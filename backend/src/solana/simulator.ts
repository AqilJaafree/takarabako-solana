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
