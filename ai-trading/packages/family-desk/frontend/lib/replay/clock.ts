import { addMs, ms } from "./time.ts";

// The playback clock (02o §d): the browser asks the server to move the playhead; it never moves it itself.
// While playing it asks once per wall-clock second for `speed` market seconds. The server clamps to the window end.

export const SPEEDS = [1, 2, 5, 10] as const;
export type Speed = (typeof SPEEDS)[number];
export const DEFAULT_SPEED: Speed = 1;
export const TICK_MS = 1000;

export const isSpeed = (value: number): value is Speed => (SPEEDS as readonly number[]).includes(value);

/** Keys 1 to 4 pick the speed chips in order. */
export const speedForDigit = (digit: string): Speed | null => {
  const index = Number(digit) - 1;
  return Number.isInteger(index) && index >= 0 && index < SPEEDS.length ? SPEEDS[index]! : null;
};

/** The `to` of the next play tick: the playhead plus `speed` market seconds, never past the window end. */
export function nextTo(revealedThrough: string, speed: Speed, windowEnd: string): string {
  const target = ms(revealedThrough) + speed * TICK_MS;
  return new Date(Math.min(target, ms(windowEnd))).toISOString();
}

/** Jump forward by whole minutes, clamped to the window end. */
export function jumpMinutes(revealedThrough: string, minutes: number, windowEnd: string): string {
  return new Date(Math.min(ms(addMs(revealedThrough, minutes * 60_000)), ms(windowEnd))).toISOString();
}

export const reachedEnd = (revealedThrough: string, windowEnd: string): boolean => ms(revealedThrough) >= ms(windowEnd);

/** Wall-clock wait before the next play request: a slow answer shortens the pause but never stacks requests. */
export function delayUntilNextTick(startedAt: number, now: number): number {
  return Math.max(0, TICK_MS - (now - startedAt));
}
