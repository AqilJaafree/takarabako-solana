// Creates (idempotently) the devnet mUSD mint and the mUSD/wSOL DLMM V2 pair,
// and seeds a two-sided treasury position so the pair has a live price.
//   cd backend && npm run sol:setup
// @meteora-ag/dlmm's ESM build can't load under Node — use the CJS shim.
import { Keypair, PublicKey } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, getMint, getMetadataPointerState } from "@solana/spl-token";
import type { ActivationType, LBCLMM_PROGRAM_IDS, deriveCustomizablePermissionlessLbPair, deriveLbPairWithPresetParamWithIndexKey } from "@meteora-ag/dlmm";
import BN from "bn.js";
import { createRequire } from "node:module";
import { config } from "../src/config.js";
import { connection, sendAndConfirm, treasury, treasurySol } from "../src/solana/client.js";
import { DLMM, StrategyType } from "../src/solana/dlmmCjs.js";
import { createMusdMint, mintToTx } from "../src/solana/musd.js";

// Named helpers from the same CJS build (type-only import above for names).
const dlmmCjs = createRequire(import.meta.url)("@meteora-ag/dlmm") as {
  LBCLMM_PROGRAM_IDS: typeof LBCLMM_PROGRAM_IDS;
  deriveLbPairWithPresetParamWithIndexKey: typeof deriveLbPairWithPresetParamWithIndexKey;
  deriveCustomizablePermissionlessLbPair: typeof deriveCustomizablePermissionlessLbPair;
  ActivationType: typeof ActivationType;
};

const OPT = { cluster: "devnet" as const };
const PROGRAM_ID = new PublicKey(dlmmCjs.LBCLMM_PROGRAM_IDS.devnet);
const MIN_SOL = 1;
const t = treasury();

async function checkBalance(step: string) {
  const sol = await treasurySol();
  console.log(`[${step}] treasury ${t.publicKey.toBase58()} ${sol.toFixed(4)} SOL`);
  if (sol < MIN_SOL) throw new Error(`treasury below ${MIN_SOL} SOL — stopping`);
}

