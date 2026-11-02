import { calcVWAPWithGaps } from "../indicators-with-gaps.ts";
import type { ReplayBar } from "./schemas.ts";
import { ms } from "./time.ts";

// VWAP is a session figure, not a chart-interval figure (D-168, owner ruling 2026-11-02). The Practice VWAP is computed from the finest bars the
// API serves for the name (one-minute) whatever interval the chart shows, then read onto the chart's bars. The header, the left rail and the
// chart line all read the one array this builds, so they agree on 1m, 5m and 15m. The math is `calcVWAP` (lib/indicators.ts), the one
// session VWAP that also takes the asset type (D-154); this file only decides which bars it runs on.

/** The one-minute bars behind a 5m or 15m chart. `loading` until the first answer, `unavailable` when none came. */
export type MinuteBars = { bars: readonly ReplayBar[]; status: "ready" | "loading" | "unavailable" };

/** `values` has one entry per chart bar; null when there are no one-minute bars to read (`status` says why). */
export type SessionVwap = { values: Array<number | null> | null; status: MinuteBars["status"] };

const STEP_MS: Readonly<Record<string, number>> = { "5m": 5 * 60_000, "15m": 15 * 60_000 };

/**
 * The session VWAP at each of `chartBars`. On a one-minute chart the bars are the minute bars. On a coarser chart a bar reads the VWAP as of the
 * last minute inside it, and a bar newer than the last minute bar we hold (the next answer is on its way) keeps the last value, so the newest
 * point never drops to "—" for a moment. A bar with no regular-session minute (pre- or after-hours) reads unknown, as everywhere.
 */
export function sessionVwap(chartBars: readonly ReplayBar[], interval: string, minutes: MinuteBars): SessionVwap {
  const step = STEP_MS[interval];
  if (step === undefined) return { values: calcVWAPWithGaps([...chartBars]), status: "ready" };
  if (minutes.status !== "ready") return { values: null, status: minutes.status };
  const perMinute = calcVWAPWithGaps([...minutes.bars]);
  let next = 0;
  const values = chartBars.map((bar) => {
    const start = ms(bar.t);
    const end = start + step;
    let last = -1;
    while (next < minutes.bars.length && ms(minutes.bars[next]!.t) < end) {
      if (ms(minutes.bars[next]!.t) >= start) last = next;
      next += 1;
    }
    if (last >= 0) return perMinute[last] ?? null;
    return next >= minutes.bars.length && next > 0 ? (perMinute[next - 1] ?? null) : null;
  });
  return { values, status: "ready" };
}
