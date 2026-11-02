// How long a poll waits after it has failed `failures` times in a row: the base delay doubled per failure, up to a cap. No failure is the base
// delay itself, so a healthy poll keeps its rhythm. A manual Retry never waits on this: it asks at once.

export const BACKOFF_CAP_MS = 60_000;

export function backoffMs(baseMs: number, failures: number, capMs: number = BACKOFF_CAP_MS): number {
  if (failures <= 0) return baseMs;
  return Math.min(capMs, baseMs * 2 ** Math.min(failures, 16));
}
