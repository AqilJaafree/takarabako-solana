import { test, after } from "node:test";
import assert from "node:assert/strict";
import { Keypair, Transaction } from "@solana/web3.js";
import { freshDb } from "./helpers.js";

const pool = await freshDb();
const accounts = await import("../src/accounts.js");
const store = await import("../src/solana/store.js");
const webEarn = await import("../src/solana/webEarn.js");
after(() => pool.end());

await accounts.insertAccount({ privyUserId: "u-w", email: "w@x.io", privyWallet: "0x00000000000000000000000000000000000000c1", boundAddress: "0x00000000000000000000000000000000000000d1", ensName: null });

const owner = Keypair.generate();
const treasuryKp = Keypair.generate();
const mintKey = Keypair.generate().publicKey;
await accounts.insertAccount({ privyUserId: "u-e", email: "e@x.io", privyWallet: "0x00000000000000000000000000000000000000c3", boundAddress: "0x00000000000000000000000000000000000000d3", ensName: null });
await accounts.setSolanaWallet("u-e", owner.publicKey.toBase58());
const account = (await accounts.findByPrivyUserId("u-e"))!;

const web = (musdIn = 3) =>
  store.createWebPosition({ privyUserId: "u-w", tier: "medium", pair: "PAIR", musdIn, id: crypto.randomUUID(), fundingMessageHash: `HASH-${crypto.randomUUID()}`, fundingValidHeight: 100 });

