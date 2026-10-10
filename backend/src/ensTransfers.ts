import { decodeEventLog, parseAbi, type Address } from "viem";
import { pool } from "./db.js";
import { config } from "./config.js";
import { findByPrivyUserId, type Account } from "./accounts.js";
import { publicClient, depositOnChain, withdrawUsdOnChain, treasuryAddress, fundWalletWithEthOnChain } from "./chain.js";
import { ensReady, ownerOfName, positionSubname, resolveName, setRecords, textRecord } from "./ens.js";
import { cashReceiptReady, fromTkUnits } from "./cashReceipt.js";
import { ALIASES, LABELS, mbCall } from "./multibaas.js";
import { openPositions } from "./aqua.js";
import { onChainEvent } from "./chainEvents.js";
import { assertWithinLimit } from "./limits.js";

/// Sending by ENS name. A name is resolved through the official ENS v2
/// Universal Resolver; the address it points to is matched to a Takarabako
/// customer by their wallet.
///   box balance — moved by the backend (vault shares out of one box, into another)
///   tkCASH      — signed by the sender in their own wallet (web app); recorded here
///   positions   — the position's ENS name is its deed: the sender transfers the
///                 name token in their own wallet, and whoever holds it owns the position

async function accountByWallet(address: string): Promise<Account | null> {
  const { rows } = await pool.query("select privy_user_id from accounts where lower(privy_wallet) = lower($1)", [address]);
  return rows[0] ? findByPrivyUserId(rows[0].privy_user_id) : null;
}

export interface Resolved {
  name: string;
  address: string;
  kind: string | null; // takarabako.kind text record: customer | kiosk | aqua-position
  customer: { ensName: string | null } | null;
  tkcashAllowlisted: boolean | null;
}

export async function lookup(name: string): Promise<Resolved | null> {
  const clean = name.trim().toLowerCase();
  const r = await resolveName(clean);
  if (!r) return null;
  const [kind, account, allowlisted] = await Promise.all([
    textRecord(clean, "takarabako.kind"),
    accountByWallet(r.address),
    cashReceiptReady ? mbCall<boolean>(ALIASES.tkcash, LABELS.cashReceipt, "allowlist", [r.address]).catch(() => null) : Promise.resolve(null),
  ]);
  return {
    name: clean,
    address: r.address,
    kind,
    customer: account ? { ensName: account.ensName } : null,
    tkcashAllowlisted: allowlisted,
  };
}

async function record(t: {
  kind: "balance" | "tkcash" | "position";
  from: string | null;
  to: string | null;
  toName?: string | null;
  toAddress?: string | null;
  amountUsd?: number | null;
  positionId?: string | null;
  txHash?: string | null;
}) {
  await pool.query(
    `insert into transfers (id, kind, from_user, to_user, to_name, to_address, amount_usd, position_id, tx_hash)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) on conflict do nothing`,
    [crypto.randomUUID(), t.kind, t.from, t.to, t.toName ?? null, t.toAddress ?? null, t.amountUsd ?? null, t.positionId ?? null, t.txHash ?? null],
  );
}

/// Box balance to another customer, by name. Custodial: the vault is ours.
export async function sendBalance(from: Account, toName: string, amount: number) {
  await assertWithinLimit(from, amount, "this send");
  const target = await lookup(toName);
  if (!target) throw new Error(`${toName} doesn't resolve to an address`);
  const to = await accountByWallet(target.address);
  if (!to) throw new Error(`${toName} isn't a Takarabako customer — box balance can only go to another box`);
  if (to.privyUserId === from.privyUserId) throw new Error("that's your own name");
  // Out of the sender's vault shares, into the recipient's.
  await withdrawUsdOnChain(from.boundAddress as Address, treasuryAddress!, amount);
  const { txHash } = await depositOnChain(to.boundAddress as Address, amount);
  await record({ kind: "balance", from: from.privyUserId, to: to.privyUserId, toName: target.name, toAddress: target.address, amountUsd: amount, txHash });
  return { to: target, txHash };
}

const tkcashTransfer = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);

