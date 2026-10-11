// Shapes returned by the Express backend (backend/src/routes/*). Shared by
// server components, route handlers and client components.

export type RiskTier = "low" | "medium" | "high";

export interface Position {
  positionId: string;
  ensName: string;
  riskTier: RiskTier; // for the 3D box's gems (advanced counts as high)
  mode: RiskTier | "advanced";
  shape: Shape;
  pair: string;
  label: string;
  amount: number; // live value, USD
  apyBps: number; // estimate
  inRange: boolean | null;
  priceMin: number | null;
  priceMax: number | null;
}

export type Shape = "full" | "spot" | "curve" | "bidask";

/// GET /me
export interface Me {
  userId: string;
  ensName: string;
  privyWallet: string;
  balance: number;
  apyBps: number;
  positions: Position[];
  limit?: DailyLimit;
  expiresAt: string;
}

/// What an account may still move today.
export interface DailyLimit {
  limited: boolean;
  limitUsd: number;
  usedUsd: number;
  leftUsd: number | null; // null when there's no limit
}

/// GET /deposits
export interface Deposit {
  id: string;
  currency: string;
  amount: number;
  usdAmount: number | null;
  txHash: string | null;
  chain?: "evm" | "sol";
  tkcashTxHash?: string | null; // the tkCASH receipt token minted for this note
  machineName?: string | null; // the kiosk that took it, when its signature checked out against ENS
  machineVerified?: boolean;
  status: "queued" | "sending" | "confirmed" | "failed";
  attempts: number;
  error: string | null;
  createdAt: string;
}

/// GET /me/cash-receipts — the customer's tkCASH and its backing.
export type CashReceipts =
  | { configured: false }
  | {
      configured: true;
      contract: string;
      wallet: string;
      balance: number;
      kiosk: { kioskId: string; reserve: number; active: boolean; frozen: boolean; lastAuditAt: number | null };
      supply: number;
      reserve: number;
      backed: boolean;
    };

/// GET /agent/pools
export interface Pool {
  riskTier: RiskTier;
  label: string;
  description: string;
  pair: string;
  apyBps: number; // estimate
  feeBps: number;
  fullRange: boolean;
  rangePct: number | null;
  priceLowUsd: number | null;
  priceHighUsd: number | null;
}

/// GET /yield/market
export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

export interface Market {
  spot: number;
  candles: Candle[];
  tiers: Pool[];
  advanced: { minPrice: number; maxPrice: number; feeBps: number; apyEstBps: number; bins: number };
}

/// POST /yield/preview
export interface PreviewBin {
  min: number | null;
  max: number | null;
  weight: number;
  usd: number;
  eth: number;
  usdc: number;
}

export interface Preview {
  spot: number;
  side: "usdc" | "eth" | "both";
  bins: PreviewBin[];
}

/// GET /yield/positions (one entry)
export interface PositionView {
  id: string;
  mode: RiskTier | "advanced";
  shape: Shape;
  label: string;
  priceMin: number | null;
  priceMax: number | null;
  spotOpen: number;
  amountUsd: number;
  apyEstBps: number;
  rationale: string | null;
  status: "open" | "closed";
  valueUsd: number | null;
  pnlUsd: number | null;
  inRange: boolean | null;
  spot: number;
  eth: number;
  usdc: number;
  bins: Array<{ min: number | null; max: number | null; weight: number; eth: number; usdc: number; valueUsd: number }>;
  createdAt: string;
  closedAt: string | null;
  closeValue: number | null;
}

/// POST /agent/open-position
export interface OpenedPosition {
  positionId: string;
  ensName: string;
  pair: string;
  apyBps: number;
  nftTokenId: string | null;
  txHash: string | null;
  rationale: string | null;
}

/// POST /withdraw
export interface WithdrawResult {
  positionsClosed: number;
  vaultTxHash: string;
  grossUsdc: number;
  feeBps: number;
  netUsdc: number;
  destination: "cash" | "wallet";
  receipt: string;
  tkcashBurned?: number;
  tkcashTxHash?: string | null;
}

/// Live events from GET /events/stream (backend/src/events.ts).
export type LiveEvent =
  | { type: "deposit.pending"; depositId: string; amount: number; currency: string; estUsd: number | null; ts: number }
  | { type: "deposit.retrying"; depositId: string; attempt: number; maxAttempts: number; error: string; ts: number }
  | {
      type: "deposit.confirmed";
      depositId: string;
      amount: number;
      currency: string;
      usdAmount: number;
      fxRate: number;
      txHash: string;
      balance: number;
      chain?: "evm" | "sol";
      ts: number;
    }
  | { type: "deposit.failed"; depositId: string; amount: number; currency: string; error: string; ts: number }
  | { type: "deposit.refused"; reason: "unsupported" | "bad_condition"; sessionId: string | null; ts: number }
  | { type: "tkcash.minted"; depositId: string; amount: number; txHash: string; ts: number }
  | { type: "solana.position.opened"; positionId: string; tier: string; amountUsd: number; signature: string; ts: number }
  | { type: "solana.position.closed"; positionId: string; valueUsd: number; signature: string; ts: number }
  | { type: "solana.position.failed"; positionId: string; error: string; ts: number }
  | { type: "solana.position.refunded"; positionId: string; amountUsd: number; signature: string; ts: number };

