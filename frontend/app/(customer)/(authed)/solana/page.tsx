import type { Metadata } from "next";
import type { Me } from "@/lib/types";
import { loadForPage } from "@/lib/serverData";
import { SolanaEarn } from "./SolanaEarn";

export const metadata: Metadata = { title: "Solana · Takarabako" };

export default async function SolanaPage() {
  const me = await loadForPage<Me>("/me");
  return (
    <>
      <h1 style={{ fontSize: 26 }}>Solana</h1>
      <p className="muted">
        Put the mUSD in your Solana wallet to work in a Meteora liquidity pool. You approve one transfer; Takarabako pays
        the network fee.
      </p>
      <SolanaEarn leftToday={me.limit?.leftUsd ?? null} />
    </>
  );
}
