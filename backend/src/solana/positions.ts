import { PublicKey } from "@solana/web3.js";
import { findByPrivyUserId } from "../accounts.js";
import { config } from "../config.js";
import { publishUserEvent, type UserEvent } from "../events.js";
import { broadcast, confirm, signTx, type Outcome, type SignedTx } from "./client.js";
import * as meteora from "./meteora.js";
import { transferFromTreasuryTx, fromRaw, toRaw } from "./musd.js";
import {
  createPositionForSession,
  finalizeClose,
  finalizeOpen,
  getPosition,
  positionForSession,
  sessionSettled,
  updatePosition,
  updatePositionIf,
  type SolPositionRow,
} from "./store.js";
import { SOL_TIERS, positionValueUsd, type SolTier } from "./tiers.js";
import { solanaWalletFor } from "./wallets.js";

/// Earn positions, step by step. Every on-chain step either checks chain
/// state first (remove) or stores its signed transaction before sending
/// (open, swap, payout), so a job retried after any failure picks up where
/// it stopped and never pays twice.
///
/// Signature rules (same as the deposit queue): a signature is stored only if
/// none is stored yet; it is cleared only when confirm() says "expired" or
/// "failed" (the transaction can then never land). If broadcast() or
/// confirm() throws, the outcome is unknown: the signature stays and the next
/// run re-checks it.

export interface PositionDeps {
  pairAddress: () => string;
  prepareOpen: (tier: SolTier, musdRaw: bigint) => Promise<{ signed: SignedTx; position: string; minBinId: number; maxBinId: number }>;
  positionAmounts: (position: string) => Promise<meteora.PositionAmounts>;
  positionExists: (position: string) => Promise<boolean>;
  removeAll: (position: string, lowerBinId: number, upperBinId: number) => Promise<string[]>;
  prepareSwap: (solRaw: bigint) => Promise<{ signed: SignedTx; outRaw: bigint }>;
  /// mUSD the treasury actually received in a confirmed swap; null if unknown.
  swapReceivedRaw: (signature: string) => Promise<bigint | null>;
  signPayout: (owner: string, raw: bigint) => Promise<SignedTx>;
  broadcast: (raw: Uint8Array) => Promise<void>;
  confirm: (signature: string, lastValidBlockHeight: number) => Promise<Outcome>;
  solPriceUsd: () => Promise<number>;
  publish: (privyUserId: string, event: UserEvent) => Promise<void>;
}

export const liveDeps: PositionDeps = {
  pairAddress: () => config.solana.dlmmPair,
  prepareOpen: meteora.prepareOpen,
  positionAmounts: meteora.positionAmounts,
  positionExists: meteora.positionExists,
  removeAll: meteora.removeAll,
  prepareSwap: meteora.prepareSwapSolToMusd,
  swapReceivedRaw: async (signature) => {
    // a just-confirmed transaction can take a moment to be served by getTransaction
    for (let i = 0; i < 3; i++) {
      const raw = await meteora.swapReceivedRaw(signature);
      if (raw != null) return raw;
      await new Promise((r) => setTimeout(r, 1_000));
    }
    return null;
  },
  signPayout: (owner, raw) => signTx(transferFromTreasuryTx(new PublicKey(owner), raw)),
  broadcast,
  confirm,
  solPriceUsd: async () => (await meteora.poolState()).solPriceUsd,
  publish: publishUserEvent,
};

const pairLabel = (tier: SolTier) => `mUSD/SOL · ${SOL_TIERS[tier].label}`;

