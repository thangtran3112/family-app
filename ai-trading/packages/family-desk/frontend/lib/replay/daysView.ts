import { formatEtDay, formatNumber, formatSignedPct } from "../desk/format.ts";
import { PRACTICE_COPY } from "../desk/freshness.ts";
import type { ReplayDay } from "./schemas.ts";

// The notable-days table (02o decision 3, §a2): spoiler-free by construction. The API never sends a day's change,
// range or close, and the date itself is masked by a render rule until "Show dates" is on.

export const dayKey = (row: Pick<ReplayDay, "symbol" | "day">) => `${row.symbol}:${row.day}`;

/** "Tue 2026-04-07", or "Hidden day" while dates are off. The weekday column stays (the plan keeps it). */
export const dayCell = (row: Pick<ReplayDay, "day">, showDates: boolean): string => (showDates ? formatEtDay(row.day) : PRACTICE_COPY.hiddenDay);

/** "Gap down 6.2%", "Heavy volume", "Earnings"; an unknown tag reads as its words. */
export function tagLabel(tag: string, gapPct: number | null): string {
  switch (tag) {
    case "gap_up": return gapPct == null ? "Gap up" : `Gap up ${formatSignedPct(Math.abs(gapPct), 1).replace("+", "")}`;
    case "gap_down": return gapPct == null ? "Gap down" : `Gap down ${formatSignedPct(Math.abs(gapPct), 1).replace("+", "")}`;
    case "heavy_volume": return "Heavy volume";
    case "earnings": return "Earnings";
    default: return tag.replaceAll("_", " ").replace(/^\w/, (letter) => letter.toUpperCase());
  }
}

export const tagsText = (row: Pick<ReplayDay, "tags" | "gap_pct">): string => row.tags.map((tag) => tagLabel(tag, row.gap_pct)).join(" · ");

/** "#1 · 99.6th pct": rank among her last year of sessions, never a direction. */
export const rankText = (row: Pick<ReplayDay, "rank" | "rv_pct_rank">): string => `#${row.rank} · ${formatNumber(row.rv_pct_rank, 1)}th pct`;

export const attemptsText = (attempts: number): string => (attempts === 0 ? "—" : String(attempts));

/** Rows for the symbol that is picked in the setup first, then the rest, each symbol's days by rank. */
export function orderDays(days: readonly ReplayDay[], symbol: string): ReplayDay[] {
  const wanted = symbol.trim().toUpperCase();
  return [...days].sort((a, b) => Number(b.symbol === wanted) - Number(a.symbol === wanted) || a.symbol.localeCompare(b.symbol) || a.rank - b.rank);
}
