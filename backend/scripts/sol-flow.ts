// The customer's journey through the Solana destinations, driven over HTTP
// against a RUNNING backend (npm run dev), the way the kiosk calls it:
//   email login → Hold visit (RM10 → mUSD in their Solana wallet)
//   → Earn High visit (Finish opens a Meteora position) → close it → paid in mUSD
// Each visit uses one test RM10 note. Real devnet transactions and a real
// Privy Solana wallet the first time the account picks Solana, so use a demo
// account, never a real customer's:
//   cd backend && npm run sol:flow -- [email]     (default bob.demo@takarabako.test)
// FLOW_API overrides the backend URL (default http://localhost:$PORT).
import { PublicKey } from "@solana/web3.js";
import { balanceRaw, fromRaw } from "../src/solana/musd.js";

const API = process.env.FLOW_API ?? `http://localhost:${process.env.PORT ?? 4000}`;
const EMAIL = process.argv[2] ?? "bob.demo@takarabako.test";
const WAIT_MS = 240_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let token = "";
let failures = 0;

// Loose on purpose: this checks the API's shape as the kiosk sees it.
type Json = any;

async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; json: Json }> {
  const res = await fetch(API + path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  try {
    return { status: res.status, json: JSON.parse(text) };
  } catch {
    return { status: res.status, json: text };
  }
}

function check(label: string, ok: boolean, detail = ""): boolean {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
  return ok;
}

/// Polls until fn() reports done, or gives up after timeoutMs.
async function until<T extends { done: boolean }>(fn: () => Promise<T>, timeoutMs = WAIT_MS): Promise<T> {
  const end = Date.now() + timeoutMs;
  let last = await fn();
  while (!last.done && Date.now() < end) {
    await sleep(3_000);
    last = await fn();
  }
  return last;
}

const me = () => call("GET", "/solana/me").then((r) => r.json);

/// One kiosk visit: open → choose destination → one RM10 note → wait → Finish.
async function visit(destination: "sol_hold" | "sol_earn", tier?: "low" | "medium" | "high") {
  console.log(`\n== Visit: ${tier ? `${destination} / ${tier}` : destination} ==`);
  const open = await call("POST", "/deposit-sessions");
  if (!check("open deposit session", open.status === 200 && Boolean(open.json.id), `${open.status} ${JSON.stringify(open.json)}`)) return null;
  const id: string = open.json.id;

  const dest = await call("POST", `/deposit-sessions/${id}/destination`, tier ? { destination, tier } : { destination });
  check("choose destination", dest.status === 200, `${dest.status} ${JSON.stringify(dest.json)}`);

  const dep = await call("POST", "/deposit", { amount: 10, currency: "MYR" });
  check("insert RM10 note", dep.status === 202, `${dep.status} deposit ${dep.json.depositId ?? JSON.stringify(dep.json)}`);

  const locked = await call("POST", `/deposit-sessions/${id}/destination`, { destination: "evm" });
  check("destination locked after the first note", locked.status === 409, String(locked.status));

  const settled = await until(async () => {
    const notes: Json[] = (await call("GET", `/deposit-sessions/${id}`)).json.notes ?? [];
    return { done: notes.length > 0 && notes.every((n) => n.status === "confirmed" || n.status === "failed"), notes };
  });
  const note = settled.notes[0];
  check("note confirmed on Solana", settled.done && settled.notes.every((n: Json) => n.status === "confirmed" && n.chain === "sol"),
    `${note?.status} $${note?.usdAmount} tx ${note?.txHash}`);

  const fin = await call("POST", `/deposit-sessions/${id}/finish`);
  check("finish visit", fin.status === 200 && fin.json.destination === destination, `${fin.status} destination=${fin.json.destination} tier=${fin.json.tier ?? "-"}`);
  return { id, usd: Number(note?.usdAmount ?? 0) };
}

async function main() {
  console.log(`sol:flow against ${API} as ${EMAIL}`);
  const status = await call("GET", "/solana/status").catch(() => null);
  if (!status || !status.json.ready) {
    console.error(`Solana isn't ready at ${API} (${status ? status.json.reason : "backend not reachable — start it with npm run dev"})`);
    process.exit(1);
  }

  const login = await call("POST", "/verify", { email: EMAIL });
  if (!check("kiosk email login", login.status === 200 && Boolean(login.json.token), `${login.status} ${login.json.ensName ?? JSON.stringify(login.json)}`)) process.exit(1);
  token = login.json.token;

  const start = await me();
  const musd0 = Number(start.musd ?? 0);
  check("dashboard /solana/me", start.ready === true, `wallet=${start.wallet ?? "none yet"} mUSD=${start.musd} positions=${start.positions?.length}`);

  // Hold: the note is minted as mUSD straight to the customer's wallet.
  const hold = await visit("sol_hold");
  let musd1 = musd0;
  if (hold) {
    const after = await until(async () => {
      const r = await me();
      return { done: Number(r.musd ?? 0) >= musd0 + hold.usd - 1e-6, r };
    }, 60_000);
    musd1 = Number(after.r.musd ?? 0);
    check("mUSD arrived in the customer's wallet", after.done, `${musd0} → ${musd1} (wallet ${after.r.wallet})`);
  }

  // Earn High: Finish opens a Meteora position; the customer then closes it.
  const known = new Set(((await me()).positions ?? []).map((p: Json) => p.id));
  const earn = await visit("sol_earn", "high");
  if (earn) {
    const opened = await until(async () => {
      const p = ((await me()).positions ?? []).find((x: Json) => !known.has(x.id));
      return { done: Boolean(p) && ["open", "failed"].includes(p.status), p };
    });
    const p = opened.p;
    check("Meteora position opened", p?.status === "open",
      `bins ${p?.minBinId}..${p?.maxBinId} value $${p?.valueUsd} inRange=${p?.inRange} tx ${p?.openSig}${p?.error ? ` error ${p.error}` : ""}`);
    if (p?.status === "open") {
      const close = await call("POST", `/solana/positions/${p.id}/close`);
      check("close position", close.status === 202, `${close.status} ${JSON.stringify(close.json)}`);
      const again = await call("POST", `/solana/positions/${p.id}/close`);
      check("second close refused", again.status === 409, String(again.status));
      const closed = await until(async () => {
        const r = await me();
        const q = (r.positions ?? []).find((x: Json) => x.id === p.id);
        return { done: Boolean(q) && ["closed", "failed"].includes(q.status), q, musd: Number(r.musd ?? 0) };
      });
      check("position closed and paid in mUSD", closed.q?.status === "closed" && closed.musd > musd1,
        `paid ${closed.q?.valueOut} of ${p.musdIn} · mUSD ${musd1} → ${closed.musd} · tx ${closed.q?.payoutSig}`);
    }
  }

  // The wallet balance read straight from devnet must match the dashboard.
  const end = await me();
  if (end.wallet) {
    const onChain = fromRaw(await balanceRaw(new PublicKey(end.wallet)));
    check("on-chain mUSD matches the dashboard", Math.abs(onChain - Number(end.musd)) < 1e-6, `devnet ${onChain} · dashboard ${end.musd}`);
  }

  const bad = await call("POST", "/deposit-sessions/00000000-0000-0000-0000-000000000000/destination", { destination: "sol_earn" });
  check("Earn without a tier is rejected", bad.status === 400, String(bad.status));

  const ops = await call("GET", "/dashboard/solana");
  check("/ops Solana panel", ops.status === 200 && ops.json.ready === true,
    `treasury ${ops.json.treasurySol} SOL · mUSD supply ${ops.json.musdSupply} · market ${ops.json.market ? `$${ops.json.market.solUsd}` : "no Solami key"}`);

  await call("POST", "/logout");
  console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
