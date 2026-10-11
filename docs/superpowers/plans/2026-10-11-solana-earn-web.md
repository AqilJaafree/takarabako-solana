# Earn from held mUSD in the web app — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A customer holding mUSD opens a Meteora DLMM V2 Earn position from the web app by approving one mUSD transfer in their Privy Solana wallet.

**Architecture:** The backend builds a Token-2022 `transferChecked` (customer mUSD → treasury, treasury pays the fee) and stores a hash of its message. The browser signs it with Privy; the backend checks the signed transaction is the one it built, co-signs, stores the signature, broadcasts, confirms, and queues the existing open job, now keyed by position id. Positions stay treasury-held and tracked per customer.

**Tech Stack:** Node/TypeScript backend (Express, Postgres, BullMQ, `@solana/web3.js` 1.99, `@solana/spl-token`), Next.js 16 frontend with `@privy-io/react-auth` 3.45 (`/solana` entry), `node:test`.

Spec: `docs/superpowers/specs/2026-10-11-solana-earn-web-design.md`.

**Repo:** `/home/wanaqil/Documents/Code/node/hackathon/takarabako-solana`, branch `main`.
**Commits:** implementers edit and test only. The main session commits and pushes after each task, **without** any `Co-Authored-By` trailer.
**Backend tests** need local Postgres + Redis: `cd backend && npm run services` (leave running). Run a single file with
`cd backend && node --import tsx --test --test-concurrency=1 test/<file>.test.ts`.

## One deviation from the spec (deliberate)

The spec says the `open` job takes a `positionId`. The kiosk Finish enqueues *before* the session's position row exists (the row is created once its notes settle), so the kiosk job keeps `{ kind: "open", sessionId }` and a second kind `{ kind: "openPosition", positionId }` is added for web rows. Both run the same `openPosition(id)`.

## File map

| File | Change |
|---|---|
| `backend/migrations/013_solana_web_earn.sql` | new: `source`, `funding_*` columns, `funding` status |
| `backend/src/solana/store.ts` | row fields, `createWebPosition`, `confirmFunding`, `fundingRows`, `webOpeningWithoutJob`; CAS on `fundingSig` |
| `backend/src/limits.ts` | daily limit counts web Earn |
| `backend/src/solana/positions.ts` | `openPosition(id)` extracted from `openForSession`; `PositionView.source` |
| `backend/src/solana/jobs.ts` | `openPosition` job kind, `enqueueOpenPosition`, pure `recoveryJob` |
| `backend/src/solana/fundingTx.ts` | new, pure: build / hash / check the funding transaction |
| `backend/src/solana/webEarn.ts` | new: `prepareWebEarn`, `submitWebEarn`, `resolveFunding`, `startFundingSweep` |
| `backend/src/routes/solanaRoutes.ts` | `POST /solana/earn/prepare`, `POST /solana/earn/submit` |
| `backend/src/index.ts` | start the funding sweep |
| `backend/test/solanaWebEarn.test.ts` | new: store, limits, service |
| `backend/test/solanaFundingTx.test.ts` | new: pure tx tests |
| `backend/test/solanaPositions.test.ts`, `solanaJobs.test.ts` | new cases |
| `backend/scripts/sol-flow.ts` | web Earn section with a local test wallet |
| `frontend/components/PrivyShell.tsx` | Solana embedded wallets on (no auto-create) |
| `frontend/lib/useSolanaSign.ts` | new: sign a base64 tx with the Privy Solana wallet |
| `frontend/lib/types.ts` | `funding` status, `source`, prepare/submit types |
| `frontend/app/api/solana/earn/{prepare,submit}/route.ts` | new proxies |
| `frontend/app/(customer)/(authed)/solana/{page,SolanaEarn}.tsx` | new page |
| `frontend/components/SolanaCard.tsx`, `Nav.tsx` | link, nav entry, funding label |
| `README.md` | web Earn |

---

### Task 1: Schema and store for web positions

**Files:**
- Create: `backend/migrations/013_solana_web_earn.sql`
- Modify: `backend/src/solana/store.ts`
- Test: `backend/test/solanaWebEarn.test.ts` (new)

- [ ] **Step 1: Write the failing test** — create `backend/test/solanaWebEarn.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd backend && node --import tsx --test --test-concurrency=1 test/solanaWebEarn.test.ts`
Expected: FAIL — `store.createWebPosition is not a function`.

- [ ] **Step 3: Add the migration** — create `backend/migrations/013_solana_web_earn.sql`:

```sql
-- Earn from held mUSD in the web app (spec 2026-10-11). Idempotent: runs at every startup.
-- A web position starts in 'funding' (waiting for the customer's approved
-- mUSD transfer to the treasury) and has no deposit session.
alter table solana_positions add column if not exists source text not null default 'kiosk';
alter table solana_positions add column if not exists funding_sig text;
alter table solana_positions add column if not exists funding_valid_height bigint;
alter table solana_positions add column if not exists funding_message_hash text;
alter table solana_positions add column if not exists funding_confirmed_at timestamptz;
do $$ begin
  alter table solana_positions add constraint solana_positions_source_check check (source in ('kiosk', 'web'));
exception when duplicate_object then null; end $$;
alter table solana_positions drop constraint if exists solana_positions_status_check;
alter table solana_positions add constraint solana_positions_status_check
  check (status in ('funding', 'opening', 'open', 'closing', 'closed', 'failed'));
```

- [ ] **Step 4: Extend the store** — in `backend/src/solana/store.ts`:

Replace the status type:

```ts
export type PositionStatus = "funding" | "opening" | "open" | "closing" | "closed" | "failed";
```

Add these fields to `SolPositionRow` (after `closedAt`):

```ts
  source: "kiosk" | "web";
  fundingSig: string | null;
  fundingValidHeight: number | null;
  fundingMessageHash: string | null;
  fundingConfirmedAt: Date | null;
```

Add to `FIELDS` (after `closedAt: "closed_at",`):

```ts
  source: "source",
  fundingSig: "funding_sig",
  fundingValidHeight: "funding_valid_height",
  fundingMessageHash: "funding_message_hash",
  fundingConfirmedAt: "funding_confirmed_at",
```

Change `NUMERIC` to include the new height:

```ts
const NUMERIC = new Set(["musd_in", "value_out", "open_valid_height", "swap_valid_height", "payout_valid_height", "funding_valid_height"]);
```

Change the `updatePositionIf` generic to allow the funding signature:

```ts
export async function updatePositionIf<K extends "openSig" | "swapSig" | "payoutSig" | "fundingSig">(
```

Add after `createPositionForSession`:

```ts
/// A web Earn position (no session), waiting for the customer's approved
/// mUSD transfer to the treasury.
export async function createWebPosition(p: {
  privyUserId: string;
  tier: SolTier;
  pair: string;
  musdIn: number;
  fundingMessageHash: string;
  fundingValidHeight: number;
}): Promise<SolPositionRow> {
  const id = crypto.randomUUID();
  await pool.query(
    `insert into solana_positions (id, privy_user_id, tier, pair, musd_in, status, source, funding_message_hash, funding_valid_height)
     values ($1, $2, $3, $4, $5, 'funding', 'web', $6, $7)`,
    [id, p.privyUserId, p.tier, p.pair, p.musdIn, p.fundingMessageHash, p.fundingValidHeight],
  );
  return (await getPosition(id))!;
}

/// 'funding' → 'opening' once the customer's transfer is confirmed. False if
/// it wasn't 'funding' any more (another run got there first).
export async function confirmFunding(id: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    "update solana_positions set status = 'opening', funding_confirmed_at = now(), error = null where id = $1 and status = 'funding'",
    [id],
  );
  return rowCount === 1;
}

/// Web positions still waiting on their funding transfer (the sweep resolves them).
export async function fundingRows(): Promise<SolPositionRow[]> {
  const { rows } = await pool.query(`select ${POSITION_COLUMNS} from solana_positions where status = 'funding'`);
  return rows;
}

/// Confirmed web positions with no open sent 5 minutes later — their open job
/// was lost (e.g. a crash right after confirming). Re-queuing is safe:
/// job ids dedupe and openPosition is idempotent.
export async function webOpeningWithoutJob(): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(
    `select id from solana_positions
     where source = 'web' and status = 'opening' and open_sig is null and error is null
       and funding_confirmed_at < now() - interval '5 minutes'`,
  );
  return rows.map((r) => r.id);
}
```

