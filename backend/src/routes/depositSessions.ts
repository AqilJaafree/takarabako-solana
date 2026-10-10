import { Router } from "express";
import { z } from "zod";
import { requireSession, type Session } from "../sessions.js";
import {
  currentOpenSession,
  finishDepositSession,
  getReceipt,
  listHistory,
  openDepositSession,
  recordRefused,
  type HistoryKind,
} from "../history.js";
import { maybeSendReceipt } from "../receiptEmail.js";
import { publishUserEvent } from "../events.js";
import { asyncHandler } from "../asyncHandler.js";
import { findByPrivyUserId } from "../accounts.js";
import { dailyAllowance } from "../limits.js";
import { parseDestination, setSessionDestination, sessionDestination } from "../solana/store.js";
import { solanaAvailable } from "../solana/client.js";
import { solanaWalletFor } from "../solana/wallets.js";
import { enqueueOpen } from "../solana/jobs.js";

/// Deposit sessions (a visit to the cash slot, ending in a receipt), refused
/// notes, and the customer's History.
export const depositSessionsRouter = Router();

/// POST /deposit-sessions — start a visit; every note deposited until it is
/// finished belongs to it. Any login (wallet QR or email) may open one.
/// A customer who has used today's limit can't start a new visit
/// (notes already in the acceptor are always credited).
depositSessionsRouter.post("/deposit-sessions", requireSession("deposit"), asyncHandler(async (_req, res) => {
  const session: Session = res.locals.session;
  const account = await findByPrivyUserId(session.privyUserId);
  const allowance = account ? await dailyAllowance(account) : null;
  if (allowance?.limited && allowance.leftUsd <= 0) {
    res.status(403).json({
      error: `You've reached today's $${allowance.limitUsd.toLocaleString("en-US")} deposit limit. Come back tomorrow to deposit more.`,
      code: "daily_limit",
    });
    return;
  }
  res.json(await openDepositSession(session.privyUserId));
}));

async function ownReceipt(id: string, session: Session) {
  const receipt = await getReceipt(id);
  return receipt && receipt.privyUserId === session.privyUserId ? receipt : null;
}

/// GET /deposit-sessions/:id — the receipt so far (notes, statuses, totals).
depositSessionsRouter.get("/deposit-sessions/:id", requireSession("deposit"), asyncHandler(async (req, res) => {
  const receipt = await ownReceipt(String(req.params.id), res.locals.session);
  if (!receipt) {
    res.status(404).json({ error: "receipt not found" });
    return;
  }
  res.json(receipt);
}));

/// POST /deposit-sessions/:id/destination { destination, tier? } — where this
/// visit's cash goes. Allowed until the first note; Solana needs a funded
/// treasury and creates the customer's Solana wallet on first use.
depositSessionsRouter.post("/deposit-sessions/:id/destination", requireSession("deposit"), asyncHandler(async (req, res) => {
  const choice = parseDestination(req.body);
  if (!choice) {
    res.status(400).json({ error: "destination must be evm, sol_hold, or sol_earn with tier low|medium|high" });
    return;
  }
  const session: Session = res.locals.session;
  if (choice.destination !== "evm") {
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
    await solanaWalletFor(account);
  }
  const result = await setSessionDestination(String(req.params.id), session.privyUserId, choice.destination, choice.tier);
  if (result === "not_found") {
    res.status(404).json({ error: "deposit session not found" });
    return;
  }
  if (result === "locked") {
    res.status(409).json({ error: "notes are already in — the destination can't change now", code: "destination_locked" });
    return;
  }
  res.json({ ok: true, ...choice });
}));

/// POST /deposit-sessions/:id/finish — the customer tapped Finish. Returns
/// the receipt; it's emailed once every note has confirmed.
depositSessionsRouter.post("/deposit-sessions/:id/finish", requireSession("deposit"), asyncHandler(async (req, res) => {
  const id = String(req.params.id);
  if (!(await ownReceipt(id, res.locals.session))) {
    res.status(404).json({ error: "receipt not found" });
    return;
  }
  await finishDepositSession(id);
  if ((await sessionDestination(id)).destination === "sol_earn") {
    await enqueueOpen(id).catch((err) => console.error(`[solana] could not queue the position for ${id}:`, err));
  }
  await maybeSendReceipt(id).catch((err) => console.error(`[receipt] ${id}:`, err));
  res.json(await getReceipt(id));
}));

const RefusedBody = z.object({ reason: z.enum(["unsupported", "bad_condition"]) });

/// POST /refused — the acceptor handed a note back (reported by the Pi
/// bridge with the logged-in session). Saved to History and pushed live.
depositSessionsRouter.post("/refused", requireSession("deposit"), asyncHandler(async (req, res) => {
  const parsed = RefusedBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "reason must be unsupported or bad_condition" });
    return;
  }
  const session: Session = res.locals.session;
  const open = await currentOpenSession(session.privyUserId);
  await recordRefused({ privyUserId: session.privyUserId, sessionId: open?.id ?? null, reason: parsed.data.reason });
  await publishUserEvent(session.privyUserId, { type: "deposit.refused", reason: parsed.data.reason, sessionId: open?.id ?? null });
  res.json({ ok: true });
}));

const KINDS: HistoryKind[] = ["deposit_session", "withdrawal", "yield", "refused", "transfer"];

/// GET /history?kind=&limit= — everything that happened to the box, newest first.
depositSessionsRouter.get("/history", requireSession("full"), asyncHandler(async (req, res) => {
  const kind = KINDS.find((k) => k === req.query.kind);
  const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 200);
  res.json({ items: await listHistory(res.locals.session.privyUserId, { limit, kind }) });
}));
