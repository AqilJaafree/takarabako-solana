// Creates (idempotently) the devnet mUSD mint and the mUSD/wSOL DLMM V2 pair,
// and seeds a two-sided treasury position so the pair has a live price.
//   cd backend && npm run sol:setup
// @meteora-ag/dlmm's ESM build can't load under Node — use the CJS shim.
import { Keypair, PublicKey } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, getMint, getMetadataPointerState } from "@solana/spl-token";
import type { LBCLMM_PROGRAM_IDS, deriveLbPairWithPresetParamWithIndexKey } from "@meteora-ag/dlmm";
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
// The pair address is a PDA of (preset parameter, sorted mints), so it is
// derived directly instead of scanning every pair with getLbPairs (slow and
// rate-limited on public devnet RPC). That also makes a re-run after a crash
// between "pair created" and ".env updated" safe.
await checkBalance("pair");
let pairKey = config.solana.dlmmPair ? new PublicKey(config.solana.dlmmPair) : null;
if (!pairKey) {
  const { presetParameter2 } = await DLMM.getAllPresetParameters(connection, OPT);
  // Prefer bin step 10 (0.1%) — fine-grained enough for a stable/SOL pair.
  // Several presets can share a bin step: pick the lowest base factor, then
  // by address, so the choice is stable across runs.
  const sorted = [...presetParameter2].sort(
    (a, b) => a.account.binStep - b.account.binStep || a.account.baseFactor - b.account.baseFactor || a.publicKey.toBase58().localeCompare(b.publicKey.toBase58()),
  );
  const preset = sorted.find((p) => p.account.binStep === 10) ?? sorted[0];
  if (!preset) throw new Error("no PresetParameter2 on devnet");
  console.log("preset", preset.publicKey.toBase58(), "bin step", preset.account.binStep, "base factor", preset.account.baseFactor);
  const [derived] = dlmmCjs.deriveLbPairWithPresetParamWithIndexKey(preset.publicKey, NATIVE_MINT, mint, PROGRAM_ID);
  const existing = await connection.getAccountInfo(derived, "confirmed");
  if (existing) {
    console.log("DLMM pair already exists", derived.toBase58());
  } else {
    const pricePerLamport = DLMM.getPricePerLamport(9, mintInfo.decimals, config.solana.initialSolPriceUsd);
    const activeId = new BN(DLMM.getBinIdFromPrice(pricePerLamport, preset.account.binStep, true));
    const tx = await DLMM.createLbPair2(connection, t.publicKey, NATIVE_MINT, mint, preset.publicKey, activeId, OPT);
    const sig = await sendAndConfirm(tx);
    console.log("created DLMM pair", derived.toBase58(), "bin step", preset.account.binStep, "active id", activeId.toString(), "tx", sig);
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
console.log("\npair", pairKey.toBase58(), "bin step", pool.lbPair.binStep);
console.log("active bin", active.binId, "price", active.pricePerToken, "mUSD/SOL", "x", active.xAmount.toString(), "y", active.yAmount.toString());
await checkBalance("done");
console.log("\nPut these in backend/.env:");
console.log(`MUSD_MINT=${mint.toBase58()}`);
console.log(`DLMM_PAIR=${pairKey.toBase58()}`);
