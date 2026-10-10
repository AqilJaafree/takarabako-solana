import { NextResponse } from "next/server";
import { backendFetch } from "@/lib/backend";
import type { SolanaStatus } from "@/lib/types";

/// GET /api/kiosk/solana — can the kiosk offer Solana right now (public).
export async function GET() {
  const status = await backendFetch<SolanaStatus>("/solana/status").catch(
    (): SolanaStatus => ({ ready: false, reason: "backend unreachable", pool: null, tiers: [] }),
  );
  return NextResponse.json(status);
}