- [ ] **Step 5: Run the tests**

Run: `cd backend && node --import tsx --test --test-concurrency=1 test/solanaWebEarn.test.ts test/solanaStore.test.ts test/solanaPositions.test.ts`
Expected: all PASS.

- [ ] **Step 6: Typecheck**

Run: `cd backend && npx tsc --noEmit -p .`
Expected: no output.

- [ ] **Step 7: Commit** (main session)

```bash
git add backend/migrations/013_solana_web_earn.sql backend/src/solana/store.ts backend/test/solanaWebEarn.test.ts
git commit -m "Store web Earn positions: funding status, source and funding signature"
git push origin main
```

---

### Task 2: Daily limit counts web Earn

**Files:**
- Modify: `backend/src/limits.ts` (`usedToday`)
- Test: `backend/test/solanaWebEarn.test.ts`

- [ ] **Step 1: Write the failing test** — append to `backend/test/solanaWebEarn.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd backend && node --import tsx --test --test-concurrency=1 test/solanaWebEarn.test.ts`
Expected: FAIL — `0 !== 7`.

- [ ] **Step 3: Implement** — in `backend/src/limits.ts`, replace the query in `usedToday` with:

```ts
  const { rows } = await pool.query<{ used: string }>(
    `select
       (select coalesce(sum(usd_amount), 0) from deposits where privy_user_id = $1 and created_at >= $2 and status <> 'failed')
     + (select coalesce(sum(gross_usd), 0) from withdrawals where privy_user_id = $1 and created_at >= $2)
     + (select coalesce(sum(amount_usd), 0) from yield_events where privy_user_id = $1 and action = 'open' and chain = 'evm' and created_at >= $2)
     + (select coalesce(sum(musd_in), 0) from solana_positions where privy_user_id = $1 and source = 'web' and status <> 'failed' and created_at >= $2)
     + (select coalesce(sum(amount_usd), 0) from transfers where from_user = $1 and created_at >= $2) as used`,
    [privyUserId, startOfUtcDay()],
  );
```

And extend the header comment's list:

```ts
/// Daily limit for every customer: everything they move in a day (UTC) —
/// cash deposited, withdrawals, yield positions opened (Ethereum, and Solana
/// Earn opened from the web app with mUSD already held), and anything sent by
/// name — adds up to at most DAILY_LIMIT_USD ($1,000). Kiosk Earn isn't
/// counted again: its notes were already counted as deposits.
```

- [ ] **Step 4: Run the tests**

Run: `cd backend && node --import tsx --test --test-concurrency=1 test/solanaWebEarn.test.ts test/limits.test.ts test/solanaPositions.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit** (main session)

```bash
git add backend/src/limits.ts backend/test/solanaWebEarn.test.ts
git commit -m "Count web Earn toward the daily limit"
git push origin main
```

---

### Task 3: Open any position by id

**Files:**
- Modify: `backend/src/solana/positions.ts` (`openForSession` → `openForSession` + `openPosition`; `PositionView`)
- Test: `backend/test/solanaPositions.test.ts`

- [ ] **Step 1: Write the failing test** — append to `backend/test/solanaPositions.test.ts`:

```ts
test("openPosition opens a funded web position (no session)", async () => {
  const { openPosition } = await import("../src/solana/positions.js");
  const row = await store.createWebPosition({ privyUserId: "u-p", tier: "medium", pair: "PAIR", musdIn: 4, fundingMessageHash: "H", fundingValidHeight: 1 });
  const { calls, deps } = fakeChain();
  assert.equal((await openPosition(row.id, deps))?.status, "funding"); // not funded yet: nothing happens
  assert.equal(calls.opened, 0);
  await store.confirmFunding(row.id);
  const opened = await openPosition(row.id, deps);
  assert.deepEqual([opened?.status, opened?.positionPubkey, opened?.musdIn, opened?.source], ["open", "POS", 4, "web"]);
  assert.deepEqual(calls.events, ["solana.position.opened"]);
});

