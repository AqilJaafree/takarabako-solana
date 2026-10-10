import { pool } from "../db.js";
import { recordYieldEvent } from "../history.js";
import { isSolTier, type SolTier } from "./tiers.js";

/// Postgres side of the Solana destination: where a visit's cash goes, and
/// the Earn positions opened from it.

export type Destination = "evm" | "sol_hold" | "sol_earn";
export interface SessionDestination {
  destination: Destination;
  tier: SolTier | null;
}

const DESTINATIONS: Destination[] = ["evm", "sol_hold", "sol_earn"];

/// Validates a request body; null if invalid. Earn needs a tier, the others must not have one.
export function parseDestination(body: unknown): SessionDestination | null {
  const b = (body ?? {}) as { destination?: unknown; tier?: unknown };
  const destination = DESTINATIONS.find((d) => d === b.destination);
  if (!destination) return null;
  if (destination === "sol_earn") return isSolTier(b.tier) ? { destination, tier: b.tier } : null;
  return b.tier === undefined || b.tier === null ? { destination, tier: null } : null;
}

export async function sessionDestination(sessionId: string | null): Promise<SessionDestination> {
  if (!sessionId) return { destination: "evm", tier: null };
  const { rows } = await pool.query("select destination, tier from deposit_sessions where id = $1", [sessionId]);
  return rows[0] ?? { destination: "evm", tier: null };
}

/// Only the session's owner, only while it's open, only before its first note.
export async function setSessionDestination(
  sessionId: string,
  privyUserId: string,
  destination: Destination,
  tier: SolTier | null,
): Promise<"ok" | "not_found" | "locked"> {
  const { rowCount } = await pool.query(
    `update deposit_sessions set destination = $3, tier = $4
     where id = $1 and privy_user_id = $2 and status = 'open'
       and not exists (select 1 from deposits where session_id = $1)`,
    [sessionId, privyUserId, destination, tier],
  );
  if (rowCount === 1) return "ok";
  const { rows } = await pool.query("select 1 from deposit_sessions where id = $1 and privy_user_id = $2 and status = 'open'", [sessionId, privyUserId]);
  return rows.length ? "locked" : "not_found";
}

/// USD of confirmed Solana notes in a session.
export async function sessionSolTotal(sessionId: string | null): Promise<number> {
  if (!sessionId) return 0;
  const { rows } = await pool.query<{ total: string }>(
    "select coalesce(sum(usd_amount), 0) as total from deposits where session_id = $1 and chain = 'sol' and status = 'confirmed'",
    [sessionId],
  );
  return Number(rows[0]?.total ?? 0);
}

/// Every note in the session has confirmed or failed.
export async function sessionSettled(sessionId: string): Promise<boolean> {
  const { rows } = await pool.query("select 1 from deposits where session_id = $1 and status in ('queued', 'sending') limit 1", [sessionId]);
  return rows.length === 0;
}

// ---- positions ---------------------------------------------------------

export type PositionStatus = "opening" | "open" | "closing" | "closed" | "failed";

export interface SolPositionRow {
  id: string;
  privyUserId: string;
  sessionId: string | null;
  tier: SolTier;
  pair: string;
  status: PositionStatus;
  musdIn: number;
  positionPubkey: string | null;
  minBinId: number | null;
  maxBinId: number | null;
  openSig: string | null;
  openValidHeight: number | null;
  musdOutRaw: string | null; // raw integer strings (bigint-safe)
  solOutRaw: string | null;
  removedAt: Date | null;
  swapSig: string | null;
  swapValidHeight: number | null;
  swapOutRaw: string | null;
  swapConfirmedAt: Date | null;
  payoutSig: string | null;
  payoutValidHeight: number | null;
  valueOut: number | null;
  error: string | null;
  createdAt: Date;
  openedAt: Date | null;
  closedAt: Date | null;
}

const FIELDS: Record<keyof SolPositionRow, string> = {
  id: "id",
  privyUserId: "privy_user_id",
  sessionId: "session_id",
  tier: "tier",
  pair: "pair",
  status: "status",
  musdIn: "musd_in",
  positionPubkey: "position_pubkey",
  minBinId: "min_bin_id",
  maxBinId: "max_bin_id",
  openSig: "open_sig",
  openValidHeight: "open_valid_height",
  musdOutRaw: "musd_out_raw",
  solOutRaw: "sol_out_raw",
  removedAt: "removed_at",
  swapSig: "swap_sig",
  swapValidHeight: "swap_valid_height",
  swapOutRaw: "swap_out_raw",
  swapConfirmedAt: "swap_confirmed_at",
  payoutSig: "payout_sig",
  payoutValidHeight: "payout_valid_height",
  valueOut: "value_out",
  error: "error",
  createdAt: "created_at",
  openedAt: "opened_at",
  closedAt: "closed_at",
};
const NUMERIC = new Set(["musd_in", "value_out", "open_valid_height", "swap_valid_height", "payout_valid_height"]);
const RAW = new Set(["musd_out_raw", "sol_out_raw", "swap_out_raw"]);
const POSITION_COLUMNS = Object.entries(FIELDS)
  .map(([k, col]) => (NUMERIC.has(col) ? `${col}::float as "${k}"` : RAW.has(col) ? `${col}::text as "${k}"` : `${col} as "${k}"`))
  .join(", ");

export async function getPosition(id: string): Promise<SolPositionRow | null> {
  const { rows } = await pool.query(`select ${POSITION_COLUMNS} from solana_positions where id = $1`, [id]);
  return rows[0] ?? null;
}

export async function positionForSession(sessionId: string): Promise<SolPositionRow | null> {
  const { rows } = await pool.query(`select ${POSITION_COLUMNS} from solana_positions where session_id = $1`, [sessionId]);
  return rows[0] ?? null;
}

