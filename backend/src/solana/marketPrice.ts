import { NATIVE_MINT } from "@solana/spl-token";
import { config } from "../config.js";

/// Real SOL/USD from Solami's market data (mainnet, liquidity-weighted across
/// pools). Our pair lives on devnet, where the price is whatever the pool
/// says; this is the reference it is compared against on /ops. Read-only and
/// best-effort: no key or a failed fetch gives null, never an error.

export interface MarketPrice {
  solUsd: number;
  at: number; // unix seconds of the last trade behind the price
  source: "solami";
}

const TTL_MS = 30_000;
let cache: { value: MarketPrice; fetchedAt: number } | null = null;

/// Picks wSOL's row out of a GET /data/token/price response.
export function parseSolamiPrice(body: unknown): MarketPrice | null {
  if (!Array.isArray(body)) return null;
  const row = body.find((r) => r && typeof r === "object" && (r as { mint?: unknown }).mint === NATIVE_MINT.toBase58()) as
    | { price_usd?: unknown; block_time?: unknown }
    | undefined;
  const solUsd = Number(row?.price_usd);
  if (!row || !Number.isFinite(solUsd) || solUsd <= 0) return null;
  return { solUsd, at: Number(row.block_time) || 0, source: "solami" };
}

/// How far the pool price sits from the market, in percent (+ = pool above).
export function driftPct(poolUsd: number, marketUsd: number): number {
  return Math.round(((poolUsd - marketUsd) / marketUsd) * 10_000) / 100;
}

export async function solMarketPrice(fetchImpl: typeof fetch = fetch): Promise<MarketPrice | null> {
  if (!config.solami.apiKey) return null;
  if (cache && Date.now() - cache.fetchedAt < TTL_MS) return cache.value;
  try {
    const url = new URL("/data/token/price", config.solami.apiUrl);
    url.searchParams.set("chain", "solana");
    url.searchParams.set("address", NATIVE_MINT.toBase58());
    const res = await fetchImpl(url, { headers: { "x-api-key": config.solami.apiKey }, signal: AbortSignal.timeout(5_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const value = parseSolamiPrice(await res.json());
    if (!value) throw new Error("no SOL price in response");
    cache = { value, fetchedAt: Date.now() };
    return value;
  } catch (err) {
    console.error("[solami] SOL price fetch failed:", err instanceof Error ? err.message : err);
    return cache?.value ?? null; // a stale price beats none
  }
}
