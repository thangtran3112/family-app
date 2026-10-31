import type { ScreenerFilter, ScreenerPreview, ScreenerResults, ScreenerUniverse } from "../api/schemas.ts";
import { formatEtDay, formatEtTimeZone, formatMetric, type MetricFormat } from "./format.ts";
import { withPriorities, type PrioritizedColumn } from "./columns.ts";

// View logic for the screener (D5): groups, columns from `table_columns`, the universe line.

export function groupFilters(filters: readonly ScreenerFilter[]): { defaults: ScreenerFilter[]; mine: ScreenerFilter[] } {
  return { defaults: filters.filter((filter) => filter.read_only), mine: filters.filter((filter) => !filter.read_only) };
}

export const filterIdFromParam = (value: string | null): number | null => {
  const id = Number(value);
  return value !== null && Number.isInteger(id) && id > 0 ? id : null;
};

/** The filter named in `?filter=`, else the first one (the screener always shows a filter). */
export function pickFilter(filters: readonly ScreenerFilter[], requested: number | null): ScreenerFilter | null {
  return filters.find((filter) => filter.id === requested) ?? filters[0] ?? null;
}

/** An old link or a deleted filter falls back to the first one: say so, so its matches are not read as hers. */
export function missingFilterNote(filters: readonly ScreenerFilter[], requested: number | null): string | null {
  const shown = pickFilter(filters, requested);
  return requested === null || shown === null || shown.id === requested ? null : `That filter was deleted or isn't available · showing ${shown.name}`;
}

type Match = ScreenerResults["matches"][number];
export type ResultColumn = PrioritizedColumn & { key: string; label: string; format: MetricFormat; align: "left" | "right" };

/** Columns the API chose for this filter (`table_columns`, 02m §a3.4), plus the priorities for the 1180 band. */
export function resultColumns(tableColumns: ScreenerResults["table_columns"]): ResultColumn[] {
  const columns = tableColumns.map((column): ResultColumn => ({
    key: column.key,
    label: column.label,
    format: column.format,
    align: column.format === "time" ? "left" : "right",
  }));
  return withPriorities(columns, "screener");
}

export function cellValue(match: Match, key: string): number | string | null {
  if (key === "matched_since") return match.matched_since;
  if (key === "rank_value") return match.rank_value;
  const column = (match.columns as Record<string, number | null | undefined>)[key];
  return column ?? match.operands[key] ?? null;
}

export const cellText = (match: Match, column: Pick<ResultColumn, "key" | "format">): string => formatMetric(column.format, cellValue(match, column.key));

const atEt = (iso: string) => `${formatEtTimeZone(iso)} ${formatEtDay(iso)}`;
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** "Scanned 131 symbols at 3:45 PM ET Fri 2026-10-23": the count and time of the run whose matches are on screen,
 * so the match count can never exceed it (V-SCR-02). The universe endpoint describes today's list, not this run. */
export function scanLine(run: Pick<ScreenerResults, "scanned" | "no_data_on_eval_day" | "evaluation_point">): string {
  const line = `Scanned ${plural(run.scanned, "symbol")} at ${atEt(run.evaluation_point)}`;
  return run.no_data_on_eval_day > 0 ? `${line} · ${run.no_data_on_eval_day} had no bars that day` : line;
}

/** The Details disclosure: how the universe was built, in plain words. */
export function universeDetails(universe: ScreenerUniverse): string[] {
  const floor = universe.liquidity_floor;
  const lines = [`Scan basis: ${universe.scan_basis}`, `Universe now: ${universe.candidates} candidates, ${universe.scanned} pass the liquidity floor`];
  if (universe.dropped_non_plain_tickers > 0) lines.push(`${universe.dropped_non_plain_tickers} dropped (not plain tickers)`);
  if (universe.no_daily_data > 0) lines.push(`${universe.no_daily_data} skipped (no daily data)`);
  if (floor.minPrice != null || floor.minAvgVolume != null) {
    lines.push(`Liquidity floor: price above $${floor.minPrice ?? 0}, average volume above ${(floor.minAvgVolume ?? 0).toLocaleString("en-US")}${floor.avgVolumeDays ? ` over ${floor.avgVolumeDays} days` : ""}`);
  }
  return lines;
}

/** "Showing the top 8 of 9 matches": the table holds only the rows the run stored, and quick filters narrow those. */
export function matchCaption(run: Pick<ScreenerResults, "matches_total" | "matches_returned">, shown: number, quick: boolean): string {
  if (quick) return `${shown} of ${plural(run.matches_returned, "row")} pass your quick filters · ${run.matches_total} matched the scan`;
  if (run.matches_returned < run.matches_total) return `Showing the top ${run.matches_returned} of ${run.matches_total} matches`;
  return run.matches_total === 1 ? "1 match" : `${run.matches_total} matches`;
}

/** The editor's live check runs now on the stored bars, the screener shows the last scheduled run: name both (V-SCR-03). */
export function previewNotes(
  preview: Pick<ScreenerPreview, "scanned">,
  lastRun: Pick<NonNullable<ScreenerFilter["last_run"]>, "evaluation_point" | "matches_total" | "scanned"> | null,
): string[] {
  const notes = [`matches of ${plural(preview.scanned, "symbol")}, checked now on stored bars`];
  if (lastRun) {
    notes.push(`Last scan: ${lastRun.matches_total} of ${lastRun.scanned} at ${atEt(lastRun.evaluation_point)}`);
    if (lastRun.scanned !== preview.scanned) notes.push("The preview and the last scan checked different symbols, so their counts differ.");
  }
  return notes;
}

