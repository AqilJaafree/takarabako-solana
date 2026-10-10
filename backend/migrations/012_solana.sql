-- Solana destination (spec 2026-10-10). Idempotent: runs at every startup.
alter table accounts add column if not exists solana_wallet text;
create unique index if not exists accounts_solana_wallet on accounts (solana_wallet) where solana_wallet is not null;

alter table deposit_sessions add column if not exists destination text not null default 'evm';
alter table deposit_sessions add column if not exists tier text;
do $$ begin
  alter table deposit_sessions add constraint deposit_sessions_destination_check
    check (destination in ('evm', 'sol_hold', 'sol_earn')
           and (destination <> 'sol_earn' or tier in ('low', 'medium', 'high')));
exception when duplicate_object then null; end $$;

-- A Solana deposit keeps its signature in tx_hash; sol_valid_height says
-- until when that signed transaction could still land.
alter table deposits add column if not exists chain text not null default 'evm';
alter table deposits add column if not exists sol_valid_height bigint;

-- Earn opens are recorded with chain 'sol' and left out of the daily limit:
-- the notes behind them were already counted as deposits.
alter table yield_events add column if not exists chain text not null default 'evm';

create table if not exists solana_positions (
  id                  uuid primary key,
  privy_user_id       text not null references accounts on delete cascade,
  session_id          uuid unique references deposit_sessions on delete set null,
  tier                text not null check (tier in ('low', 'medium', 'high')),
  pair                text not null,
  status              text not null default 'opening' check (status in ('opening', 'open', 'closing', 'closed', 'failed')),
  musd_in             numeric not null,
  position_pubkey     text,
  min_bin_id          int,
  max_bin_id          int,
  open_sig            text,
  open_valid_height   bigint,
  musd_out_raw        numeric,
  sol_out_raw         numeric,
  removed_at          timestamptz,
  swap_sig            text,
  swap_valid_height   bigint,
  swap_out_raw        numeric,
  swap_confirmed_at   timestamptz,
  payout_sig          text,
  payout_valid_height bigint,
  value_out           numeric,
  error               text,
  created_at          timestamptz not null default now(),
  opened_at           timestamptz,
  closed_at           timestamptz
);
create index if not exists solana_positions_user on solana_positions (privy_user_id, created_at desc);
