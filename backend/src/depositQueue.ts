import { Queue, Worker, type Job } from "bullmq";
import type { Address } from "viem";
import { newRedisConnection } from "./redis.js";
import { pool } from "./db.js";
import { PublicKey } from "@solana/web3.js";
import {
  getDeposit,
  findByPrivyUserId,
  markDepositSending,
  markDepositSendingSol,
  clearDepositSend,
  markDepositConfirmed,
  markDepositFailed,
  type Account,
  type DepositRow,
} from "./accounts.js";
import { broadcast, confirm, signTx, treasury, type Outcome, type SignedTx } from "./solana/client.js";
import { balanceRaw, fromRaw, mintToTx } from "./solana/musd.js";
import { sessionDestination, sessionSolTotal, type SessionDestination } from "./solana/store.js";
import { solanaWalletFor } from "./solana/wallets.js";
import { toUsd } from "./fx.js";
import { sendDepositTx, waitForDepositTx } from "./chain.js";
import { publishUserEvent, type UserEvent } from "./events.js";
import { maybeSendReceipt } from "./receiptEmail.js";
import { recordCashIn } from "./cashReceipt.js";

/// Durable deposits. The row in Postgres is the record; the BullMQ job is the
/// work item. If the backend dies mid-job, BullMQ's stalled-job check hands
/// the job to a worker again after restart. A stored tx_hash means "already
/// sent — only wait", so no retry can pay twice.
export const DEPOSIT_ATTEMPTS = 5;
const QUEUE_NAME = "deposits";

let queue: Queue | null = null;
let queueConn: ReturnType<typeof newRedisConnection> | null = null;

function depositQueue() {
  queueConn ??= newRedisConnection();
  queue ??= new Queue(QUEUE_NAME, {
    connection: queueConn,
    defaultJobOptions: {
      attempts: DEPOSIT_ATTEMPTS,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: 1000,
      removeOnFail: false,
    },
  });
  return queue;
}

export async function closeDepositQueue() {
  await queue?.close();
  queueConn?.disconnect();
  queue = null;
  queueConn = null;
}

