import { test, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.js";

const pool = await freshDb();
const accounts = await import("../src/accounts.js");
const store = await import("../src/solana/store.js");
after(() => pool.end());

await accounts.insertAccount({ privyUserId: "u-w", email: "w@x.io", privyWallet: "0x00000000000000000000000000000000000000c1", boundAddress: "0x00000000000000000000000000000000000000d1", ensName: null });

const web = (musdIn = 3) =>
  store.createWebPosition({ privyUserId: "u-w", tier: "medium", pair: "PAIR", musdIn, fundingMessageHash: "HASH", fundingValidHeight: 100 });

test("a web position starts in funding with no session", async () => {
  const row = await web();
  assert.deepEqual(
    [row.source, row.status, row.sessionId, row.musdIn, row.fundingMessageHash, row.fundingValidHeight, row.fundingSig],
    ["web", "funding", null, 3, "HASH", 100, null],
  );
});

test("kiosk positions default to source kiosk", async () => {
  const { rows } = await pool.query("select column_default from information_schema.columns where table_name = 'solana_positions' and column_name = 'source'");
  assert.match(rows[0].column_default, /kiosk/);
});

test("the funding signature is stored once (compare-and-set)", async () => {
  const row = await web();
  assert.equal(await store.updatePositionIf(row.id, "fundingSig", null, { fundingSig: "S1" }), true);
  assert.equal(await store.updatePositionIf(row.id, "fundingSig", null, { fundingSig: "S2" }), false);
  assert.equal((await store.getPosition(row.id))?.fundingSig, "S1");
});

test("confirmFunding moves funding → opening once", async () => {
  const row = await web();
  assert.equal(await store.confirmFunding(row.id), true);
  const after1 = await store.getPosition(row.id);
  assert.equal(after1?.status, "opening");
  assert.ok(after1?.fundingConfirmedAt);
  assert.equal(await store.confirmFunding(row.id), false);
});

test("fundingRows lists only rows still in funding", async () => {
  const a = await web();
  const b = await web();
  await store.confirmFunding(b.id);
  const ids = (await store.fundingRows()).map((r) => r.id);
  assert.ok(ids.includes(a.id));
  assert.ok(!ids.includes(b.id));
});

test("webOpeningWithoutJob finds confirmed web rows with no open sent after 5 minutes", async () => {
  const row = await web();
  await store.confirmFunding(row.id);
  assert.ok(!(await store.webOpeningWithoutJob()).includes(row.id)); // too recent
  await pool.query("update solana_positions set funding_confirmed_at = now() - interval '6 minutes' where id = $1", [row.id]);
  assert.ok((await store.webOpeningWithoutJob()).includes(row.id));
  await store.updatePosition(row.id, { openSig: "O" });
  assert.ok(!(await store.webOpeningWithoutJob()).includes(row.id)); // an open is in flight
});

test("web Earn counts toward the daily limit; failed ones and kiosk Earn don't", async () => {
  const { usedToday } = await import("../src/limits.js");
  await accounts.insertAccount({ privyUserId: "u-lim", email: "lim@x.io", privyWallet: "0x00000000000000000000000000000000000000c2", boundAddress: "0x00000000000000000000000000000000000000d2", ensName: null });
  const before = await usedToday("u-lim");
  const ok = await store.createWebPosition({ privyUserId: "u-lim", tier: "low", pair: "P", musdIn: 7, fundingMessageHash: "H", fundingValidHeight: 1 });
  const bad = await store.createWebPosition({ privyUserId: "u-lim", tier: "low", pair: "P", musdIn: 50, fundingMessageHash: "H", fundingValidHeight: 1 });
  await store.updatePosition(bad.id, { status: "failed" });
  await pool.query(
    "insert into solana_positions (id, privy_user_id, tier, pair, musd_in, status) values ($1, 'u-lim', 'low', 'P', 100, 'open')",
    [crypto.randomUUID()],
  ); // a kiosk position: its notes were already counted as deposits
  assert.equal((await usedToday("u-lim")) - before, 7);
  assert.ok(ok);
});
