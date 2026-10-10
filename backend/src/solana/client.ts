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
const isSettled = (s: string | undefined) => s === "confirmed" || s === "finalized";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/// Waits until the transaction is confirmed, has failed on-chain, or can no
/// longer land. "expired" is returned only once the FINALIZED block height is
/// past lastValidBlockHeight (the blockhash can then never be included), so
/// "expired" and "failed" both mean it is safe to build and send a new one.
/// A thrown error means "unknown" (still pending / RPC trouble): re-check the
/// stored signature later, never treat it as failed.
export async function confirm(signature: string, lastValidBlockHeight: number, timeoutMs = 180_000): Promise<Outcome> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { value } = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
    const st = value[0];
    // An error at "processed" can still be rolled back by a fork: only trust it once confirmed.
    if (st?.err && isSettled(st.confirmationStatus)) {
      console.error(`[solana] ${signature} failed:`, JSON.stringify(st.err));
      return "failed";
    }
    if (st && !st.err && isSettled(st.confirmationStatus)) return "confirmed";
    // The confirmed height passing is only the cue to check the finalized one:
    // until finalized passes too, the transaction could still be included.
    if (
      (await connection.getBlockHeight("confirmed")) > lastValidBlockHeight &&
      (await connection.getBlockHeight("finalized")) > lastValidBlockHeight
    ) {
      // One last look — it may have landed in the final valid block.
      const again = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
      if (again?.err && isSettled(again.confirmationStatus)) {
        console.error(`[solana] ${signature} failed:`, JSON.stringify(again.err));
        return "failed";
      }
      if (again && !again.err && isSettled(again.confirmationStatus)) return "confirmed";
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