export async function enqueueDeposit(depositId: string) {
  // jobId = depositId: the same deposit can never be queued twice. The
  // connection retries forever, so without a timeout a Redis outage would
  // hang the request instead of failing it.
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Redis did not answer within 3s")), 3_000);
  });
  try {
    await Promise.race([depositQueue().add("deposit", { depositId }, { jobId: depositId }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export interface SolDeps {
  owner: (account: Account, destination: "sol_hold" | "sol_earn") => Promise<string>;
  signMint: (owner: string, usdAmount: number) => Promise<SignedTx>;
  broadcast: (raw: Uint8Array) => Promise<void>;
  confirm: (signature: string, lastValidBlockHeight: number) => Promise<Outcome>;
  balance: (owner: string) => Promise<number>;
}

export interface ProcessDeps {
  toUsd: (amount: number, currency: "USD" | "MYR") => Promise<{ usdAmount: number; rate: number; source: string }>;
  send: (user: Address, usdAmount: number) => Promise<`0x${string}`>;
  wait: (hash: `0x${string}`, user: Address) => Promise<number>;
  publish: (privyUserId: string, event: UserEvent) => Promise<void>;
  destination?: (sessionId: string | null) => Promise<SessionDestination>;
  sol?: SolDeps;
}

const liveSol: SolDeps = {
  owner: async (account, destination) => (destination === "sol_hold" ? solanaWalletFor(account) : treasury().publicKey.toBase58()),
  signMint: (owner, usd) => signTx(mintToTx(new PublicKey(owner), usd)),
  broadcast,
  confirm,
  balance: async (owner) => fromRaw(await balanceRaw(new PublicKey(owner))),
};

const liveDeps: ProcessDeps = { toUsd, send: sendDepositTx, wait: waitForDepositTx, publish: publishUserEvent, destination: sessionDestination, sol: liveSol };

export async function processDeposit(depositId: string, deps: ProcessDeps = liveDeps) {
  const row = await getDeposit(depositId);
  if (!row || row.status === "confirmed" || row.status === "failed") return;
  const account = await findByPrivyUserId(row.privyUserId);
  if (!account) throw new Error(`deposit ${depositId}: account missing`);
  const { destination } = await (deps.destination ?? sessionDestination)(row.sessionId);
  // chain === "sol" with an evm session: a mint already stored must be finished, not re-sent on EVM.
  if (destination === "evm" && row.chain !== "sol") return processEvm(row, account, deps);
  return processSol(row, account, destination === "evm" ? "sol_hold" : destination, deps);
}

async function processEvm(row: DepositRow, account: Account, deps: ProcessDeps) {
  const user = account.boundAddress as Address;
  let hash = row.txHash as `0x${string}` | null;
  let usdAmount = row.usdAmount ?? 0;
  let rate = row.amount > 0 ? usdAmount / row.amount : 1;
  if (!hash) {
    const fx = await deps.toUsd(row.amount, row.currency as "USD" | "MYR");
    usdAmount = fx.usdAmount;
    rate = fx.rate;
    hash = await deps.send(user, usdAmount);
    await markDepositSending(row.id, hash, usdAmount); // stored before waiting
  }
  const balance = await deps.wait(hash, user);
  await markDepositConfirmed(row.id);
  await deps.publish(row.privyUserId, {
    type: "deposit.confirmed", depositId: row.id, amount: row.amount, currency: row.currency,
    usdAmount, fxRate: rate, txHash: hash, balance, chain: "evm",
  });
  await afterConfirmed(row, account, usdAmount, deps);
}

/// Solana: mint mUSD — to the customer's wallet (Hold) or to the treasury,
/// to be invested when the visit ends (Earn). Signed -> stored -> broadcast.
/// A throw from confirm() means "unknown": it propagates and the stored
/// signature is kept, so the retry only re-checks it.
async function processSol(row: DepositRow, account: Account, destination: "sol_hold" | "sol_earn", deps: ProcessDeps) {
  const sol = deps.sol ?? liveSol;
  let usdAmount = row.usdAmount ?? 0;
  let rate = row.amount > 0 ? usdAmount / row.amount : 1;
  let signature = row.txHash;
  let validHeight = row.solValidHeight;
  if (!signature || validHeight == null) {
    const fx = await deps.toUsd(row.amount, row.currency as "USD" | "MYR");
    usdAmount = fx.usdAmount;
    rate = fx.rate;
    const owner = await sol.owner(account, destination);
    const signed = await sol.signMint(owner, usdAmount);
    // stored before sending; false means another worker already stored a send
    if (!(await markDepositSendingSol(row.id, signed.signature, usdAmount, signed.lastValidBlockHeight))) {
      throw new Error(`deposit ${row.id}: a Solana send is already recorded - not sending a second`);
    }
    signature = signed.signature;
    validHeight = signed.lastValidBlockHeight;
    await sol.broadcast(signed.raw);
  }
  const outcome = await sol.confirm(signature, validHeight);
  if (outcome !== "confirmed") {
    await clearDepositSend(row.id);
    throw new Error(`mUSD mint ${signature} ${outcome} - sending a new one`);
  }
  await markDepositConfirmed(row.id);
  // The note is already minted: a failing balance read must not lose the confirmation event/receipt.
  const balance = await (destination === "sol_hold"
    ? sol.owner(account, destination).then((o) => sol.balance(o))
    : sessionSolTotal(row.sessionId)
  ).catch((err) => {
    console.error(`[deposits] ${row.id} balance read failed:`, err instanceof Error ? err.message : err);
    return usdAmount;
  });
  await deps.publish(row.privyUserId, {
    type: "deposit.confirmed", depositId: row.id, amount: row.amount, currency: row.currency,
    usdAmount, fxRate: rate, txHash: signature, balance, chain: "sol",
  });
  await afterConfirmed(row, account, usdAmount, deps);
}

/// On the final attempt a send that is in flight (hash stored) may still land,
/// so the deposit stays 'sending' for recoverInFlightDeposits to resume.
export function finalFailureStatus(row: { status: string; txHash: string | null }): "failed" | "keep" {
  return row.status === "sending" && row.txHash ? "keep" : "failed";
}

/// Re-queue deposits stuck in queued/sending for over 2 minutes (e.g. after
/// retries ran out mid-flight). processDeposit resumes from the stored hash.
export async function recoverInFlightDeposits(): Promise<number> {
  const { rows } = await pool.query(
    "select id from deposits where status in ('queued','sending') and updated_at < now() - interval '2 minutes'",
  );
  for (const r of rows) {
    await depositQueue().add("deposit", { depositId: r.id }, { jobId: `${r.id}-recover-${Date.now()}` });
  }
  return rows.length;
}

/// Receipt email and tkCASH - the same for every destination: the note is in the box.
async function afterConfirmed(row: DepositRow, account: Account, usdAmount: number, deps: ProcessDeps) {
  if (row.sessionId) await sendReceiptIfDone(row.sessionId);
  // tkCASH: the note is now in the box, so mint its receipt token. In the
  // background - it must never hold up or fail a deposit that went through.
  void recordCashIn({ depositId: row.id, wallet: account.privyWallet, usdAmount, denomination: row.amount, currency: row.currency })
    .then(async (txHash) => {
      if (txHash) await deps.publish(row.privyUserId, { type: "tkcash.minted", depositId: row.id, amount: usdAmount, txHash });
    })
    .catch((err) => console.error(`[tkcash] cash-in for deposit ${row.id}:`, err instanceof Error ? err.message : err));
}

// The receipt email must never fail (and so retry) a deposit that already went through.
async function sendReceiptIfDone(sessionId: string) {
  await maybeSendReceipt(sessionId).catch((err) => console.error(`[receipt] ${sessionId}:`, err));
}

export function startDepositWorker() {
  const worker = new Worker<{ depositId: string }>(QUEUE_NAME, (job: Job<{ depositId: string }>) => processDeposit(job.data.depositId), {
    connection: newRedisConnection(),
    // Sends are serialised in chain.ts anyway; one job at a time keeps the
    // receipt waits simple and the kiosk's notes in order.
    concurrency: 1,
  });

  worker.on("failed", async (job, err) => {
    if (!job) return;
    const final = job.attemptsMade >= DEPOSIT_ATTEMPTS;
    const row = await getDeposit(job.data.depositId);
    const keep = final && !!row && finalFailureStatus(row) === "keep";
    await markDepositFailed(job.data.depositId, err.message, final && !keep);
    if (!row) return;
    console.error(`[deposits] ${row.id} attempt ${job.attemptsMade}/${DEPOSIT_ATTEMPTS} failed: ${err.message}`);
    if (keep) return; // in flight: recoverInFlightDeposits resumes it
    await publishUserEvent(
      row.privyUserId,
      final
        ? { type: "deposit.failed", depositId: row.id, amount: row.amount, currency: row.currency, error: err.message }
        : { type: "deposit.retrying", depositId: row.id, attempt: job.attemptsMade, maxAttempts: DEPOSIT_ATTEMPTS, error: err.message },
    );
    if (final && row.sessionId) await sendReceiptIfDone(row.sessionId);
  });

  const recover = () => recoverInFlightDeposits().catch((err) => console.error("[deposits] recover:", err instanceof Error ? err.message : err));
  void recover();
  setInterval(recover, 10 * 60_000).unref();

  worker.on("error", (err) => console.error("[deposits] worker error:", err.message));
  return worker;
}
