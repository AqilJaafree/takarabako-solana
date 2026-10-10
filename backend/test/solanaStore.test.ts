import { test, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.js";

const pool = await freshDb();
const accounts = await import("../src/accounts.js");
const history = await import("../src/history.js");
const store = await import("../src/solana/store.js");
after(() => pool.end());

await accounts.insertAccount({ privyUserId: "u-sol", email: "s@x.io", privyWallet: "0x00000000000000000000000000000000000000a1", boundAddress: "0x00000000000000000000000000000000000000b1", ensName: null });

test("a new session goes to the Ethereum vault by default", async () => {
  const s = await history.openDepositSession("u-sol");
  assert.deepEqual(await store.sessionDestination(s.id), { destination: "evm", tier: null });
  assert.deepEqual(await store.sessionDestination(null), { destination: "evm", tier: null });
});

test("destination can be set until the first note, then it's locked", async () => {
  const s = await history.openDepositSession("u-sol");
  assert.equal(await store.setSessionDestination(s.id, "u-sol", "sol_earn", "high"), "ok");
  assert.deepEqual(await store.sessionDestination(s.id), { destination: "sol_earn", tier: "high" });
  assert.equal(await store.setSessionDestination(s.id, "someone-else", "evm", null), "not_found");
  await accounts.createQueuedDeposit({ privyUserId: "u-sol", currency: "USD", amount: 10, sessionId: s.id });
  assert.equal(await store.setSessionDestination(s.id, "u-sol", "sol_hold", null), "locked");
});

test("parseDestination: tier required for Earn and only for Earn", () => {
  assert.deepEqual(store.parseDestination({ destination: "sol_earn", tier: "low" }), { destination: "sol_earn", tier: "low" });
  assert.deepEqual(store.parseDestination({ destination: "sol_hold" }), { destination: "sol_hold", tier: null });
  assert.equal(store.parseDestination({ destination: "sol_earn" }), null);
  assert.equal(store.parseDestination({ destination: "evm", tier: "low" }), null);
  assert.equal(store.parseDestination({ destination: "btc" }), null);
});

test("an Earn session's position is created once, from its confirmed Solana notes", async () => {
  const s = await history.openDepositSession("u-sol");
  await store.setSessionDestination(s.id, "u-sol", "sol_earn", "medium");
  const a = await accounts.createQueuedDeposit({ privyUserId: "u-sol", currency: "USD", amount: 20, sessionId: s.id });
  const b = await accounts.createQueuedDeposit({ privyUserId: "u-sol", currency: "USD", amount: 5, sessionId: s.id });
  await accounts.markDepositSendingSol(a.id, "sigA", 20, 100);
  await accounts.markDepositConfirmed(a.id);
  await accounts.markDepositSendingSol(b.id, "sigB", 5, 100);
  await accounts.markDepositFailed(b.id, "x", true);
  assert.equal(await store.sessionSolTotal(s.id), 20);

  const p = await store.createPositionForSession(s.id, "PAIR");
  assert.ok(p);
  assert.deepEqual([p.tier, p.musdIn, p.status, p.pair], ["medium", 20, "opening", "PAIR"]);
  const again = await store.createPositionForSession(s.id, "PAIR");
  assert.equal(again?.id, p.id, "idempotent");

  await store.updatePosition(p.id, { status: "open", positionPubkey: "POS", minBinId: 1, maxBinId: 30 });
  const listed = await store.listPositions("u-sol");
  assert.deepEqual([listed[0]?.status, listed[0]?.positionPubkey], ["open", "POS"]);
});

test("no confirmed Solana notes → no position", async () => {
  const s = await history.openDepositSession("u-sol");
  await store.setSessionDestination(s.id, "u-sol", "sol_earn", "low");
  assert.equal(await store.createPositionForSession(s.id, "PAIR"), null);
});
