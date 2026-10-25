import { EMPTY_VALUE, type Tone } from "../desk/format.ts";
import { PRACTICE_COPY, practiceText } from "../desk/freshness.ts";
import { moneyTone, tradesCountText } from "./journalView.ts";
import type { PracticeThread, Thread, ThreadBrief, ThreadDay, ThreadToday } from "./threads.ts";

// View logic of the practice-thread screens (02r): money text, the thread card, the weeks of the journal, the improvement
// panel and its too-few-days caveat, and the summary tiles. Every dollar figure is SIMULATED. Dates stay hidden: a day is
// "D3" and a weekday, never a calendar date.

const MINUS = "−";
const ET = "America/New_York";
/** A trend needs this many weeks, each with this many practice days, before a comparison is called a trend. */
export const TREND_WEEKS = 2;
export const TREND_DAYS_PER_WEEK = 3;

const cents = (value: number) => Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const whole = (value: number) => Math.abs(Math.round(value)).toLocaleString("en-US");

// One money rule (D-044): every dollar figure is dollars and cents, so the journal, the hub and the trade lines
// agree to the cent. Only an axis tick may drop the cents (`formatAxisDollars`).

/** "$50,123.40": a balance, dollars and cents. */
export function formatBalance(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return EMPTY_VALUE;
  const text = cents(value);
  return `${value < 0 && Number(text.replaceAll(",", "")) !== 0 ? MINUS : ""}$${text}`;
}

/** "+$1,565.00" / "−$246.60" / "$0.00": a day's result or the change in a balance; the sign is the cue. */
export function formatDayResult(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return EMPTY_VALUE;
  if (Number(cents(value).replaceAll(",", "")) === 0) return "$0.00";
  return `${value > 0 ? "+" : MINUS}$${cents(value)}`;
}

/** "$50,000": an amount she chose (starting balance, max loss), whole dollars; a figure the ledger produced uses `formatBalance`. */
export const formatWhole = (value: number): string => `${value < 0 ? MINUS : ""}$${whole(value)}`;

/** "$50,123" / "+$1,565" / "−$247": an axis tick, whole dollars (a scale, not a figure to read to the cent). */
export function formatAxisDollars(value: number, signed = false): string {
  const rounded = Math.round(value);
  if (rounded === 0) return "$0";
  return `${rounded < 0 ? MINUS : signed ? "+" : ""}$${whole(value)}`;
}

export const dayResultTone = (value: number | null | undefined): Tone => moneyTone(value);

export const threadModeLabel = (mode: PracticeThread["mode"]): string => (mode === "day" ? "Day trading" : "Swing");

const monthName = new Intl.DateTimeFormat("en-US", { timeZone: ET, month: "long" });
const monthDay = new Intl.DateTimeFormat("en-US", { timeZone: ET, month: "short", day: "numeric" });

/** "October thread": the month it was started (the thread has no name of its own). */
export const threadName = (thread: Pick<PracticeThread, "createdAt">): string => `${monthName.format(new Date(thread.createdAt))} thread`;

/** "Started Oct 25": the day she started it (not a replayed day, so no date is spoiled). */
export const threadStartedText = (thread: Pick<PracticeThread, "createdAt">): string => `Started ${monthDay.format(new Date(thread.createdAt))}`;

/** "Started with $50,000 · +$123 so far". */
export function startedWithText(thread: Pick<PracticeThread, "startingBalance" | "stats">): string {
  const change = thread.stats.balance - thread.startingBalance;
  const start = formatWhole(thread.startingBalance);
  return Math.round(change) === 0
    ? practiceText("threadStartedFlat", { start })
    : practiceText("threadStartedWith", { start, change: formatDayResult(change) });
}

/** "64%" from a 0..1 share, or a dash with no closed trade. */
export const winRateText = (rate: number | undefined): string => (rate === undefined ? EMPTY_VALUE : `${Math.round(rate * 100)}%`);

