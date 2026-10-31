import { EMPTY_VALUE, changeTone, formatPrice, formatSignedPct, type Tone } from "../desk/format.ts";
import { PRACTICE_COPY, practiceText } from "../desk/freshness.ts";
import { ordinal, syntheticDays } from "./dayView.ts";
import { formatR } from "./journalView.ts";
import { gapText } from "./swing.ts";
import type { SwingSource, WeekCheck, WeekHeat, WeekHold, WeekOut, WeekReview, WeekRow, WeekStop } from "./swingApi.ts";
import type { SwingState } from "./threads.ts";
import { dayResultTone, formatBalance, formatDayResult, winRateText } from "./threadView.ts";
import { sourceLabel } from "./universeView.ts";

// The weekly review (02p e1, e2), view logic: tiles, the selection and timing sentence, the equity series, the days and
// holds tables, the universe heat strip, the adherence checks and the "Start Week" step. Pure, so the node tests cover
// it. A week names its days by number and weekday only, so no date is revealed. Every dollar figure is SIMULATED, and
// every sign is a real minus (U+2212) or a plus.

const MINUS = "−";
const pct = (value: number | null | undefined, digits = 1): string => (value == null ? EMPTY_VALUE : formatSignedPct(value, digits));

/** "+1.8 pts" / "−0.6 pts" / "0.0 pts": percentage points against the universe median or against holding close to close. */
export function signedPts(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return EMPTY_VALUE;
  const text = Math.abs(value).toFixed(1);
  return text === "0.0" ? "0.0 pts" : `${value > 0 ? "+" : MINUS}${text} pts`;
}

const ptsTone = (value: number | null | undefined): Tone => (value == null ? "flat" : changeTone(Number(Math.abs(value).toFixed(1)) === 0 ? 0 : value));

// -- heading ---------------------------------------------------------------------------------------------------

export type WeekHeading = {
  /** "Week 3", "Week 1 · 3 days", or "Week 3 · 2 of 5 days" for a week not played to its planned end. */
  title: string;
  /** "Week to date" while the week is open, else "Final". */
  badge: string;
  /** What "to date" means, shown under the title; null for a frozen week. */
  note: string | null;
};

export function weekHeading(week: Pick<WeekOut, "label" | "to_date" | "status">, openHolds = 0): WeekHeading {
  const toDate = week.to_date === "yes";
  // A week can be final while holds ride on: the chip says so (D-130).
  const final = openHolds > 0 ? practiceText("swingWeekFinalHolds", { n: openHolds, noun: openHolds === 1 ? "hold" : "holds" }) : PRACTICE_COPY.swingWeekFinal;
  return {
    title: week.label,
    badge: toDate ? PRACTICE_COPY.swingWeekToDate : week.status === "closed" ? final : PRACTICE_COPY.swingWeekOpen,
    note: toDate ? PRACTICE_COPY.swingWeekToDateNote : null,
  };
}

/** "Start Week 3" once week 2 is reviewed and the thread is waiting for the next day; null when there is nothing to start. */
export function startWeekAction(state: Pick<SwingState, "next" | "week_no"> | null | undefined, reviewedWeekNo: number): { label: string; weekNo: number } | null {
  if (!state || state.next !== "week_review" || state.week_no !== reviewedWeekNo + 1) return null;
  return { label: practiceText("swingStartWeek", { n: state.week_no }), weekNo: state.week_no };
}

// -- tiles -----------------------------------------------------------------------------------------------------

export type WeekTile = { id: string; label: string; value: string; sub: string; tone: Tone };

/** A share of the week's change. Past 100% the gap is bigger than the whole change (the rest of the week pulled the other
 *  way), so the tile says "Over 100%" and its line says why instead of printing 315% (D-070). */
const OVER_SHARE = 100;
const share = (value: number | null | undefined): string =>
  value == null || !Number.isFinite(value)
    ? EMPTY_VALUE
    : Math.abs(value) > OVER_SHARE
      ? PRACTICE_COPY.swingTileGapOver
      : `${value < 0 ? MINUS : ""}${Math.abs(Math.round(value))}%`;
const gapSub = (t: Pick<WeekReview["tiles"], "gap_usd" | "gap_share_pct">): string => {
  const text = gapText(t.gap_usd);
  if (text === null) return PRACTICE_COPY.swingTileNoGap;
  return t.gap_share_pct != null && Math.abs(t.gap_share_pct) > OVER_SHARE ? practiceText("swingTileGapOverSub", { gap: text }) : text;
};

