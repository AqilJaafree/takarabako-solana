# Solana destination (Token-2022 mUSD + Meteora DLMM V2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove World ID, and let a kiosk customer send their cash either to the existing Ethereum vault or to Solana — holding a Token-2022 mock stablecoin (mUSD) or earning in a Meteora DLMM V2 position at a Low/Medium/High tier.

**Architecture:** The EVM stack is untouched. A new `backend/src/solana/` package holds the Solana client (sign → store signature → broadcast → confirm, so retries never double-send), the mUSD Token-2022 mint, a thin Meteora DLMM wrapper, and the customer-facing position lifecycle. Deposit sessions gain a `destination`; the existing BullMQ deposit worker routes each note to EVM or to an mUSD mint. A second BullMQ queue opens/closes DLMM positions. Positions are treasury-owned and tracked per customer in Postgres.

**Tech Stack:** Node 22 + Express + TypeScript, Postgres, BullMQ/Redis, `@solana/web3.js` v1, `@solana/spl-token`, `@solana/spl-token-metadata`, `@meteora-ag/dlmm` 1.9.x, `bs58`, Privy (`@privy-io/node`), Next.js frontend.

**Spec:** `docs/superpowers/specs/2026-10-10-solana-meteora-design.md`

**Repo:** `/home/wanaqil/Documents/Code/node/hackathon/takarabako-solana` (all paths below are relative to it).

**Commits:** the user's standing rule is *never commit without an explicit ask*. Every "Commit" step below is a checkpoint: ask the user once before the first commit whether per-task commits are OK; if not, skip all commit steps. Note this copy's `origin` is still the original repo — never push.

**Test command:** backend tests need Postgres + Redis (`cd backend && npm run services` or `docker compose up -d`). Run one file with
`cd backend && node --import tsx --test test/<file>.test.ts`; all with `npm test`. Typecheck with `npm run typecheck`.

---

## SDK facts this plan relies on (verified 2026-10-10 against `@meteora-ag/dlmm@1.9.14` typings and docs.meteora.ag)

- `DLMM.create(connection, pairPubkey, { cluster: "devnet" })`; DLMM program id is the same on devnet and mainnet: `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo`.
- `DLMM.createLbPair2(connection, funder, tokenX, tokenY, presetParameter2, activeId: BN, opt)` → `Transaction`; supports SPL Token and Token-2022. `DLMM.getAllPresetParameters(connection, opt)` → `{ presetParameter, presetParameter2 }` (each `ProgramAccount<{ binStep, baseFactor, ... }>`).
- `DLMM.getBinIdFromPrice(pricePerLamport, binStep, min)`.
- Instance: `pubkey`, `lbPair` (`activeId`, `binStep`), `tokenX`/`tokenY` (`TokenReserve` with `publicKey` = mint), `refetchStates()`, `getActiveBin()` → `BinLiquidity { binId, price, pricePerToken }`, `getPosition(pk)` → `LbPosition { positionData: { totalXAmount: string, totalYAmount: string, feeX: BN, feeY: BN, lowerBinId, upperBinId } }`, `initializePositionAndAddLiquidityByStrategy({ positionPubKey, totalXAmount, totalYAmount, strategy: { minBinId, maxBinId, strategyType, singleSidedX? }, user, slippage? })` → `Transaction` (position keypair must sign), `removeLiquidity({ user, position, fromBinId, toBinId, bps, shouldClaimAndClose, skipUnwrapSOL })` → `Transaction[]`, `getBinArrayForSwap(swapForY, count)`, `swapQuote(inAmount, swapForY, allowedSlippageBps: BN, binArrays)` → `{ consumedInAmount, outAmount, minOutAmount, binArraysPubkey }`, `swap({ inToken, outToken, inAmount, minOutAmount, lbPair, user, binArraysPubkey })` → `Transaction`.
- `StrategyType { Spot = 0, Curve = 1, BidAsk = 2 }`.
- Positions hold 70 bins by default (up to 1,400 with resizing). Tier widths 60/30/10 fit one default position.
- DLMM permissionless Token-2022 extensions include **MetadataPointer** and **TokenMetadata** — mUSD needs no token badge.
- Privy node SDK: `privy.users().pregenerateWallets(userId, { wallets: [{ chain_type: "solana" }] })`; linked wallet accounts carry `chain_type: "solana"`.

---

## File map

**Phase A — World ID removal**
- Delete: `backend/src/worldId.ts`, `backend/src/worldLogin.ts`, `backend/src/routes/loginWorld.ts`, `backend/src/routes/worldIdRoutes.ts`, `backend/scripts/world-staging.ts`, `backend/test/worldId.test.ts`, `backend/test/loginWorld.test.ts`, `backend/migrations/009_world_id.sql`
- Create: `backend/migrations/011_drop_world_id.sql`
- Modify: `backend/src/{config,limits,accounts,privy,depositLogin,accountsFlow,ensTransfers,index}.ts`, `backend/src/routes/{me,ensRoutes,depositSessions}.ts`, `backend/test/limits.test.ts`, `backend/package.json`
- Delete (frontend): `frontend/components/WorldSelfie.tsx`, `frontend/app/kiosk/WorldLogin.tsx`, `frontend/lib/useWorldProof.ts`, `frontend/app/(customer)/(authed)/verify/`, `frontend/app/api/worldid/`, `frontend/app/api/kiosk/login-world/`, `frontend/app/api/me/worldid/`
- Modify (frontend): `frontend/app/kiosk/KioskApp.tsx`, `frontend/app/(customer)/(authed)/Dashboard.tsx`, `frontend/app/(customer)/(authed)/send/{page,SendForm}.tsx`, `frontend/app/(customer)/login/LoginForm.tsx`, `frontend/lib/{types,kiosk}.ts`, `frontend/package.json`

**Phase B — Solana backend**
- Create: `backend/src/solana/client.ts` (RPC, treasury key, sign/broadcast/confirm), `backend/src/solana/musd.ts` (Token-2022 mUSD), `backend/src/solana/tiers.ts` (pure tier → bin range), `backend/src/solana/meteora.ts` (DLMM wrapper), `backend/src/solana/store.ts` (Postgres: destinations, positions, wallets), `backend/src/solana/wallets.ts` (Privy Solana wallet), `backend/src/solana/positions.ts` (open/close lifecycle), `backend/src/solana/jobs.ts` (BullMQ queue + sweep), `backend/src/solana/simulator.ts` (optional devnet swaps), `backend/src/routes/solanaRoutes.ts`, `backend/migrations/012_solana.sql`, `backend/scripts/sol-setup.ts`, `backend/scripts/sol-smoke.ts`
- Tests: `backend/test/solanaTiers.test.ts`, `backend/test/solanaStore.test.ts`, `backend/test/depositQueueSolana.test.ts`, `backend/test/solanaPositions.test.ts`
- Modify: `backend/src/{config,accounts,depositQueue,events,history,limits,privy,index}.ts`, `backend/src/routes/{depositSessions,dashboard}.ts`, `backend/package.json`, `backend/.env.example`

**Phase C — Frontend + docs**
- Create: `frontend/app/kiosk/DestinationPicker.tsx`, `frontend/app/api/kiosk/destination/route.ts`, `frontend/app/api/kiosk/solana/route.ts`, `frontend/app/api/solana/me/route.ts`, `frontend/app/api/solana/positions/[id]/close/route.ts`, `frontend/components/SolanaCard.tsx`
- Modify: `frontend/lib/{types,format,ops,opsTypes}.ts`, `frontend/app/kiosk/{KioskApp,DepositFlow}.tsx`, `frontend/app/(customer)/(authed)/Dashboard.tsx`, the History item renderer, `frontend/app/ops/OpsDashboard.tsx`, `DEPLOYMENTS.md`, `README.md`

---

# Phase A — Remove World ID

### Task 1: Backend — remove World ID

**Files:** see Phase A file map (backend).

- [ ] **Step 1: Update the limits test first (it encodes the new rule)**

In `backend/test/limits.test.ts`:
- Delete the four `process.env.WORLD_*` lines.
- Replace `process.env.UNVERIFIED_DAILY_LIMIT_USD = "1000";` with `process.env.DAILY_LIMIT_USD = "1000";`
- Replace the last test (`"a verified human has no limit"`) with:

```ts
test("the limit applies to every account and nothing lifts it", async () => {
  const a = await dailyAllowance(await carol());
  assert.equal(a.limited, true);
  await assert.rejects(assertWithinLimit(await carol(), 1_000_000), (err) => {
    assert.ok(err instanceof DailyLimitError);
    assert.doesNotMatch(err.message, /World ID/);
    return true;
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `cd backend && node --import tsx --test test/limits.test.ts`
Expected: FAIL — `dailyAllowance` returns `limited: false` because `worldIdReady` is false without WORLD_* env.

- [ ] **Step 3: Delete World ID files**

```bash
cd backend
git rm src/worldId.ts src/worldLogin.ts src/routes/loginWorld.ts src/routes/worldIdRoutes.ts scripts/world-staging.ts test/worldId.test.ts test/loginWorld.test.ts migrations/009_world_id.sql
npm uninstall @worldcoin/idkit-core
```

In `backend/package.json` delete the `"world:staging"` script line.

- [ ] **Step 4: Migration that drops the columns**

Create `backend/migrations/011_drop_world_id.sql` (009 is deleted, so on a fresh DB these are no-ops; on an existing DB they remove the old columns):

```sql
-- World ID was removed (spec 2026-10-10). Drop what 009_world_id.sql added.
drop index if exists accounts_world_nullifier;
alter table accounts drop column if exists world_nullifier;
alter table accounts drop column if exists world_credential;
alter table accounts drop column if exists world_verified_at;
```

- [ ] **Step 5: `config.ts`**

Delete the whole `worldId: { ... },` block and its comment. Replace

```ts
  // Customers who haven't verified with World ID can move this much a day
  // (deposits, withdrawals, yield, sends — limits.ts).
  unverifiedDailyLimitUsd: Number(process.env.UNVERIFIED_DAILY_LIMIT_USD ?? 1000),
```
with
```ts
  // Every customer can move this much a day (deposits, withdrawals, yield,
  // sends — limits.ts). UNVERIFIED_DAILY_LIMIT_USD is the old name.
  dailyLimitUsd: Number(process.env.DAILY_LIMIT_USD ?? process.env.UNVERIFIED_DAILY_LIMIT_USD ?? 1000),
```

- [ ] **Step 6: `limits.ts`**

Remove `import { worldIdReady } from "./worldId.js";`. Replace the header comment with:

```ts
/// Daily limit for every customer: everything they move in a day (UTC) —
/// cash deposited, withdrawals, yield positions opened, and anything sent by
/// name — adds up to at most DAILY_LIMIT_USD ($1,000).
```

Replace `dailyAllowance` and the `assertWithinLimit` message:

```ts
export async function dailyAllowance(account: Account): Promise<DailyAllowance> {
  const limitUsd = config.dailyLimitUsd;
  const usedUsd = await usedToday(account.privyUserId);
  return { limited: true, limitUsd, usedUsd, leftUsd: Math.max(0, limitUsd - usedUsd) };
}
```

```ts
  throw new DailyLimitError(
    `Accounts can move ${usd(a.limitUsd)} a day and you have ${usd(a.leftUsd)} left today, so ${what} (${usd(amountUsd)}) can't go through.`,
  );
```

- [ ] **Step 7: `accounts.ts`**

Remove `worldVerifiedAt` and `worldCredential` from `Account`, remove `,\n  world_verified_at as "worldVerifiedAt", world_credential as "worldCredential"` from `COLUMNS` (keep the preceding `qr_emailed_at as "qrEmailedAt"`), delete `findByWorldNullifier`, and change `insertAccount`'s parameter type to `Omit<Account, "qrEmailedAt">`.

- [ ] **Step 8: `privy.ts`**

- Remove `import { worldIdReady } from "./worldId.js";`.
- Replace the header comment block (lines starting `/// PRD §7.8 (revised)` down to `/// World ID bridge.`) with:

```ts
/// Privy is the identity layer: email in, a real embedded wallet and a
/// stable user id out — no phone, no QR, no bridge. One email → one Privy
/// user (`getByEmailAddress` before `create`).
```
- Replace
```ts
  // With World ID on, the gas gift waits until they verify as a unique human
  // (worldId.ts) — otherwise throwaway emails could farm Sepolia ETH.
  if (isNewUser && chainReady && !worldIdReady) {
```
with
```ts
  if (isNewUser && chainReady) {
```

- [ ] **Step 9: `depositLogin.ts`, `accountsFlow.ts`**

- `depositLogin.ts`: comment `/// Shared by the wallet-QR and World ID logins.` → `/// Used by the wallet-QR login.`; delete the `worldVerified: Boolean(account.worldVerifiedAt),` line.
- `accountsFlow.ts`: delete the `worldVerified: Boolean(account.worldVerifiedAt),` line.

- [ ] **Step 10: `ensTransfers.ts`**

Remove `verifiedHuman` from `Resolved`, and in `lookup`:

```ts
  const [kind, account, allowlisted] = await Promise.all([
    textRecord(clean, "takarabako.kind"),
    accountByWallet(r.address),
    cashReceiptReady ? mbCall<boolean>(ALIASES.tkcash, LABELS.cashReceipt, "allowlist", [r.address]).catch(() => null) : Promise.resolve(null),
  ]);
  return {
    name: clean,
    address: r.address,
    kind,
    customer: account ? { ensName: account.ensName } : null,
    tkcashAllowlisted: allowlisted,
  };
```

- [ ] **Step 11: Routes and server**

- `routes/me.ts`: delete the `worldId: { ... },` line in the `/me` response.
- `routes/ensRoutes.ts`: delete `import { isVerifiedHuman } from "../worldId.js";` and the `worldId: { ... },` line in `/me/wallet`.
- `routes/depositSessions.ts`: replace the 403 error string with
  `` `You've reached today's $${allowance.limitUsd.toLocaleString("en-US")} deposit limit. Come back tomorrow to deposit more.` ``
  and the route comment line `/// An unverified customer who has used today's limit can't start a new visit` with `/// A customer who has used today's limit can't start a new visit`.
- `index.ts`: delete both `loginWorldRouter` and `worldIdRouter` imports and their `app.use(...)` lines.

- [ ] **Step 12: Find leftovers**

Run: `cd backend && grep -rn -i "world" src scripts test package.json | grep -v -i "worldwide"`
Expected: no output. Fix anything that appears.

- [ ] **Step 13: Typecheck and test**

Run: `cd backend && npm run typecheck && npm test`
Expected: typecheck clean; all tests PASS (including the new limits test).

- [ ] **Step 14: Commit**

```bash
git add -A backend
git commit -m "Remove World ID; the daily limit now applies to every account"
```

### Task 2: Frontend — remove World ID

- [ ] **Step 1: Delete files and dependency**