test("viewPosition reports the source", async () => {
  const { viewPosition } = await import("../src/solana/positions.js");
  const row = await store.createWebPosition({ privyUserId: "u-p", tier: "low", pair: "PAIR", musdIn: 1, fundingMessageHash: "H", fundingValidHeight: 1 });
  assert.equal((await viewPosition(row)).source, "web");
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd backend && node --import tsx --test --test-concurrency=1 test/solanaPositions.test.ts`
Expected: FAIL — `openPosition is not a function`.

- [ ] **Step 3: Implement** — in `backend/src/solana/positions.ts` replace the whole `openForSession` function with:

```ts
/// Opens the Earn position for a finished kiosk session (idempotent).
export async function openForSession(sessionId: string, d: PositionDeps = liveDeps): Promise<SolPositionRow | null> {
  if (!(await sessionSettled(sessionId))) throw new Error(`session ${sessionId}: notes still settling`);
  const row = await createPositionForSession(sessionId, d.pairAddress());
  if (!row || row.status !== "opening") return row;
  return openPosition(row.id, d);
}

/// Opens a position row that is 'opening' — a kiosk session's, or a web one
/// whose funding transfer has confirmed (idempotent; anything else is left as is).
export async function openPosition(id: string, d: PositionDeps = liveDeps): Promise<SolPositionRow | null> {
  let row = await getPosition(id);
  if (!row || row.status !== "opening") return row;

  let signature = row.openSig;
  let validHeight = row.openValidHeight;
  if (!signature || validHeight == null) {
    const prepared = await d.prepareOpen(row.tier, toRaw(row.musdIn));
    // stored before sending; false means another run already stored a send
    const stored = await updatePositionIf(row.id, "openSig", null, {
      positionPubkey: prepared.position,
      minBinId: prepared.minBinId,
      maxBinId: prepared.maxBinId,
      openSig: prepared.signed.signature,
      openValidHeight: prepared.signed.lastValidBlockHeight,
    });
    if (!stored) throw new Error(`position ${row.id}: an open is already recorded - not sending a second`);
    signature = prepared.signed.signature;
    validHeight = prepared.signed.lastValidBlockHeight;
    await d.broadcast(prepared.signed.raw);
  }
  const outcome = await d.confirm(signature, validHeight);
  if (outcome !== "confirmed") {
    await updatePositionIf(row.id, "openSig", signature, {
      openSig: null, openValidHeight: null, positionPubkey: null, minBinId: null, maxBinId: null,
    });
    throw new Error(`position open ${signature} ${outcome} - opening again`);
  }

  // status + History in one transaction; publish only after it commits
  const finalized = await finalizeOpen(row.id, {
    privyUserId: row.privyUserId, action: "open", riskTier: row.tier, pair: pairLabel(row.tier),
    apyBps: null, amountUsd: row.musdIn, rationale: null, ensName: null, txHash: signature, chain: "sol",
  });
  row = (await getPosition(row.id))!;
  if (finalized) {
    await d.publish(row.privyUserId, { type: "solana.position.opened", positionId: row.id, tier: row.tier, amountUsd: row.musdIn, signature });
  }
  return row;
}
```

In the same file add `source` to `PositionView` (after `status`):

```ts
  source: SolPositionRow["source"];
```

and to the object `viewPosition` returns (after `status: row.status,`):

```ts
    source: row.source,
```

- [ ] **Step 4: Run the tests**

Run: `cd backend && node --import tsx --test --test-concurrency=1 test/solanaPositions.test.ts`
Expected: all PASS (the existing kiosk tests unchanged).

- [ ] **Step 5: Typecheck** — `cd backend && npx tsc --noEmit -p .` → no output.

- [ ] **Step 6: Commit** (main session)

```bash
git add backend/src/solana/positions.ts backend/test/solanaPositions.test.ts
git commit -m "Open Earn positions by id so web positions share the open path"
git push origin main
```

---

### Task 4: Queue web opens by position id

**Files:**
- Modify: `backend/src/solana/jobs.ts`
- Test: `backend/test/solanaJobs.test.ts`

- [ ] **Step 1: Write the failing test** — append to `backend/test/solanaJobs.test.ts` (and add `recoveryJob` to the import on line 3: `import { failedPositionPatch, recoveryJob } from "../src/solana/jobs.js";`):

```ts
test("recoveryJob: closing → close, kiosk opening → by session, web opening → by position", () => {
  assert.deepEqual(recoveryJob({ id: "p1", status: "closing", sessionId: "s1" }), { kind: "close", positionId: "p1" });
  assert.deepEqual(recoveryJob({ id: "p2", status: "opening", sessionId: "s2" }), { kind: "open", sessionId: "s2" });
  assert.deepEqual(recoveryJob({ id: "p3", status: "opening", sessionId: null }), { kind: "openPosition", positionId: "p3" });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd backend && node --import tsx --test --test-concurrency=1 test/solanaJobs.test.ts`
Expected: FAIL — `recoveryJob` is not exported.

- [ ] **Step 3: Implement** — in `backend/src/solana/jobs.ts`:

Change the import from positions:

```ts
import { closePosition, openForSession, openPosition } from "./positions.js";
```

Replace `type JobData = ...` with:

```ts
type JobData =
  | { kind: "open"; sessionId: string } // kiosk Earn: the row is created once the session's notes settle
  | { kind: "openPosition"; positionId: string } // web Earn: the row exists and its funding has confirmed
  | { kind: "close"; positionId: string };
```

Add after `enqueueOpen`:

```ts
export async function enqueueOpenPosition(positionId: string, opts: { retry?: boolean } = {}) {
  const jobId = opts.retry ? `openpos-${positionId}-${Date.now()}` : `openpos-${positionId}`;
  const q = positionsQueue();
  if (!opts.retry) {
    const existing = await q.getJob(jobId);
    if (existing && (await existing.isFailed())) await existing.remove();
  }
  await q.add("open", { kind: "openPosition", positionId }, { jobId });
}
```

Replace `run`:

```ts
async function run(job: Job<JobData>) {
  if (job.data.kind === "open") await openForSession(job.data.sessionId);
  else if (job.data.kind === "openPosition") await openPosition(job.data.positionId);
  else await closePosition(job.data.positionId);
}
```

Replace `markFailed`:

```ts
async function markFailed(job: Job<JobData>, err: Error) {
  const row = job.data.kind === "open" ? await positionForSession(job.data.sessionId) : await getPosition(job.data.positionId);
  if (!row) return;
  await updatePosition(row.id, failedPositionPatch(job.data.kind === "close" ? "close" : "open", row, err.message));
  await publishUserEvent(row.privyUserId, { type: "solana.position.failed", positionId: row.id, error: err.message });
}
```

Replace `recoverStuckPositions` with a pure helper plus the sweep:

```ts
/// Which job resumes a stuck row.
export function recoveryJob(r: { id: string; status: string; sessionId: string | null }): JobData {
  if (r.status === "closing") return { kind: "close", positionId: r.id };
  return r.sessionId ? { kind: "open", sessionId: r.sessionId } : { kind: "openPosition", positionId: r.id };
}

/// Re-queue opens and closes whose retries ran out while a send was still
/// stored (error is only written on final failure). The error is cleared so
/// a row is queued once per failure.
export async function recoverStuckPositions(): Promise<number> {
  const { rows } = await pool.query<{ id: string; status: string; sessionId: string | null }>(
    `select id, status, session_id as "sessionId" from solana_positions
     where status in ('opening', 'closing') and error is not null`,
  );
  for (const r of rows) {
    await updatePosition(r.id, { error: null });
    const job = recoveryJob(r);
    if (job.kind === "close") await enqueueClose(job.positionId);
    else if (job.kind === "open") await enqueueOpen(job.sessionId, { retry: true });
    else await enqueueOpenPosition(job.positionId, { retry: true });
  }
  return rows.length;
}
```

- [ ] **Step 4: Run the tests** — `cd backend && node --import tsx --test --test-concurrency=1 test/solanaJobs.test.ts` → all PASS. Typecheck → no output.

- [ ] **Step 5: Commit** (main session)

```bash
git add backend/src/solana/jobs.ts backend/test/solanaJobs.test.ts
git commit -m "Queue web Earn opens by position id"
git push origin main
```

---

### Task 5: Build and check the funding transaction (pure)

**Files:**
- Create: `backend/src/solana/fundingTx.ts`
- Test: `backend/test/solanaFundingTx.test.ts` (new)

- [ ] **Step 1: Write the failing test** — create `backend/test/solanaFundingTx.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, Transaction, ComputeBudgetProgram } from "@solana/web3.js";
import { buildFundingTx, checkSignedFunding, messageHash, unsignedBase64 } from "../src/solana/fundingTx.js";

const owner = Keypair.generate();
const treasury = Keypair.generate();
const mint = Keypair.generate().publicKey;
const blockhash = Keypair.generate().publicKey.toBase58(); // any 32 bytes in base58
const params = (amountRaw = 2_500_000n) => ({
  owner: owner.publicKey, treasury: treasury.publicKey, mint, amountRaw, blockhash, lastValidBlockHeight: 500, priorityMicroLamports: 10_000,
});

/// What the browser does: decode, sign with the customer's key, re-encode.
function customerSigns(b64: string, signer = owner): string {
  const tx = Transaction.from(Buffer.from(b64, "base64"));
  tx.partialSign(signer);
  return tx.serialize({ requireAllSignatures: false }).toString("base64");
}

test("the treasury pays the fee and the customer is the only other signer", () => {
  const tx = buildFundingTx(params());
  assert.ok(tx.feePayer?.equals(treasury.publicKey));
  const signers = tx.compileMessage().accountKeys.slice(0, tx.compileMessage().header.numRequiredSignatures).map((k) => k.toBase58());
  assert.deepEqual(signers.sort(), [owner.publicKey.toBase58(), treasury.publicKey.toBase58()].sort());
});

test("a correctly signed transaction passes, and the treasury can co-sign it", () => {
  const tx = buildFundingTx(params());
  const res = checkSignedFunding(customerSigns(unsignedBase64(tx)), messageHash(tx), owner.publicKey);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  res.tx.partialSign(treasury);
  assert.equal(res.tx.verifySignatures(true), true);
});

test("a different amount is refused", () => {
  const prepared = buildFundingTx(params());
  const other = buildFundingTx(params(9_000_000n));
  const res = checkSignedFunding(customerSigns(unsignedBase64(other)), messageHash(prepared), owner.publicKey);
  assert.deepEqual(res, { ok: false, reason: "transaction differs from the one prepared" });
});

test("an extra instruction is refused", () => {
  const prepared = buildFundingTx(params());
  const extra = buildFundingTx(params()).add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }));
  const res = checkSignedFunding(customerSigns(unsignedBase64(extra)), messageHash(prepared), owner.publicKey);
  assert.equal(res.ok, false);
});

