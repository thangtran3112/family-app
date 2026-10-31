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
import type { Candidate, DayJournal, DayList, DayReview, DayTradeLine, ListColumn, PracticePlan, Rescan, ReviewRow } from "./daily.ts";
import { formatUsd } from "./journalView.ts";
import type { ThreadPlan } from "./threads.ts";

// Daily-list practice, view logic (02o-b v1): what the hub card, the day screen and the review say. Pure, so the
// node tests cover it. Dates are returned by the API and hidden here by a render rule, as in 02o.

export const MAX_STARS = 5;

/** "name" or "names" for a count. */
export const nameWord = (count: number): string => (count === 1 ? "name" : "names");

/** The most names the plan lets her star and practise in a day (`maxSymbols`; the server sends the effective cap). */
export const nameCap = (plan: Pick<PracticePlan, "max_symbols">): number => plan.max_symbols;

/** "2 of 3 names practiced today". */
export function namesTodayText(list: Pick<DayList, "sessions" | "plan">): string {
  const max = nameCap(list.plan);
  return practiceText("dayNamesToday", { used: list.sessions.length, max, names: nameWord(max) });
}

/** The plan hides dates (the weekday stays). */
export const datesHidden = (plan: Pick<PracticePlan["spec"], "hideDates">): boolean => plan.hideDates === "yes";

const dayName = (weekday: string, day: string | null, hidden: boolean): string => (hidden || day === null ? weekday : formatEtDay(day));

/** A day's number in its thread (D-047): a plan counts its own days from 1, and a plan that replaced another comes after the
 *  days the thread had already ended. This is the number the journal gives the same day (`n`). */
export const threadDayNo = (plan: Pick<PracticePlan, "day_offset">, planDayNo: number): number => planDayNo + plan.day_offset;

/** "Day 7 of 20", or "Day 7 · plan day 2 of 5" when an earlier plan's days came first: one number for the day on every screen. */
export function dayNumberText(plan: Pick<PracticePlan, "day_offset" | "sessions">, planDayNo: number): string {
  return plan.day_offset === 0
    ? practiceText("planDay", { day: planDayNo, of: plan.sessions })
    : practiceText("planDayInThread", { day: threadDayNo(plan, planDayNo), planDay: planDayNo, of: plan.sessions });
}

/** "Day 7 of 20 · Tue", or "Day 7 of 20 · Tue 2026-03-03" with dates shown. */
export function dayTitle(list: Pick<DayList, "day_no" | "of" | "weekday" | "day"> & { plan: Pick<PracticePlan, "day_offset"> }, hidden: boolean): string {
  return `${dayNumberText({ day_offset: list.plan.day_offset, sessions: list.of }, list.day_no)} · ${dayName(list.weekday, list.day, hidden)}`;
}

/** "List at 8:30 AM ET from data through 8:15 AM · 118 of 131 scanned · 34 matched, showing 30" (kept whole for the plain-text reads). */
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

/** "118 of 131 scanned · 34 matched · showing 30": the first line under the title (P7). */
export function listCountsText(list: Pick<DayList, "universe">): string {
  const { universe } = list;
  return practiceText("dayCounts", { scanned: universe.scanned, size: universe.size, matched: universe.matches_total, shown: universe.shown });
}

/** "List built at 8:30 AM ET from data through 8:15 AM": the small line beside the counts. */
export function listBuiltText(list: Pick<DayList, "list_at" | "data_through">): string {
  return practiceText("dayListBuilt", { listAt: formatEtTimeZone(list.list_at), through: formatEtTime(list.data_through) });
}

/** The Desk universe is capped at this many names by dollar volume (the backend's `MAX_UNIVERSE`). */
export const UNIVERSE_CAP = 250;

/** P7's universe footnote with the list's own size, then whatever else the server said (a watchlist scope, a cap); the recorded morning's own note when the Desk recorded it. */
export function universeNote(universe: Pick<DayList["universe"], "size" | "label" | "footnote" | "membership">): string {
  // A day with a recorded morning (02o-b2) says so in the server's own words; the line about today's set is for the days before the recording.
  if (universe.membership?.source === "universe_days") return universe.footnote;
  const extra = (universe.footnote.startsWith(universe.label) ? universe.footnote.slice(universe.label.length) : "").replace(/^ · /, "").trim();
  const base = practiceText("dayUniverse", { max: UNIVERSE_CAP, size: universe.size });
  return extra ? `${base} ${extra.charAt(0).toUpperCase()}${extra.slice(1)}.` : base;
}

