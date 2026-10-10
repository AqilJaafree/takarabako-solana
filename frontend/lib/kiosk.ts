import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { BackendError, backendFetch, setSessionCookie } from "./backend";
import type { DailyLimit, KioskLogin } from "./types";

/// The Pi's bill-acceptor bridge (device-agent/server.js). After a kiosk
/// login, this server — never the browser — hands it the session token, so
/// notes stacked by the serial listener are deposited into that account.
/// Unset = no bridge (bench testing without the box).
export const PI_BRIDGE_URL = process.env.PI_BRIDGE_URL ?? "";
// Required by the bridge when it's reached through a tunnel (device-agent/server.js).
// Shared with the Pi bridge's BRIDGE_SECRET; PI_BRIDGE_SECRET is accepted too.
const BRIDGE_SECRET = process.env.BRIDGE_SECRET || process.env.PI_BRIDGE_SECRET || "";

async function bridge(path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (BRIDGE_SECRET) headers["x-bridge-secret"] = BRIDGE_SECRET;
  return fetch(`${PI_BRIDGE_URL}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(3000),
  });
}

export async function bridgeStartSession(s: { token: string; ensName: string; scope: string; expiresAt: string }) {
  if (!PI_BRIDGE_URL) return "skipped" as const;
  try {
    const res = await bridge("/session", { ...s, expiresAt: Date.parse(s.expiresAt) });
    return res.ok ? ("ok" as const) : ("failed" as const);
  } catch {
    return "failed" as const;
  }
}

export async function bridgeEndSession() {
  if (!PI_BRIDGE_URL) return;
  await bridge("/session/end", {}).catch(() => {});
}

export async function bridgeEvents(since: number): Promise<unknown[]> {
  if (!PI_BRIDGE_URL) return [];
  const res = await bridge(`/events?since=${since}`);
  const { events } = (await res.json()) as { events: unknown[] };
  return events;
}

interface BackendLogin {
  token: string;
  ensName: string;
  balance: number;
  scope: "full" | "deposit";
  expiresAt: string;
  qrFallback?: string | null;
  qrEmailed?: boolean;
  limit?: DailyLimit;
}

/// Finishes a kiosk login: hand the session to the Pi bridge, keep the token
/// in the kiosk cookie, and give the browser only what it shows.
export async function kioskLoginResponse(req: NextRequest, login: BackendLogin) {
  // Every visit to the cash slot is a deposit session that ends in a receipt.
  let depositBlocked: string | null = null;
  const depositSession = await backendFetch<{ id: string }>("/deposit-sessions", { token: login.token, method: "POST" }).catch(
    (err) => {
      // Today's limit is used: keep the slot closed.
      if (err instanceof BackendError && err.status === 403) depositBlocked = err.message;
      else console.error("[kiosk] could not open a deposit session:", err instanceof Error ? err.message : err);
      return null;
    },
  );
  const bridgeStatus = depositBlocked ? "skipped" : await bridgeStartSession(login);
  const body: KioskLogin = {
    ensName: login.ensName,
    balance: login.balance,
    scope: login.scope,
    expiresAt: login.expiresAt,
    qrFallback: login.qrFallback ?? null,
    qrEmailed: login.qrEmailed ?? false,
    bridge: bridgeStatus,
    depositSessionId: depositSession?.id ?? null,
    limit: login.limit ?? null,
    depositBlocked,
  };
  const res = NextResponse.json(body);
  setSessionCookie(res, req, "kiosk", login.token);
  return res;
}
