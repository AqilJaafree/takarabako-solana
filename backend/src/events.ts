import { redis, newRedisConnection } from "./redis.js";

/// Per-user live events. Published on Redis so every backend instance's SSE
/// clients (the kiosk screen, the customer's phone, the Pi bridge) hear them.
export type UserEvent =
  | { type: "deposit.pending"; depositId: string; amount: number; currency: string; estUsd: number | null }
  | { type: "deposit.retrying"; depositId: string; attempt: number; maxAttempts: number; error: string }
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
    }
  | { type: "deposit.failed"; depositId: string; amount: number; currency: string; error: string }
  // A note the acceptor handed back: not a supported note, or in poor condition.
  | { type: "deposit.refused"; reason: "unsupported" | "bad_condition"; sessionId: string | null }
  // The note's tkCASH receipt token was minted to the customer's wallet.
  | { type: "tkcash.minted"; depositId: string; amount: number; txHash: string }
  | { type: "solana.position.opened"; positionId: string; tier: string; amountUsd: number; signature: string }
  | { type: "solana.position.closed"; positionId: string; valueUsd: number; signature: string }
  | { type: "solana.position.failed"; positionId: string; error: string }
  | { type: "solana.position.refunded"; positionId: string; amountUsd: number; signature: string };

const channel = (privyUserId: string) => `user:${privyUserId}`;

export async function publishUserEvent(privyUserId: string, event: UserEvent) {
  await redis.publish(channel(privyUserId), JSON.stringify({ ...event, ts: Date.now() }));
}

/// Calls `onEvent` with each event's JSON on the user's channel until the
/// returned function is called.
export async function subscribeUserEvents(privyUserId: string, onEvent: (json: string) => void) {
  const sub = newRedisConnection();
  await sub.subscribe(channel(privyUserId));
  sub.on("message", (_channel, message) => onEvent(message));
  return async () => {
    await sub.unsubscribe().catch(() => {});
    sub.disconnect();
  };
}