/** "Source: Alpaca SIP bars up to 8:15 AM ET · nothing after the list time is shown". */
export const sourceNote = (list: Pick<DayList, "data_through">): string => practiceText("daySource", { through: formatEtTimeZone(list.data_through) });

/** "Chosen at setup · a name that passes either one is listed", or just "Chosen at setup" for one filter. */
export const filtersNote = (count: number): string => (count > 1 ? PRACTICE_COPY.dayFiltersNote : PRACTICE_COPY.dayFiltersNoteOne);

/** The thread's risk plan in one sentence: "stop on every entry, trade only on a signal, max loss $600, up to 3 trades a day". */
export function riskPlanText(plan: Pick<ThreadPlan, "stopNoteOnEntry" | "tradeOnlyOnSignal" | "maxLossUsd" | "maxTrades">): string {
  const parts = [
    plan.stopNoteOnEntry === "yes" ? "stop on every entry" : null,
    plan.tradeOnlyOnSignal === "yes" ? "trade only on a signal" : null,
    plan.maxLossUsd === undefined ? null : `max loss $${plan.maxLossUsd.toLocaleString("en-US")}`,
    plan.maxTrades === undefined ? null : `up to ${plan.maxTrades} ${plan.maxTrades === 1 ? "trade" : "trades"} a day`,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? PRACTICE_COPY.dayRiskNone : practiceText("dayRiskFrom", { plan: parts.join(", ") });
}

export type LadderRow = { n: number; weekday: string | null; state: "ended" | "open" | "opens_after" | "locked"; detail: string };

/** The block's days as a ladder (P7): the ones before this day ended, this day open or ended, the next one waits for this one, the rest are locked.
 *  `n` is the plan's own count; `offset` (the plan's `day_offset`) turns it into the thread's number for the labels (D-047). */
export function blockLadder(list: Pick<DayList, "day_no" | "of" | "status" | "weekday">, offset = 0): LadderRow[] {
  const ended = list.status === "ended";
  return Array.from({ length: list.of }, (_, index): LadderRow => {
    const n = index + 1;
    if (n < list.day_no || (n === list.day_no && ended)) return { n, weekday: n === list.day_no ? list.weekday : null, state: "ended", detail: PRACTICE_COPY.dayLadderEnded };
    if (n === list.day_no) return { n, weekday: list.weekday, state: "open", detail: PRACTICE_COPY.dayLadderOpen };
    if (n === list.day_no + 1) return { n, weekday: null, state: "opens_after", detail: practiceText("dayLadderOpensAfter", { day: list.day_no + offset }) };
    return { n, weekday: null, state: "locked", detail: PRACTICE_COPY.dayLadderLocked };
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
    // A listed day has not been practiced yet; only a practicing one is "in progress" (D-035). The day before it is done (D-051).
    const day = threadDayNo(plan, current.day_no);
    const previous = day > 1 ? practiceText("planDayDoneNext", { done: day - 1, next: day }) : null;
    return {
      headline: `${dayNumberText(plan, current.day_no)} · ${PRACTICE_COPY[current.status === "practicing" ? "planStateInProgress" : "planStateListed"]}`,
      detail: [current.status === "listed" ? previous : null, failed].filter(Boolean).join(" · ") || null,
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
  const done = current === null ? null : practiceText("planDayDone", { day: threadDayNo(plan, current.day_no) });
  return {
    headline: `${dayNumberText(plan, plan.next_day_no ?? plan.days_opened + 1)}${next}`,
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

/** One column of the day list: the API's own metric columns, plus the P7 columns it only holds in part (D-018). */
export type DayColumn = {
  key: string;
  label: string;
  format: string;
  /** The cell's value; null reads as a dash. */
  value: (row: Candidate) => number | string | null;
  /** The payload has no value for this column in this list: every cell is an honest dash, never a stand-in. */
  missing?: boolean;
};

const EARNINGS_FORMAT = "earnings";

/**
 * The table's columns in the order of P7: list price, prev close, prev RVOL, prev change %, ATR %, RSI, earnings, then the rest of the
 * server's columns and the time the match began. A list built before the open reads the previous session
 * in the server's own columns (`prev_basis`), so those fill Prev RVOL and Prev change %. A list built after the open has
 * no previous-session RVOL or change in its payload: those two columns stay and read a dash. Prev close is
 * the candidate's `prior_close` either way.
 */
export function dayColumns(list: Pick<DayList, "columns" | "universe">): DayColumn[] {
  const prevBasis = list.universe.prev_basis;
  const have = new Map(list.columns.map((column) => [column.key, column]));
  const used = new Set<string>(["matched_since"]);
  const metric = (key: string) => (row: Candidate) => row.metrics[key] ?? null;
  const plain = (key: string): DayColumn[] => {
    const column = have.get(key);
    if (!column || used.has(key)) return [];
    used.add(key);
    return [{ key, label: column.label, format: column.format, value: metric(key) }];
  };
  const previous = (key: string, label: string, format: string, source: string): DayColumn => {
    if (prevBasis) used.add(source);
    return { key, label, format, value: prevBasis ? metric(source) : () => null, missing: !prevBasis };
  };
  if (prevBasis) used.add("last");

  const head = [...plain("list_price"), ...plain("list_change_pct")];
  const prev: DayColumn[] = [
    { key: "prev_close", label: "Prev close", format: "price", value: (row) => row.prior_close },
    previous("prev_rvol", "Prev RVOL", "ratio", "rvol_10d"),
    previous("prev_change_pct", "Prev change %", "pct_signed", "change_pct"),
  ];
  const core = [...plain("atr_pct_14"), ...plain("rsi_14")];
  const rest = list.columns.flatMap((column) => plain(column.key));
  const earnings: DayColumn = { key: "earnings", label: "Earnings", format: EARNINGS_FORMAT, value: (row) => (row.reported_before_open ? PRACTICE_COPY.dayReported : null) };
  const since = have.get("matched_since");
  const tail: DayColumn[] = since ? [{ key: "matched_since", label: since.label, format: since.format, value: (row) => row.matched_since }] : [];
  return [...head, ...prev, ...core, earnings, ...rest, ...tail];
}

/** A cell's text: a dash for a value the payload does not hold. */
export function dayCellText(column: DayColumn, row: Candidate): string {
  const value = column.value(row);
  if (column.format === EARNINGS_FORMAT) return value === null ? EMPTY_VALUE : String(value);
  if (column.format === "time") return formatMetric("time", value);
  const format = FORMATS.has(column.format) ? (column.format as MetricFormat) : "number";
  return formatMetric(format, typeof value === "number" ? value : null);
}

export function dayCellTone(column: DayColumn, row: Candidate): Tone | null {
  const value = column.value(row);
  return column.format === "pct_signed" && typeof value === "number" ? changeTone(value) : null;
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

/** A name's button on the day list: "Practice" opens a name at the day clock, "Switch" goes back to one she opened. Resume
 *  belongs to the thread's day (one shared clock for every name), never to a single name. */
export const nameActionLabel = (opened: boolean): string => (opened ? "Switch" : "Practice");

/** Where a session's Resume goes: a day-list session resumes through its day (the list, whose "Resume Day N" reopens the
 *  day at the shared clock); only a standalone session, which has no day, opens on its own. */
export const sessionResumeHref = (session: { id: number; day_list_id: number | null }): string =>
  session.day_list_id === null ? `/practice/replay?id=${session.id}` : `/practice/day?id=${session.day_list_id}`;

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

export function listWarning(list: Pick<DayList, "warnings">): string | null {
  // The server says why a list is short. A list it had no reason for shows the empty state under the table instead.
  return list.warnings[0] ?? null;
}

/** "0 of 131 matched": the empty state's headline; the line under it says what to do (P7). */
export const noMatchText = (list: Pick<DayList, "universe">): string =>
  practiceText("dayNoneMatched", { matched: list.universe.matches_total, size: list.universe.size });

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

export const pickedLabel = (row: Pick<ReviewRow, "picked">): string => (row.picked === "traded" ? "Practiced" : row.picked === "starred" ? "Starred" : "");

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

/** A hidden Peek chart's row labels for a screen reader: "D-3", "D-2", "D-1" (every bar is before the day; the last is the prior close). */
export const peekOffsets = (count: number): string[] => Array.from({ length: count }, (_, index) => `D-${count - index}`);
