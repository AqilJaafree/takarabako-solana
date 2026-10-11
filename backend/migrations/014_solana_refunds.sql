-- Automatic refund of web Earn opens that can never succeed. Idempotent: runs at every startup.
-- 'refunding': the treasury is sending the customer's mUSD back; 'refunded': it landed.
alter table solana_positions add column if not exists recoveries int not null default 0;
alter table solana_positions add column if not exists refund_sig text;
alter table solana_positions add column if not exists refund_valid_height bigint;
alter table solana_positions add column if not exists refunded_at timestamptz;
alter table solana_positions drop constraint if exists solana_positions_status_check;
alter table solana_positions add constraint solana_positions_status_check
  check (status in ('funding', 'opening', 'open', 'closing', 'closed', 'failed', 'refunding', 'refunded'));
