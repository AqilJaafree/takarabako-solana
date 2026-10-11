"use client";

import { useCallback } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { useSignTransaction, useWallets } from "@privy-io/react-auth/solana";

const toBytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const toBase64 = (bytes: Uint8Array) => btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""));

/// Has the customer sign (not send) a Solana transaction the backend
/// prepared, in their Privy Solana wallet. Returns the signed transaction,
/// base64; the backend checks it, co-signs as fee payer and sends it.
export function useSolanaSign() {
  const { ready, authenticated, login } = usePrivy();
  const { wallets, ready: walletsReady } = useWallets();
  const { signTransaction } = useSignTransaction();

  return useCallback(
    async (txBase64: string, address: string): Promise<string> => {
      if (!ready || !walletsReady) throw new Error("wallet is still loading — try again in a moment");
      if (!authenticated) {
        login();
        throw new Error("sign in to your wallet, then press Earn again");
      }
      const wallet = wallets.find((w) => w.address === address);
      if (!wallet) throw new Error("your Takarabako Solana wallet isn't available in this browser — log out and in again");
      const { signedTransaction } = await signTransaction({ transaction: toBytes(txBase64), wallet, chain: "solana:devnet" });
      return toBase64(signedTransaction);
    },
    [ready, walletsReady, authenticated, login, wallets, signTransaction],
  );
}
