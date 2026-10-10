import { test, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.js";

const pool = await freshDb();
const accounts = await import("../src/accounts.js");
const history = await import("../src/history.js");
const store = await import("../src/solana/store.js");
const { processDeposit, finalFailureStatus, recoverInFlightDeposits, closeDepositQueue } = await import("../src/depositQueue.js");
after(async () => { await closeDepositQueue(); await pool.end(); });

await accounts.insertAccount({ privyUserId: "u-q", email: "q@x.io", privyWallet: "0x00000000000000000000000000000000000000c1", boundAddress: "0x00000000000000000000000000000000000000d1", ensName: null });

function fakes(outcomes: Array<"confirmed" | "expired" | "failed"> = ["confirmed"]) {
  const calls = { evmSent: 0, minted: [] as Array<[string, number]>, broadcast: 0, events: [] as Array<{ type: string; chain?: string; balance?: number }> };
  let n = 0;
  return {
    calls,
    deps: {
      toUsd: async (amount: number) => ({ usdAmount: amount, rate: 1, source: "test" }),
      send: async () => { calls.evmSent++; return "0xevm" as `0x${string}`; },
      wait: async () => 1,
      publish: async (_u: string, e: { type: string }) => { calls.events.push(e as never); },
      sol: {
        owner: async (_a: unknown, d: string) => (d === "sol_hold" ? "CUSTOMER" : "TREASURY"),
        signMint: async (owner: string, usd: number) => { calls.minted.push([owner, usd]); n++; return { signature: `sig${n}`, lastValidBlockHeight: 100, raw: Buffer.from([]) }; },
        broadcast: async () => { calls.broadcast++; },
        confirm: async () => outcomes.shift() ?? "confirmed",
        balance: async () => 42,
      },
    },
  };
}

async function sessionWith(destination: "evm" | "sol_hold" | "sol_earn", tier: "low" | null = null) {
  const s = await history.openDepositSession("u-q");
  assert.equal(await store.setSessionDestination(s.id, "u-q", destination, tier), "ok");
  return s.id;
}

test("evm session: unchanged EVM path", async () => {
  const sid = await sessionWith("evm");
  const d = await accounts.createQueuedDeposit({ privyUserId: "u-q", currency: "USD", amount: 10, sessionId: sid });
  const { calls, deps } = fakes();
  await processDeposit(d.id, deps);
  assert.equal(calls.evmSent, 1);
  assert.equal(calls.minted.length, 0);
});

test("sol_hold: mints mUSD to the customer's wallet, publishes chain sol + wallet balance", async () => {
  const sid = await sessionWith("sol_hold");
  const d = await accounts.createQueuedDeposit({ privyUserId: "u-q", currency: "USD", amount: 10, sessionId: sid });
  const { calls, deps } = fakes();
  await processDeposit(d.id, deps);
  assert.equal(calls.evmSent, 0);
  assert.deepEqual(calls.minted, [["CUSTOMER", 10]]);
  const row = await accounts.getDeposit(d.id);
  assert.deepEqual([row?.status, row?.chain, row?.txHash, row?.solValidHeight], ["confirmed", "sol", "sig1", 100]);
  const ev = calls.events.find((e) => e.type === "deposit.confirmed");
  assert.deepEqual([ev?.chain, ev?.balance], ["sol", 42]);
});

test("sol_earn: mints to the treasury; balance is the session's Solana total", async () => {
  const sid = await sessionWith("sol_earn", "low");
  const d = await accounts.createQueuedDeposit({ privyUserId: "u-q", currency: "USD", amount: 7, sessionId: sid });
  const { calls, deps } = fakes();
  await processDeposit(d.id, deps);
  assert.deepEqual(calls.minted, [["TREASURY", 7]]);
  assert.equal(calls.events.find((e) => e.type === "deposit.confirmed")?.balance, 7);
});

test("retry with a stored signature never mints again", async () => {
  const sid = await sessionWith("sol_hold");
  const d = await accounts.createQueuedDeposit({ privyUserId: "u-q", currency: "USD", amount: 3, sessionId: sid });
  await accounts.markDepositSendingSol(d.id, "already", 3, 100);
  const { calls, deps } = fakes(["confirmed"]);
  await processDeposit(d.id, deps);
  assert.equal(calls.minted.length, 0);
  assert.equal((await accounts.getDeposit(d.id))?.status, "confirmed");
});

test("an expired mint is forgotten and the job throws so BullMQ retries with a fresh one", async () => {
  const sid = await sessionWith("sol_hold");
  const d = await accounts.createQueuedDeposit({ privyUserId: "u-q", currency: "USD", amount: 4, sessionId: sid });
  const first = fakes(["expired"]);
  await assert.rejects(processDeposit(d.id, first.deps), /expired/);
  const row = await accounts.getDeposit(d.id);
  assert.deepEqual([row?.status, row?.txHash], ["queued", null]);
  const second = fakes(["confirmed"]);
  await processDeposit(d.id, second.deps);
  assert.equal(second.calls.minted.length, 1);
  assert.equal((await accounts.getDeposit(d.id))?.status, "confirmed");
});

test("broadcast throws: signature kept, status stays sending", async () => {
  const sid = await sessionWith("sol_hold");
  const d = await accounts.createQueuedDeposit({ privyUserId: "u-q", currency: "USD", amount: 2, sessionId: sid });
  const { deps } = fakes();
  deps.sol.broadcast = async () => { throw new Error("rpc down"); };
  await assert.rejects(processDeposit(d.id, deps), /rpc down/);
  const row = await accounts.getDeposit(d.id);
  assert.deepEqual([row?.status, row?.txHash], ["sending", "sig1"]);
});

test("confirm throws (unknown): signature kept", async () => {
  const sid = await sessionWith("sol_hold");
  const d = await accounts.createQueuedDeposit({ privyUserId: "u-q", currency: "USD", amount: 2, sessionId: sid });
  const { deps } = fakes();
  deps.sol.confirm = async () => { throw new Error("still pending"); };
  await assert.rejects(processDeposit(d.id, deps), /still pending/);
  const row = await accounts.getDeposit(d.id);
  assert.deepEqual([row?.status, row?.txHash], ["sending", "sig1"]);
});

test("failed outcome: cleared and rethrown", async () => {
  const sid = await sessionWith("sol_hold");
  const d = await accounts.createQueuedDeposit({ privyUserId: "u-q", currency: "USD", amount: 2, sessionId: sid });
  await assert.rejects(processDeposit(d.id, fakes(["failed"]).deps), /failed/);
  const row = await accounts.getDeposit(d.id);
  assert.deepEqual([row?.status, row?.txHash], ["queued", null]);
});

test("second sender: stored send already exists, nothing is broadcast", async () => {
  const sid = await sessionWith("sol_hold");
  const d = await accounts.createQueuedDeposit({ privyUserId: "u-q", currency: "USD", amount: 2, sessionId: sid });
  assert.equal(await accounts.markDepositSendingSol(d.id, "first", 2, 100), true);
  assert.equal(await accounts.markDepositSendingSol(d.id, "second", 2, 100), false);
  assert.equal((await accounts.getDeposit(d.id))?.txHash, "first");
});

test("balance read failing does not lose the confirmation", async () => {
  const sid = await sessionWith("sol_hold");
  const d = await accounts.createQueuedDeposit({ privyUserId: "u-q", currency: "USD", amount: 5, sessionId: sid });
  const { calls, deps } = fakes();
  deps.sol.balance = async () => { throw new Error("rpc"); };
  await processDeposit(d.id, deps);
  assert.equal(calls.events.find((e) => e.type === "deposit.confirmed")?.balance, 5);
});

test("finalFailureStatus keeps in-flight sends", () => {
  assert.equal(finalFailureStatus({ status: "sending", txHash: "x" }), "keep");
  assert.equal(finalFailureStatus({ status: "queued", txHash: null }), "failed");
});

test("recoverInFlightDeposits picks only stale queued/sending rows", async () => {
  const mk = async () => (await accounts.createQueuedDeposit({ privyUserId: "u-q", currency: "USD", amount: 1 })).id;
  const stale = await mk(), fresh = await mk();
  await pool.query("update deposits set status = 'confirmed' where status in ('queued','sending')");
  await pool.query("update deposits set status = 'queued', updated_at = now() - interval '5 minutes' where id = $1", [stale]);
  await pool.query("update deposits set status = 'queued' where id = $1", [fresh]);
  assert.equal(await recoverInFlightDeposits(), 1);
});

test("clearDepositSend only clears the signature that was checked", async () => {
  const sid = await sessionWith("sol_hold");
  const d = await accounts.createQueuedDeposit({ privyUserId: "u-q", currency: "USD", amount: 4, sessionId: sid });
  await accounts.markDepositSendingSol(d.id, "sigA", 4, 100);
  assert.equal(await accounts.clearDepositSend(d.id, "other"), false);
  assert.equal((await accounts.getDeposit(d.id))?.txHash, "sigA");
  assert.equal(await accounts.clearDepositSend(d.id, "sigA"), true);
  assert.equal((await accounts.getDeposit(d.id))?.txHash, null);
});
