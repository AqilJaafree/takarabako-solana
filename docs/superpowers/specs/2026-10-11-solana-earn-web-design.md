# Earn from held mUSD in the web app — design

Date: 2026-10-11 · Repo: `takarabako-solana` (branch `main`) · Builds on
[`2026-10-10-solana-meteora-design.md`](./2026-10-10-solana-meteora-design.md)

## Goal

Today Solana is reachable only from the kiosk: a visit's cash becomes mUSD
(Hold) or a Meteora position (Earn). The customer web app shows the mUSD
balance and Earn positions with Close, but can't start anything.

Add **Earn from the web app**: a customer who holds mUSD picks an amount and a
tier (Low / Medium / High) and opens a Meteora DLMM V2 position from it.

Out of scope: choosing the kiosk destination in advance, moving the Ethereum
vault balance to Solana, a picker on `/deposit`, mUSD → USDC/cash, sending
mUSD to other people.

## Decisions

| Topic | Decision |
|---|---|
| How mUSD reaches the position | The customer signs one Token-2022 `transferChecked` (their mUSD → treasury mUSD account) in the browser with their Privy Solana wallet. Positions stay treasury-held and tracked per customer, as for kiosk Earn |
| Fees | The treasury is the fee payer. Customer wallets hold no SOL and never need any |
| Who builds the transaction | The backend. The browser only signs. The backend co-signs only the exact message it built |
| Alternatives rejected | Privy server-side session signers (dashboard setup, custody-like power over customer wallets); a new mint with PermanentDelegate (replaces the live mint, pair and balances) |
| Daily limit | Web Earn counts toward the flat daily limit (it is new money put to work, like an Ethereum yield open). Kiosk Earn stays excluded (its notes were already counted) |
| Login | Both endpoints need a `full` session (email login), like `/yield` and `/withdraw` |

## Backend

### Data — migration `013_solana_web_earn.sql` (idempotent)

`solana_positions`:
- `source text not null default 'kiosk'` — `kiosk | web`.
- `funding_sig text`, `funding_valid_height bigint`, `funding_message_hash text`,
  `funding_confirmed_at timestamptz`.
- Status check gains `funding` (before `opening`):
  `funding | opening | open | closing | closed | failed`.
- `session_id` is already nullable; web positions leave it null.

### Opening by position, not by session

`openForSession(sessionId)` becomes a thin wrapper: it creates (or finds) the
session's position row, then calls a new `openPosition(positionId)` that holds
the existing open logic (sign → store `open_sig` → broadcast → confirm →
`finalizeOpen`). The BullMQ job `open` takes a `positionId`; the kiosk path
enqueues by the session's position id. Jobs ids stay `-`-separated
(`open-<positionId>`). `recoverStuckPositions` and
`earnSessionsWithoutPosition` keep working; a second sweep re-queues web
positions stuck in `opening`.

### `src/solana/webEarn.ts`

- `buildFundingTx(owner, amountRaw)` → `{ tx, messageHash }`: one
  `transferChecked` (Token-2022, mUSD, 6 decimals) from the owner's mUSD ATA to
  the treasury's, plus the compute-unit price instruction; fee payer =
  treasury; fresh blockhash. `messageHash` = sha256 of the serialized message.
- `checkSignedFunding(signedTx, expectedHash, owner)` → ok or a reason:
  message hash equals `expectedHash`; the owner's signature is present and
  valid for that message; the fee-payer slot is unsigned or already the
  treasury's. Pure, unit-tested.

### Routes (`src/routes/solanaRoutes.ts`)

**`POST /solana/earn/prepare { amount, tier }`** (`full` session)
1. Validate `tier` and `amount` (> 0, ≤ 6 decimals).
2. Refuse with 503 if `solanaAvailable()` is not ok.
3. Refuse with 403 `daily_limit` if `amount` > today's allowance left.
4. Read the customer's mUSD balance on-chain; 400 if `amount` exceeds it.
5. Create a position row: `source='web'`, `status='funding'`, `tier`,
   `musd_in = amount`, `funding_message_hash`, `funding_valid_height`.