// Quick filters (A-SCR-02): the standard retail-screener bands (Finviz/TradingView style) over the metric columns every
// match carries. They narrow the stored rows in place; they do not re-run the scan.
// ponytail: market cap, float, short float, sector, earnings date and premarket change/volume are not in the scan
// data, so they have no band here; add them when the data layer supplies those columns.
type Band = { id: string; label: string; min?: number; max?: number };
export type QuickKey = "price" | "change" | "gap" | "avgVolume" | "rvol" | "rsi" | "high52";
export type QuickPicks = Partial<Record<QuickKey, string>>;
export type QuickFilter = { key: QuickKey; label: string; column: keyof Match["columns"]; bands: readonly Band[] };

export const QUICK_FILTERS: readonly QuickFilter[] = [
  { key: "price", label: "Price", column: "last", bands: [
    { id: "under5", label: "$5 and under", max: 5 },
    { id: "2-20", label: "$2 to $20", min: 2, max: 20 },
    { id: "5-50", label: "$5 to $50", min: 5, max: 50 },
    { id: "over20", label: "$20 and over", min: 20 },
    { id: "over50", label: "$50 and over", min: 50 },
  ] },
  { key: "change", label: "Change %", column: "change_pct", bands: [
    { id: "up2", label: "Up 2% or more", min: 2 },
    { id: "up5", label: "Up 5% or more", min: 5 },
    { id: "up10", label: "Up 10% or more", min: 10 },
    { id: "up20", label: "Up 20% or more", min: 20 },
    { id: "down2", label: "Down 2% or more", max: -2 },
    { id: "down5", label: "Down 5% or more", max: -5 },
    { id: "down10", label: "Down 10% or more", max: -10 },
  ] },
  { key: "gap", label: "Gap %", column: "gap_pct_open", bands: [
    { id: "up2", label: "Up 2% or more", min: 2 },
    { id: "up4", label: "Up 4% or more", min: 4 },
    { id: "up10", label: "Up 10% or more", min: 10 },
    { id: "down2", label: "Down 2% or more", max: -2 },
    { id: "down4", label: "Down 4% or more", max: -4 },
  ] },
  { key: "avgVolume", label: "Avg volume", column: "avg_volume_20d", bands: [
    { id: "500k", label: "500K or more", min: 500_000 },
    { id: "1m", label: "1M or more", min: 1_000_000 },
    { id: "2m", label: "2M or more", min: 2_000_000 },
    { id: "10m", label: "10M or more", min: 10_000_000 },
  ] },
  { key: "rvol", label: "Rel volume", column: "rvol_10d", bands: [
    { id: "1.5x", label: "1.5x or more", min: 1.5 },
    { id: "2x", label: "2x or more", min: 2 },
    { id: "3x", label: "3x or more", min: 3 },
    { id: "5x", label: "5x or more", min: 5 },
  ] },
  { key: "rsi", label: "RSI (14)", column: "rsi_14", bands: [
    { id: "oversold", label: "Oversold (≤ 30)", max: 30 },
    { id: "overbought", label: "Overbought (70+)", min: 70 },
    { id: "40-60", label: "Neutral (40–60)", min: 40, max: 60 },
  ] },
  { key: "high52", label: "52-week high", column: "dist_to_252d_high_pct", bands: [
    { id: "within5", label: "Within 5% of high", min: -5 },
    { id: "within10", label: "Within 10% of high", min: -10 },
    { id: "below20", label: "20% or more below", max: -20 },
    { id: "below50", label: "50% or more below", max: -50 },
  ] },
];

export const quickFiltersActive = (picks: QuickPicks): boolean => Object.values(picks).some(Boolean);

/** The rows inside every picked band (bounds inclusive). A row without the metric cannot pass an active band. */
export function applyQuickFilters<Row extends Pick<Match, "columns">>(rows: readonly Row[], picks: QuickPicks): Row[] {
  const active = QUICK_FILTERS.flatMap((quick) => {
    const band = quick.bands.find((item) => item.id === picks[quick.key]);
    return band ? [{ column: quick.column, band }] : [];
  });
  return rows.filter((row) =>
    active.every(({ column, band }) => {
      const value = row.columns[column];
      return typeof value === "number" && (band.min === undefined || value >= band.min) && (band.max === undefined || value <= band.max);
    }),
  );
}

/** Bars the preview chart loads for a selected row. */
export const previewInterval = (runOn: string): "15m" | "1d" => (runOn === "daily_close" || runOn === "weekly" || runOn === "premarket_0830" ? "1d" : "15m");

export type ResultsState = "scanning" | "error" | "empty" | "ready";
export function resultsState(input: { loading: boolean; hasResults: boolean; failed: boolean; matches: number }): ResultsState {
  if (input.hasResults) return input.matches === 0 ? "empty" : "ready";
  return input.failed ? "error" : "scanning";
}

/** Delayed scans say so (02l D5): the scan stamp is delayed while the market is open. */
export const scanIsDelayed = (stamp: { freshness: string }): boolean => stamp.freshness === "delayed";

/** A filter that no scan has run yet: the API answers 200 with no matches and a stamp without an as-of time. */
export const neverScanned = (stamp: { as_of: string | null; freshness: string }): boolean => stamp.as_of === null && stamp.freshness === "unavailable";

/** The new-filter form starts from the first default's rule, under a name of its own. */
export const NEW_FILTER_SPEC = {
  schemaVersion: 1,
  name: "New filter",
  watch: { universe: { market: "us_equities" }, session: "regular", runOn: "daily_close" },
  liquidity: { minPrice: 5, minAvgVolume: 500000 },
  when: { op: "gte", left: { series: "rvol", lookbackDays: 10 }, right: { value: 2 } },
  rank: { by: { series: "rvol", lookbackDays: 10 }, order: "desc" },
  maxResults: 50,
} as const;