/// Opens the Earn position for a finished session (idempotent).
export async function openForSession(sessionId: string, d: PositionDeps = liveDeps): Promise<SolPositionRow | null> {
  if (!(await sessionSettled(sessionId))) throw new Error(`session ${sessionId}: notes still settling`);
  let row = await createPositionForSession(sessionId, d.pairAddress());
  if (!row || row.status !== "opening") return row;

  let signature = row.openSig;
  let validHeight = row.openValidHeight;
  if (!signature || validHeight == null) {
    const prepared = await d.prepareOpen(row.tier, toRaw(row.musdIn));
    // stored before sending; false means another run already stored a send
    const stored = await updatePositionIf(row.id, "openSig", null, {
      positionPubkey: prepared.position,
      minBinId: prepared.minBinId,
      maxBinId: prepared.maxBinId,
      openSig: prepared.signed.signature,
      openValidHeight: prepared.signed.lastValidBlockHeight,
    });
    if (!stored) throw new Error(`position ${row.id}: an open is already recorded - not sending a second`);
    signature = prepared.signed.signature;
    validHeight = prepared.signed.lastValidBlockHeight;
    await d.broadcast(prepared.signed.raw);
  }
  const outcome = await d.confirm(signature, validHeight);
  if (outcome !== "confirmed") {
    await updatePositionIf(row.id, "openSig", signature, {
      openSig: null, openValidHeight: null, positionPubkey: null, minBinId: null, maxBinId: null,
    });
    throw new Error(`position open ${signature} ${outcome} - opening again`);
  }

  // status + History in one transaction; publish only after it commits
  const finalized = await finalizeOpen(row.id, {
    privyUserId: row.privyUserId, action: "open", riskTier: row.tier, pair: pairLabel(row.tier),
    apyBps: null, amountUsd: row.musdIn, rationale: null, ensName: null, txHash: signature, chain: "sol",
  });
  row = (await getPosition(row.id))!;
  if (finalized) {
    await d.publish(row.privyUserId, { type: "solana.position.opened", positionId: row.id, tier: row.tier, amountUsd: row.musdIn, signature });
  }
  return row;
}

/// Closes a position the customer asked to close (status 'closing').
export async function closePosition(id: string, d: PositionDeps = liveDeps): Promise<SolPositionRow | null> {
  let row = await getPosition(id);
  if (!row || row.status !== "closing") return row;
  if (!row.positionPubkey) throw new Error(`position ${id}: closing but has no position address`);
  const positionPubkey = row.positionPubkey;
  const account = await findByPrivyUserId(row.privyUserId);
  if (!account) throw new Error(`position ${id}: account missing`);

  // 1. Take everything out of the pair. While the position exists, its
  //    amounts are re-read and stored right before removing (removal is one
  //    atomic transaction — tier widths fit one 70-bin chunk — so the
  //    position is either untouched or gone). Once it's gone, the last
  //    stored amounts are what came out.
  if (!row.removedAt) {
    if (await d.positionExists(positionPubkey)) {
      const a = await d.positionAmounts(positionPubkey);
      await updatePosition(id, { musdOutRaw: a.musdRaw.toString(), solOutRaw: a.solRaw.toString() });
      await d.removeAll(positionPubkey, row.minBinId!, row.maxBinId!);
    } else if (row.musdOutRaw == null) {
      throw new Error(`position ${id}: no longer on chain and no amounts recorded - needs a manual check`);
    }
    await updatePosition(id, { removedAt: new Date() });
    row = (await getPosition(id))!;
  }

  // 2. Swap the SOL side back to mUSD.
  const solOut = BigInt(row.solOutRaw ?? "0");
  if (solOut > 0n && !row.swapConfirmedAt) {
    let signature = row.swapSig;
    let validHeight = row.swapValidHeight;
    if (!signature || validHeight == null) {
      const { signed, outRaw } = await d.prepareSwap(solOut);
      const stored = await updatePositionIf(id, "swapSig", null, {
        swapSig: signed.signature, swapValidHeight: signed.lastValidBlockHeight, swapOutRaw: outRaw.toString(),
      });
      if (!stored) throw new Error(`position ${id}: a swap is already recorded - not sending a second`);
      signature = signed.signature;
      validHeight = signed.lastValidBlockHeight;
      await d.broadcast(signed.raw);
    }
    const outcome = await d.confirm(signature, validHeight);
    if (outcome !== "confirmed") {
      await updatePositionIf(id, "swapSig", signature, { swapSig: null, swapValidHeight: null, swapOutRaw: null });
      throw new Error(`swap ${signature} ${outcome} - swapping again`);
    }
    // Pay what actually arrived, not the quote; keep the quote if the chain can't tell us.
    const received = await d.swapReceivedRaw(signature).catch((err) => {
      console.error(`[solana] swap ${signature} received amount:`, err instanceof Error ? err.message : err);
      return null;
    });
    if (received == null) console.error(`[solana] swap ${signature}: actual mUSD received unknown - paying the quoted ${row.swapOutRaw}`);
    await updatePosition(id, { ...(received != null && { swapOutRaw: received.toString() }), swapConfirmedAt: new Date() });
    row = (await getPosition(id))!;
  }

  // 3. Pay the customer.
  const payoutRaw = BigInt(row.musdOutRaw ?? "0") + BigInt(row.swapOutRaw ?? "0");
  let signature = row.payoutSig;
  let validHeight = row.payoutValidHeight;
  if (!signature || validHeight == null) {
    const wallet = await solanaWalletFor(account);
    const signed = await d.signPayout(wallet, payoutRaw);
    const stored = await updatePositionIf(id, "payoutSig", null, { payoutSig: signed.signature, payoutValidHeight: signed.lastValidBlockHeight });
    if (!stored) throw new Error(`position ${id}: a payout is already recorded - not sending a second`);
    signature = signed.signature;
    validHeight = signed.lastValidBlockHeight;
    await d.broadcast(signed.raw);
  }
  const outcome = await d.confirm(signature, validHeight);
  if (outcome !== "confirmed") {
    await updatePositionIf(id, "payoutSig", signature, { payoutSig: null, payoutValidHeight: null });
    throw new Error(`payout ${signature} ${outcome} - paying again`);
  }

  const valueOut = fromRaw(payoutRaw);
  // status + History in one transaction; publish only after it commits
  const finalized = await finalizeClose(id, { valueOut, payoutSig: signature }, {
    privyUserId: row.privyUserId, action: "close", riskTier: row.tier, pair: pairLabel(row.tier),
    apyBps: null, amountUsd: valueOut, rationale: null, ensName: null, txHash: signature, chain: "sol",
  });
  if (finalized) await d.publish(row.privyUserId, { type: "solana.position.closed", positionId: id, valueUsd: valueOut, signature });
  return getPosition(id);
}

