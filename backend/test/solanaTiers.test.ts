import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_BIN_PER_POSITION, DLMM, StrategyType } from "../src/solana/dlmmCjs.js";
import { MAX_TIER_WIDTH, SOL_TIERS, tierRange, isSolTier, positionValueUsd } from "../src/solana/tiers.js";

test("tiers: Low wide Spot, Medium Curve, High narrow BidAsk", () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(SOL_TIERS).map(([k, t]) => [k, [t.strategy, t.width]])),
    { low: [StrategyType.Spot, 60], medium: [StrategyType.Curve, 30], high: [StrategyType.BidAsk, 10] },
  );
  for (const t of Object.values(SOL_TIERS)) assert.ok(t.width <= 70, "fits one default DLMM position");
});

test("every tier is removed in ONE transaction (width < DEFAULT_BIN_PER_POSITION)", () => {
  // closePosition relies on removal being atomic: the SDK sends one remove tx per 70-bin chunk.
  assert.equal(DEFAULT_BIN_PER_POSITION, 70);
  assert.ok(MAX_TIER_WIDTH < DEFAULT_BIN_PER_POSITION);
  for (const [k, t] of Object.entries(SOL_TIERS)) assert.ok(t.width <= MAX_TIER_WIDTH, `${k}: width ${t.width} needs more than one remove tx`);
});

test("mUSD as token Y sits in the bins just below the active bin", () => {
  assert.deepEqual(tierRange("high", 1000, false), { minBinId: 990, maxBinId: 999, strategyType: StrategyType.BidAsk, singleSidedX: false });
  assert.deepEqual(tierRange("low", -5, false), { minBinId: -65, maxBinId: -6, strategyType: StrategyType.Spot, singleSidedX: false });
});

test("mUSD as token X sits in the bins just above the active bin", () => {
  assert.deepEqual(tierRange("medium", 1000, true), { minBinId: 1001, maxBinId: 1030, strategyType: StrategyType.Curve, singleSidedX: true });
});

test("isSolTier", () => {
  assert.ok(isSolTier("low") && isSolTier("medium") && isSolTier("high"));
  assert.ok(!isSolTier("advanced") && !isSolTier(undefined));
});

test("value = mUSD + SOL × price, all raw amounts", () => {
  // 12.5 mUSD (6 dp) + 0.1 SOL (9 dp) at $150
  assert.equal(positionValueUsd(12_500_000n, 100_000_000n, 150), 27.5);
});

test("dlmm shim exposes the DLMM class and StrategyType", () => {
  assert.equal(typeof DLMM.create, "function");
  assert.equal(StrategyType.BidAsk, 2);
});
