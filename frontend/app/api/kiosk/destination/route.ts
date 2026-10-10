import { NextResponse, type NextRequest } from "next/server";
import { relay } from "@/lib/backend";

/// POST /api/kiosk/destination { sessionId, destination, tier? }
export async function POST(req: NextRequest) {
  const { sessionId, destination, tier } = (await req.json().catch(() => ({}))) as { sessionId?: string; destination?: string; tier?: string };
  if (!sessionId) return NextResponse.json({ error: "sessionId required" }, { status: 400 });
  return relay("kiosk", `/deposit-sessions/${encodeURIComponent(sessionId)}/destination`, { method: "POST", body: { destination, tier } });
}