6. Return `{ id, tx: base64 of the unsigned transaction }`.

**`POST /solana/earn/submit { id, signedTx }`** (`full` session)
1. The row must belong to the caller and be in `funding` with no
   `funding_sig` (409 otherwise).
2. `checkSignedFunding`; on failure mark the row `failed` with the reason, 400.
3. Treasury co-signs; compare-and-set `funding_sig` (the same rule as every
   other send: stored before broadcast).
4. Broadcast, `confirm()`:
   - `confirmed` → set `funding_confirmed_at`, `status='opening'`, enqueue
     `open-<id>`; respond 202 `{ id, status: 'opening' }`.
   - `failed` / `expired` → `failed` with the reason (nothing moved); 400.
   - unknown (throw) → leave `funding` with the signature stored; the
     recovery sweep re-checks it; respond 202 `{ status: 'funding' }`.

A `funding` row with no signature older than 10 minutes is marked `failed`
(the customer walked away). A `funding` row with a signature is re-checked by
the sweep: confirmed → `opening` + enqueue; failed/expired → `failed`.

### Daily limit (`limits.ts`)

`usedToday` adds `sum(musd_in)` of the customer's `solana_positions` with
`source = 'web'`, created today, whose status is not `failed`.

### Views

`PositionView` gains `source`. `GET /solana/me` already lists every position;
`funding` rows show as "Waiting for your approval".

## Frontend

### `PrivyShell`

Enable Solana in the Privy provider (Solana embedded wallets are already
created server-side; `createOnLogin: "off"` stays). Exact config keys are
taken from the installed `@privy-io/react-auth` 3.45 types/docs at plan time.

### `lib/useSolanaSign.ts`

Finds the customer's Privy Solana wallet whose address equals
`/solana/me`'s `wallet`, and signs (does not send) a base64 transaction with
it, returning the signed base64. Errors: no matching wallet, user rejected.

### Page `app/(customer)/(authed)/solana/page.tsx`

- mUSD balance and Solana wallet address (Solscan devnet link).
- **Earn** form: amount input with Max, three tier tiles (same labels, blurbs
  and widths as the kiosk, from `/api/kiosk/solana`), the allowance left today.
- Earn → `prepare` → Privy signing → `submit` → toast + position appears in
  the list (`opening` → `open`), live via the existing stream / polling.
- Positions list with Close: reuse `SolanaCard`'s list.
- Proxies: `app/api/solana/earn/prepare`, `app/api/solana/earn/submit`.
- Dashboard `SolanaCard` gets an "Earn with your mUSD" link to the page; the
  customer nav gets a "Solana" entry.

## Error handling summary

| Situation | Result |
|---|---|
| Not enough mUSD / over the daily limit / Solana unavailable | Refused at `prepare`, nothing created on-chain |
| Customer rejects in Privy | Row stays `funding` without a signature → `failed` after 10 min; UI says "Cancelled" |
| Tampered or wrong-signer transaction | Refused at `submit`, row `failed`, treasury never signs |
| Transfer lands, open fails | Row `opening`; mUSD is in the treasury tagged to the row; BullMQ retries; recovery sweep re-queues |
| Crash between broadcast and confirm | `funding_sig` stored; sweep resolves it; never re-sent while it could land |

## Testing

- Unit: `buildFundingTx` / `checkSignedFunding` (good signature passes;
  changed amount, changed destination, extra instruction, wrong signer,
  missing signature all fail); daily limit counts web Earn and still ignores
  kiosk Earn; route validation (tier, amount, ownership, 409 on resubmit).
- Store/job: `openPosition(id)` for a web row; kiosk path unchanged
  (existing `solanaPositions` tests stay green).
- `npm run sol:flow`: after the Hold visit, a web Earn of part of the held
  mUSD, signed with a **local test keypair** standing in for the Privy wallet
  (a real Privy approval needs a browser). The flow script needs that
  keypair's address to be the account's Solana wallet, so it uses a dedicated
  throwaway account created in the DB (like `sol:smoke`), not the demo account.
- Manual: one real Privy approval in the browser on devnet.
- Frontend: typecheck, lint, build.
