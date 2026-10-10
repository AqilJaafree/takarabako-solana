"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import jsQR from "jsqr";
import type { Destination, KioskLogin, SolTier, LiveEvent, OpenedPosition, Pool, RiskTier, WithdrawResult } from "@/lib/types";
import { useLiveEvents } from "@/lib/useLiveEvents";
import { apy, cash, usd, without } from "@/lib/format";
import { TreasureStage } from "@/components/treasure/TreasureStage";
import { useStageDirector } from "@/components/treasure/useStageDirector";
import { DepositFlow, type Refusal } from "./DepositFlow";
import { DestinationPicker } from "./DestinationPicker";
import { QrProblem, type QrProblemKind } from "./QrProblem";
import { ConnectionLost, useBackendDown } from "@/components/ConnectionLost";
import { MachineBadge } from "@/components/MachineBadge";

const GREETINGS = {
  kiosk: "いらっしゃいませ! Tap in with your email or wallet QR.",
  deposit: "いらっしゃいませ! Pick how to log in, then feed me your notes.",
} as const;
const bubble = (text: string) => (text.length > 170 ? `${text.slice(0, 167).trimEnd()}…` : text);

/// Kiosk flows, as on the original device-agent page (ATM-style: identify
/// first, then insert cash):
///   - email login → full access (deposit, yield, withdraw as cash or to wallet)
///   - wallet-QR scan → deposit only
/// mode="deposit" (the /deposit page) is a cash-deposit terminal: it opens on
/// a deposit-QR login, takes deposit-only sessions,
/// and goes back to that choice after every customer.
/// The backend session token never reaches this page: /api/kiosk/* keeps it
/// in an httpOnly cookie and hands it to the Pi bridge server-side.

type Screen = "welcome" | "scan" | "account" | "yield" | "receipt";

// Backend session lifetimes (backend/src/sessions.ts); each deposit slides them.
const TTL_MS = { full: 15 * 60_000, deposit: 5 * 60_000 } as const;

interface Pending {
  amount: number;
  currency: string;
  estUsd: number | null;
  retry?: { attempt: number; of: number };
}

// device-agent/server.js GET /events entries.
type BridgeEvent =
  | { seq: number; id: string; type: "rejected"; reason: string; code?: Refusal["code"] }
  | {
      seq: number;
      id: string;
      type: "deposit";
      status: "pending" | "confirmed" | "failed";
      amount: number;
      currency: string;
      estUsd: number | null;
      usdAmount?: number;
      txHash?: string;
      balance?: number;
      error?: string;
      retry?: { attempt: number; of: number };
    };

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.error ?? "request failed"), { status: res.status });
  return json as T;
}

