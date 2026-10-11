"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { SolanaMe, SolanaPosition } from "@/lib/types";
import { SOLSCAN_ACCOUNT, SOLSCAN_TX, shortAddr, usd } from "@/lib/format";

/// Solana side of My box: wallet + mUSD balance, and Meteora Earn positions.
export function SolanaCard({ refreshKey, showEarnLink = true }: { refreshKey: number; showEarnLink?: boolean }) {
  const [data, setData] = useState<SolanaMe | null>(null);
  const [closing, setClosing] = useState<string | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/solana/me", { cache: "no-store" });
      if (res.ok) setData(await res.json());
    } catch {
      /* keep the last good data */
    }
  }, []);
  useEffect(() => {
    let live = true;
    fetch("/api/solana/me", { cache: "no-store" })
      .then((res) => (res.ok ? (res.json() as Promise<SolanaMe>) : null))
      .then((d) => {
        if (live && d) setData(d);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [refreshKey]);

  async function close(p: SolanaPosition) {
    setClosing(p.id);
    setError("");
    try {
      const res = await fetch(`/api/solana/positions/${p.id}/close`, { method: "POST" });
      if (!res.ok) setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "couldn't close");
    } catch {
      setError("couldn't close");
    }
    setClosing(null);
    void load();
  }

  if (!data?.ready || (!data.wallet && data.positions.length === 0)) return null;
  return (
    <section className="card">
      <div className="spread">
        <h2>Solana</h2>
        {data.wallet && (
          <a className="small mono" href={SOLSCAN_ACCOUNT(data.wallet)} target="_blank" rel="noreferrer">
            {shortAddr(data.wallet)}
          </a>
        )}
      </div>
      <p className="spread">
        <span>
          {usd(data.musd ?? 0)} <span className="muted small">mUSD in your wallet</span>
        </span>
        {showEarnLink && (data.musd ?? 0) > 0 && (
          <Link href="/solana" className="small">
            Earn with your mUSD →
          </Link>
        )}
      </p>
      {data.positions.length > 0 && (
        <ul className="list">
          {data.positions.map((p) => (
            <li key={p.id} className="spread">
              <span>
                {p.label} · {p.status === "open" ? (p.inRange ? "in range" : "out of range") : p.status === "funding" ? "waiting for your approval" : p.status === "refunding" ? "refunding your mUSD" : p.status}
                <br />
                <span className="muted small">
                  in {usd(p.musdIn)}
                  {p.valueUsd != null && ` · now ${usd(p.valueUsd)}`}
                  {p.feesUsd != null && p.feesUsd > 0 && ` · fees ${usd(p.feesUsd)}`}
                  {(p.refundSig ?? p.payoutSig ?? p.openSig) && (
                    <>
                      {" "}· <a href={SOLSCAN_TX((p.refundSig ?? p.payoutSig ?? p.openSig)!)} target="_blank" rel="noreferrer">tx</a>
                    </>
                  )}
                </span>
                {p.error && p.status !== "closed" && (
                  <>
                    <br />
                    <span className="small" style={{ color: "var(--bad)" }}>{p.error}</span>
                  </>
                )}
              </span>
              {p.status === "open" && (
                <button className="btn btn-ghost small" disabled={closing === p.id} onClick={() => close(p)}>
                  {closing === p.id ? "Closing…" : "Close"}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {error && <div className="notice error">{error}</div>}
    </section>
  );
}
