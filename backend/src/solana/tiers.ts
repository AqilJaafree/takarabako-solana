import { StrategyType } from "./dlmmCjs.js";

/// The three Earn tiers, all on the one mUSD/wSOL DLMM pair. The customer's
/// mUSD goes in one-sided, in the bins right next to the price: it buys SOL
/// as the price moves into the range and earns swap fees while it does.
/// Narrower = more fees per dollar while in range, out of range sooner.

export type SolTier = "low" | "medium" | "high";

export const SOL_TIERS: Record<SolTier, { label: string; strategy: StrategyType; width: number; blurb: string }> = {
  low: { label: "Low", strategy: StrategyType.Spot, width: 60, blurb: "A wide, even ladder — earns slowly, rarely leaves its range." },
  medium: { label: "Medium", strategy: StrategyType.Curve, width: 30, blurb: "Concentrated near the price — more fees, moves out sooner." },
  high: { label: "High", strategy: StrategyType.BidAsk, width: 10, blurb: "A tight band right at the price — most fees, most movement." },
};

export const isSolTier = (v: unknown): v is SolTier => v === "low" || v === "medium" || v === "high";

/// Bin range for a one-sided mUSD deposit. Token-Y liquidity has to sit
/// below the active bin and token-X liquidity above it, so the side depends
/// on which token mUSD is in the pair.
export function tierRange(tier: SolTier, activeId: number, musdIsX: boolean) {
  const { strategy, width } = SOL_TIERS[tier];
  return musdIsX
    ? { minBinId: activeId + 1, maxBinId: activeId + width, strategyType: strategy, singleSidedX: true }
    : { minBinId: activeId - width, maxBinId: activeId - 1, strategyType: strategy, singleSidedX: false };
}

export const MUSD_DECIMALS = 6;
export const SOL_DECIMALS = 9;

/// USD value of raw mUSD + raw SOL at `solPriceUsd` (mUSD ≡ $1).
export function positionValueUsd(musdRaw: bigint, solRaw: bigint, solPriceUsd: number): number {
  const v = Number(musdRaw) / 10 ** MUSD_DECIMALS + (Number(solRaw) / 10 ** SOL_DECIMALS) * solPriceUsd;
  return Math.round(v * 1e6) / 1e6;
}
