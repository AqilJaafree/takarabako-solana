import { test, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.js";

process.env.DAILY_LIMIT_USD = "1000";
delete process.env.MULTIBAAS_URL;
delete process.env.ENS_REGISTRY_ADDRESS;

const pool = await freshDb();
const { assertWithinLimit, dailyAllowance, usedToday, DailyLimitError } = await import("../src/limits.js");
const accounts = await import("../src/accounts.js");
after(() => pool.end());

const CAROL = { privyUserId: "u-carol", email: "c@x.io", privyWallet: "0x00000000000000000000000000000000000000c1", boundAddress: "0x00000000000000000000000000000000000000d1", ensName: "carol.takarabako.eth" };
await accounts.insertAccount(CAROL);
const carol = async () => (await accounts.findByPrivyUserId("u-carol"))!;
const id = () => crypto.randomUUID();

test("everything a customer moves today counts toward the limit", async () => {
  await pool.query("insert into deposits (id, privy_user_id, currency, amount, usd_amount, status) values ($1, 'u-carol', 'USD', 300, 300, 'confirmed')", [id()]);
  await pool.query("insert into deposits (id, privy_user_id, currency, amount, usd_amount, status) values ($1, 'u-carol', 'USD', 999, 999, 'failed')", [id()]);
  await pool.query("insert into deposits (id, privy_user_id, currency, amount, usd_amount, status, created_at) values ($1, 'u-carol', 'USD', 500, 500, 'confirmed', now() - interval '2 days')", [id()]);
  await pool.query("insert into withdrawals (id, privy_user_id, destination, gross_usd, fee_bps, net_usd) values ($1, 'u-carol', 'cash', 200, 200, 196)", [id()]);
  await pool.query("insert into yield_events (id, privy_user_id, action, amount_usd) values ($1, 'u-carol', 'open', 150)", [id()]);
  await pool.query("insert into yield_events (id, privy_user_id, action, amount_usd) values ($1, 'u-carol', 'close', 150)", [id()]);
  await pool.query("insert into transfers (id, kind, from_user, amount_usd) values ($1, 'balance', 'u-carol', 50)", [id()]);
  // failed deposits, old deposits and position closes don't count
  assert.equal(await usedToday("u-carol"), 700);
  const a = await dailyAllowance(await carol());
  assert.deepEqual(a, { limited: true, limitUsd: 1000, usedUsd: 700, leftUsd: 300 });
});

test("going over the limit is refused; up to it is fine", async () => {
  await assertWithinLimit(await carol(), 300);
  await assert.rejects(assertWithinLimit(await carol(), 300.01, "this send"), (err) => {
    assert.ok(err instanceof DailyLimitError);
    assert.equal(err.status, 403);
    assert.match(err.message, /\$300 left today/);
    return true;
  });
});

test("the limit applies to every account and nothing lifts it", async () => {
  const a = await dailyAllowance(await carol());
  assert.equal(a.limited, true);
  await assert.rejects(assertWithinLimit(await carol(), 1_000_000), (err) => {
    assert.ok(err instanceof DailyLimitError);
    assert.doesNotMatch(err.message, /World ID/);
    return true;
  });
});
