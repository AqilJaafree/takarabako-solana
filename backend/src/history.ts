import { pool } from "./db.js";

/// Deposit sessions (one customer visit to the cash slot, ending in a
/// receipt) and everything the customer's History page lists: deposits,
/// withdrawals, yield actions and notes the acceptor refused.

export type RefusedReason = "unsupported" | "bad_condition" | "no_session";

export interface ReceiptNote {
  id: string;
  amount: number;
  currency: string;
  usdAmount: number | null;
  txHash: string | null;
  tkcashTxHash: string | null; // the tkCASH minted for this note
  machineName: string | null; // the kiosk that took it (ENS name), when its signature checked out
  machineVerified: boolean;
  status: "queued" | "sending" | "confirmed" | "failed";
  chain: "evm" | "sol";
  at: Date;
}

export interface Receipt {
  id: string;
  privyUserId: string;
  status: "open" | "finished";
  startedAt: Date;
  finishedAt: Date | null;
  notes: ReceiptNote[];
  totalAmount: number; // face value, in the notes' currency
  currency: string;
  totalUsdConfirmed: number;
  settled: boolean; // no note still queued or sending
  destination: "evm" | "sol_hold" | "sol_earn";
  tier: string | null;
  solPosition: { id: string; status: string; openSig: string | null } | null; // Earn only
}

export type HistoryItem =
  | ({ kind: "deposit_session"; at: Date } & Receipt)
  | {
      kind: "withdrawal";
      at: Date;
      id: string;
      destination: "cash" | "wallet";
      grossUsd: number;
      feeBps: number;
      netUsd: number;
      txHash: string | null;
      tkcashBurned: number;
      tkcashTxHash: string | null;
    }
  | {
      kind: "yield";
      at: Date;
      id: string;
      action: "open" | "close";
      riskTier: string | null;
      pair: string | null;
      apyBps: number | null;
      amountUsd: number | null;
      rationale: string | null;
      ensName: string | null;
      txHash: string | null;
      chain: "evm" | "sol";
    }
  | { kind: "refused"; at: Date; id: string; reason: RefusedReason; sessionId: string | null }
  | {
      kind: "transfer";
      at: Date;
      id: string;
      asset: "balance" | "tkcash" | "position";
      direction: "sent" | "received";
      counterparty: string | null; // the other side's ENS name, or address
      amountUsd: number | null;
      positionId: string | null;
      txHash: string | null;
    };

export type HistoryKind = HistoryItem["kind"];

// ---- deposit sessions --------------------------------------------------

/// Opens a session for a new visit, closing any session this customer left open.
export async function openDepositSession(privyUserId: string) {
  await pool.query(
    "update deposit_sessions set status = 'finished', finished_at = now() where privy_user_id = $1 and status = 'open'",
    [privyUserId],
  );
  const { rows } = await pool.query(
    `insert into deposit_sessions (id, privy_user_id) values ($1, $2) returning id, started_at as "startedAt"`,
    [crypto.randomUUID(), privyUserId],
  );
  return rows[0] as { id: string; startedAt: Date };
}

export async function currentOpenSession(privyUserId: string): Promise<{ id: string } | null> {
  const { rows } = await pool.query(
    "select id from deposit_sessions where privy_user_id = $1 and status = 'open' order by started_at desc limit 1",
    [privyUserId],
  );
  return rows[0] ?? null;
}

export async function finishDepositSession(id: string) {
  await pool.query(
    "update deposit_sessions set status = 'finished', finished_at = coalesce(finished_at, now()) where id = $1",
    [id],
  );
}

/// Claims the one-time receipt email; false if it was already sent.
export async function markReceiptEmailed(id: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    "update deposit_sessions set receipt_emailed_at = now() where id = $1 and receipt_emailed_at is null",
    [id],
  );
  return rowCount === 1;
}

type SessionRow = {
  id: string;
  privyUserId: string;
  status: "open" | "finished";
  startedAt: Date;
  finishedAt: Date | null;
  destination: "evm" | "sol_hold" | "sol_earn";
  tier: string | null;
};

function buildReceipt(session: SessionRow, notes: ReceiptNote[], solPosition: Receipt["solPosition"] = null): Receipt {
  return {
    ...session,
    solPosition,
    notes,
    totalAmount: notes.reduce((s, n) => s + n.amount, 0),
    currency: notes[0]?.currency ?? "MYR",
    totalUsdConfirmed: Math.round(notes.filter((n) => n.status === "confirmed").reduce((s, n) => s + (n.usdAmount ?? 0), 0) * 1e6) / 1e6,
    settled: notes.every((n) => n.status === "confirmed" || n.status === "failed"),
  };
}

const NOTE_COLUMNS = `id, amount::float as amount, currency, usd_amount::float as "usdAmount", tx_hash as "txHash", tkcash_tx_hash as "tkcashTxHash", machine_name as "machineName", machine_verified as "machineVerified", status, chain,
  created_at as at, session_id as "sessionId"`;

export async function getReceipt(id: string): Promise<Receipt | null> {
  const { rows: sessions } = await pool.query(
    `select id, privy_user_id as "privyUserId", status, started_at as "startedAt", finished_at as "finishedAt", destination, tier
     from deposit_sessions where id = $1`,
    [id],
  );
  if (!sessions[0]) return null;
  const { rows: notes } = await pool.query(`select ${NOTE_COLUMNS} from deposits where session_id = $1 order by created_at`, [id]);
  const { rows: pos } = await pool.query(
    `select id, status, open_sig as "openSig" from solana_positions where session_id = $1`,
    [id],
  );
  return buildReceipt(sessions[0], notes, pos[0] ?? null);
}

