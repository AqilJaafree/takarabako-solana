"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import type { CashReceipts, Deposit, LiveEvent, Me } from "@/lib/types";
import { useLiveEvents } from "@/lib/useLiveEvents";
import { useRouter } from "next/navigation";
import { apy, cash, SEPOLIA_TX, shortHex, timeAgo, usd, without } from "@/lib/format";
import { RollingNumber } from "@/components/RollingNumber";
import { TreasureStage } from "@/components/treasure/TreasureStage";
import { useStageDirector } from "@/components/treasure/useStageDirector";

interface Pending {
  amount: number;
  currency: string;
  estUsd: number | null;
  retry?: { attempt: number; of: number };
}

export function Dashboard({
  me,
  deposits: initialDeposits,
  receipts,
}: {
  me: Me;
  deposits: Deposit[];
  receipts: CashReceipts | null;
}) {
  const router = useRouter();
  const [tkBalance, setTkBalance] = useState(receipts?.configured ? receipts.balance : 0);
  const [balance, setBalance] = useState(me.balance);
  const [deposits, setDeposits] = useState(initialDeposits);
  const [pending, setPending] = useState<Record<string, Pending>>({});
  const [fresh, setFresh] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const { stage, deposit } = useStageDirector(
    me.balance > 0 ? `いらっしゃいませ! Your box holds ${usd(me.balance)}.` : "いらっしゃいませ! Insert a note at the kiosk and watch it land here.",
  );

  const upsert = useCallback((d: Partial<Deposit> & { id: string }) => {
    setDeposits((list) => {
      const i = list.findIndex((x) => x.id === d.id);
      if (i === -1) {
        const row: Deposit = {
          currency: "MYR", amount: 0, usdAmount: null, txHash: null, status: "queued",
          attempts: 0, error: null, createdAt: new Date().toISOString(), ...d,
        };
        return [row, ...list];
      }
      const next = [...list];
      next[i] = { ...next[i], ...d };
      return next;
    });
  }, []);

  const onEvent = useCallback((e: LiveEvent) => {
    const drop = (id: string) => setPending((p) => without(p, id));
    switch (e.type) {
      case "deposit.pending":
        setFailure(null);
        setPending((p) => ({ ...p, [e.depositId]: { amount: e.amount, currency: e.currency, estUsd: e.estUsd } }));
        upsert({ id: e.depositId, amount: e.amount, currency: e.currency, status: "queued" });
        deposit(e.depositId, { status: "pending", amount: e.amount, currency: e.currency, estUsd: e.estUsd });
        break;
      case "deposit.retrying":
        setPending((p) => (p[e.depositId] ? { ...p, [e.depositId]: { ...p[e.depositId], retry: { attempt: e.attempt, of: e.maxAttempts } } } : p));
        upsert({ id: e.depositId, attempts: e.attempt });
        deposit(e.depositId, { status: "retrying", attempt: e.attempt, of: e.maxAttempts });
        break;
      case "deposit.confirmed":
        drop(e.depositId);
        setBalance(e.balance);
        setFresh(e.depositId);
        upsert({ id: e.depositId, amount: e.amount, currency: e.currency, usdAmount: e.usdAmount, txHash: e.txHash, status: "confirmed" });
        deposit(e.depositId, { status: "confirmed", amount: e.amount, currency: e.currency, usdAmount: e.usdAmount, txHash: e.txHash });
        break;
      case "deposit.failed":
        drop(e.depositId);
        setFailure(`${cash(e.amount, e.currency)} couldn't be credited (${e.error}). It's recorded — staff can re-send it.`);
        upsert({ id: e.depositId, status: "failed", error: e.error });
        deposit(e.depositId, { status: "failed", amount: e.amount, currency: e.currency, error: e.error });
        break;
      case "tkcash.minted":
        upsert({ id: e.depositId, tkcashTxHash: e.txHash });
        setTkBalance((b) => b + e.amount);
        break;
    }
  }, [upsert, deposit]);

  // Fallback while the stream is down: refresh the balance and history.
  const poll = useCallback(async () => {
    const [meRes, depRes] = await Promise.all([fetch("/api/me"), fetch("/api/deposits")]);
    if (meRes.status === 401) {
      router.replace("/login");
      return;
    }
    if (meRes.ok) setBalance(((await meRes.json()) as Me).balance);
    if (depRes.ok) setDeposits(((await depRes.json()) as { deposits: Deposit[] }).deposits);
  }, [router]);

  const live = useLiveEvents("/api/stream", onEvent, poll);
  const pendingList = Object.entries(pending);
  const pendingUsd = pendingList.reduce((s, [, p]) => s + (p.estUsd ?? 0), 0);
  const retry = pendingList.find(([, p]) => p.retry)?.[1].retry;

  return (
    <>
      <TreasureStage
        {...stage}
        balance={balance}
        gems={me.positions.map((p) => ({ id: p.positionId, riskTier: p.riskTier, apyBps: p.apyBps }))}
      />
      <section className="lacquer-card" aria-live="polite">
        <div className="spread">
          <span className="label">Your treasure box</span>
          <span className={`pill ${live === "live" ? "ok" : "warn"}`}>{live === "live" ? "Live" : live === "polling" ? "Reconnecting" : "Connecting"}</span>
        </div>
        <RollingNumber value={balance} className="balance" />
        <div className="ens">
          {me.ensName}
          {me.limit?.leftUsd != null && <span className="human-badge is-pending">{usd(me.limit.leftUsd)} left today</span>}
        </div>
        <p className="small" style={{ marginTop: 10, marginBottom: 0, color: "rgba(244,233,218,.8)" }}>
          Earning {apy(me.apyBps)} APY in the Takarabako vault
        </p>
      </section>

      {pendingList.length > 0 && (
        <div className="notice pending">
          + ≈{usd(pendingUsd)} landing ({pendingList.map(([, p]) => cash(p.amount, p.currency)).join(" + ")})
          {retry && ` · retrying (${retry.attempt}/${retry.of})`}
        </div>
      )}
      {failure && <div className="notice error">{failure}</div>}

      {receipts?.configured && <CashReceiptsCard r={receipts} balance={tkBalance} />}

      {me.positions.length > 0 && (
        <section className="card">
          <div className="spread" style={{ marginBottom: 4 }}>
            <h2 style={{ margin: 0 }}>Yield on 1inch Aqua</h2>
            <Link href="/yield" className="small">Manage →</Link>
          </div>
          <ul className="list">
            {me.positions.map((p) => (
              <li key={p.positionId}>
                <div>
                  <div>{p.label} · {p.pair}</div>
                  <div className="small muted">
                    {p.priceMin !== null && p.priceMax !== null ? `${usd(p.priceMin, 0)} – ${usd(p.priceMax, 0)}` : "Full range"}
                    {p.inRange !== null && (
                      <span className={p.inRange ? "tone-ok" : "tone-warn"}> · {p.inRange ? "earning" : "out of range"}</span>
                    )}
                  </div>
                  <div className="ens small muted">{p.ensName}</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div className="amount">{usd(p.amount)}</div>
                  <div className="small muted">~{apy(p.apyBps)} APY</div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card">
        <div className="spread" style={{ marginBottom: 4 }}>
          <h2 style={{ margin: 0 }}>Deposits</h2>
          <Link href="/kiosks" className="small">Find a kiosk →</Link>
        </div>
        {deposits.length === 0 ? (
          <p className="muted" style={{ margin: "12px 0 0" }}>
            No cash yet. Scan your QR at a Takarabako kiosk and insert a note — it will land here within a second.
          </p>
        ) : (
          <ul className="list">
            {deposits.map((d) => (
              <li key={d.id} className={fresh === d.id ? "fresh" : undefined}>
                <div>
                  <div className="amount">{cash(d.amount, d.currency)}</div>
                  <div className="small muted">
                    {timeAgo(d.createdAt)}
                    {d.txHash && (
                      <> · <a href={SEPOLIA_TX(d.txHash)} target="_blank" rel="noreferrer" className="mono">{shortHex(d.txHash)}</a></>
                    )}
                    {d.tkcashTxHash && (
                      <> · <a href={SEPOLIA_TX(d.tkcashTxHash)} target="_blank" rel="noreferrer" title="tkCASH receipt token minted">tkCASH ✓</a></>
                    )}
                    {d.machineVerified && d.machineName && (
                      <span className="machine-badge" title="Signed by the kiosk's device key, checked against its ENS name">✓ {d.machineName}</span>
                    )}
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div>{d.usdAmount != null ? usd(d.usdAmount) : ""}</div>
                  <DepositStatus d={d} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function DepositStatus({ d }: { d: Deposit }) {
  if (d.status === "confirmed") return <span className="pill ok">Confirmed</span>;
  if (d.status === "failed") return <span className="pill bad" title={d.error ?? undefined}>Failed</span>;
  return <span className="pill warn">{d.attempts > 1 ? `Retrying ${d.attempts}/5` : "Confirming"}</span>;
}

const ADDRESS_URL = (a: string) => `https://sepolia.etherscan.io/token/${a}`;

/// tkCASH: a token for the banknotes this customer put into the kiosk,
/// with the proof that every token is backed by cash in the box.
function CashReceiptsCard({ r, balance }: { r: Extract<CashReceipts, { configured: true }>; balance: number }) {
  return (
    <section className="card tk-card">
      <div className="spread">
        <h2 style={{ margin: 0 }}>Cash receipts</h2>
        <span className={`pill ${r.backed && !r.kiosk.frozen ? "ok" : "bad"}`}>
          {r.kiosk.frozen ? "Kiosk under review" : r.backed ? "Fully backed" : "Backing mismatch"}
        </span>
      </div>
      <div className="tk-balance">
        <span className="amount">{usd(balance)}</span> <span className="tk-symbol">tkCASH</span>
      </div>
      <p className="small muted" style={{ margin: "4px 0 10px" }}>
        One tkCASH for every dollar of notes you put in the box. It lives in your wallet and is redeemed when you withdraw.
      </p>
      <p className="small tk-proof">
        {r.backed ? "✓" : "✗"} {usd(r.supply)} tkCASH issued · {usd(r.reserve)} of banknotes held in Takarabako kiosks · this kiosk{" "}
        <span className="mono">{r.kiosk.kioskId}</span>
        {r.kiosk.lastAuditAt ? ` · last counted ${timeAgo(new Date(r.kiosk.lastAuditAt * 1000).toISOString())}` : ""}
      </p>
      <a href={ADDRESS_URL(r.contract)} target="_blank" rel="noreferrer" className="small">
        View tkCASH on Etherscan →
      </a>
    </section>
  );
}
