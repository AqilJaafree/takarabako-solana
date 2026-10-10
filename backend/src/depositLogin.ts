import type { Address } from "viem";
import type { Account } from "./accounts.js";
import { createSession } from "./sessions.js";
import { chainReady, previewValueOnChain } from "./chain.js";
import { allowanceJson, dailyAllowance } from "./limits.js";

/// A deposit-only session at the cash terminal, and what the terminal shows.
/// Used by the wallet-QR login.
export async function depositLogin(account: Account) {
  const session = await createSession(account.privyUserId, "deposit");
  const balance = chainReady ? await previewValueOnChain(account.boundAddress as Address) : 0;
  return {
    userId: account.privyUserId,
    ensName: account.ensName,
    balance,
    token: session.token,
    scope: session.scope,
    expiresAt: session.expiresAt,
    limit: allowanceJson(await dailyAllowance(account)), // the deposit terminal shows what's left today
  };
}