test("an unsigned transaction is refused", () => {
  const tx = buildFundingTx(params());
  assert.deepEqual(checkSignedFunding(unsignedBase64(tx), messageHash(tx), owner.publicKey), { ok: false, reason: "not signed by your Solana wallet" });
});

test("a forged signature is refused", () => {
  const tx = buildFundingTx(params());
  tx.addSignature(owner.publicKey, Buffer.alloc(64, 7));
  const forged = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
  assert.deepEqual(checkSignedFunding(forged, messageHash(tx), owner.publicKey), { ok: false, reason: "bad signature" });
});

test("a transaction for someone else's wallet is refused", () => {
  const stranger = Keypair.generate();
  const tx = buildFundingTx({ ...params(), owner: stranger.publicKey });
  const signed = customerSigns(unsignedBase64(tx), stranger);
  assert.equal(checkSignedFunding(signed, messageHash(tx), owner.publicKey).ok, false);
});

test("garbage is refused", () => {
  assert.deepEqual(checkSignedFunding("bm90IGEgdHg=", "x", owner.publicKey), { ok: false, reason: "unreadable transaction" });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd backend && node --import tsx --test --test-concurrency=1 test/solanaFundingTx.test.ts`
Expected: FAIL — cannot find module `fundingTx.js`.

- [ ] **Step 3: Implement** — create `backend/src/solana/fundingTx.ts`:

```ts
import { createHash } from "node:crypto";
import { ComputeBudgetProgram, PublicKey, Transaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, createTransferCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { MUSD_DECIMALS } from "./tiers.js";

/// The one transaction a customer signs for web Earn: their mUSD → the
/// treasury's mUSD account, the treasury paying the fee. The backend builds
/// it and remembers the hash of its message; whatever comes back signed must
/// have exactly that message, so the treasury never co-signs anything else.

export interface FundingParams {
  owner: PublicKey;
  treasury: PublicKey;
  mint: PublicKey;
  amountRaw: bigint;
  blockhash: string;
  lastValidBlockHeight: number;
  priorityMicroLamports: number;
}

const ata = (mint: PublicKey, owner: PublicKey) => getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022_PROGRAM_ID);

export function buildFundingTx(p: FundingParams): Transaction {
  return new Transaction({ feePayer: p.treasury, blockhash: p.blockhash, lastValidBlockHeight: p.lastValidBlockHeight }).add(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: p.priorityMicroLamports }),
    createTransferCheckedInstruction(ata(p.mint, p.owner), p.mint, ata(p.mint, p.treasury), p.owner, p.amountRaw, MUSD_DECIMALS, [], TOKEN_2022_PROGRAM_ID),
  );
}

export const messageHash = (tx: Transaction) => createHash("sha256").update(tx.serializeMessage()).digest("hex");

export const unsignedBase64 = (tx: Transaction) => tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");

export type FundingCheck = { ok: true; tx: Transaction } | { ok: false; reason: string };

export function checkSignedFunding(signedBase64: string, expectedHash: string, owner: PublicKey): FundingCheck {
  let tx: Transaction;
  try {
    tx = Transaction.from(Buffer.from(signedBase64, "base64"));
  } catch {
    return { ok: false, reason: "unreadable transaction" };
  }
  if (messageHash(tx) !== expectedHash) return { ok: false, reason: "transaction differs from the one prepared" };
  const mine = tx.signatures.find((s) => s.publicKey.equals(owner));
  if (!mine?.signature) return { ok: false, reason: "not signed by your Solana wallet" };
  if (!tx.verifySignatures(false)) return { ok: false, reason: "bad signature" };
  return { ok: true, tx };
}
```

- [ ] **Step 4: Run the tests** — same command → all 8 PASS. Typecheck → no output.

If "a transaction for someone else's wallet" passes the hash check unexpectedly, it can't: the stranger's tx has a different message, but note the hash passed in is the stranger tx's own hash — so the refusal must come from the owner-signature check (`not signed by your Solana wallet`). That is the intended path; keep the assertion as `ok === false`.

- [ ] **Step 5: Commit** (main session)

```bash
git add backend/src/solana/fundingTx.ts backend/test/solanaFundingTx.test.ts
git commit -m "Build and check the customer-signed mUSD funding transaction"
git push origin main
```

---

### Task 6: Web Earn service (prepare, submit, sweep)

**Files:**
- Create: `backend/src/solana/webEarn.ts`
- Test: `backend/test/solanaWebEarn.test.ts`

- [ ] **Step 1: Write the failing tests** — append to `backend/test/solanaWebEarn.test.ts`:

```ts
import { Keypair, Transaction } from "@solana/web3.js";

const webEarn = await import("../src/solana/webEarn.js");
const owner = Keypair.generate();
const treasuryKp = Keypair.generate();
const mintKey = Keypair.generate().publicKey;
await accounts.insertAccount({ privyUserId: "u-e", email: "e@x.io", privyWallet: "0x00000000000000000000000000000000000000c3", boundAddress: "0x00000000000000000000000000000000000000d3", ensName: null });
await accounts.setSolanaWallet("u-e", owner.publicKey.toBase58());
const account = (await accounts.findByPrivyUserId("u-e"))!;

