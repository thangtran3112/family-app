import { EMPTY_VALUE, changeTone, formatEtDay, formatMetric, formatPrice, formatSignedPct, type MetricFormat, type Tone } from "../desk/format.ts";
import { PRACTICE_COPY, practiceText } from "../desk/freshness.ts";
import { formatR } from "./journalView.ts";
import type { Hold, Paused, PriceBasis, StripRow } from "./schemas.ts";
import type { BoardRow, SwingDayList, SwingDaySummary } from "./swingApi.ts";
import type { ThreadBrief, ThreadSummary } from "./threads.ts";
import { dayResultTone, formatBalance, formatDayResult } from "./threadView.ts";
import { etHhMm } from "./time.ts";
import { sourceLabel } from "./universeView.ts";

// Swing practice (02p), view logic of the board, the workspace and the hub card: hold rows, free cash, the sizing hint,
// the gap, the stop pause, the day strip, the header lines and the End day and Pass prompts. Pure, so the node tests
// cover it. A swing payload names days by number and weekday; dates stay hidden by the thread's `hideDates` rule. Every
// dollar figure is SIMULATED, and the lines that join money say so in words.

/** The most shares a mark can carry (the contract's bound), so a sizing hint never asks for more. */
export const MAX_MARK_SHARES = 10_000;

