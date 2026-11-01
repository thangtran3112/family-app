import type { MarketChartLevel } from "../../components/charts/MarketChart.tsx";
import type { ChartBar, ChartMarkerInput, CrosshairPoint } from "../chart-data.ts";
import { formatPrice } from "../desk/format.ts";
import { PRACTICE_COPY } from "../desk/freshness.ts";
import type { LegendModel } from "../desk/workspace.ts";
import { syntheticDays } from "./dayView.ts";
import type { PlanItem } from "./planView.ts";
import type { DailyBlock, Hold, Paused, ReplayInterval, StripRow } from "./schemas.ts";
import { swingBriefLine, swingDayTitle } from "./swing.ts";
import type { SwingDayList, WeekRow } from "./swingApi.ts";
import type { ThreadBrief } from "./threads.ts";
import { formatBalance, formatDayResult } from "./threadView.ts";

// The swing practice workspace (02p), the view logic F4's screens need on top of `swing.ts`: the chart toggle and the
// Daily chart's data, the sizing default, the plan checklist rows, the stop-pause Exit target and the header lines.
// Pure, so the node tests cover it. Money is SIMULATED and no date reaches the screen while the thread hides dates.

/** The few strings the workspace says that no copy row carries. Plain words; the tests run them through the banned list. */
export const SWING_PLAY_COPY = {
  switchError: "Couldn't open that name · Try again",
  dailyNote: "Daily bars through the prior close · today's candle is still forming",
  dailyNotePrior: "Daily bars through the prior close",
  noOpenHold: "No open practice hold",
  openHoldsLabel: "Open holds",
  holdOpenCardLabel: "Open practice hold",
  planTitle: "Swing plan",
  today: "Today",
} as const;


/** A swing session is one that belongs to a swing thread (the session answer carries the thread brief). */
export const isSwingSession = (session: { thread: { mode: string } | null }): boolean => session.thread?.mode === "swing";

// -- the chart toggle -------------------------------------------------------------------------------------------

export type ChartMode = "daily" | "15m" | "5m";
/** Daily · 15m · 5m, in the order the toggle prints them. */
export const CHART_MODES: readonly ChartMode[] = ["daily", "15m", "5m"];

export const chartModeLabel = (mode: ChartMode): string => (mode === "daily" ? "Daily" : mode);

/** The view a swing session opens on: its own interval (a swing thread uses 5m or 15m; anything else reads as 5m). */
export const initialChartMode = (interval: ReplayInterval): ChartMode => (interval === "15m" ? "15m" : "5m");

/** The feed interval behind an intraday mode. */
export const intradayOf = (mode: Exclude<ChartMode, "daily">): ReplayInterval => mode;

// -- the Daily chart --------------------------------------------------------------------------------------------

const AMBER = "#FFB020";
const MUTED = "#9B9BA1";

export type DailyChartModel = {
  /** The rebased bars through the prior close, then today's forming candle. Dates are a stand-in timeline while hidden. */
  bars: ChartBar[];
  /** Her hold's entry marker on the bar of the day she entered (none when that day is older than the chart). */
  markers: ChartMarkerInput[];
  /** Her entry and stop as price lines across all the days. */
  levels: MarketChartLevel[];
  /** While dates are hidden, "D-12 … D-1, Today" per bar; null when dates show. */
  offsets: string[] | null;
  /** The sentence under the chart. */
  note: string;
};

const offsetLabel = (back: number): string => (back <= 0 ? SWING_PLAY_COPY.today : `D-${back}`);

/**
 * The Daily chart's data from the API's `daily` block (the rebased frame through the prior close, the forming candle, her
 * hold). With dates hidden the real dates give way to a stand-in timeline (the last real date would name the day), and the
 * hold marker is placed by the bar's INDEX, found through the real date before it is replaced.
 */