```bash
cd frontend
git rm -r components/WorldSelfie.tsx app/kiosk/WorldLogin.tsx lib/useWorldProof.ts "app/(customer)/(authed)/verify" app/api/worldid app/api/kiosk/login-world app/api/me/worldid
grep -o '"@worldcoin/[a-z-]*"' package.json | tr -d '"' | xargs -r npm uninstall
```

- [ ] **Step 2: `lib/types.ts`**

- `Me`: delete the `worldId?: ...` line.
- Comment above `DailyLimit` → `/// What an account may still move today.`
- `MyWallet`: delete `worldId?: ...`.
- `KioskLogin`: delete `worldVerified: boolean;` and change the `limit` comment to `// what's left today`.
- The ENS lookup type at ~line 259: delete `verifiedHuman?: boolean;`.

- [ ] **Step 3: `lib/kiosk.ts`**

Delete `worldVerified?: boolean;` from `BackendLogin` and `worldVerified: login.worldVerified ?? false,` from the response body. Change the comment `// An unverified customer who has used today's limit: keep the slot closed.` → `// Today's limit is used: keep the slot closed.`

- [ ] **Step 4: `app/kiosk/KioskApp.tsx`**

- Delete `import { WorldLogin } from "./WorldLogin";`, the `loginVia` state, the `WorldIdIcon` function, and the World ID `choice-tile` button (lines ~415-419).
- Delete the login tab bar that switches `loginVia` (the `role="tab"` buttons near line 442) and the `{screen === "scan" && depositOnly && loginVia === "world" && (...)}` block.
- Change `{screen === "scan" && !(depositOnly && loginVia === "world") && (` → `{screen === "scan" && (`.
- In the QR `choice-tile` onClick, drop `setLoginVia("qr");`.
- Comment on line ~27: `a choice of login (deposit QR or World ID)` → `a deposit-QR login`.
- The limit line (~475): replace ` · verify with a World ID selfie in the app to lift it` with nothing (keep the `{usd(...)} of today's {usd(...)} left` text).

- [ ] **Step 5: Customer app**

- `Dashboard.tsx`: replace the `{me.worldId?.verified ? (...) : me.worldId ? (...) : null}` expression with
```tsx
          {me.limit?.leftUsd != null && <span className="human-badge is-pending">{usd(me.limit.leftUsd)} left today</span>}
```
  and remove `Link` from imports if now unused.
- `send/page.tsx`: delete the sentence containing `<Link href="/verify">Take a World ID selfie</Link> to lift the limit.` (keep the surrounding limit text; remove `Link` import if unused).
- `send/SendForm.tsx`: message → `` `Accounts can move ${usd(wallet.limit!.limitUsd, 0)} a day — ${usd(limitLeft)} left today.` ``; delete the `{r.verifiedHuman && <span className="pill ok">Verified human</span>}` line.
- `login/LoginForm.tsx`: the comment and redirect around line 42 send brand-new wallets to `/verify`; make every login go to My box (`/`). Change the comment to `// Everyone lands on My box.` and the redirect target to `"/"`.

- [ ] **Step 6: Find leftovers, typecheck, lint, build**

Run: `cd frontend && grep -rn -i "world id\|worldid\|/verify\|idkit\|worldVerified\|verifiedHuman" app components lib`
Expected: no output.
Run: `npx tsc --noEmit && npm run lint && npm run build`
Expected: all succeed.

- [ ] **Step 7: Commit**

```bash
git add -A frontend
git commit -m "Remove World ID from the kiosk and the customer app"
```

---

# Phase B — Solana backend

### Task 3: Dependencies, config, Solana client

**Files:** Modify `backend/package.json`, `backend/src/config.ts`, `backend/.env.example`; Create `backend/src/solana/client.ts`

- [ ] **Step 1: Install**

```bash
cd backend
npm i @solana/web3.js@^1 @solana/spl-token @solana/spl-token-metadata @meteora-ag/dlmm@^1.9.14 bn.js bs58
npm i -D @types/bn.js
```
Then check only one `@solana/web3.js` major is installed: `npm ls @solana/web3.js` — every entry must be `1.x`.

- [ ] **Step 2: Config**

In `backend/src/config.ts`, add before the closing `} as const;`:

```ts
  // Solana devnet (src/solana/): Token-2022 mUSD and the Meteora DLMM V2
  // mUSD/wSOL pair. Unset = Solana destinations are hidden at the kiosk.
  solana: {
    rpcUrl: process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com",
    treasuryKey: process.env.SOLANA_TREASURY_KEY ?? "", // base58 secret key
    musdMint: process.env.MUSD_MINT ?? "",
    dlmmPair: process.env.DLMM_PAIR ?? "",
    // Below this much SOL the treasury can't safely pay fees and rent:
    // Solana destinations are refused at visit start.
    minTreasurySol: Number(process.env.SOLANA_MIN_TREASURY_SOL ?? 0.5),
    priorityMicroLamports: Number(process.env.SOLANA_PRIORITY_MICROLAMPORTS ?? 10_000),
    // Starting price for sol:setup (mUSD per SOL).
    initialSolPriceUsd: Number(process.env.SOLANA_INITIAL_SOL_PRICE ?? 150),
    // Devnet market maker (solana/simulator.ts), off by default.
    simEnabled: process.env.SOL_SIM === "1",
    simIntervalMs: Number(process.env.SOL_SIM_INTERVAL_MS ?? 600_000),
  },
```

Append to `backend/.env.example`:

```
# Solana devnet (npm run sol:setup prints MUSD_MINT and DLMM_PAIR)
SOLANA_RPC_URL=https://api.devnet.solana.com
SOLANA_TREASURY_KEY=
MUSD_MINT=
DLMM_PAIR=
SOLANA_MIN_TREASURY_SOL=0.5
SOLANA_INITIAL_SOL_PRICE=150
SOL_SIM=0
DAILY_LIMIT_USD=1000
```

- [ ] **Step 3: Client**

Create `backend/src/solana/client.ts`:

```ts
import { ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, type Signer, type Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import { config } from "../config.js";

/// Solana devnet plumbing. Every write is signed first, its signature stored
/// by the caller, then broadcast — so a retry after a crash checks the stored
/// signature instead of sending a second transaction (same rule as the EVM
/// deposit queue's stored tx hash).

export const solanaReady = Boolean(config.solana.treasuryKey && config.solana.musdMint && config.solana.dlmmPair);

export const connection = new Connection(config.solana.rpcUrl, "confirmed");

let treasuryKp: Keypair | null = null;
export function treasury(): Keypair {
  if (!config.solana.treasuryKey) throw new Error("SOLANA_TREASURY_KEY is not set — see backend/.env.example");
  treasuryKp ??= Keypair.fromSecretKey(bs58.decode(config.solana.treasuryKey));
  return treasuryKp;
}

export interface SignedTx {
  signature: string;
  lastValidBlockHeight: number;
  raw: Buffer;
}

/// Sets a fresh blockhash, the treasury as fee payer and a priority fee (if
/// the builder didn't add a compute-budget instruction), then signs.
export async function signTx(tx: Transaction, signers: Signer[] = []): Promise<SignedTx> {
  const payer = treasury();
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = payer.publicKey;
  if (!tx.instructions.some((ix) => ix.programId.equals(ComputeBudgetProgram.programId))) {
    tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: config.solana.priorityMicroLamports }));
  }
  tx.sign(payer, ...signers);
  return { signature: bs58.encode(tx.signature!), lastValidBlockHeight, raw: tx.serialize() };
}

export async function broadcast(raw: Uint8Array): Promise<void> {
  await connection.sendRawTransaction(raw, { maxRetries: 5 });
}

export type Outcome = "confirmed" | "expired" | "failed";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/// Waits until the transaction is confirmed, has failed on-chain, or can no
/// longer land (its blockhash expired). "expired" and "failed" both mean it
/// is safe to build and send a new one.
export async function confirm(signature: string, lastValidBlockHeight: number, timeoutMs = 150_000): Promise<Outcome> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { value } = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
    const st = value[0];
    if (st?.err) {
      console.error(`[solana] ${signature} failed:`, JSON.stringify(st.err));
      return "failed";
    }
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return "confirmed";
    if ((await connection.getBlockHeight("confirmed")) > lastValidBlockHeight) {
      // One last look — it may have landed in the final valid block.
      const again = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
      if (again && !again.err && again.confirmationStatus !== "processed") return "confirmed";
      return "expired";
    }
    if (Date.now() > deadline) throw new Error(`transaction ${signature} still pending after ${timeoutMs / 1000}s`);
    await sleep(1_000);
  }
}

/// For steps that are idempotent by on-chain state (setup, removing
/// liquidity): sign, send, and throw unless confirmed.
export async function sendAndConfirm(tx: Transaction, signers: Signer[] = []): Promise<string> {
  const signed = await signTx(tx, signers);
  await broadcast(signed.raw);
  const outcome = await confirm(signed.signature, signed.lastValidBlockHeight);
  if (outcome !== "confirmed") throw new Error(`transaction ${signed.signature} ${outcome}`);
  return signed.signature;
}

export async function treasurySol(): Promise<number> {
  return (await connection.getBalance(treasury().publicKey, "confirmed")) / LAMPORTS_PER_SOL;
}

/// Ready *and* able to pay: what the kiosk checks before offering Solana.
export async function solanaAvailable(): Promise<{ ok: boolean; reason?: string }> {
  if (!solanaReady) return { ok: false, reason: "Solana is not configured" };
  const sol = await treasurySol().catch(() => -1);
  if (sol < 0) return { ok: false, reason: "Solana RPC unreachable" };
  if (sol < config.solana.minTreasurySol) return { ok: false, reason: `treasury has ${sol.toFixed(3)} SOL (needs ${config.solana.minTreasurySol})` };
  return { ok: true };
}

export const solscanTx = (sig: string) => `https://solscan.io/tx/${sig}?cluster=devnet`;
```

- [ ] **Step 4: Typecheck**

Run: `cd backend && npm run typecheck`
Expected: clean.

- [ ] **Step 5: Generate and fund a devnet treasury key (manual, one time)**

```bash
cd backend
node -e "const {Keypair}=require('@solana/web3.js');const bs58=require('bs58').default??require('bs58');const k=Keypair.generate();console.log('address',k.publicKey.toBase58());console.log('SOLANA_TREASURY_KEY='+bs58.encode(k.secretKey))"
```
Put `SOLANA_TREASURY_KEY` in `backend/.env` (gitignored — never print it in chat or commit it). Fund the printed address with devnet SOL (≥ 5 SOL — rent for bin arrays/positions + the seed position) from https://faucet.solana.com. Verify: `curl -s https://api.devnet.solana.com -X POST -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getBalance","params":["<address>"]}'` shows a non-zero `value`.

- [ ] **Step 6: Commit**

```bash
git add backend/package.json backend/package-lock.json backend/src/config.ts backend/.env.example backend/src/solana/client.ts
git commit -m "Add Solana devnet client and config"
```

### Task 4: Pure tier math (TDD)

**Files:** Create `backend/src/solana/tiers.ts`, `backend/test/solanaTiers.test.ts`

- [ ] **Step 1: Failing test**

Create `backend/test/solanaTiers.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { StrategyType } from "@meteora-ag/dlmm";
import { SOL_TIERS, tierRange, isSolTier, positionValueUsd } from "../src/solana/tiers.js";

test("tiers: Low wide Spot, Medium Curve, High narrow BidAsk", () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(SOL_TIERS).map(([k, t]) => [k, [t.strategy, t.width]])),
    { low: [StrategyType.Spot, 60], medium: [StrategyType.Curve, 30], high: [StrategyType.BidAsk, 10] },
  );
  for (const t of Object.values(SOL_TIERS)) assert.ok(t.width <= 70, "fits one default DLMM position");
});

test("mUSD as token Y sits in the bins just below the active bin", () => {
  assert.deepEqual(tierRange("high", 1000, false), { minBinId: 990, maxBinId: 999, strategyType: StrategyType.BidAsk, singleSidedX: false });
  assert.deepEqual(tierRange("low", -5, false), { minBinId: -65, maxBinId: -6, strategyType: StrategyType.Spot, singleSidedX: false });
});

test("mUSD as token X sits in the bins just above the active bin", () => {
  assert.deepEqual(tierRange("medium", 1000, true), { minBinId: 1001, maxBinId: 1030, strategyType: StrategyType.Curve, singleSidedX: true });
});

test("isSolTier", () => {
  assert.ok(isSolTier("low") && isSolTier("medium") && isSolTier("high"));
  assert.ok(!isSolTier("advanced") && !isSolTier(undefined));
});

test("value = mUSD + SOL × price, all raw amounts", () => {
  // 12.5 mUSD (6 dp) + 0.1 SOL (9 dp) at $150
  assert.equal(positionValueUsd(12_500_000n, 100_000_000n, 150), 27.5);
});
```

- [ ] **Step 2: Run — expect FAIL** (`Cannot find module '../src/solana/tiers.js'`)

Run: `cd backend && node --import tsx --test test/solanaTiers.test.ts`

- [ ] **Step 3: Implement**

Create `backend/src/solana/tiers.ts`:

```ts
import { StrategyType } from "@meteora-ag/dlmm";

/// The three Earn tiers, all on the one mUSD/wSOL DLMM pair. The customer's
/// mUSD goes in one-sided, in the bins right next to the price: it buys SOL
/// as the price moves into the range and earns swap fees while it does.
/// Narrower = more fees per dollar while in range, out of range sooner.

export type SolTier = "low" | "medium" | "high";

export const SOL_TIERS: Record<SolTier, { label: string; strategy: StrategyType; width: number; blurb: string }> = {
  low: { label: "Low", strategy: StrategyType.Spot, width: 60, blurb: "A wide, even ladder — earns slowly, rarely leaves its range." },
  medium: { label: "Medium", strategy: StrategyType.Curve, width: 30, blurb: "Concentrated near the price — more fees, moves out sooner." },
  high: { label: "High", strategy: StrategyType.BidAsk, width: 10, blurb: "A tight band right at the price — most fees, most movement." },
};

export const isSolTier = (v: unknown): v is SolTier => v === "low" || v === "medium" || v === "high";

/// Bin range for a one-sided mUSD deposit. Token-Y liquidity has to sit
/// below the active bin and token-X liquidity above it, so the side depends
/// on which token mUSD is in the pair.
export function tierRange(tier: SolTier, activeId: number, musdIsX: boolean) {
  const { strategy, width } = SOL_TIERS[tier];
  return musdIsX
    ? { minBinId: activeId + 1, maxBinId: activeId + width, strategyType: strategy, singleSidedX: true }
    : { minBinId: activeId - width, maxBinId: activeId - 1, strategyType: strategy, singleSidedX: false };
}

export const MUSD_DECIMALS = 6;
export const SOL_DECIMALS = 9;

/// USD value of raw mUSD + raw SOL at `solPriceUsd` (mUSD ≡ $1).
export function positionValueUsd(musdRaw: bigint, solRaw: bigint, solPriceUsd: number): number {
  const v = Number(musdRaw) / 10 ** MUSD_DECIMALS + (Number(solRaw) / 10 ** SOL_DECIMALS) * solPriceUsd;
  return Math.round(v * 1e6) / 1e6;
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `cd backend && node --import tsx --test test/solanaTiers.test.ts`

- [ ] **Step 5: Commit**

```bash
git add backend/src/solana/tiers.ts backend/test/solanaTiers.test.ts
git commit -m "Add Solana Earn tiers as DLMM range strategies"
```

### Task 5: Token-2022 mUSD

**Files:** Create `backend/src/solana/musd.ts`

- [ ] **Step 1: Implement**

```ts
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  ExtensionType,
  LENGTH_SIZE,
  TOKEN_2022_PROGRAM_ID,
  TYPE_SIZE,
  TokenAccountNotFoundError,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMetadataPointerInstruction,
  createInitializeMintInstruction,
  createMintToCheckedInstruction,
  createTransferCheckedInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  getMintLen,
} from "@solana/spl-token";
import { createInitializeInstruction, pack, type TokenMetadata } from "@solana/spl-token-metadata";
import { config } from "../config.js";
import { connection, sendAndConfirm, treasury } from "./client.js";
import { MUSD_DECIMALS } from "./tiers.js";