/** "71% → 83%": the first and the latest scored day; one value alone, or a dash. */
export function adherenceTrendText(stats: Pick<PracticeThread["stats"], "adherenceFirstPct" | "adherenceLastPct">): string {
  const { adherenceFirstPct: first, adherenceLastPct: last } = stats;
  if (first === undefined && last === undefined) return EMPTY_VALUE;
  if (first === undefined || last === undefined || first === last) return `${last ?? first}%`;
  return `${first}% → ${last}%`;
}

/** "+$112 realized so far · 1 practice trade", or the plain "no day open" line. */
export function todayLine(today: ThreadToday | null): string {
  if (today === null) return PRACTICE_COPY.threadNoToday;
  return practiceText("threadTodayLine", { pnl: formatDayResult(today.pnl_usd), trades: tradesCountText(today.trades) });
}

/** "+$1,565 realized · 1 practice trade", or the skipped-day line: the last ended day, read from the ledger's day series. */
export function lastDayLine(day: Pick<ThreadDay, "kind" | "pnl_usd" | "trades">): string {
  if (day.kind === "skipped") return PRACTICE_COPY.threadLastDaySkipped;
  return practiceText("threadLastDayLine", { pnl: formatDayResult(day.pnl_usd), trades: tradesCountText(day.trades) });
}

/** What the thread card's TODAY row says: its label, the line, and the signed amount to color (null for none).
 *  The practice day under way reads "so far" once practice has started or booked a trade. A day that is only listed has
 *  nothing realized, so the row shows the last ended day instead of a $0 beside a balance that already moved (D-030): the
 *  same ledger rows as the balance and the journal. */
export function todayView(today: ThreadToday | null, lastDay: ThreadDay | null): { label: string; line: string; pnl: number | null } {
  if (today !== null && (today.status === "practicing" || today.trades > 0 || lastDay === null)) {
    return { label: PRACTICE_COPY.threadToday, line: todayLine(today), pnl: today.pnl_usd };
  }
  if (lastDay !== null) {
    return { label: PRACTICE_COPY.threadLastDay, line: lastDayLine(lastDay), pnl: lastDay.kind === "practiced" ? lastDay.pnl_usd : null };
  }
  return { label: PRACTICE_COPY.threadToday, line: todayLine(null), pnl: null };
}

/** The header strip of a day screen or the workspace: "Thread balance $50,123 · today +$112". */
export function briefLine(brief: Pick<ThreadBrief, "balance" | "today_pnl_usd">): string {
  const balance = practiceText("threadBalanceLine", { balance: formatBalance(brief.balance) });
  return brief.today_pnl_usd === null ? balance : `${balance} · ${practiceText("threadTodayShort", { pnl: formatDayResult(brief.today_pnl_usd) })}`;
}

/** "4 weeks in", "first week". */
export const weeksInText = (count: number): string => (count <= 1 ? "first week" : `${count} weeks in`);

// ---- weeks -----------------------------------------------------------------------------------------------------------

export type Week = {
  /** 1-based, in the order she practised. */
  n: number;
  label: string;
  /** "2 days practiced" or "1 day practiced · 1 skipped". */
  detail: string;
  days: ThreadDay[];
  practiced: number;
  skipped: number;
  /** Sum of the days' results. */
  pnl: number;
  /** Days that won (a practised day with a positive result). */
  won: number;
  /** Mean of the days' scores; null when no day was scored. */
  adherencePct: number | null;
  latest: boolean;
};

const mondayOf = (day: string): string => {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
};

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
/** "2 practice days", "1 practice day", "no practice days". */
const practiceDays = (count: number) => (count === 0 ? "no practice days" : plural(count, "practice day"));

