import type { MarketChartLevel } from "../../components/charts/MarketChart.tsx";
import type { ChartMarkerInput } from "../chart-data.ts";
import { formatEtClock, formatPrice } from "../desk/format.ts";
import type { ChartPrefs, LevelId } from "./chartPrefs.ts";
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
    case "long_entry": return `Practice buy ${mark.shares ?? ""}`.trim();
    case "short_entry": return `Practice sell ${mark.shares ?? ""}`.trim();
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

/** Key levels as dotted muted lines (prior close, session high and low, opening range). `id` is what the chart settings filter by. */
export function levelLines(levels: ReplayLevels): Array<MarketChartLevel & { id: LevelId; price: number }> {
  const rows: Array<[LevelId, string, number | null | undefined]> = [
    ["prior_close", "Prior close", levels.prior_close],
    ["session", "Session high", levels.session_high],
    ["session", "Session low", levels.session_low],
    ["opening_range", "OR high", levels.opening_range_high],
    ["opening_range", "OR low", levels.opening_range_low],
  ];
  return rows.flatMap(([id, label, price]) => (price == null ? [] : [{ id, label, price, color: MUTED, style: "dotted" as const }]));
}

/** The order the names of one merged line read in: "OR high · Session high". */
const NAME_ORDER = ["OR high", "OR low", "Session high", "Session low", "Prior close"];
const cents = (price: number) => Math.round(price * 100);

/**
 * The levels the chart draws: the ones she left on, with levels within one cent of each other as one line that carries
 * every name (D-099: on a flat day OR high and Session high are the same price and drew eight stacked tags). The Levels
 * list under the chart keeps every row (`levelRows`); the toggles hide lines, not data.
 */
export function chartLevels(levels: ReplayLevels, prefs: Pick<ChartPrefs, "on">): MarketChartLevel[] {
  const kept = levelLines(levels).flatMap((line, order) => (prefs.on[line.id] ? [{ ...line, order }] : []));
  const groups: Array<typeof kept> = [];
  for (const line of [...kept].sort((a, b) => a.price - b.price)) {
    const group = groups.find((members) => cents(line.price) - cents(members[0]!.price) <= 1);
    if (group) group.push(line);
    else groups.push([line]);
  }
  return groups
    .sort((a, b) => Math.min(...a.map((line) => line.order)) - Math.min(...b.map((line) => line.order)))
    .map((members): MarketChartLevel => {
      const named = [...members].sort((a, b) => NAME_ORDER.indexOf(a.label) - NAME_ORDER.indexOf(b.label));
      return { label: named.map((line) => line.label).join(" · "), price: named[0]!.price, color: MUTED, style: "dotted" };
    });
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

/** When the open position was opened: the time of its first fill (every fill that adds to it carries its trade number). Null when no mark carries it. */
export function entrySince(marks: readonly ReplayMark[], trade: Pick<OpenTrade, "trade_no"> | null): string | null {
  if (trade === null) return null;
  const entry = marks.find((mark) => (mark.kind === "long_entry" || mark.kind === "short_entry") && mark.trade_no === trade.trade_no);
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

/** Which side of its bar the library draws a marker's text on: only markers on one side can print over each other. */
const MARKER_SIDE: Record<ChartMarkerInput["kind"], "above" | "below" | "in"> = {
  pattern: "below",
  fire: "above",
  would_fire: "above",
  practice_long: "below",
  practice_short: "above",
  practice_exit: "in",
};

/** Labels about this far apart (in bars) no longer touch at the replay's usual zoom. */
const LABEL_GAP_BARS = 12;

/**
 * Marker labels that would print over each other (and over the VWAP line) lose their text, the newest one on each side
 * keeping it; every marker keeps its shape and colour, and the Marks list names them all (D-099).
 * ponytail: a fixed 12-bar gap, not measured from the zoom; widen or measure if labels still touch.
 */
export function declutterMarkers(markers: readonly ChartMarkerInput[], bars: readonly Pick<ReplayBar, "t">[]): ChartMarkerInput[] {
  const index = new Map(bars.map((bar, position) => [bar.t, position]));
  const hidden = new Set<number>();
  for (const side of ["above", "below", "in"] as const) {
    const newestFirst = markers
      .flatMap((marker, position) => (MARKER_SIDE[marker.kind] === side && index.has(marker.time) ? [{ position, bar: index.get(marker.time)! }] : []))
      .sort((a, b) => b.bar - a.bar || b.position - a.position);
    let lastKept = Infinity;
    for (const { position, bar } of newestFirst) {
      if (lastKept - bar >= LABEL_GAP_BARS) lastKept = bar;
      else hidden.add(position);
    }
  }
  return markers.map((marker, position) => (hidden.has(position) ? { ...marker, label: "" } : marker));
}

/** Bars shown on the first draw of a followed chart: 90, or one regular session (6.5 hours) when that is fewer, so a 15m axis stops at the session (D-099). */
export function firstDrawBars(interval: string): number {
  const minutes = /^(\d+)m$/.exec(interval)?.[1];
  return minutes ? Math.min(90, Math.ceil(390 / Number(minutes))) : 90;
}