/** The review's tiles in reading order. `toDate` only changes the wording of the sub-lines. */
export function weekTiles(review: Pick<WeekReview, "tiles">, toDate = false): WeekTile[] {
  const t = review.tiles;
  const wins = t.avg_win_usd === null && t.avg_loss_usd === null;
  return [
    { id: "realized", label: "Realized", value: formatDayResult(t.realized_usd), sub: toDate ? PRACTICE_COPY.swingTileRealizedSoFar : PRACTICE_COPY.swingTileRealized, tone: dayResultTone(t.realized_usd) },
    { id: "unrealized", label: "Unrealized change", value: formatDayResult(t.unrealized_change_usd), sub: PRACTICE_COPY.swingTileUnrealized, tone: dayResultTone(t.unrealized_change_usd) },
    { id: "equity_change", label: "Equity change", value: formatDayResult(t.equity_change_usd), sub: PRACTICE_COPY.swingTileEquityChange, tone: dayResultTone(t.equity_change_usd) },
    { id: "balance", label: "Balance", value: t.balance_usd == null ? EMPTY_VALUE : formatBalance(t.balance_usd), sub: PRACTICE_COPY.swingTileBalance, tone: "flat" },
    {
      id: "win_rate",
      label: "Win rate",
      value: t.win_rate == null ? EMPTY_VALUE : winRateText(t.win_rate),
      sub: wins ? PRACTICE_COPY.swingTileNoClosed : practiceText("swingTileWinLoss", { win: formatDayResult(t.avg_win_usd), loss: formatDayResult(t.avg_loss_usd) }),
      tone: "flat",
    },
    {
      id: "days_held",
      label: "Average days held",
      value: t.avg_days_held == null ? EMPTY_VALUE : `${t.avg_days_held.toFixed(1)} days`,
      sub: PRACTICE_COPY.swingTileDaysHeld,
      tone: "flat",
    },
    { id: "gap_share", label: "Gap share of P/L", value: share(t.gap_share_pct), sub: gapSub(t), tone: "flat" },
    { id: "adherence", label: "Adherence", value: t.adherence_pct == null ? EMPTY_VALUE : `${Math.round(t.adherence_pct)}%`, sub: PRACTICE_COPY.swingTileAdherence, tone: "flat" },
    { id: "selection", label: "Selection", value: signedPts(t.selection_pts), sub: PRACTICE_COPY.swingTileSelection, tone: ptsTone(t.selection_pts) },
    { id: "timing", label: "Timing", value: signedPts(t.timing_pts), sub: PRACTICE_COPY.swingTileTiming, tone: ptsTone(t.timing_pts) },
    { id: "spy", label: "SPY", value: pct(t.spy_return_pct), sub: PRACTICE_COPY.swingTileSpy, tone: changeTone(t.spy_return_pct) },
    {
      id: "universe",
      label: "Universe, equal weight",
      value: pct(t.universe_mean_return_pct),
      sub: practiceText("swingTileMedian", { median: pct(t.universe_median_return_pct) }),
      tone: changeTone(t.universe_mean_return_pct),
    },
  ];
}

/** "Selection +1.8 pts vs the universe median · your holds ranked 4th, 11th and 23rd of 50 · Timing −0.6 pts": the API's own line. */
export const weekSelectionLine = (review: Pick<WeekReview, "copy">): string | null => review.copy[0] ?? null;

/** The selection line, or the plain reason there is none (no hold, or nothing that could be ranked). */
export function weekSelectionText(review: Pick<WeekReview, "copy" | "holds">): string {
  return weekSelectionLine(review) ?? (review.holds.length === 0 ? PRACTICE_COPY.swingNoHoldsWeek : PRACTICE_COPY.swingNoSelection);
}

// -- equity series ---------------------------------------------------------------------------------------------

export type EquityPoint = {
  dayNo: number;
  /** "D3" */
  label: string;
  /** A stand-in weekday date for the chart's time axis: the real dates stay hidden. */
  t: string;
  balance: number;
  equity: number;
  /** One of this week's days (the shaded stretch). */
  inWeek: boolean;
};

export type EquitySeries = {
  points: EquityPoint[];
  /** Balance per close, aligned with `points`, for an overlay line. */
  balance: number[];
  /** Equity per close, aligned with `points`. */
  equity: number[];
  /** Equity as flat bars (`o = h = l = c`) for a chart that wants bars; `ext` marks this week's days so session shading paints the week. */
  bars: Array<{ t: string; o: number; h: number; l: number; c: number; ext: boolean }>;
  weekFirstDay: number;
  weekLastDay: number;
};

