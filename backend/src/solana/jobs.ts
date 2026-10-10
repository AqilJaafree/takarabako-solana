import { Queue, Worker, type Job } from "bullmq";
import { newRedisConnection } from "../redis.js";
import { pool } from "../db.js";
import { publishUserEvent } from "../events.js";
import { solanaReady } from "./client.js";
import { closePosition, openForSession } from "./positions.js";
import { earnSessionsWithoutPosition, getPosition, positionForSession, updatePosition, type SolPositionRow } from "./store.js";

/// Earn positions are opened and closed by this queue, one job at a time
/// (the treasury signs everything, so serialising keeps its balances simple).
const QUEUE_NAME = "solana-positions";
export const SOLANA_ATTEMPTS = 8;

type JobData = { kind: "open"; sessionId: string } | { kind: "close"; positionId: string };

let queue: Queue<JobData> | null = null;
let queueConn: ReturnType<typeof newRedisConnection> | null = null;

function positionsQueue() {
  queueConn ??= newRedisConnection();
  queue ??= new Queue<JobData>(QUEUE_NAME, {
    connection: queueConn,
    defaultJobOptions: { attempts: SOLANA_ATTEMPTS, backoff: { type: "exponential", delay: 5_000 }, removeOnComplete: 1000, removeOnFail: false },
  });
  return queue;
}

export async function closeSolanaQueue() {
  await queue?.close();
  queueConn?.disconnect();
  queue = null;
  queueConn = null;
}

export async function enqueueOpen(sessionId: string, opts: { retry?: boolean } = {}) {
  // BullMQ custom job ids cannot contain ':'. The plain id dedupes Finish +
  // sweep; a recovery retry needs a fresh one (failed jobs are kept).
  const jobId = opts.retry ? `open-${sessionId}-${Date.now()}` : `open-${sessionId}`;
  const q = positionsQueue();
  if (!opts.retry) {
    // A job that failed for good before any position row existed leaves nothing
    // for markFailed to flag, and its kept id would dedupe the sweep forever.
    const existing = await q.getJob(jobId);
    if (existing && (await existing.isFailed())) await existing.remove();
  }
  await q.add("open", { kind: "open", sessionId }, { jobId });
}

export async function enqueueClose(positionId: string) {
  // A new jobId per request so a customer can retry a close that failed for good.
  await positionsQueue().add("close", { kind: "close", positionId }, { jobId: `close-${positionId}-${Date.now()}` });
}

async function run(job: Job<JobData>) {
  if (job.data.kind === "open") await openForSession(job.data.sessionId);
  else await closePosition(job.data.positionId);
}

/// What to write when a job has used up its attempts. An open fails for good
/// unless its signed open is stored (it may still land — stays 'opening' for
/// the recovery sweep). A close goes back to 'open' so the customer can retry
/// - unless a swap or payout signature is stored: that send may still land,
/// so the row stays 'closing' (error recorded) for the recovery sweep.
export function failedPositionPatch(
  kind: "open" | "close",
  row: Pick<SolPositionRow, "openSig" | "swapSig" | "payoutSig">,
  message: string,
): Partial<Omit<SolPositionRow, "id">> {
  if (kind === "open") return row.openSig ? { status: "opening", error: message } : { status: "failed", error: message };
  if (row.payoutSig || row.swapSig) return { status: "closing", error: message };
  return { status: "open", error: message };
}

async function markFailed(job: Job<JobData>, err: Error) {
  const row = job.data.kind === "open" ? await positionForSession(job.data.sessionId) : await getPosition(job.data.positionId);
  if (!row) return;
  await updatePosition(row.id, failedPositionPatch(job.data.kind, row, err.message));
  await publishUserEvent(row.privyUserId, { type: "solana.position.failed", positionId: row.id, error: err.message });
}

/// Re-queue opens and closes whose retries ran out while a send was still
/// stored (error is only written on final failure). The error is cleared so
/// a row is queued once per failure.
export async function recoverStuckPositions(): Promise<number> {
  const { rows } = await pool.query<{ id: string; status: string; sessionId: string | null }>(
    `select id, status, session_id as "sessionId" from solana_positions
     where status in ('opening', 'closing') and error is not null`,
  );
  for (const r of rows) {
    await updatePosition(r.id, { error: null });
    if (r.status === "closing") await enqueueClose(r.id);
    else if (r.sessionId) await enqueueOpen(r.sessionId, { retry: true });
  }
  return rows.length;
}

export function startSolanaWorker() {
  if (!solanaReady) return null;
  const worker = new Worker<JobData>(QUEUE_NAME, run, { connection: newRedisConnection(), concurrency: 1 });
  worker.on("failed", async (job, err) => {
    if (!job) return;
    console.error(`[solana] ${job.name} attempt ${job.attemptsMade}/${SOLANA_ATTEMPTS} failed: ${err.message}`);
    if (job.attemptsMade >= SOLANA_ATTEMPTS) await markFailed(job, err).catch((e) => console.error("[solana] markFailed:", e));
  });
  worker.on("error", (err) => console.error("[solana] worker error:", err.message));

  // Sweep: Earn sessions the customer walked away from (never tapped Finish).
  const sweep = async () => {
    for (const sessionId of await earnSessionsWithoutPosition()) await enqueueOpen(sessionId).catch(() => {});
  };
  const recover = () => recoverStuckPositions().catch((e) => console.error("[solana] recover:", e instanceof Error ? e.message : e));
  void sweep().catch((e) => console.error("[solana] sweep:", e));
  void recover();
  setInterval(() => void sweep().catch((e) => console.error("[solana] sweep:", e)), 10 * 60_000).unref();
  setInterval(() => void recover(), 5 * 60_000).unref();
  return worker;
}
