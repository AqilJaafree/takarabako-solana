import { DLMM } from "./dlmmCjs.js";
import { Keypair, PublicKey, type TokenBalance } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import BN from "bn.js";
import { config } from "../config.js";
import { connection, sendAndConfirm, signTx, treasury, type SignedTx } from "./client.js";
import { musdMint } from "./musd.js";
import { SOL_TIERS, tierRange, type SolTier } from "./tiers.js";

/// The one mUSD/wSOL DLMM V2 pair. Every position is owned by the treasury;
/// solana/positions.ts tracks whose it is.

const OPT = { cluster: "devnet" as const };
let cached: DLMM | null = null;

export async function pair(): Promise<DLMM> {
  cached ??= await DLMM.create(connection, new PublicKey(config.solana.dlmmPair), OPT);
  await cached.refetchStates(); // always quote from current state
  return cached;
}

export interface PoolState {
  pair: string;
  activeId: number;
  binStep: number;
  musdIsX: boolean;
  solPriceUsd: number; // mUSD per SOL at the active bin
}

export async function poolState(): Promise<PoolState> {
  const p = await pair();
  const active = await p.getActiveBin();
  const musdIsX = p.tokenX.publicKey.equals(musdMint());
  const yPerX = Number(active.pricePerToken); // UI units: token Y per token X
  return { pair: p.pubkey.toBase58(), activeId: active.binId, binStep: p.lbPair.binStep, musdIsX, solPriceUsd: musdIsX ? 1 / yPerX : yPerX };
}

/// Signs (doesn't send) a new one-sided mUSD position for `tier`.
export async function prepareOpen(tier: SolTier, musdRaw: bigint) {
  const p = await pair();
  const st = await poolState();
  const range = tierRange(tier, st.activeId, st.musdIsX);
  const position = Keypair.generate();
  const amount = new BN(musdRaw.toString());
  const tx = await p.initializePositionAndAddLiquidityByStrategy({
    positionPubKey: position.publicKey,
    user: treasury().publicKey,
    totalXAmount: st.musdIsX ? amount : new BN(0),
    totalYAmount: st.musdIsX ? new BN(0) : amount,
    strategy: { minBinId: range.minBinId, maxBinId: range.maxBinId, strategyType: SOL_TIERS[tier].strategy, singleSidedX: range.singleSidedX },
    slippage: 1, // %
  });
  const signed: SignedTx = await signTx(tx, [position]);
  return { signed, position: position.publicKey.toBase58(), minBinId: range.minBinId, maxBinId: range.maxBinId };
}

export interface PositionAmounts {
  musdRaw: bigint; // liquidity + unclaimed fees
  solRaw: bigint;
  feesMusdRaw: bigint;
  feesSolRaw: bigint;
  lowerBinId: number;
  upperBinId: number;
}

const big = (v: string | BN) => BigInt(typeof v === "string" ? Math.floor(Number(v)).toString() : v.toString());

export async function positionAmounts(position: string): Promise<PositionAmounts> {
  const p = await pair();
  const { positionData: d } = await p.getPosition(new PublicKey(position));
  const musdIsX = p.tokenX.publicKey.equals(musdMint());
  const [x, y, fx, fy] = [big(d.totalXAmount), big(d.totalYAmount), big(d.feeX), big(d.feeY)];
  return musdIsX
    ? { musdRaw: x + fx, solRaw: y + fy, feesMusdRaw: fx, feesSolRaw: fy, lowerBinId: d.lowerBinId, upperBinId: d.upperBinId }
    : { musdRaw: y + fy, solRaw: x + fx, feesMusdRaw: fy, feesSolRaw: fx, lowerBinId: d.lowerBinId, upperBinId: d.upperBinId };
}

export async function positionExists(position: string): Promise<boolean> {
  return (await connection.getAccountInfo(new PublicKey(position), "confirmed")) !== null;
}

/// Removes all liquidity, claims fees and closes the position. SOL comes
/// back unwrapped into the treasury's native balance.
export async function removeAll(position: string, lowerBinId: number, upperBinId: number): Promise<string[]> {
  const p = await pair();
  const txs = await p.removeLiquidity({
    user: treasury().publicKey,
    position: new PublicKey(position),
    fromBinId: lowerBinId,
    toBinId: upperBinId,
    bps: new BN(10_000),
    shouldClaimAndClose: true,
  });
  const sigs: string[] = [];
  for (const tx of txs) sigs.push(await sendAndConfirm(tx));
  return sigs;
}

/// Signs (doesn't send) a swap of `solRaw` SOL into mUSD through the pair.
/// `outRaw` is the quote's expected output — an estimate; once the swap
/// confirms, swapReceivedRaw() reads what actually arrived.
export async function prepareSwapSolToMusd(solRaw: bigint): Promise<{ signed: SignedTx; outRaw: bigint }> {
  const p = await pair();
  const musdIsX = p.tokenX.publicKey.equals(musdMint());
  const swapForY = !musdIsX; // SOL is X → swapping X for Y
  const binArrays = await p.getBinArrayForSwap(swapForY, 4);
  const quote = p.swapQuote(new BN(solRaw.toString()), swapForY, new BN(100), binArrays); // 1% slippage
  const tx = await p.swap({
    inToken: NATIVE_MINT,
    outToken: musdMint(),
    inAmount: quote.consumedInAmount,
    minOutAmount: quote.minOutAmount,
    lbPair: p.pubkey,
    user: treasury().publicKey,
    binArraysPubkey: quote.binArraysPubkey,
  });
  return { signed: await signTx(tx), outRaw: BigInt(quote.outAmount.toString()) };
}

/// Devnet only (simulator, setup): swap mUSD → SOL.
export async function swapMusdToSol(musdRaw: bigint): Promise<string> {
  const p = await pair();
  const musdIsX = p.tokenX.publicKey.equals(musdMint());
  const swapForY = musdIsX;
  const binArrays = await p.getBinArrayForSwap(swapForY, 4);
  const quote = p.swapQuote(new BN(musdRaw.toString()), swapForY, new BN(100), binArrays);
  const tx = await p.swap({
    inToken: musdMint(),
    outToken: NATIVE_MINT,
    inAmount: quote.consumedInAmount,
    minOutAmount: quote.minOutAmount,
    lbPair: p.pubkey,
    user: treasury().publicKey,
    binArraysPubkey: quote.binArraysPubkey,
  });
  return sendAndConfirm(tx);
}

/// mUSD the treasury's token account gained in a confirmed transaction
/// (post - pre token balance). Null if the transaction can't be fetched or
/// doesn't show the treasury's mUSD balance.
export async function swapReceivedRaw(signature: string): Promise<bigint | null> {
  const tx = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  if (!tx?.meta?.postTokenBalances) return null;
  const mint = musdMint().toBase58();
  const owner = treasury().publicKey.toBase58();
  const amount = (list: TokenBalance[] | null | undefined) =>
    list?.find((b) => b.mint === mint && b.owner === owner)?.uiTokenAmount.amount;
  const post = amount(tx.meta.postTokenBalances);
  if (post == null) return null;
  const pre = amount(tx.meta.preTokenBalances) ?? "0"; // account created in this tx
  const received = BigInt(post) - BigInt(pre);
  return received >= 0n ? received : null;
}
