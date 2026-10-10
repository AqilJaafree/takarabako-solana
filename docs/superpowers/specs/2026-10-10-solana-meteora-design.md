# Solana destination: Token-2022 mUSD + Meteora DLMM V2 — design

Date: 2026-10-10 · Repo: `takarabako-solana` (copy of `takarabako`, branch `world-id`)

## Goal

1. Remove World ID entirely.
2. Let the customer choose, at the start of a kiosk visit, where their cash goes:
   the existing **Ethereum vault**, or **Solana** (hold a Token-2022 mock
   stablecoin, or earn with a Meteora DLMM V2 liquidity position).
3. Mint on Solana with **Token-2022**; provide liquidity on **Meteora DLMM V2**.

The EVM stack (Sepolia vault, tkCASH, MultiBaas, ENS, 1inch Aqua, ops agent)
stays as is. Solana is added for these new features only.

## Decisions

| Topic | Decision |
|---|---|
| Scope | Solana for new features only; EVM core unchanged |
| Choice | Customer picks a destination per visit: `evm`, `sol_hold`, `sol_earn` (+ tier) |
| Token-2022 | One mock stablecoin, **mUSD** (6 decimals), on devnet. No compliance extensions |
| LP venue | Meteora **DLMM V2** (`createLbPair2` / `PresetParameter2`) — single-sided deposits, tiers as range strategies |
| Custody | Positions are **treasury-held**, tracked per user in Postgres (same model as the EVM vault). Customer never signs Solana txs; treasury pays all fees |
| Pool | One pair, **mUSD/wSOL**, devnet |
| Daily limit | Kept, applied flat to every account; nothing lifts it |
| Network | Solana devnet |

## Part 1 — World ID removal and destination choice

### World ID removal

Delete:
- Backend: `src/worldId.ts`, `src/worldLogin.ts`, `src/routes/loginWorld.ts`,
  `src/routes/worldIdRoutes.ts`, `scripts/world-staging.ts`, the
  `world:staging` npm script, `@worldcoin/idkit-core`, `config.worldId`.
- Frontend: `components/WorldSelfie.tsx`, `app/kiosk/WorldLogin.tsx`,
  `app/(customer)/(authed)/verify/*`, `app/api/worldid/*`,
  `app/api/kiosk/login-world/*`, `app/api/me/worldid/*`, `lib/useWorldProof.ts`,
  `@worldcoin/idkit*` dependencies, and World ID references in
  `LoginForm.tsx`, `Dashboard.tsx`, `send/page.tsx`, `KioskApp.tsx`,
  `CurrencyTunnel.tsx` and the treasure scene components.