// ---- other history rows ------------------------------------------------

export async function recordWithdrawal(w: {
  privyUserId: string;
  destination: "cash" | "wallet";
  grossUsd: number;
  feeBps: number;
  netUsd: number;
  txHash: string | null;
  tkcashBurned?: number;
  tkcashTxHash?: string | null;
}) {
  await pool.query(
    `insert into withdrawals (id, privy_user_id, destination, gross_usd, fee_bps, net_usd, tx_hash, tkcash_burned, tkcash_tx_hash)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [crypto.randomUUID(), w.privyUserId, w.destination, w.grossUsd, w.feeBps, w.netUsd, w.txHash, w.tkcashBurned ?? 0, w.tkcashTxHash ?? null],
  );
}

/// Anything with pg's query(): the pool, or a client inside a transaction.
export type Queryable = { query: (text: string, values?: unknown[]) => Promise<unknown> };

export async function recordYieldEvent(y: {
  privyUserId: string;
  action: "open" | "close";
  riskTier: string | null;
  pair: string | null;
  apyBps: number | null;
  amountUsd: number | null;
  rationale: string | null;
  ensName: string | null;
  txHash: string | null;
  chain?: "evm" | "sol";
}, db: Queryable = pool) {
  await db.query(
    `insert into yield_events (id, privy_user_id, action, risk_tier, pair, apy_bps, amount_usd, rationale, ens_name, tx_hash, chain)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [crypto.randomUUID(), y.privyUserId, y.action, y.riskTier, y.pair, y.apyBps, y.amountUsd, y.rationale, y.ensName, y.txHash, y.chain ?? "evm"],
  );
}

export async function recordRefused(r: { privyUserId: string; sessionId: string | null; reason: RefusedReason }) {
  await pool.query("insert into refused_notes (id, privy_user_id, session_id, reason) values ($1, $2, $3, $4)", [
    crypto.randomUUID(),
    r.privyUserId,
    r.sessionId,
    r.reason,
  ]);
}

// ---- the History list --------------------------------------------------

/// Everything, newest first. Each kind is fetched up to `limit` and merged,
/// so the combined list is exact for its first `limit` items.
export async function listHistory(privyUserId: string, opts: { limit: number; kind?: HistoryKind }): Promise<HistoryItem[]> {
  const { limit, kind } = opts;
  const want = (k: HistoryKind) => !kind || kind === k;
  const items: HistoryItem[] = [];

  if (want("deposit_session")) {
    // Sessions with at least one note; an empty visit isn't worth listing.
    const { rows: sessions } = await pool.query(
      `select s.id, s.privy_user_id as "privyUserId", s.status, s.started_at as "startedAt", s.finished_at as "finishedAt", s.destination, s.tier
       from deposit_sessions s
       where s.privy_user_id = $1 and exists (select 1 from deposits d where d.session_id = s.id)
       order by s.started_at desc limit $2`,
      [privyUserId, limit],
    );
    if (sessions.length) {
      const { rows: notes } = await pool.query(
        `select ${NOTE_COLUMNS} from deposits where session_id = any($1::uuid[]) order by created_at`,
        [sessions.map((s) => s.id)],
      );
      for (const s of sessions) {
        const receipt = buildReceipt(s, notes.filter((n) => n.sessionId === s.id).map(({ sessionId: _s, ...n }) => n));
        items.push({ kind: "deposit_session", at: s.startedAt, ...receipt });
      }
    }
  }

  if (want("withdrawal")) {
    const { rows } = await pool.query(
      `select id, destination, gross_usd::float as "grossUsd", fee_bps as "feeBps", net_usd::float as "netUsd",
              tx_hash as "txHash", tkcash_burned::float as "tkcashBurned", tkcash_tx_hash as "tkcashTxHash", created_at as at
       from withdrawals where privy_user_id = $1 order by created_at desc limit $2`,
      [privyUserId, limit],
    );
    for (const r of rows) items.push({ kind: "withdrawal", ...r });
  }

  if (want("yield")) {
    const { rows } = await pool.query(
      `select id, action, risk_tier as "riskTier", pair, apy_bps as "apyBps", amount_usd::float as "amountUsd", rationale,
              ens_name as "ensName", tx_hash as "txHash", chain, created_at as at
       from yield_events where privy_user_id = $1 order by created_at desc limit $2`,
      [privyUserId, limit],
    );
    for (const r of rows) items.push({ kind: "yield", ...r });
  }

  if (want("transfer")) {
    const { rows } = await pool.query(
      `select t.id, t.kind as asset, t.created_at as at, t.amount_usd::float as "amountUsd", t.position_id as "positionId", t.tx_hash as "txHash",
              case when t.from_user = $1 then 'sent' else 'received' end as direction,
              case when t.from_user = $1 then coalesce(t.to_name, rcv.ens_name, t.to_address) else snd.ens_name end as counterparty
       from transfers t
       left join accounts snd on snd.privy_user_id = t.from_user
       left join accounts rcv on rcv.privy_user_id = t.to_user
       where t.from_user = $1 or t.to_user = $1
       order by t.created_at desc limit $2`,
      [privyUserId, limit],
    );
    for (const r of rows) items.push({ kind: "transfer", ...r });
  }

  if (want("refused")) {
    const { rows } = await pool.query(
      `select id, reason, session_id as "sessionId", created_at as at
       from refused_notes where privy_user_id = $1 order by created_at desc limit $2`,
      [privyUserId, limit],
    );
    for (const r of rows) items.push({ kind: "refused", ...r });
  }

  return items.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, limit);
}
