import { test } from "node:test";
import assert from "node:assert/strict";
import { failedPositionPatch, recoveryJob } from "../src/solana/jobs.js";

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

test("recoveryJob: closing → close, kiosk opening → by session, web opening → by position", () => {
  assert.deepEqual(recoveryJob({ id: "p1", status: "closing", sessionId: "s1" }), { kind: "close", positionId: "p1" });
  assert.deepEqual(recoveryJob({ id: "p2", status: "opening", sessionId: "s2" }), { kind: "open", sessionId: "s2" });
  assert.deepEqual(recoveryJob({ id: "p3", status: "opening", sessionId: null }), { kind: "openPosition", positionId: "p3" });
});

test("a failed web open stays opening: the customer's mUSD is already in the treasury", () => {
  assert.deepEqual(failedPositionPatch("open", { ...none, source: "web" }, "boom"), { status: "opening", error: "boom" });
  assert.deepEqual(failedPositionPatch("open", { ...none, source: "kiosk" }, "boom"), { status: "failed", error: "boom" });
});
