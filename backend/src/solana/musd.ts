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
