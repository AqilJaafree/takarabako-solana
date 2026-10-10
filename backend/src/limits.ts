import { config } from "./config.js";
import { pool } from "./db.js";
import type { Account } from "./accounts.js";

/// Daily limit for every customer: everything they move in a day (UTC) —
/// cash deposited, withdrawals, yield positions opened, and anything sent by
/// name — adds up to at most DAILY_LIMIT_USD ($1,000).

export interface DailyAllowance {
  limited: boolean;
  limitUsd: number;
  usedUsd: number;
  leftUsd: number;
}

export class DailyLimitError extends Error {
  status = 403;
  code = "daily_limit";
}

const startOfUtcDay = () => new Date(Math.floor(Date.now() / 86_400_000) * 86_400_000);

/// USD this customer has moved since midnight UTC.
export async function usedToday(privyUserId: string): Promise<number> {
  const { rows } = await pool.query<{ used: string }>(
    `select
       (select coalesce(sum(usd_amount), 0) from deposits where privy_user_id = $1 and created_at >= $2 and status <> 'failed')
     + (select coalesce(sum(gross_usd), 0) from withdrawals where privy_user_id = $1 and created_at >= $2)
     + (select coalesce(sum(amount_usd), 0) from yield_events where privy_user_id = $1 and action = 'open' and chain = 'evm' and created_at >= $2)
     + (select coalesce(sum(amount_usd), 0) from transfers where from_user = $1 and created_at >= $2) as used`,
    [privyUserId, startOfUtcDay()],
  );
  return Number(rows[0]?.used ?? 0);
}

export async function dailyAllowance(account: Account): Promise<DailyAllowance> {
  const limitUsd = config.dailyLimitUsd;
  const usedUsd = await usedToday(account.privyUserId);
  return { limited: true, limitUsd, usedUsd, leftUsd: Math.max(0, limitUsd - usedUsd) };
}

const usd = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

/// Throws DailyLimitError if moving `amountUsd` would take a customer
/// over today's limit.
export async function assertWithinLimit(account: Account, amountUsd: number, what = "this"): Promise<void> {
  const a = await dailyAllowance(account);
  if (!a.limited || amountUsd <= a.leftUsd + 1e-9) return;
  throw new DailyLimitError(
    `Accounts can move ${usd(a.limitUsd)} a day and you have ${usd(a.leftUsd)} left today, so ${what} (${usd(amountUsd)}) can't go through.`,
  );
}

/// For JSON responses (Infinity doesn't serialise).
export function allowanceJson(a: DailyAllowance) {
  return a.limited ? a : { limited: false, limitUsd: a.limitUsd, usedUsd: 0, leftUsd: null };
}
