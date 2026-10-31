import { z } from "zod";

// What she chose to see on the replay chart (design-replay-chart §b.4, §b.5): the series type and which lines and levels
// are drawn. One object per browser profile under `desk.replayChart`, the same scope as `desk.lane`. The defaults are the
// chart as it was before there were settings, and a value that is stale, hand-edited or missing a toggle added later
// falls back field by field (`.catch`), so a bad store can never break the chart.

export const CHART_PREFS_KEY = "desk.replayChart";

export const CHART_TYPES = ["candles", "hollow", "bars", "line", "area"] as const;
export type ChartType = (typeof CHART_TYPES)[number];

export const CHART_TYPE_LABELS: Record<ChartType, string> = { candles: "Candles", hollow: "Hollow", bars: "Bars", line: "Line", area: "Area" };

/** Lines drawn from the revealed bars (`volume` is the histogram), then the levels the server cut at the playhead. */
export const OVERLAY_IDS = ["vwap", "ema9", "ema21", "volume"] as const;
export const LEVEL_IDS = ["prior_close", "session", "opening_range"] as const;
export type OverlayId = (typeof OVERLAY_IDS)[number];
export type LevelId = (typeof LEVEL_IDS)[number];
export type PrefId = OverlayId | LevelId;

export type ChartPrefs = { v: 1; type: ChartType; on: Record<PrefId, boolean> };

const on = () => z.boolean().catch(true);
const OnSchema = z.object({
  vwap: on(),
  ema9: on(),
  ema21: on(),
  volume: on(),
  prior_close: on(),
  session: on(),
  opening_range: on(),
});

const ChartPrefsSchema = z.object({
  v: z.literal(1).catch(1),
  type: z.enum(CHART_TYPES).catch("candles"),
  on: OnSchema.catch(() => OnSchema.parse({})),
});

type PrefsStorage = Pick<Storage, "getItem" | "setItem">;

export const defaultChartPrefs = (): ChartPrefs => ChartPrefsSchema.parse({});

export function readChartPrefs(storage: PrefsStorage | null): ChartPrefs {
  try {
    const raw = storage?.getItem(CHART_PREFS_KEY);
    if (!raw) return defaultChartPrefs();
    return ChartPrefsSchema.parse(JSON.parse(raw));
  } catch {
    return defaultChartPrefs();
  }
}

export function writeChartPrefs(storage: PrefsStorage | null, prefs: ChartPrefs): void {
  try {
    storage?.setItem(CHART_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Private mode or a full quota: the setting stays in memory until the page reloads.
  }
}

export const togglePref = (prefs: ChartPrefs, id: PrefId): ChartPrefs => ({ ...prefs, on: { ...prefs.on, [id]: !prefs.on[id] } });

export const setChartType = (prefs: ChartPrefs, type: ChartType): ChartPrefs => ({ ...prefs, type });

/** The overlays the chart draws: those she did not turn off. An id the settings do not know stays. */
export function visibleOverlays<T extends { id: string }>(overlays: readonly T[], prefs: ChartPrefs): T[] {
  return overlays.filter(({ id }) => prefs.on[id as PrefId] !== false);
}
