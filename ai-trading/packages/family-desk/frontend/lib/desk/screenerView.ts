import type { ScreenerFilter, ScreenerResults, ScreenerUniverse } from "../api/schemas.ts";
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

/** "Scanned 131 US stocks and ETFs · as of last close Fri 2026-10-23" (02l D5). */
export function universeLine(universe: Pick<ScreenerUniverse, "scanned" | "stamp">): string {
  const { as_of: asOf, freshness } = universe.stamp;
  const when = !asOf ? "no scan yet" : freshness === "closed" ? `as of last close ${formatEtDay(asOf)}` : `as of ${formatEtTimeZone(asOf)}`;
  return `Scanned ${universe.scanned} US stocks and ETFs · ${when}`;
}

/** The Details disclosure: how the universe was built, in plain words. */
export function universeDetails(universe: ScreenerUniverse): string[] {
  const floor = universe.liquidity_floor;
  const lines = [`Scan basis: ${universe.scan_basis}`, `${universe.candidates} candidates, ${universe.scanned} scanned`];
  if (universe.dropped_non_plain_tickers > 0) lines.push(`${universe.dropped_non_plain_tickers} dropped (not plain tickers)`);
  if (universe.no_daily_data > 0) lines.push(`${universe.no_daily_data} skipped (no daily data)`);
  if (floor.minPrice != null || floor.minAvgVolume != null) {
    lines.push(`Liquidity floor: price above $${floor.minPrice ?? 0}, average volume above ${(floor.minAvgVolume ?? 0).toLocaleString("en-US")}${floor.avgVolumeDays ? ` over ${floor.avgVolumeDays} days` : ""}`);
  }
  return lines;
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