function fakeDeps(opts: { balance?: bigint; outcome?: "confirmed" | "expired" | "failed" | "throw" } = {}) {
  const calls = { broadcast: 0, enqueued: [] as string[] };
  return {
    calls,
    deps: {
      pairAddress: () => "PAIR",
      balanceRaw: async () => opts.balance ?? 10_000_000n,
      latestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 900 }),
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
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd backend && node --import tsx --test --test-concurrency=1 test/solanaWebEarn.test.ts`
Expected: FAIL — cannot find module `webEarn.js`.

- [ ] **Step 3: Implement** — create `backend/src/solana/webEarn.ts`:

```ts
import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import type { Account } from "../accounts.js";
import { findByPrivyUserId } from "../accounts.js";
import { config } from "../config.js";
import { dailyAllowance } from "../limits.js";
import { broadcast, confirm, connection, treasury, type Outcome } from "./client.js";
import { buildFundingTx, checkSignedFunding, messageHash, unsignedBase64 } from "./fundingTx.js";
import { enqueueOpenPosition } from "./jobs.js";
import { balanceRaw, fromRaw, musdMint, toRaw } from "./musd.js";
import {
  confirmFunding,
  createWebPosition,
  fundingRows,
  getPosition,
  updatePosition,
  updatePositionIf,
  webOpeningWithoutJob,
} from "./store.js";
import { isSolTier } from "./tiers.js";

/// Earn from mUSD the customer already holds (web app). Two steps:
///   prepare — checks, a 'funding' row, and the unsigned transfer to sign;
///   submit  — checks the signed transfer is the prepared one, co-signs as
///             fee payer, stores the signature, sends, confirms, queues the open.
/// Same send rule as everywhere else: the signature is stored before
/// broadcasting, and a send whose outcome is unknown is re-checked by the
/// sweep, never re-sent.

export interface WebEarnDeps {
  pairAddress: () => string;
  balanceRaw: (owner: PublicKey) => Promise<bigint>;
  latestBlockhash: () => Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  treasury: () => Keypair;
  mint: () => PublicKey;
  priorityMicroLamports: () => number;
  broadcast: (raw: Uint8Array) => Promise<void>;
  confirm: (signature: string, lastValidBlockHeight: number) => Promise<Outcome>;
  enqueueOpen: (positionId: string) => Promise<void>;
}

export const liveWebEarnDeps: WebEarnDeps = {
  pairAddress: () => config.solana.dlmmPair,
  balanceRaw,
  latestBlockhash: () => connection.getLatestBlockhash("confirmed"),
  treasury,
  mint: musdMint,
  priorityMicroLamports: () => config.solana.priorityMicroLamports,
  broadcast,
  confirm: (sig, height) => confirm(sig, height, 60_000), // an HTTP request is waiting
  enqueueOpen: (id) => enqueueOpenPosition(id),
};

export interface Reply {
  status: number;
  body: unknown;
}

const APPROVAL_WINDOW_MS = 10 * 60_000;

export async function prepareWebEarn(account: Account, amount: unknown, tier: unknown, d: WebEarnDeps = liveWebEarnDeps): Promise<Reply> {
  if (!isSolTier(tier)) return { status: 400, body: { error: "tier must be low, medium or high" } };
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0 || toRaw(amount) <= 0n || Math.abs(amount * 1e6 - Math.round(amount * 1e6)) > 1e-6) {
    return { status: 400, body: { error: "enter an amount of mUSD (up to 6 decimals)" } };
  }
  if (!account.solanaWallet) return { status: 400, body: { error: "You don't have a Solana wallet yet — choose Solana at a kiosk first." } };
  const owner = new PublicKey(account.solanaWallet);

  const allowance = await dailyAllowance(account);
  if (allowance.limited && amount > allowance.leftUsd) {
    return {
      status: 403,
      body: { error: `That's over today's limit — you can move $${allowance.leftUsd.toFixed(2)} more today.`, code: "daily_limit" },
    };
  }
  const held = await d.balanceRaw(owner);
  if (toRaw(amount) > held) return { status: 400, body: { error: `You have ${fromRaw(held)} mUSD — enter that much or less.` } };

  const { blockhash, lastValidBlockHeight } = await d.latestBlockhash();
  const tx = buildFundingTx({
    owner,
    treasury: d.treasury().publicKey,
    mint: d.mint(),
    amountRaw: toRaw(amount),
    blockhash,
    lastValidBlockHeight,
    priorityMicroLamports: d.priorityMicroLamports(),
  });
  const row = await createWebPosition({
    privyUserId: account.privyUserId,
    tier,
    pair: d.pairAddress(),
    musdIn: amount,
    fundingMessageHash: messageHash(tx),
    fundingValidHeight: lastValidBlockHeight,
  });
  return { status: 200, body: { id: row.id, tx: unsignedBase64(tx) } };
}

export async function submitWebEarn(privyUserId: string, id: string, signedTx: unknown, d: WebEarnDeps = liveWebEarnDeps): Promise<Reply> {
  const row = await getPosition(id);
  if (!row || row.privyUserId !== privyUserId || row.source !== "web") return { status: 404, body: { error: "position not found" } };
  if (row.status !== "funding" || row.fundingSig) return { status: 409, body: { error: `position is ${row.status}`, code: "already_submitted" } };
  const account = await findByPrivyUserId(privyUserId);
  if (!account?.solanaWallet || typeof signedTx !== "string" || !row.fundingMessageHash || row.fundingValidHeight == null) {
    return { status: 400, body: { error: "signed transaction required" } };
  }

  const check = checkSignedFunding(signedTx, row.fundingMessageHash, new PublicKey(account.solanaWallet));
  if (!check.ok) {
    await updatePosition(id, { status: "failed", error: check.reason });
    return { status: 400, body: { error: check.reason } };
  }
  check.tx.partialSign(d.treasury());
  const signature = bs58.encode(check.tx.signature!);
  if (!(await updatePositionIf(id, "fundingSig", null, { fundingSig: signature }))) {
    return { status: 409, body: { error: "already submitted", code: "already_submitted" } };
  }
  try {
    await d.broadcast(check.tx.serialize());
    return await settle(id, signature, row.fundingValidHeight, d);
  } catch (err) {
    // Unknown outcome: the signature is stored; the sweep re-checks it.
    console.error(`[solana] web earn ${id}: ${err instanceof Error ? err.message : err}`);
    return { status: 202, body: { id, status: "funding" } };
  }
}

/// Confirms a stored funding signature and moves the row on. Throws if the
/// outcome is still unknown.
async function settle(id: string, signature: string, validHeight: number, d: WebEarnDeps): Promise<Reply> {
  const outcome = await d.confirm(signature, validHeight);
  if (outcome === "confirmed") {
    await confirmFunding(id);
    await d.enqueueOpen(id);
    return { status: 202, body: { id, status: "opening" } };
  }
  await updatePosition(id, { status: "failed", error: `the mUSD transfer ${outcome} — nothing moved, try again` });
  return { status: 400, body: { error: `the mUSD transfer ${outcome} — nothing moved, try again` } };
}

/// The sweep: settle sent transfers whose outcome was unknown, fail approvals
/// never given, and re-queue confirmed rows whose open job was lost.
export async function resolveFunding(d: WebEarnDeps = liveWebEarnDeps): Promise<void> {
  for (const row of await fundingRows()) {
    if (row.fundingSig && row.fundingValidHeight != null) {
      await settle(row.id, row.fundingSig, row.fundingValidHeight, d).catch(() => {}); // still unknown: next sweep
    } else if (Date.now() - new Date(row.createdAt).getTime() > APPROVAL_WINDOW_MS) {
      await updatePositionIf(row.id, "fundingSig", null, { status: "failed", error: "not approved in time" });
    }
  }
  for (const id of await webOpeningWithoutJob()) await d.enqueueOpen(id);
}

export function startFundingSweep() {
  const tick = () => void resolveFunding().catch((e) => console.error("[solana] funding sweep:", e instanceof Error ? e.message : e));
  tick();
  setInterval(tick, 2 * 60_000).unref();
}
```

Check `isSolTier` exists in `src/solana/tiers.ts` (it is used by `test/solanaTiers.test.ts`); if it is not exported, export it there.

- [ ] **Step 4: Run the tests**

Run: `cd backend && node --import tsx --test --test-concurrency=1 test/solanaWebEarn.test.ts`
Expected: all PASS.

- [ ] **Step 5: Run the whole suite and typecheck**

Run: `cd backend && npm test 2>&1 | grep -E "^# (tests|pass|fail)" && npx tsc --noEmit -p .`
Expected: `# fail 0`, no type errors.

- [ ] **Step 6: Commit** (main session)

```bash
git add backend/src/solana/webEarn.ts backend/test/solanaWebEarn.test.ts backend/src/solana/tiers.ts
git commit -m "Web Earn service: prepare, customer-signed submit, funding sweep"
git push origin main
```

---

### Task 7: Routes and startup

**Files:**
- Modify: `backend/src/routes/solanaRoutes.ts`, `backend/src/index.ts`

- [ ] **Step 1: Add the routes** — in `backend/src/routes/solanaRoutes.ts` add the import:

```ts
import { prepareWebEarn, submitWebEarn } from "../solana/webEarn.js";
```

and, after the close route:

```ts
/// POST /solana/earn/prepare { amount, tier } — Earn from mUSD the customer
/// holds: returns the transfer for them to approve in their wallet.
solanaRouter.post("/solana/earn/prepare", requireSession("full"), asyncHandler(async (req, res) => {
  const session: Session = res.locals.session;
  const available = await solanaAvailable();
  if (!available.ok) {
    res.status(503).json({ error: `Solana is unavailable right now (${available.reason})`, code: "solana_unavailable" });
    return;
  }
  const account = await findByPrivyUserId(session.privyUserId);
  if (!account) {
    res.status(404).json({ error: "unknown account" });
    return;
  }
  const reply = await prepareWebEarn(account, req.body?.amount, req.body?.tier);
  res.status(reply.status).json(reply.body);
}));

/// POST /solana/earn/submit { id, signedTx } — the approved transfer; the
/// position opens once it confirms (follow it on GET /solana/me).
solanaRouter.post("/solana/earn/submit", requireSession("full"), asyncHandler(async (req, res) => {
  const session: Session = res.locals.session;
  const reply = await submitWebEarn(session.privyUserId, String(req.body?.id ?? ""), req.body?.signedTx);
  res.status(reply.status).json(reply.body);
}));
```

