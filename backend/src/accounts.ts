import { pool } from "./db.js";

/// Registered customers: the Privy user, the embedded wallet whose QR logs
/// them in for deposits, and the vault account their deposits credit.
export interface Account {
  privyUserId: string;
  email: string;
  privyWallet: string; // lowercase 0x address, what the QR holds
  boundAddress: string; // vault account (deriveBoundAddress in store.ts)
  ensName: string | null;
  qrEmailedAt: Date | null;
}

const COLUMNS = `privy_user_id as "privyUserId", email, privy_wallet as "privyWallet",
  bound_address as "boundAddress", ens_name as "ensName", qr_emailed_at as "qrEmailedAt"`;

export async function findByPrivyUserId(privyUserId: string): Promise<Account | null> {
  const { rows } = await pool.query(`select ${COLUMNS} from accounts where privy_user_id = $1`, [privyUserId]);
  return rows[0] ?? null;
}

/// Case-insensitive: the kiosk may type Ali@Gmail.com for ali@gmail.com.
export async function findByEmail(email: string): Promise<Account | null> {
  const { rows } = await pool.query(`select ${COLUMNS} from accounts where lower(email) = lower($1)`, [email.trim()]);
  return rows[0] ?? null;
}

export async function findByWallet(wallet: string): Promise<Account | null> {
  const { rows } = await pool.query(`select ${COLUMNS} from accounts where privy_wallet = $1`, [wallet.toLowerCase()]);
  return rows[0] ?? null;
}

export async function insertAccount(a: Omit<Account, "qrEmailedAt">): Promise<Account> {
  const { rows } = await pool.query(
    `insert into accounts (privy_user_id, email, privy_wallet, bound_address, ens_name)
     values ($1, $2, $3, $4, $5) returning ${COLUMNS}`,
    [a.privyUserId, a.email, a.privyWallet.toLowerCase(), a.boundAddress, a.ensName],
  );
  return rows[0];
}

export async function markQrEmailed(privyUserId: string) {
  await pool.query("update accounts set qr_emailed_at = now() where privy_user_id = $1", [privyUserId]);
}

export interface DepositRow {
  id: string;
  privyUserId: string;
  currency: string;
  amount: number;
  usdAmount: number | null;
  txHash: string | null;
  status: "queued" | "sending" | "confirmed" | "failed";
  attempts: number;
  error: string | null;
  sessionId: string | null;
  tkcashTxHash: string | null;
  machineName: string | null;
  machineVerified: boolean;
  createdAt: Date;
}

const DEPOSIT_COLUMNS = `id, privy_user_id as "privyUserId", currency, amount::float as amount,
  usd_amount::float as "usdAmount", tx_hash as "txHash", status, attempts, error, session_id as "sessionId",
  tkcash_tx_hash as "tkcashTxHash", machine_name as "machineName", machine_verified as "machineVerified", created_at as "createdAt"`;

/// A deposit starts as a queued row; the deposit queue (depositQueue.ts)
/// sends it and moves it to sending → confirmed | failed.
export async function createQueuedDeposit(d: {
  privyUserId: string;
  currency: string;
  amount: number;
  sessionId?: string | null; // the deposit session (history.ts) the note belongs to
  machine?: { name: string; signer: string; nonce: string; signature: string } | null; // a verified kiosk signature
}): Promise<DepositRow> {
  const m = d.machine ?? null;
  const { rows } = await pool.query(
    `insert into deposits (id, privy_user_id, currency, amount, status, session_id, machine_name, machine_signer, machine_nonce, machine_sig, machine_verified)
     values ($1, $2, $3, $4, 'queued', $5, $6, $7, $8, $9, $10)
     returning ${DEPOSIT_COLUMNS}`,
    [crypto.randomUUID(), d.privyUserId, d.currency, d.amount, d.sessionId ?? null, m?.name ?? null, m?.signer ?? null, m?.nonce ?? null, m?.signature ?? null, Boolean(m)],
  );
  return rows[0];
}

export async function getDeposit(id: string): Promise<DepositRow | null> {
  const { rows } = await pool.query(`select ${DEPOSIT_COLUMNS} from deposits where id = $1`, [id]);
  return rows[0] ?? null;
}

/// Records the tx hash *before* waiting for it, so a retry after a crash
/// waits for this transaction instead of sending a second one.
export async function markDepositSending(id: string, txHash: string, usdAmount: number) {
  await pool.query(
    `update deposits set status = 'sending', tx_hash = $2, usd_amount = $3, attempts = attempts + 1, updated_at = now()
     where id = $1`,
    [id, txHash, usdAmount],
  );
}

export async function markDepositConfirmed(id: string) {
  await pool.query("update deposits set status = 'confirmed', error = null, updated_at = now() where id = $1", [id]);
}

export async function markDepositFailed(id: string, error: string, final: boolean) {
  await pool.query(
    "update deposits set error = $2, status = case when $3 then 'failed' else status end, updated_at = now() where id = $1",
    [id, error, final],
  );
}

export async function listDeposits(privyUserId: string, limit: number): Promise<DepositRow[]> {
  const { rows } = await pool.query(
    `select ${DEPOSIT_COLUMNS} from deposits where privy_user_id = $1 order by created_at desc limit $2`,
    [privyUserId, limit],
  );
  return rows;
}
