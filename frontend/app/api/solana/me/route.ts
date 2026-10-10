import { relay } from "@/lib/backend";

/// GET /api/solana/me
export async function GET() {
  return relay("web", "/solana/me");
}