/** Balance and equity at each close from Day 1 through the week's last close, with this week's days flagged. */
export function weekEquitySeries(review: Pick<WeekReview, "equity" | "week">): EquitySeries {
  const days = syntheticDays(review.equity.length);
  const points = review.equity.map((point, index): EquityPoint => ({
    dayNo: point.day_no,
    label: `D${point.day_no}`,
    t: days[index]!,
    balance: point.balance_usd,
    equity: point.equity_usd,
    inWeek: point.day_no >= review.week.first_day_no && point.day_no <= review.week.last_day_no,
  }));
  return {
    points,
    balance: points.map((point) => point.balance),
    equity: points.map((point) => point.equity),
    bars: points.map((point) => ({ t: point.t, o: point.equity, h: point.equity, l: point.equity, c: point.equity, ext: point.inWeek })),
    weekFirstDay: review.week.first_day_no,
    weekLastDay: review.week.last_day_no,
  };
}

// -- days table ------------------------------------------------------------------------------------------------

export type WeekDayRowView = {
  dayNo: number;
  /** "Day 3 · Tue" */
  title: string;
  watched: "Watched" | "Passed";
  entries: string;
  exits: string;
  realized: string;
  realizedTone: Tone;
  gap: string;
  gapTone: Tone;
  intraday: string;
  intradayTone: Tone;
  adherence: string;
};

export function weekDayRows(review: Pick<WeekReview, "days">): WeekDayRowView[] {
  return review.days.map((day) => ({
    dayNo: day.day_no,
    title: practiceText("swingDayShort", { day: day.day_no, weekday: day.weekday }),
    watched: day.watched === "yes" ? "Watched" : "Passed",
    entries: String(day.entries),
    exits: String(day.exits),
    realized: formatDayResult(day.realized_usd),
    realizedTone: dayResultTone(day.realized_usd),
    gap: formatDayResult(day.gap_usd),
    gapTone: dayResultTone(day.gap_usd),
    intraday: formatDayResult(day.intraday_usd),
    intradayTone: dayResultTone(day.intraday_usd),
    adherence: day.adherence_pct == null ? EMPTY_VALUE : `${Math.round(day.adherence_pct)}%`,
  }));
}

// -- holds table -----------------------------------------------------------------------------------------------

const STOP_LABEL: Record<WeekStop, string> = {
  none: "No stop",
  set: "Stop set",
  honored: "Stop honored",
  away: "Crossed while away",
};

export type WeekHoldRowView = {
  holdId: number;
  symbol: string;
  side: string;
  shares: string;
  /** "Day 3 · 184.20" */
  entry: string;
  /** "Day 5 · 190.10", or "open · Fri close" for a hold still open at the week's last close. */
  exit: string;
  held: string;
  pnl: string;
  pnlTone: Tone;
  r: string;
  gap: string;
  stop: string;
  /** A stop crossed while she was away reads amber. */
  stopAway: boolean;
  /** "4th of 50" by side-signed return over the hold's span. */
  rank: string;
  selection: string;
  timing: string;
};

function openExit(review: Pick<WeekReview, "days" | "week">): string {
  const last = review.days.find((day) => day.day_no === review.week.last_day_no);
  return practiceText("swingOpenClose", { weekday: last?.weekday ?? "week" });
}

export function weekHoldRows(review: Pick<WeekReview, "holds" | "days" | "week">): WeekHoldRowView[] {
  return review.holds.map((hold: WeekHold) => ({
    holdId: hold.hold_id,
    symbol: hold.symbol,
    side: hold.side === "long" ? "Long" : "Short",
    shares: hold.shares.toLocaleString("en-US"),
    entry: practiceText("swingEntryLabel", { day: hold.entry_day_no, price: formatPrice(hold.entry_price) }),
    exit:
      hold.status === "closed" && hold.exit_day_no !== null
        ? practiceText("swingEntryLabel", { day: hold.exit_day_no, price: formatPrice(hold.exit_price) })
        : openExit(review),
    held: hold.days_held === 1 ? PRACTICE_COPY.swingDaysHeldOne : practiceText("swingDaysHeld", { n: hold.days_held }),
    pnl: formatDayResult(hold.pnl_usd),
    pnlTone: dayResultTone(hold.pnl_usd),
    r: formatR(hold.r),
    gap: hold.gap_usd == null ? EMPTY_VALUE : formatDayResult(hold.gap_usd),
    stop: STOP_LABEL[hold.stop],
    stopAway: hold.stop === "away",
    rank: hold.selection_rank == null || hold.selection_of == null ? EMPTY_VALUE : practiceText("swingRank", { rank: ordinal(hold.selection_rank), of: hold.selection_of }),
    selection: signedPts(hold.selection_edge_pts),
    timing: signedPts(hold.timing_edge_pts),
  }));
}

// -- heat strip ------------------------------------------------------------------------------------------------

export type HeatKind = "both" | "held" | "focus" | "none";

