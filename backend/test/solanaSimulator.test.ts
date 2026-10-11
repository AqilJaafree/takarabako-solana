import { test } from "node:test";
import assert from "node:assert/strict";
import { simAction } from "../src/solana/simulator.js";

test("simAction: no market price keeps the fee round trip", () => {
  assert.equal(simAction(150, null), "roundTrip");
});

test("simAction: inside the band keeps the fee round trip", () => {
  assert.equal(simAction(110, 109), "roundTrip"); // +0.92%
  assert.equal(simAction(108, 109.5), "roundTrip"); // -1.37%
});

test("simAction: pool above the market sells SOL, below buys SOL", () => {
  assert.equal(simAction(150, 109.58), "sellSol");
  assert.equal(simAction(100, 109.58), "buySol");
});
