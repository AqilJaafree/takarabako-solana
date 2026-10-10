import { Router } from "express";
import type { Address } from "viem";
import QRCode from "qrcode";
import { findByPrivyUserId, listDeposits } from "../accounts.js";
import { requireSession } from "../sessions.js";
import { positionSummaries } from "../yieldPositions.js";
import { chainReady, previewValueOnChain, currentApyBpsOnChain } from "../chain.js";
import { asyncHandler } from "../asyncHandler.js";
import { config } from "../config.js";
import { allowanceJson, dailyAllowance } from "../limits.js";
import { ALIASES, LABELS, mbCall } from "../multibaas.js";
import { cashReceiptReady, fromTkUnits, kioskState, tkSupply } from "../cashReceipt.js";
import { issueDepositCode } from "../depositCode.js";

/// Read endpoints for the web app (full sessions only): the account at a
/// glance, deposit history, and the quick-deposit QR to show at the kiosk.
export const meRouter = Router();

meRouter.get("/me", requireSession("full"), asyncHandler(async (_req, res) => {
  const userId: string = res.locals.session.privyUserId;
  const account = await findByPrivyUserId(userId);
  if (!account) {
    res.status(404).json({ error: "unknown account" });
    return;
  }
  const [balance, apyBps] = chainReady
    ? await Promise.all([previewValueOnChain(account.boundAddress as Address), currentApyBpsOnChain()])
    : [0, 0];
  res.json({
    userId,
    ensName: account.ensName,
    privyWallet: account.privyWallet,
    balance,
    apyBps,
    positions: await positionSummaries(userId).catch(() => []),
    limit: allowanceJson(await dailyAllowance(account)),
    expiresAt: res.locals.session.expiresAt,
  });
}));

meRouter.get("/deposits", requireSession("full"), asyncHandler(async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit ?? 20) || 20, 1), 100);
  res.json({ deposits: await listDeposits(res.locals.session.privyUserId, limit) });
}));

/// GET /me/qr — a fresh deposit QR (depositCode.ts): valid for 5 minutes,
/// and it replaces the account's previous one. Every call issues a new code.
meRouter.get("/me/qr", requireSession("full"), asyncHandler(async (_req, res) => {
  const account = await findByPrivyUserId(res.locals.session.privyUserId);
  if (!account) {
    res.status(404).json({ error: "unknown account" });
    return;
  }
  const { qr, expiresAt, ttlSeconds } = await issueDepositCode(account.privyUserId);
  res.set("cache-control", "no-store");
  res.json({
    wallet: account.privyWallet,
    qr,
    expiresAt,
    ttlSeconds,
    dataUrl: await QRCode.toDataURL(qr, { width: 480, margin: 2 }),
  });
}));

/// GET /me/cash-receipts — the customer's tkCASH: their balance (a claim on
/// banknotes in the kiosk's box) and the proof that it's backed.
meRouter.get("/me/cash-receipts", requireSession("full"), asyncHandler(async (_req, res) => {
  const account = await findByPrivyUserId(res.locals.session.privyUserId);
  if (!account) {
    res.status(404).json({ error: "unknown account" });
    return;
  }
  if (!cashReceiptReady) {
    res.json({ configured: false });
    return;
  }
  const [balance, kiosk, supply] = await Promise.all([
    mbCall<string>(ALIASES.tkcash, LABELS.cashReceipt, "balanceOf", [account.privyWallet]),
    kioskState(),
    tkSupply(),
  ]);
  res.json({
    configured: true,
    contract: config.cashReceiptAddress,
    wallet: account.privyWallet,
    balance: fromTkUnits(balance),
    kiosk: { kioskId: kiosk.kioskId, reserve: kiosk.reserve, active: kiosk.active, frozen: kiosk.frozen, lastAuditAt: kiosk.lastAuditAt },
    supply: supply.supply,
    reserve: supply.reserve,
    backed: Math.abs(supply.supply - supply.reserve) < 1e-6,
  });
}));