/// mUSD: a Token-2022 mock stablecoin on devnet. The treasury is the mint
/// authority and mints 1 mUSD per USD of cash accepted. Only MetadataPointer
/// + TokenMetadata — both on Meteora DLMM's permissionless allowlist, so the
/// pair needs no token badge. No freeze authority.

export const toRaw = (usd: number) => BigInt(Math.round(usd * 10 ** MUSD_DECIMALS));
export const fromRaw = (raw: bigint) => Number(raw) / 10 ** MUSD_DECIMALS;

export const musdMint = () => new PublicKey(config.solana.musdMint);
export const musdAta = (owner: PublicKey) => getAssociatedTokenAddressSync(musdMint(), owner, true, TOKEN_2022_PROGRAM_ID);

/// Mint `usd` worth of mUSD to `owner` (creating their token account if needed).
export function mintToTx(owner: PublicKey, usd: number): Transaction {
  const authority = treasury().publicKey;
  const mint = musdMint();
  const dest = musdAta(owner);
  return new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(authority, dest, owner, mint, TOKEN_2022_PROGRAM_ID),
    createMintToCheckedInstruction(mint, dest, authority, toRaw(usd), MUSD_DECIMALS, [], TOKEN_2022_PROGRAM_ID),
  );
}

/// Move `raw` mUSD from the treasury to `owner`.
export function transferFromTreasuryTx(owner: PublicKey, raw: bigint): Transaction {
  const from = treasury().publicKey;
  const mint = musdMint();
  const dest = musdAta(owner);
  return new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(from, dest, owner, mint, TOKEN_2022_PROGRAM_ID),
    createTransferCheckedInstruction(musdAta(from), mint, dest, from, raw, MUSD_DECIMALS, [], TOKEN_2022_PROGRAM_ID),
  );
}

