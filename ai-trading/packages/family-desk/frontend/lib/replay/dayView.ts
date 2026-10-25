import {
  EMPTY_VALUE,
  changeTone,
  formatEtDay,
  formatEtTime,
  formatEtTimeZone,
  formatMetric,
  formatSignedPct,
  formatPct,
  type MetricFormat,
  type Tone,
} from "../desk/format.ts";
import { PRACTICE_COPY, practiceText } from "../desk/freshness.ts";
import type { Candidate, DayList, DayReview, ListColumn, PracticePlan, Rescan, ReviewRow } from "./daily.ts";

// Daily-list practice, view logic (02o-b v1): what the hub card, the day screen and the review say. Pure, so the
// node tests cover it. Dates are returned by the API and hidden here by a render rule, as in 02o.

export const MAX_STARS = 5;

/** "name" or "names" for a count. */
export const nameWord = (count: number): string => (count === 1 ? "name" : "names");

/** The most names the plan lets her star and practise in a day (`maxSymbols`; the server sends the effective cap). */
export const nameCap = (plan: Pick<PracticePlan, "max_symbols">): number => plan.max_symbols;

/** "2 of 3 names practised today". */
export function namesTodayText(list: Pick<DayList, "sessions" | "plan">): string {
  const max = nameCap(list.plan);
  return practiceText("dayNamesToday", { used: list.sessions.length, max, names: nameWord(max) });
}

/** The plan hides dates (the weekday stays). */
export const datesHidden = (plan: Pick<PracticePlan["spec"], "hideDates">): boolean => plan.hideDates === "yes";

const dayName = (weekday: string, day: string | null, hidden: boolean): string => (hidden || day === null ? weekday : formatEtDay(day));

/** "Day 7 of 20 · Tue", or "Day 7 of 20 · Tue 2026-03-03" with dates shown. */
export function dayTitle(list: Pick<DayList, "day_no" | "of" | "weekday" | "day">, hidden: boolean): string {
  return `${practiceText("planDay", { day: list.day_no, of: list.of })} · ${dayName(list.weekday, list.day, hidden)}`;
}

/** "List at 8:30 AM ET from data through 8:15 AM · 118 of 131 scanned · 34 matched, showing 30". */
export function listHeaderText(list: Pick<DayList, "list_at" | "data_through" | "universe">): string {
  const { universe } = list;
  return practiceText("dayHeader", {
    listAt: formatEtTimeZone(list.list_at),
    through: formatEtTime(list.data_through),
    scanned: universe.scanned,
    size: universe.size,
    matched: universe.matches_total,
    shown: universe.shown,
  });
}

/** What is armed on the plan's practice days: its picked filters by name, other strategies by count. */
export function planArmedText(plan: Pick<PracticePlan, "spec" | "filters">): string {
  const armed = plan.spec.setup.armed;
  if (armed.length === 0) return PRACTICE_COPY.planArmedNone;
  const names = armed
    .filter((ref) => ref.source === "filter")
    .map((ref) => plan.filters.find((filter) => filter.id === ref.id)?.name ?? "A filter");
  const alerts = armed.length - names.length;
  if (alerts > 0) names.push(`${alerts} alert ${alerts === 1 ? "strategy" : "strategies"}`);
  return practiceText("planArmed", { names: names.join(" · ") });
}

export type PlanCardAction = "new" | "start" | "continue" | "none";
export type PlanCard = { headline: string; detail: string | null; action: PlanCardAction };

/** The hub card: "Day 7 of 20 · next: Tue" with Continue, the data-preparing line, or the empty state. */
export function planCard(plan: PracticePlan | null): PlanCard {
  if (plan === null) return { headline: PRACTICE_COPY.planNone, detail: null, action: "new" };
  const hidden = datesHidden(plan.spec);
  const failed = plan.prep.failed > 0 ? practiceText("planFailedSome", { failed: plan.prep.failed }) : null;
  if (plan.finished) return { headline: practiceText("planDone", { of: plan.sessions }), detail: failed, action: "new" };
  const current = plan.current;
  if (current !== null && current.status !== "ended") {
    return {
      headline: practiceText("planInProgress", { day: current.day_no, of: plan.sessions }),
      detail: failed,
      action: "continue",
    };
  }
  if (plan.prep.state === "running" && plan.days_opened === 0) {
    return {
      headline: practiceText("planPreparing", { done: plan.prep.done, total: plan.prep.total }),
      detail: PRACTICE_COPY.planPreparingHint,
      action: "none",
    };
  }
  const next = plan.next_weekday === null ? "" : ` · ${practiceText("planNext", { weekday: dayName(plan.next_weekday, plan.next_day, hidden) })}`;
  return {
    headline: `${practiceText("planDay", { day: plan.next_day_no ?? plan.days_opened + 1, of: plan.sessions })}${next}`,
    detail: failed,
    action: plan.days_opened === 0 ? "start" : "continue",
  };
}