- [ ] **Step 2: Start the sweep** — in `backend/src/index.ts` add `import { startFundingSweep } from "./solana/webEarn.js";` with the other imports, and after `startSolanaWorker();`:

```ts
if (solanaReady) startFundingSweep();
```

(import `solanaReady` from `./solana/client.js` if `index.ts` doesn't already).

- [ ] **Step 3: Smoke-check the routes** — start the backend (`cd backend && npm run dev` in the background), then:

```bash
curl -s -X POST localhost:4000/solana/earn/prepare -H 'content-type: application/json' -d '{"amount":1,"tier":"low"}' -w ' %{http_code}\n'
```
Expected: `{"error":...} 401` (no session). Stop the backend.

- [ ] **Step 4: Typecheck and full suite** — `cd backend && npx tsc --noEmit -p . && npm test 2>&1 | grep -E "^# (pass|fail)"` → `# fail 0`.

- [ ] **Step 5: Commit** (main session)

```bash
git add backend/src/routes/solanaRoutes.ts backend/src/index.ts
git commit -m "Routes for web Earn and the funding sweep at startup"
git push origin main
```

---

### Task 8: Frontend plumbing (Privy Solana, signing hook, proxies, types)

**Files:**
- Modify: `frontend/components/PrivyShell.tsx`, `frontend/lib/types.ts`
- Create: `frontend/lib/useSolanaSign.ts`, `frontend/app/api/solana/earn/prepare/route.ts`, `frontend/app/api/solana/earn/submit/route.ts`

- [ ] **Step 1: Privy** — in `frontend/components/PrivyShell.tsx` replace the `embeddedWallets` line with:

```tsx
        // Both wallets are created by the backend; Privy only signs with them.
        embeddedWallets: { ethereum: { createOnLogin: "off" }, solana: { createOnLogin: "off" } },
```

- [ ] **Step 2: Types** — in `frontend/lib/types.ts`, in `SolanaPosition` change `status` and add `source`:

```ts
  status: "funding" | "opening" | "open" | "closing" | "closed" | "failed";
  source: "kiosk" | "web";
```

and append:

```ts
/// POST /solana/earn/prepare → the transfer to approve.
export interface WebEarnPrepared {
  id: string;
  tx: string; // base64, unsigned
}

/// POST /solana/earn/submit
export interface WebEarnSubmitted {
  id: string;
  status: "opening" | "funding";
}
```

- [ ] **Step 3: Signing hook** — create `frontend/lib/useSolanaSign.ts`:

```ts
"use client";

import { useCallback } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { useSignTransaction, useWallets } from "@privy-io/react-auth/solana";

const toBytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const toBase64 = (bytes: Uint8Array) => btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""));

/// Has the customer sign (not send) a Solana transaction the backend
/// prepared, in their Privy Solana wallet. Returns the signed transaction,
/// base64; the backend checks it, co-signs as fee payer and sends it.
export function useSolanaSign() {
  const { ready, authenticated, login } = usePrivy();
  const { wallets } = useWallets();
  const { signTransaction } = useSignTransaction();

  return useCallback(
    async (txBase64: string, address: string): Promise<string> => {
      if (!ready) throw new Error("wallet is still loading — try again in a moment");
      if (!authenticated) {
        login();
        throw new Error("sign in to your wallet, then press Earn again");
      }
      const wallet = wallets.find((w) => w.address === address);
      if (!wallet) throw new Error("your Takarabako Solana wallet isn't available in this browser — log out and in again");
      const { signedTransaction } = await signTransaction({ transaction: toBytes(txBase64), wallet, chain: "solana:devnet" });
      return toBase64(signedTransaction);
    },
    [ready, authenticated, login, wallets, signTransaction],
  );
}
```

- [ ] **Step 4: Proxies** — create `frontend/app/api/solana/earn/prepare/route.ts`:

```ts
import type { NextRequest } from "next/server";
import { relay } from "@/lib/backend";

/// POST /api/solana/earn/prepare { amount, tier }
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  return relay("web", "/solana/earn/prepare", { body });
}
```

and `frontend/app/api/solana/earn/submit/route.ts`:

```ts
import type { NextRequest } from "next/server";
import { relay } from "@/lib/backend";

/// POST /api/solana/earn/submit { id, signedTx }
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  return relay("web", "/solana/earn/submit", { body });
}
```

- [ ] **Step 5: Typecheck and lint**

Run: `cd frontend && npx tsc --noEmit && npx eslint lib/useSolanaSign.ts components/PrivyShell.tsx app/api/solana`
Expected: no output. If `tsc` reports that `@solana/kit` can't be resolved from `@privy-io/react-auth/solana`, run `npm install @solana/kit@^5` in `frontend` and re-run.

- [ ] **Step 6: Commit** (main session)

```bash
git add frontend/components/PrivyShell.tsx frontend/lib/types.ts frontend/lib/useSolanaSign.ts frontend/app/api/solana/earn frontend/package.json frontend/package-lock.json
git commit -m "Frontend plumbing for web Earn: Privy Solana signing and proxies"
git push origin main
```

---

### Task 9: The Solana page, nav and card

**Files:**
- Create: `frontend/app/(customer)/(authed)/solana/page.tsx`, `frontend/app/(customer)/(authed)/solana/SolanaEarn.tsx`
- Modify: `frontend/components/Nav.tsx`, `frontend/components/SolanaCard.tsx`

- [ ] **Step 1: Page** — create `frontend/app/(customer)/(authed)/solana/page.tsx`:

```tsx
import type { Metadata } from "next";
import type { Me } from "@/lib/types";
import { loadForPage } from "@/lib/serverData";
import { SolanaEarn } from "./SolanaEarn";

export const metadata: Metadata = { title: "Solana · Takarabako" };

export default async function SolanaPage() {
  const me = await loadForPage<Me>("/me");
  return (
    <>
      <h1 style={{ fontSize: 26 }}>Solana</h1>
      <p className="muted">
        Put the mUSD in your Solana wallet to work in a Meteora liquidity pool. You approve one transfer; Takarabako pays
        the network fee.
      </p>
      <SolanaEarn leftToday={me.limit?.leftUsd ?? null} />
    </>
  );
}
```

- [ ] **Step 2: Earn form** — create `frontend/app/(customer)/(authed)/solana/SolanaEarn.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import type { SolTier, SolanaMe, SolanaStatus, WebEarnPrepared, WebEarnSubmitted } from "@/lib/types";
import { usd } from "@/lib/format";
import { useSolanaSign } from "@/lib/useSolanaSign";
import { SolanaCard } from "@/components/SolanaCard";

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error ?? "something went wrong");
  return json as T;
}

/// Earn from held mUSD: amount + tier → approve in Privy → position opens.
export function SolanaEarn({ leftToday }: { leftToday: number | null }) {
  const sign = useSolanaSign();
  const [me, setMe] = useState<SolanaMe | null>(null);
  const [status, setStatus] = useState<SolanaStatus | null>(null);
  const [amount, setAmount] = useState("");
  const [tier, setTier] = useState<SolTier>("low");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    fetch("/api/kiosk/solana", { cache: "no-store" }).then((r) => r.json()).then(setStatus).catch(() => setStatus(null));
  }, []);
  useEffect(() => {
    fetch("/api/solana/me", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<SolanaMe>) : null))
      .then((d) => d && setMe(d))
      .catch(() => {});
  }, [refreshKey]);

  // After a submit, follow the position from opening to open for a minute.
  function follow() {
    let n = 0;
    const t = setInterval(() => {
      setRefreshKey((k) => k + 1);
      if (++n >= 20) clearInterval(t);
    }, 3_000);
  }

  async function earn() {
    if (!me?.wallet) return;
    setBusy(true);
    setMessage(null);
    try {
      const prepared = await post<WebEarnPrepared>("/api/solana/earn/prepare", { amount: Number(amount), tier });
      const signedTx = await sign(prepared.tx, me.wallet);
      const done = await post<WebEarnSubmitted>("/api/solana/earn/submit", { id: prepared.id, signedTx });
      setMessage({
        kind: "ok",
        text: done.status === "opening" ? "Approved — your Meteora position is opening." : "Sent — waiting for the network to confirm.",
      });
      setAmount("");
      follow();
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof Error ? err.message : "couldn't start Earn" });
    } finally {
      setBusy(false);
      setRefreshKey((k) => k + 1);
    }
  }

  if (!status?.ready) return <p className="muted">Solana isn&apos;t available right now.</p>;
  if (me && !me.wallet) return <p className="muted">You don&apos;t have a Solana wallet yet — choose Solana at a kiosk first.</p>;

  const held = me?.musd ?? 0;
  const value = Number(amount);
  const valid = value > 0 && value <= held && (leftToday == null || value <= leftToday);
  return (
    <>
      <section className="card">
        <h2>Earn with your mUSD</h2>
        <p className="muted small">
          {usd(held)} mUSD in your wallet{leftToday != null && ` · ${usd(leftToday)} left to move today`}
        </p>
        <div className="spread" style={{ gap: 8 }}>
          <input
            className="input"
            inputMode="decimal"
            placeholder="Amount of mUSD"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            disabled={busy}
            aria-label="Amount of mUSD"
          />
          <button className="btn btn-ghost small" disabled={busy || held <= 0} onClick={() => setAmount(String(held))}>
            Max
          </button>
        </div>
        <div className="choice-grid" style={{ marginTop: 12 }}>
          {status.tiers.map((t) => (
            <button
              key={t.id}
              className="choice-tile"
              aria-pressed={tier === t.id}
              disabled={busy}
              onClick={() => setTier(t.id)}
              style={tier === t.id ? { outline: "2px solid var(--accent)" } : undefined}
            >
              <span className="choice-title">{t.label} risk</span>
              <span className="choice-sub">
                {t.blurb} · {t.width} bins
              </span>
            </button>
          ))}
        </div>
        <button className="btn" style={{ marginTop: 12 }} disabled={busy || !valid} onClick={earn}>
          {busy ? "Waiting for your approval…" : "Earn"}
        </button>
        <div aria-live="polite">
          {message && <div className={`notice ${message.kind === "ok" ? "pending" : "error"}`} role="status">{message.text}</div>}
        </div>
      </section>
      <SolanaCard refreshKey={refreshKey} showEarnLink={false} />
    </>
  );
}
```

Before relying on them, check the class names used here exist in `frontend/app/globals.css` (`input`, `btn`, `btn-ghost`, `choice-grid`, `choice-tile`, `choice-title`, `choice-sub`, `notice`, `spread`) and the CSS variable `--accent`; replace any missing one with the closest existing class/variable used by `app/(customer)/(authed)/withdraw` or the kiosk picker.

- [ ] **Step 3: Nav** — in `frontend/components/Nav.tsx` add after the Yield link:

```ts
  { href: "/solana", label: "Solana" },
```

- [ ] **Step 4: Card** — in `frontend/components/SolanaCard.tsx`:

Add `import Link from "next/link";` and change the signature:

```tsx
export function SolanaCard({ refreshKey, showEarnLink = true }: { refreshKey: number; showEarnLink?: boolean }) {
```

Replace the mUSD paragraph with:

```tsx
      <p className="spread">
        <span>
          {usd(data.musd ?? 0)} <span className="muted small">mUSD in your wallet</span>
        </span>
        {showEarnLink && (data.musd ?? 0) > 0 && (
          <Link href="/solana" className="small">
            Earn with your mUSD →
          </Link>
        )}
      </p>
```

and replace the status text expression `p.status === "open" ? (p.inRange ? "in range" : "out of range") : p.status` with:

```tsx
p.status === "open" ? (p.inRange ? "in range" : "out of range") : p.status === "funding" ? "waiting for your approval" : p.status
```

- [ ] **Step 5: Typecheck, lint, build**

Run: `cd frontend && npx tsc --noEmit && npx eslint "app/(customer)/(authed)/solana" components/SolanaCard.tsx components/Nav.tsx && npm run build 2>&1 | tail -15`
Expected: no type or lint errors; the build lists `/solana`.

- [ ] **Step 6: Commit** (main session)

```bash
git add "frontend/app/(customer)/(authed)/solana" frontend/components/Nav.tsx frontend/components/SolanaCard.tsx
git commit -m "Solana page in the web app: Earn from held mUSD"
git push origin main
```

---

### Task 10: `sol:flow` covers web Earn; run it on devnet

**Files:**
- Modify: `backend/scripts/sol-flow.ts`

- [ ] **Step 1: Add a `login(email)` helper and the web Earn section.** In `backend/scripts/sol-flow.ts`:

Add imports at the top:

```ts
import { Keypair, Transaction } from "@solana/web3.js";
import { insertAccount, markQrEmailed, setSolanaWallet } from "../src/accounts.js";
```

(`PublicKey` is already imported from `@solana/web3.js` — merge into one import line.)

Update the header comment's flow description to add:

```ts
//   → web Earn (a throwaway account whose Solana wallet is a local keypair,
//     standing in for the Privy wallet): Hold RM10, then Earn part of it from
//     the web app, approve the transfer, check it opens, close it
```

Replace the login block in `main()` with a helper defined above `main()`:

```ts
async function login(email: string): Promise<boolean> {
  const res = await call("POST", "/verify", { email });
  const ok = check(`login as ${email}`, res.status === 200 && Boolean(res.json.token), `${res.status} ${res.json.ensName ?? JSON.stringify(res.json)}`);
  if (ok) token = res.json.token;
  return ok;
}
```

and in `main()` use `if (!(await login(EMAIL))) process.exit(1);`.

After the `/ops` check and **before** `await call("POST", "/logout")`, add:

```ts
  await call("POST", "/logout");
  await webEarnFlow();
```

and remove the old trailing `await call("POST", "/logout");` so logout happens once per account. Add this function above `main()`:

```ts
/// Web Earn with a wallet this script can sign for.
async function webEarnFlow() {
  console.log("\n== Web Earn (local test wallet) ==");
  const user = `flow-${Date.now()}`;
  const wallet = Keypair.generate();
  const evm = (n: number) => `0x${(BigInt(Date.now()) * 10n + BigInt(n)).toString(16).padStart(40, "0")}`;
  await insertAccount({ privyUserId: user, email: `${user}@example.com`, privyWallet: evm(1), boundAddress: evm(2), ensName: null });
  await markQrEmailed(user); // no welcome email to example.com
  await setSolanaWallet(user, wallet.publicKey.toBase58());
  if (!(await login(`${user}@example.com`))) return;

  const hold = await visit("sol_hold");
  if (!hold) return;
  const funded = await until(async () => ({ done: Number((await me()).musd ?? 0) >= hold.usd - 1e-6 }), 60_000);
  if (!check("test wallet holds mUSD", funded.done)) return;

  const amount = Math.floor(hold.usd * 1e6 / 2) / 1e6; // half of it
  const tooMuch = await call("POST", "/solana/earn/prepare", { amount: hold.usd * 10, tier: "medium" });
  check("prepare refuses more than the balance", tooMuch.status === 400, `${tooMuch.status} ${tooMuch.json.error}`);

  const bad = await call("POST", "/solana/earn/prepare", { amount, tier: "medium" });
  const garbage = await call("POST", "/solana/earn/submit", { id: bad.json.id, signedTx: Buffer.from("not a tx").toString("base64") });
  check("submit refuses an unsigned or garbage transaction", garbage.status === 400, `${garbage.status} ${garbage.json.error}`);

  const prep = await call("POST", "/solana/earn/prepare", { amount, tier: "medium" });
  if (!check("prepare web Earn", prep.status === 200 && Boolean(prep.json.tx), `${prep.status} ${prep.json.error ?? `id ${prep.json.id}`}`)) return;
  const tx = Transaction.from(Buffer.from(prep.json.tx, "base64"));
  tx.partialSign(wallet); // the customer approves (Privy does this in the browser)
  const signedTx = tx.serialize({ requireAllSignatures: false }).toString("base64");
  const sub = await call("POST", "/solana/earn/submit", { id: prep.json.id, signedTx });
  check("submit the approved transfer", sub.status === 202 && sub.json.status === "opening", `${sub.status} ${JSON.stringify(sub.json)}`);
  const again = await call("POST", "/solana/earn/submit", { id: prep.json.id, signedTx });
  check("second submit refused", again.status === 409, String(again.status));

  const opened = await until(async () => {
    const p = ((await me()).positions ?? []).find((x: Json) => x.id === prep.json.id);
    return { done: Boolean(p) && ["open", "failed"].includes(p.status), p };
  });
  check("web position opened", opened.p?.status === "open" && opened.p?.source === "web",
    `in ${opened.p?.musdIn} · bins ${opened.p?.minBinId}..${opened.p?.maxBinId} · tx ${opened.p?.openSig}${opened.p?.error ? ` error ${opened.p.error}` : ""}`);
  const onChain = fromRaw(await balanceRaw(wallet.publicKey));
  check("the transfer left the customer's wallet", Math.abs(onChain - (hold.usd - amount)) < 1e-6, `devnet ${onChain} = ${hold.usd} − ${amount}`);

  if (opened.p?.status === "open") {
    await call("POST", `/solana/positions/${opened.p.id}/close`);
    const closed = await until(async () => {
      const r = await me();
      const q = (r.positions ?? []).find((x: Json) => x.id === opened.p.id);
      return { done: Boolean(q) && ["closed", "failed"].includes(q.status), q };
    });
    check("web position closed and paid back", closed.q?.status === "closed", `paid ${closed.q?.valueOut} of ${amount}`);
  }
  await call("POST", "/logout");
}
```

- [ ] **Step 2: Typecheck the script**

Run: `cd backend && npx tsc --noEmit --module nodenext --moduleResolution nodenext --target es2022 --strict --skipLibCheck --types node scripts/sol-flow.ts`
Expected: no output.

- [ ] **Step 3: Run it on devnet** — backend running (`cd backend && npm run dev`), then:

Run: `cd backend && npm run -s sol:flow`
Expected: every line `PASS`, ending `ALL PASSED`. Stop the backend afterwards. Verify one web Earn signature from the output independently with the devnet RPC:

```bash
curl -s https://api.devnet.solana.com -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getSignatureStatuses","params":[["<openSig>"],{"searchTransactionHistory":true}]}'
```
Expected: `"confirmationStatus":"finalized"`, `"err":null`.

- [ ] **Step 4: Commit** (main session)

```bash
git add backend/scripts/sol-flow.ts
git commit -m "sol:flow covers web Earn with a local test wallet"
git push origin main
```

---

### Task 11: Docs and a manual Privy check

**Files:**
- Modify: `README.md`

- [ ] **Step 1: README** — in the "Solana destination" section, after the paragraph that starts "Customers see their mUSD balance and positions", add:

```markdown
**Earn from the web app.** On the **Solana** page a customer who holds mUSD
enters an amount, picks Low / Medium / High and taps Earn. The backend builds
one mUSD transfer to the treasury (the treasury pays the fee), the customer
approves it in their Privy Solana wallet, and the backend checks that the
signed transaction is exactly the one it built before co-signing and sending
it. Once it confirms, the same queue that serves the kiosk opens the
position. This counts toward the daily limit; kiosk Earn doesn't (its notes
were already counted).
```

In the Solana `flowchart LR` diagram add one edge after `Q -->|Earn| T[treasury mUSD]`:

```
    W -->|web app: customer approves| T
```

and change `T -->|Finish| P[...]` to `T -->|Finish, or approved| P[...]` keeping the node text as is.

In the System flow `sequenceDiagram`, inside the final `alt` add a branch before `end`:

```
    else Solana Earn from held mUSD
        User->>API: POST /solana/earn/prepare (amount, tier)
        API-->>User: transfer to approve
        User->>Privy: approve in the Solana wallet
        User->>API: POST /solana/earn/submit (signed)
        API->>Sol: co-sign, send, confirm → open the position
```

- [ ] **Step 2: Render the diagrams** to check the Mermaid still parses:

```bash
mkdir -p /tmp/mmd && cd /tmp/mmd && python3 -c "
import re;s=open('$OLDPWD/README.md').read()
[open(f'd{i}.mmd','w').write(b) for i,b in enumerate(re.findall(r'\`\`\`mermaid\n(.*?)\`\`\`',s,re.S))]" && for f in d*.mmd; do npx -y @mermaid-js/mermaid-cli@11 -i $f -o ${f%.mmd}.svg >/dev/null && echo "$f ok"; done
```
(run from the repo root; use the session scratchpad instead of `/tmp` if one is available.) Expected: every file `ok`.

- [ ] **Step 3: Manual Privy check (needs a person in the browser).** With backend and frontend running, log in to `http://localhost:3000/login` with an email you can read, on an account that holds mUSD (do a Solana Hold visit at `/kiosk` with the test deposit first). Open **Solana**, enter an amount, pick a tier, tap **Earn**, approve in Privy. Expected: "Approved — your Meteora position is opening.", then the position shows `open` within a minute. Record the result (or that it was not done) in the final report.

- [ ] **Step 4: Commit** (main session)

```bash
git add README.md
git commit -m "README: Earn from held mUSD in the web app"
git push origin main
```

---

## Self-review

- **Spec coverage:** migration + statuses (T1), daily limit (T2), open by position (T3), queue + recovery (T4), build/check tx (T5), prepare/submit/sweep incl. 10-minute expiry and lost-job re-queue (T6), routes + startup (T7), Privy config + hook + proxies + types (T8), page/nav/card + funding label (T9), sol:flow with local keypair (T10), manual Privy check + docs (T11). The deliberate job-kind deviation is stated at the top.
- **Placeholders:** none; the two "check before relying" notes (CSS classes, `@solana/kit` resolution) name the exact fallback.
- **Types:** `createWebPosition`, `confirmFunding`, `fundingRows`, `webOpeningWithoutJob`, `openPosition`, `enqueueOpenPosition`, `recoveryJob`, `buildFundingTx`, `messageHash`, `unsignedBase64`, `checkSignedFunding`, `prepareWebEarn`, `submitWebEarn`, `resolveFunding`, `startFundingSweep`, `WebEarnPrepared`, `WebEarnSubmitted` are each defined once and used with the same signatures.