/// A deposit session's receipt (backend history.ts).
export interface ReceiptNote {
  id: string;
  amount: number;
  currency: string;
  usdAmount: number | null;
  txHash: string | null;
  tkcashTxHash?: string | null;
  machineName?: string | null;
  machineVerified?: boolean;
  status: "queued" | "sending" | "confirmed" | "failed";
  chain: "evm" | "sol";
  at: string;
}

export interface Receipt {
  id: string;
  status: "open" | "finished";
  startedAt: string;
  finishedAt: string | null;
  notes: ReceiptNote[];
  totalAmount: number;
  currency: string;
  totalUsdConfirmed: number;
  settled: boolean;
  destination: Destination;
  tier: SolTier | null;
  solPosition: { id: string; status: string; openSig: string | null } | null;
}

export type HistoryItem =
  | ({ kind: "deposit_session"; at: string } & Receipt)
  | {
      kind: "withdrawal";
      at: string;
      id: string;
      destination: "cash" | "wallet";
      grossUsd: number;
      feeBps: number;
      netUsd: number;
      txHash: string | null;
      tkcashBurned?: number;
      tkcashTxHash?: string | null;
    }
  | {
      kind: "yield";
      at: string;
      id: string;
      action: "open" | "close";
      riskTier: string | null;
      pair: string | null;
      apyBps: number | null;
      amountUsd: number | null;
      rationale: string | null;
      ensName: string | null;
      txHash: string | null;
      chain: "evm" | "sol";
    }
  | { kind: "refused"; at: string; id: string; reason: "unsupported" | "bad_condition" | "no_session"; sessionId: string | null }
  | {
      kind: "transfer";
      at: string;
      id: string;
      asset: "balance" | "tkcash" | "position";
      direction: "sent" | "received";
      counterparty: string | null;
      amountUsd: number | null;
      positionId: string | null;
      txHash: string | null;
    };

/// GET /ens/resolve
export interface ResolvedName {
  name: string;
  address: string;
  kind: string | null;
  customer: { ensName: string | null } | null;
  tkcashAllowlisted: boolean | null;
}

/// GET /me/wallet
export interface MyWallet {
  ensName: string | null;
  wallet: string;
  eth: number;
  tkcash: { balance: number; allowlisted: boolean; dailyLimit: number | null; spentToday: number } | null;
  chainId: number;
  limit?: DailyLimit;
}

/// What a kiosk login hands the browser. The backend session token stays in
/// the httpOnly cookie; the browser only gets what it displays.
export interface KioskLogin {
  ensName: string;
  balance: number;
  scope: "full" | "deposit";
  expiresAt: string;
  qrFallback: string | null;
  qrEmailed: boolean;
  bridge: "ok" | "skipped" | "failed";
  depositSessionId: string | null;
  limit: DailyLimit | null; // what's left today
  depositBlocked: string | null; // why a deposit couldn't start (e.g. today's limit is used)
}

export type Destination = "evm" | "sol_hold" | "sol_earn";
export type SolTier = "low" | "medium" | "high";

/// GET /solana/status
export interface SolanaStatus {
  ready: boolean;
  reason: string | null;
  pool: { pair: string; activeId: number; binStep: number; musdIsX: boolean; solPriceUsd: number } | null;
  tiers: Array<{ id: SolTier; label: string; blurb: string; width: number }>;
}

export interface SolanaPosition {
  id: string;
  tier: SolTier;
  label: string;
  status: "funding" | "opening" | "open" | "closing" | "closed" | "failed" | "refunding" | "refunded";
  source: "kiosk" | "web";
  musdIn: number;
  valueUsd: number | null;
  feesUsd: number | null;
  inRange: boolean | null;
  minBinId: number | null;
  maxBinId: number | null;
  openSig: string | null;
  payoutSig: string | null;
  refundSig: string | null;
  valueOut: number | null;
  error: string | null;
  createdAt: string;
}

/// GET /solana/me
export interface SolanaMe {
  ready: boolean;
  wallet: string | null;
  musd: number | null;
  positions: SolanaPosition[];
}

/// POST /solana/earn/prepare → the transfer to approve.
export interface WebEarnPrepared {
  id: string;
  tx: string; // base64, unsigned
}

/// POST /solana/earn/submit
export interface WebEarnSubmitted {
  id: string;
  status: "opening" | "funding";
}
