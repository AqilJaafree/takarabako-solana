import type { NextRequest } from "next/server";
import { relay } from "@/lib/backend";

/// POST /api/solana/positions/:id/close
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return relay("web", `/solana/positions/${encodeURIComponent(id)}/close`, { body: {} });
}