/// Records a tkCASH transfer the customer signed in their own wallet, after
/// checking the transaction really moved tkCASH from them.
export async function confirmTkcashSend(from: Account, txHash: string, toName: string | null) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash as `0x${string}`, timeout: 60_000 });
  if (receipt.status !== "success") throw new Error("the transfer reverted on-chain");
  const log = receipt.logs.find((l) => l.address.toLowerCase() === config.cashReceiptAddress.toLowerCase());
  if (!log) throw new Error("no tkCASH transfer in that transaction");
  const ev = decodeEventLog({ abi: tkcashTransfer, data: log.data, topics: log.topics });
  if (ev.args.from.toLowerCase() !== from.privyWallet.toLowerCase()) throw new Error("that transfer wasn't from your wallet");
  const to = await accountByWallet(ev.args.to);
  const amountUsd = fromTkUnits(ev.args.value);
  await record({ kind: "tkcash", from: from.privyUserId, to: to?.privyUserId ?? null, toName, toAddress: ev.args.to, amountUsd, txHash });
  return { to: ev.args.to, amountUsd, toCustomer: to?.ensName ?? null };
}

/// Makes the database agree with the chain about who holds each open
/// position's deed name. Run after a customer transfers one, and whenever
/// MultiBaas reports a transfer on our ENS registry.
export async function reconcileDeeds(onlyPositionId?: string) {
  if (!ensReady) return [];
  const changes: Array<{ positionId: string; from: string; to: string | null; holder: string }> = [];
  for (const p of await openPositions()) {
    if (onlyPositionId && p.id !== onlyPositionId) continue;
    const holder = await ownerOfName(positionSubname(p.id));
    if (!holder) continue;
    const owner = await findByPrivyUserId(p.privyUserId);
    if (owner && owner.privyWallet.toLowerCase() === holder.toLowerCase()) continue;
    const next = await accountByWallet(holder);
    if (next) {
      await pool.query("update aqua_positions set privy_user_id = $2, deed_holder = null where id = $1", [p.id, next.privyUserId]);
    } else {
      await pool.query("update aqua_positions set deed_holder = $2 where id = $1", [p.id, holder]);
    }
    // Point the deed's address record at its new holder.
    await setRecords(positionSubname(p.id), { addr: holder }).catch((err) => console.error("[ens] deed record:", err.message));
    await record({ kind: "position", from: p.privyUserId, to: next?.privyUserId ?? null, toName: next?.ensName ?? null, toAddress: holder, amountUsd: p.amountUsd, positionId: p.id });
    changes.push({ positionId: p.id, from: p.privyUserId, to: next?.privyUserId ?? null, holder });
    console.log(`[deeds] ${positionSubname(p.id)} moved to ${next?.ensName ?? holder}`);
  }
  return changes;
}

/// Only the deed's holder may close a position (the name is the ownership).
export async function holdsDeed(account: Account, positionId: string): Promise<boolean> {
  if (!ensReady) return true;
  const holder = await ownerOfName(positionSubname(positionId));
  return !holder || holder.toLowerCase() === account.privyWallet.toLowerCase();
}

const MIN_GAS_ETH = 0.0005;
const TOP_UP_ETH = 0.001;
const lastTopUp = new Map<string, number>();

/// Customers pay gas for transfers they sign; top their wallet up when low (at most hourly).
export async function ensureGas(account: Account) {
  const wei = await publicClient.getBalance({ address: account.privyWallet as Address });
  const eth = Number(wei) / 1e18;
  if (eth >= MIN_GAS_ETH) return { eth, toppedUp: false };
  const last = lastTopUp.get(account.privyUserId) ?? 0;
  if (Date.now() - last < 3600_000) return { eth, toppedUp: false };
  lastTopUp.set(account.privyUserId, Date.now());
  const { txHash } = await fundWalletWithEthOnChain(account.privyWallet as Address, TOP_UP_ETH);
  return { eth: eth + TOP_UP_ETH, toppedUp: true, txHash };
}

/// MultiBaas streams our ENS registry's events; a name token changing hands
/// may be a position deed, so reconcile.
export function startDeedWatcher() {
  onChainEvent(async (e) => {
    if (e.contractLabel === LABELS.ensRegistry && (e.name === "TransferSingle" || e.name === "TransferBatch")) {
      await reconcileDeeds().catch((err) => console.error("[deeds]", err instanceof Error ? err.message : err));
    }
  });
}