Change:
- `limits.ts`: limit applies to every account; drop the `worldIdReady` /
  `worldVerifiedAt` bypass. Messages become plain ("You've reached today's
  $N limit.").
- `routes/depositSessions.ts`: same message change.
- `routes/me.ts`, `routes/ensRoutes.ts`, `ensTransfers.ts`, `accountsFlow.ts`,
  `depositLogin.ts`: stop returning/reading `worldId` / `worldVerified`; stop
  writing the `takarabako.verified` ENS text record.
- `accounts.ts`: drop `worldVerifiedAt`, `worldCredential`,
  `findByWorldNullifier`.
- `privy.ts`: the new-account ETH gas gift no longer waits for World ID;
  every new account is funded at creation (as before World ID).
- Migration `011_drop_world_id.sql` drops `world_verified_at`,
  `world_credential`, `world_nullifier` (and their indexes). `009` stays.

### Destination choice

- The kiosk opens the deposit session at login (`frontend/lib/kiosk.ts`), so
  the destination is set by a separate call right after login:
  `POST /deposit-sessions/:id/destination`
  `{ destination: "evm" | "sol_hold" | "sol_earn", tier?: "low" | "medium" | "high" }`.
  `tier` is required iff `destination = sol_earn`. Sessions default to `evm`.
  The destination is locked (409) once the session has a note. Solana
  destinations are rejected with 503 when `solanaReady` is false or the
  treasury SOL balance is below the floor.
- Stored on `deposit_sessions.destination` / `deposit_sessions.tier`.
- `depositQueue` routes each note by its session's destination:
  - `evm` → existing `depositFor` path, unchanged.
  - `sol_hold` → mint mUSD (USD amount from `fx.ts`) to the customer's Solana wallet.
  - `sol_earn` → mint mUSD to the treasury's mUSD account, tagged to the session.
  All paths publish the same `deposit.pending | confirmed | retrying | failed`
  events, so kiosk animation and receipts are unchanged.
- `POST /deposit-sessions/:id/finish` for `sol_earn`: enqueue an
  `open-position` job for the session's confirmed mUSD total at its tier.

### Solana wallet

Each customer gets a Privy **Solana** embedded wallet beside the Ethereum one,
created (`pregenerateWallets`, `chain_type: "solana"`) the first time they pick
a Solana destination — the same path for new and existing accounts. Stored in
`accounts.solana_wallet`.

## Part 2 — Backend: Solana + Meteora (devnet)

### Modules

- `src/solana/client.ts` — `Connection`, treasury `Keypair`
  (`SOLANA_TREASURY_KEY`, base58, in `.env`), `SOLANA_RPC_URL`,
  `send(tx, signers)`: sets compute-unit price, confirms, retries on blockhash
  expiry. Exports `solanaReady` and `treasurySolBalance()`.
- `src/solana/musd.ts` — Token-2022 mUSD: `MUSD_MINT` from `.env`; mint
  authority = treasury. Extensions: MetadataPointer + TokenMetadata only
  (must be within DLMM's permissionless allowlist; verify before creating the
  mint). `mintTo(owner, amount)` (creates the ATA idempotently),
  `transfer(fromTreasury → owner, amount)`, `balanceOf(owner)`, `supply()`.
- `src/solana/meteora.ts` — wrapper over `@meteora-ag/dlmm`:
  `openPosition(tier, amountMusd) → { position, minBinId, maxBinId, sig }`,
  `viewPosition(position) → { valueMusd, feesMusd, inRange, activePrice }`,
  `closePosition(position) → { musdOut, sigs }`.
- `src/solana/positions.ts` — customer-facing layer like `yieldPositions.ts`:
  `openForSession(sessionId)`, `closeForCustomer(account, id)`; writes `solana_positions` and History (`recordYieldEvent` with
  `pair: "mUSD/SOL · <tier>"`, Solscan devnet link as tx reference).
- `src/routes/solanaRoutes.ts` — `GET /solana/positions`,
  `POST /solana/positions/:id/close`, `GET /solana/wallet` (address + mUSD
  balance), `GET /solana/pool` (active price, tiers).

### Pool setup — `npm run sol:setup` (idempotent)

1. Create the mUSD Token-2022 mint (skip if `MUSD_MINT` set).
2. Pick a devnet `PresetParameter2` (`DLMM.getAllPresetParameters`), create the
   mUSD/wSOL pair with `createLbPair2` at an initial price (skip if
   `DLMM_PAIR` set).
3. Seed a small two-sided treasury position around the active bin.
4. Print addresses for `.env`; record them in `DEPLOYMENTS.md` after
   independently verifying on-chain (mint extensions, pair token X/Y, active
   bin, seed position liquidity).

### Tiers

All single-sided mUSD placed on the side of the active bin that mUSD occupies
(determined by the pair's X/Y ordering):

| Tier | Strategy | Width |
|---|---|---|
| Low | Spot | ~60 bins |
| Medium | Curve | ~30 bins |
| High | BidAsk | ~10 bins |

Exact widths are fixed in the plan after checking the preset's bin step and
the SDK's max position width. Tier → `{ strategyType, minBinId, maxBinId }`
is a pure function (unit-tested).

### Fees on devnet

Optional `sol:simulate` ops job (off by default, mirrors `aquaSimulator.ts`):
small treasury swaps back and forth through the pair so positions accrue
visible fees.

### Exit

`closePosition`: remove 100% liquidity + claim fees + close position → swap
any wSOL received back to mUSD through the same pair → transfer total mUSD to
the customer's Solana wallet. Each step checks on-chain state first, so a
partially failed close is safe to retry. Value is computed from live bins at
the pair's active price.

### Data — migration `012_solana.sql`

- `accounts.solana_wallet text unique`
- `deposit_sessions.destination text not null default 'evm'`
  (check in `evm|sol_hold|sol_earn`), `deposit_sessions.tier text null`
- `deposits`: `chain text not null default 'evm'` (`evm|sol`) and
  `sol_valid_height bigint null`. The Solana signature is stored in the
  existing `tx_hash` column (signed → stored → broadcast, so a retry never
  mints twice).
- `yield_events.chain text not null default 'evm'`: Solana Earn opens are
  recorded with `chain = 'sol'` and excluded from the daily limit, because the
  notes behind them were already counted as deposits.
- `solana_positions`: `id`, `privy_user_id`, `session_id` (unique), `tier`, `pair`,
  `position_pubkey`, `min_bin_id`, `max_bin_id`, `musd_in`, `open_sig`,
  `open_valid_height`, `status` (`opening|open|closing|closed|failed`),
  close progress (`musd_out`, `sol_out`, `removed_at`, `swap_sig`,
  `swap_out`, `payout_sig`, `payout_valid_height`), `value_out`, `error`,
  `created_at`, `closed_at`.

### Config (`backend/.env`)

`SOLANA_RPC_URL`, `SOLANA_TREASURY_KEY`, `MUSD_MINT`, `DLMM_PAIR`,
`SOLANA_MIN_TREASURY_SOL` (default 0.5).

## Part 3 — Frontend, error handling, testing

### Kiosk (`app/kiosk/KioskApp.tsx`)

After login, a **"Where should your cash go?"** step: three cards —
*Ethereum vault*, *Solana · Hold mUSD*, *Solana · Earn with Meteora* (the
last reveals Low/Medium/High with one-line description, bin width, est. APY).
Solana cards are hidden when `/solana/pool` reports not ready. The choice is
sent with `POST /deposit-sessions`. Note animation unchanged. Finish receipt
shows the destination; for Earn, "Opening Meteora position…" resolving to a
Solscan (devnet) link.

### Customer app

Dashboard: Solana wallet address + mUSD balance; **Solana positions** list
(tier, bin range, in-range badge, live value, fees, Close). History renders
Solana events with Solscan links.

### Ops (`/ops`)

One **Solana** card from Postgres + RPC: mUSD supply, treasury SOL, pair
active price and liquidity, open-position TVL, low-SOL alert. The ops agent
stays EVM-only.

### Error handling

- Mint failure → BullMQ retry, same events as EVM deposits.
- Open-position failure at Finish → mUSD stays in treasury, row `failed`,
  queue retries; receipt shows "position opening". Cash is never lost: the
  mUSD is minted and recorded.
- Treasury SOL below floor → Solana destinations disabled at visit start
  (`/ops` alert), never mid-visit.
- Close is step-wise idempotent (see Exit).

### Testing

- Unit (`node:test`, existing style): tier → bin-range math; destination
  routing in `depositQueue`; `POST /deposit-sessions` validation (tier iff
  `sol_earn`); flat limit with World ID removed; migrations apply cleanly.
- `npm run sol:smoke` on devnet: mint → open one position per tier → close
  each, verified on-chain (bins, balances) rather than trusting receipts.
  Results recorded in `DEPLOYMENTS.md`.
- Existing backend tests, frontend typecheck and lint pass after World ID
  removal.

## Out of scope

Customer-signed Solana transactions, mainnet, Solana in MultiBaas or the ops
agent, a Solana version of tkCASH, DAMM v2.
