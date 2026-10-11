import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import type { Account } from "../accounts.js";
import { findByPrivyUserId } from "../accounts.js";
import { config } from "../config.js";
import { dailyAllowance, usedToday } from "../limits.js";
import { broadcast, confirm, connection, treasury, type Outcome } from "./client.js";
import { buildFundingTx, checkSignedFunding, messageHash, unsignedBase64 } from "./fundingTx.js";
import { enqueueOpenPosition } from "./jobs.js";
import { balanceRaw, fromRaw, musdMint, toRaw } from "./musd.js";
import {
  claimFunding,
  confirmFunding,
  createWebPosition,
  failFunding,
  fundingRows,
  getPosition,
  webOpeningWithoutJob,
} from "./store.js";
import { isSolTier } from "./tiers.js";

/// Earn from mUSD the customer already holds (web app). Two steps:
///   prepare — checks, a 'funding' row, and the unsigned transfer to sign;
///   submit  — checks the signed transfer is the prepared one, co-signs as
///             fee payer, stores the signature, sends, confirms, queues the open.
/// Same send rule as everywhere else: the signature is stored before
/// broadcasting, and a send whose outcome is unknown is re-checked by the
/// sweep, never re-sent.

export interface WebEarnDeps {
  pairAddress: () => string;
  balanceRaw: (owner: PublicKey) => Promise<bigint>;
  latestBlockhash: () => Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  treasury: () => Keypair;
  mint: () => PublicKey;
  priorityMicroLamports: () => number;
  broadcast: (raw: Uint8Array) => Promise<void>;
  confirm: (signature: string, lastValidBlockHeight: number) => Promise<Outcome>;
  enqueueOpen: (positionId: string) => Promise<void>;
}

export const liveWebEarnDeps: WebEarnDeps = {
  pairAddress: () => config.solana.dlmmPair,
  balanceRaw,
  latestBlockhash: () => connection.getLatestBlockhash("confirmed"),
  treasury,
  mint: musdMint,
  priorityMicroLamports: () => config.solana.priorityMicroLamports,
  broadcast,
  confirm: (sig, height) => confirm(sig, height, 60_000), // an HTTP request is waiting
  enqueueOpen: (id) => enqueueOpenPosition(id),
};

export interface Reply {
  status: number;
  body: unknown;
}

/// Smallest amount a web Earn may move.
export const MIN_WEB_EARN_MUSD = 0.01;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const APPROVAL_WINDOW_MS = 10 * 60_000;

const overLimit = (leftUsd: number): Reply => ({
  status: 403,
  body: { error: `That's over today's limit — you can move $${leftUsd.toFixed(2)} more today.`, code: "daily_limit" },
});

export async function prepareWebEarn(account: Account, amount: unknown, tier: unknown, d: WebEarnDeps = liveWebEarnDeps): Promise<Reply> {
  if (!isSolTier(tier)) return { status: 400, body: { error: "tier must be low, medium or high" } };
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0 || toRaw(amount) <= 0n || Math.abs(amount * 1e6 - Math.round(amount * 1e6)) > 1e-6) {
    return { status: 400, body: { error: "enter an amount of mUSD (up to 6 decimals)" } };
  }
  if (amount < MIN_WEB_EARN_MUSD) return { status: 400, body: { error: `the minimum is ${MIN_WEB_EARN_MUSD} mUSD` } };
  if (!account.solanaWallet) return { status: 400, body: { error: "You don't have a Solana wallet yet — choose Solana at a kiosk first." } };
  const owner = new PublicKey(account.solanaWallet);

  const allowance = await dailyAllowance(account);
  if (allowance.limited && amount > allowance.leftUsd) return overLimit(allowance.leftUsd);
  const held = await d.balanceRaw(owner);
  if (toRaw(amount) > held) return { status: 400, body: { error: `You have ${fromRaw(held)} mUSD — enter that much or less.` } };

  const { blockhash, lastValidBlockHeight } = await d.latestBlockhash();
  const id = crypto.randomUUID();
  const tx = buildFundingTx({
    owner,
    treasury: d.treasury().publicKey,
    mint: d.mint(),
    amountRaw: toRaw(amount),
    blockhash,
    lastValidBlockHeight,
    priorityMicroLamports: d.priorityMicroLamports(),
    memo: `takarabako:${id}`,
  });
  const row = await createWebPosition({
    id,
    privyUserId: account.privyUserId,
    tier,
    pair: d.pairAddress(),
    musdIn: amount,
    fundingMessageHash: messageHash(tx),
    fundingValidHeight: lastValidBlockHeight,
  });
  // Two prepares can both pass the check above; whoever lands second sees the total.
  const used = await usedToday(account.privyUserId);
  if (used > config.dailyLimitUsd + 1e-9) {
    await failFunding(row.id, "over today's limit", null);
    return overLimit(Math.max(0, config.dailyLimitUsd - (used - amount)));
  }
  return { status: 200, body: { id: row.id, tx: unsignedBase64(tx) } };
}

