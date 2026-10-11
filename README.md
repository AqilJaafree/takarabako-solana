# Takarabako (宝箱)

**Takarabako turns banknotes into on-chain money: insert cash at a kiosk and
choose where it goes: a yield-bearing balance and a tokenized cash receipt
(tkCASH) on Ethereum, or a Token-2022 dollar and a Meteora liquidity position
on Solana. Curvegrid MultiBaas indexes the Ethereum flows for a treasury
dashboard and a policy-bound AI agent.**

An ATM-style cash-in kiosk: verify your identity with just an email (Privy —
real embedded wallet, no seed phrase, no app), *then* insert cash, and it's
credited to an ENS-named on-chain wallet (`*.takarabako.eth`) with optional
risk-tiered yield as 1inch Aqua liquidity strategies (Uniswap v3 before), with a Claude Haiku
4.5 call. The same kiosk can instead send the cash to Solana devnet: hold mUSD
in a Privy Solana wallet, or earn with a Meteora DLMM V2 position. Built for
ETHGlobal Online 2026. Full product spec lives in
`takarabako-prd.md` (gitignored, local-only).

Nearly everything below is real, on Ethereum Sepolia and Solana devnet — not a stub. See
[`DEPLOYMENTS.md`](./DEPLOYMENTS.md) for the full deployment history and
independent on-chain verification of each piece, and
[`FEEDBACK.md`](./FEEDBACK.md) for integration notes gathered along the way.

## Live deployments (Ethereum Sepolia, chain 11155111)

Our own five contracts are deployed **and independently verified on
Etherscan** (exact-match source, not just a bytecode match) — click through
to confirm:

