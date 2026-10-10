# Deployments — Ethereum Sepolia (chain 11155111)

Live testnet addresses this build actually talks to. Update this file
whenever something new is deployed or seeded — it's the source of truth
for `backend/.env`, not the other way around.

## Takarabako contracts

Deployed via `contracts/script/Deploy.s.sol`. All four are **verified on
Sepolia Etherscan as an exact source-code match** (`forge verify-contract`,
independently re-confirmed by fetching each Etherscan page directly rather
than trusting the CLI's own success message):

| Contract | Address | Etherscan |
|---|---|---|
| `MockUSDC` | `0x6cc5f175810e61A56508049f0527BC75EB7e77e4` | [Verified](https://sepolia.etherscan.io/address/0x6cc5f175810e61A56508049f0527BC75EB7e77e4#code) |
| `TakarabakoVault` | `0xD069D36Af7DF950EE87002Fc120B90eF5Ea3ce3D` | [Verified](https://sepolia.etherscan.io/address/0xD069D36Af7DF950EE87002Fc120B90eF5Ea3ce3D#code) |
| `MockRiskToken (mAAVE)` | `0x9c57968055d77d765e4EF1E4F138e9089295eD04` | [Verified](https://sepolia.etherscan.io/address/0x9c57968055d77d765e4EF1E4F138e9089295eD04#code) |
| `MockRiskToken (mDOGE)` | `0x071436DC66a7C86a7c12Bc7E337A05fb46908c38` | [Verified](https://sepolia.etherscan.io/address/0x071436DC66a7C86a7c12Bc7E337A05fb46908c38#code) |

Compiler `0.8.28+commit.7893614a`, optimizer on (200 runs). Constructor args
were re-derived from `Deploy.s.sol` with `cast abi-encode` rather than
guessed — e.g. `MockUSDC(address)` takes the treasury address
`0x9205DcCC081D896edeAB423d88665660d61d5bfE` as `initialOwner`.

Vault's yield reserve was topped up with 100 mUSDC (tx `0x17b9fe848b...`)
so `withdrawTo` can actually pay out accrued mock yield — see PRD §7.6.

## Uniswap v3 (canonical Sepolia deployment, not ours)

| Contract | Address |
|---|---|
| `UniswapV3Factory` | `0x0227628f3F023bb0B980b67D528571c95c6DaC1c` |
| `NonfungiblePositionManager` | `0x1238536071E1c677A632429e3655c799b22cDA52` |
| `WETH9` | `0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14` |

Verified independently before use: `factory.feeAmountTickSpacing(3000) == 60`,
`NPM.factory() == UniswapV3Factory`, `NPM.WETH9() == WETH9` above.

## Risk-tier pools (PRD §7.6)

| Tier | Pair | Fee | Pool address | Status |
|---|---|---|---|---|
| **Low** | USDC/WETH | 0.3% | `0xE8Dd26347E5Ef1D98946D81b681db1bC4dEeC44d` | **Live** — real liquidity seeded (LP NFT `#231957`, owned by treasury). Price initialized at 3000 USDC = 1 WETH. |
| **Medium** | USDC/mAAVE | 0.3% | `0xb9a463fdBC9f1be53d582351b631e0EC277B16e0` | **Live** — real liquidity seeded (LP NFT `#231958`, owned by treasury). Price initialized at 100 USDC = 1 mAAVE. |
| **High** | USDC/mDOGE | 1% | `0x90999138f8b1B69b953239Eb1F0D991e601Bbfe2` | **Live** — real liquidity seeded (LP NFT `#231959`, owned by treasury). Price initialized at 1 USDC = 10 mDOGE. |

All three verified independently after seeding (`liquidity()` non-zero,
`token0`/`token1`/`fee` match, `NPM.ownerOf(tokenId)` == treasury) —
not just trusting transaction receipts.

Pool math (token ordering, `sqrtPriceX96`, full-range ticks) for all three
tiers was precomputed with exact BigInt arithmetic before touching chain —
see the low-risk pool above for the pattern if reviving medium/high:
`sqrtPriceX96 = isqrt(amount1Raw * 2**192 / amount0Raw)`, full-range ticks
`[-887220, 887220]` at the 0.3% tier and `[-887200, 887200]` at 1%.

## Treasury / deployer

`0x9205DcCC081D896edeAB423d88665660d61d5bfE` — testnet-only burner key,
lives in `contracts/.env` and `backend/.env` (both gitignored). Funded via
public Sepolia faucets; never used for anything but this project.

## Per-user position open/exit (PRD §6.4/§6.6) — real

`POST /agent/open-position` mints a genuine new LP NFT into the tier's pool
above; `POST /withdraw` decreases its liquidity and collects the proceeds,
valuing the non-USDC side at each pool's fixed init price (not a live
oracle) to fold into the receipt. Verified end-to-end for all three tiers,
both directions (`chain.ts`, `agent.ts`):

| Test | Privy user id | Open tx | Position NFT | Exit result |
|---|---|---|---|---|
| Low | `0xuni-low` | `0x6b1de330...` | `#231960` | liquidity → 0, gross ≈ $2.00 (1 USDC + 0.000333 WETH) |
| Medium | `0xuni-med` | `0x868eae43...` | `#231961` | gross ≈ $20.00 (10 USDC + 0.1 mAAVE) |
| High | `0xuni-high` | `0x99a78ffe...` | `#231962` | gross ≈ $20.00 (100 mDOGE + 10 USDC) |

The treasury supplies the non-USDC side of every open (WETH for low —
wrapped from real ETH, so this is the one operation that costs real
capital, not just gas; mAAVE/mDOGE are freely mintable mocks for
medium/high). Mint amounts are small and fixed per tier, not literally
proportional to the user's deposit — see the "why" comment in `agent.ts`.

## ENS v2 (Sepolia Beta — genuinely live, confirmed on-chain)

Earlier drafts of this doc assumed ENS v2/Namechain testnet availability
was unconfirmed. It's not unconfirmed — it's live. Every address below
was verified two ways before use: bytecode presence, then the *actual*
Etherscan-verified contract name (not a doc summary) via WebFetch, then
cross-checked against a related contract's own on-chain reference (e.g.
`ETHRegistrar.ETH_REGISTRY()` == the `ETHRegistry` address independently
found).

| Contract | Address | Verified as |
|---|---|---|
| `ETHRegistry` (root PermissionedRegistry for `.eth`) | `0xbdc85dd5b15d7ecb354cd7cb6f2c50b4f2c4f0e2` | `PermissionedRegistry` |
| `ETHRegistrar` | `0xa88553f454b77203b0d036a05c894d555eaaa2cc` | `ETHRegistrar`; `.ETH_REGISTRY()` matches the row above exactly |
| `VerifiableFactory` | `0x10dc6333cdfe1fcef624c6e0a8221b91804cd7ef` | `VerifiableFactory` |
| `StandardRentPriceOracle` | `0x8914b66260EB8C4fff795650c3AE8Cd335958987` | accepts real Circle Sepolia USDC (`0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`) as `paymentToken` — **not** ETH, **not** our MockUSDC |

**`wantest.eth` is registered**, owned by the treasury:
- `findOwner("wantest")` → treasury address (independently verified, not just trusting the tx receipt)
- `findExpiry("wantest")` → 2027-09-12 (1-year registration)
- Paid 8.000021 real Circle-USDC (commit tx `0x1cf2f306...`, register tx `0x0a10c61f...`)
- Registered with `address(0)` subregistry/resolver placeholders first (a deliberate lower-risk sequencing — see below), then `setSubregistry` was called once the real registry deployment was confirmed working; `getSubregistry("wantest")` now returns that real registry (see next section). `getResolver("wantest")` is still `address(0)` — no resolver deployed/needed yet.

### Subname registry — real, deployed, issuing real subnames

Found the exact deployment mechanics by getting `RegistryRolesLib.sol`'s
authoritative source from `ensdomains/contracts-v2` on GitHub (via `gh api`,
not a doc summary) rather than guessing a role bitmap, and by confirming
`UserRegistry` (not the root's `PermissionedRegistry`) is the actual
`VerifiableFactory`-clonable implementation, with its own `initialize()`.

| Contract | Address | Verified as |
|---|---|---|
| `UserRegistry` implementation | `0x624a25d67b59d587752ebec8dded8827dae52050` | `UserRegistry`; has `initialize(address,uint256)`, unlike the root's constructor-only `PermissionedRegistry` |
| **Our subregistry for `wantest.eth`** | `0x786441fDe1a4006EadD745A8b90d8621F7a99916` | deployed via `VerifiableFactory.deployProxy`; `factory.verifyContract(...)` confirms it points at the `UserRegistry` impl above |

Deployment used `salt = uint256(keccak256(abi.encode(keccak256("UserRegistry"), namehash("wantest.eth"), 0)))`
and `data = initialize(treasury, ALL_ROLES)`, where `ALL_ROLES` is every
role constant from `RegistryRolesLib.sol` (base + `<<128` admin variant)
OR'd together. Both `namehash("wantest.eth")` and `keccak256("wantest")`
were cross-checked against values that appeared independently inside the
`wantest.eth` registration transaction's own logs — not just internal
consistency, agreement with what the real ENS contracts had already
computed on-chain. Every step (proxy deployment, linking it to
`wantest.eth` via `ETHRegistry.setSubregistry(findTokenId("wantest"), ...)`,
then registering the first real subname) was dry-run via `eth_call`
first — all succeeded with no reverts before any real transaction was sent.

`ETHRegistry.getSubregistry("wantest")` now returns our registry above,
confirmed independently (not just the tx receipt).

**Real subnames issued and independently verified** (`findOwner(label)`
on our registry matches exactly):

| Subname | Owner | Register tx |
|---|---|---|
| `machina.wantest.eth` | `0xb018D435f253f63fff95E3a37a11FA54D9283702` | `0x15ad190b...` |
| `realenstest.wantest.eth` | `0x62F5422C49F448d2D3B57F0dd26F14fF6b43A82B` | `0x0b5a23b4...` |
| `uniswap-1.wantest.eth` | `0x62F5422C49F448d2D3B57F0dd26F14fF6b43A82B` | `0x3ebf71d1...` |

`backend/src/ens.ts` calls this for real now (`registerEnsLabelOnChain` in
`chain.ts`) — `POST /deposit` and `POST /agent/open-position` both mint
genuine subnames, no stub path left for the happy case.

## Identity: World ID → Privy (swapped)

> World ID was removed on 2026-10-10 (Privy email is the only identity layer; flat `DAILY_LIMIT_USD` for all accounts). The notes below are history.

World ID Selfie Check (`backend/src/worldId.ts`, now deleted) was replaced
with Privy (`backend/src/privy.ts`) after its bridge/QR handoff never got a
scanned phone to actually connect — repeated real attempts (with the SDK's
own `getDebugReport()` logged) sat at `waiting_for_connection` forever, even
after registering the missing World ID action via the
`worldcoin-developer-portal` MCP. Privy needs no phone, no QR, no bridge:
the kiosk takes an email on-screen, the backend calls `users().create()` /
`users().getByEmailAddress()` directly (server-to-server, app secret auth)
and gets back a real embedded wallet synchronously. Sybil-resistance signal
is now "one email → one Privy user" — weaker than World ID's biometric
uniqueness proof, a deliberate trade for something that actually works in
the time available.

`PRIVY_APP_ID` / `PRIVY_APP_SECRET` are set in `backend/.env` (from
dashboard.privy.io) and **verified working end-to-end**: real Privy user +
embedded wallet returned synchronously (no polling), same email correctly
reuses the same user (`reused: true`, no duplicate wallet), backend stayed
alive throughout.

**New-account funding:** every brand-new Privy user (first-time
`users().create()` only — not repeat logins) gets **0.001 real Sepolia ETH**
sent from the treasury to their embedded wallet, so they have gas for
anything they do with it themselves later (`fundWalletWithEthOnChain` in
`chain.ts`, gated in `privy.ts`). Verified: a fresh test wallet
(`0xEe411b45...`) received exactly 0.001 ETH (tx `0x9d6c4ba1...`); a
second `/verify` with the *same* email correctly returned `reused: true`
with no `fundingTxHash` and no balance change — confirmed via independent
`cast balance` checks both times, not just trusting the API response.
A funding failure (e.g. treasury low on ETH) is caught and logged without
failing the account creation itself — the user still gets a real wallet,
just no gas yet.

## ATM-style flow reorder (verify-then-deposit)

Backend now authenticates before it accepts cash, matching a real ATM
instead of the original "cash in blind, identify after" order:

- `POST /verify { email }` runs **first**: resolves/creates the Privy user,
  and — new-account only — derives an ENS label from the email
  (`deriveEnsLabel` in `ens.ts`, collision-avoiding hash suffix, e.g.
  `alice-4f2a.wantest.eth`) and registers it immediately, before any money
  has moved. Returns `{ userId, ensName, balance: 0 }` synchronously.
- `POST /deposit { userId, amount }` runs **second**: credits the account
  identified by `userId` (already known from `/verify`), no more inline
  `{handle, email}`/ENS-registration-on-deposit path.
- `backend/src/store.ts` was rewritten to match: `User`+`Wallet` merged into
  one `Account` type keyed by `privyUserId`, with `deriveBoundAddress`
  exported for the deterministic bookkeeping address. `routes/withdraw.ts`,
  `routes/agentRoutes.ts`, `routes/position.ts` updated to look accounts up
  by `userId` through this single store.
- Verified end-to-end via curl and a Playwright kiosk run (email →
  `atm-ui-test-2-feb1.wantest.eth` registered and new wallet funded with
  0.001 ETH at verify-time, deposit afterward credited the same account) —
  see PRD §6.1/§6.2/§8 for the updated flow and sequence diagram.

## Claude Haiku 4.5 decision-making — now real

`backend/src/agent.ts`'s `chooseRiskTierWithAgent()` makes a genuine
`@anthropic-ai/sdk` call to `claude-haiku-4-5-20251001` (`ANTHROPIC_API_KEY`
in `backend/.env`) before every `POST /agent/open-position` mint. It's given
the live pool data (`getPoolsInfo()` — real pair/fee/APY, not hardcoded
strings) plus the user's chosen risk tier and deposit amount, and returns a
one-sentence rationale grounded in that data.

**Guardrail (PRD §10):** the model has no authority to change the user's
risk tier — `chooseRiskTierWithAgent` always mints into the tier the user
picked on the kiosk screen; a mismatched `riskTier` in Claude's JSON reply
is logged as a warning and discarded, never acted on. This is a deliberate
match for the security posture already in place for the agent's on-chain
actions: it proposes/explains, the backend's own tier-scoped logic is what
actually executes.

**Resilience:** any API failure (bad key, timeout, malformed JSON) falls
back to a canned per-tier rationale rather than blocking the mint — verified
by triggering a real failure (an unsupported `output_config.effort` param
on Haiku 4.5) and confirming the position still opened correctly with the
fallback text logged.

**Verified end-to-end, not just trusted:** real API call → response logged
as `[agent] model=claude-haiku-4-5-20251001 confirmed risk=low: "USDC/ETH at
0.3% fee offers stable stablecoin-to-major-asset exposure with modest 3.2%
APY, matching your low-risk selection."` — the rationale cites the pool's
actual fee/APY figures it was given, confirming it's reasoning over the real
JSON rather than echoing a template. The resulting mint tx
(`0xe2b46783...`) was independently confirmed on-chain (`status: 1`, a real
NFT `Transfer` at the NonfungiblePositionManager address) via `cast
receipt`, not just the API's own response.

Two real bugs were caught and fixed by this live test rather than assumed
away: Haiku 4.5 rejects `output_config.effort` (Anthropic API error,
`invalid_request_error`) — removed; and Haiku sometimes wraps its JSON
reply in a ` ```json ` fence despite being told not to — now stripped
before `JSON.parse`.

The rationale is threaded all the way to the kiosk: `POST
/agent/open-position`'s response includes `rationale`, and
`device-agent/public/app.js` logs it (`agent: "..."`) right after the
position-opened line.

## tkCASH and Curvegrid MultiBaas

`TakarabakoCashReceipt` (tkCASH) is deployed on its own with
`contracts/script/DeployCashReceipt.s.sol`, so the verified contracts above
stay as they are. **Verified on Sepolia Etherscan as an exact source-code
match**, re-confirmed through Etherscan's `getsourcecode` API rather than the
CLI's own message (compiler 0.8.28, optimizer 200 runs):

| Contract | Address | Etherscan |
|---|---|---|
| `TakarabakoCashReceipt (tkCASH)` | `0x8023edf927c0a53f5620998f972b3d0740e04ea9` | [Verified](https://sepolia.etherscan.io/address/0x8023edf927c0a53f5620998f972b3d0740e04ea9#code) |

Deployed in block 11784052 (tx `0x15513552d1…`), with kiosk `kl-sentral-01`
registered in the same block (`setKiosk`, tx `0xab09547f99…`). Checked on-chain
afterwards with `cast call`: `owner()` is the treasury
`0x9205DcCC081D896edeAB423d88665660d61d5bfE`, `symbol()` is `tkCASH`,
`decimals()` is 6, and `kiosks("kl-sentral-01")` is active, not frozen, with a
zero reserve.

How it was deployed and verified (constructor arg: the treasury address as `initialOwner`):

```bash
cd contracts
KIOSK_ID=kl-sentral-01 forge script script/DeployCashReceipt.s.sol --rpc-url $RPC_URL --broadcast --private-key $PRIVATE_KEY
forge verify-contract 0x8023edf927c0a53f5620998f972b3d0740e04ea9 src/TakarabakoCashReceipt.sol:TakarabakoCashReceipt \
  --chain sepolia --etherscan-api-key $ETHERSCAN_API_KEY \
  --constructor-args $(cast abi-encode "constructor(address)" 0x9205DcCC081D896edeAB423d88665660d61d5bfE)
```

MultiBaas deployment host (Sepolia, free tier): `lfozlu7lwjb2bl25fgqbersp6u.multibaas.com`. Only the host is recorded here, never the API key or webhook secret.

`npm run mb:setup` (backend) creates these labels and aliases:

| Label | Contract | Alias | Address |
|---|---|---|---|
| `takarabako_vault` | `TakarabakoVault` | `vault` | `0xD069D36Af7DF950EE87002Fc120B90eF5Ea3ce3D` |
| `takarabako_cash_receipt` | `TakarabakoCashReceipt` | `tkcash` | `0x8023edf927c0a53f5620998f972b3d0740e04ea9` |
| `mock_usdc` | `MockUSDC` | `musdc` | `0x6cc5f175810e61A56508049f0527BC75EB7e77e4` |
| `uniswap_v3_npm` | `NonfungiblePositionManager` (events + `positions` only) | `uniswap-npm` | `0x1238536071E1c677A632429e3655c799b22cDA52` |
| `ens_user_registry` | `UserRegistry` (`LabelRegistered`, `register`, `findOwner`) | `ens-wantest` | `0x786441fDe1a4006EadD745A8b90d8621F7a99916` |

Plus `treasury` → the treasury signer, and one alias per customer (their
ENS label → their Privy wallet), created at registration.

## 1inch Aqua yield (Sepolia)

| Contract | Address | Notes |
|---|---|---|
| 1inch `Aqua` | `0x1111113ccf1426a8e30e2bff5e005d929bf6a90a` | Same address as mainnet; present on Sepolia though the SDK's address list omits it |
| `AquaSwapVMRouter` | `0x1111113db0e0ef9d0e3a50d5f094a3a57a26c0de` | The router's previous address; `eip712Domain()` reports "1inch SwapVM v1.0" / 1.0.2 on chain 11155111 and `AQUA()` returns the Aqua address above. The current mainnet router address (`0x11111133…ac0de`) has no code on Sepolia |
| `MockRiskToken (mETH)` | `0x5A9E9fF59AeBb96C14DFaB7C2a43d0C130ba9282` | Ours — `contracts/script/DeployMockEth.s.sol`, 18 decimals, 1M minted to the treasury; [Etherscan](https://sepolia.etherscan.io/address/0x5A9E9fF59AeBb96C14DFaB7C2a43d0C130ba9282#code) shows it verified (same bytecode as the other mocks) |

Verified on-chain before building on it: a concentrated strategy shipped
(tx `0x6d8ceb35…`) quoted 100 mUSDC → 0.03318 mETH and 0.01 mETH → 29.90 mUSDC
around a $3,000 spot; a USDC-only bid at $2,400–2,700 (tx `0x021858f7…`) took a
real swap from the treasury as taker (tx `0x0fc339df…`), leaving 973.12 of 1,000
mUSDC. Both probe strategies were docked afterwards. The treasury approved Aqua
(to pull as maker) and the router (to pay as taker) for mETH and mUSDC.

MultiBaas links the Aqua contract as `oneinch_aqua` (alias `aqua`) in the slot
that held Uniswap's position manager; a saved query `aqua_pulled_by_token`
sums swap volume out of our strategies.

## ENS v2 — official Sepolia deployment (takarabako.eth)

The earlier `wantest.eth` (above) sits on the Sepolia *beta* deployment; the
official `UniversalResolverV2` (`0x2f8a180604c42457cb56c7c4f708748ff1f91df1`)
resolves through a different root (`0xc960F7217d3643B525Ef36Bec8Adf86953CD9aB8`
→ `.eth` registry `0xdedb92913a25abe1f7bcdd85d8a344a43b398b67`), which has no
`wantest`. So names moved to `takarabako.eth` there (addresses from
`ensdomains/contracts-v2` `deployments/sepolia-official-v1-20260525-r2`,
checked on-chain).

| What | Address / value |
|---|---|
| `takarabako.eth` | registered with the official `ETHRegistrar` (`0x8c2e866b…affca`) for 1 year, 7.99 of the deployment's open-mint MockUSDC (register tx `0x3dd28cec…`) |
| Our `UserRegistry` (subnames) | `0x73153594ec5349f2ea191e39b9ec1e2fe4fa4b99` — deployed via the official `VerifiableFactory`, which verifies it points at `UserRegistryImpl` |
| Our `PermissionedResolver` (records) | `0x6ef4efc23141edf959bcad3b8f3d213f9b244905` — same factory, `PermissionedResolverImpl` |
| `kl-sentral-01.takarabako.eth` | addr → `0xb3F9928aD5E659b8d22A556FbcfF545cf49EC9f5`, the Pi's device key; `takarabako.kind=kiosk` |

Checked through the official `UniversalResolverV2`: `takarabako.eth` → the
treasury; `aqiljeff-6263.takarabako.eth` → the customer's Privy wallet;
`kl-sentral-01.takarabako.eth` → the device key. The first signed note
(nonce 1) was verified end to end: signer recovered from the Pi's signature ==
the kiosk name's address record.

tkCASH's daily transfer limit is now set on-chain to $500
(`setDailyTransferLimit`, tx `0xae068973…`). MultiBaas links our UserRegistry
as `takarabako_names` (the beta registry link was retired).

### Kiosk renamed: kl-sentral-01 → tokyo-01

The kiosk is now `tokyo-01`. On tkCASH, `setKiosk(tokyo-01, true)` (tx
`0x52fe4df9…`) put it in service and `setKiosk(kl-sentral-01, false)` (tx
`0x1a656cbe…`) retired the old one: no new cash-ins there, but its reserve
(122.33 at the switch) stays redeemable — the backend burns against the
current kiosk first, then retired ones (`KIOSK_PREVIOUS_IDS`). On ENS,
`tokyo-01.takarabako.eth` resolves to the same Pi device key
(`0xb3F9…C9f5`, `takarabako.kind=kiosk`), and `kl-sentral-01.takarabako.eth`
is marked `takarabako.kind=retired-kiosk`, so notes signed as the old kiosk
no longer verify. The first note signed as `tokyo-01.takarabako.eth`
verified end to end and minted against Tokyo's reserve.

## Solana devnet

Treasury `HQ6Q4Sdu21h7NKiNZpmBecJMT8DJWEJ4cV4VaCQk6ZJ3` (funded from faucet.solana.com).

| What | Address | How it was verified |
|---|---|---|
| mUSD (Token-2022) | `G9kbAWLmKRr8PYz3x2rrbq4CnurkPx14dQnbYz343DsS` | owner program `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`; extensions exactly MetadataPointer + TokenMetadata; "Takarabako Mock USD" / mUSD, 6 decimals; mint authority = treasury; no freeze authority. Created in tx `5bdY3Zbp8NYK1ePxMJ4im9QvPv4h9xFsXekqy7nwF1GCVKAB9JUptQKmMr2rE7EjCsUcNjErxf88rBVNaTnopZPo` |
| DLMM V2 pair (wSOL = X, mUSD = Y) | `2U8tBjTahgLvMv1QboFCZJ8aKdNPFRnLwY47pReS2spg` | owner `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo`; customizable permissionless pair (`createCustomizablePermissionlessLbPair2`), bin step 10, base fee 0.25% (25 bps), initial price ~149.86 mUSD/SOL (active bin -1899); fee read back on-chain via `DLMM.create` + `calculateFeeInfo`. Created in tx `8dVd8Xh8e4UtfXv2qNiRKqUGgNPXtE312KVVMpbF6w4GJumt82VGEqps155teKJ8zqJHcMhYYYbXttBY5g4YmTE` |
| Seed position | `CUU6Xpjxt8KmbAVqf7JCQhsg9CpikUZTnLDxLdcqNBkD` | bins -1929..-1869 Spot, 0.5 SOL + 75 mUSD; tx `57w1BJ8gc79auMfqpzGvKJKbRZxhEz4F83JXhj8vXeB8ngsReKTRj7Vk8HgCugtFkLGU64wFzSzWpFj6W7ho6kFg` |

**Why a customizable pair.** All four devnet `PresetParameter2` accounts
(`4vP4DFDJ…gekn`, `7FEVd6Lp…97z`, `BB2atM1V…vwg`, `CDdy228D…Rabs`) are bin step
10 / baseFactor 10000 / power 2, a 10% base fee. A first pair on that preset
(`G1YDVGS8GiWcSoerdj7751CTzTsjhR9renS9gxcaAkHC`) was abandoned; its seed
position was withdrawn (tx `4MZPuC5xcjuW6uGE3E4FZFKeK3n5hbDc6ucFH2Z7u5kyjxp7hXyP74A61z6eHbPsTpb7ts9GwwsH67gZ4b7tkH1W`,
position account closed).

**`npm run sol:smoke` (2026-10-10, live pair).** Each tier opened and closed on
devnet and was checked on-chain rather than by trusting receipts:

- Low, bins [-1959,-1900]: paid 4.99998 of 5 mUSD.
- Medium, bins [-1929,-1900]: paid 4.999985.
- High, bins [-1909,-1900]: paid 4.999995. These are single-sided mUSD below the price, so out of range and no SOL.
- Swap leg (High): the price was moved by swapping 0.15 SOL (active bin -1899 to -1907); the position held 2.353717 mUSD + 0.017786484 SOL. Close swapped the SOL back for 2.63686 mUSD (tx `5JCveBRaX3MY26S12UZwdmbVcqDRXihz4Sz6Khf9cfpg8G7W8sHZucrtfWfxSWQeawG8Qq8rxo9YXRY3YDheJT58`; the recorded swap output matched the treasury's on-chain mUSD gain exactly). Payout 4.990577 mUSD (tx `Qf5tXu5fd6zDHhgs5C35UXKLwGhnTxc7wZXEwDb1QBt1ijVyaCw6o2XhQkHofUnQBPDTk7xvpX6CCY9iJM5m2C8`).
- Position accounts were verified closed afterwards, and customer wallet gains equal the recorded payouts.

Integration note: `@meteora-ag/dlmm` 1.9.x's ESM build can't load under Node,
so `backend/src/solana/dlmmCjs.ts` loads the CJS build.