// ---- the candidate table -----------------------------------------------------------------------------------

const FORMATS: ReadonlySet<string> = new Set<MetricFormat>(["price", "pct", "pct_signed", "compact", "ratio", "number", "time"]);

/** One cell of the list table; the API names each column's format, an unknown one reads as a plain number. */
export function cellText(column: Pick<ListColumn, "key" | "format">, row: Pick<Candidate, "metrics" | "matched_since">): string {
  if (column.key === "matched_since") return formatMetric("time", row.matched_since);
  const format = FORMATS.has(column.format) ? (column.format as MetricFormat) : "number";
  return formatMetric(format, row.metrics[column.key] ?? null);
}

export function cellTone(column: Pick<ListColumn, "key" | "format">, row: Pick<Candidate, "metrics">): Tone | null {
  return column.format === "pct_signed" ? changeTone(row.metrics[column.key] ?? null) : null;
}

/** "Gap up · Abnormal volume" */
export const filtersText = (row: Pick<Candidate, "filters">): string => row.filters.join(" · ");

export const isStarred = (watch: readonly { symbol: string }[], symbol: string): boolean => watch.some((star) => star.symbol === symbol);

/** The next stars after a click, or null when a name past the cap is refused (the plan's `maxSymbols`, at most five). */
export function toggledStars(watch: readonly { symbol: string }[], symbol: string, cap: number = MAX_STARS): string[] | null {
  const symbols = watch.map((star) => star.symbol);
  if (symbols.includes(symbol)) return symbols.filter((item) => item !== symbol);
  return symbols.length >= Math.min(cap, MAX_STARS) ? null : [...symbols, symbol];
}

/** The message for a refused star: the plain 5-name line, or the plan's own cap. */
export function starsFullText(cap: number): string {
  return cap >= MAX_STARS ? PRACTICE_COPY.dayStarsFull : practiceText("dayStarsFullAt", { max: cap, names: nameWord(cap) });
}

export type StripRow = {
  symbol: string;
  /** The session to resume; null for a starred name she has not opened yet. */
  sessionId: number | null;
  starred: boolean;
  behind: boolean;
  holding: boolean;
};

/** The day's names: every one she has opened, then the starred ones she has not. `from` is the name she is on and its
 *  playhead: another name whose playhead is earlier is behind the day clock, which the list read may not know yet. */
export function stripRows(list: Pick<DayList, "sessions" | "watch">, from?: { symbol: string; playhead: string }): StripRow[] {
  const starred = new Set(list.watch.map((star) => star.symbol));
  const opened = list.sessions.map((session): StripRow => ({
    symbol: session.symbol,
    sessionId: session.id,
    starred: starred.has(session.symbol),
    behind:
      session.behind_clock ||
      (from !== undefined && session.symbol !== from.symbol && session.status === "active" && Date.parse(session.revealed_through) < Date.parse(from.playhead)),
    holding: session.has_open_trade,
  }));
  const open = new Set(opened.map((row) => row.symbol));
  const rest = list.watch.filter((star) => !open.has(star.symbol)).map((star): StripRow => ({ symbol: star.symbol, sessionId: null, starred: true, behind: false, holding: false }));
  return [...opened, ...rest];
}

// ---- re-scan at the day clock (02o-b2) ---------------------------------------------------------------------------

/** A re-scan runs at the day clock, which starts with her first name and is never before the list time. */
export const canRescan = (list: Pick<DayList, "status" | "clock" | "list_at">): boolean =>
  list.status !== "ended" && list.clock !== null && Date.parse(list.clock) >= Date.parse(list.list_at);

