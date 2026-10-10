"use client";

import { useEffect, useState } from "react";
import type { Destination, SolTier, SolanaStatus } from "@/lib/types";

/// "Where should your cash go?" — shown once per visit, before any note.
/// Solana options appear only when the backend says Solana is ready.
export function DestinationPicker({
  sessionId,
  onChosen,
}: {
  sessionId: string;
  onChosen: (d: Destination, tier: SolTier | null, notice?: string) => void;
}) {
  const [status, setStatus] = useState<SolanaStatus | null>(null);
  const [earn, setEarn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/kiosk/solana", { cache: "no-store" })
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);

  async function choose(destination: Destination, tier: SolTier | null = null) {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/kiosk/destination", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, destination, tier }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 409 && body.code === "destination_locked") {
        onChosen("evm", null, "Your first note already went to your Ethereum vault, so this visit stays there.");
        return;
      }
      if (!res.ok) throw new Error(body.error ?? "couldn't set the destination");
      onChosen(destination, tier);
    } catch (err) {
      setError(err instanceof Error ? err.message : "couldn't set the destination");
    } finally {
      setBusy(false);
    }
  }

  const solana = Boolean(status?.ready);
  return (
    <section className="lacquer-card destination-picker">
      <h2>Where should your cash go?</h2>
      {!earn ? (
        <div className="choice-grid">
          <button className="choice-tile" disabled={busy} onClick={() => choose("evm")}>
            <span className="choice-title">Ethereum vault</span>
            <span className="choice-sub">Your Takarabako balance, earning the vault APY</span>
          </button>
          {solana && (
            <>
              <button className="choice-tile" disabled={busy} onClick={() => choose("sol_hold")}>
                <span className="choice-title">Solana · Hold mUSD</span>
                <span className="choice-sub">A dollar token in your own Solana wallet</span>
              </button>
              <button className="choice-tile" disabled={busy} onClick={() => setEarn(true)}>
                <span className="choice-title">Solana · Earn with Meteora</span>
                <span className="choice-sub">mUSD in a Meteora DLMM pool, earning swap fees</span>
              </button>
            </>
          )}
        </div>
      ) : (
        <>
          <button className="btn btn-ghost small" onClick={() => setEarn(false)} disabled={busy}>
            ← Back
          </button>
          <div className="choice-grid">
            {(status?.tiers ?? []).map((t) => (
              <button key={t.id} className="choice-tile" disabled={busy} onClick={() => choose("sol_earn", t.id)}>
                <span className="choice-title">{t.label} risk</span>
                <span className="choice-sub">
                  {t.blurb} · {t.width} bins
                </span>
              </button>
            ))}
          </div>
        </>
      )}
      {status && !solana && <p className="muted small">Solana options are unavailable right now.</p>}
      <div aria-live="polite">{error && <div className="notice error" role="alert">{error}</div>}</div>
    </section>
  );
}
