import {
  EMPTY_VALUE,
  changeTone,
  formatPrice,
  formatEtDay,
  formatEtTime,
  formatEtTimeZone,
  formatMetric,
  formatSignedPct,
  type MetricFormat,
  type Tone,
} from "../desk/format.ts";
import { PRACTICE_COPY, practiceText } from "../desk/freshness.ts";
import type { Candidate, DayJournal, DayList, DayReview, DayTradeLine, ListColumn, PracticePlan, ReviewRow } from "./daily.ts";
import { formatUsd } from "./journalView.ts";

// Daily-list practice, view logic (02o-b v1): what the hub card, the day screen and the review say. Pure, so the
// node tests cover it. Dates are returned by the API and hidden here by a render rule, as in 02o.

export const MAX_STARS = 5;

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
    // A listed day has not been practised yet; only a practising one is "in progress" (D-035).
    return {
      headline: practiceText(current.status === "practicing" ? "planInProgress" : "planListed", { day: current.day_no, of: plan.sessions }),
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
  // The day just ended is said as done, and Continue opens the next one: the same list the review's "Next day" opens.
  const done = current === null ? null : practiceText("planDayDone", { day: current.day_no });
  return {
    headline: `${practiceText("planDay", { day: plan.next_day_no ?? plan.days_opened + 1, of: plan.sessions })}${next}`,
    detail: [done, failed].filter(Boolean).join(" · ") || null,
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

/** The next stars after a click, or null when a sixth name is refused. */
export function toggledStars(watch: readonly { symbol: string }[], symbol: string): string[] | null {
  const symbols = watch.map((star) => star.symbol);
  if (symbols.includes(symbol)) return symbols.filter((item) => item !== symbol);
  return symbols.length >= MAX_STARS ? null : [...symbols, symbol];
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

/** "Your names moved +3.1% and −0.4% · list median +1.8% · ranked 4th and 11th of 30"; null when she picked none.
 *  The median is of the signed moves, like the ranking (D-031). */
export function selectionText(review: Pick<DayReview, "of" | "selection">): string | null {
  const { picks, median_move_pct: median } = review.selection;
  if (picks.length === 0) return null;
  return practiceText("reviewSelection", {
    moves: joinAnd(picks.map((pick) => formatSignedPct(pick.move_pct, 1))),
    median: formatSignedPct(median, 1),
    ranks: joinAnd(picks.map((pick) => ordinal(pick.rank))),
    of: review.of,
  });
}

export const moveText = (value: number | null): string => (value === null ? EMPTY_VALUE : formatSignedPct(value, 2));

export const pickedLabel = (row: Pick<ReviewRow, "picked">): string => (row.picked === "traded" ? "Practised" : row.picked === "starred" ? "Starred" : "");

/** "Day finished · date shown below" when the plan hid the date while the day ran, else null (the date was never hidden: D-029). */
export const dayFinishedLine = (review: Pick<DayReview, "dates_hidden">): string | null => (review.dates_hidden ? PRACTICE_COPY.reviewDayFinished : null);

/** "Your day: 1 practice trade · +$1,565.00", dollars and cents. */
export function journalLine(journal: Pick<DayJournal, "trades" | "pnl_usd">): string {
  const trades = journal.trades === 1 ? "1 practice trade" : `${journal.trades} practice trades`;
  return `${trades} · ${formatUsd(journal.pnl_usd)}`;
}

/** "1 win · 0 losses" (a scratch is neither, and is counted only when there is one). */
export function dayRecordText(journal: Pick<DayJournal, "wins" | "losses" | "scratches">): string {
  const part = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  const text = `${part(journal.wins, "win", "wins")} · ${part(journal.losses, "loss", "losses")}`;
  return journal.scratches > 0 ? `${text} · ${part(journal.scratches, "scratch", "scratches")}` : text;
}

const money = (value: number): string => `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** "Balance $50,000.00 → $51,565.00" (SIMULATED), or null for a day with no thread. */
export function dayBalanceText(journal: Pick<DayJournal, "balance_before" | "balance_after">): string | null {
  const { balance_before: before, balance_after: after } = journal;
  if (before === null || after === null) return null;
  return practiceText("reviewBalance", { before: money(before), after: money(after) });
}

export type TradeLineRow = { key: string; symbol: string; side: string; shares: string; entry: string; exit: string; pnl: string; tone: Tone };

/** One row per closed trade: the entry and exit price with the ET time, the shares, and the P/L to the cent. */
export function tradeLineRows(journal: Pick<DayJournal, "lines">): TradeLineRow[] {
  return journal.lines.map((line: DayTradeLine) => ({
    key: `${line.symbol}-${line.no}-${line.entry_at}`,
    symbol: line.symbol,
    side: line.side === "long" ? "Long" : "Short",
    shares: line.shares.toLocaleString("en-US"),
    entry: `${formatPrice(line.entry_price)} · ${formatEtTime(line.entry_at)}`,
    exit: `${formatPrice(line.exit_price)} · ${formatEtTime(line.exit_at)}${line.exit_source === "auto" ? " (auto, window end)" : ""}`,
    pnl: formatUsd(line.pnl_usd),
    tone: changeTone(line.pnl_usd),
  }));
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
