import "server-only";
import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";

/// Server-side access to the Express backend. The backend session token lives
/// only in an httpOnly cookie and in these server calls — browser JavaScript
/// never sees it.

export const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:4000";

/// The customer app (phones/laptops) and the box's own screen keep separate
/// sessions, so a phone login and the kiosk never share one.
export type SessionKind = "web" | "kiosk";
export const SESSION_COOKIE: Record<SessionKind, string> = { web: "tb_session", kiosk: "tb_kiosk_session" };

export class BackendError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

function errorCode(body: unknown): string | undefined {
  const code = (body as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

function errorMessage(body: unknown, status: number): string {
  const error = (body as { error?: unknown } | null)?.error;
  if (typeof error === "string") return error;
  if (error) return JSON.stringify(error);
  return `backend returned ${status}`;
}

export async function backendFetch<T>(
  path: string,
  opts: { token?: string | null; method?: "GET" | "POST"; body?: unknown } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(`${BACKEND_URL}${path}`, {
      method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      cache: "no-store",
    });
  } catch {
    throw new BackendError(502, "The Takarabako backend is unreachable");
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new BackendError(res.status, errorMessage(body, res.status), errorCode(body));
  return body as T;
}

export async function sessionToken(kind: SessionKind): Promise<string | null> {
  return (await cookies()).get(SESSION_COOKIE[kind])?.value ?? null;
}

/// Stores a backend session in its httpOnly cookie. The cookie outlives the
/// backend's sliding expiry on purpose: the backend is the judge, and a 401
/// from it clears the cookie.
export function setSessionCookie(res: NextResponse, req: NextRequest, kind: SessionKind, token: string) {
  res.cookies.set(SESSION_COOKIE[kind], token, {
    httpOnly: true,
    sameSite: "lax",
    secure: req.nextUrl.protocol === "https:",
    path: "/",
    maxAge: kind === "web" ? 60 * 60 * 12 : 60 * 30,
  });
}

export function clearSessionCookie(res: NextResponse, kind: SessionKind) {
  res.cookies.delete(SESSION_COOKIE[kind]);
}

/// Route-handler helper: calls the backend with this request's session and
/// relays the result. A backend 401 also clears the stale cookie.
export async function relay(
  kind: SessionKind,
  path: string,
  opts: { method?: "GET" | "POST"; body?: unknown } = {},
): Promise<NextResponse> {
  const token = await sessionToken(kind);
  if (!token) return NextResponse.json({ error: "log in first" }, { status: 401 });
  try {
    return NextResponse.json(await backendFetch(path, { ...opts, token }));
  } catch (err) {
    return errorResponse(err, kind);
  }
}

export function errorResponse(err: unknown, kind?: SessionKind): NextResponse {
  const status = err instanceof BackendError ? err.status : 500;
  const message = err instanceof Error ? err.message : "request failed";
  const code = err instanceof BackendError ? err.code : undefined;
  const res = NextResponse.json(code ? { error: message, code } : { error: message }, { status });
  if (status === 401 && kind) clearSessionCookie(res, kind);
  return res;
}

/// Streams the backend's SSE feed for this request's session. Aborting the
/// browser request (tab closed, navigation) also closes the upstream stream.
export async function proxyEventStream(req: NextRequest, kind: SessionKind): Promise<Response> {
  const token = await sessionToken(kind);
  if (!token) return new Response("log in first", { status: 401 });

  let upstream: Response;
  try {
    upstream = await fetch(`${BACKEND_URL}/events/stream`, {
      headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" },
      signal: req.signal,
      cache: "no-store",
    });
  } catch {
    return new Response("backend unreachable", { status: 502 });
  }
  if (!upstream.ok || !upstream.body) {
    return new Response(await upstream.text().catch(() => ""), { status: upstream.status || 502 });
  }
  return new Response(upstream.body, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
