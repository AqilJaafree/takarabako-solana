import { Router } from "express";
import { PublicKey } from "@solana/web3.js";
import { asyncHandler } from "../asyncHandler.js";
import { config } from "../config.js";
import { requireSession, type Session } from "../sessions.js";
import { findByPrivyUserId } from "../accounts.js";
import { solanaAvailable, solanaReady, treasurySol, treasury } from "../solana/client.js";
import { balanceRaw, fromRaw, supplyRaw } from "../solana/musd.js";
import { poolState } from "../solana/meteora.js";
import { SOL_TIERS } from "../solana/tiers.js";
import { driftPct, solMarketPrice } from "../solana/marketPrice.js";
import { getPosition, listLivePositions, listPositions, markClosing } from "../solana/store.js";
import { viewPosition } from "../solana/positions.js";
import { enqueueClose } from "../solana/jobs.js";
import { cancelWebEarn, prepareWebEarn, submitWebEarn } from "../solana/webEarn.js";
import { solanaWalletFor } from "../solana/wallets.js";

export const solanaRouter = Router();

const tiers = () => Object.entries(SOL_TIERS).map(([id, t]) => ({ id, label: t.label, blurb: t.blurb, width: t.width }));

/// GET /solana/status — public: can the kiosk offer Solana, and the tiers.
solanaRouter.get("/solana/status", asyncHandler(async (_req, res) => {
  const available = await solanaAvailable();
  const pool = available.ok ? await poolState().catch(() => null) : null;
  res.json({ ready: available.ok && Boolean(pool), reason: available.reason ?? null, pool, tiers: tiers() });
}));

/// GET /solana/me — the customer's Solana wallet, mUSD balance and positions.
solanaRouter.get("/solana/me", requireSession("full"), asyncHandler(async (_req, res) => {
  const session: Session = res.locals.session;
  const account = await findByPrivyUserId(session.privyUserId);
  if (!account) {
    res.status(404).json({ error: "unknown account" });
    return;
  }
  if (!solanaReady) {
    res.json({ ready: false, wallet: account.solanaWallet, musd: null, positions: [] });
    return;
  }
  // No kiosk visit needed: the first look at the Solana page creates the
  // customer's Privy Solana wallet. A Privy failure leaves it null and the
  // page offers a retry.
  let wallet = account.solanaWallet;
  if (!wallet) {
    wallet = await solanaWalletFor(account).catch((err) => {
      console.error("[solana] /me wallet creation failed:", err instanceof Error ? err.message : err);
      return null;
    });
  }
  let musd: number | null = 0;
  if (wallet) {
    try {
      musd = fromRaw(await balanceRaw(new PublicKey(wallet)));
    } catch (err) {
      console.error("[solana] /me mUSD balance read failed:", err instanceof Error ? err.message : err);
      musd = null;
    }
  }
  const rows = await listPositions(account.privyUserId);
  res.json({ ready: true, wallet, musd, positions: await Promise.all(rows.map((r) => viewPosition(r))) });
}));

/// POST /solana/positions/:id/close — queue the close; the result arrives on the live stream.
solanaRouter.post("/solana/positions/:id/close", requireSession("full"), asyncHandler(async (req, res) => {
  const session: Session = res.locals.session;
  const row = await getPosition(String(req.params.id));
  if (!row || row.privyUserId !== session.privyUserId) {
    res.status(404).json({ error: "position not found" });
    return;
  }
  if (!(await markClosing(row.id, session.privyUserId))) {
    res.status(409).json({ error: `position is ${row.status}` });
    return;
  }
  await enqueueClose(row.id);
  res.status(202).json({ id: row.id, status: "closing" });
}));

/// POST /solana/earn/prepare { amount, tier } — Earn from mUSD the customer
/// holds: returns the transfer for them to approve in their wallet.
solanaRouter.post("/solana/earn/prepare", requireSession("full"), asyncHandler(async (req, res) => {
  const session: Session = res.locals.session;
  const available = await solanaAvailable();
  if (!available.ok) {
    res.status(503).json({ error: `Solana is unavailable right now (${available.reason})`, code: "solana_unavailable" });
    return;
  }
  const account = await findByPrivyUserId(session.privyUserId);
  if (!account) {
    res.status(404).json({ error: "unknown account" });
    return;
  }
  const reply = await prepareWebEarn(account, req.body?.amount, req.body?.tier);
  res.status(reply.status).json(reply.body);
}));

/// POST /solana/earn/submit { id, signedTx } — the approved transfer; the
/// position opens once it confirms (follow it on GET /solana/me).
solanaRouter.post("/solana/earn/submit", requireSession("full"), asyncHandler(async (req, res) => {
  const session: Session = res.locals.session;
  const reply = await submitWebEarn(session.privyUserId, String(req.body?.id ?? ""), req.body?.signedTx);
  res.status(reply.status).json(reply.body);
}));

/// POST /solana/earn/cancel { id } — drop an Earn that wasn't approved; frees
/// its share of the daily limit.
solanaRouter.post("/solana/earn/cancel", requireSession("full"), asyncHandler(async (req, res) => {
  const session: Session = res.locals.session;
  const reply = await cancelWebEarn(session.privyUserId, String(req.body?.id ?? ""));
  res.status(reply.status).json(reply.body);
}));

/// GET /dashboard/solana — the /ops Solana card.
solanaRouter.get("/dashboard/solana", asyncHandler(async (_req, res) => {
  if (!solanaReady) {
    res.json({ ready: false });
    return;
  }
  const [sol, supply, pool, live, market] = await Promise.all([treasurySol(), supplyRaw(), poolState(), listLivePositions(), solMarketPrice()]);
  const views = await Promise.all(live.filter((r) => r.status === "open").map((r) => viewPosition(r)));
  res.json({
    ready: true,
    treasury: treasury().publicKey.toBase58(),
    treasurySol: sol,
    lowSol: sol < config.solana.minTreasurySol,
    musdSupply: fromRaw(supply),
    pool,
    market: market && { ...market, driftPct: driftPct(pool.solPriceUsd, market.solUsd) },
    positions: {
      open: views.length,
      opening: live.filter((r) => r.status === "opening").length,
      closing: live.filter((r) => r.status === "closing").length,
      tvlUsd: Math.round(views.reduce((s, v) => s + (v.valueUsd ?? 0), 0) * 100) / 100,
    },
  });
}));
