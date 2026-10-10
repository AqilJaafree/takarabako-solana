import { test } from "node:test";
import assert from "node:assert/strict";
import { failedPositionPatch } from "../src/solana/jobs.js";

const none = { openSig: null, swapSig: null, payoutSig: null };

test("a failed open fails for good", () => {
  assert.deepEqual(failedPositionPatch("open", none, "boom"), { status: "failed", error: "boom" });
});

test("a failed close with nothing sent goes back to open", () => {
  assert.deepEqual(failedPositionPatch("close", none, "boom"), { status: "open", error: "boom" });
});

test("a failed close with a stored swap or payout signature stays closing", () => {
  assert.equal(failedPositionPatch("close", { openSig: "o", swapSig: "s", payoutSig: null }, "x").status, "closing");
  assert.equal(failedPositionPatch("close", { openSig: "o", swapSig: null, payoutSig: "p" }, "x").status, "closing");
});

test("a failed open whose signed open is stored stays opening for recovery", () => {
  assert.deepEqual(failedPositionPatch("open", { ...none, openSig: "o" }, "boom"), { status: "opening", error: "boom" });
});