export async function listPositions(privyUserId: string): Promise<SolPositionRow[]> {
  const { rows } = await pool.query(`select ${POSITION_COLUMNS} from solana_positions where privy_user_id = $1 order by created_at desc`, [privyUserId]);
  return rows;
}

export async function listLivePositions(): Promise<SolPositionRow[]> {
  const { rows } = await pool.query(`select ${POSITION_COLUMNS} from solana_positions where status in ('opening', 'open', 'closing')`);
  return rows;
}

/// Creates the Earn position row for a session from its confirmed Solana
/// notes — once (session_id is unique). Null if there's nothing to invest.
export async function createPositionForSession(sessionId: string, pair: string): Promise<SolPositionRow | null> {
  const existing = await positionForSession(sessionId);
  if (existing) return existing;
  const { rows: s } = await pool.query("select privy_user_id as \"privyUserId\", destination, tier from deposit_sessions where id = $1", [sessionId]);
  const session = s[0] as { privyUserId: string; destination: Destination; tier: SolTier | null } | undefined;
  if (!session || session.destination !== "sol_earn" || !session.tier) return null;
  const total = await sessionSolTotal(sessionId);
  if (total <= 0) return null;
  await pool.query(
    `insert into solana_positions (id, privy_user_id, session_id, tier, pair, musd_in)
     values ($1, $2, $3, $4, $5, $6) on conflict (session_id) do nothing`,
    [crypto.randomUUID(), session.privyUserId, sessionId, session.tier, pair, total],
  );
  return positionForSession(sessionId);
}

/// Writes the given fields (camelCase keys of SolPositionRow).
export async function updatePosition(id: string, patch: Partial<Omit<SolPositionRow, "id">>): Promise<void> {
  const keys = Object.keys(patch) as (keyof Omit<SolPositionRow, "id">)[];
  if (!keys.length) return;
  const sets = keys.map((k, i) => `${FIELDS[k]} = $${i + 2}`);
  await pool.query(`update solana_positions set ${sets.join(", ")} where id = $1`, [id, ...keys.map((k) => patch[k] ?? null)]);
}

/// Atomically flips open -> closing for the owner; false if it wasn't open
/// (already closing/closed, or not theirs), so two clicks can't double-close.
export async function markClosing(id: string, privyUserId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `update solana_positions set status = 'closing', error = null where id = $1 and privy_user_id = $2 and status = 'open'`,
    [id, privyUserId],
  );
  return rowCount === 1;
}

/// Writes `patch` only while `field` still equals `expected` (null = unset).
/// False if another run changed it first — used so a stored signature is
/// never overwritten by a second send, nor cleared after a newer one.
export async function updatePositionIf<K extends "openSig" | "swapSig" | "payoutSig">(
  id: string,
  field: K,
  expected: string | null,
  patch: Partial<Omit<SolPositionRow, "id">>,
): Promise<boolean> {
  const keys = Object.keys(patch) as (keyof Omit<SolPositionRow, "id">)[];
  if (!keys.length) return false;
  const sets = keys.map((k, i) => `${FIELDS[k]} = $${i + 3}`);
  const { rowCount } = await pool.query(`update solana_positions set ${sets.join(", ")} where id = $1 and ${FIELDS[field]} is not distinct from $2::text`, [
    id,
    expected,
    ...keys.map((k) => patch[k] ?? null),
  ]);
  return rowCount === 1;
}

type YieldEvent = Parameters<typeof recordYieldEvent>[0];

/// Runs `fn` in one transaction on a dedicated client.
async function inTransaction<T>(fn: (c: import("pg").PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    const out = await fn(c);
    await c.query("commit");
    return out;
  } catch (err) {
    await c.query("rollback").catch(() => {});
    throw err;
  } finally {
    c.release();
  }
}

/// 'opening' → 'open' and its History row, atomically. False (and no
/// History row) if the position wasn't 'opening' any more.
export async function finalizeOpen(id: string, event: YieldEvent): Promise<boolean> {
  return inTransaction(async (c) => {
    const { rowCount } = await c.query(
      "update solana_positions set status = 'open', opened_at = now(), error = null where id = $1 and status = 'opening'",
      [id],
    );
    if (rowCount !== 1) return false;
    await recordYieldEvent(event, c);
    return true;
  });
}

/// 'closing' → 'closed' (value, payout signature) and its History row,
/// atomically. False (and no History row) if it wasn't 'closing' any more.
export async function finalizeClose(id: string, close: { valueOut: number; payoutSig: string }, event: YieldEvent): Promise<boolean> {
  return inTransaction(async (c) => {
    const { rowCount } = await c.query(
      `update solana_positions set status = 'closed', value_out = $2, payout_sig = $3, closed_at = now(), error = null
       where id = $1 and status = 'closing'`,
      [id, close.valueOut, close.payoutSig],
    );
    if (rowCount !== 1) return false;
    await recordYieldEvent(event, c);
    return true;
  });
}

/// Earn sessions that are over (finished, or no note for 30 min) with
/// confirmed Solana notes but no position yet — the sweep opens them.
export async function earnSessionsWithoutPosition(): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(
    `select s.id from deposit_sessions s
     where s.destination = 'sol_earn'
       and (s.status = 'finished'
            or coalesce((select max(d.created_at) from deposits d where d.session_id = s.id), s.started_at) < now() - interval '30 minutes')
       and not exists (select 1 from solana_positions p where p.session_id = s.id)
       and exists (select 1 from deposits d where d.session_id = s.id and d.chain = 'sol' and d.status = 'confirmed')`,
  );
  return rows.map((r) => r.id);
}
