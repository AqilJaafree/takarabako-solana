import { test, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.js";

const pool = await freshDb();
const accounts = await import("../src/accounts.js");
const history = await import("../src/history.js");
const store = await import("../src/solana/store.js");
const { openForSession, closePosition } = await import("../src/solana/positions.js");
const { usedToday } = await import("../src/limits.js");
after(() => pool.end());

await accounts.insertAccount({ privyUserId: "u-p", email: "p@x.io", privyWallet: "0x00000000000000000000000000000000000000e1", boundAddress: "0x00000000000000000000000000000000000000f1", ensName: null });
await accounts.setSolanaWallet("u-p", "WALLET");

function fakeChain(outcomes: Record<string, Array<"confirmed" | "expired" | "failed">> = {}) {
  const calls = { opened: 0, removed: 0, swapped: [] as bigint[], paid: [] as Array<[string, bigint]>, broadcast: 0, events: [] as string[] };
  let n = 0;
  const signed = (tag: string) => ({ signature: `${tag}${++n}`, lastValidBlockHeight: 10, raw: Buffer.from([]) });
  return {
    calls,
    deps: {
      pairAddress: () => "PAIR",
      prepareOpen: async () => { calls.opened++; return { signed: signed("open"), position: "POS", minBinId: 1, maxBinId: 10 }; },
      positionAmounts: async () => ({ musdRaw: 5_000_000n, solRaw: 100_000_000n, feesMusdRaw: 0n, feesSolRaw: 0n, lowerBinId: 1, upperBinId: 10 }),
      positionExists: async () => calls.removed === 0,
      removeAll: async () => { calls.removed++; return ["rm"]; },
      prepareSwap: async (sol: bigint) => { calls.swapped.push(sol); return { signed: signed("swap"), outRaw: 14_000_000n }; },
      swapReceivedRaw: async (_sig: string): Promise<bigint | null> => null, // unknown → the quote is paid
      signPayout: async (owner: string, raw: bigint) => { calls.paid.push([owner, raw]); return signed("pay"); },
      broadcast: async () => { calls.broadcast++; },
      confirm: async (sig: string) => (outcomes[sig.replace(/\d+$/, "")]?.shift() ?? "confirmed"),
      solPriceUsd: async () => 150,
      publish: async (_u: string, e: { type: string }) => { calls.events.push(e.type); },
    },
  };
}

async function earnSession(usd: number) {
  const s = await history.openDepositSession("u-p");
  await store.setSessionDestination(s.id, "u-p", "sol_earn", "high");
  const d = await accounts.createQueuedDeposit({ privyUserId: "u-p", currency: "USD", amount: usd, sessionId: s.id });
  await accounts.markDepositSendingSol(d.id, `dep-${s.id}`, usd, 1);
  await accounts.markDepositConfirmed(d.id);
  return s.id;
}

test("open: refuses while notes are still settling", async () => {
  const s = await history.openDepositSession("u-p");
  await store.setSessionDestination(s.id, "u-p", "sol_earn", "low");
  await accounts.createQueuedDeposit({ privyUserId: "u-p", currency: "USD", amount: 1, sessionId: s.id });
  await assert.rejects(openForSession(s.id, fakeChain().deps), /settling/);
});

test("open: creates the position once and records History", async () => {
  const sid = await earnSession(20);
  const { calls, deps } = fakeChain();
  const row = await openForSession(sid, deps);
  assert.deepEqual([row?.status, row?.positionPubkey, row?.musdIn], ["open", "POS", 20]);
  assert.deepEqual(calls.events, ["solana.position.opened"]);
  await openForSession(sid, deps); // second run is a no-op
  assert.equal(calls.opened, 1);
  const { rows } = await pool.query("select chain, amount_usd::float as a from yield_events where privy_user_id = 'u-p' and action = 'open'");
  assert.deepEqual(rows.at(-1), { chain: "sol", a: 20 });
});

test("open: an expired open is forgotten and retried with a new position", async () => {
  const sid = await earnSession(9);
  const first = fakeChain({ open: ["expired"] });
  await assert.rejects(openForSession(sid, first.deps), /expired/);
  const row = await store.positionForSession(sid);
  assert.deepEqual([row?.status, row?.openSig], ["opening", null]);
  const second = fakeChain();
  assert.equal((await openForSession(sid, second.deps))?.status, "open");
});

test("close: remove → swap SOL back → pay mUSD to the customer's wallet", async () => {
  const sid = await earnSession(10);
  const { deps } = fakeChain();
  const opened = (await openForSession(sid, deps))!;
  await store.updatePosition(opened.id, { status: "closing" });
  const c = fakeChain();
  const closed = await closePosition(opened.id, c.deps);
  assert.equal(c.calls.removed, 1);
  assert.deepEqual(c.calls.swapped, [100_000_000n]);
  assert.deepEqual(c.calls.paid, [["WALLET", 19_000_000n]]); // 5 mUSD + 14 mUSD from the swap
  assert.deepEqual([closed?.status, closed?.valueOut], ["closed", 19]);
  assert.ok(c.calls.events.includes("solana.position.closed"));
});

test("close: a retry after a failed payout resumes at the payout (no second remove or swap)", async () => {
  const sid = await earnSession(10);
  const opened = (await openForSession(sid, fakeChain().deps))!;
  await store.updatePosition(opened.id, { status: "closing" });
  const first = fakeChain({ pay: ["expired"] });
  await assert.rejects(closePosition(opened.id, first.deps), /expired/);
  const second = fakeChain();
  await closePosition(opened.id, second.deps);
  assert.equal(second.calls.removed, 0);
  assert.equal(second.calls.swapped.length, 0);
  assert.equal(second.calls.paid.length, 1);
  assert.equal((await store.getPosition(opened.id))?.status, "closed");
});

test("open: a broadcast error keeps the stored signature; the retry re-checks it instead of opening again", async () => {
  const sid = await earnSession(7);
  const first = fakeChain();
  first.deps.broadcast = async () => { throw new Error("rpc down"); };
  await assert.rejects(openForSession(sid, first.deps), /rpc down/);
  const stored = await store.positionForSession(sid);
  assert.ok(stored?.openSig?.startsWith("open"));
  const second = fakeChain();
  const row = await openForSession(sid, second.deps);
  assert.equal(second.calls.opened, 0);
  assert.equal(second.calls.broadcast, 0);
  assert.deepEqual([row?.status, row?.openSig], ["open", stored?.openSig]);
});

test("close: a payout whose confirm throws keeps its signature and is not paid twice", async () => {
  const sid = await earnSession(10);
  const opened = (await openForSession(sid, fakeChain().deps))!;
  await store.updatePosition(opened.id, { status: "closing" });
  const first = fakeChain();
  first.deps.confirm = async (sig: string) => { if (sig.startsWith("pay")) throw new Error("still pending"); return "confirmed"; };
  await assert.rejects(closePosition(opened.id, first.deps), /still pending/);
  const mid = (await store.getPosition(opened.id))!;
  assert.ok(mid.payoutSig?.startsWith("pay"));
  const second = fakeChain();
  const closed = await closePosition(opened.id, second.deps);
  assert.equal(second.calls.paid.length, 0);
  assert.deepEqual([closed?.status, closed?.payoutSig], ["closed", mid.payoutSig]);
});

test("open: a send stored by another run is never overwritten", async () => {
  const sid = await earnSession(5);
  const { calls, deps } = fakeChain();
  deps.prepareOpen = async () => {
    const row = (await store.positionForSession(sid))!;
    await store.updatePosition(row.id, { openSig: "other1", openValidHeight: 10 }); // the other run got there first
    return { signed: { signature: "mine1", lastValidBlockHeight: 10, raw: Buffer.from([]) }, position: "POS", minBinId: 1, maxBinId: 10 };
  };
  await assert.rejects(openForSession(sid, deps), /already recorded/);
  assert.equal(calls.broadcast, 0);
  assert.equal((await store.positionForSession(sid))?.openSig, "other1");
});

test("an expired open does not clear a newer signature", async () => {
  const sid = await earnSession(6);
  const { deps } = fakeChain();
  deps.confirm = async (sig: string) => {
    const row = (await store.positionForSession(sid))!;
    await store.updatePosition(row.id, { openSig: "newer1" }); // replaced meanwhile
    return sig === "newer1" ? "confirmed" : "expired";
  };
  await assert.rejects(openForSession(sid, deps), /expired/);
  assert.equal((await store.positionForSession(sid))?.openSig, "newer1");
});

test("close: the payout uses the mUSD the swap actually delivered, not the quote", async () => {
  const sid = await earnSession(10);
  const opened = (await openForSession(sid, fakeChain().deps))!;
  await store.updatePosition(opened.id, { status: "closing" });
  const c = fakeChain();
  const asked: string[] = [];
  c.deps.swapReceivedRaw = async (sig: string) => { asked.push(sig); return 14_350_000n; };
  const closed = await closePosition(opened.id, c.deps);
  assert.deepEqual(asked, [closed?.swapSig]);
  assert.equal(closed?.swapOutRaw, "14350000");
  assert.deepEqual(c.calls.paid, [["WALLET", 19_350_000n]]);
  assert.equal(closed?.valueOut, 19.35);
});

test("close: an expired swap is cleared and swapped again from a fresh quote", async () => {
  const sid = await earnSession(10);
  const opened = (await openForSession(sid, fakeChain().deps))!;
  await store.updatePosition(opened.id, { status: "closing" });
  const first = fakeChain({ swap: ["expired"] });
  await assert.rejects(closePosition(opened.id, first.deps), /swap .* expired/);
  const mid = (await store.getPosition(opened.id))!;
  assert.deepEqual([mid.swapSig, mid.swapValidHeight, mid.swapOutRaw, mid.swapConfirmedAt], [null, null, null, null]);
  assert.ok(mid.removedAt);
  assert.equal(first.calls.paid.length, 0);
  const second = fakeChain();
  const closed = await closePosition(opened.id, second.deps);
  assert.equal(second.calls.removed, 0);
  assert.deepEqual(second.calls.swapped, [100_000_000n]);
  assert.equal(second.calls.paid.length, 1);
  assert.equal(closed?.status, "closed");
});

test("close: a crash after removal (position gone, removedAt unset) skips the remove and still pays", async () => {
  const sid = await earnSession(10);
  const opened = (await openForSession(sid, fakeChain().deps))!;
  // the last run stored amounts and removed, then died before marking it
  await store.updatePosition(opened.id, { status: "closing", musdOutRaw: "6000000", solOutRaw: "0" });
  const c = fakeChain();
  c.deps.positionExists = async () => false;
  c.deps.positionAmounts = async () => { throw new Error("position account is gone"); };
  const closed = await closePosition(opened.id, c.deps);
  assert.equal(c.calls.removed, 0);
  assert.equal(c.calls.swapped.length, 0);
  assert.deepEqual(c.calls.paid, [["WALLET", 6_000_000n]]);
  assert.deepEqual([closed?.status, closed?.valueOut], ["closed", 6]);
});

test("close: amounts are re-read right before removing while the position exists", async () => {
  const sid = await earnSession(10);
  const opened = (await openForSession(sid, fakeChain().deps))!;
  await store.updatePosition(opened.id, { status: "closing", musdOutRaw: "1", solOutRaw: "1" }); // stale from an earlier try
  const c = fakeChain();
  await closePosition(opened.id, c.deps);
  assert.deepEqual(c.calls.paid, [["WALLET", 19_000_000n]]);
});

test("close: a position that's gone with no amounts recorded is refused, not paid as zero", async () => {
  const sid = await earnSession(10);
  const opened = (await openForSession(sid, fakeChain().deps))!;
  await store.updatePosition(opened.id, { status: "closing" });
  const c = fakeChain();
  c.deps.positionExists = async () => false;
  await assert.rejects(closePosition(opened.id, c.deps), /no amounts recorded/);
  assert.equal(c.calls.paid.length, 0);
});

test("close: a 'closing' row without a position address throws", async () => {
  const sid = await earnSession(10);
  const opened = (await openForSession(sid, fakeChain().deps))!;
  await store.updatePosition(opened.id, { status: "closing", positionPubkey: null });
  await assert.rejects(closePosition(opened.id, fakeChain().deps), /no position address/);
});

test("finalize is atomic and once: status + History row together, never twice", async () => {
  const sid = await earnSession(4);
  const row = (await openForSession(sid, fakeChain().deps))!;
  const ev = { privyUserId: "u-p", action: "open" as const, riskTier: "high", pair: "x", apyBps: null, amountUsd: 4, rationale: null, ensName: null, txHash: "t", chain: "sol" as const };
  const count = async () => Number((await pool.query("select count(*) from yield_events where privy_user_id = 'u-p'")).rows[0].count);
  const before = await count();
  assert.equal(await store.finalizeOpen(row.id, ev), false); // already open
  assert.equal(await store.finalizeClose(row.id, { valueOut: 1, payoutSig: "p" }, { ...ev, action: "close" }), false); // not closing
  assert.equal(await count(), before);
  // a failing History insert rolls the status change back
  await store.updatePosition(row.id, { status: "closing" });
  await assert.rejects(store.finalizeClose(row.id, { valueOut: 1, payoutSig: "p" }, { ...ev, action: "close", privyUserId: "no-such-user" }));
  const after = (await store.getPosition(row.id))!;
  assert.deepEqual([after.status, after.valueOut, after.payoutSig, await count()], ["closing", null, null, before]);
});

test("getReceipt shows the destination, tier and Earn position", async () => {
  const sid = await earnSession(3);
  const opened = (await openForSession(sid, fakeChain().deps))!;
  const r = (await history.getReceipt(sid))!;
  assert.deepEqual([r.destination, r.tier], ["sol_earn", "high"]);
  assert.deepEqual(r.solPosition, { id: opened.id, status: "open", openSig: opened.openSig });
  assert.equal(r.notes[0]?.chain, "sol");
  const plain = await history.openDepositSession("u-p");
  const r2 = (await history.getReceipt(plain.id))!;
  assert.deepEqual([r2.destination, r2.tier, r2.solPosition], ["evm", null, null]);
});

test("a Solana Earn open is not counted again in the daily limit", async () => {
  const before = await usedToday("u-p");
  await history.recordYieldEvent({ privyUserId: "u-p", action: "open", riskTier: "high", pair: "x", apyBps: null, amountUsd: 50, rationale: null, ensName: null, txHash: null, chain: "sol" });
  assert.equal(await usedToday("u-p"), before);
  await history.recordYieldEvent({ privyUserId: "u-p", action: "open", riskTier: "high", pair: "x", apyBps: null, amountUsd: 50, rationale: null, ensName: null, txHash: null });
  assert.equal(await usedToday("u-p"), before + 50);
});