export async function balanceRaw(owner: PublicKey): Promise<bigint> {
  try {
    return (await getAccount(connection, musdAta(owner), "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
  } catch (err) {
    if (err instanceof TokenAccountNotFoundError) return 0n;
    throw err;
  }
}

export async function supplyRaw(): Promise<bigint> {
  return (await getMint(connection, musdMint(), "confirmed", TOKEN_2022_PROGRAM_ID)).supply;
}

/// One-time (scripts/sol-setup.ts): create the mint with on-mint metadata.
export async function createMusdMint(): Promise<{ mint: PublicKey; signature: string }> {
  const authority = treasury().publicKey;
  const mintKp = Keypair.generate();
  const mint = mintKp.publicKey;
  const metadata: TokenMetadata = {
    mint,
    name: "Takarabako Mock USD",
    symbol: "mUSD",
    uri: "",
    updateAuthority: authority,
    additionalMetadata: [],
  };
  const mintLen = getMintLen([ExtensionType.MetadataPointer]);
  const metadataLen = TYPE_SIZE + LENGTH_SIZE + pack(metadata).length;
  const lamports = await connection.getMinimumBalanceForRentExemption(mintLen + metadataLen);
  const tx = new Transaction().add(
    SystemProgram.createAccount({ fromPubkey: authority, newAccountPubkey: mint, space: mintLen, lamports, programId: TOKEN_2022_PROGRAM_ID }),
    createInitializeMetadataPointerInstruction(mint, authority, mint, TOKEN_2022_PROGRAM_ID),
    createInitializeMintInstruction(mint, MUSD_DECIMALS, authority, null, TOKEN_2022_PROGRAM_ID),
    createInitializeInstruction({
      programId: TOKEN_2022_PROGRAM_ID,
      mint,
      metadata: mint,
      name: metadata.name,
      symbol: metadata.symbol,
      uri: metadata.uri,
      mintAuthority: authority,
      updateAuthority: authority,
    }),
  );
  const signature = await sendAndConfirm(tx, [mintKp]);
  return { mint, signature };
}
```

- [ ] **Step 2: Typecheck**

Run: `cd backend && npm run typecheck` — expected clean.

- [ ] **Step 3: Commit**

```bash
git add backend/src/solana/musd.ts
git commit -m "Add Token-2022 mUSD mint helpers"
```

### Task 6: Meteora DLMM wrapper

**Files:** Create `backend/src/solana/meteora.ts`

- [ ] **Step 1: Implement**

```ts
import DLMM from "@meteora-ag/dlmm";
import { Keypair, PublicKey } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import BN from "bn.js";
import { config } from "../config.js";
import { connection, sendAndConfirm, signTx, treasury, type SignedTx } from "./client.js";
import { musdMint } from "./musd.js";
import { SOL_TIERS, tierRange, type SolTier } from "./tiers.js";

/// The one mUSD/wSOL DLMM V2 pair. Every position is owned by the treasury;
/// solana/positions.ts tracks whose it is.

const OPT = { cluster: "devnet" as const };
let cached: DLMM | null = null;

export async function pair(): Promise<DLMM> {
  cached ??= await DLMM.create(connection, new PublicKey(config.solana.dlmmPair), OPT);
  await cached.refetchStates(); // always quote from current state
  return cached;
}

export interface PoolState {
  pair: string;
  activeId: number;
  binStep: number;
  musdIsX: boolean;
  solPriceUsd: number; // mUSD per SOL at the active bin
}

export async function poolState(): Promise<PoolState> {
  const p = await pair();
  const active = await p.getActiveBin();
  const musdIsX = p.tokenX.publicKey.equals(musdMint());
  const yPerX = Number(active.pricePerToken); // UI units: token Y per token X
  return { pair: p.pubkey.toBase58(), activeId: active.binId, binStep: p.lbPair.binStep, musdIsX, solPriceUsd: musdIsX ? 1 / yPerX : yPerX };
}

/// Signs (doesn't send) a new one-sided mUSD position for `tier`.
export async function prepareOpen(tier: SolTier, musdRaw: bigint) {
  const p = await pair();
  const st = await poolState();
  const range = tierRange(tier, st.activeId, st.musdIsX);
  const position = Keypair.generate();
  const amount = new BN(musdRaw.toString());
  const tx = await p.initializePositionAndAddLiquidityByStrategy({
    positionPubKey: position.publicKey,
    user: treasury().publicKey,
    totalXAmount: st.musdIsX ? amount : new BN(0),
    totalYAmount: st.musdIsX ? new BN(0) : amount,
    strategy: { minBinId: range.minBinId, maxBinId: range.maxBinId, strategyType: SOL_TIERS[tier].strategy, singleSidedX: range.singleSidedX },
    slippage: 1, // %
  });
  const signed: SignedTx = await signTx(tx, [position]);
  return { signed, position: position.publicKey.toBase58(), minBinId: range.minBinId, maxBinId: range.maxBinId };
}

export interface PositionAmounts {
  musdRaw: bigint; // liquidity + unclaimed fees
  solRaw: bigint;
  feesMusdRaw: bigint;
  feesSolRaw: bigint;
  lowerBinId: number;
  upperBinId: number;
}

const big = (v: string | BN) => BigInt(typeof v === "string" ? Math.floor(Number(v)).toString() : v.toString());

export async function positionAmounts(position: string): Promise<PositionAmounts> {
  const p = await pair();
  const { positionData: d } = await p.getPosition(new PublicKey(position));
  const musdIsX = p.tokenX.publicKey.equals(musdMint());
  const [x, y, fx, fy] = [big(d.totalXAmount), big(d.totalYAmount), big(d.feeX), big(d.feeY)];
  return musdIsX
    ? { musdRaw: x + fx, solRaw: y + fy, feesMusdRaw: fx, feesSolRaw: fy, lowerBinId: d.lowerBinId, upperBinId: d.upperBinId }
    : { musdRaw: y + fy, solRaw: x + fx, feesMusdRaw: fy, feesSolRaw: fx, lowerBinId: d.lowerBinId, upperBinId: d.upperBinId };
}

export async function positionExists(position: string): Promise<boolean> {
  return (await connection.getAccountInfo(new PublicKey(position), "confirmed")) !== null;
}

/// Removes all liquidity, claims fees and closes the position. SOL comes
/// back unwrapped into the treasury's native balance.
export async function removeAll(position: string, lowerBinId: number, upperBinId: number): Promise<string[]> {
  const p = await pair();
  const txs = await p.removeLiquidity({
    user: treasury().publicKey,
    position: new PublicKey(position),
    fromBinId: lowerBinId,
    toBinId: upperBinId,
    bps: new BN(10_000),
    shouldClaimAndClose: true,
  });
  const sigs: string[] = [];
  for (const tx of txs) sigs.push(await sendAndConfirm(tx));
  return sigs;
}

/// Signs (doesn't send) a swap of `solRaw` SOL into mUSD through the pair.
/// `outRaw` is the quote's minimum — what the treasury is sure to receive.
export async function prepareSwapSolToMusd(solRaw: bigint): Promise<{ signed: SignedTx; outRaw: bigint }> {
  const p = await pair();
  const musdIsX = p.tokenX.publicKey.equals(musdMint());
  const swapForY = !musdIsX; // SOL is X → swapping X for Y
  const binArrays = await p.getBinArrayForSwap(swapForY, 4);
  const quote = p.swapQuote(new BN(solRaw.toString()), swapForY, new BN(100), binArrays); // 1% slippage
  const tx = await p.swap({
    inToken: NATIVE_MINT,
    outToken: musdMint(),
    inAmount: quote.consumedInAmount,
    minOutAmount: quote.minOutAmount,
    lbPair: p.pubkey,
    user: treasury().publicKey,
    binArraysPubkey: quote.binArraysPubkey,
  });
  return { signed: await signTx(tx), outRaw: BigInt(quote.minOutAmount.toString()) };
}

/// Devnet only (simulator, setup): swap mUSD → SOL.
export async function swapMusdToSol(musdRaw: bigint): Promise<string> {
  const p = await pair();
  const musdIsX = p.tokenX.publicKey.equals(musdMint());
  const swapForY = musdIsX;
  const binArrays = await p.getBinArrayForSwap(swapForY, 4);
  const quote = p.swapQuote(new BN(musdRaw.toString()), swapForY, new BN(100), binArrays);
  const tx = await p.swap({
    inToken: musdMint(),
    outToken: NATIVE_MINT,
    inAmount: quote.consumedInAmount,
    minOutAmount: quote.minOutAmount,
    lbPair: p.pubkey,
    user: treasury().publicKey,
    binArraysPubkey: quote.binArraysPubkey,
  });
  return sendAndConfirm(tx);
}

export { DLMM, OPT as DLMM_OPT };
```

- [ ] **Step 2: Typecheck**

Run: `cd backend && npm run typecheck`
Expected: clean. If `import DLMM from "@meteora-ag/dlmm"` fails under the project's module settings, use `import dlmmPkg from "@meteora-ag/dlmm"; const DLMM = dlmmPkg.default ?? dlmmPkg;` and `type DLMM = InstanceType<typeof DLMM>` — check with a one-line `tsx -e` import before changing.

- [ ] **Step 3: Commit**

```bash
git add backend/src/solana/meteora.ts
git commit -m "Add Meteora DLMM V2 wrapper for the mUSD/wSOL pair"
```

### Task 7: Devnet setup script (mint, pair, seed)

**Files:** Create `backend/scripts/sol-setup.ts`; Modify `backend/package.json`

- [ ] **Step 1: Script**

```ts
// Creates (idempotently) the devnet mUSD mint and the mUSD/wSOL DLMM V2 pair,
// and seeds a two-sided treasury position so the pair has a live price.
//   cd backend && npm run sol:setup
import DLMM, { StrategyType } from "@meteora-ag/dlmm";
import { Keypair, PublicKey } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, getMint, getMetadataPointerState } from "@solana/spl-token";
import BN from "bn.js";
import { config } from "../src/config.js";
import { connection, sendAndConfirm, treasury, treasurySol } from "../src/solana/client.js";
import { createMusdMint, mintToTx } from "../src/solana/musd.js";

const OPT = { cluster: "devnet" as const };
const t = treasury();
console.log("treasury", t.publicKey.toBase58(), `${(await treasurySol()).toFixed(3)} SOL`);

// 1. mint
let mint = config.solana.musdMint ? new PublicKey(config.solana.musdMint) : null;
if (!mint) {
  const created = await createMusdMint();
  mint = created.mint;
  console.log("created mUSD mint", mint.toBase58(), "tx", created.signature);
}
const mintInfo = await getMint(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
console.log("mUSD decimals", mintInfo.decimals, "metadata pointer", getMetadataPointerState(mintInfo)?.metadataAddress?.toBase58());
process.env.MUSD_MINT = mint.toBase58();
(config.solana as { musdMint: string }).musdMint = mint.toBase58();

// 2. pair — X = wSOL, Y = mUSD, so the price is mUSD per SOL
let pairKey = config.solana.dlmmPair ? new PublicKey(config.solana.dlmmPair) : null;
if (!pairKey) {
  const { presetParameter2 } = await DLMM.getAllPresetParameters(connection, OPT);
  // Prefer bin step 10 (0.1%) — fine-grained enough for a stable/SOL pair.
  const preset = presetParameter2.find((p) => p.account.binStep === 10) ?? presetParameter2.sort((a, b) => a.account.binStep - b.account.binStep)[0];
  if (!preset) throw new Error("no PresetParameter2 on devnet");
  const pricePerLamport = config.solana.initialSolPriceUsd * 10 ** (mintInfo.decimals - 9);
  const activeId = new BN(DLMM.getBinIdFromPrice(pricePerLamport, preset.account.binStep, true));
  const tx = await DLMM.createLbPair2(connection, t.publicKey, NATIVE_MINT, mint, preset.publicKey, activeId, OPT);
  const sig = await sendAndConfirm(tx);
  // Find the pair we just created.
  const pairs = await DLMM.getLbPairs(connection, OPT);
  const mine = pairs.find((p) => p.account.tokenXMint.equals(NATIVE_MINT) && p.account.tokenYMint.equals(mint!) && p.account.binStep === preset.account.binStep);
  if (!mine) throw new Error(`pair created (tx ${sig}) but not found — look it up on Solscan and set DLMM_PAIR`);
  pairKey = mine.publicKey;
  console.log("created DLMM pair", pairKey.toBase58(), "bin step", preset.account.binStep, "tx", sig);
}

// 3. seed: 0.5 SOL above and the matching mUSD below the price, spot shape.
const pool = await DLMM.create(connection, pairKey, OPT);
const { userPositions } = await pool.getPositionsByUserAndLbPair(t.publicKey);
if (userPositions.length === 0) {
  const active = await pool.getActiveBin();
  const seedSol = new BN(500_000_000); // 0.5 SOL
  const seedMusdUsd = 0.5 * config.solana.initialSolPriceUsd;
  await sendAndConfirm(mintToTx(t.publicKey, seedMusdUsd));
  const position = Keypair.generate();
  const tx = await pool.initializePositionAndAddLiquidityByStrategy({
    positionPubKey: position.publicKey,
    user: t.publicKey,
    totalXAmount: seedSol,
    totalYAmount: new BN(Math.round(seedMusdUsd * 1e6)),
    strategy: { minBinId: active.binId - 30, maxBinId: active.binId + 30, strategyType: StrategyType.Spot },
    slippage: 1,
  });
  const sig = await sendAndConfirm(tx, [position]);
  console.log("seeded position", position.publicKey.toBase58(), "tx", sig);
}

await pool.refetchStates();
const active = await pool.getActiveBin();
console.log("\nactive bin", active.binId, "price", active.pricePerToken, "mUSD/SOL");
console.log("\nPut these in backend/.env:");
console.log(`MUSD_MINT=${mint.toBase58()}`);
console.log(`DLMM_PAIR=${pairKey.toBase58()}`);
```

Add to `backend/package.json` scripts: `"sol:setup": "tsx --env-file=.env scripts/sol-setup.ts",`

- [ ] **Step 2: Run on devnet**

Run: `cd backend && npm run sol:setup`
Expected: prints mint, pair, seed position, active bin with price ≈ 150, and the two `.env` lines. Copy them into `backend/.env`. Re-run once: it must skip creation and only print state (idempotent).

- [ ] **Step 3: Verify independently (don't trust the script's own output)**

- `https://solscan.io/token/<MUSD_MINT>?cluster=devnet` → program is Token-2022, extensions MetadataPointer + TokenMetadata only, name "Takarabako Mock USD", mint authority = treasury, no freeze authority.
- `https://solscan.io/account/<DLMM_PAIR>?cluster=devnet` → owner program `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo`.
- Re-read the pair with a fresh `DLMM.create` in `tsx -e` and assert `tokenX.publicKey` = `So11111111111111111111111111111111111111112`, `tokenY.publicKey` = mUSD, active bin has non-zero `xAmount` or `yAmount`.

Record the results for Task 18 (DEPLOYMENTS.md).

- [ ] **Step 4: Commit**

```bash
git add backend/scripts/sol-setup.ts backend/package.json
git commit -m "Add sol:setup — mUSD mint, DLMM V2 pair and seed liquidity"
```

### Task 8: Migration + Solana store (TDD)

**Files:** Create `backend/migrations/012_solana.sql`, `backend/src/solana/store.ts`, `backend/test/solanaStore.test.ts`; Modify `backend/src/accounts.ts`, `backend/test/helpers.ts`

- [ ] **Step 1: Migration**

Create `backend/migrations/012_solana.sql`:

```sql
-- Solana destination (spec 2026-10-10). Idempotent: runs at every startup.
alter table accounts add column if not exists solana_wallet text;
create unique index if not exists accounts_solana_wallet on accounts (solana_wallet) where solana_wallet is not null;

alter table deposit_sessions add column if not exists destination text not null default 'evm';
alter table deposit_sessions add column if not exists tier text;
do $$ begin
  alter table deposit_sessions add constraint deposit_sessions_destination_check
    check (destination in ('evm', 'sol_hold', 'sol_earn')
           and (destination <> 'sol_earn' or tier in ('low', 'medium', 'high')));
exception when duplicate_object then null; end $$;

-- A Solana deposit keeps its signature in tx_hash; sol_valid_height says
-- until when that signed transaction could still land.
alter table deposits add column if not exists chain text not null default 'evm';
alter table deposits add column if not exists sol_valid_height bigint;

-- Earn opens are recorded with chain 'sol' and left out of the daily limit:
-- the notes behind them were already counted as deposits.
alter table yield_events add column if not exists chain text not null default 'evm';

create table if not exists solana_positions (
  id                  uuid primary key,
  privy_user_id       text not null references accounts on delete cascade,
  session_id          uuid unique references deposit_sessions on delete set null,
  tier                text not null check (tier in ('low', 'medium', 'high')),
  pair                text not null,
  status              text not null default 'opening' check (status in ('opening', 'open', 'closing', 'closed', 'failed')),
  musd_in             numeric not null,
  position_pubkey     text,
  min_bin_id          int,
  max_bin_id          int,
  open_sig            text,
  open_valid_height   bigint,
  musd_out_raw        numeric,
  sol_out_raw         numeric,
  removed_at          timestamptz,
  swap_sig            text,
  swap_valid_height   bigint,
  swap_out_raw        numeric,
  swap_confirmed_at   timestamptz,
  payout_sig          text,
  payout_valid_height bigint,
  value_out           numeric,
  error               text,
  created_at          timestamptz not null default now(),
  opened_at           timestamptz,
  closed_at           timestamptz
);
create index if not exists solana_positions_user on solana_positions (privy_user_id, created_at desc);
```

- [ ] **Step 2: Accounts gets `solanaWallet`, deposits get `chain`**

In `backend/src/accounts.ts`:
- `Account`: add `solanaWallet: string | null; // Privy Solana embedded wallet (solana/wallets.ts)`.
- `COLUMNS`: append `, solana_wallet as "solanaWallet"`.
- `insertAccount` parameter type: `Omit<Account, "qrEmailedAt" | "solanaWallet">`.
- `DepositRow`: add `chain: "evm" | "sol";` and `solValidHeight: number | null;`.
- `DEPOSIT_COLUMNS`: append `, chain, sol_valid_height::float as "solValidHeight"`.
- Add:

```ts
/// Solana mint: the signed transaction's signature and expiry height are
/// stored before broadcasting, so a retry checks it instead of minting twice.
export async function markDepositSendingSol(id: string, signature: string, usdAmount: number, validHeight: number) {
  await pool.query(
    `update deposits set status = 'sending', chain = 'sol', tx_hash = $2, usd_amount = $3, sol_valid_height = $4,
       attempts = attempts + 1, updated_at = now()
     where id = $1`,
    [id, signature, usdAmount, validHeight],
  );
}

/// The stored Solana transaction expired or failed on-chain: forget it so the
/// next attempt signs a new one.
export async function clearDepositSend(id: string) {
  await pool.query("update deposits set status = 'queued', tx_hash = null, sol_valid_height = null, updated_at = now() where id = $1", [id]);
}

export async function setSolanaWallet(privyUserId: string, address: string) {
  await pool.query("update accounts set solana_wallet = $2 where privy_user_id = $1", [privyUserId, address]);
}
```

In `backend/test/helpers.ts` change the truncate to `"truncate accounts, sessions, deposits, solana_positions cascade"`.

- [ ] **Step 3: Failing store test**

Create `backend/test/solanaStore.test.ts`:

```ts
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
```

- [ ] **Step 4: Run — expect FAIL** (module not found)

Run: `cd backend && node --import tsx --test test/solanaStore.test.ts`

- [ ] **Step 5: Implement `backend/src/solana/store.ts`**

```ts
import { pool } from "../db.js";
import { isSolTier, type SolTier } from "./tiers.js";

/// Postgres side of the Solana destination: where a visit's cash goes, and
/// the Earn positions opened from it.

export type Destination = "evm" | "sol_hold" | "sol_earn";
export interface SessionDestination {
  destination: Destination;
  tier: SolTier | null;
}

const DESTINATIONS: Destination[] = ["evm", "sol_hold", "sol_earn"];

/// Validates a request body; null if invalid. Earn needs a tier, the others must not have one.
export function parseDestination(body: unknown): SessionDestination | null {
  const b = (body ?? {}) as { destination?: unknown; tier?: unknown };
  const destination = DESTINATIONS.find((d) => d === b.destination);
  if (!destination) return null;
  if (destination === "sol_earn") return isSolTier(b.tier) ? { destination, tier: b.tier } : null;
  return b.tier === undefined || b.tier === null ? { destination, tier: null } : null;
}

export async function sessionDestination(sessionId: string | null): Promise<SessionDestination> {
  if (!sessionId) return { destination: "evm", tier: null };
  const { rows } = await pool.query("select destination, tier from deposit_sessions where id = $1", [sessionId]);
  return rows[0] ?? { destination: "evm", tier: null };
}

/// Only the session's owner, only while it's open, only before its first note.
export async function setSessionDestination(
  sessionId: string,
  privyUserId: string,
  destination: Destination,
  tier: SolTier | null,
): Promise<"ok" | "not_found" | "locked"> {
  const { rowCount } = await pool.query(
    `update deposit_sessions set destination = $3, tier = $4
     where id = $1 and privy_user_id = $2 and status = 'open'
       and not exists (select 1 from deposits where session_id = $1)`,
    [sessionId, privyUserId, destination, tier],
  );
  if (rowCount === 1) return "ok";
  const { rows } = await pool.query("select 1 from deposit_sessions where id = $1 and privy_user_id = $2 and status = 'open'", [sessionId, privyUserId]);
  return rows.length ? "locked" : "not_found";
}

/// USD of confirmed Solana notes in a session.
export async function sessionSolTotal(sessionId: string | null): Promise<number> {
  if (!sessionId) return 0;
  const { rows } = await pool.query<{ total: string }>(
    "select coalesce(sum(usd_amount), 0) as total from deposits where session_id = $1 and chain = 'sol' and status = 'confirmed'",
    [sessionId],
  );
  return Number(rows[0]?.total ?? 0);
}

/// Every note in the session has confirmed or failed.
export async function sessionSettled(sessionId: string): Promise<boolean> {
  const { rows } = await pool.query("select 1 from deposits where session_id = $1 and status in ('queued', 'sending') limit 1", [sessionId]);
  return rows.length === 0;
}

// ---- positions ---------------------------------------------------------

export type PositionStatus = "opening" | "open" | "closing" | "closed" | "failed";

export interface SolPositionRow {
  id: string;
  privyUserId: string;
  sessionId: string | null;
  tier: SolTier;
  pair: string;
  status: PositionStatus;
  musdIn: number;
  positionPubkey: string | null;
  minBinId: number | null;
  maxBinId: number | null;
  openSig: string | null;
  openValidHeight: number | null;
  musdOutRaw: string | null; // raw integer strings (bigint-safe)
  solOutRaw: string | null;
  removedAt: Date | null;
  swapSig: string | null;
  swapValidHeight: number | null;
  swapOutRaw: string | null;
  swapConfirmedAt: Date | null;
  payoutSig: string | null;
  payoutValidHeight: number | null;
  valueOut: number | null;
  error: string | null;
  createdAt: Date;
  openedAt: Date | null;
  closedAt: Date | null;
}

const FIELDS: Record<keyof SolPositionRow, string> = {
  id: "id",
  privyUserId: "privy_user_id",
  sessionId: "session_id",
  tier: "tier",
  pair: "pair",
  status: "status",
  musdIn: "musd_in",
  positionPubkey: "position_pubkey",
  minBinId: "min_bin_id",
  maxBinId: "max_bin_id",
  openSig: "open_sig",
  openValidHeight: "open_valid_height",
  musdOutRaw: "musd_out_raw",
  solOutRaw: "sol_out_raw",
  removedAt: "removed_at",
  swapSig: "swap_sig",
  swapValidHeight: "swap_valid_height",
  swapOutRaw: "swap_out_raw",
  swapConfirmedAt: "swap_confirmed_at",
  payoutSig: "payout_sig",
  payoutValidHeight: "payout_valid_height",
  valueOut: "value_out",
  error: "error",
  createdAt: "created_at",
  openedAt: "opened_at",
  closedAt: "closed_at",
};
const NUMERIC = new Set(["musd_in", "value_out", "open_valid_height", "swap_valid_height", "payout_valid_height"]);
const RAW = new Set(["musd_out_raw", "sol_out_raw", "swap_out_raw"]);
const POSITION_COLUMNS = Object.entries(FIELDS)
  .map(([k, col]) => (NUMERIC.has(col) ? `${col}::float as "${k}"` : RAW.has(col) ? `${col}::text as "${k}"` : `${col} as "${k}"`))
  .join(", ");

export async function getPosition(id: string): Promise<SolPositionRow | null> {
  const { rows } = await pool.query(`select ${POSITION_COLUMNS} from solana_positions where id = $1`, [id]);
  return rows[0] ?? null;
}

export async function positionForSession(sessionId: string): Promise<SolPositionRow | null> {
  const { rows } = await pool.query(`select ${POSITION_COLUMNS} from solana_positions where session_id = $1`, [sessionId]);
  return rows[0] ?? null;
}

export async function listPositions(privyUserId: string): Promise<SolPositionRow[]> {
  const { rows } = await pool.query(`select ${POSITION_COLUMNS} from solana_positions where privy_user_id = $1 order by created_at desc`, [privyUserId]);
  return rows;
}

export async function listLivePositions(): Promise<SolPositionRow[]> {
  const { rows } = await pool.query(`select ${POSITION_COLUMNS} from solana_positions where status in ('opening', 'open', 'closing')`);
  return rows;
}

/// Creates the Earn position row for a session from its confirmed Solana
/// notes — once (session_id is unique). Null if there's nothing to invest.
export async function createPositionForSession(sessionId: string, pair: string): Promise<SolPositionRow | null> {
  const existing = await positionForSession(sessionId);
  if (existing) return existing;
  const { rows: s } = await pool.query("select privy_user_id as \"privyUserId\", destination, tier from deposit_sessions where id = $1", [sessionId]);
  const session = s[0] as { privyUserId: string; destination: Destination; tier: SolTier | null } | undefined;
  if (!session || session.destination !== "sol_earn" || !session.tier) return null;
  const total = await sessionSolTotal(sessionId);
  if (total <= 0) return null;
  await pool.query(
    `insert into solana_positions (id, privy_user_id, session_id, tier, pair, musd_in)
     values ($1, $2, $3, $4, $5, $6) on conflict (session_id) do nothing`,
    [crypto.randomUUID(), session.privyUserId, sessionId, session.tier, pair, total],
  );
  return positionForSession(sessionId);
}

/// Writes the given fields (camelCase keys of SolPositionRow).
export async function updatePosition(id: string, patch: Partial<Omit<SolPositionRow, "id">>): Promise<void> {
  const keys = Object.keys(patch) as (keyof SolPositionRow)[];
  if (!keys.length) return;
  const sets = keys.map((k, i) => `${FIELDS[k]} = $${i + 2}`);
  await pool.query(`update solana_positions set ${sets.join(", ")} where id = $1`, [id, ...keys.map((k) => patch[k] ?? null)]);
}

/// Earn sessions that are over (finished, or abandoned for 30 min) with
/// confirmed Solana notes but no position yet — the sweep opens them.
export async function earnSessionsWithoutPosition(): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(
    `select s.id from deposit_sessions s
     where s.destination = 'sol_earn'
       and (s.status = 'finished' or s.started_at < now() - interval '30 minutes')
       and not exists (select 1 from solana_positions p where p.session_id = s.id)
       and exists (select 1 from deposits d where d.session_id = s.id and d.chain = 'sol' and d.status = 'confirmed')`,
  );
  return rows.map((r) => r.id);
}
```

- [ ] **Step 6: Run — expect PASS**

Run: `cd backend && node --import tsx --test test/solanaStore.test.ts`
Then the whole suite: `npm test` — all PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/migrations/012_solana.sql backend/src/solana/store.ts backend/src/accounts.ts backend/test/solanaStore.test.ts backend/test/helpers.ts
git commit -m "Add Solana destination and position tables"
```

### Task 9: Privy Solana wallet

**Files:** Modify `backend/src/privy.ts`; Create `backend/src/solana/wallets.ts`

- [ ] **Step 1: Privy helper**

In `backend/src/privy.ts`, below `findEthereumWallet`:

```ts
function findSolanaWallet(linkedAccounts: LinkedAccount[]): string | undefined {
  const wallet = linkedAccounts.find((a) => a.type === "wallet" && a.chain_type === "solana");
  return wallet && "address" in wallet ? wallet.address : undefined;
}

/// The user's Privy Solana embedded wallet, created on first use.
export async function ensureSolanaWallet(privyUserId: string): Promise<string> {
  let user = await privy.users()._get(privyUserId);
  let address = findSolanaWallet(user.linked_accounts);
  if (!address) {
    user = await privy.users().pregenerateWallets(privyUserId, { wallets: [{ chain_type: "solana" }] });
    address = findSolanaWallet(user.linked_accounts);
  }
  if (!address) throw new Error(`Privy user ${privyUserId} has no solana embedded wallet`);
  return address;
}
```

- [ ] **Step 2: Cached lookup**

Create `backend/src/solana/wallets.ts`:

```ts
import { setSolanaWallet, type Account } from "../accounts.js";
import { ensureSolanaWallet } from "../privy.js";

/// The customer's Solana wallet address, from the account row or created
/// through Privy the first time (then stored).
export async function solanaWalletFor(account: Account): Promise<string> {
  if (account.solanaWallet) return account.solanaWallet;
  const address = await ensureSolanaWallet(account.privyUserId);
  await setSolanaWallet(account.privyUserId, address);
  return address;
}
```

- [ ] **Step 3: Typecheck**

Run: `cd backend && npm run typecheck`. If `pregenerateWallets` rejects `chain_type: "solana"` at the type level, open `node_modules/@privy-io/node/resources/users/users.d.mts`, find the `pregenerateWallets` params type, and use the exact solana variant it declares.

- [ ] **Step 4: Live check (one real Privy call)**

```bash
cd backend && npx tsx --env-file=.env -e "import('./src/privy.ts').then(async m => { const u = process.argv[1]; console.log(await m.ensureSolanaWallet(u)); console.log(await m.ensureSolanaWallet(u)); })" <an existing test privy user id from the DB>
```
Expected: the same base58 address printed twice (second call doesn't create another).

- [ ] **Step 5: Commit**

```bash
git add backend/src/privy.ts backend/src/solana/wallets.ts
git commit -m "Create Privy Solana wallets on first Solana deposit"
```

### Task 10: Route deposits to Solana (TDD)

**Files:** Modify `backend/src/depositQueue.ts`, `backend/src/events.ts`; Create `backend/test/depositQueueSolana.test.ts`

- [ ] **Step 1: Failing test**

Create `backend/test/depositQueueSolana.test.ts`:

```ts
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.js";

const pool = await freshDb();
const accounts = await import("../src/accounts.js");
const history = await import("../src/history.js");
const store = await import("../src/solana/store.js");
const { processDeposit } = await import("../src/depositQueue.js");
after(() => pool.end());

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
```

- [ ] **Step 2: Run — expect FAIL** (deps.sol ignored → EVM path runs)

Run: `cd backend && node --import tsx --test test/depositQueueSolana.test.ts`

- [ ] **Step 3: Event type**

In `backend/src/events.ts`, in the `deposit.confirmed` variant add `chain?: "evm" | "sol";`. Also add to the `UserEvent` union:

```ts
  | { type: "solana.position.opened"; positionId: string; tier: string; amountUsd: number; signature: string }
  | { type: "solana.position.closed"; positionId: string; valueUsd: number; signature: string }
  | { type: "solana.position.failed"; positionId: string; error: string }
```

- [ ] **Step 4: Implement routing in `depositQueue.ts`**

Add imports:

```ts
import { PublicKey } from "@solana/web3.js";
import { clearDepositSend, markDepositSendingSol, type Account, type DepositRow } from "./accounts.js";
import { broadcast, confirm, signTx, treasury, type Outcome, type SignedTx } from "./solana/client.js";
import { balanceRaw, fromRaw, mintToTx } from "./solana/musd.js";
import { sessionDestination, sessionSolTotal, type SessionDestination } from "./solana/store.js";
import { solanaWalletFor } from "./solana/wallets.js";
```
(merge the `accounts.js` import with the existing one).

Extend the deps:

```ts
export interface SolDeps {
  owner: (account: Account, destination: "sol_hold" | "sol_earn") => Promise<string>;
  signMint: (owner: string, usdAmount: number) => Promise<SignedTx>;
  broadcast: (raw: Uint8Array) => Promise<void>;
  confirm: (signature: string, lastValidBlockHeight: number) => Promise<Outcome>;
  balance: (owner: string) => Promise<number>;
}

export interface ProcessDeps {
  toUsd: (amount: number, currency: "USD" | "MYR") => Promise<{ usdAmount: number; rate: number; source: string }>;
  send: (user: Address, usdAmount: number) => Promise<`0x${string}`>;
  wait: (hash: `0x${string}`, user: Address) => Promise<number>;
  publish: (privyUserId: string, event: UserEvent) => Promise<void>;
  destination?: (sessionId: string | null) => Promise<SessionDestination>;
  sol?: SolDeps;
}

const liveSol: SolDeps = {
  owner: async (account, destination) => (destination === "sol_hold" ? solanaWalletFor(account) : treasury().publicKey.toBase58()),
  signMint: (owner, usd) => signTx(mintToTx(new PublicKey(owner), usd)),
  broadcast,
  confirm,
  balance: async (owner) => fromRaw(await balanceRaw(new PublicKey(owner))),
};

const liveDeps: ProcessDeps = { toUsd, send: sendDepositTx, wait: waitForDepositTx, publish: publishUserEvent, destination: sessionDestination, sol: liveSol };
```

Replace `processDeposit` with:

```ts
export async function processDeposit(depositId: string, deps: ProcessDeps = liveDeps) {
  const row = await getDeposit(depositId);
  if (!row || row.status === "confirmed" || row.status === "failed") return;
  const account = await findByPrivyUserId(row.privyUserId);
  if (!account) throw new Error(`deposit ${depositId}: account missing`);
  const { destination } = await (deps.destination ?? sessionDestination)(row.sessionId);
  if (destination === "evm" && row.chain !== "sol") return processEvm(row, account, deps);
  return processSol(row, account, destination === "evm" ? "sol_hold" : destination, deps);
}

async function processEvm(row: DepositRow, account: Account, deps: ProcessDeps) {
  const user = account.boundAddress as Address;
  let hash = row.txHash as `0x${string}` | null;
  let usdAmount = row.usdAmount ?? 0;
  let rate = row.amount > 0 ? usdAmount / row.amount : 1;
  if (!hash) {
    const fx = await deps.toUsd(row.amount, row.currency as "USD" | "MYR");
    usdAmount = fx.usdAmount;
    rate = fx.rate;
    hash = await deps.send(user, usdAmount);
    await markDepositSending(row.id, hash, usdAmount); // stored before waiting
  }
  const balance = await deps.wait(hash, user);
  await markDepositConfirmed(row.id);
  await deps.publish(row.privyUserId, {
    type: "deposit.confirmed", depositId: row.id, amount: row.amount, currency: row.currency,
    usdAmount, fxRate: rate, txHash: hash, balance, chain: "evm",
  });
  await afterConfirmed(row, account, usdAmount, deps);
}

/// Solana: mint mUSD — to the customer's wallet (Hold) or to the treasury,
/// to be invested when the visit ends (Earn). Signed → stored → broadcast.
async function processSol(row: DepositRow, account: Account, destination: "sol_hold" | "sol_earn", deps: ProcessDeps) {
  const sol = deps.sol ?? liveSol;
  const owner = await sol.owner(account, destination);
  let usdAmount = row.usdAmount ?? 0;
  let rate = row.amount > 0 ? usdAmount / row.amount : 1;
  let signature = row.txHash;
  let validHeight = row.solValidHeight;
  if (!signature || validHeight == null) {
    const fx = await deps.toUsd(row.amount, row.currency as "USD" | "MYR");
    usdAmount = fx.usdAmount;
    rate = fx.rate;
    const signed = await sol.signMint(owner, usdAmount);
    await markDepositSendingSol(row.id, signed.signature, usdAmount, signed.lastValidBlockHeight); // stored before sending
    signature = signed.signature;
    validHeight = signed.lastValidBlockHeight;
    await sol.broadcast(signed.raw);
  }
  const outcome = await sol.confirm(signature, validHeight);
  if (outcome !== "confirmed") {
    await clearDepositSend(row.id);
    throw new Error(`mUSD mint ${signature} ${outcome} — sending a new one`);
  }
  await markDepositConfirmed(row.id);
  const balance = destination === "sol_hold" ? await sol.balance(owner) : await sessionSolTotal(row.sessionId);
  await deps.publish(row.privyUserId, {
    type: "deposit.confirmed", depositId: row.id, amount: row.amount, currency: row.currency,
    usdAmount, fxRate: rate, txHash: signature, balance, chain: "sol",
  });
  await afterConfirmed(row, account, usdAmount, deps);
}

/// Receipt email and tkCASH — the same for every destination: the note is in the box.
async function afterConfirmed(row: DepositRow, account: Account, usdAmount: number, deps: ProcessDeps) {
  if (row.sessionId) await sendReceiptIfDone(row.sessionId);
  // tkCASH: the note is now in the box, so mint its receipt token. In the
  // background — it must never hold up or fail a deposit that went through.
  void recordCashIn({ depositId: row.id, wallet: account.privyWallet, usdAmount, denomination: row.amount, currency: row.currency })
    .then(async (txHash) => {
      if (txHash) await deps.publish(row.privyUserId, { type: "tkcash.minted", depositId: row.id, amount: usdAmount, txHash });
    })
    .catch((err) => console.error(`[tkcash] cash-in for deposit ${row.id}:`, err instanceof Error ? err.message : err));
}
```

Note: existing tests pass deps without `destination`/`sol`; the default `sessionDestination` returns `evm` for their sessionless deposits, so they keep exercising the EVM path. But they also don't stub `recordCashIn` — unchanged from before.

- [ ] **Step 5: Run both deposit test files — expect PASS**

Run: `cd backend && node --import tsx --test test/depositQueueSolana.test.ts test/depositQueue.test.ts`

- [ ] **Step 6: Commit**

```bash
git add backend/src/depositQueue.ts backend/src/events.ts backend/test/depositQueueSolana.test.ts
git commit -m "Route deposits to Solana: mint mUSD per note for Hold and Earn"
```

### Task 11: Position lifecycle (TDD)

**Files:** Create `backend/src/solana/positions.ts`, `backend/test/solanaPositions.test.ts`; Modify `backend/src/history.ts`, `backend/src/limits.ts`

- [ ] **Step 1: History + limits accept `chain`**

`backend/src/history.ts`:
- `recordYieldEvent` param gets `chain?: "evm" | "sol";`, insert becomes
```ts
    `insert into yield_events (id, privy_user_id, action, risk_tier, pair, apy_bps, amount_usd, rationale, ens_name, tx_hash, chain)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [crypto.randomUUID(), y.privyUserId, y.action, y.riskTier, y.pair, y.apyBps, y.amountUsd, y.rationale, y.ensName, y.txHash, y.chain ?? "evm"],
```
- The `yield` `HistoryItem` variant and the `listHistory` yield select: add `chain` (`chain: "evm" | "sol";` and `, chain` in the select list after `tx_hash as "txHash"`).
- `ReceiptNote`: add `chain: "evm" | "sol";` and add `chain` to `NOTE_COLUMNS` (after `status,`).
- `Receipt`: add
```ts
  destination: "evm" | "sol_hold" | "sol_earn";
  tier: string | null;
  solPosition: { id: string; status: string; openSig: string | null } | null; // Earn only
```
  In `getReceipt` and the `listHistory` session query select `s.destination, s.tier` (and `destination, tier` in `getReceipt`), and change `buildReceipt` to take `solPosition` as a third argument (default `null`) and spread it in. In `getReceipt`, fetch it:
```ts
  const { rows: pos } = await pool.query(
    `select id, status, open_sig as "openSig" from solana_positions where session_id = $1`,
    [id],
  );
  return buildReceipt(sessions[0], notes, pos[0] ?? null);
```

`backend/src/limits.ts` — in `usedToday`, change the yield line to:
```sql
     + (select coalesce(sum(amount_usd), 0) from yield_events where privy_user_id = $1 and action = 'open' and chain = 'evm' and created_at >= $2)
```

Run `npm test` — the history and limits tests must still PASS.

- [ ] **Step 2: Failing lifecycle test**

Create `backend/test/solanaPositions.test.ts`:

```ts
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.js";

const pool = await freshDb();
const accounts = await import("../src/accounts.js");
const history = await import("../src/history.js");
const store = await import("../src/solana/store.js");
const { openForSession, closePosition } = await import("../src/solana/positions.js");
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
  second.deps.positionExists = async () => false;
  await closePosition(opened.id, second.deps);
  assert.equal(second.calls.removed, 0);
  assert.equal(second.calls.swapped.length, 0);
  assert.equal(second.calls.paid.length, 1);
  assert.equal((await store.getPosition(opened.id))?.status, "closed");
});
```

- [ ] **Step 3: Run — expect FAIL** (module not found)

Run: `cd backend && node --import tsx --test test/solanaPositions.test.ts`

- [ ] **Step 4: Implement `backend/src/solana/positions.ts`**

```ts
import { PublicKey } from "@solana/web3.js";
import { findByPrivyUserId } from "../accounts.js";
import { config } from "../config.js";
import { publishUserEvent, type UserEvent } from "../events.js";
import { recordYieldEvent } from "../history.js";
import { broadcast, confirm, signTx, type Outcome, type SignedTx } from "./client.js";
import * as meteora from "./meteora.js";
import { transferFromTreasuryTx, fromRaw, toRaw } from "./musd.js";
import { createPositionForSession, getPosition, positionForSession, sessionSettled, updatePosition, type SolPositionRow } from "./store.js";
import { SOL_TIERS, positionValueUsd, type SolTier } from "./tiers.js";
import { solanaWalletFor } from "./wallets.js";

/// Earn positions, step by step. Every on-chain step either checks chain
/// state first (remove) or stores its signed transaction before sending
/// (open, swap, payout), so a job retried after any failure picks up where
/// it stopped and never pays twice.

export interface PositionDeps {
  pairAddress: () => string;
  prepareOpen: (tier: SolTier, musdRaw: bigint) => Promise<{ signed: SignedTx; position: string; minBinId: number; maxBinId: number }>;
  positionAmounts: (position: string) => Promise<meteora.PositionAmounts>;
  positionExists: (position: string) => Promise<boolean>;
  removeAll: (position: string, lowerBinId: number, upperBinId: number) => Promise<string[]>;
  prepareSwap: (solRaw: bigint) => Promise<{ signed: SignedTx; outRaw: bigint }>;
  signPayout: (owner: string, raw: bigint) => Promise<SignedTx>;
  broadcast: (raw: Uint8Array) => Promise<void>;
  confirm: (signature: string, lastValidBlockHeight: number) => Promise<Outcome>;
  solPriceUsd: () => Promise<number>;
  publish: (privyUserId: string, event: UserEvent) => Promise<void>;
}

export const liveDeps: PositionDeps = {
  pairAddress: () => config.solana.dlmmPair,
  prepareOpen: meteora.prepareOpen,
  positionAmounts: meteora.positionAmounts,
  positionExists: meteora.positionExists,
  removeAll: meteora.removeAll,
  prepareSwap: meteora.prepareSwapSolToMusd,
  signPayout: (owner, raw) => signTx(transferFromTreasuryTx(new PublicKey(owner), raw)),
  broadcast,
  confirm,
  solPriceUsd: async () => (await meteora.poolState()).solPriceUsd,
  publish: publishUserEvent,
};

const pairLabel = (tier: SolTier) => `mUSD/SOL · ${SOL_TIERS[tier].label}`;

/// Opens the Earn position for a finished session (idempotent).
export async function openForSession(sessionId: string, d: PositionDeps = liveDeps): Promise<SolPositionRow | null> {
  if (!(await sessionSettled(sessionId))) throw new Error(`session ${sessionId}: notes still settling`);
  let row = await createPositionForSession(sessionId, d.pairAddress());
  if (!row || row.status !== "opening") return row;

  if (row.openSig && row.openValidHeight != null) {
    const outcome = await d.confirm(row.openSig, row.openValidHeight);
    if (outcome !== "confirmed") {
      await updatePosition(row.id, { openSig: null, openValidHeight: null, positionPubkey: null, minBinId: null, maxBinId: null });
      throw new Error(`position open ${row.openSig} ${outcome} — opening again`);
    }
  } else {
    const prepared = await d.prepareOpen(row.tier, toRaw(row.musdIn));
    await updatePosition(row.id, {
      positionPubkey: prepared.position,
      minBinId: prepared.minBinId,
      maxBinId: prepared.maxBinId,
      openSig: prepared.signed.signature,
      openValidHeight: prepared.signed.lastValidBlockHeight,
    });
    await d.broadcast(prepared.signed.raw);
    const outcome = await d.confirm(prepared.signed.signature, prepared.signed.lastValidBlockHeight);
    if (outcome !== "confirmed") {
      await updatePosition(row.id, { openSig: null, openValidHeight: null, positionPubkey: null, minBinId: null, maxBinId: null });
      throw new Error(`position open ${prepared.signed.signature} ${outcome} — opening again`);
    }
  }

  await updatePosition(row.id, { status: "open", openedAt: new Date(), error: null });
  row = (await getPosition(row.id))!;
  await recordYieldEvent({
    privyUserId: row.privyUserId, action: "open", riskTier: row.tier, pair: pairLabel(row.tier),
    apyBps: null, amountUsd: row.musdIn, rationale: null, ensName: null, txHash: row.openSig, chain: "sol",
  });
  await d.publish(row.privyUserId, { type: "solana.position.opened", positionId: row.id, tier: row.tier, amountUsd: row.musdIn, signature: row.openSig! });
  return row;
}

/// Closes a position the customer asked to close (status 'closing').
export async function closePosition(id: string, d: PositionDeps = liveDeps): Promise<SolPositionRow | null> {
  let row = await getPosition(id);
  if (!row || row.status !== "closing" || !row.positionPubkey) return row;
  const account = await findByPrivyUserId(row.privyUserId);
  if (!account) throw new Error(`position ${id}: account missing`);

  // 1. Take everything out of the pair (amounts recorded first).
  if (!row.removedAt) {
    if (row.musdOutRaw == null) {
      const a = await d.positionAmounts(row.positionPubkey);
      await updatePosition(id, { musdOutRaw: a.musdRaw.toString(), solOutRaw: a.solRaw.toString() });
    }
    if (await d.positionExists(row.positionPubkey)) await d.removeAll(row.positionPubkey, row.minBinId!, row.maxBinId!);
    await updatePosition(id, { removedAt: new Date() });
    row = (await getPosition(id))!;
  }

  // 2. Swap the SOL side back to mUSD.
  const solOut = BigInt(row.solOutRaw ?? "0");
  if (solOut > 0n && !row.swapConfirmedAt) {
    if (!row.swapSig || row.swapValidHeight == null) {
      const { signed, outRaw } = await d.prepareSwap(solOut);
      await updatePosition(id, { swapSig: signed.signature, swapValidHeight: signed.lastValidBlockHeight, swapOutRaw: outRaw.toString() });
      await d.broadcast(signed.raw);
      row = (await getPosition(id))!;
    }
    const outcome = await d.confirm(row.swapSig!, row.swapValidHeight!);
    if (outcome !== "confirmed") {
      await updatePosition(id, { swapSig: null, swapValidHeight: null, swapOutRaw: null });
      throw new Error(`swap ${row.swapSig} ${outcome} — swapping again`);
    }
    await updatePosition(id, { swapConfirmedAt: new Date() });
    row = (await getPosition(id))!;
  }

  // 3. Pay the customer.
  const payoutRaw = BigInt(row.musdOutRaw ?? "0") + BigInt(row.swapOutRaw ?? "0");
  const wallet = await solanaWalletFor(account);
  if (!row.payoutSig || row.payoutValidHeight == null) {
    const signed = await d.signPayout(wallet, payoutRaw);
    await updatePosition(id, { payoutSig: signed.signature, payoutValidHeight: signed.lastValidBlockHeight });
    await d.broadcast(signed.raw);
    row = (await getPosition(id))!;
  }
  const outcome = await d.confirm(row.payoutSig!, row.payoutValidHeight!);
  if (outcome !== "confirmed") {
    await updatePosition(id, { payoutSig: null, payoutValidHeight: null });
    throw new Error(`payout ${row.payoutSig} ${outcome} — paying again`);
  }

  const valueOut = fromRaw(payoutRaw);
  await updatePosition(id, { status: "closed", valueOut, closedAt: new Date(), error: null });
  await recordYieldEvent({
    privyUserId: row.privyUserId, action: "close", riskTier: row.tier, pair: pairLabel(row.tier),
    apyBps: null, amountUsd: valueOut, rationale: null, ensName: null, txHash: row.payoutSig, chain: "sol",
  });
  await d.publish(row.privyUserId, { type: "solana.position.closed", positionId: id, valueUsd: valueOut, signature: row.payoutSig! });
  return getPosition(id);
}

export interface PositionView {
  id: string;
  tier: SolTier;
  label: string;
  status: SolPositionRow["status"];
  musdIn: number;
  valueUsd: number | null;
  feesUsd: number | null;
  inRange: boolean | null;
  minBinId: number | null;
  maxBinId: number | null;
  openSig: string | null;
  payoutSig: string | null;
  valueOut: number | null;
  createdAt: Date;
}

/// What the customer sees: live value for open positions, final value for closed ones.
export async function viewPosition(row: SolPositionRow, d: Pick<PositionDeps, "positionAmounts" | "solPriceUsd"> = liveDeps): Promise<PositionView> {
  let valueUsd: number | null = null;
  let feesUsd: number | null = null;
  let inRange: boolean | null = null;
  if (row.status === "open" && row.positionPubkey) {
    try {
      const [a, price, state] = await Promise.all([d.positionAmounts(row.positionPubkey), d.solPriceUsd(), meteora.poolState()]);
      valueUsd = positionValueUsd(a.musdRaw, a.solRaw, price);
      feesUsd = positionValueUsd(a.feesMusdRaw, a.feesSolRaw, price);
      inRange = state.activeId >= a.lowerBinId && state.activeId <= a.upperBinId;
    } catch (err) {
      console.error(`[solana] view ${row.id}:`, err instanceof Error ? err.message : err);
    }
  }
  return {
    id: row.id, tier: row.tier, label: pairLabel(row.tier), status: row.status, musdIn: row.musdIn,
    valueUsd: row.status === "closed" ? row.valueOut : valueUsd, feesUsd, inRange,
    minBinId: row.minBinId, maxBinId: row.maxBinId, openSig: row.openSig, payoutSig: row.payoutSig,
    valueOut: row.valueOut, createdAt: row.createdAt,
  };
}

export { positionForSession };
```

- [ ] **Step 5: Run — expect PASS**

Run: `cd backend && node --import tsx --test test/solanaPositions.test.ts` then `npm test`.

- [ ] **Step 6: Commit**

```bash
git add backend/src/solana/positions.ts backend/test/solanaPositions.test.ts backend/src/history.ts backend/src/limits.ts
git commit -m "Open and close Meteora Earn positions step by step"
```

### Task 12: Position queue, sweep, and simulator

**Files:** Create `backend/src/solana/jobs.ts`, `backend/src/solana/simulator.ts`

- [ ] **Step 1: Queue**

Create `backend/src/solana/jobs.ts`:

```ts
import { Queue, Worker, type Job } from "bullmq";
import { newRedisConnection } from "../redis.js";
import { publishUserEvent } from "../events.js";
import { solanaReady } from "./client.js";
import { closePosition, openForSession } from "./positions.js";
import { earnSessionsWithoutPosition, getPosition, positionForSession, updatePosition } from "./store.js";

/// Earn positions are opened and closed by this queue, one job at a time
/// (the treasury signs everything, so serialising keeps its balances simple).
const QUEUE_NAME = "solana-positions";
const ATTEMPTS = 8;

type JobData = { kind: "open"; sessionId: string } | { kind: "close"; positionId: string };

let queue: Queue<JobData> | null = null;
function positionsQueue() {
  queue ??= new Queue<JobData>(QUEUE_NAME, {
    connection: newRedisConnection(),
    defaultJobOptions: { attempts: ATTEMPTS, backoff: { type: "exponential", delay: 5_000 }, removeOnComplete: 1000, removeOnFail: false },
  });
  return queue;
}

export async function enqueueOpen(sessionId: string) {
  await positionsQueue().add("open", { kind: "open", sessionId }, { jobId: `open-${sessionId}` });
}

export async function enqueueClose(positionId: string) {
  // A new jobId per request so a customer can retry a close that failed for good.
  await positionsQueue().add("close", { kind: "close", positionId }, { jobId: `close-${positionId}-${Date.now()}` });
}

async function run(job: Job<JobData>) {
  if (job.data.kind === "open") await openForSession(job.data.sessionId);
  else await closePosition(job.data.positionId);
}

async function markFailed(job: Job<JobData>, err: Error) {
  const row = job.data.kind === "open" ? await positionForSession(job.data.sessionId) : await getPosition(job.data.positionId);
  if (!row) return;
  // A failed open stays retryable by the sweep; a failed close goes back to 'open' so the customer can try again.
  await updatePosition(row.id, { error: err.message, ...(job.data.kind === "close" ? { status: "open" as const } : { status: "failed" as const }) });
  await publishUserEvent(row.privyUserId, { type: "solana.position.failed", positionId: row.id, error: err.message });
}

export function startSolanaWorker() {
  if (!solanaReady) return null;
  const worker = new Worker<JobData>(QUEUE_NAME, run, { connection: newRedisConnection(), concurrency: 1 });
  worker.on("failed", async (job, err) => {
    if (!job) return;
    console.error(`[solana] ${job.name} attempt ${job.attemptsMade}/${ATTEMPTS} failed: ${err.message}`);
    if (job.attemptsMade >= ATTEMPTS) await markFailed(job, err).catch((e) => console.error("[solana] markFailed:", e));
  });
  worker.on("error", (err) => console.error("[solana] worker error:", err.message));

  // Sweep: Earn sessions the customer walked away from (never tapped Finish).
  const sweep = async () => {
    for (const sessionId of await earnSessionsWithoutPosition()) await enqueueOpen(sessionId).catch(() => {});
  };
  void sweep().catch((e) => console.error("[solana] sweep:", e));
  setInterval(() => void sweep().catch((e) => console.error("[solana] sweep:", e)), 10 * 60_000).unref();
  return worker;
}
```

Note: with `jobId: open-<sessionId>`, BullMQ ignores a duplicate add while the job exists. A failed-for-good open (status `failed`) is not retried by the sweep (it has a row). That's deliberate: ops sees it on `/ops` (Task 15); a retry is `enqueueOpen` after `updatePosition(id, { status: "opening" })` and removing the failed job — documented in the ops card.

- [ ] **Step 2: Simulator (optional devnet fees)**

Create `backend/src/solana/simulator.ts`:

```ts
import { config } from "../config.js";
import { broadcast, confirm, sendAndConfirm, solanaReady, treasury } from "./client.js";
import { mintToTx, toRaw } from "./musd.js";
import { prepareSwapSolToMusd, swapMusdToSol, poolState } from "./meteora.js";

/// Devnet market maker: nobody trades on devnet, so Earn positions would
/// never earn. With SOL_SIM=1 the treasury swaps a little mUSD → SOL and
/// back every interval, so positions near the price collect fees.
export function startSolanaSimulator() {
  if (!solanaReady || !config.solana.simEnabled) return;
  const tick = async () => {
    const usd = 25;
    await sendAndConfirm(mintToTx(treasury().publicKey, usd));
    await swapMusdToSol(toRaw(usd));
    const { solPriceUsd } = await poolState();
    const solRaw = BigInt(Math.floor((usd / solPriceUsd) * 0.98 * 1e9));
    const { signed } = await prepareSwapSolToMusd(solRaw);
    await broadcast(signed.raw);
    await confirm(signed.signature, signed.lastValidBlockHeight);
  };
  setInterval(() => void tick().catch((e) => console.error("[solana-sim]", e instanceof Error ? e.message : e)), config.solana.simIntervalMs).unref();
}
```

- [ ] **Step 3: Typecheck** — `cd backend && npm run typecheck`.

- [ ] **Step 4: Commit**

```bash
git add backend/src/solana/jobs.ts backend/src/solana/simulator.ts
git commit -m "Add the Solana positions queue, abandoned-session sweep and devnet simulator"
```

### Task 13: HTTP routes and wiring

**Files:** Create `backend/src/routes/solanaRoutes.ts`; Modify `backend/src/routes/depositSessions.ts`, `backend/src/index.ts`

- [ ] **Step 1: Destination + finish in `depositSessions.ts`**

Add imports:
```ts
import { parseDestination, setSessionDestination, sessionDestination } from "../solana/store.js";
import { solanaAvailable } from "../solana/client.js";
import { solanaWalletFor } from "../solana/wallets.js";
import { enqueueOpen } from "../solana/jobs.js";
```

Add the route after `POST /deposit-sessions`:

```ts
/// POST /deposit-sessions/:id/destination { destination, tier? } — where this
/// visit's cash goes. Allowed until the first note; Solana needs a funded
/// treasury and creates the customer's Solana wallet on first use.
depositSessionsRouter.post("/deposit-sessions/:id/destination", requireSession("deposit"), asyncHandler(async (req, res) => {
  const choice = parseDestination(req.body);
  if (!choice) {
    res.status(400).json({ error: "destination must be evm, sol_hold, or sol_earn with tier low|medium|high" });
    return;
  }
  const session: Session = res.locals.session;
  if (choice.destination !== "evm") {
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
    await solanaWalletFor(account);
  }
  const result = await setSessionDestination(String(req.params.id), session.privyUserId, choice.destination, choice.tier);
  if (result === "not_found") {
    res.status(404).json({ error: "deposit session not found" });
    return;
  }
  if (result === "locked") {
    res.status(409).json({ error: "notes are already in — the destination can't change now", code: "destination_locked" });
    return;
  }
  res.json({ ok: true, ...choice });
}));
```

In the finish route, after `await finishDepositSession(id);` add:

```ts
  if ((await sessionDestination(id)).destination === "sol_earn") {
    await enqueueOpen(id).catch((err) => console.error(`[solana] could not queue the position for ${id}:`, err));
  }
```

- [ ] **Step 2: `routes/solanaRoutes.ts`**

```ts
import { Router } from "express";
import { PublicKey } from "@solana/web3.js";
import { asyncHandler } from "../asyncHandler.js";
import { config } from "../config.js";
import { requireSession, type Session } from "../sessions.js";
import { findByPrivyUserId } from "../accounts.js";
import { solanaAvailable, solanaReady, treasurySol, treasury } from "../solana/client.js";
import { balanceRaw, fromRaw, supplyRaw } from "../solana/musd.js";
import { poolState } from "../solana/meteora.js";
import { SOL_TIERS } from "../solana/tiers.js";
import { getPosition, listLivePositions, listPositions, updatePosition } from "../solana/store.js";
import { viewPosition } from "../solana/positions.js";
import { enqueueClose } from "../solana/jobs.js";

export const solanaRouter = Router();

const tiers = () => Object.entries(SOL_TIERS).map(([id, t]) => ({ id, label: t.label, blurb: t.blurb, width: t.width }));

/// GET /solana/status — public: can the kiosk offer Solana, and the tiers.
solanaRouter.get("/solana/status", asyncHandler(async (_req, res) => {
  const available = await solanaAvailable();
  const pool = available.ok ? await poolState().catch(() => null) : null;
  res.json({ ready: available.ok && Boolean(pool), reason: available.reason ?? null, pool, tiers: tiers() });
}));

/// GET /solana/me — the customer's Solana wallet, mUSD balance and positions.
solanaRouter.get("/solana/me", requireSession("full"), asyncHandler(async (_req, res) => {
  const session: Session = res.locals.session;
  const account = await findByPrivyUserId(session.privyUserId);
  if (!account) {
    res.status(404).json({ error: "unknown account" });
    return;
  }
  if (!solanaReady) {
    res.json({ ready: false, wallet: account.solanaWallet, musd: null, positions: [] });
    return;
  }
  const musd = account.solanaWallet ? fromRaw(await balanceRaw(new PublicKey(account.solanaWallet))) : 0;
  const rows = await listPositions(account.privyUserId);
  res.json({ ready: true, wallet: account.solanaWallet, musd, positions: await Promise.all(rows.map((r) => viewPosition(r))) });
}));

/// POST /solana/positions/:id/close — queue the close; the result arrives on the live stream.
solanaRouter.post("/solana/positions/:id/close", requireSession("full"), asyncHandler(async (req, res) => {
  const session: Session = res.locals.session;
  const row = await getPosition(String(req.params.id));
  if (!row || row.privyUserId !== session.privyUserId) {
    res.status(404).json({ error: "position not found" });
    return;
  }
  if (row.status !== "open") {
    res.status(409).json({ error: `position is ${row.status}` });
    return;
  }
  await updatePosition(row.id, { status: "closing", error: null });
  await enqueueClose(row.id);
  res.status(202).json({ id: row.id, status: "closing" });
}));

/// GET /dashboard/solana — the /ops Solana card.
solanaRouter.get("/dashboard/solana", asyncHandler(async (_req, res) => {
  if (!solanaReady) {
    res.json({ ready: false });
    return;
  }
  const [sol, supply, pool, live] = await Promise.all([treasurySol(), supplyRaw(), poolState(), listLivePositions()]);
  const views = await Promise.all(live.filter((r) => r.status === "open").map((r) => viewPosition(r)));
  res.json({
    ready: true,
    treasury: treasury().publicKey.toBase58(),
    treasurySol: sol,
    lowSol: sol < config.solana.minTreasurySol,
    musdSupply: fromRaw(supply),
    pool,
    positions: {
      open: views.length,
      opening: live.filter((r) => r.status === "opening").length,
      closing: live.filter((r) => r.status === "closing").length,
      tvlUsd: Math.round(views.reduce((s, v) => s + (v.valueUsd ?? 0), 0) * 100) / 100,
    },
  });
}));
```

- [ ] **Step 3: Wire up `index.ts`**

```ts
import { solanaRouter } from "./routes/solanaRoutes.js";
import { startSolanaWorker } from "./solana/jobs.js";
import { startSolanaSimulator } from "./solana/simulator.js";
```
Add `app.use(solanaRouter);` after `app.use(dashboardRouter);`, and after `startDeedWatcher();`:
```ts
startSolanaWorker();
startSolanaSimulator();
```

- [ ] **Step 4: Typecheck, test, smoke the HTTP surface**

Run: `cd backend && npm run typecheck && npm test`
Then `npm run dev` and in another shell:
```bash
curl -s localhost:4000/solana/status | jq
```
Expected: `ready: true`, `pool.solPriceUsd` ≈ 150, three tiers. With `SOLANA_TREASURY_KEY` unset: `ready: false`, reason "Solana is not configured".

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/solanaRoutes.ts backend/src/routes/depositSessions.ts backend/src/index.ts
git commit -m "Expose Solana status, positions and destination over HTTP"
```

### Task 14: Devnet end-to-end smoke

**Files:** Create `backend/scripts/sol-smoke.ts`; Modify `backend/package.json`

- [ ] **Step 1: Script** (real devnet, real Postgres; uses the live deps)

```ts
// End-to-end on devnet: for each tier, mint mUSD → open a position → close it
// → check balances on-chain. cd backend && npm run sol:smoke
import { Keypair } from "@solana/web3.js";
import { pool, migrate } from "../src/db.js";
import { insertAccount, setSolanaWallet, createQueuedDeposit, markDepositSendingSol, markDepositConfirmed } from "../src/accounts.js";
import { openDepositSession } from "../src/history.js";
import { setSessionDestination, updatePosition } from "../src/solana/store.js";
import { openForSession, closePosition } from "../src/solana/positions.js";
import { sendAndConfirm, treasury, solscanTx } from "../src/solana/client.js";
import { mintToTx, balanceRaw, fromRaw } from "../src/solana/musd.js";
import { positionExists } from "../src/solana/meteora.js";

await migrate();
const user = `smoke-${Date.now()}`;
const wallet = Keypair.generate().publicKey; // a throwaway devnet wallet stands in for the Privy one
await insertAccount({ privyUserId: user, email: `${user}@example.com`, privyWallet: `0x${"0".repeat(39)}1`, boundAddress: `0x${"0".repeat(39)}2`, ensName: null });
await setSolanaWallet(user, wallet.toBase58());

for (const tier of ["low", "medium", "high"] as const) {
  const s = await openDepositSession(user);
  await setSessionDestination(s.id, user, "sol_earn", tier);
  const sig = await sendAndConfirm(mintToTx(treasury().publicKey, 5)); // what the deposit queue would mint
  const d = await createQueuedDeposit({ privyUserId: user, currency: "USD", amount: 5, sessionId: s.id });
  await markDepositSendingSol(d.id, sig, 5, 0);
  await markDepositConfirmed(d.id);

  const opened = await openForSession(s.id);
  if (!opened?.positionPubkey) throw new Error(`${tier}: not opened`);
  if (!(await positionExists(opened.positionPubkey))) throw new Error(`${tier}: position account missing on-chain`);
  console.log(`${tier}: opened ${opened.positionPubkey} bins [${opened.minBinId}, ${opened.maxBinId}] ${solscanTx(opened.openSig!)}`);

  const before = await balanceRaw(wallet);
  await updatePosition(opened.id, { status: "closing" });
  const closed = await closePosition(opened.id);
  const after = await balanceRaw(wallet);
  if (await positionExists(opened.positionPubkey)) throw new Error(`${tier}: position still exists after close`);
  if (after - before <= 0n) throw new Error(`${tier}: customer wallet received nothing`);
  console.log(`${tier}: closed → ${fromRaw(after - before)} mUSD to ${wallet.toBase58()} ${solscanTx(closed!.payoutSig!)}`);
}
await pool.end();
console.log("smoke OK");
```

Add script: `"sol:smoke": "tsx --env-file=.env scripts/sol-smoke.ts",`

- [ ] **Step 2: Run on devnet**

Run: `cd backend && npm run sol:smoke`
Expected: three `opened` + three `closed` lines with Solscan links, then `smoke OK`. Each tier should return ≈ 5 mUSD (slightly less if any of it bought SOL and was swapped back).

- [ ] **Step 3: Verify independently**

Open two of the printed Solscan links: the open tx calls the DLMM program `LBUZK…wxo`; the payout tx moves mUSD (Token-2022) from the treasury ATA to the throwaway wallet's ATA. Record results for Task 18.

- [ ] **Step 4: Commit**

```bash
git add backend/scripts/sol-smoke.ts backend/package.json
git commit -m "Add sol:smoke — devnet open/close per tier, checked on-chain"
```

---

# Phase C — Frontend and docs

### Task 15: Types, format helpers, API proxies

**Files:** Modify `frontend/lib/types.ts`, `frontend/lib/format.ts`; Create the four API route files.

- [ ] **Step 1: Types** — append to `frontend/lib/types.ts`:

```ts
export type Destination = "evm" | "sol_hold" | "sol_earn";
export type SolTier = "low" | "medium" | "high";

/// GET /solana/status
export interface SolanaStatus {
  ready: boolean;
  reason: string | null;
  pool: { pair: string; activeId: number; binStep: number; musdIsX: boolean; solPriceUsd: number } | null;
  tiers: Array<{ id: SolTier; label: string; blurb: string; width: number }>;
}

export interface SolanaPosition {
  id: string;
  tier: SolTier;
  label: string;
  status: "opening" | "open" | "closing" | "closed" | "failed";
  musdIn: number;
  valueUsd: number | null;
  feesUsd: number | null;
  inRange: boolean | null;
  minBinId: number | null;
  maxBinId: number | null;
  openSig: string | null;
  payoutSig: string | null;
  valueOut: number | null;
  createdAt: string;
}

/// GET /solana/me
export interface SolanaMe {
  ready: boolean;
  wallet: string | null;
  musd: number | null;
  positions: SolanaPosition[];
}
```

Also: in `Receipt` add `destination: Destination; tier: SolTier | null; solPosition: { id: string; status: string; openSig: string | null } | null;`, in the receipt note type add `chain: "evm" | "sol";`, in the yield history item add `chain: "evm" | "sol";`, and in `LiveEvent` (or the deposit.confirmed event type) add `chain?: "evm" | "sol";` plus the three `solana.position.*` events from Task 10 Step 3.

- [ ] **Step 2: Explorer helper** — in `frontend/lib/format.ts` next to `SEPOLIA_TX`:

```ts
export const SOLSCAN_TX = (sig: string) => `https://solscan.io/tx/${sig}?cluster=devnet`;
export const SOLSCAN_ACCOUNT = (addr: string) => `https://solscan.io/account/${addr}?cluster=devnet`;
/// The right explorer for a stored transaction reference.
export const TX_URL = (hash: string, chain: "evm" | "sol" = "evm") => (chain === "sol" ? SOLSCAN_TX(hash) : SEPOLIA_TX(hash));
```

- [ ] **Step 3: API routes**

`frontend/app/api/kiosk/destination/route.ts`:
```ts
import { NextResponse, type NextRequest } from "next/server";
import { relay } from "@/lib/backend";

/// POST /api/kiosk/destination { sessionId, destination, tier? }
export async function POST(req: NextRequest) {
  const { sessionId, destination, tier } = (await req.json().catch(() => ({}))) as { sessionId?: string; destination?: string; tier?: string };
  if (!sessionId) return NextResponse.json({ error: "sessionId required" }, { status: 400 });
  return relay("kiosk", `/deposit-sessions/${encodeURIComponent(sessionId)}/destination`, { method: "POST", body: { destination, tier } });
}
```

`frontend/app/api/kiosk/solana/route.ts`:
```ts
import { NextResponse } from "next/server";
import { backendFetch } from "@/lib/backend";
import type { SolanaStatus } from "@/lib/types";

/// GET /api/kiosk/solana — can the kiosk offer Solana right now (public).
export async function GET() {
  const status = await backendFetch<SolanaStatus>("/solana/status").catch(() => ({ ready: false, reason: "backend unreachable", pool: null, tiers: [] }));
  return NextResponse.json(status);
}
```

`frontend/app/api/solana/me/route.ts`:
```ts
import { relay } from "@/lib/backend";

/// GET /api/solana/me
export async function GET() {
  return relay("web", "/solana/me");
}
```

`frontend/app/api/solana/positions/[id]/close/route.ts`:
```ts
import { relay } from "@/lib/backend";

/// POST /api/solana/positions/:id/close
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return relay("web", `/solana/positions/${encodeURIComponent(id)}/close`, { method: "POST" });
}
```
(If the project's Next version types `params` synchronously, match the existing dynamic routes in `frontend/app/api/` — check one with `ls frontend/app/api/*/\[*` first.)

- [ ] **Step 4: Typecheck** — `cd frontend && npx tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add frontend/lib frontend/app/api/kiosk/destination frontend/app/api/kiosk/solana frontend/app/api/solana
git commit -m "Add Solana types, Solscan links and API proxies"
```

### Task 16: Kiosk destination picker

**Files:** Create `frontend/app/kiosk/DestinationPicker.tsx`; Modify `frontend/app/kiosk/KioskApp.tsx`, `frontend/app/kiosk/DepositFlow.tsx`

- [ ] **Step 1: Component**

```tsx
"use client";

import { useEffect, useState } from "react";
import type { Destination, SolTier, SolanaStatus } from "@/lib/types";

/// "Where should your cash go?" — shown once per visit, before any note.
/// Solana options appear only when the backend says Solana is ready.
export function DestinationPicker({ sessionId, onChosen }: { sessionId: string; onChosen: (d: Destination, tier: SolTier | null) => void }) {
  const [status, setStatus] = useState<SolanaStatus | null>(null);
  const [earn, setEarn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/kiosk/solana", { cache: "no-store" }).then((r) => r.json()).then(setStatus).catch(() => setStatus(null));
  }, []);

  async function choose(destination: Destination, tier: SolTier | null = null) {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/kiosk/destination", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, destination, tier }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "couldn't set the destination");
      onChosen(destination, tier);
    } catch (err) {
      setError(err instanceof Error ? err.message : "couldn't set the destination");
    } finally {
      setBusy(false);
    }
  }

  const solana = status?.ready;
  return (
    <section className="lacquer-card">
      <h2>Where should your cash go?</h2>
      {!earn ? (
        <div className="choice-grid">
          <button className="choice-tile" disabled={busy} onClick={() => choose("evm")}>
            <span className="choice-title">Ethereum vault</span>
            <span className="choice-sub">Your Takarabako balance, earning the vault APY</span>
          </button>
          {solana && (
            <>
              <button className="choice-tile" disabled={busy} onClick={() => choose("sol_hold")}>
                <span className="choice-title">Solana · Hold mUSD</span>
                <span className="choice-sub">A dollar token in your own Solana wallet</span>
              </button>
              <button className="choice-tile" disabled={busy} onClick={() => setEarn(true)}>
                <span className="choice-title">Solana · Earn with Meteora</span>
                <span className="choice-sub">mUSD in a Meteora DLMM pool, earning swap fees</span>
              </button>
            </>
          )}
        </div>
      ) : (
        <>
          <button className="btn btn-ghost small" onClick={() => setEarn(false)} disabled={busy}>← Back</button>
          <div className="choice-grid">
            {status!.tiers.map((t) => (
              <button key={t.id} className="choice-tile" disabled={busy} onClick={() => choose("sol_earn", t.id)}>
                <span className="choice-title">{t.label} risk</span>
                <span className="choice-sub">{t.blurb} · {t.width} bins</span>
              </button>
            ))}
          </div>
        </>
      )}
      {status && !solana && <p className="muted small">Solana options are unavailable right now.</p>}
      {error && <div className="notice error">{error}</div>}
    </section>
  );
}
```

(If `choice-grid` isn't an existing class, use whatever wraps the existing welcome-screen `choice-tile` buttons — check `KioskApp.tsx` around line 405 and reuse that container class.)

- [ ] **Step 2: Use it in `KioskApp.tsx`**

- Import `DestinationPicker` and `Destination`/`SolTier` types.
- State: `const [destination, setDestination] = useState<{ d: Destination; tier: SolTier | null } | null>(null);`
- In `startSession`, reset: `setDestination(null);` (and in `logout`/reset paths where `session` is cleared).
- In the deposit-terminal account block, replace the `session.depositSessionId ? (<DepositFlow .../>)` branch with:

```tsx
            ) : session.depositSessionId && !destination ? (
              <DestinationPicker sessionId={session.depositSessionId} onChosen={(d, tier) => setDestination({ d, tier })} />
            ) : session.depositSessionId ? (
              <DepositFlow
                sessionId={session.depositSessionId}
                destination={destination!.d}
                refusal={refusal}
                onDone={logout}
                onTestDeposit={testDeposit ? onTestDeposit : undefined}
              />
```
- The "Depositing to" card: when `destination?.d` is `sol_hold` show `Solana wallet · mUSD`, `sol_earn` show `Meteora · ${tier} risk`, else the ENS name (unchanged).

Note: the bill-acceptor bridge is already live at login. A note inserted before the customer picks is credited to the default (`evm`) and locks the session — the picker then gets 409 and shows its message. That's acceptable; the picker is the first thing on screen.

- [ ] **Step 3: `DepositFlow.tsx` receipt**

- Add prop `destination: Destination`.
- In the receipt view, add a line under the total:
```tsx
{receipt.destination === "sol_hold" && <p className="small">Sent as mUSD to your Solana wallet</p>}
{receipt.destination === "sol_earn" && (
  receipt.solPosition?.openSig
    ? <p className="small">Meteora position opened · <a href={SOLSCAN_TX(receipt.solPosition.openSig)} target="_blank" rel="noreferrer">view on Solscan</a></p>
    : <p className="small">Opening your Meteora position…</p>
)}
```
- Per-note links: use `TX_URL(note.txHash, note.chain)` wherever the receipt links a note's tx.
- While `receipt.destination === "sol_earn"` and `!receipt.solPosition?.openSig`, keep polling the receipt (reuse the existing settle-poll loop: extend its "done" condition with `&& (receipt.destination !== "sol_earn" || receipt.solPosition?.status === "open" || receipt.solPosition?.status === "failed")`).

- [ ] **Step 4: Typecheck, lint, manual run**

`cd frontend && npx tsc --noEmit && npm run lint`. Then run backend + frontend, open `/kiosk` in deposit-terminal mode, log in with a test QR, pick **Solana · Earn → Low**, use the test-deposit button, Finish: the receipt shows "Opening your Meteora position…" then the Solscan link.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/kiosk
git commit -m "Kiosk: choose Ethereum vault, Solana Hold or Meteora Earn per visit"
```

### Task 17: Customer dashboard, History, and /ops

**Files:** Create `frontend/components/SolanaCard.tsx`; Modify `frontend/app/(customer)/(authed)/Dashboard.tsx`, the History renderer under `frontend/app/(customer)/(authed)/history/`, `frontend/lib/opsTypes.ts`, `frontend/lib/ops.ts`, `frontend/app/ops/OpsDashboard.tsx`

- [ ] **Step 1: `SolanaCard.tsx`**

```tsx
"use client";

import { useCallback, useEffect, useState } from "react";
import type { SolanaMe, SolanaPosition } from "@/lib/types";
import { SOLSCAN_ACCOUNT, SOLSCAN_TX, shortHex, usd } from "@/lib/format";

/// Solana side of My box: wallet + mUSD balance, and Meteora Earn positions.
export function SolanaCard({ refreshKey }: { refreshKey: number }) {
  const [data, setData] = useState<SolanaMe | null>(null);
  const [closing, setClosing] = useState<string | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const res = await fetch("/api/solana/me", { cache: "no-store" });
    if (res.ok) setData(await res.json());
  }, []);
  useEffect(() => void load(), [load, refreshKey]);

  async function close(p: SolanaPosition) {
    setClosing(p.id);
    setError("");
    const res = await fetch(`/api/solana/positions/${p.id}/close`, { method: "POST" });
    if (!res.ok) setError((await res.json().catch(() => ({}))).error ?? "couldn't close");
    setClosing(null);
    void load();
  }

  if (!data?.ready || (!data.wallet && data.positions.length === 0)) return null;
  return (
    <section className="card">
      <div className="spread">
        <h2>Solana</h2>
        {data.wallet && <a className="small" href={SOLSCAN_ACCOUNT(data.wallet)} target="_blank" rel="noreferrer">{shortHex(data.wallet)}</a>}
      </div>
      <p>{usd(data.musd ?? 0)} <span className="muted small">mUSD in your wallet</span></p>
      {data.positions.length > 0 && (
        <ul className="list">
          {data.positions.map((p) => (
            <li key={p.id} className="spread">
              <span>
                {p.label} · {p.status === "open" ? (p.inRange ? "in range" : "out of range") : p.status}
                <br />
                <span className="muted small">
                  in {usd(p.musdIn)}
                  {p.valueUsd != null && ` · now ${usd(p.valueUsd)}`}
                  {p.feesUsd != null && p.feesUsd > 0 && ` · fees ${usd(p.feesUsd)}`}
                  {p.openSig && <> · <a href={SOLSCAN_TX(p.payoutSig ?? p.openSig)} target="_blank" rel="noreferrer">tx</a></>}
                </span>
              </span>
              {p.status === "open" && (
                <button className="btn btn-ghost small" disabled={closing === p.id} onClick={() => close(p)}>
                  {closing === p.id ? "Closing…" : "Close"}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {error && <div className="notice error">{error}</div>}
    </section>
  );
}
```

(If `shortHex` assumes a `0x` prefix, add `shortAddr = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`` to `format.ts` and use it.)

- [ ] **Step 2: Dashboard**

In `Dashboard.tsx`: `import { SolanaCard } from "@/components/SolanaCard";`, add `const [solTick, setSolTick] = useState(0);`, render `<SolanaCard refreshKey={solTick} />` right after the pending/failure notices, and in the live-event handler bump it on Solana events:

```ts
if (e.type.startsWith("solana.") || (e.type === "deposit.confirmed" && e.chain === "sol")) setSolTick((n) => n + 1);
```
For `deposit.confirmed` with `chain === "sol"`, don't add `e.balance` to the vault balance (it's an mUSD balance) — guard the existing balance update with `e.chain !== "sol"`.

- [ ] **Step 3: History**

In the History item renderer, replace each `SEPOLIA_TX(x.txHash)` for deposit notes and yield items with `TX_URL(x.txHash, x.chain)`, and label deposit sessions by destination (`Ethereum vault` / `Solana · Hold` / `Meteora · <tier>`). Find the renderer with `grep -rn "SEPOLIA_TX" frontend/app/\(customer\)`.

- [ ] **Step 4: /ops Solana card**

- `frontend/lib/opsTypes.ts`: add to `OpsData` a `solana: SolanaOps | { error: string };` with
```ts
export interface SolanaOps {
  ready: boolean;
  treasury?: string;
  treasurySol?: number;
  lowSol?: boolean;
  musdSupply?: number;
  pool?: { pair: string; activeId: number; binStep: number; solPriceUsd: number };
  positions?: { open: number; opening: number; closing: number; tvlUsd: number };
}
```
- `frontend/lib/ops.ts`: add `get<OpsData["solana"]>("/dashboard/solana")` to the `Promise.all` and `solana` to the returned object.
- `OpsDashboard.tsx`: add after the Banknote mix `ops-grid`:

```tsx
      <section className="card">
        <h2>Solana · Meteora</h2>
        {ok(data.solana) && data.solana.ready ? (
          <div className="tiles">
            <Tile label="Treasury SOL" value={data.solana.treasurySol!.toFixed(3)} tone={data.solana.lowSol ? "bad" : "ok"} sub={data.solana.lowSol ? "below floor — Solana destinations are off" : undefined} />
            <Tile label="mUSD supply" value={usd(data.solana.musdSupply!)} />
            <Tile label="SOL price (pool)" value={usd(data.solana.pool!.solPriceUsd)} sub={`bin ${data.solana.pool!.activeId} · step ${data.solana.pool!.binStep}`} />
            <Tile label="Earn positions" value={String(data.solana.positions!.open)} sub={`${usd(data.solana.positions!.tvlUsd)} · ${data.solana.positions!.opening} opening · ${data.solana.positions!.closing} closing`} />
          </div>
        ) : ok(data.solana) ? (
          <p className="muted small">Solana isn't configured (set SOLANA_TREASURY_KEY, MUSD_MINT, DLMM_PAIR).</p>
        ) : (
          <PanelError error={data.solana.error} />
        )}
      </section>
```
(Use the same tile container class `StatTiles` uses — check it and match.)

- [ ] **Step 5: Typecheck, lint, build, manual check**

`cd frontend && npx tsc --noEmit && npm run lint && npm run build`. Open `/` as the test customer: the Solana card shows the wallet, mUSD and the Earn position; Close works and the position flips to closed with a Solscan link. Open `/ops`: the Solana card shows live numbers.

- [ ] **Step 6: Commit**

```bash
git add frontend
git commit -m "Show Solana wallet, Meteora positions and ops stats"
```

### Task 18: Docs

**Files:** Modify `DEPLOYMENTS.md`, `README.md`

- [ ] **Step 1: DEPLOYMENTS.md** — add a section:

```markdown
## Solana devnet

| What | Address | How it was verified |
|---|---|---|
| Treasury | `<treasury pubkey>` | funded from faucet.solana.com |
| mUSD (Token-2022) | `<MUSD_MINT>` | Solscan: Token-2022 program, MetadataPointer + TokenMetadata only, mint authority = treasury, no freeze authority |
| DLMM V2 pair mUSD/wSOL | `<DLMM_PAIR>` | owner `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo`; fresh `DLMM.create` reads tokenX = wSOL, tokenY = mUSD; bin step `<n>`; initial price 150 mUSD/SOL |
| Seed position | `<pubkey>` | ±30 bins Spot, 0.5 SOL + 75 mUSD |

`npm run sol:smoke` (<date>): Low/Medium/High each opened and closed on devnet — open txs `<…>`, payouts `<…>`, each verified on Solscan rather than trusting receipts.
```
Fill every `<…>` from Tasks 7 and 14 output.

- [ ] **Step 2: README.md** — replace World ID mentions, and add a "Solana destination" section: the three kiosk choices, Token-2022 mUSD, Meteora DLMM V2 tiers (table from the spec), how to run `sol:setup` / `sol:smoke`, and `SOL_SIM=1` for devnet fees.

- [ ] **Step 3: Commit**

```bash
git add DEPLOYMENTS.md README.md
git commit -m "Document the Solana devnet deployment"
```

---

## Spec coverage check (done while writing)

| Spec item | Task |
|---|---|
| Remove World ID (backend, frontend, migration, limit flat, gas gift) | 1, 2 |
| Destination per visit, locked after first note, Solana gated on readiness | 8, 13, 16 |
| Privy Solana wallet on first use | 9 |
| Token-2022 mUSD, safe extensions only | 5, 7 |
| DLMM V2 pair mUSD/wSOL via `createLbPair2`, seeded | 6, 7 |
| Tiers Spot 60 / Curve 30 / BidAsk 10, one-sided | 4, 6 |
| Hold mints to customer; Earn mints to treasury, opens at Finish | 10, 11, 13 |
| Abandoned Earn sessions still invested | 12 (sweep) |
| Close: remove → swap → pay, step-wise idempotent | 11 |
| No double-send (signed → stored → broadcast) | 3, 10, 11 |
| Earn opens excluded from the daily limit | 11 (limits.ts) |
| Optional devnet simulator | 12 |
| Kiosk picker + receipt; dashboard; History Solscan; /ops card | 16, 17 |
| Unit tests + devnet smoke + DEPLOYMENTS.md | 4, 8, 10, 11, 14, 18 |
