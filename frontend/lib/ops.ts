import "server-only";
import { backendFetch } from "./backend";
import type { OpsData } from "./opsTypes";

/// Everything the /ops dashboard shows, in one round of backend calls. A
/// panel whose call fails carries its error rather than failing the page.
export async function loadOpsData(): Promise<OpsData> {
  const get = <T,>(path: string) =>
    backendFetch<T>(path).catch((err: unknown) => ({ error: err instanceof Error ? err.message : "request failed" }));
  const [summary, holders, flows, positions, events, integrity, mandate, reports, solana] = await Promise.all([
    get<OpsData["summary"]>("/dashboard/summary"),
    get<OpsData["holders"]>("/dashboard/holders"),
    get<OpsData["flows"]>("/dashboard/flows"),
    get<OpsData["positions"]>("/dashboard/positions"),
    get<OpsData["events"]>("/dashboard/events"),
    get<OpsData["integrity"]>("/ops/integrity"),
    get<OpsData["mandate"]>("/ops/mandate"),
    get<OpsData["reports"]>("/ops/reports"),
    get<OpsData["solana"]>("/dashboard/solana"),
  ]);
  return { summary, holders, flows, positions, events, integrity, mandate, reports, solana, loadedAt: new Date().toISOString() };
}