export async function submitWebEarn(privyUserId: string, id: string, signedTx: unknown, d: WebEarnDeps = liveWebEarnDeps): Promise<Reply> {
  const row = UUID.test(id) ? await getPosition(id) : null; // fresh read: the 409 below must see a signature stored a moment ago
  if (!row || row.privyUserId !== privyUserId || row.source !== "web") return { status: 404, body: { error: "position not found" } };
  if (row.status !== "funding" || row.fundingSig) return { status: 409, body: { error: `position is ${row.status}`, code: "already_submitted" } };
  const account = await findByPrivyUserId(privyUserId);
  if (!account?.solanaWallet || typeof signedTx !== "string" || !row.fundingMessageHash || row.fundingValidHeight == null) {
    return { status: 400, body: { error: "signed transaction required" } };
  }

  const check = checkSignedFunding(signedTx, row.fundingMessageHash, new PublicKey(account.solanaWallet));
  if (!check.ok) {
    await failFunding(id, check.reason, null);
    return { status: 400, body: { error: check.reason } };
  }
  const owner = new PublicKey(account.solanaWallet);
  if ((await d.balanceRaw(owner)) < toRaw(row.musdIn)) {
    const reason = "your mUSD balance changed — prepare again";
    await failFunding(id, reason, null);
    return { status: 400, body: { error: reason } };
  }
  check.tx.partialSign(d.treasury());
  const signature = bs58.encode(check.tx.signature!);
  if (!(await claimFunding(id, signature))) {
    return { status: 409, body: { error: "already submitted", code: "already_submitted" } };
  }
  try {
    await d.broadcast(check.tx.serialize());
    return await settle(id, signature, row.fundingValidHeight, d);
  } catch (err) {
    // Unknown outcome: the signature is stored; the sweep re-checks it.
    console.error(`[solana] web earn ${id}: ${err instanceof Error ? err.message : err}`);
    return { status: 202, body: { id, status: "funding" } };
  }
}

/// Cancels an Earn the customer didn't approve (e.g. rejected in their wallet),
/// freeing its share of the daily limit. Only while no signature is stored.
export async function cancelWebEarn(privyUserId: string, id: string): Promise<Reply> {
  const row = UUID.test(id) ? await getPosition(id) : null;
  if (!row || row.privyUserId !== privyUserId || row.source !== "web") return { status: 404, body: { error: "position not found" } };
  if (!(await failFunding(id, "cancelled", null))) return { status: 409, body: { error: `position is ${row.status}`, code: "not_cancellable" } };
  return { status: 200, body: { id, status: "failed" } };
}

/// Confirms a stored funding signature and moves the row on. Throws if the
/// outcome is still unknown.
async function settle(id: string, signature: string, validHeight: number, d: WebEarnDeps): Promise<Reply> {
  const outcome = await d.confirm(signature, validHeight);
  if (outcome === "confirmed") {
    // Queue the open only if this run moved it on, or it was already 'opening'.
    if ((await confirmFunding(id)) || (await getPosition(id))?.status === "opening") await d.enqueueOpen(id);
    return { status: 202, body: { id, status: "opening" } };
  }
  const reason = `the mUSD transfer ${outcome} — nothing moved, try again`;
  await failFunding(id, reason, signature);
  return { status: 400, body: { error: reason } };
}

/// The sweep: settle sent transfers whose outcome was unknown, fail approvals
/// never given, and re-queue confirmed rows whose open job was lost.
export async function resolveFunding(d: WebEarnDeps = liveWebEarnDeps): Promise<void> {
  for (const row of await fundingRows()) {
    if (row.fundingSig && row.fundingValidHeight != null) {
      await settle(row.id, row.fundingSig, row.fundingValidHeight, d).catch(() => {}); // still unknown: next sweep
    } else if (Date.now() - new Date(row.createdAt).getTime() > APPROVAL_WINDOW_MS) {
      await failFunding(row.id, "not approved in time", null);
    }
  }
  for (const id of await webOpeningWithoutJob()) await d.enqueueOpen(id);
}

export function startFundingSweep() {
  const tick = () => void resolveFunding().catch((e) => console.error("[solana] funding sweep:", e instanceof Error ? e.message : e));
  tick();
  setInterval(tick, 2 * 60_000).unref();
}