export interface PositionView {
  id: string;
  tier: SolTier;
  label: string;
  status: SolPositionRow["status"];
  musdIn: number;
  valueUsd: number | null;
  feesUsd: number | null;
  inRange: boolean | null;
  minBinId: number | null;
  maxBinId: number | null;
  openSig: string | null;
  payoutSig: string | null;
  valueOut: number | null;
  error: string | null;
  createdAt: Date;
}

/// What the customer sees: live value for open positions, final value for closed ones.
export async function viewPosition(row: SolPositionRow, d: Pick<PositionDeps, "positionAmounts" | "solPriceUsd"> = liveDeps): Promise<PositionView> {
  let valueUsd: number | null = null;
  let feesUsd: number | null = null;
  let inRange: boolean | null = null;
  if (row.status === "open" && row.positionPubkey) {
    try {
      const [a, price, state] = await Promise.all([d.positionAmounts(row.positionPubkey), d.solPriceUsd(), meteora.poolState()]);
      valueUsd = positionValueUsd(a.musdRaw, a.solRaw, price);
      feesUsd = positionValueUsd(a.feesMusdRaw, a.feesSolRaw, price);
      inRange = state.activeId >= a.lowerBinId && state.activeId <= a.upperBinId;
    } catch (err) {
      console.error(`[solana] view ${row.id}:`, err instanceof Error ? err.message : err);
    }
  }
  return {
    id: row.id, tier: row.tier, label: pairLabel(row.tier), status: row.status, musdIn: row.musdIn,
    valueUsd: row.status === "closed" ? row.valueOut : valueUsd, feesUsd, inRange,
    minBinId: row.minBinId, maxBinId: row.maxBinId, openSig: row.openSig, payoutSig: row.payoutSig,
    valueOut: row.valueOut, error: row.error, createdAt: row.createdAt,
  };
}

export { positionForSession };
