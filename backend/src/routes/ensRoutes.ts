import { Router } from "express";
import { encodeFunctionData, parseAbi, type Address } from "viem";
import { z } from "zod";
import { config } from "../config.js";
import { findByPrivyUserId } from "../accounts.js";
import { requireSession } from "../sessions.js";
import { asyncHandler } from "../asyncHandler.js";
import { publicClient } from "../chain.js";
import { cashReceiptReady, fromTkUnits, toTkUnits } from "../cashReceipt.js";
import { ALIASES, LABELS, mbCall } from "../multibaas.js";
import { positionSubname, tokenIdOf } from "../ens.js";
import { registryAbi } from "../ensV2.js";
import { confirmTkcashSend, ensureGas, holdsDeed, lookup, reconcileDeeds, sendBalance } from "../ensTransfers.js";
import { listPositions } from "../aqua.js";
import { allowanceJson, assertWithinLimit, dailyAllowance, DailyLimitError } from "../limits.js";

/// Sending by ENS name (web app). Customer-signed transfers are prepared here
/// — recipient resolved and checked, gas topped up — and the browser has the
/// customer sign the exact transaction in their own Privy wallet.
export const ensRouter = Router();

const SEPOLIA = 11155111;
const erc20 = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);

/// GET /ens/resolve?name=alice-1234.takarabako.eth — through the official ENS v2 Universal Resolver.
ensRouter.get("/ens/resolve", asyncHandler(async (req, res) => {
  const name = String(req.query.name ?? "");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(name)) {
    res.status(400).json({ error: "enter an ENS name like alice-1234.takarabako.eth" });
    return;
  }
  const r = await lookup(name);
  if (!r) {
    res.status(404).json({ error: `${name} doesn't resolve to an address` });
    return;
  }
  res.json(r);
}));

async function me(res: import("express").Response) {
  const account = await findByPrivyUserId(res.locals.session.privyUserId);
  if (!account) {
    res.status(404).json({ error: "unknown account" });
    return null;
  }
  return account;
}

/// GET /me/wallet — the customer's own wallet: gas, tkCASH and its transfer limits.
ensRouter.get("/me/wallet", requireSession("full"), asyncHandler(async (_req, res) => {
  const account = await me(res);
  if (!account) return;
  const eth = Number(await publicClient.getBalance({ address: account.privyWallet as Address })) / 1e18;
  let tk: { balance: number; allowlisted: boolean; dailyLimit: number | null; spentToday: number } | null = null;
  if (cashReceiptReady) {
    const [bal, allow, limit, spent, day] = await Promise.all([
      mbCall<string>(ALIASES.tkcash, LABELS.cashReceipt, "balanceOf", [account.privyWallet]),
      mbCall<boolean>(ALIASES.tkcash, LABELS.cashReceipt, "allowlist", [account.privyWallet]),
      mbCall<string>(ALIASES.tkcash, LABELS.cashReceipt, "dailyTransferLimit"),
      mbCall<string>(ALIASES.tkcash, LABELS.cashReceipt, "spentToday", [account.privyWallet]),
      mbCall<string>(ALIASES.tkcash, LABELS.cashReceipt, "spentDay", [account.privyWallet]),
    ]);
    const today = Math.floor(Date.now() / 86_400_000);
    tk = {
      balance: fromTkUnits(bal),
      allowlisted: allow,
      dailyLimit: BigInt(limit) === 0n ? null : fromTkUnits(limit),
      spentToday: Number(day) === today ? fromTkUnits(spent) : 0,
    };
  }
  res.json({
    ensName: account.ensName,
    wallet: account.privyWallet,
    eth,
    tkcash: tk,
    chainId: SEPOLIA,
    limit: allowanceJson(await dailyAllowance(account)),
  });
}));

const Balance = z.object({ to: z.string().min(3), amount: z.number().positive() });

/// POST /send/balance — box balance to another customer, by name.
ensRouter.post("/send/balance", requireSession("full"), asyncHandler(async (req, res) => {
  const parsed = Balance.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const account = await me(res);
  if (!account) return;
  try {
    const r = await sendBalance(account, parsed.data.to, parsed.data.amount);
    res.json({ to: r.to, txHash: r.txHash, amount: parsed.data.amount });
  } catch (err) {
    if (err instanceof DailyLimitError) throw err;
    res.status(422).json({ error: err instanceof Error ? err.message : "send failed" });
  }
}));