export type HeatItem = {
  symbol: string;
  source: SwingSource | null;
  sourceLabel: string;
  /** "+3.1%" */
  returnText: string;
  tone: Tone;
  /** `both`: a name she held and had starred; the strip highlights `held` and `both` hardest, then `focus`. */
  kind: HeatKind;
  label: string;
};

const heatKind = (item: Pick<WeekHeat, "held" | "focus">): HeatKind =>
  item.held === "yes" ? (item.focus === "yes" ? "both" : "held") : item.focus === "yes" ? "focus" : "none";

/** The universe's names sorted by week return (best first, ties by symbol), with her holds and focus names flagged. */
export function heatStrip(review: Pick<WeekReview, "heat">): HeatItem[] {
  return [...review.heat]
    .sort((a, b) => b.return_pct - a.return_pct || a.symbol.localeCompare(b.symbol))
    .map((item) => {
      const kind = heatKind(item);
      const returnText = formatSignedPct(item.return_pct, 1);
      const role = kind === "both" ? "held and focus name" : kind === "held" ? "practice hold" : kind === "focus" ? "focus name" : null;
      return {
        symbol: item.symbol,
        source: item.source,
        sourceLabel: item.source === null ? EMPTY_VALUE : sourceLabel(item.source),
        returnText,
        tone: changeTone(item.return_pct),
        kind,
        label: [item.symbol, returnText, role].filter((part) => part !== null).join(", "),
      };
    });
}

// -- adherence and quality lines ----------------------------------------------------------------------------------

export type CheckView = { id: WeekCheck["id"]; label: string; detail: string; state: "pass" | "fail" | "na" };

/** The week's checklist: a check that did not apply is "na", never a pass. */
export const weekChecks = (review: Pick<WeekReview, "adherence">): CheckView[] =>
  review.adherence.checks.map((check) => ({
    id: check.id,
    label: check.label,
    detail: check.detail,
    state: !check.applicable ? "na" : check.passed ? "pass" : "fail",
  }));

/** "Names your filters flagged (6): median +1.2% vs universe median +0.4% · edge +0.8 pts"; null when none were flagged. */
export function filterQualityLine(quality: WeekReview["filter_quality"]): string | null {
  if (!quality) return null;
  return practiceText("swingFilterQuality", {
    n: quality.n,
    median: formatSignedPct(quality.median_return_pct, 1),
    universe: formatSignedPct(quality.universe_median_pct, 1),
    edge: signedPts(quality.edge_pts),
  });
}

/** "Watchlist +1.4% · liquidity +0.3%": the median week return by where the name came from. Null with none. */
export function sourceQualityLine(items: WeekReview["source_quality"]): string | null {
  if (items.length === 0) return null;
  return items
    .map((item, index) => {
      const label = sourceLabel(item.source);
      return `${index === 0 ? label : label.toLowerCase()} ${formatSignedPct(item.median_return_pct, 1)}`;
    })
    .join(" · ");
}

/** "NVDA would have ranked 7th of 50 (+3.1%)" for each starred name she never held. */
export const focusUntradedLines = (items: WeekReview["focus_untraded"]): string[] =>
  items.map((item) => practiceText("swingFocusUntraded", { symbol: item.symbol, rank: ordinal(item.rank), of: item.of, ret: formatSignedPct(item.return_pct, 1) }));

// -- the thread's week table -------------------------------------------------------------------------------------

export type WeekRowView = {
  weekNo: number;
  label: string;
  /** "4 days" */
  days: string;
  status: "Final" | "Week to date";
  realized: string;
  realizedTone: Tone;
  equityChange: string;
  equityChangeTone: Tone;
  adherence: string;
  selection: string;
  timing: string;
};

export function weekRowView(row: WeekRow): WeekRowView {
  return {
    weekNo: row.week_no,
    label: row.label,
    days: `${row.days} ${row.days === 1 ? "day" : "days"}`,
    status: row.status === "closed" ? PRACTICE_COPY.swingWeekFinal : "Week to date",
    realized: formatDayResult(row.realized_usd),
    realizedTone: dayResultTone(row.realized_usd),
    equityChange: formatDayResult(row.equity_change_usd),
    equityChangeTone: dayResultTone(row.equity_change_usd),
    adherence: row.adherence_pct == null ? EMPTY_VALUE : `${Math.round(row.adherence_pct)}%`,
    selection: signedPts(row.selection_pts),
    timing: signedPts(row.timing_pts),
  };
}

/** A week row links to its review once a day of it has ended (an open week with no ended day answers 404). */
export const weekReviewable = (row: Pick<WeekRow, "status" | "first_day_no">, daysEnded: number): boolean => row.status === "closed" || daysEnded >= row.first_day_no;
