"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Destination, Receipt } from "@/lib/types";
import { cash, SOLSCAN_TX, TX_URL, usd } from "@/lib/format";

/// The deposit terminal after a wallet-QR scan: wait for notes, show each
/// accepted note with a running total, then Finish → an animated receipt.
/// The note list comes from the backend's receipt (every stacked note is
/// recorded there immediately), so it survives reloads and matches History.

const IDLE_MS = 30_000; // no note for this long → "Still there?"
const BACK_TO_SCAN_MS = 20_000; // receipt stays up this long once settled

type Phase = "waiting" | "idle" | "receipt";

export interface Refusal {
  code: "unsupported" | "bad_condition" | "no_session";
  at: number;
}

const REFUSAL_TEXT: Record<Refusal["code"], string> = {
  unsupported: "That note isn't one I can take. Try a different note.",
  bad_condition: "That note came back — smooth it out and insert it again.",
  no_session: "Scan your QR first, then insert your notes.",
};

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: "no-store", ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error ?? "request failed"), { status: res.status });
  return body as T;
}

export function DepositFlow({
  sessionId,
  destination,
  refusal,
  onDone,
  onTestDeposit,
}: {
  sessionId: string;
  destination: Destination;
  refusal: Refusal | null;
  onDone: () => void;
  onTestDeposit?: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("waiting");
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [lastActivity, setLastActivity] = useState(() => Date.now());
  const [error, setError] = useState("");
  const [shownRefusal, setShownRefusal] = useState<Refusal | null>(null);
  const noteCount = useRef(0);

  // Poll the receipt: new notes, then their on-chain confirmations.
  const refresh = useCallback(async () => {
    try {
      const r = await getJson<Receipt>(`/api/kiosk/receipt?id=${encodeURIComponent(sessionId)}`);
      setReceipt(r);
      if (r.notes.length !== noteCount.current) {
        noteCount.current = r.notes.length;
        setLastActivity(Date.now());
        setPhase((p) => (p === "idle" ? "waiting" : p));
      }
    } catch (err) {
      if ((err as { status?: number }).status === 401) onDone();
    }
  }, [sessionId, onDone]);

  useEffect(() => {
    const first = setTimeout(refresh, 0);
    const t = setInterval(refresh, phase === "receipt" ? 2000 : 1500);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [refresh, phase]);

  // A refused note is activity too: the customer is still here.
  useEffect(() => {
    if (!refusal) return;
    const show = setTimeout(() => {
      setLastActivity(refusal.at);
      setShownRefusal(refusal);
      setPhase((p) => (p === "idle" ? "waiting" : p));
    }, 0);
    const hide = setTimeout(() => setShownRefusal(null), 8000); // the message fades after 8 s
    return () => {
      clearTimeout(show);
      clearTimeout(hide);
    };
  }, [refusal]);

  // 30 s with no note → ask whether they're still there.
  useEffect(() => {
    if (phase !== "waiting") return;
    const t = setTimeout(() => setPhase("idle"), Math.max(0, lastActivity + IDLE_MS - Date.now()));
    return () => clearTimeout(t);
  }, [phase, lastActivity]);

  // Earn receipts stay up until the Meteora position opens or fails.
  const isEarn = (receipt?.destination ?? destination) === "sol_earn";
  const positionStatus = receipt?.solPosition?.status;
  const positionDone = !isEarn || positionStatus === "open" || positionStatus === "failed";

  // Receipt settled → back to scanning for the next person after a while.
  useEffect(() => {
    if (phase !== "receipt" || !receipt?.settled || !positionDone) return;
    const t = setTimeout(onDone, BACK_TO_SCAN_MS);
    return () => clearTimeout(t);
  }, [phase, receipt?.settled, positionDone, onDone]);

  async function finish() {
    setError("");
    try {
      setReceipt(await getJson<Receipt>("/api/kiosk/finish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId }),
      }));
      setPhase("receipt");
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const notes = receipt?.notes ?? [];
  const hasNotes = notes.length > 0;
  const estTotal = notes.reduce((s, n) => s + (n.usdAmount ?? 0), 0);

  if (phase === "receipt" && receipt) {
    return (
      <section className="receipt-wrap" aria-live="polite">
        <div className="receipt-slot" aria-hidden="true" />
        <article className="receipt">
          <p className="receipt-brand">宝箱 Takarabako</p>
          <p className="receipt-sub">Deposit receipt · {receipt.id.slice(0, 8)}</p>
          <ul className="receipt-lines">
            {receipt.notes.map((n, i) => (
              <li key={n.id} style={{ animationDelay: `${0.6 + i * 0.15}s` }}>
                <span>
                  {cash(n.amount, n.currency)}
                  {n.txHash && (
                    <>
                      {" "}
                      <a href={TX_URL(n.txHash, n.chain)} target="_blank" rel="noreferrer" aria-label="View transaction">
                        ↗
                      </a>
                    </>
                  )}
                </span>
                <span className={`receipt-status ${n.status}`}>
                  {n.status === "confirmed"
                    ? `${usd(n.usdAmount ?? 0)} ✓`
                    : n.status === "failed"
                      ? "not credited"
                      : "confirming…"}
                </span>
              </li>
            ))}
          </ul>
          {receipt.destination === "sol_hold" && <p className="receipt-tk">Sent as mUSD to your Solana wallet</p>}
          {receipt.destination === "sol_earn" && (
            <p className="receipt-tk">
              {receipt.solPosition?.openSig ? (
                <>
                  Meteora position opened ·{" "}
                  <a href={SOLSCAN_TX(receipt.solPosition.openSig)} target="_blank" rel="noreferrer">
                    view on Solscan
                  </a>
                </>
              ) : receipt.solPosition?.status === "failed" ? (
                "Your Meteora position couldn't be opened — your mUSD is safe; ask staff."
              ) : (
                "Opening your Meteora position…"
              )}
            </p>
          )}
          <div className="receipt-total">
            <span>Total {cash(receipt.totalAmount, receipt.currency)}</span>
            <b>{usd(receipt.totalUsdConfirmed)}</b>
          </div>
          {receipt.notes.some((n) => n.machineVerified) && (
            <p className="receipt-tk">
              ✓ Verified machine · {receipt.notes.find((n) => n.machineVerified)?.machineName}
            </p>
          )}
          {receipt.notes.some((n) => n.tkcashTxHash) && (
            <p className="receipt-tk">
              + {usd(receipt.notes.filter((n) => n.tkcashTxHash).reduce((s, n) => s + (n.usdAmount ?? 0), 0))} tkCASH — a token
              for your cash in this box
            </p>
          )}
          <p className="receipt-foot">
            {receipt.settled
              ? `All confirmed on ${receipt.destination === "evm" ? "Sepolia" : "Solana devnet"}. A copy is on its way to your email and in your History.`
              : `Confirming on ${receipt.destination === "evm" ? "Sepolia" : "Solana devnet"}… your email copy follows once every note is in.`}
          </p>
        </article>
        <button className="btn btn-gold btn-block" onClick={onDone}>
          Done
        </button>
      </section>
    );
  }

  return (
    <section className="deposit-flow">
      {phase === "idle" ? (
        <div className="card" style={{ textAlign: "center" }} role="alertdialog" aria-label="Still there?">
          <p className="label">Still there?</p>
          <p className="muted">
            {hasNotes ? "No more notes for a while. Add more, or finish to get your receipt." : "We haven't seen a note yet."}
          </p>
          <div className="row">
            <button className="btn" style={{ flex: 1 }} onClick={() => { setLastActivity(Date.now()); setPhase("waiting"); }}>
              Try again
            </button>
            <button className="btn btn-gold" style={{ flex: 1 }} onClick={hasNotes ? finish : onDone}>
              {hasNotes ? "Finish" : "Cancel"}
            </button>
          </div>
        </div>
      ) : (
        <div className="slot-hint" aria-live="polite">
          <div className="slot-anim" aria-hidden="true">
            <span className="slot-note">RM</span>
            <span className="slot-mouth" />
          </div>
          <p>{hasNotes ? "Insert another note, or finish" : "Insert your notes into the slot"}</p>
        </div>
      )}

      {shownRefusal && <div className="notice pending" role="status">{REFUSAL_TEXT[shownRefusal.code]}</div>}

      {hasNotes && (
        <div className="card deposit-notes">
          <ul className="list">
            {notes.map((n) => (
              <li key={n.id} className="spread fresh">
                <span className="amount">{cash(n.amount, n.currency)}</span>
                <span className="muted small">
                  {n.status === "confirmed" ? `${usd(n.usdAmount ?? 0)} ✓` : n.status === "failed" ? "not credited" : "confirming…"}
                </span>
              </li>
            ))}
          </ul>
          <div className="spread deposit-total">
            <span>Total {cash(receipt!.totalAmount, receipt!.currency)}</span>
            <b>≈ {usd(estTotal)}</b>
          </div>
          <div className="row">
            <button className="btn" style={{ flex: 1 }} onClick={() => { setLastActivity(Date.now()); setPhase("waiting"); }}>
              Add more money
            </button>
            <button className="btn btn-gold" style={{ flex: 1 }} onClick={finish}>
              Finish
            </button>
          </div>
        </div>
      )}

      {error && <div className="notice error">{error}</div>}

      <div className="row" style={{ marginTop: 10 }}>
        {onTestDeposit && (
          <button className="btn btn-ghost" onClick={onTestDeposit}>
            Test: insert RM10
          </button>
        )}
        {!hasNotes && (
          <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onDone}>
            Cancel
          </button>
        )}
      </div>
    </section>
  );
}
