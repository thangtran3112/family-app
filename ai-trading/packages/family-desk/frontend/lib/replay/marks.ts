import type { MarketChartLevel } from "../../components/charts/MarketChart.tsx";
import type { ChartMarkerInput } from "../chart-data.ts";
import { formatEtClock, formatPrice } from "../desk/format.ts";
import type { OpenTrade, ReplayBar, ReplayLevels, ReplayMark, ReplaySignal } from "./schemas.ts";
import { ms } from "./time.ts";

// Practice marks and replayed signals to chart inputs (02o §d). Every label says Practice: these are journal
// annotations on a finished past day, never orders.

const AMBER = "#FFB020";
const MUTED = "#9B9BA1";

/** The start of the bar that was open at `instantMs`: the last bar starting at or before it. Null before the first bar. */
export function barStartFor(bars: readonly Pick<ReplayBar, "t">[], instantMs: number): string | null {
  let found: string | null = null;
  for (const bar of bars) {
    if (ms(bar.t) <= instantMs) found = bar.t;
    else break;
  }
  return found;
}

export function markLabel(mark: Pick<ReplayMark, "kind" | "shares" | "stop_price">): string {
  switch (mark.kind) {
    case "long_entry": return `Practice long ${mark.shares ?? ""}`.trim();
    case "short_entry": return `Practice short ${mark.shares ?? ""}`.trim();
    case "long_exit":
    case "short_exit": return "Practice exit";
    case "stop": return `Practice stop ${formatPrice(mark.stop_price)}`;
    case "note": return "Practice note";
  }
}

/** Entries and exits sit on the bar they were placed in; a stop is a chart level and a note lives in the Marks list. */
export function practiceMarkers(marks: readonly ReplayMark[], bars: readonly ReplayBar[]): ChartMarkerInput[] {
  return marks.flatMap((mark): ChartMarkerInput[] => {
    const kind = mark.kind === "long_entry" ? "practice_long" : mark.kind === "short_entry" ? "practice_short" : mark.kind === "long_exit" || mark.kind === "short_exit" ? "practice_exit" : null;
    const time = barStartFor(bars, ms(mark.at));
    return kind && time ? [{ time, kind, label: markLabel(mark) }] : [];
  });
}

/** A released signal fires at its bar close: the marker sits on the display bar that was open one second before it. */
export function signalMarkers(signals: readonly ReplaySignal[], bars: readonly ReplayBar[]): ChartMarkerInput[] {
  return signals.flatMap((signal): ChartMarkerInput[] => {
    const time = barStartFor(bars, ms(signal.bar_close) - 1000);
    return time ? [{ time, kind: "would_fire", label: signal.name }] : [];
  });
}

/** The practice stop of the open trade as an amber dashed level; none when no stop note exists. */
export function stopLevel(trade: Pick<OpenTrade, "stop_price"> | null): MarketChartLevel[] {
  return trade?.stop_price != null ? [{ label: "Practice stop", price: trade.stop_price, color: AMBER, style: "dashed" }] : [];
}

/** Key levels as dotted muted lines (prior close, session high and low, opening range). */
export function levelLines(levels: ReplayLevels): MarketChartLevel[] {
  const rows: Array<[string, number | null | undefined]> = [
    ["Prior close", levels.prior_close],
    ["Session high", levels.session_high],
    ["Session low", levels.session_low],
    ["OR high", levels.opening_range_high],
    ["OR low", levels.opening_range_low],
  ];
  return rows.flatMap(([label, price]): MarketChartLevel[] => (price == null ? [] : [{ label, price, color: MUTED, style: "dotted" }]));
}

export type LevelRow = { label: string; price: number };

/** The Levels tab: highest first. */
export function levelRows(levels: ReplayLevels): LevelRow[] {
  return levelLines(levels).flatMap((line) => (line.price == null ? [] : [{ label: line.label, price: line.price }])).sort((a, b) => b.price - a.price);
}

export type MarkRow = { id: number; time: string; label: string; price: string; note: string | null; auto: boolean };

/** The Marks tab: newest first. */
export function markRows(marks: readonly ReplayMark[]): MarkRow[] {
  return [...marks]
    .sort((a, b) => b.seq - a.seq)
    .map((mark) => ({
      id: mark.id,
      time: formatEtClock(mark.at),
      label: markLabel(mark),
      price: mark.kind === "note" ? "" : formatPrice(mark.kind === "stop" ? mark.stop_price : mark.price),
      note: mark.note,
      auto: mark.source === "auto",
    }));
}

/** When the open trade was entered: the time of its entry mark. Null when no mark carries its trade number. */
export function entrySince(marks: readonly ReplayMark[], trade: Pick<OpenTrade, "trade_no"> | null): string | null {
  if (trade === null) return null;
  const entry = [...marks].reverse().find((mark) => (mark.kind === "long_entry" || mark.kind === "short_entry") && mark.trade_no === trade.trade_no);
  return entry?.at ?? null;
}

/** The side of the open trade, for the keyboard map and the controls. */
export const openSide = (trade: Pick<OpenTrade, "side"> | null): "flat" | "long" | "short" => (trade ? trade.side : "flat");

/** The journal chart's `Practice P/L` pane: the latest realized P/L at or before each bar's start, null before the first point. */
export function pnlValues(bars: readonly Pick<ReplayBar, "t">[], series: ReadonlyArray<{ t: string; pnl_usd: number }>): Array<number | null> {
  const points = series.map((point) => ({ at: ms(point.t), value: point.pnl_usd })).sort((a, b) => a.at - b.at);
  let index = -1;
  return bars.map((bar) => {
    const start = ms(bar.t);
    while (index + 1 < points.length && points[index + 1]!.at <= start) index += 1;
    return index >= 0 ? points[index]!.value : null;
  });
}

/** Undo is possible only while the playhead sits where the last mark was stamped (02o §b1 endpoint 9). */
export function canUndoLast(marks: readonly ReplayMark[], revealedThrough: string): boolean {
  const last = [...marks].sort((a, b) => b.seq - a.seq)[0];
  return last !== undefined && last.source === "her" && ms(last.at) === ms(revealedThrough);
}

export const lastMark = (marks: readonly ReplayMark[]): ReplayMark | null => [...marks].sort((a, b) => b.seq - a.seq)[0] ?? null;

/** Index of the first bar at or after the window start (the lookback sits before it); 0 when none is earlier. */
export function windowIndex(bars: readonly Pick<ReplayBar, "t">[], windowStart: string): number {
  const start = ms(windowStart);
  const index = bars.findIndex((bar) => ms(bar.t) >= start);
  return index < 0 ? 0 : index;
}