// 1. mint
await checkBalance("mint");
let mint = config.solana.musdMint ? new PublicKey(config.solana.musdMint) : null;
if (!mint) {
  const created = await createMusdMint();
  mint = created.mint;
  console.log("created mUSD mint", mint.toBase58(), "tx", created.signature);
}
const mintInfo = await getMint(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
console.log("mUSD mint", mint.toBase58(), "decimals", mintInfo.decimals, "metadata pointer", getMetadataPointerState(mintInfo)?.metadataAddress?.toBase58());
process.env.MUSD_MINT = mint.toBase58();
(config.solana as { musdMint: string }).musdMint = mint.toBase58();

// 2. pair — X = wSOL, Y = mUSD, so the price is mUSD per SOL.
// The pair address is a PDA, so it is derived directly instead of scanning
// every pair with getLbPairs (slow and rate-limited on public devnet RPC).
// That also makes a re-run after a crash between "pair created" and ".env
// updated" safe.
//
// The pair's base swap fee is what a customer loses when an Earn position
// that bought SOL is swapped back to mUSD, so pick it by the actual fee rate
// — DLMM.calculateFeeInfo(baseFactor, binStep, baseFeePowerFactor) — not by
// baseFactor alone (baseFeePowerFactor scales it: devnet's bin-step-10
// presets have baseFactor 10000 and power 2 = a 10% fee). Prefer bin step 10
// and a preset whose base fee is within FEE_MIN..FEE_MAX % (closest to
// FEE_TARGET). If no preset qualifies, create a customizable permissionless
// pair (one per mint pair) with exactly FEE_TARGET.
const BIN_STEP = 10;
const FEE_TARGET = 0.25; // %
const FEE_MIN = 0.1;
const FEE_MAX = 0.3;
const feePct = (a: { baseFactor: number; binStep: number; baseFeePowerFactor?: number }) =>
  Number(DLMM.calculateFeeInfo(a.baseFactor, a.binStep, a.baseFeePowerFactor ?? 0).baseFeeRatePercentage.toString());

await checkBalance("pair");
const { presetParameter2 } = await DLMM.getAllPresetParameters(connection, OPT);
const candidates = presetParameter2
  .map((p) => ({ p, fee: feePct(p.account) }))
  .filter((c) => c.p.account.binStep === BIN_STEP && c.fee >= FEE_MIN && c.fee <= FEE_MAX)
  .sort((a, b) => Math.abs(a.fee - FEE_TARGET) - Math.abs(b.fee - FEE_TARGET) || a.p.publicKey.toBase58().localeCompare(b.p.publicKey.toBase58()));
for (const p of presetParameter2) console.log("  preset", p.publicKey.toBase58(), "bin step", p.account.binStep, "base factor", p.account.baseFactor, "power", p.account.baseFeePowerFactor, "fee", `${feePct(p.account)}%`);
const chosen = candidates[0]?.p ?? null;
const derived = chosen
  ? dlmmCjs.deriveLbPairWithPresetParamWithIndexKey(chosen.publicKey, NATIVE_MINT, mint, PROGRAM_ID)[0]
  : dlmmCjs.deriveCustomizablePermissionlessLbPair(NATIVE_MINT, mint, PROGRAM_ID)[0];
console.log(
  chosen
    ? `chosen preset ${chosen.publicKey.toBase58()} bin step ${chosen.account.binStep} fee ${feePct(chosen.account)}%`
    : `no bin-step-${BIN_STEP} preset with a ${FEE_MIN}-${FEE_MAX}% fee; using a customizable permissionless pair at ${FEE_TARGET}%`,
);
let pairKey = config.solana.dlmmPair ? new PublicKey(config.solana.dlmmPair) : null;
if (pairKey && !pairKey.equals(derived)) console.warn(`DLMM_PAIR ${pairKey.toBase58()} is not the pair this setup would use (${derived.toBase58()}) — keeping DLMM_PAIR`);
if (!pairKey) {
  if (await connection.getAccountInfo(derived, "confirmed")) {
    console.log("DLMM pair already exists", derived.toBase58());
  } else {
    const pricePerLamport = DLMM.getPricePerLamport(9, mintInfo.decimals, config.solana.initialSolPriceUsd);
    const activeId = new BN(DLMM.getBinIdFromPrice(pricePerLamport, BIN_STEP, true));
    const tx = chosen
      ? await DLMM.createLbPair2(connection, t.publicKey, NATIVE_MINT, mint, chosen.publicKey, activeId, OPT)
      : await DLMM.createCustomizablePermissionlessLbPair2(
          connection, new BN(BIN_STEP), NATIVE_MINT, mint, activeId, new BN(Math.round(FEE_TARGET * 100)), // fee in bps
          dlmmCjs.ActivationType.Timestamp, false, t.publicKey, undefined, false, undefined, undefined, OPT,
        );
    const sig = await sendAndConfirm(tx);
    console.log("created DLMM pair", derived.toBase58(), "bin step", BIN_STEP, "active id", activeId.toString(), "tx", sig);
  }
  pairKey = derived;
}

// 3. seed: 0.5 SOL above and the matching mUSD below the price, spot shape.
const pool = await DLMM.create(connection, pairKey, OPT);
const { userPositions } = await pool.getPositionsByUserAndLbPair(t.publicKey);
if (userPositions.length === 0) {
  await checkBalance("seed");
  const active = await pool.getActiveBin();
  const seedSol = new BN(500_000_000); // 0.5 SOL
  const seedMusdUsd = 0.5 * config.solana.initialSolPriceUsd;
  const mintSig = await sendAndConfirm(mintToTx(t.publicKey, seedMusdUsd));
  console.log("minted", seedMusdUsd, "mUSD to treasury, tx", mintSig);
  const position = Keypair.generate();
  const tx = await pool.initializePositionAndAddLiquidityByStrategy({
    positionPubKey: position.publicKey,
    user: t.publicKey,
    totalXAmount: seedSol,
    totalYAmount: new BN(Math.round(seedMusdUsd * 10 ** mintInfo.decimals)),
    strategy: { minBinId: active.binId - 30, maxBinId: active.binId + 30, strategyType: StrategyType.Spot },
    slippage: 1,
  });
  const sig = await sendAndConfirm(tx, [position]);
  console.log("seeded position", position.publicKey.toBase58(), "tx", sig);
} else {
  for (const p of userPositions) {
    console.log("existing position", p.publicKey.toBase58(), "bins", p.positionData.lowerBinId, "..", p.positionData.upperBinId, "X", p.positionData.totalXAmount, "Y", p.positionData.totalYAmount);
  }
}

await pool.refetchStates();
const active = await pool.getActiveBin();
const pairInfo = await connection.getAccountInfo(pairKey, "confirmed");
const params = pool.lbPair.parameters;
console.log("\npair", pairKey.toBase58(), "owner", pairInfo?.owner.toBase58(), "bin step", pool.lbPair.binStep,
  "base fee", `${feePct({ baseFactor: params.baseFactor, binStep: pool.lbPair.binStep, baseFeePowerFactor: params.baseFeePowerFactor })}%`);
console.log("active bin", active.binId, "price", active.pricePerToken, "mUSD/SOL", "x", active.xAmount.toString(), "y", active.yAmount.toString());
await checkBalance("done");
console.log("\nPut these in backend/.env:");
console.log(`MUSD_MINT=${mint.toBase58()}`);
console.log(`DLMM_PAIR=${pairKey.toBase58()}`);
