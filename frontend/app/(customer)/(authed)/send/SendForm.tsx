"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { MyWallet, ResolvedName } from "@/lib/types";
import { SEPOLIA_TX, shortHex, usd } from "@/lib/format";
import { useWalletSend, type PreparedTx } from "@/lib/useWalletSend";

type Asset = "balance" | "tkcash";

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : "request failed");
  return json as T;
}

/// Resolves a typed name through the official ENS v2 resolver (debounced).
export function useResolvedName(input: string) {
  const [state, setState] = useState<{ loading: boolean; result: ResolvedName | null; error: string }>({ loading: false, result: null, error: "" });
  const seq = useRef(0);
  useEffect(() => {
    const name = input.trim().toLowerCase();
    const id = ++seq.current;
    if (!name.includes(".")) {
      const t = setTimeout(() => id === seq.current && setState({ loading: false, result: null, error: "" }), 0);
      return () => clearTimeout(t);
    }
    const t = setTimeout(async () => {
      setState((s) => ({ ...s, loading: true }));
      const res = await fetch(`/api/ens/resolve?name=${encodeURIComponent(name)}`);
      const json = await res.json().catch(() => ({}));
      if (id !== seq.current) return;
      setState(res.ok ? { loading: false, result: json, error: "" } : { loading: false, result: null, error: json.error ?? "not found" });
    }, 350);
    return () => clearTimeout(t);
  }, [input]);
  return state;
}

export function NameField({ value, onChange, resolved }: { value: string; onChange: (v: string) => void; resolved: ReturnType<typeof useResolvedName> }) {
  const r = resolved.result;
  return (
    <div className="name-field">
      <label className="label" htmlFor="to-name">To</label>
      <input
        id="to-name"
        className="input mono"
        placeholder="name.takarabako.eth"
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <div className="name-status small">
        {resolved.loading ? (
          <span className="muted">Looking up on ENS…</span>
        ) : r ? (
          <>
            <span className="tone-ok">✓ {r.name}</span> → <span className="mono">{shortHex(r.address, 8, 6)}</span>
            {r.customer ? <span className="pill ok">Takarabako customer</span> : <span className="pill warn">External wallet</span>}
            {r.kind === "kiosk" && <span className="pill">Kiosk</span>}
          </>
        ) : resolved.error ? (
          <span className="tone-bad">{resolved.error}</span>
        ) : (
          <span className="muted">Resolved through the official ENS v2 Universal Resolver.</span>
        )}
      </div>
    </div>
  );
}

export function SendForm({ balance, wallet }: { balance: number; wallet: MyWallet }) {
  const router = useRouter();
  const signAndSend = useWalletSend();
  const [asset, setAsset] = useState<Asset>("balance");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<{ text: string; tx: string | null } | null>(null);
  const resolved = useResolvedName(to);
  const r = resolved.result;
  const tk = wallet.tkcash;
  const available = asset === "balance" ? balance : tk?.balance ?? 0;
  const dailyLeft = tk?.dailyLimit != null ? Math.max(0, tk.dailyLimit - tk.spentToday) : null;
  const value = Number(amount);

  const limitLeft = wallet.limit?.limited ? wallet.limit.leftUsd : null;
  const problem = limitLeft !== null && value > limitLeft
    ? `Accounts can move ${usd(wallet.limit!.limitUsd, 0)} a day — ${usd(limitLeft)} left today.`
    : !r
    ? null
    : asset === "balance" && !r.customer
      ? "Box balance can only go to another Takarabako box."
      : asset === "tkcash" && r.tkcashAllowlisted === false
        ? "This wallet can't hold tkCASH — only identity-verified Takarabako wallets can."
        : r.address.toLowerCase() === wallet.wallet.toLowerCase()
          ? "That's your own name."
          : asset === "tkcash" && dailyLeft !== null && value > dailyLeft
            ? `tkCASH transfers are limited to ${usd(tk!.dailyLimit)} a day — ${usd(dailyLeft)} left today.`
            : null;

  async function send() {
    if (!r) return;
    setBusy(true);
    setError("");
    setDone(null);
    try {
      if (asset === "balance") {
        const res = await post<{ txHash: string }>("/api/send/balance", { to: r.name, amount: value });
        setDone({ text: `Sent ${usd(value)} from your box to ${r.name}`, tx: res.txHash });
      } else {
        const prep = await post<{ tx: PreparedTx; from: string }>("/api/send/tkcash/prepare", { to: r.name, amount: value });
        const hash = await signAndSend(prep.tx, prep.from, `Send ${value} tkCASH to ${r.name}`);
        await post("/api/send/tkcash/confirm", { txHash: hash, to: r.name });
        setDone({ text: `Sent ${value} tkCASH to ${r.name} from your own wallet`, tx: hash });
      }
      setAmount("");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "send failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <div className="yield-tabs" role="tablist" aria-label="What to send">
        <button role="tab" aria-selected={asset === "balance"} className={asset === "balance" ? "is-on" : ""} onClick={() => setAsset("balance")}>
          Box balance <span className="muted small">{usd(balance)}</span>
        </button>
        <button role="tab" aria-selected={asset === "tkcash"} className={asset === "tkcash" ? "is-on" : ""} onClick={() => setAsset("tkcash")}>
          tkCASH <span className="muted small">{tk ? `${tk.balance.toFixed(2)} in your wallet` : "unavailable"}</span>
        </button>
      </div>

      <p className="muted small">
        {asset === "balance"
          ? "Moves money from your box to theirs straight away. Takarabako handles it — no gas."
          : "tkCASH lives in your own wallet, so you sign this transfer yourself. The token's rules apply on-chain: both wallets must be identity-verified, and there's a daily limit."}
      </p>

      <NameField value={to} onChange={setTo} resolved={resolved} />

      <label className="label" htmlFor="send-amount" style={{ display: "block", marginTop: 14 }}>Amount</label>
      <div className="row" style={{ flexWrap: "nowrap", marginTop: 6 }}>
        <input id="send-amount" className="input" type="number" min={0} step="0.01" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ margin: 0 }} />
        <button type="button" className="btn btn-ghost small chip" onClick={() => setAmount(String(Math.floor(available * 100) / 100))}>Max</button>
      </div>
      <p className="muted small" style={{ margin: "4px 0 0" }}>
        {usd(available)} available
        {asset === "tkcash" && dailyLeft !== null && ` · ${usd(dailyLeft)} of today's ${usd(tk!.dailyLimit)} limit left`}
        {asset === "tkcash" && ` · wallet gas ${wallet.eth.toFixed(4)} ETH`}
      </p>

      {problem && <div className="notice pending" style={{ marginTop: 12 }}>{problem}</div>}
      {error && <div className="notice error" style={{ marginTop: 12 }}>{error}</div>}
      {done && (
        <div className="notice success" style={{ marginTop: 12 }}>
          {done.text}
          {done.tx && (
            <> · <a href={SEPOLIA_TX(done.tx)} target="_blank" rel="noreferrer" className="mono">{shortHex(done.tx)}</a></>
          )}
        </div>
      )}

      <button
        className="btn btn-gold btn-block"
        style={{ marginTop: 14 }}
        disabled={busy || !r || Boolean(problem) || !(value > 0) || value > available}
        onClick={send}
      >
        {busy ? (asset === "tkcash" ? "Waiting for your wallet…" : "Sending…") : r ? `Send ${value > 0 ? (asset === "tkcash" ? `${value} tkCASH` : usd(value)) : ""} to ${r.name}` : "Enter a name"}
      </button>
    </section>
  );
}
