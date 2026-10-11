/// Shapes of the backend's /dashboard/* and /ops/* responses (backend/src/routes/dashboard.ts, ops.ts).

export type Panel<T> = { data: T | null; error: string | null };

export interface VaultState {
  apyBps: number;
  totalShares: number;
  liabilityUsd: number;
  vaultUsdcBalance: number;
  reserveCoverage: number | null;
}

export interface KioskState {
  kioskId: string;
  active: boolean;
  frozen: boolean;
  reserve: number;
  lastAuditAt: number | null;
}

export interface Attestation {
  kioskId: string;
  counted: number;
  onChain: number;
  delta: number;
  at: string | null;
}

export type ReserveStatus =
  | { configured: false }
  | { configured: true; supply: number; reserve: number; paused: boolean; backed: boolean; kiosks: KioskState[]; attestations: Attestation[] };

export interface TreasuryBalances {
  address: string | null;
  eth: number;
  musdc: number | null;
}

export type Severity = "critical" | "serious" | "warning" | "info";
export interface ActionItem {
  severity: Severity;
  title: string;
  detail: string;
}

export interface Alert {
  id: string;
  rule: string;
  severity: "info" | "warn" | "critical";
  message: string;
  createdAt: string;
}

export interface Proposal {
  id: string;
  action: "fund_yield_reserve" | "set_apy" | "pause_kiosk" | "mint_usdc_float";
  args: Record<string, unknown>;
  rationale: string;
  source: "ask" | "monitor";
  status: "pending" | "approved" | "rejected" | "executed" | "failed";
  txHash: string | null;
  error: string | null;
  autonomous?: boolean;
  createdAt: string;
}

export interface Summary {
  multibaas: boolean;
  cashReceipt: boolean;
  kioskId: string;
  retiredKiosks?: string[];
  feeBps: number;
  vault: Panel<VaultState>;
  reserve: Panel<ReserveStatus>;
  treasury: Panel<TreasuryBalances>;
  actionItems: ActionItem[];
  alerts: Alert[];
  proposals: Proposal[];
}

export interface Holders {
  tkcash: Panel<{
    total: number;
    count: number;
    top1Share: number;
    top3Share: number;
    holders: Array<{ address: string; balance: number; name: string | null }>;
  }>;
  vault: Panel<{ count: number; depositors: Array<{ address: string; deposited: number; name: string | null }> }>;
}

export interface Flows {
  days: number;
  daily: Array<{ day: string; cashIn: number; cashOut: number }>;
  withdrawals: { gross: number; fees: number; count: number };
  denominations: Panel<Array<{ denomination: number; total: number }>>;
}

export interface Positions {
  spot: number | null;
  aqua: string;
  router: string;
  tiers: Array<{
    mode: string;
    label: string;
    range: string;
    apyBps: number;
    open: number;
    strategies: number;
    amountUsd: number;
    valueUsd: number;
    inRange: number;
  }>;
}

export interface ChainEvent {
  id?: string;
  name: string;
  contractLabel: string | null;
  inputs: Record<string, string>;
  txHash: string | null;
  triggeredAt: string;
}

export interface SolanaOps {
  ready: boolean;
  treasury?: string;
  treasurySol?: number;
  lowSol?: boolean;
  musdSupply?: number;
  pool?: { pair: string; activeId: number; binStep: number; solPriceUsd: number };
  /** Real SOL/USD from Solami (mainnet); null without SOLAMI_API_KEY. */
  market?: { solUsd: number; at: number; source: "solami"; driftPct: number } | null;
  positions?: { open: number; opening: number; closing: number; tvlUsd: number };
}

export interface OpsData {
  solana: SolanaOps | { error: string };
  summary: Summary | { error: string };
  holders: Holders | { error: string };
  flows: Flows | { error: string };
  positions: Positions | { error: string };
  events: { source: string; events: ChainEvent[] } | { error: string };
  integrity: { kiosks: IntegrityReport[] } | { error: string };
  mandate: MandateStatus | { error: string };
  reports: { reports: AgentReportSummary[] } | { error: string };
  loadedAt: string;
}

/// Cash integrity (backend integrity.ts).
export interface IntegrityFinding {
  code: string;
  severity: "critical" | "warn" | "info";
  title: string;
  detail: string;
}

export interface IntegrityReport {
  kioskId: string;
  windowDays: number;
  status: "clear" | "warn" | "critical";
  machine: { notes: number; usd: number; unsigned: number };
  chain: { mints: number; usd: number; reserve: number | null; frozen: boolean };
  lastCount: { counted: number; onChain: number; delta: number; at: string | null } | null;
  notesSinceCount: number;
  findings: IntegrityFinding[];
  checkedAt: string;
}

/// The agent's mandate (backend mandate.ts).
export interface MandateStatus {
  enabled: boolean;
  rules: Array<{ action: Proposal["action"]; label: string; autonomous: boolean; dailyLimit: number | null; why: string; usedToday: number }>;
}

/// Daily reports (backend report.ts).
export interface AgentReportSummary {
  id: string;
  body: string;
  hash: string;
  anchorTx: string | null;
  model: string | null;
  status: "clear" | "warn" | "critical";
  createdAt: string;
}

export interface TraceStep {
  tool: string;
  input: unknown;
  output: unknown;
  error?: boolean;
}

export interface AgentRun {
  answer: string;
  trace: TraceStep[];
  proposalIds: string[];
  model: string;
}
