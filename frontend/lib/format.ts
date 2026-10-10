export function usd(n: number | null | undefined, digits = 2): string {
  if (n == null || Number.isNaN(n)) return "—";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export function cash(amount: number, currency: string): string {
  return currency === "MYR" ? `RM${amount}` : `$${amount}`;
}

export function apy(bps: number): string {
  return `${(bps / 100).toFixed(1)}%`;
}

export function shortHex(hex: string, head = 6, tail = 4): string {
  return hex.length <= head + tail + 1 ? hex : `${hex.slice(0, head)}…${hex.slice(-tail)}`;
}

export const shortAddr = (a: string) => (a.length <= 9 ? a : `${a.slice(0, 4)}…${a.slice(-4)}`);

export const SEPOLIA_TX = (hash: string) => `https://sepolia.etherscan.io/tx/${hash}`;
export const SOLSCAN_TX = (sig: string) => `https://solscan.io/tx/${sig}?cluster=devnet`;
export const SOLSCAN_ACCOUNT = (addr: string) => `https://solscan.io/account/${addr}?cluster=devnet`;
/// The right explorer for a stored transaction reference.
export const TX_URL = (hash: string, chain: "evm" | "sol" = "evm") => (chain === "sol" ? SOLSCAN_TX(hash) : SEPOLIA_TX(hash));

export function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

/// Copy of `record` without `key`.
export function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
}