/** The ended days grouped by calendar week of the replayed day, in the order she practised them. */
export function weeksOf(daily: readonly ThreadDay[]): Week[] {
  const groups: ThreadDay[][] = [];
  let key = "";
  for (const day of daily) {
    const monday = mondayOf(day.day);
    if (monday !== key) groups.push([]);
    key = monday;
    groups[groups.length - 1]!.push(day);
  }
  return groups.map((days, index) => {
    const practicedDays = days.filter((day) => day.kind === "practiced");
    const skipped = days.length - practicedDays.length;
    const scores = practicedDays.map((day) => day.adherence_pct).filter((score): score is number => score !== null);
    const latest = index === groups.length - 1;
    return {
      n: index + 1,
      label: `Week ${index + 1}${latest && groups.length > 1 ? " · latest" : ""}`,
      detail: [practicedDays.length > 0 ? `${plural(practicedDays.length, "day")} practiced` : "no day practiced", skipped > 0 ? `${skipped} skipped` : null].filter(Boolean).join(" · "),
      days,
      practiced: practicedDays.length,
      skipped,
      pnl: days.reduce((sum, day) => sum + day.pnl_usd, 0),
      won: practicedDays.filter((day) => day.pnl_usd > 0).length,
      adherencePct: scores.length === 0 ? null : Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length),
      latest,
    };
  });
}

// ---- improvement -------------------------------------------------------------------------------------------------------

export type ImprovementRow = { id: string; label: string; first: string; latest: string };
export type Improvement = {
  /** The first week and the latest week, with their rows; null with fewer than two weeks. */
  compared: { first: Week; latest: Week; intro: string; rows: ImprovementRow[] } | null;
  /** True when at least `TREND_WEEKS` weeks each have `TREND_DAYS_PER_WEEK` or more practice days. */
  trend: boolean;
  /** The honest caveat while `trend` is false; null otherwise. */
  caveat: { title: string; reason: string } | null;
  /** One neutral sentence of fact once there is a trend; never advice, never a promise. */
  verdict: string | null;
};

const perDay = (week: Week) => (week.practiced === 0 ? null : week.pnl / week.practiced);

/** First week against the latest week, and whether there are enough days to call the comparison a trend. */
export function improvementOf(weeks: readonly Week[]): Improvement {
  const full = weeks.filter((week) => week.practiced >= TREND_DAYS_PER_WEEK);
  const trend = full.length >= TREND_WEEKS;
  const first = weeks[0];
  const latest = weeks.length > 1 ? weeks[weeks.length - 1] : undefined;
  const compared =
    first && latest
      ? {
          first,
          latest,
          intro: practiceText("improvementIntro", { n: latest.n, days: practiceDays(latest.practiced) }),
          rows: [
            { id: "result", label: "Day results", first: formatDayResult(first.pnl), latest: formatDayResult(latest.pnl) },
            { id: "won", label: "Days won", first: `${first.won} of ${first.practiced}`, latest: `${latest.won} of ${latest.practiced}` },
            { id: "adherence", label: "Adherence", first: first.adherencePct === null ? EMPTY_VALUE : `${first.adherencePct}%`, latest: latest.adherencePct === null ? EMPTY_VALUE : `${latest.adherencePct}%` },
            { id: "practiced", label: "Days practiced", first: String(first.practiced), latest: String(latest.practiced) },
          ],
        }
      : null;
  if (!trend) {
    // One week alone still gets the plain count and the threshold; with no week at all, only the rule.
    const newest = weeks[weeks.length - 1];
    const reason = newest ? practiceText("improvementReason", { n: newest.n, days: practiceDays(newest.practiced) }) : PRACTICE_COPY.improvementReasonOneWeek;
    return { compared, trend, caveat: { title: PRACTICE_COPY.improvementTooFew, reason }, verdict: null };
  }
  const firstFull = full[0]!;
  const latestFull = full[full.length - 1]!;
  const a = perDay(firstFull)!;
  const b = perDay(latestFull)!;
  return {
    compared,
    trend,
    caveat: null,
    verdict: practiceText("improvementVerdict", { latest: latestFull.n, latestAvg: formatDayResult(b), first: firstFull.n, firstAvg: formatDayResult(a) }),
  };
}

// ---- tiles -------------------------------------------------------------------------------------------------------------

export type ThreadTile = { id: string; label: string; value: string; sub: string; tone: Tone };