const joinAnd = (parts: readonly string[]): string => (parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`);
const wholeNumber = (value: number) => value.toLocaleString("en-US");
const plural = (count: number, one: string, many = `${one}s`) => (count === 1 ? one : many);

/** The thread's dates rule: hidden unless the setup says otherwise. */
export const swingDatesHidden = (swing: { hideDates: "yes" | "no" } | null | undefined): boolean => swing?.hideDates !== "no";

export const sideLabel = (side: "long" | "short"): string => (side === "long" ? "Long" : "Short");

// -- holds ----------------------------------------------------------------------------------------------------

/** "Day 3 · 184.20": the day she entered and the price. */
export const holdEntryLabel = (hold: Pick<Hold, "entry_day_no" | "entry_price">): string =>
  practiceText("swingEntryLabel", { day: hold.entry_day_no, price: formatPrice(hold.entry_price) });

/** "Day 2 of hold": the entry day is Day 1. It is a count of the hold's days, not a length of time, so it never reads "1 day held" on the entry day and again on the next board (D-140). */
export const daysHeldText = (days: number): string => practiceText("swingHoldDay", { n: days });

/** "Stop 182.50", "Stop 182.50 crossed" once play paused on it, or "No stop". */
export function holdStopText(hold: Pick<Hold, "stop_price" | "stop_hit">): string {
  if (hold.stop_price === null) return PRACTICE_COPY.swingNoStop;
  const price = formatPrice(hold.stop_price);
  return practiceText(hold.stop_hit === "yes" ? "swingStopCrossed" : "swingStop", { price });
}

/**
 * How far the price is from a stop. `pct` is signed in her favour (the strip's `stop_distance_pct`): positive while the
 * price is on the safe side, zero at the stop, negative once it crossed. A stop the pause already flagged reads as past.
 */
export function stopDistanceText(pct: number | null | undefined, stopped: "yes" | "no" = "no"): string {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return PRACTICE_COPY.swingNoStop;
  const size = `${Math.abs(pct).toFixed(1)}%`;
  if (stopped === "yes" || pct < 0) return practiceText("swingStopPast", { pct: size });
  return Number(size.slice(0, -1)) === 0 ? PRACTICE_COPY.swingStopAt : practiceText("swingStopAway", { pct: size });
}

/** "Prior close 187.40" before anything of the day is revealed, "Last 182.10" after; "Last 182.35 · one-minute close" with the tape off. */
export function priceBasisLabel(basis: PriceBasis | null | undefined, price: number | null | undefined, tape: "on" | "off" = "on"): string {
  if (price === null || price === undefined || !Number.isFinite(price)) return EMPTY_VALUE;
  const text = formatPrice(price);
  if (basis === "prior_close") return practiceText("swingPriorClose", { price: text });
  return practiceText(tape === "off" ? "swingLastOneMinute" : "swingLastPrice", { price: text });
}

/** "Gap −$412" / "Gap +$412": the carried hold's overnight move, signed for its side. Null while there is no first price. */
export function gapText(usd: number | null | undefined): string | null {
  if (usd === null || usd === undefined || !Number.isFinite(usd)) return null;
  return practiceText("swingGap", { amount: formatDayResult(usd) });
}

/** "Earnings today · before open", "Earnings next session · after close", "Earnings in 3 sessions · before open". */
export function earningsText(chip: { in_sessions: number; timing: "before open" | "after close" } | null | undefined): string | null {
  if (!chip) return null;
  const when = chip.in_sessions <= 0 ? "today" : chip.in_sessions === 1 ? "next session" : `in ${chip.in_sessions} sessions`;
  return practiceText("swingEarnings", { when, timing: chip.timing });
}

export type HoldRowView = {
  id: number;
  symbol: string;
  status: "open" | "closed";
  side: string;
  shares: string;
  /** "Day 3 · 184.20" */
  entry: string;
  /** "2 days held" */
  held: string;
  /** "Stop 182.50", "Stop 182.50 crossed" or "No stop". */
  stop: string;
  stopCrossed: boolean;
  /** An open hold's value line: "Prior close 187.40" / "Last 182.10". Empty dash for a closed hold. */
  value: string;
  /** Unrealized P/L for an open hold, final P/L for a closed one. */
  result: string;
  resultTone: Tone;
  r: string;
  gap: string | null;
  earnings: string | null;
  /** The API's own sentence ("Split 10-for-1 before today's open · 100 shares are now 1,000 at 120.38"), as it is. */
  splitNote: string | null;
  /** A closed hold: "Exit Day 5 · 190.10", or "Closed at the close of Day 20 · 190.10" for an automatic exit. */
  exit: string | null;
};

function exitText(hold: Pick<Hold, "status" | "exit_day_no" | "exit_price" | "exit_source">): string | null {
  if (hold.status !== "closed" || hold.exit_day_no === null) return null;
  const values = { day: hold.exit_day_no, price: formatPrice(hold.exit_price) };
  return practiceText(hold.exit_source === "auto" ? "swingExitAuto" : "swingExitHer", values);
}

/** A hold as a row of the board's pinned table, the thread page and the hold card. `tape` only changes the "Last" wording. */
export function holdRowView(hold: Hold, tape: "on" | "off" = "on"): HoldRowView {
  const closed = hold.status === "closed";
  const result = closed ? hold.pnl_usd : hold.unrealized_usd;
  return {
    id: hold.id,
    symbol: hold.symbol,
    status: hold.status,
    side: sideLabel(hold.side),
    shares: wholeNumber(hold.shares),
    entry: holdEntryLabel(hold),
    held: daysHeldText(hold.days_held),
    stop: holdStopText(hold),
    stopCrossed: hold.stop_hit === "yes",
    value: closed ? EMPTY_VALUE : priceBasisLabel(hold.price_basis, hold.last_close, tape),
    result: formatDayResult(result),
    resultTone: dayResultTone(result),
    r: formatR(hold.r),
    gap: gapText(hold.gap_usd),
    earnings: earningsText(hold.earnings),
    splitNote: hold.split_note,
    exit: exitText(hold),
  };
}

// -- cash and sizing --------------------------------------------------------------------------------------------

/** "Free cash $8,240". */
export const freeCashText = (usd: number | null | undefined): string =>
  usd === null || usd === undefined ? EMPTY_VALUE : practiceText("swingFreeCash", { amount: formatBalance(usd) });

/** The risk a sizing hint uses: `riskPerHoldUsd` when set, else the thread plan's max loss (02p b2). */
export const sizingRiskUsd = (swing: { riskPerHoldUsd?: number | null } | null | undefined, plan: { maxLossUsd?: number | null } | null | undefined): number | undefined =>
  swing?.riskPerHoldUsd ?? plan?.maxLossUsd ?? undefined;

export type SizingHint = { shares: number; limitedBy: "risk" | "cash"; text: string };

/**
 * shares = risk ÷ |last − stop|, capped by free cash ÷ last and by the 10,000 a mark can carry. A hint only: nothing
 * blocks a bigger size. Null with no risk, no stop or no price to size from.
 */
export function sizingHint(input: { riskUsd: number | null | undefined; last: number | null | undefined; stop: number | null | undefined; freeCash?: number | null }): SizingHint | null {
  const { riskUsd, last, stop, freeCash } = input;
  if (riskUsd == null || last == null || stop == null || !(riskUsd > 0) || !(last > 0)) return null;
  const perShare = Math.abs(last - stop);
  if (!(perShare > 0)) return null;
  const byRisk = Math.floor(riskUsd / perShare);
  const byCash = freeCash == null ? Number.POSITIVE_INFINITY : Math.floor(Math.max(freeCash, 0) / last);
  const shares = Math.min(byRisk, byCash, MAX_MARK_SHARES);
  const limitedBy = byCash < byRisk ? "cash" : "risk";
  if (shares < 1) {
    const text = limitedBy === "cash" ? PRACTICE_COPY.swingSizingNoCash : practiceText("swingSizingTooBig", { risk: formatBalance(riskUsd) });
    return { shares: 0, limitedBy, text };
  }
  const noun = shares === 1 ? "share" : "shares";
  const text =
    limitedBy === "cash"
      ? practiceText("swingSizingCash", { shares: wholeNumber(shares), noun })
      : practiceText("swingSizingRisk", { shares: wholeNumber(shares), noun, risk: formatBalance(riskUsd) });
  return { shares, limitedBy, text };
}

// -- the stop pause -------------------------------------------------------------------------------------------

export type PauseView = {
  /** "NVDA crossed your stop 182.50 at 11:42", or "NVDA opened below your stop 182.50 at 179.10" at a gap open. */
  headline: string;
  /** "AMD and TSLA also crossed", when more than one hold crossed in the same minute. */
  also: string | null;
  action: string;
  /** The toast: headline, the other names, then "Exit or keep". */
  text: string;
};

/** The toast for a stop pause. Playing has stopped; the stop is a note, so exiting is her call. */
export function pauseView(paused: Paused): PauseView {
  const stop = formatPrice(paused.stop_price);
  const headline =
    paused.kind === "gap"
      ? practiceText(paused.price < paused.stop_price ? "swingPauseGapBelow" : "swingPauseGapAbove", { symbol: paused.symbol, stop, price: formatPrice(paused.price) })
      : practiceText("swingPauseCross", { symbol: paused.symbol, stop, time: etHhMm(paused.at) });
  const also = paused.also.length > 0 ? practiceText("swingPauseAlso", { names: joinAnd(paused.also) }) : null;
  const action = PRACTICE_COPY.swingPauseAction;
  return { headline, also, action, text: [headline, also, action].filter((part) => part !== null).join(" · ") };
}

// -- the day strip --------------------------------------------------------------------------------------------

export type StripRowView = {
  symbol: string;
  source: "hold" | "focus";
  /** "182.10", or a dash before the day's first price. */
  last: string;
  /** "−0.4%" against the prior close. */
  change: string;
  changeTone: Tone;
  /** A hold's line: "Long 100 · +$231 · 1.8% from your stop". Null for a focus name. */
  sub: string | null;
  /** The stop paused play on this hold. */
  amber: boolean;
  /** One sentence for the row's accessible name. */
  label: string;
};

/** A row of the workspace's day strip; a hold whose stop paused the clock is amber. */
export function stripRowView(row: StripRow): StripRowView {
  const last = row.last === null ? EMPTY_VALUE : formatPrice(row.last);
  const change = formatSignedPct(row.chg_pct, 1);
  const hold = row.hold;
  const sub = hold
    ? practiceText("swingStripHold", {
        side: sideLabel(hold.side),
        shares: wholeNumber(hold.shares),
        pnl: formatDayResult(hold.unrealized_usd),
        stop: stopDistanceText(hold.stop_distance_pct, hold.stopped),
      })
    : null;
  const amber = hold?.stopped === "yes";
  const label = [row.symbol, row.source === "hold" ? "practice hold" : "focus name", `last ${last}`, change, sub, amber ? "stop crossed" : null]
    .filter((part) => part !== null)
    .join(", ");
  // The colour follows the rounded text: -0.01% reads "0.0%" and is flat, not red (D-148).
  const shown = row.chg_pct == null ? row.chg_pct : Number(row.chg_pct.toFixed(1));
  return { symbol: row.symbol, source: row.source, last, change, changeTone: changeTone(shown), sub, amber, label };
}

// -- header lines ---------------------------------------------------------------------------------------------

const dayName = (weekday: string, day: string, hidden: boolean): string => (hidden ? weekday : formatEtDay(day));

/** "Day 7 of 20 · Week 2 · Tue", or with the date when dates are shown. */
export function swingDayTitle(list: Pick<SwingDayList, "day_no" | "of" | "week_no" | "weekday" | "day">, hidden: boolean): string {
  return [practiceText("planDay", { day: list.day_no, of: list.of }), practiceText("swingWeek", { n: list.week_no }), dayName(list.weekday, list.day, hidden)].join(" · ");
}

/** "Balance $51,240 · Equity $52,010 · Free cash $8,240 · SIMULATED": the money half of the workspace header. */
export function swingBriefLine(brief: Pick<ThreadBrief, "balance" | "equity_usd" | "free_cash_usd">): string {
  const parts = [practiceText("swingBalance", { amount: formatBalance(brief.balance) })];
  if (brief.equity_usd != null) parts.push(practiceText("swingEquity", { amount: formatBalance(brief.equity_usd) }));
  if (brief.free_cash_usd != null) parts.push(freeCashText(brief.free_cash_usd));
  parts.push(PRACTICE_COPY.swingSimulated);
  return parts.join(" · ");
}

/** "Day 7 of 20 · Tue": the board's h1. The week and the state are chips beside it and the money is in the strip below (D-139). */
export function swingBoardTitle(list: Pick<SwingDayList, "day_no" | "of" | "weekday" | "day">, hidden: boolean): string {
  return [practiceText("planDay", { day: list.day_no, of: list.of }), dayName(list.weekday, list.day, hidden)].join(" · ");
}

/** "2 holds open" / "1 hold open" / "No holds open". */
export const holdsOpenText = (count: number): string => (count === 0 ? PRACTICE_COPY.swingNoHoldsOpen : `${count} ${plural(count, "hold")} open`);

export type SwingCardAction = { kind: "start" | "continue" | "review" | "none"; label: string | null; weekNo: number | null };
export type SwingCardView = {
  /** "Swing · 50 names" */
  title: string;
  /** "Swing · 50 names · Week 2 of 4 · Day 7 of 20 · 2 holds open" */
  line: string;
  /** "Week 1 review ready" once a week's last day has ended and the next day has not opened. */
  notice: string | null;
  action: SwingCardAction;
};

/** The hub card of a swing thread; null for a day thread (or a payload without the swing state). */
export function swingCardView(summary: Pick<ThreadSummary, "thread" | "swing" | "today">): SwingCardView | null {
  const { thread, swing } = summary;
  if (thread.mode !== "swing" || !swing) return null;
  const title = practiceText("swingCardNames", { n: thread.swing?.universe.length ?? 0 });
  const finished = swing.next === "finished";
  const place = finished
    ? [practiceText("swingFinished", { days: swing.days })]
    : [practiceText("swingCardWeek", { week: swing.week_no, weeks: swing.weeks }), practiceText("planDay", { day: swing.day_no, of: swing.days })];
  // Week, day, names and holds only: the balance and the equity sit in their own cells (D-112).
  const line = [title, ...place, ...(finished ? [] : [holdsOpenText(swing.holds_open)])].join(" · ");
  const reviewWeek = swing.week_no - 1;
  if (finished) return { title, line, notice: null, action: { kind: "none", label: null, weekNo: null } };
  if (swing.next === "week_review" && reviewWeek >= 1) {
    return {
      title,
      line,
      notice: practiceText("swingReviewReady", { n: reviewWeek }),
      action: { kind: "review", label: practiceText("swingOpenReview", { n: reviewWeek }), weekNo: reviewWeek },
    };
  }
  const fresh = swing.days_ended === 0 && summary.today === null;
  return {
    title,
    line,
    notice: null,
    action: fresh
      ? { kind: "start", label: practiceText("swingStartDay", { n: swing.day_no }), weekNo: null }
      : { kind: "continue", label: practiceText("swingContinueDay", { n: swing.day_no }), weekNo: null },
  };
}

// -- End day and Pass -----------------------------------------------------------------------------------------

/** "End Day 7 at 11:40? Your 2 holds stay open through the close, unwatched." `clock` is the day clock (ISO), if it has one. */
export function endDayPrompt(input: { dayNo: number; clock: string | null; holdsOpen: number }): string {
  const time = input.clock === null ? null : etHhMm(input.clock);
  const ask = time === null ? practiceText("swingEndAsk", { day: input.dayNo }) : practiceText("swingEndAskAt", { day: input.dayNo, time });
  const body =
    input.holdsOpen === 0
      ? PRACTICE_COPY.swingEndNoHolds
      : input.holdsOpen === 1
        ? PRACTICE_COPY.swingEndOneHold
        : practiceText("swingEndHolds", { n: input.holdsOpen });
  return `${ask} ${body}`;
}

/** The End day button's hint: "2 holds stay open overnight". Null with none open. */
export const endDayHint = (holdsOpen: number): string | null =>
  holdsOpen === 0 ? null : holdsOpen === 1 ? PRACTICE_COPY.swingOvernightOne : practiceText("swingOvernight", { n: holdsOpen });

/** Pass this day: "Your 2 holds ride through Day 7 unwatched." */
export function passDayPrompt(input: { dayNo: number; holdsOpen: number }): string {
  if (input.holdsOpen === 0) return practiceText("swingPassNoHolds", { day: input.dayNo });
  if (input.holdsOpen === 1) return practiceText("swingPassOneHold", { day: input.dayNo });
  return practiceText("swingPassHolds", { n: input.holdsOpen, day: input.dayNo });
}

// -- the board ------------------------------------------------------------------------------------------------

const FORMATS: ReadonlySet<string> = new Set<MetricFormat>(["price", "pct", "pct_signed", "compact", "ratio", "number", "time"]);

/** One cell of the swing board; the API names each column's format, and `text` or an unknown one reads as plain text. */
export function boardCellText(column: { key: string; format: string }, row: BoardRow): string {
  if (column.key === "source") return sourceLabel(row.source);
  if (column.key === "matches") return row.matches.length === 0 ? EMPTY_VALUE : row.matches.join(" · ");
  const value = (row as Record<string, unknown>)[column.key];
  if (typeof value !== "number") return typeof value === "string" ? value : EMPTY_VALUE;
  return formatMetric(FORMATS.has(column.format) ? (column.format as MetricFormat) : "number", value);
}

export function boardCellTone(column: { key: string; format: string }, row: BoardRow): Tone | null {
  if (column.format !== "pct_signed") return null;
  const value = (row as Record<string, unknown>)[column.key];
  return changeTone(typeof value === "number" ? value : null);
}

/** Names she can practise today: her open holds first, then the starred names (entries are allowed only on these). */
export function practiseNames(list: Pick<SwingDayList, "watch" | "holds">): string[] {
  const held = list.holds.filter((hold) => hold.status === "open").map((hold) => hold.symbol);
  return [...new Set([...held, ...list.watch.map((star) => star.symbol)])];
}

/** The name `Start Day` opens on: the first starred name, else the first hold. Null with neither. */
export const firstSessionSymbol = (list: Pick<SwingDayList, "watch" | "holds">): string | null =>
  list.watch[0]?.symbol ?? list.holds.find((hold) => hold.status === "open")?.symbol ?? null;

/** Where an ended day's tiles come from: the day summary as one strip of tiles. */
export type DayTile = { id: string; label: string; value: string; sub: string | null; tone: Tone };

export function daySummaryTiles(summary: SwingDaySummary): DayTile[] {
  const away = summary.stop_hits.filter((hit) => hit.watched === "no").length;
  return [
    { id: "realized", label: "Realized", value: formatDayResult(summary.realized_usd), sub: null, tone: dayResultTone(summary.realized_usd) },
    { id: "gap", label: "Overnight gap", value: formatDayResult(summary.gap_usd), sub: null, tone: dayResultTone(summary.gap_usd) },
    { id: "intraday", label: "Intraday", value: formatDayResult(summary.intraday_usd), sub: null, tone: dayResultTone(summary.intraday_usd) },
    { id: "equity_change", label: "Equity change", value: formatDayResult(summary.equity_change_usd), sub: null, tone: dayResultTone(summary.equity_change_usd) },
    { id: "balance", label: "Balance", value: formatBalance(summary.balance_usd), sub: null, tone: "flat" },
    { id: "equity", label: "Equity", value: formatBalance(summary.equity_usd), sub: null, tone: "flat" },
    { id: "trades", label: "Entries · exits", value: `${summary.entries} · ${summary.exits}`, sub: summary.passed === "yes" ? PRACTICE_COPY.swingPassed : null, tone: "flat" },
    {
      id: "stops",
      label: "Stop crossings",
      value: String(summary.stop_hits.length),
      sub: away > 0 ? practiceText("swingStopsAway", { n: away }) : null,
      tone: "flat",
    },
  ];
}

/** "NVDA crossed its stop at 11:42" or "... at 11:42 while you were away". */
export const stopHitText = (hit: { symbol: string; at: string; watched: "yes" | "no" }): string =>
  practiceText(hit.watched === "yes" ? "swingStopHitWatched" : "swingStopHitAway", { symbol: hit.symbol, time: hit.at });
