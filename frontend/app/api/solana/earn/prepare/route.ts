import type { NextRequest } from "next/server";
import { relay } from "@/lib/backend";

/// POST /api/solana/earn/prepare { amount, tier }
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  return relay("web", "/solana/earn/prepare", { body });
}
