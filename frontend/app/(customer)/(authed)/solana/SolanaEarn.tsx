"use client";

import { useEffect, useState } from "react";
import type { SolTier, SolanaMe, SolanaStatus, WebEarnPrepared, WebEarnSubmitted } from "@/lib/types";
import { usd } from "@/lib/format";
import { useSolanaSign } from "@/lib/useSolanaSign";
import { SolanaCard } from "@/components/SolanaCard";

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error ?? "something went wrong");
  return json as T;
}

/// Earn from held mUSD: amount + tier → approve in Privy → position opens.
export function SolanaEarn({ leftToday }: { leftToday: number | null }) {
  const sign = useSolanaSign();
  const [me, setMe] = useState<SolanaMe | null>(null);
  const [status, setStatus] = useState<SolanaStatus | null>(null);
  const [amount, setAmount] = useState("");
  const [tier, setTier] = useState<SolTier>("low");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    fetch("/api/kiosk/solana", { cache: "no-store" }).then((r) => r.json()).then(setStatus).catch(() => setStatus(null));
  }, []);
  useEffect(() => {
    fetch("/api/solana/me", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<SolanaMe>) : null))
      .then((d) => d && setMe(d))
      .catch(() => {});
  }, [refreshKey]);

  // After a submit, follow the position from opening to open for a minute.
  function follow() {
    let n = 0;
    const t = setInterval(() => {
      setRefreshKey((k) => k + 1);
      if (++n >= 20) clearInterval(t);
    }, 3_000);
  }

  async function earn() {
    if (!me?.wallet) return;
    setBusy(true);
    setMessage(null);
    try {
      const prepared = await post<WebEarnPrepared>("/api/solana/earn/prepare", { amount: Number(amount), tier });
      const signedTx = await sign(prepared.tx, me.wallet);
      const done = await post<WebEarnSubmitted>("/api/solana/earn/submit", { id: prepared.id, signedTx });
      setMessage({
        kind: "ok",
        text: done.status === "opening" ? "Approved — your Meteora position is opening." : "Sent — waiting for the network to confirm.",
      });
      setAmount("");
      follow();
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof Error ? err.message : "couldn't start Earn" });
    } finally {
      setBusy(false);
      setRefreshKey((k) => k + 1);
    }
  }

  if (!status?.ready) return <p className="muted">Solana isn&apos;t available right now.</p>;
  if (me && !me.wallet) return <p className="muted">You don&apos;t have a Solana wallet yet — choose Solana at a kiosk first.</p>;

  const held = me?.musd ?? 0;
  const value = Number(amount);
  const valid = value > 0 && value <= held && (leftToday == null || value <= leftToday);
  return (
    <>
      <section className="card">
        <h2>Earn with your mUSD</h2>
        <p className="muted small">
          {usd(held)} mUSD in your wallet{leftToday != null && ` · ${usd(leftToday)} left to move today`}
        </p>
        <div className="spread" style={{ gap: 8 }}>
          <input
            className="input"
            inputMode="decimal"
            placeholder="Amount of mUSD"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            disabled={busy}
            aria-label="Amount of mUSD"
          />
          <button className="btn btn-ghost small" disabled={busy || held <= 0} onClick={() => setAmount(String(held))}>
            Max
          </button>
        </div>
        <div className="choice-grid" style={{ marginTop: 12 }}>
          {status.tiers.map((t) => (
            <button
              key={t.id}
              className="choice-tile"
              aria-pressed={tier === t.id}
              disabled={busy}
              onClick={() => setTier(t.id)}
              style={{ aspectRatio: "auto", padding: "14px 12px", ...(tier === t.id ? { borderColor: "var(--gold)", background: "var(--gold-soft)" } : {}) }}
            >
              <span className="choice-title">{t.label} risk</span>
              <span className="choice-sub">
                {t.blurb} · {t.width} bins
              </span>
            </button>
          ))}
        </div>
        <button className="btn" style={{ marginTop: 12 }} disabled={busy || !valid} onClick={earn}>
          {busy ? "Waiting for your approval…" : "Earn"}
        </button>
        <div aria-live="polite">
          {message && <div className={`notice ${message.kind === "ok" ? "pending" : "error"}`} role="status">{message.text}</div>}
        </div>
      </section>
      <SolanaCard refreshKey={refreshKey} showEarnLink={false} />
    </>
  );
}
