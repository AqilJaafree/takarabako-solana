import { test } from "node:test";
import assert from "node:assert/strict";
import { driftPct, parseSolamiPrice } from "../src/solana/marketPrice.js";

const WSOL = "So11111111111111111111111111111111111111112";

test("parseSolamiPrice picks the wSOL row", () => {
  const body = [
    { mint: "other", price_usd: "1", block_time: 1 },
    { mint: WSOL, price_usd: "109.5775", price_native: "109.5775", block_time: 1791688997 },
  ];
  assert.deepEqual(parseSolamiPrice(body), { solUsd: 109.5775, at: 1791688997, source: "solami" });
});

test("parseSolamiPrice rejects missing or bad prices", () => {
  assert.equal(parseSolamiPrice([]), null); // Solami omits tokens with no recent trade
  assert.equal(parseSolamiPrice({ message: "unauthorized" }), null);
  assert.equal(parseSolamiPrice([{ mint: WSOL, price_usd: "abc" }]), null);
  assert.equal(parseSolamiPrice([{ mint: WSOL, price_usd: "0" }]), null);
});

test("driftPct: pool vs market, two decimals", () => {
  assert.equal(driftPct(150, 109.58), 36.89);
  assert.equal(driftPct(100, 125), -20);
  assert.equal(driftPct(110, 110), 0);
});
