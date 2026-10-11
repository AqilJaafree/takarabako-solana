import { createHash } from "node:crypto";
import { ComputeBudgetProgram, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
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
  /// Binds the transaction to its position row, so one signed transfer can't fund two.
  memo: string;
}

const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

const ata = (mint: PublicKey, owner: PublicKey) => getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022_PROGRAM_ID);

export function buildFundingTx(p: FundingParams): Transaction {
  return new Transaction({ feePayer: p.treasury, blockhash: p.blockhash, lastValidBlockHeight: p.lastValidBlockHeight }).add(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: p.priorityMicroLamports }),
    createTransferCheckedInstruction(ata(p.mint, p.owner), p.mint, ata(p.mint, p.treasury), p.owner, p.amountRaw, MUSD_DECIMALS, [], TOKEN_2022_PROGRAM_ID),
    new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [], data: Buffer.from(p.memo, "utf8") }),
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