/// POST /send/tkcash/prepare — a tkCASH transfer for the customer to sign.
ensRouter.post("/send/tkcash/prepare", requireSession("full"), asyncHandler(async (req, res) => {
  const parsed = Balance.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const account = await me(res);
  if (!account) return;
  await assertWithinLimit(account, parsed.data.amount, "this tkCASH send");
  const target = await lookup(parsed.data.to);
  if (!target) {
    res.status(422).json({ error: `${parsed.data.to} doesn't resolve to an address` });
    return;
  }
  if (target.tkcashAllowlisted === false) {
    res.status(422).json({ error: `${target.name} can't hold tkCASH — only identity-verified Takarabako wallets can` });
    return;
  }
  const gas = await ensureGas(account);
  res.json({
    recipient: target,
    gas,
    tx: {
      to: config.cashReceiptAddress,
      data: encodeFunctionData({ abi: erc20, functionName: "transfer", args: [target.address as Address, BigInt(toTkUnits(parsed.data.amount))] }),
      chainId: SEPOLIA,
    },
    from: account.privyWallet,
  });
}));

/// POST /send/tkcash/confirm { txHash, to } — record a signed tkCASH transfer.
ensRouter.post("/send/tkcash/confirm", requireSession("full"), asyncHandler(async (req, res) => {
  const account = await me(res);
  if (!account) return;
  const txHash = String(req.body?.txHash ?? "");
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    res.status(400).json({ error: "txHash required" });
    return;
  }
  try {
    res.json(await confirmTkcashSend(account, txHash, typeof req.body?.to === "string" ? req.body.to : null));
  } catch (err) {
    res.status(422).json({ error: err instanceof Error ? err.message : "couldn't confirm" });
  }
}));

/// POST /yield/positions/:id/give/prepare { to } — transfer a position's deed (its ENS name token).
ensRouter.post("/yield/positions/:id/give/prepare", requireSession("full"), asyncHandler(async (req, res) => {
  const account = await me(res);
  if (!account) return;
  const row = (await listPositions(account.privyUserId, "open")).find((p) => p.id === req.params.id);
  if (!row) {
    res.status(404).json({ error: "no such open position" });
    return;
  }
  if (!(await holdsDeed(account, row.id))) {
    res.status(409).json({ error: "your wallet doesn't hold this position's deed any more" });
    return;
  }
  await assertWithinLimit(account, row.amountUsd, "giving this position");
  const target = await lookup(String(req.body?.to ?? ""));
  if (!target) {
    res.status(422).json({ error: `${req.body?.to} doesn't resolve to an address` });
    return;
  }
  if (target.address.toLowerCase() === account.privyWallet.toLowerCase()) {
    res.status(422).json({ error: "that's your own name" });
    return;
  }
  const name = positionSubname(row.id);
  const tokenId = await tokenIdOf(name);
  if (!tokenId) {
    res.status(409).json({ error: `${name} isn't registered yet` });
    return;
  }
  const gas = await ensureGas(account);
  res.json({
    deed: name,
    recipient: target,
    gas,
    tx: {
      to: config.ens.registryAddress,
      data: encodeFunctionData({
        abi: registryAbi,
        functionName: "safeTransferFrom",
        args: [account.privyWallet as Address, target.address as Address, tokenId, 1n, "0x"],
      }),
      chainId: SEPOLIA,
    },
    from: account.privyWallet,
  });
}));

/// POST /yield/positions/:id/give/confirm { txHash } — after the deed moved on-chain.
ensRouter.post("/yield/positions/:id/give/confirm", requireSession("full"), asyncHandler(async (req, res) => {
  const txHash = String(req.body?.txHash ?? "");
  if (/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    const r = await publicClient.waitForTransactionReceipt({ hash: txHash as `0x${string}`, timeout: 60_000 });
    if (r.status !== "success") {
      res.status(422).json({ error: "the deed transfer reverted on-chain" });
      return;
    }
  }
  const changes = await reconcileDeeds(req.params.id);
  res.json({ changes });
}));
