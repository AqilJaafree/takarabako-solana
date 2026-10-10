"use client";

import { useState } from "react";
import type { HistoryItem } from "@/lib/types";
import { TX_URL, apy, cash, shortHex, usd } from "@/lib/format";

const FILTERS = [
  { kind: null, label: "All" },
  { kind: "deposit_session", label: "Deposits" },
  { kind: "withdrawal", label: "Withdrawals" },
  { kind: "yield", label: "Yield" },
  { kind: "transfer", label: "Transfers" },
  { kind: "refused", label: "Refused" },
] as const;

const ASSET_TEXT = { balance: "Box balance", tkcash: "tkCASH", position: "Yield position" } as const;

const TIER_TEXT = { low: "Low", medium: "Medium", high: "High" } as const;

function destinationText(item: Extract<HistoryItem, { kind: "deposit_session" }>) {
  if (item.destination === "sol_hold") return "Solana · Hold";
  if (item.destination === "sol_earn") return `Meteora · ${item.tier ? TIER_TEXT[item.tier] : "Earn"}`;
  return "Ethereum vault";
}

const REFUSED_TEXT = {
  unsupported: "Note not supported — handed back",
  bad_condition: "Note in poor condition — handed back",
  no_session: "Note inserted before login — handed back",
} as const;

function when(iso: string) {
  return new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function TxLink({ hash, chain = "evm" }: { hash: string | null; chain?: "evm" | "sol" }) {
  if (!hash) return null;
  return (
    <a className="mono small" href={TX_URL(hash, chain)} target="_blank" rel="noreferrer">
      {shortHex(hash)} ↗
    </a>
  );
}

export function HistoryList({ items }: { items: HistoryItem[] }) {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["kind"]>(null);
  const [open, setOpen] = useState<string | null>(null);
  const shown = filter ? items.filter((i) => i.kind === filter) : items;

  return (
    <>
      <div className="row" role="tablist" aria-label="Filter history" style={{ flexWrap: "wrap", margin: "14px 0" }}>
        {FILTERS.map((f) => (
          <button
            key={f.label}
            role="tab"
            aria-selected={filter === f.kind}
            className={`btn small ${filter === f.kind ? "btn-gold" : "btn-ghost"}`}
            onClick={() => setFilter(f.kind)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <div className="card muted">
          {filter ? "Nothing here yet." : "Nothing yet. Deposit cash at a Takarabako kiosk and it shows up here."}
        </div>
      ) : (
        <ul className="list card" style={{ padding: 0 }}>
          {shown.map((item) => {
            if (item.kind === "deposit_session") {
              const expanded = open === item.id;
              return (
                <li key={item.id} style={{ display: "block", padding: "14px 18px" }}>
                  <button
                    className="spread"
                    style={{ width: "100%", background: "none", border: 0, color: "inherit", padding: 0, cursor: "pointer", textAlign: "left" }}
                    aria-expanded={expanded}
                    onClick={() => setOpen(expanded ? null : item.id)}
                  >
                    <span>
                      <b>Deposit · {cash(item.totalAmount, item.currency)}</b>
                      <br />
                      <span className="muted small">
                        {when(item.at)} · {item.notes.length} note{item.notes.length === 1 ? "" : "s"} · {destinationText(item)}
                      </span>
                    </span>
                    <span className="amount" style={{ color: "var(--gold)" }}>
                      +{usd(item.totalUsdConfirmed)} {expanded ? "▴" : "▾"}
                    </span>
                  </button>
                  {expanded && (
                    <ul className="list" style={{ marginTop: 10 }}>
                      {item.notes.map((n) => (
                        <li key={n.id} className="spread">
                          <span>{cash(n.amount, n.currency)}</span>
                          <span className="small">
                            {n.status === "confirmed" ? (
                              <>
                                {usd(n.usdAmount)} · <TxLink hash={n.txHash} chain={n.chain} />
                                {n.tkcashTxHash && (
                                  <>
                                    {" "}· tkCASH <TxLink hash={n.tkcashTxHash} />
                                  </>
                                )}
                                {n.machineVerified && n.machineName && (
                                  <span className="machine-badge" title="Signed by the kiosk's device key, checked against its ENS name">
                                    ✓ {n.machineName}
                                  </span>
                                )}
                              </>
                            ) : n.status === "failed" ? (
                              <span style={{ color: "var(--bad)" }}>not credited</span>
                            ) : (
                              <span style={{ color: "var(--warn)" }}>confirming…</span>
                            )}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            }
            if (item.kind === "withdrawal") {
              return (
                <li key={item.id} className="spread" style={{ padding: "14px 18px" }}>
                  <span>
                    <b>Withdrawal · {item.destination === "wallet" ? "to wallet" : "cash"}</b>
                    <br />
                    <span className="muted small">
                      {when(item.at)}
                      {item.feeBps > 0 && ` · ${item.feeBps / 100}% fee`}
                    </span>
                  </span>
                  <span style={{ textAlign: "right" }}>
                    <span className="amount">−{usd(item.grossUsd)}</span>
                    <br />
                    <TxLink hash={item.txHash} />
                    {item.tkcashTxHash && (
                      <>
                        <br />
                        <span className="small muted">{usd(item.tkcashBurned ?? 0)} tkCASH redeemed · </span>
                        <TxLink hash={item.tkcashTxHash} />
                      </>
                    )}
                  </span>
                </li>
              );
            }
            if (item.kind === "yield") {
              return (
                <li key={item.id} style={{ display: "block", padding: "14px 18px" }}>
                  <div className="spread">
                    <span>
                      <b>
                        Yield {item.action === "open" ? "opened" : "closed"} · {item.pair ?? ""}
                      </b>
                      <br />
                      <span className="muted small">
                        {when(item.at)} · {item.riskTier} risk{item.apyBps != null && ` · ${apy(item.apyBps)} APY`}
                      </span>
                    </span>
                    <span style={{ textAlign: "right" }}>
                      <span className="amount">{usd(item.amountUsd)}</span>
                      <br />
                      <TxLink hash={item.txHash} chain={item.chain} />
                    </span>
                  </div>
                  {item.rationale && <p className="speech small" style={{ marginBottom: 0 }}>{item.rationale}</p>}
                </li>
              );
            }
            if (item.kind === "transfer") {
              const sent = item.direction === "sent";
              return (
                <li key={item.id} className="spread" style={{ padding: "14px 18px" }}>
                  <span>
                    <b>
                      {ASSET_TEXT[item.asset]} {sent ? "sent to" : "received from"}{" "}
                      <span className="mono">{item.counterparty ?? "an external wallet"}</span>
                    </b>
                    <br />
                    <span className="muted small">{when(item.at)} · by ENS name</span>
                  </span>
                  <span style={{ textAlign: "right" }}>
                    <span className="amount" style={{ color: sent ? undefined : "var(--ok)" }}>
                      {item.amountUsd != null ? `${sent ? "−" : "+"}${usd(item.amountUsd)}` : ""}
                    </span>
                    <br />
                    <TxLink hash={item.txHash} />
                  </span>
                </li>
              );
            }
            return (
              <li key={item.id} className="spread" style={{ padding: "14px 18px" }}>
                <span>
                  <b style={{ color: "var(--warn)" }}>{REFUSED_TEXT[item.reason]}</b>
                  <br />
                  <span className="muted small">{when(item.at)}</span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
