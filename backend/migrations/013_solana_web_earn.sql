-- Earn from held mUSD in the web app (spec 2026-10-11). Idempotent: runs at every startup.
-- A web position starts in 'funding' (waiting for the customer's approved
-- mUSD transfer to the treasury) and has no deposit session.
alter table solana_positions add column if not exists source text not null default 'kiosk';
alter table solana_positions add column if not exists funding_sig text;
alter table solana_positions add column if not exists funding_valid_height bigint;
alter table solana_positions add column if not exists funding_message_hash text;
alter table solana_positions add column if not exists funding_confirmed_at timestamptz;
do $$ begin
  alter table solana_positions add constraint solana_positions_source_check check (source in ('kiosk', 'web'));
exception when duplicate_object then null; end $$;
alter table solana_positions drop constraint if exists solana_positions_status_check;
alter table solana_positions add constraint solana_positions_status_check
  check (status in ('funding', 'opening', 'open', 'closing', 'closed', 'failed'));
