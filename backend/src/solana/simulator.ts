import { config } from "../config.js";
import { broadcast, confirm, sendAndConfirm, solanaReady, treasury, treasurySol } from "./client.js";
import { mintToTx, toRaw } from "./musd.js";
import { prepareSwapSolToMusd, swapMusdToSol, poolState } from "./meteora.js";
import { driftPct, solMarketPrice } from "./marketPrice.js";

/// Devnet market maker: nobody trades on devnet, so Earn positions would
/// never earn and the pool price would never move. With SOL_SIM=1 the
/// treasury trades against the pair every interval:
/// - pool within SIM_BAND_PCT of Solami's SOL/USD (or no market price): swap
///   a little mUSD → SOL and back, so positions near the price collect fees;
/// - pool below the market: buy SOL with mUSD (pushes the pool price up);
/// - pool above the market: sell SOL for mUSD (pushes it down).
/// One trade of SIM_TRADE_USD per tick, so the pool walks toward the market
/// over several ticks and crosses Earn positions like a real move would.

export const SIM_BAND_PCT = 2;
export const SIM_TRADE_USD = 25;
// Selling SOL never takes the treasury within this much of its floor.
const SOL_HEADROOM = 0.1;

export type SimAction = "roundTrip" | "buySol" | "sellSol";

export function simAction(poolUsd: number, marketUsd: number | null, bandPct = SIM_BAND_PCT): SimAction {
  if (marketUsd === null) return "roundTrip";
  const drift = driftPct(poolUsd, marketUsd);
  if (drift < -bandPct) return "buySol";
  if (drift > bandPct) return "sellSol";
  return "roundTrip";
}

const solFor = (usd: number, solPriceUsd: number) => BigInt(Math.floor((usd / solPriceUsd) * 0.98 * 1e9));

async function buySol(usd: number) {
  await sendAndConfirm(mintToTx(treasury().publicKey, usd));
  await swapMusdToSol(toRaw(usd));
}

async function sellSol(solRaw: bigint) {
  const { signed } = await prepareSwapSolToMusd(solRaw);
  await broadcast(signed.raw);
  const outcome = await confirm(signed.signature, signed.lastValidBlockHeight);
  if (outcome !== "confirmed") throw new Error(`SOL → mUSD swap ${signed.signature} ${outcome}`);
}

export function startSolanaSimulator() {
  if (!solanaReady || !config.solana.simEnabled) return;
  const tick = async () => {
    const usd = SIM_TRADE_USD;
    const [{ solPriceUsd }, market] = await Promise.all([poolState(), solMarketPrice()]);
    const action = simAction(solPriceUsd, market?.solUsd ?? null);
    if (action === "buySol") return buySol(usd);
    if (action === "sellSol") {
      const solRaw = solFor(usd, solPriceUsd);
      if ((await treasurySol()) - Number(solRaw) / 1e9 < config.solana.minTreasurySol + SOL_HEADROOM) {
        console.warn("[solana-sim] treasury SOL too low to sell toward the market price; skipping");
        return;
      }
      return sellSol(solRaw);
    }
    await buySol(usd);
    await sellSol(solFor(usd, (await poolState()).solPriceUsd));
  };
  setInterval(() => void tick().catch((e) => console.error("[solana-sim]", e instanceof Error ? e.message : e)), config.solana.simIntervalMs).unref();
}