export function KioskApp({
  pools,
  testDeposit,
  mode = "kiosk",
}: {
  pools: Pool[];
  testDeposit: boolean;
  mode?: "kiosk" | "deposit";
}) {
  const depositOnly = mode === "deposit";
  const GREETING = GREETINGS[mode];
  const startScreen: Screen = "welcome";
  const [screen, setScreen] = useState<Screen>(startScreen);
  const [session, setSession] = useState<KioskLogin | null>(null);
  const [destination, setDestination] = useState<{ d: Destination; tier: SolTier | null; notice?: string } | null>(null);
  const [balance, setBalance] = useState(0);
  const [expiresAt, setExpiresAt] = useState(0);
  const [pending, setPending] = useState<Record<string, Pending>>({});
  const [position, setPosition] = useState<(OpenedPosition & { riskTier: RiskTier }) | null>(null);
  const [receipt, setReceipt] = useState<WithdrawResult | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [ticker, setTicker] = useState<string[]>([]);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  // Deposit terminal: which login the scan screen shows.
  const [qrProblem, setQrProblem] = useState<QrProblemKind | null>(null);
  // The unknown QR just scanned, and (after "Scan a new QR") a short window in
  // which the scanner skips it, so the same phone can't re-open the pop-up.
  const [badQr, setBadQr] = useState<string | null>(null);
  const [ignoreQr, setIgnoreQr] = useState<{ text: string; until: number } | null>(null);
  const emailInput = useRef<HTMLInputElement>(null);
  // Backend unreachable: cover the screen until it's back, then reveal the
  // same screen underneath (session, notes and step all kept).
  const [backendDown, backendRecovered] = useBackendDown();
  const director = useStageDirector(GREETING);
  const { deposit: cue, say: catSay, withdraw: burst } = director;

  const say = useCallback((line: string) => {
    const t = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    setTicker((l) => [`${t}  ${line}`, ...l].slice(0, 5));
  }, []);

  const logout = useCallback(async () => {
    await post("/api/kiosk/logout").catch(() => {});
    setSession(null);
    setDestination(null);
    setBalance(0);
    setExpiresAt(0);
    setPending({});
    setPosition(null);
    setReceipt(null);
    setMessage("");
    setScreen(startScreen);
    catSay(GREETING, "idle", 0);
  }, [catSay, GREETING, startScreen]);

  // A fresh page load always starts at the welcome screen with no session,
  // so the next person never lands in someone else's account.
  useEffect(() => {
    void post("/api/kiosk/logout").catch(() => {});
  }, []);

  // Session timeout.
  useEffect(() => {
    if (!session) return;
    const t = setInterval(() => {
      if (Date.now() > expiresAt) {
        say("session timed out");
        void logout();
      }
    }, 2000);
    return () => clearInterval(t);
  }, [session, expiresAt, logout, say]);

  const onRequestError = useCallback(
    (e: unknown, what: string) => {
      const err = e as Error & { status?: number };
      if (err.status === 401) {
        say("session expired — please log in again");
        void logout();
        return;
      }
      setMessage(`${what}: ${err.message}`);
    },
    [logout, say],
  );

  const slide = useCallback(() => {
    if (session) setExpiresAt(Date.now() + TTL_MS[session.scope]);
  }, [session]);

  // ---- deposits: backend stream (primary), Pi bridge feed (fallback) ----
  const applyDeposit = useCallback(
    (id: string, d: { status: "pending" | "retrying" | "confirmed" | "failed"; amount?: number; currency?: string; estUsd?: number | null; balance?: number; usdAmount?: number; txHash?: string; error?: string; retry?: { attempt: number; of: number } }) => {
      slide();
      if (d.status === "pending") {
        setPending((p) => (p[id] ? p : { ...p, [id]: { amount: d.amount!, currency: d.currency!, estUsd: d.estUsd ?? null } }));
        say(`${cash(d.amount!, d.currency!)} received${d.estUsd != null ? ` → ≈${usd(d.estUsd)}` : ""}, confirming on-chain…`);
        cue(id, { status: "pending", amount: d.amount!, currency: d.currency!, estUsd: d.estUsd ?? null });
      } else if (d.status === "retrying") {
        setPending((p) => (p[id] ? { ...p, [id]: { ...p[id], retry: d.retry } } : p));
        if (d.retry) cue(id, { status: "retrying", attempt: d.retry.attempt, of: d.retry.of });
      } else if (d.status === "confirmed") {
        setPending((p) => without(p, id));
        if (d.balance != null) setBalance(d.balance);
        say(`${cash(d.amount!, d.currency!)} credited${d.usdAmount != null ? ` → ${usd(d.usdAmount)}` : ""}`);
        cue(id, { status: "confirmed", amount: d.amount!, currency: d.currency!, usdAmount: d.usdAmount ?? d.estUsd ?? 0, txHash: d.txHash });
      } else {
        setPending((p) => without(p, id));
        say(`${cash(d.amount!, d.currency!)} NOT credited (${d.error}) — please ask staff`);
        cue(id, { status: "failed", amount: d.amount!, currency: d.currency!, error: d.error ?? "unknown error" });
      }
    },
    [say, slide, cue],
  );

  const onLive = useCallback(
    (e: LiveEvent) => {
      if (e.type === "deposit.pending") applyDeposit(e.depositId, { status: "pending", amount: e.amount, currency: e.currency, estUsd: e.estUsd });
      else if (e.type === "deposit.retrying") applyDeposit(e.depositId, { status: "retrying", retry: { attempt: e.attempt, of: e.maxAttempts } });
      else if (e.type === "deposit.confirmed") applyDeposit(e.depositId, { status: "confirmed", amount: e.amount, currency: e.currency, balance: e.balance, usdAmount: e.usdAmount, txHash: e.txHash });
      else if (e.type === "deposit.failed") applyDeposit(e.depositId, { status: "failed", amount: e.amount, currency: e.currency, error: e.error });
      // deposit.refused: shown from the Pi bridge's feed below, which also
      // sees notes refused while nobody is logged in.
    },
    [applyDeposit],
  );

  const live = useLiveEvents(session ? "/api/kiosk/stream" : null, onLive);
  const liveRef = useRef(live);
  useEffect(() => {
    liveRef.current = live;
  }, [live]);

  // The Pi bridge's feed: refused notes always come from here (they never
  // reach the backend); deposits only while the backend stream is down.
  useEffect(() => {
    if (!session) return;
    let since = 0;
    let stopped = false;
    const seen = new Map<string, string>();
    const tick = async () => {
      try {
        const res = await fetch(`/api/kiosk/bridge-events?since=${since}`);
        const { events } = (await res.json()) as { events: BridgeEvent[] };
        for (const e of events) {
          since = Math.max(since, e.seq);
          if (e.type === "rejected") {
            const code = e.code ?? "bad_condition";
            say(`note handed back (${e.reason}) — please try again`);
            catSay(
              code === "unsupported"
                ? "Hmm, I can't take that note. Try another one?"
                : "That note came back — smooth it out and try again?",
              "worried",
            );
            setRefusal({ code, at: Date.now() });
            continue;
          }
          if (liveRef.current === "live" || seen.get(e.id) === e.status) continue;
          seen.set(e.id, e.status);
          applyDeposit(e.id, { ...e, status: e.retry && e.status === "pending" ? "retrying" : e.status });
        }
      } catch {
        // bridge briefly unreachable — next tick retries
      }
      if (!stopped) timer = setTimeout(tick, 1000);
    };
    let timer = setTimeout(tick, 0);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [session, applyDeposit, say, catSay]);

  // ---- login ----
  function startSession(login: KioskLogin) {
    setSession(login);
    setDestination(null);
    setBalance(login.balance);
    setExpiresAt(Date.parse(login.expiresAt));
    setMessage("");
    setScreen("account");
    say(`${login.ensName} — ${login.scope === "full" ? "full access" : "deposit only"}`);
    catSay("Welcome back! Insert your notes 💴", "happy");
    if (login.bridge === "failed") say("⚠ bill acceptor bridge unreachable — notes will be handed back");
    if (login.qrEmailed) say("quick-deposit QR emailed");
  }

  async function onEmail(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const email = String(new FormData(e.currentTarget).get("email") ?? "").trim();
    if (!email) return;
    setBusy(true);
    setMessage("Verifying…");
    try {
      startSession(await post<KioskLogin>("/api/kiosk/verify", { email }));
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function onQr(text: string) {
    setBusy(true);
    try {
      startSession(await post<KioskLogin>("/api/kiosk/login-qr", { qr: text }));
    } catch (err) {
      const status = (err as Error & { status?: number }).status;
      setScreen("welcome");
      if (status === 404 || status === 400 || status === 410) {
        // Unknown, foreign or expired QR: a pop-up to scan again (or sign up).
        setMessage("");
        setBadQr(text);
        setQrProblem(status === 410 ? "expired" : status === 404 ? "unregistered" : "invalid");
        catSay("Hmm, I don't know this QR…", "thinking", 0);
      } else {
        // Deposit terminal: show why, with a button to scan again.
        setMessage((err as Error).message);
      }
    } finally {
      setBusy(false);
    }
  }

  const closeQrProblem = useCallback(() => {
    setQrProblem(null);
    setMessage("");
    catSay(GREETING, "idle", 0);
  }, [catSay, GREETING]);

  function onRescan() {
    closeQrProblem();
    if (badQr) setIgnoreQr({ text: badQr, until: Date.now() + 5000 });
    setScreen("scan");
  }

  // /kiosk: email login registers new customers, so sign-up is the email box.
  function onSignUpHere() {
    closeQrProblem();
    setScreen("welcome");
    setMessage("New here? Enter your email to sign up — your wallet is created for you.");
    catSay("Welcome! Sign up with your email 💌", "happy");
    setTimeout(() => emailInput.current?.focus(), 0);
  }

  // ---- actions ----
  async function onOpenPosition(tier: RiskTier) {
    setBusy(true);
    setMessage("");
    catSay(`Looking at the ${tier}-risk pool…`, "thinking", 0);
    try {
      const res = await post<OpenedPosition>("/api/kiosk/yield", { riskLevel: tier, amount: balance });
      setPosition({ ...res, riskTier: tier });
      catSay(bubble(res.rationale ?? `Done! ${res.pair} at ${apy(res.apyBps)} APY.`), "happy", 12000);
      say(`agent opened ${res.pair} — ${res.ensName}`);
      slide();
      setScreen("account");
    } catch (err) {
      onRequestError(err, "Couldn't open the position");
    } finally {
      setBusy(false);
    }
  }

  async function onWithdraw(destination: "cash" | "wallet") {
    setBusy(true);
    setMessage("");
    try {
      setReceipt(await post<WithdrawResult>("/api/kiosk/withdraw", { destination }));
      setBalance(0);
      setPosition(null);
      burst();
      setScreen("receipt");
    } catch (err) {
      onRequestError(err, "Withdraw failed");
    } finally {
      setBusy(false);
    }
  }

  async function onTestDeposit() {
    try {
      await post("/api/kiosk/test-deposit");
    } catch (err) {
      onRequestError(err, "Test deposit failed");
    }
  }

  const pendingList = Object.values(pending);
  const pendingUsd = pendingList.reduce((s, p) => s + (p.estUsd ?? 0), 0);
  const retry = pendingList.find((p) => p.retry)?.retry;
  const canWithdraw = balance > 0 || !!position;

  return (
    <main className="kiosk">
      {backendDown && (
        <div className="conn-overlay">
          <ConnectionLost
            onRecovered={backendRecovered}
            detail={session ? "Your session and any notes you've inserted are safe. We'll carry on right here." : undefined}
          />
        </div>
      )}
      {qrProblem && (
        <QrProblem
          kind={qrProblem}
          depositOnly={depositOnly}
          onRescan={onRescan}
          onSignUpHere={onSignUpHere}
          onDismiss={closeQrProblem}
        />
      )}
      <div className="kiosk-panel">
        <header className="kiosk-head">
          <div className="brand">
            <span className="kanji">宝箱</span> Takarabako
          </div>
          <MachineBadge />
        </header>

        {screen !== "scan" && (
          <TreasureStage
            {...director.stage}
            balance={balance}
            gems={position ? [{ id: position.positionId, riskTier: position.riskTier, apyBps: position.apyBps }] : []}
            height={360}
          />
        )}

        {screen === "welcome" && depositOnly && (
          <section className="card deposit-choose">
            <span className="kiosk-tag">Takarabako kiosk</span>
            <h2>Deposit cash</h2>
            <p className="muted">To deposit money, scan your quick-deposit QR.</p>
            {message && <div className="notice error">{message}</div>}
            <div className="choice-grid">
              <button className="choice-tile" disabled={busy} onClick={() => { setMessage(""); setScreen("scan"); }}>
                <QrIcon />
                <span className="choice-title">{busy ? "Checking your QR…" : "Scan my QR"}</span>
                <span className="choice-sub">Show the QR from the app’s Deposit tab</span>
              </button>
            </div>
            <p className="muted small" style={{ margin: "14px 0 0" }}>New here? Sign up in the Takarabako app first.</p>
          </section>
        )}

        {screen === "welcome" && !depositOnly && (
          <section className="card">
            <p className="muted" style={{ textAlign: "center" }}>Enter your email to begin — like a card at an ATM.</p>
            <form onSubmit={onEmail}>
              <input ref={emailInput} className="input" type="email" name="email" placeholder="you@example.com" autoComplete="off" required autoFocus />
              <button className="btn btn-gold btn-block" disabled={busy}>{busy ? "Verifying…" : "Continue"}</button>
            </form>
            {message && <p className="muted small" style={{ marginTop: 12, marginBottom: 0 }}>{message}</p>}
            <div className="divider">or</div>
            <p className="muted small" style={{ textAlign: "center" }}>Registered already? Show your wallet QR to deposit cash.</p>
            <button className="btn btn-block" onClick={() => { setMessage(""); setScreen("scan"); }}>Scan my QR to deposit</button>
          </section>
        )}

        {screen === "scan" && (
          <Scanner
            onResult={onQr}
            ignore={ignoreQr}
            onCancel={(why) => { setMessage(why ?? ""); setScreen("welcome"); }}
            hint={depositOnly ? "Open Deposit in the Takarabako app, then hold your phone up to the camera." : undefined}
            fallback={depositOnly ? "check the camera is connected and allowed, then tap Scan my QR" : "log in with email instead"}
          />
        )}

        {screen === "account" && session && depositOnly && (
          <>
            <section className="lacquer-card" aria-live="polite">
              <div className="spread">
                <span className="label">Depositing to</span>
                <span className={`pill ${live === "live" ? "ok" : "warn"}`}>{live === "live" ? "Live" : "Reconnecting"}</span>
              </div>
              <div className="ens">
                {destination?.d === "sol_hold"
                  ? "Solana wallet · mUSD"
                  : destination?.d === "sol_earn"
                    ? `Meteora · ${destination.tier ?? ""} risk`
                    : session.ensName}
              </div>
              <div className="balance">{usd(balance)}</div>
            </section>
            {session.bridge === "failed" && (
              <div className="notice error">The cash slot is offline — notes will be handed back. Please ask staff.</div>
            )}
            {session.limit?.limited && session.limit.leftUsd !== null && !session.depositBlocked && (
              <p className="kiosk-limit small">
                {usd(session.limit.leftUsd)} of today&apos;s {usd(session.limit.limitUsd, 0)} left
              </p>
            )}
            {session.depositBlocked ? (
              <div className="notice pending">{session.depositBlocked}</div>
            ) : session.depositSessionId && !destination ? (
              <DestinationPicker
                sessionId={session.depositSessionId}
                onChosen={(d, tier, notice) => setDestination({ d, tier, notice })}
              />
            ) : session.depositSessionId && destination ? (
              <>
                {destination.notice && <div className="notice pending" role="status">{destination.notice}</div>}
                <DepositFlow
                  sessionId={session.depositSessionId}
                  destination={destination.d}
                  refusal={refusal}
                  onDone={logout}
                  onTestDeposit={testDeposit ? onTestDeposit : undefined}
                />
              </>
            ) : (
              <div className="notice error">Couldn&apos;t start a deposit. Tap Done and scan again.</div>
            )}
          </>
        )}

        {screen === "account" && session && !depositOnly && (
          <>
            <section className="lacquer-card" aria-live="polite">
              <div className="spread">
                <span className="label">{session.scope === "full" ? "Your treasure box" : "Deposit only"}</span>
                <span className={`pill ${live === "live" ? "ok" : "warn"}`}>{live === "live" ? "Live" : "Reconnecting"}</span>
              </div>
              <div className="balance">{usd(balance)}</div>
              <div className="ens">{session.ensName}</div>
            </section>

            {pendingList.length > 0 && (
              <div className="notice pending">
                + ≈{usd(pendingUsd)} confirming ({pendingList.map((p) => cash(p.amount, p.currency)).join(" + ")})
                {retry && ` · retrying (${retry.attempt}/${retry.of})`}
              </div>
            )}
            {message && <div className="notice error">{message}</div>}

            <div className="insert-hint">💴 Insert your notes now</div>

            {position && (
              <div className="notice">
                Active: <span className="ens">{position.ensName}</span> — {position.pair} @ {apy(position.apyBps)} APY
                {position.rationale && <p className="speech">{position.rationale}</p>}
              </div>
            )}

            {session.scope === "full" ? (
              <div style={{ display: "grid", gap: 10 }}>
                {balance > 0 && !position && (
                  <button className="btn btn-block" onClick={() => setScreen("yield")} disabled={busy}>Get yield →</button>
                )}
                <div className="row">
                  <button className="btn" style={{ flex: 1 }} disabled={!canWithdraw || busy} onClick={() => onWithdraw("cash")}>
                    Withdraw as cash
                  </button>
                  <button className="btn" style={{ flex: 1 }} disabled={!canWithdraw || busy} onClick={() => onWithdraw("wallet")}>
                    Withdraw to wallet
                  </button>
                </div>
                {session.qrFallback && (
                  <div className="card" style={{ textAlign: "center", margin: 0 }}>
                    <p className="small muted">We couldn’t email your quick-deposit QR. Take a photo of it now:</p>
                    {/* eslint-disable-next-line @next/next/no-img-element -- data URL from the backend */}
                    <img src={session.qrFallback} alt="Your wallet QR" width={200} height={200} style={{ background: "#fff", borderRadius: 12, padding: 8 }} />
                  </div>
                )}
              </div>
            ) : (
              <p className="muted small" style={{ textAlign: "center" }}>To withdraw or earn yield, log in with your email.</p>
            )}

            <div className="row" style={{ marginTop: 14 }}>
              {testDeposit && (
                <button className="btn btn-ghost" onClick={onTestDeposit}>Test: insert RM10</button>
              )}
              <button className="btn btn-gold" style={{ flex: 1 }} onClick={logout}>Done — log out</button>
            </div>
          </>
        )}

        {screen === "yield" && (
          <section className="card">
            <button className="btn btn-ghost small" onClick={() => setScreen("account")}>← Back</button>
            <h2 style={{ marginTop: 12 }}>Get yield — 1inch Aqua on ETH/USDC</h2>
            <p className="muted small">Your {usd(balance)} becomes ETH/USDC liquidity. The agent explains its choice. Draw your own range in the web app.</p>
            {message && <div className="notice error">{message}</div>}
            <div className="tiers">
              {pools.map((p) => (
                <button key={p.riskTier} className="btn tier" data-tier={p.riskTier} disabled={busy} onClick={() => onOpenPosition(p.riskTier)}>
                  <span className="spread">
                    <span className="tier-name">{p.label} · {p.riskTier} risk</span>
                    <span className="amount" style={{ color: "var(--gold)" }}>~{apy(p.apyBps)} APY</span>
                  </span>
                  <span className="small muted">
                    {p.fullRange || p.priceLowUsd === null || p.priceHighUsd === null ? "Full range" : `${usd(p.priceLowUsd, 0)} – ${usd(p.priceHighUsd, 0)}`} · {(p.feeBps / 100).toFixed(2)}% fee
                  </span>
                </button>
              ))}
            </div>
            {busy && <p className="muted small" style={{ marginTop: 12 }}>The agent is placing your position…</p>}
          </section>
        )}

        {screen === "receipt" && receipt && (
          <section className="card" style={{ textAlign: "center" }}>
            <p className="label">Withdraw complete</p>
            <p className="amount" style={{ fontSize: 26, color: "var(--gold)" }}>{receipt.receipt}</p>
            <p className="muted small">
              {receipt.destination === "wallet"
                ? "USDC sent to your own wallet on Sepolia."
                : "Please collect your cash."}
            </p>
            <button className="btn btn-gold btn-block" onClick={logout}>Done</button>
          </section>
        )}

        {ticker.length > 0 && (
          <ul className="ticker" aria-label="Activity">
            {ticker.map((l, i) => <li key={i}>{l}</li>)}
          </ul>
        )}
      </div>
    </main>
  );
}

/// Wallet-QR camera scan. Browsers only allow the camera on a secure page
/// (https or localhost), so on the bench the kiosk is opened via localhost.
function Scanner({
  onResult,
  onCancel,
  hint,
  fallback = "log in with email instead",
  ignore = null,
}: {
  onResult: (text: string) => void;
  onCancel: (why?: string) => void;
  hint?: string;
  /** A QR to skip until `until` (the unknown one the customer was just shown). */
  ignore?: { text: string; until: number } | null;
  fallback?: string; // what to do when there's no camera (the deposit terminal has no email login)
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState("Starting the camera…");

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    let done = false;

    (async () => {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        onCancel(`Camera unavailable here (the page must be on localhost or https) — ${fallback}.`);
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      } catch (e) {
        onCancel(`Camera unavailable (${(e as Error).name}) — ${fallback}.`);
        return;
      }
      if (done) return;
      const video = videoRef.current!;
      video.srcObject = stream;
      await video.play().catch(() => {});
      setStatus("Looking for a QR code…");

      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
      const tick = () => {
        if (done) return;
        if (video.readyState === video.HAVE_ENOUGH_DATA) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          ctx.drawImage(video, 0, 0);
          const code = jsQR(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
          if (code?.data && ignore && code.data === ignore.text && Date.now() < ignore.until) {
            setStatus("That QR isn’t registered — show a different one.");
          } else if (code?.data) {
            done = true;
            setStatus("Got it — logging you in…");
            onResult(code.data);
            return;
          }
        }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    })();

    return () => {
      done = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
    // Runs once per scan screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section className="card">
      <p className="label" style={{ textAlign: "center" }}>Show your QR to the camera</p>
      {hint && <p className="muted small" style={{ textAlign: "center" }}>{hint}</p>}
      <div className="scan-frame">
        <video ref={videoRef} playsInline muted />
      </div>
      <p className="muted small" style={{ textAlign: "center" }}>{status}</p>
      <button className="btn btn-block" onClick={() => onCancel()}>Cancel</button>
    </section>
  );
}

// Choice-tile icons for the deposit terminal (inline, so they follow the theme).
function QrIcon() {
  return (
    <svg className="choice-icon" viewBox="0 0 48 48" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth="3" strokeLinejoin="round">
        <rect x="6" y="6" width="14" height="14" rx="2" />
        <rect x="28" y="6" width="14" height="14" rx="2" />
        <rect x="6" y="28" width="14" height="14" rx="2" />
      </g>
      <g fill="currentColor">
        <rect x="11" y="11" width="4" height="4" />
        <rect x="33" y="11" width="4" height="4" />
        <rect x="11" y="33" width="4" height="4" />
        <rect x="28" y="28" width="5" height="5" />
        <rect x="37" y="28" width="5" height="5" />
        <rect x="32.5" y="32.5" width="5" height="5" />
        <rect x="28" y="37" width="5" height="5" />
        <rect x="37" y="37" width="5" height="5" />
      </g>
    </svg>
  );
}