| Contract | Address | Etherscan |
|---|---|---|
| `MockUSDC` | `0x6cc5f175810e61A56508049f0527BC75EB7e77e4` | [Verified ✅](https://sepolia.etherscan.io/address/0x6cc5f175810e61A56508049f0527BC75EB7e77e4#code) |
| `TakarabakoVault` | `0xD069D36Af7DF950EE87002Fc120B90eF5Ea3ce3D` | [Verified ✅](https://sepolia.etherscan.io/address/0xD069D36Af7DF950EE87002Fc120B90eF5Ea3ce3D#code) |
| `MockRiskToken (mAAVE)` | `0x9c57968055d77d765e4EF1E4F138e9089295eD04` | [Verified ✅](https://sepolia.etherscan.io/address/0x9c57968055d77d765e4EF1E4F138e9089295eD04#code) |
| `MockRiskToken (mDOGE)` | `0x071436DC66a7C86a7c12Bc7E337A05fb46908c38` | [Verified ✅](https://sepolia.etherscan.io/address/0x071436DC66a7C86a7c12Bc7E337A05fb46908c38#code) |
| `TakarabakoCashReceipt (tkCASH)` | `0x8023edf927c0a53f5620998f972b3d0740e04ea9` | [Verified ✅](https://sepolia.etherscan.io/address/0x8023edf927c0a53f5620998f972b3d0740e04ea9#code) |

Everything else the app talks to is a canonical, already-verified deployment
we don't own — real Uniswap v3 (Factory/NPM/WETH9), real ENS v2 Beta
(ETHRegistry/ETHRegistrar/VerifiableFactory), and our own `wantest.eth`
subname registry deployed via that factory. Full addresses, how each was
independently confirmed on-chain (not just trusting a tx receipt), and the
per-risk-tier pool addresses are all in [`DEPLOYMENTS.md`](./DEPLOYMENTS.md).

On Solana devnet (verification in [`DEPLOYMENTS.md`](./DEPLOYMENTS.md#solana-devnet)):

| What | Address | Explorer |
|---|---|---|
| mUSD (Token-2022) | `G9kbAWLmKRr8PYz3x2rrbq4CnurkPx14dQnbYz343DsS` | [Solscan](https://solscan.io/token/G9kbAWLmKRr8PYz3x2rrbq4CnurkPx14dQnbYz343DsS?cluster=devnet) |
| Meteora DLMM V2 pair (wSOL/mUSD, 0.25% fee) | `2U8tBjTahgLvMv1QboFCZJ8aKdNPFRnLwY47pReS2spg` | [Solscan](https://solscan.io/account/2U8tBjTahgLvMv1QboFCZJ8aKdNPFRnLwY47pReS2spg?cluster=devnet) |
| Treasury | `HQ6Q4Sdu21h7NKiNZpmBecJMT8DJWEJ4cV4VaCQk6ZJ3` | [Solscan](https://solscan.io/account/HQ6Q4Sdu21h7NKiNZpmBecJMT8DJWEJ4cV4VaCQk6ZJ3?cluster=devnet) |

Live app deployment:

| Component | URL |
|---|---|
| Kiosk demo | https://takarabako-kiosk.netlify.app |

## Curvegrid MultiBaas — all three tracks

One build covers the three Curvegrid prizes, with MultiBaas as the
backend's contract layer and indexer:

| Track | What we built | Where |
|---|---|---|
| **RWA tokenization** | **tkCASH** — a token that is a claim on one US dollar of banknotes in a specific kiosk. Minted when a note is accepted, burned when cash leaves; supply always equals the on-chain kiosk reserve. Operator counts (`attestReserve`) are proof-of-reserve checkpoints — a mismatch freezes that kiosk's minting. Transfers need both sides allowlisted (Privy-verified), respect a daily limit and a global pause. | `contracts/src/TakarabakoCashReceipt.sol`, `backend/src/cashReceipt.ts` |
| **Digital asset dashboard** | **`/ops`** — proof of reserve per kiosk, tkCASH backing, vault coverage, treasury gas, banknote mix, daily cash in/out, holders and concentration, vault depositors, 1inch Aqua strategies, a live event feed and action items. | `frontend/app/ops/`, `backend/src/routes/dashboard.ts` |
| **AI agent** | A **treasury ops agent** (Claude) that answers operators from live MultiBaas data and can only *propose* actions — fund the yield reserve, set APY, pause a kiosk, mint float. Hard limits are enforced in code; a human approves; approval executes through MultiBaas. A monitor watches webhook events and wakes the agent on anomalies. | `backend/src/opsAgent.ts`, `policy.ts`, `opsMonitor.ts` |

### How we used MultiBaas

- **Contract calls and unsigned transactions.** Every tkCASH write and every
  approved agent action is built by MultiBaas's contract API from the
  uploaded ABI, returned unsigned, signed locally with the treasury key, and
  broadcast through `POST /chains/ethereum/transactions/submit`. The key
  never leaves the backend and no Cloud Wallet is needed
  (`backend/src/multibaas.ts`, `mbSend`).
- **Reads** of the vault, tkCASH and mUSDC go through the same API
  (`mbCall`), including the customer's live vault value on `/position`.
- **Address aliases** name the contracts (`vault`, `tkcash`, `musdc`,
  `treasury`) and each new customer's wallet (their ENS label).
- **Saved Event Queries** power the dashboard: `cash_in_by_kiosk`,
  `cash_in_by_denomination`, `tkcash_holders` (balances rebuilt from
  Transfer events with `add`/`subtract` aggregators), `deposits_by_user`,
  `withdrawals`, `reserve_attestations`.
- **Signed webhooks** stream every event to `/webhooks/multibaas`
  (HMAC-SHA256 over body + timestamp, verified, replays rejected) into a
  Postgres event log that feeds the flows chart, the live feed and the
  agent's monitor.
- `npm run mb:setup` does all of the setup idempotently: five ABIs (the
  free tier's cap), aliases, links from the latest block, the queries and
  the webhook.

```mermaid
flowchart LR
    Kiosk[Kiosk / bill acceptor] -->|note accepted| API[backend]
    API -->|recordCashIn / redeem / agent actions<br/>unsigned tx from MultiBaas,<br/>signed locally| MB[(Curvegrid MultiBaas)]
    MB -->|broadcast| Chain[Ethereum Sepolia<br/>vault · tkCASH · mUSDC<br/>1inch Aqua · ENS registry]
    Chain -->|events indexed| MB
    MB -->|signed webhooks| API
    MB -->|Event Queries · reads| API
    API -->|aggregates| Dash["/ops dashboard"]
    API <-->|tools: reads + proposals| Agent[Claude ops agent]
    Dash -->|operator approves| API
```

### Our experience with MultiBaas

See the MultiBaas section of [`FEEDBACK.md`](./FEEDBACK.md#feedback-curvegrid-multibaas)
for what worked, what tripped us up, and suggestions.

## ENS v2: verifiable machines and sending by name

Takarabako's names live under **`takarabako.eth` on the official ENS v2
Sepolia deployment** (`npm run ens:setup`): the name points at our own
UserRegistry (subnames are ERC-1155 tokens) and PermissionedResolver
(records), so every name resolves through the official
`UniversalResolverV2` — any ENS-aware app sees them.

- **Verifiable machines.** Each kiosk is a name, e.g.
  `tokyo-01.takarabako.eth`, whose address record is a signing key
  generated on the Raspberry Pi itself (`device-agent/machine.js`). The Pi
  signs every note it accepts (EIP-712 `NoteAccepted`: kiosk, amount,
  currency, session hash, nonce, time). `/deposit` resolves the kiosk's name,
  recovers the signer and credits the note as verified only if they match; a
  fake box or a replayed signature can't mint deposits
  (`MACHINE_SIGNATURE=required` rejects unsigned ones outright). The kiosk
  screen, receipts and History show "✓ tokyo-01.takarabako.eth".
- **Customer names** (`alice-1a2b.takarabako.eth`) are owned by, and resolve
  to, the customer's own Privy wallet.
- **Send by name.** Type a name, it resolves through ENS: box balance moves
  between boxes (Takarabako does it), **tkCASH** is signed by the customer in
  their own wallet, with the token's on-chain rules (both wallets
  identity-verified, $500/day limit).
- **Positions as deeds.** Each 1inch Aqua position has a transferable name
  (`aqua-1a2b3c4d.takarabako.eth`) in its owner's wallet. Sending that name
  token gives the position away; the backend follows the token (webhook from
  MultiBaas, or on confirm), and only the deed's holder can close it.

Scripts: `npm run ens:setup` (register the parent, deploy registry and
resolver), `npm run ens:kiosk -- http://<pi>:8080` (publish a kiosk's device
key), `npm run ens:migrate` (re-issue names).

## Identity: Privy email, one daily limit

Customers sign in with an email code through Privy, which gives each one an
embedded wallet with no seed phrase (`backend/src/privy.ts`). One email is one
account. World ID was used earlier and was removed on 2026-10-10, so there is
no selfie step and no verified tier any more.

Every account has the same flat limit: **$1,000 a day** (UTC, `DAILY_LIMIT_USD`)
across cash deposited at the kiosk, withdrawals, yield positions opened, and
anything sent by name (`backend/src/limits.ts`). A kiosk visit won't start once
the day's limit is used (notes already taken are always credited). `/deposit`
logs in by scanning the customer's wallet QR.

## Solana destination

At the kiosk a customer picks where the cash goes:

1. **Ethereum vault**: the original Sepolia flow above.
2. **Solana Hold mUSD**: the treasury mints mUSD to the customer's Solana wallet
   (a Privy embedded wallet created the first time they pick Solana).
3. **Solana Meteora Earn**: the cash opens a Meteora DLMM V2 liquidity position.

mUSD is a Token-2022 mock dollar (6 decimals, MetadataPointer + TokenMetadata
only, no freeze authority) minted by the treasury on devnet. It trades against
wSOL in a live DLMM V2 pair. Earn positions are single-sided mUSD placed next
to the current price and held by the treasury, which tracks each one per
customer:

| Tier | Shape | Bins |
|---|---|---|
| Low | Spot | 60 |
| Medium | Curve | 30 |
| High | BidAsk | 10 |

Customers see their mUSD balance and positions (range, live value, fees) on
the dashboard and can close a position there. Closing pays the customer back
in mUSD, swapping any SOL the position picked up along the way. There is no
way yet to turn mUSD into USDC or cash.

`/ops` has a Solana panel: treasury SOL (Solana is switched off at the kiosk
below `SOLANA_MIN_TREASURY_SOL`), mUSD supply, the pool's SOL price next to
the real SOL/USD from [Solami](https://solami.dev) market data (with the gap
between them), and open Earn positions.

Safety model: every signed transaction is stored before it is broadcast, and it
is never re-sent until the finalized block height proves the old one can no
longer land, so a retry can't pay twice.

```bash
cd backend
npm run sol:setup     # create mUSD + the DLMM pair + a seed position (needs a funded devnet treasury)
npm run sol:smoke     # open and close Low/Medium/High against the live pair, check payouts on-chain
SOL_SIM=1             # in backend/.env: the treasury swaps against the pair so Earn positions accrue fees,
                      # and (with SOLAMI_API_KEY) walks the pool price toward the real SOL/USD, $25 a tick
SOLAMI_API_KEY=sk_…   # in backend/.env: real SOL/USD from Solami (mainnet) beside the devnet pool price on /ops
```

Addresses and verification are in [`DEPLOYMENTS.md`](./DEPLOYMENTS.md#solana-devnet).
`@meteora-ag/dlmm` 1.9.x's ESM build can't load under Node, so
`backend/src/solana/dlmmCjs.ts` loads the CJS build.

## Yield on 1inch Aqua

Customers put their box to work as ETH/USDC liquidity through
[1inch Aqua](https://github.com/1inch/aqua), the shared-liquidity registry,
and SwapVM strategies from [`@1inch/swap-vm-sdk`](https://github.com/1inch/sdks).
Aqua and its SwapVM router are live on Sepolia (the SDK doesn't list Sepolia;
the router is at its previous address, `0x1111113d…c0de`, version 1.0.2).
The pair is mETH (a mintable ETH stand-in priced off live ETH/USD) and mUSDC.

- **Quick start** — three tiers for beginners: *Steady* (full-range x·y=k),
  *Balanced* (±25% concentrated) and *Bold* (±8%), each with a one-line Claude
  rationale.
- **Advanced** — drag a price range on a week of ETH/USD (log scale, −90% to
  +300%) and pick a shape: *Spot* (even), *Curve* (weighted to the current
  price) or *Bid-Ask* (weighted to the edges). The range is split into up to
  five bins, each its own concentrated SwapVM strategy; bins wholly below the
  price are USDC-only bids, wholly above are ETH-only asks, so a −90%…−3%
  range is a one-sided "buy the dip" ladder. Token amounts come from SwapVM's
  liquidity maths so every strategy starts at the market price.
- **Money flow** — opening takes the amount out of the customer's vault; the
  treasury is the Aqua maker and ships the strategies (tokens stay in its
  wallet, Aqua tracks virtual balances). Closing — or withdrawing — docks
  them and returns their value at the live ETH price to the vault.
- **Demo market maker** — nobody trades on Sepolia, so with `AQUA_SIM=1` the
  treasury trades against its own strategies every 10 minutes (at most two
  swaps), pulling mispriced ones toward the live price or making a small
  round trip so fees accrue.
- The 1inch hosted Swap API doesn't serve Sepolia; everything here talks to
  the Aqua and SwapVM contracts directly through the SDKs.

## Layout

- **`contracts/`** — Foundry workspace: `MockUSDC`, mock risk-tier tokens,
  `TakarabakoVault` (mock-yield ERC-4626-flavored vault) and
  `TakarabakoCashReceipt` (tkCASH).
- **`backend/`** — Node/TypeScript orchestrator: real Privy identity, real
  ENS v2 subname registration, real vault deposit/withdraw, real per-user
  1inch Aqua yield strategies (beginner tiers and a drawable advanced range), real Claude Haiku 4.5
  rationale. `src/solana/` holds the Solana side: mUSD, the Meteora pair,
  Earn positions and their BullMQ queue, and the Solami price feed.
- **`frontend/`** — Next.js web app: the customer app (Privy email-code
  login, live balance, quick-deposit QR, yield, withdraw), `/kiosk`, the
  box's new screen, `/deposit`, the public cash-deposit terminal (wallet QR login), and
  `/ops`, the treasury dashboard. See [`frontend/README.md`](./frontend/README.md).
- **`device-agent/`** — kiosk page for the Raspberry Pi 4 touchscreen, plus
  the software bridge for a real TB74 pulse bill acceptor (`gpio/`).

## System flow

```mermaid
sequenceDiagram
    actor User
    participant Kiosk as device-agent (kiosk)
    participant API as backend
    participant Privy
    participant Claude as Claude Haiku 4.5
    participant Aqua as 1inch Aqua (SwapVM)
    participant ENS as ENS v2 (takarabako.eth)
    participant Vault as TakarabakoVault

    User->>Kiosk: enter email
    Kiosk->>API: POST /verify {email}
    API->>Privy: getByEmailAddress / create
    Privy-->>API: userId + embedded wallet
    API->>ENS: register <label>.takarabako.eth (new account only)
    API-->>Kiosk: {userId, ensName, balance: 0}

    User->>Kiosk: pick a destination (Ethereum vault, Solana Hold, Solana Earn)
    Note over Kiosk,API: Solana paths mint mUSD on devnet instead,<br/>and Earn opens a Meteora position at Finish

    User->>Kiosk: insert cash (or fallback button)
    Kiosk->>API: POST /deposit {userId, amount}
    API->>Vault: depositFor(boundAddress, amount)
    API-->>Kiosk: {balance, txHash}

    User->>Kiosk: pick a risk tier
    Kiosk->>API: POST /agent/open-position {riskLevel, amount}
    API->>Claude: confirm tier against live pool data
    Claude-->>API: rationale (tier is never overridden)
    API->>Vault: withdrawTo(treasury, amount's shares)
    API->>Aqua: ship SwapVM strategies (one per bin)
    API->>ENS: register aqua-<id>.takarabako.eth
    API-->>Kiosk: {ensName, pair, apyBps, rationale}

    User->>Kiosk: withdraw
    Kiosk->>API: POST /withdraw {userId}
    API->>Aqua: dock strategies, value at live ETH price, depositFor back
    API->>Vault: withdrawTo(treasury, shares)
    API-->>Kiosk: {netUsdc, receipt} (2% fee)
```

## Quickstart

```bash
# contracts
cd contracts && forge install --no-git && forge test

# backend — needs real Sepolia RPC/keys in .env; see DEPLOYMENTS.md
cd backend && npm install && cp .env.example .env
npm run services   # Postgres + Redis without Docker (or: docker compose up -d)
npm run dev        # http://localhost:4000

# web app + /kiosk + /ops (separate shell)
cd frontend && npm install && npm run dev   # http://localhost:3000

# Pi kiosk page (separate shell)
cd device-agent && cp public/config.example.js public/config.js && node server.js   # http://localhost:8080
```

### MultiBaas setup

1. Create a free Sepolia deployment at [console.curvegrid.com](https://console.curvegrid.com)
   and an admin API key (Admin → API Keys). Put them in `backend/.env` as
   `MULTIBAAS_URL` and `MULTIBAAS_API_KEY`. No CORS setup is needed: the
   browser never calls MultiBaas; the dashboard goes through the backend.
2. tkCASH is already deployed at `0x8023edf927c0a53f5620998f972b3d0740e04ea9`; set `CASH_RECEIPT_ADDRESS` to it. To deploy your own:
   ```bash
   cd contracts
   KIOSK_ID=tokyo-01 forge script script/DeployCashReceipt.s.sol --rpc-url $RPC_URL --broadcast --private-key $PRIVATE_KEY
   ```
3. Expose the backend for webhooks, e.g. `cloudflared tunnel --url http://localhost:4000`,
   and set `PUBLIC_BACKEND_URL` to the tunnel URL.
4. `cd contracts && forge build && cd ../backend && npm run mb:setup` —
   uploads the ABIs, links addresses, saves the queries and registers the
   webhook. Copy the printed `MULTIBAAS_WEBHOOK_SECRET` into `.env` and
   restart the backend.
5. Set `OPS_ADMIN_TOKEN` (a long random string) to use the agent and approve
   proposals on `http://localhost:3000/ops`.

### Testing

```bash
cd contracts && forge test          # vault + tkCASH (18 tests, incl. a supply == reserve fuzz)
cd backend && npm test              # needs Postgres + Redis (npm run services); 127 tests:
                                    # webhook signatures, tkCASH encoding, policy limits,
                                    # proposal lifecycle with the executor stubbed, monitor
                                    # rules, Solana deposit routing, Earn position lifecycle, …
cd backend && npm run sol:smoke     # live devnet: open and close every Earn tier
cd backend && npm run typecheck
```

End to end: log in at the kiosk and insert a note (or use the test-deposit
button), then check `/ops` — a CashIn arrives by webhook, the reserve and
holders update. Ask the agent "Is the yield reserve sufficient?" (grounded
answer + tool trace), then "Raise APY to 50%" (policy rejects it), then "Top
up the yield reserve with 100 USDC" (pending → Approve → the tx appears in
MultiBaas and the feed).

Treasury wallets are testnet-only burner keys — check the Sepolia ETH and
devnet SOL balances before running anything that spends gas; they run dry
easily at hackathon pace.