export function dailyChartModel(block: DailyBlock, hidden: boolean): DailyChartModel {
  const raw = block.forming ? [...block.bars, block.forming] : [...block.bars];
  const dates = hidden ? syntheticDays(raw.length) : raw.map((bar) => bar.t);
  const bars: ChartBar[] = raw.map((bar, index) => ({ t: dates[index]!, o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v }));
  const today = block.forming ? raw.length - 1 : raw.length;
  const hold = block.holds[0];
  const at = hold ? raw.findIndex((bar) => bar.t === hold.entry_t) : -1;
  // The chart snaps a marker to the ET day of its instant: noon UTC is the same ET day all year.
  const markers: ChartMarkerInput[] =
    hold && at >= 0
      ? [{ time: `${dates[at]}T12:00:00Z`, kind: hold.side === "long" ? "practice_long" : "practice_short", label: `Practice ${hold.side} ${formatPrice(hold.entry_price)}` }]
      : [];
  const levels: MarketChartLevel[] = hold
    ? [
        { label: "Practice entry", price: hold.entry_price, color: MUTED, style: "dotted" },
        ...(hold.stop_price != null ? [{ label: "Practice stop", price: hold.stop_price, color: AMBER, style: "dashed" as const }] : []),
      ]
    : [];
  return {
    bars,
    markers,
    levels,
    offsets: hidden ? raw.map((_, index) => offsetLabel(today - index)) : null,
    note: block.forming ? SWING_PLAY_COPY.dailyNote : SWING_PLAY_COPY.dailyNotePrior,
  };
}

const timeKey = (time: CrosshairPoint["time"]): string | null =>
  typeof time === "string" ? time : typeof time === "object" ? `${time.year}-${String(time.month).padStart(2, "0")}-${String(time.day).padStart(2, "0")}` : null;

/** The legend of the Daily chart: `NVDA · Daily · D-3 · O … H … L … C …` at the crosshair, or at the newest bar. */
export function dailyLegend(symbol: string, model: Pick<DailyChartModel, "bars" | "offsets">, point: CrosshairPoint | null): LegendModel {
  const last = model.bars.at(-1);
  const key = point ? timeKey(point.time) : null;
  const index = key === null ? model.bars.length - 1 : model.bars.findIndex((bar) => bar.t === key);
  const offset = model.offsets?.[index] ?? null;
  const o = point ? point.open : (last?.o ?? null);
  const h = point ? point.high : (last?.h ?? null);
  const l = point ? point.low : (last?.l ?? null);
  const c = point ? point.close : (last?.c ?? null);
  const ohlc = `O ${formatPrice(o)} H ${formatPrice(h)} L ${formatPrice(l)} C ${formatPrice(c)}`;
  return { title: [symbol, "Daily", offset, ohlc].filter((part): part is string => part !== null).join(" · "), items: [] };
}

// -- marks: the stop pause ---------------------------------------------------------------------------------------

export const exitKindFor = (side: "long" | "short"): "long_exit" | "short_exit" => (side === "long" ? "long_exit" : "short_exit");

export type PauseExit = { symbol: string; kind: "long_exit" | "short_exit"; /** The paused name is the one on the chart. */ here: boolean };

/**
 * What the toast's Exit does: an exit mark on the paused name. On the chart's own name the side comes from the open trade;
 * for another name from its swing strip row or, on a day, from the portfolio (`held`). Null when the side is not known (the
 * button is then left off).
 */
export function pauseExit(
  paused: Pick<Paused, "symbol">,
  context: {
    sessionSymbol: string;
    openSide: "flat" | "long" | "short";
    strip: readonly StripRow[] | null;
    held?: readonly { symbol: string; side: "long" | "short" | null }[];
  },
): PauseExit | null {
  const here = paused.symbol === context.sessionSymbol;
  const fromStrip = context.strip?.find((row) => row.symbol === paused.symbol)?.hold?.side ?? null;
  const fromHeld = context.held?.find((row) => row.symbol === paused.symbol)?.side ?? null;
  const side = here && context.openSide !== "flat" ? context.openSide : (fromStrip ?? fromHeld);
  return side === null ? null : { symbol: paused.symbol, kind: exitKindFor(side), here };
}

/** Open holds, counted from the day strip (every open hold is on it). */
export const stripHoldCount = (strip: readonly StripRow[] | null): number => strip?.filter((row) => row.source === "hold").length ?? 0;