test("a web position starts in funding with no session", async () => {
  const row = await web();
  assert.deepEqual(
    [row.source, row.status, row.sessionId, row.musdIn, row.fundingMessageHash?.startsWith("HASH-"), row.fundingValidHeight, row.fundingSig],
    ["web", "funding", null, 3, true, 100, null],
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
  const ok = await store.createWebPosition({ privyUserId: "u-lim", tier: "low", pair: "P", musdIn: 7, id: crypto.randomUUID(), fundingMessageHash: `H-${crypto.randomUUID()}`, fundingValidHeight: 1 });
  const bad = await store.createWebPosition({ privyUserId: "u-lim", tier: "low", pair: "P", musdIn: 50, id: crypto.randomUUID(), fundingMessageHash: `H-${crypto.randomUUID()}`, fundingValidHeight: 1 });
  await store.updatePosition(bad.id, { status: "failed" });
  await pool.query(
    "insert into solana_positions (id, privy_user_id, tier, pair, musd_in, status) values ($1, 'u-lim', 'low', 'P', 100, 'open')",
    [crypto.randomUUID()],
  ); // a kiosk position: its notes were already counted as deposits
  assert.equal((await usedToday("u-lim")) - before, 7);
  assert.ok(ok);
});

function fakeDeps(opts: { balance?: bigint; outcome?: "confirmed" | "expired" | "failed" | "throw"; blockhash?: string } = {}) {
  const calls = { broadcast: 0, enqueued: [] as string[] };
  return {
    calls,
    deps: {
      pairAddress: () => "PAIR",
      balanceRaw: async () => opts.balance ?? 10_000_000n,
      latestBlockhash: async () => ({ blockhash: opts.blockhash ?? Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 900 }),
      treasury: () => treasuryKp,
      mint: () => mintKey,
      priorityMicroLamports: () => 10_000,
      broadcast: async () => { calls.broadcast++; },
      confirm: async () => {
        if (opts.outcome === "throw") throw new Error("still pending");
        return opts.outcome ?? "confirmed";
      },
      enqueueOpen: async (id: string) => { calls.enqueued.push(id); },
    },
  };
}

const sign = (b64: string, kp = owner) => {
  const tx = Transaction.from(Buffer.from(b64, "base64"));
  tx.partialSign(kp);
  return tx.serialize({ requireAllSignatures: false }).toString("base64");
};

test("prepare: refuses a bad tier, a bad amount, more than the balance, or over the daily limit", async () => {
  const { deps } = fakeDeps({ balance: 5_000_000n });
  assert.equal((await webEarn.prepareWebEarn(account, 1, "max", deps)).status, 400);
  assert.equal((await webEarn.prepareWebEarn(account, -1, "low", deps)).status, 400);
  assert.equal((await webEarn.prepareWebEarn(account, 0.0000001, "low", deps)).status, 400);
  const tooMuch = await webEarn.prepareWebEarn(account, 6, "low", deps);
  assert.deepEqual([tooMuch.status, (tooMuch.body as { error: string }).error], [400, "You have 5 mUSD — enter that much or less."]);
  const { deps: rich } = fakeDeps({ balance: 5_000_000_000n });
  const limited = await webEarn.prepareWebEarn(account, 2_000, "low", rich);
  assert.deepEqual([limited.status, (limited.body as { code: string }).code], [403, "daily_limit"]);
});

test("prepare → customer signs → submit: funded, opening, open job queued", async () => {
  const { calls, deps } = fakeDeps();
  const prep = await webEarn.prepareWebEarn(account, 2.5, "medium", deps);
  assert.equal(prep.status, 200);
  const { id, tx } = prep.body as { id: string; tx: string };
  assert.equal((await store.getPosition(id))?.status, "funding");
  const sub = await webEarn.submitWebEarn("u-e", id, sign(tx), deps);
  assert.deepEqual([sub.status, (sub.body as { status: string }).status], [202, "opening"]);
  const row = await store.getPosition(id);
  assert.deepEqual([row?.status, Boolean(row?.fundingSig), Boolean(row?.fundingConfirmedAt), row?.musdIn], ["opening", true, true, 2.5]);
  assert.deepEqual(calls.enqueued, [id]);
  assert.equal(calls.broadcast, 1);
});

test("submit: a second submit, someone else's id, or a tampered tx is refused", async () => {
  const { calls, deps } = fakeDeps();
  const a = (await webEarn.prepareWebEarn(account, 1, "low", deps)).body as { id: string; tx: string };
  assert.equal((await webEarn.submitWebEarn("someone-else", a.id, sign(a.tx), deps)).status, 404);
  assert.equal((await webEarn.submitWebEarn("u-e", a.id, sign(a.tx), deps)).status, 202);
  assert.equal((await webEarn.submitWebEarn("u-e", a.id, sign(a.tx), deps)).status, 409);

  const b = (await webEarn.prepareWebEarn(account, 1, "low", deps)).body as { id: string; tx: string };
  const c = (await webEarn.prepareWebEarn(account, 3, "low", deps)).body as { id: string; tx: string };
  const before = calls.broadcast;
  const tampered = await webEarn.submitWebEarn("u-e", b.id, sign(c.tx), deps); // c's transaction for b's row
  assert.equal(tampered.status, 400);
  assert.equal((await store.getPosition(b.id))?.status, "failed");
  assert.equal(calls.broadcast, before); // the treasury never co-signed or sent it
});

test("submit: an expired transfer fails the row; nothing moved", async () => {
  const { deps } = fakeDeps({ outcome: "expired" });
  const p = (await webEarn.prepareWebEarn(account, 1, "high", deps)).body as { id: string; tx: string };
  const sub = await webEarn.submitWebEarn("u-e", p.id, sign(p.tx), deps);
  assert.equal(sub.status, 400);
  assert.equal((await store.getPosition(p.id))?.status, "failed");
});

test("submit: an unknown outcome keeps the signature; the sweep settles it later", async () => {
  const pending = fakeDeps({ outcome: "throw" });
  const p = (await webEarn.prepareWebEarn(account, 1, "high", pending.deps)).body as { id: string; tx: string };
  const sub = await webEarn.submitWebEarn("u-e", p.id, sign(p.tx), pending.deps);
  assert.deepEqual([sub.status, (sub.body as { status: string }).status], [202, "funding"]);
  assert.ok((await store.getPosition(p.id))?.fundingSig);

  const later = fakeDeps();
  await webEarn.resolveFunding(later.deps);
  assert.equal((await store.getPosition(p.id))?.status, "opening");
  assert.ok(later.calls.enqueued.includes(p.id));
});

test("sweep: an approval never given fails after 10 minutes", async () => {
  const { deps } = fakeDeps();
  const p = (await webEarn.prepareWebEarn(account, 1, "low", deps)).body as { id: string };
  await webEarn.resolveFunding(deps);
  assert.equal((await store.getPosition(p.id))?.status, "funding"); // still in time
  await pool.query("update solana_positions set created_at = now() - interval '11 minutes' where id = $1", [p.id]);
  await webEarn.resolveFunding(deps);
  const row = await store.getPosition(p.id);
  assert.deepEqual([row?.status, row?.error], ["failed", "not approved in time"]);
});

test("one signed transfer can't fund two rows (same amount, same blockhash)", async () => {
  const { calls, deps } = fakeDeps({ blockhash: Keypair.generate().publicKey.toBase58() });
  const a = (await webEarn.prepareWebEarn(account, 1.25, "low", deps)).body as { id: string; tx: string };
  const b = (await webEarn.prepareWebEarn(account, 1.25, "low", deps)).body as { id: string; tx: string };
  assert.notEqual(a.tx, b.tx);
  const before = calls.broadcast;
  const res = await webEarn.submitWebEarn("u-e", b.id, sign(a.tx), deps); // A's transaction for B's row
  assert.equal(res.status, 400);
  assert.equal(calls.broadcast, before);
  assert.equal((await store.getPosition(b.id))?.fundingSig, null);
});

test("a funded row isn't failed by a later bad submit", async () => {
  const pending = fakeDeps({ outcome: "throw" });
  const a = (await webEarn.prepareWebEarn(account, 1, "low", pending.deps)).body as { id: string; tx: string };
  const other = (await webEarn.prepareWebEarn(account, 2, "low", pending.deps)).body as { id: string; tx: string };
  assert.equal((await webEarn.submitWebEarn("u-e", a.id, sign(a.tx), pending.deps)).status, 202); // signature stored, outcome unknown
  const bad = await webEarn.submitWebEarn("u-e", a.id, sign(other.tx), pending.deps);
  assert.equal(bad.status, 409);
  const row = await store.getPosition(a.id);
  assert.deepEqual([row?.status, Boolean(row?.fundingSig)], ["funding", true]);
  assert.equal(await store.failFunding(a.id, "late", null), false); // the backstop
  await webEarn.resolveFunding(fakeDeps().deps);
  assert.equal((await store.getPosition(a.id))?.status, "opening");
});

test("claimFunding and failFunding are conditional", async () => {
  const row = await web();
  assert.equal(await store.claimFunding(row.id, "CF1"), true);
  assert.equal(await store.claimFunding(row.id, "CF2"), false);
  assert.equal(await store.failFunding(row.id, "x", null), false);
  assert.equal(await store.failFunding(row.id, "x", "CF2"), false);
  assert.equal(await store.failFunding(row.id, "x", "CF1"), true);
  assert.deepEqual([(await store.getPosition(row.id))?.status, (await store.getPosition(row.id))?.error], ["failed", "x"]);
  assert.equal(await store.claimFunding(row.id, "CF3"), false); // no longer funding
});

test("the same funding signature or message hash can't be on two rows", async () => {
  const a = await web();
  const b = await web();
  await store.claimFunding(a.id, "DUP");
  await assert.rejects(store.claimFunding(b.id, "DUP"));
  await assert.rejects(pool.query("update solana_positions set funding_message_hash = $2 where id = $1", [b.id, a.fundingMessageHash]));
});

test("prepare: two concurrent prepares never both fit under the daily limit", async () => {
  const racer = Keypair.generate();
  await accounts.insertAccount({ privyUserId: "u-race", email: "r@x.io", privyWallet: "0x00000000000000000000000000000000000000c4", boundAddress: "0x00000000000000000000000000000000000000d4", ensName: null });
  await accounts.setSolanaWallet("u-race", racer.publicKey.toBase58());
  const acct = (await accounts.findByPrivyUserId("u-race"))!;
  await store.createWebPosition({ privyUserId: "u-race", tier: "low", pair: "P", musdIn: 995, id: crypto.randomUUID(), fundingMessageHash: `H-${crypto.randomUUID()}`, fundingValidHeight: 1 });
  const { deps } = fakeDeps();
  const res = await Promise.all([webEarn.prepareWebEarn(acct, 3, "low", deps), webEarn.prepareWebEarn(acct, 3, "low", deps)]);
  const ok = res.filter((r) => r.status === 200);
  assert.ok(ok.length <= 1);
  for (const r of res.filter((r) => r.status !== 200)) assert.deepEqual([r.status, (r.body as { code: string }).code], [403, "daily_limit"]);
  const { usedToday } = await import("../src/limits.js");
  assert.ok((await usedToday("u-race")) <= 1000);
});

test("submit: a balance that dropped since prepare is refused before the treasury signs", async () => {
  const { calls, deps } = fakeDeps();
  const p = (await webEarn.prepareWebEarn(account, 4, "low", deps)).body as { id: string; tx: string };
  const res = await webEarn.submitWebEarn("u-e", p.id, sign(p.tx), { ...deps, balanceRaw: async () => 1_000_000n });
  assert.equal(res.status, 400);
  const row = await store.getPosition(p.id);
  assert.deepEqual([row?.status, row?.error, row?.fundingSig], ["failed", "your mUSD balance changed — prepare again", null]);
  assert.equal(calls.broadcast, 0);
});
