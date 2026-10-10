"use client";

import { useEffect, useRef, useState } from "react";
import { useLoginWithEmail, useLoginWithOAuth, usePrivy } from "@privy-io/react-auth";
import { useBoxTransition } from "@/components/BoxTransition";

// Google first; email + code is the fallback behind "Use email instead".
type Step = "choose" | "email" | "code";

/// Privy email one-time code → Privy access token → POST /api/session, which
/// has the backend verify the token and sets the httpOnly session cookie.
export function LoginForm() {
  const box = useBoxTransition();
  const { ready, authenticated, getAccessToken, logout } = usePrivy();
  const { sendCode, loginWithCode } = useLoginWithEmail();
  // Google redirects away and back; on return Privy finishes the login here,
  // `authenticated` flips to true and the effect below completes it.
  const { initOAuth, state: oauthState } = useLoginWithOAuth({
    onError: () => setError("Google sign-in didn't finish. Try again, or use your email."),
  });
  const googleBusy = oauthState.status === "loading";
  const [step, setStep] = useState<Step>("choose");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const exchanging = useRef(false);

  async function exchange() {
    if (exchanging.current) return;
    exchanging.current = true;
    try {
      const accessToken = await getAccessToken();
      if (!accessToken) throw new Error("Privy didn't return a login token — try again");
      const res = await fetch("/api/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accessToken }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "login failed");
      // Everyone lands on My box.
      await box.openInto("/");
    } catch (e) {
      exchanging.current = false;
      setError(e instanceof Error ? e.message : "login failed");
      // Start over cleanly: a Privy session the backend refused is no use.
      setStep("choose");
      await logout().catch(() => {});
    }
  }

  // Already logged in with Privy (e.g. the cookie expired): swap the token
  // for a fresh backend session without asking for another code.
  // exchange() only sets state after awaiting Privy and the backend.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (ready && authenticated) void exchange();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, authenticated]);

  async function onSendCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await sendCode({ email: email.trim() });
      setStep("code");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't send the code");
    } finally {
      setBusy(false);
    }
  }

  async function onLogin(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await loginWithCode({ code: code.trim() });
      // `authenticated` flips to true and the effect above finishes the login.
    } catch {
      setError("That code is wrong or has expired. Check it, or send a new one.");
      setBusy(false);
    }
  }

  // Privy is logged in: the effect above is swapping its token for a session.
  if (!ready || authenticated) {
    return (
      <div className="card login-card" style={{ textAlign: "center" }}>
        <p className="muted" style={{ margin: 0 }}>{authenticated ? "Opening your box…" : "Loading…"}</p>
      </div>
    );
  }

  return (
    <div className="card login-card">
      {error && <div className="notice error">{error}</div>}
      {step === "choose" ? (
        <div>
          <button
            type="button"
            className="btn btn-google btn-block"
            disabled={googleBusy}
            onClick={() => {
              setError("");
              void initOAuth({ provider: "google" });
            }}
          >
            <GoogleMark />
            {googleBusy ? "Opening Google…" : "Continue with Google"}
          </button>
          <div className="login-or"><span>or</span></div>
          <button
            type="button"
            className="btn btn-outline btn-block"
            onClick={() => {
              setError("");
              setStep("email");
            }}
          >
            Use email instead
          </button>
          <p className="muted small" style={{ textAlign: "center", marginTop: 16, marginBottom: 0 }}>
            Use the same email as at the kiosk to see the same box.
          </p>
        </div>
      ) : step === "email" ? (
        <form onSubmit={onSendCode}>
          <label className="label" htmlFor="email">Email</label>
          <input
            id="email"
            className="input"
            type="email"
            autoComplete="email"
            required
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={{ marginTop: 6 }}
          />
          <button className="btn btn-gold btn-block" disabled={busy || !email}>
            {busy ? "Sending…" : "Email me a code"}
          </button>
          <p className="muted small" style={{ marginTop: 14, marginBottom: 0 }}>
            Use the same email as at the kiosk to see the same box.
          </p>
          <button
            type="button"
            className="btn btn-ghost small"
            style={{ marginTop: 12 }}
            onClick={() => {
              setError("");
              setStep("choose");
            }}
          >
            ← Continue with Google instead
          </button>
        </form>
      ) : (
        <form onSubmit={onLogin}>
          <label className="label" htmlFor="code">Code sent to {email}</label>
          <input
            id="code"
            className="input code-input"
            inputMode="numeric"
            autoComplete="one-time-code"
            required
            maxLength={6}
            placeholder="••••••"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            style={{ marginTop: 6 }}
            autoFocus
          />
          <button className="btn btn-gold btn-block" disabled={busy || code.length < 6}>
            {busy ? "Checking…" : "Log in"}
          </button>
          <div className="spread" style={{ marginTop: 12 }}>
            <button type="button" className="btn btn-ghost small" onClick={() => { setStep("email"); setCode(""); }}>
              ← Different email
            </button>
            <button type="button" className="btn btn-ghost small" disabled={busy} onClick={onSendCode}>
              Send a new code
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function GoogleMark() {
  return (
    <svg className="google-mark" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}