// -- the plan checklist ----------------------------------------------------------------------------------------------

export type WeekFigures = { entries: number; realizedUsd: number };
export type DayRange = { first: number; last: number };

/** The first and last day number of a week, from the weeks list. */
export function weekRange(weeks: readonly Pick<WeekRow, "week_no" | "first_day_no" | "last_day_no">[], weekNo: number | null | undefined): DayRange | null {
  const row = weeks.find((week) => week.week_no === weekNo);
  return row ? { first: row.first_day_no, last: row.last_day_no } : null;
}

/** The week's entries and realized P/L from the thread's holds: entered or exited on a day of the week (today's exits count). */
export function weekFigures(holds: readonly Pick<Hold, "entry_day_no" | "exit_day_no" | "status" | "pnl_usd">[], range: DayRange): WeekFigures {
  const within = (day: number | null) => day !== null && day >= range.first && day <= range.last;
  return {
    entries: holds.filter((hold) => within(hold.entry_day_no)).length,
    realizedUsd: holds.reduce((sum, hold) => sum + (hold.status === "closed" && within(hold.exit_day_no) ? (hold.pnl_usd ?? 0) : 0), 0),
  };
}

/**
 * The swing plan as live ticks (02p b2: all scored, none blocks): the open holds (a count; cash is the only size rule),
 * then, when the week's holds are known, the entries and the realized result of the week. A number that is not known is left off.
 */
export function swingPlanItems(input: { holdsOpen: number; maxTrades: number | null; maxLossUsd: number | null; week: WeekFigures | null }): PlanItem[] {
  const { holdsOpen, maxTrades, maxLossUsd, week } = input;
  const items: PlanItem[] = [
    {
      id: "open_holds",
      label: SWING_PLAY_COPY.openHoldsLabel,
      state: "ok",
      detail: String(holdsOpen),
    },
  ];
  if (week === null) return items;
  items.push({
    id: "entries_week",
    label: maxTrades === null ? "Entries this week" : `Entries this week · max ${maxTrades}`,
    state: maxTrades !== null && week.entries > maxTrades ? "warn" : week.entries === 0 ? "pending" : "ok",
    detail: maxTrades === null ? String(week.entries) : `${week.entries} of ${maxTrades}`,
  });
  if (maxLossUsd !== null) {
    items.push({
      id: "week_loss",
      label: `Week loss limit ${formatBalance(maxLossUsd)}`,
      state: week.realizedUsd <= -maxLossUsd ? "warn" : "ok",
      detail: `${formatDayResult(week.realizedUsd)} this week`,
    });
  }
  return items;
}

// -- the header ------------------------------------------------------------------------------------------------------

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** "Day 7 of 20 · Week 2 · Tue" (the date in place of the weekday when dates show). Null when the brief lacks the numbers. */
export function swingDayChip(brief: Pick<ThreadBrief, "day_no" | "days" | "week_no">, day: string, hidden: boolean): string | null {
  const weekday = WEEKDAYS[new Date(`${day}T12:00:00Z`).getUTCDay()];
  if (brief.day_no == null || brief.days == null || brief.week_no == null || weekday === undefined || weekday === "Sun" || weekday === "Sat") return null;
  const list: Pick<SwingDayList, "day_no" | "of" | "week_no" | "weekday" | "day"> = { day_no: brief.day_no, of: brief.days, week_no: brief.week_no, weekday, day };
  return swingDayTitle(list, hidden);
}

/** "Balance $51,240 · Equity $52,010 · Free cash $24,720": the money half of the header, without the SIMULATED word (a badge follows it). */
export function swingMoneyLine(brief: Pick<ThreadBrief, "balance" | "equity_usd" | "free_cash_usd">): string {
  const suffix = ` · ${PRACTICE_COPY.swingSimulated}`;
  const line = swingBriefLine(brief);
  return line.endsWith(suffix) ? line.slice(0, -suffix.length) : line;
}

/** The note under the header while the tape is off; tape on shows the feed label in the tape panel as it always did. */
export const tapeNote = (feed: string): string | null => (feed === "off" ? PRACTICE_COPY.swingTapeOff : null);