/** "Scan 2 · run at 10:00 AM ET · data through 9:45 AM": the clock it ran at and the time its data stops. */
export const rescanLabel = (scan: Pick<Rescan, "seq" | "as_of" | "data_through">): string =>
  practiceText("dayRescanLabel", { seq: scan.seq, clock: formatEtTimeZone(scan.as_of), through: formatEtTime(scan.data_through) });

/** "2 of 2 matched · 1 new since your list". */
export const rescanCounts = (scan: Pick<Rescan, "universe" | "new_count">): string =>
  practiceText("dayRescanCounts", { shown: scan.universe.shown, matched: scan.universe.matches_total, fresh: scan.new_count });

/** The day clock has moved since the scan ran: the scan is older than the screen's clock. */
export function rescanStaleText(list: Pick<DayList, "clock" | "rescan">): string | null {
  if (list.rescan === null || list.clock === null || Date.parse(list.clock) <= Date.parse(list.rescan.as_of)) return null;
  return practiceText("dayRescanStale", { clock: formatEtTimeZone(list.clock) });
}

export function listWarning(list: Pick<DayList, "warnings" | "candidates">): string | null {
  // The server says why a list is short; the plain line stands in for a list it had no reason for.
  return list.warnings[0] ?? (list.candidates.length === 0 ? PRACTICE_COPY.dayNoNames : null);
}

// ---- the review ----------------------------------------------------------------------------------------------

const ORDINAL_SUFFIX = ["th", "st", "nd", "rd"];

/** 1st, 2nd, 3rd, 4th, 11th, 12th, 13th, 21st. */
export function ordinal(value: number): string {
  const lastTwo = value % 100;
  const suffix = lastTwo >= 11 && lastTwo <= 13 ? "th" : (ORDINAL_SUFFIX[value % 10] ?? "th");
  return `${value}${suffix}`;
}

const joinAnd = (parts: readonly string[]): string => (parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`);

/** "Your names moved +3.1% and −0.4% · list median 1.8% · ranked 4th and 11th of 30"; null when she picked none. */
export function selectionText(review: Pick<DayReview, "of" | "selection">): string | null {
  const { picks, median_abs_move_pct: median } = review.selection;
  if (picks.length === 0) return null;
  return practiceText("reviewSelection", {
    moves: joinAnd(picks.map((pick) => formatSignedPct(pick.move_pct, 1))),
    median: formatPct(median, 1),
    ranks: joinAnd(picks.map((pick) => ordinal(pick.rank))),
    of: review.of,
  });
}

export const moveText = (value: number | null): string => (value === null ? EMPTY_VALUE : formatSignedPct(value, 2));

export const pickedLabel = (row: Pick<ReviewRow, "picked">): string => (row.picked === "traded" ? "Practised" : row.picked === "starred" ? "Starred" : "");

/** "Your day: 1 practice trade · +$63.00". */
export function journalLine(journal: NonNullable<DayList["journal"]>): string {
  const trades = journal.trades === 1 ? "1 practice trade" : `${journal.trades} practice trades`;
  const pnl = journal.pnl_usd;
  const sign = pnl > 0 ? "+" : pnl < 0 ? "−" : "";
  return `${trades} · ${sign}$${Math.abs(pnl).toFixed(2)}`;
}

// ---- Peek ----------------------------------------------------------------------------------------------------

/** `count` weekday dates ending 2001-01-05 + count: a stand-in timeline for a daily chart whose real dates are hidden. */
export function syntheticDays(count: number): string[] {
  const out: string[] = [];
  const date = new Date(Date.UTC(2001, 0, 1, 12));
  while (out.length < count) {
    if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6) out.push(date.toISOString().slice(0, 10));
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return out;
}

type PeekDaily = { t: string; o: number; h: number; l: number; c: number; v: number };

/** Daily bars for the chart; with dates hidden, real dates give way to a stand-in timeline (the last bar's date would name the day). */
export function peekDailyBars(bars: readonly PeekDaily[], hidden: boolean): PeekDaily[] {
  if (!hidden) return [...bars];
  const days = syntheticDays(bars.length);
  return bars.map((bar, index) => ({ ...bar, t: days[index]! }));
}
