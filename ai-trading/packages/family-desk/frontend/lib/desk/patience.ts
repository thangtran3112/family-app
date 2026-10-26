import { DeskApiError } from "../api/client.ts";

// A slow day-open or re-scan outlives the gateway's patience (Cloudflare answers 524 after about 100 seconds) while the
// server keeps working and finishes (D-058, D-059). These calls are safe to repeat, so a gateway answer is not a failure:
// the screen says it is still working and asks again, and the second answer is the finished day or scan.

/** Statuses a gateway sends when it gives up waiting, not when the Desk refuses a request. */
const GATEWAY_STATUSES: ReadonlySet<number> = new Set([502, 503, 504, 522, 524]);

/** True when the gateway (or a dropped connection) cut the call short; the server may still be finishing it. */
export function gatewayGaveUp(error: unknown): boolean {
  if (error instanceof DeskApiError) return error.kind === "http" && error.status !== undefined && GATEWAY_STATUSES.has(error.status);
  return error instanceof TypeError; // fetch rejected: the connection dropped before any answer
}

export type Patience = {
  /** Calls in all, the first included. */
  attempts?: number;
  /** Pause before each repeat. */
  gapMs?: number;
  /** Runs before each repeat, so the screen can say it is still working. */
  onWaiting?: () => void;
  sleep?: (ms: number) => Promise<void>;
};

export const PATIENCE_ATTEMPTS = 6;
export const PATIENCE_GAP_MS = 3000;
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Runs `call`; when a gateway cuts it short, waits and runs it again, up to `attempts` calls. Any other error is thrown at once. */
export async function whenReady<T>(call: () => Promise<T>, patience: Patience = {}): Promise<T> {
  const attempts = patience.attempts ?? PATIENCE_ATTEMPTS;
  const sleep = patience.sleep ?? pause;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await call();
    } catch (error) {
      if (!gatewayGaveUp(error) || attempt >= attempts) throw error;
      patience.onWaiting?.();
      await sleep(patience.gapMs ?? PATIENCE_GAP_MS);
    }
  }
}

/**
 * Saves a new plan and opens its first day. The save is not safe to send twice (each one replaces the plan), so when a
 * gateway cuts it short this waits until the new plan shows (`planId` changes) and then continues it with a plain open.
 */
export async function savePlanPatiently<T>(
  save: () => Promise<T>,
  continueDay: () => Promise<T>,
  currentPlanId: () => Promise<number | null>,
  before: number | null,
  patience: Patience = {},
): Promise<T> {
  try {
    return await save();
  } catch (error) {
    if (!gatewayGaveUp(error)) throw error;
    const attempts = patience.attempts ?? PATIENCE_ATTEMPTS;
    const sleep = patience.sleep ?? pause;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      patience.onWaiting?.();
      await sleep(patience.gapMs ?? PATIENCE_GAP_MS);
      const now = await currentPlanId().catch(() => null);
      if (now !== null && now !== before) return whenReady(continueDay, patience);
    }
    throw error;
  }
}