const dayNumberOf = (daily: readonly ThreadDay[], result: number | undefined): string => {
  const row = result === undefined ? undefined : daily.find((day) => day.kind === "practiced" && day.pnl_usd === result);
  return row ? `day ${row.n}` : EMPTY_VALUE;
};

/** The worst day is the lowest result, which is a gain while no day has lost (D-045): the tile then says so. */
const worstSub = (daily: readonly ThreadDay[], worst: number | undefined): string => {
  const day = dayNumberOf(daily, worst);
  return worst !== undefined && worst >= 0 ? `${day} · no losing day` : day;
};

/** The ten tiles of "Summary so far". Wins and losses count practice trades; today's day is still open and not counted. */
export function threadTiles(thread: Pick<Thread, "thread" | "daily">): ThreadTile[] {
  const { stats } = thread.thread;
  const closedTrades = stats.wins + stats.losses;
  return [
    { id: "practiced", label: "Days practiced", value: String(stats.daysPracticed), sub: practiceText("threadTileOpened", { n: stats.daysPracticed + stats.daysSkipped }), tone: "flat" },
    { id: "skipped", label: "Skipped", value: String(stats.daysSkipped), sub: PRACTICE_COPY.threadTileCarried, tone: "flat" },
    { id: "wins", label: "Wins", value: String(stats.wins), sub: PRACTICE_COPY.threadTileTrades, tone: "flat" },
    { id: "losses", label: "Losses", value: String(stats.losses), sub: PRACTICE_COPY.threadTileTrades, tone: "flat" },
    { id: "win_rate", label: "Win rate", value: winRateText(stats.winRate), sub: closedTrades === 0 ? PRACTICE_COPY.threadTileNoTrades : practiceText("threadTileOfTrades", { wins: stats.wins, trades: closedTrades }), tone: "flat" },
    { id: "avg_win", label: "Avg win", value: formatDayResult(stats.avgWinUsd), sub: PRACTICE_COPY.threadTilePerWin, tone: dayResultTone(stats.avgWinUsd) },
    { id: "avg_loss", label: "Avg loss", value: formatDayResult(stats.avgLossUsd), sub: PRACTICE_COPY.threadTilePerLoss, tone: dayResultTone(stats.avgLossUsd) },
    { id: "best", label: "Best day", value: formatDayResult(stats.bestDayUsd), sub: dayNumberOf(thread.daily, stats.bestDayUsd), tone: dayResultTone(stats.bestDayUsd) },
    { id: "worst", label: "Worst day", value: formatDayResult(stats.worstDayUsd), sub: worstSub(thread.daily, stats.worstDayUsd), tone: dayResultTone(stats.worstDayUsd) },
    { id: "adherence", label: "Adherence trend", value: adherenceTrendText(stats), sub: PRACTICE_COPY.threadTileAdherenceBy, tone: "flat" },
  ];
}

/** True while the thread has no ended day: nothing to chart yet. */
export const hasNoDays = (thread: Pick<Thread, "daily">): boolean => thread.daily.length === 0;

/** The plan as plain rows for the recap: label and value. A limit left unset is "None". The thread plan holds no share count (she sizes each entry), so that row says so. */
export function planRows(plan: PracticeThread["plan"]): Array<{ id: string; label: string; value: string }> {
  return [
    { id: "shares", label: PRACTICE_COPY.threadShares, value: PRACTICE_COPY.threadSharesPerEntry },
    { id: "stop", label: "Stop on every entry", value: plan.stopNoteOnEntry === "yes" ? "Yes" : "No" },
    { id: "signal", label: "Trade only on a signal", value: plan.tradeOnlyOnSignal === "yes" ? "Yes" : "No" },
    { id: "max_loss", label: "Max loss, pretend dollars a day", value: plan.maxLossUsd === undefined ? "None" : formatWhole(plan.maxLossUsd) },
    { id: "max_trades", label: "Max trades a day", value: plan.maxTrades === undefined ? "None" : String(plan.maxTrades) },
  ];
}
