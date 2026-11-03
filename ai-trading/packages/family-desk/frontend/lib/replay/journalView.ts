import { formatEtDay, formatEtTime, formatNumber, formatPrice, formatPct, EMPTY_VALUE, type Tone } from "../desk/format.ts";
import { practiceText, PRACTICE_COPY } from "../desk/freshness.ts";
import { formatSignedUsd } from "../desk/mask.ts";
import type { JournalTrade, ReplayJournal, SignalVsTrade } from "./schemas.ts";
import type { PracticeThread, Thread } from "./threads.ts";

// Journal screen view logic (02o §a4, §c5; ADR-0025): money (mask.ts formatSignedUsd with cents) and R formatting, the summary tiles, and the honest
// empty states. The journal is read LIVE: a lane's journal is computed on read and is never final, and the thread's is its ledger grouped by ET date
// (a label and a grouping key; nothing ends, resets or reviews at a date).

const MINUS = "−";

/** "+1.21R" / "−0.40R". */
export function formatR(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return EMPTY_VALUE;
  const text = Math.abs(value).toFixed(2);
  return Number(text) === 0 ? `${text}R` : `${value > 0 ? "+" : MINUS}${text}R`;
}

export const moneyTone = (value: number | null | undefined): Tone => (value == null || !Number.isFinite(value) || value === 0 ? "flat" : value > 0 ? "up" : "down");

export type SummaryTile = { id: string; label: string; value: string; tone: Tone };

export function summaryTiles(journal: ReplayJournal): SummaryTile[] {
  const { totals, adherence } = journal;
  const none = totals.trades === 0;
  return [
    { id: "pnl", label: "Practice P/L", value: formatSignedUsd(totals.pnl_usd, { cents: true }), tone: moneyTone(totals.pnl_usd) },
    { id: "r", label: "Total R", value: none ? EMPTY_VALUE : formatR(totals.r_total), tone: none ? "flat" : moneyTone(totals.r_total) },
    { id: "trades", label: "Trades", value: String(totals.trades), tone: "flat" },
    { id: "win_rate", label: "Win rate", value: totals.win_rate == null ? EMPTY_VALUE : formatPct(totals.win_rate * 100, 0), tone: "flat" },
    { id: "avg_win", label: "Average win", value: formatSignedUsd(totals.avg_win_usd, { cents: true }), tone: moneyTone(totals.avg_win_usd) },
    { id: "avg_loss", label: "Average loss", value: formatSignedUsd(totals.avg_loss_usd, { cents: true }), tone: moneyTone(totals.avg_loss_usd) },
    { id: "largest_loss", label: "Largest loss", value: formatSignedUsd(totals.largest_loss_usd, { cents: true }), tone: moneyTone(totals.largest_loss_usd) },
    { id: "adherence", label: "Adherence", value: adherence.score_pct == null ? EMPTY_VALUE : `${adherence.score_pct}%`, tone: "flat" },
  ];
}

/** Under the adherence tile: the API's hint, else the plan hint when no check applies. */
export const adherenceHint = (journal: ReplayJournal): string | null =>
  journal.adherence.score_pct == null ? (journal.adherence.hint ?? PRACTICE_COPY.adherenceHint) : null;

export type TradeRow = {
  no: number;
  side: string;
  entry: string;
  exit: string;
  shares: string;
  pnl: string;
  pnlTone: Tone;
  r: string;
  stop: string;
  onSignal: string;
};

export function tradeRows(trades: readonly JournalTrade[]): TradeRow[] {
  return trades.map((trade) => ({
    no: trade.no,
    side: trade.side === "long" ? "Long" : "Short",
    entry: `${formatEtTime(trade.entry_at)} · ${formatPrice(trade.entry_price)}`,
    exit: `${formatEtTime(trade.exit_at)} · ${formatPrice(trade.exit_price)}${trade.exit_source === "auto" ? " (auto)" : ""}`,
    shares: formatNumber(trade.shares, 0),
    pnl: formatSignedUsd(trade.pnl_usd, { cents: true }),
    pnlTone: moneyTone(trade.pnl_usd),
    r: formatR(trade.r),
    stop: trade.stop_price == null ? "none" : formatPrice(trade.stop_price),
    onSignal: trade.on_signal ? "Yes" : "No",
  }));
}

export type SignalRow = { key: string; time: string; name: string; close: string; chg15: string; chg30: string; chg15Tone: Tone; chg30Tone: Tone; her: string };

const changeText = (value: number | null) => (value == null ? EMPTY_VALUE : `${value > 0 ? "+" : value < 0 ? MINUS : ""}${Math.abs(value).toFixed(2)}%`);

export function signalRows(rows: readonly SignalVsTrade[]): SignalRow[] {
  return rows.map((row, index) => ({
    key: `${row.time}:${row.name}:${index}`,
    time: formatEtTime(row.time),
    name: row.name,
    close: formatPrice(row.close),
    chg15: changeText(row.chg_15m_pct),
    chg30: changeText(row.chg_30m_pct),
    chg15Tone: moneyTone(row.chg_15m_pct),
    chg30Tone: moneyTone(row.chg_30m_pct),
    her: row.her,
  }));
}

/** "No practice trades on this name yet · 3 signals would have fired" or without the signal count when there were none. */
export function noTradesText(signalCount: number): string {
  if (signalCount === 0) return PRACTICE_COPY.journalNoTrades;
  return practiceText("journalNoTradesSignals", { signals: `${signalCount} signal${signalCount === 1 ? "" : "s"}` });
}

export const tradesCountText = (count: number): string => `${count} practice trade${count === 1 ? "" : "s"}`;

// ---- the thread's journal, by ET date --------------------------------------------------------------------------------

/** "Wed 2026-03-11": an ET calendar date as the journal names it. */
export const dateLabel = formatEtDay;

/** "03-11": the short form an axis label uses. */
export const shortDate = (day: string): string => day.slice(5);

export type ThreadTile = { id: string; label: string; value: string; sub: string; tone: Tone };

/** "64%" from a 0..1 share, or a dash with no closed trade. */
const winRate = (rate: number | undefined): string => (rate === undefined ? EMPTY_VALUE : `${Math.round(rate * 100)}%`);

const dateOf = (daily: Thread["daily"], result: number | undefined): string => {
  const row = result === undefined ? undefined : daily.find((entry) => entry.pnl_usd === result);
  return row ? dateLabel(row.day) : EMPTY_VALUE;
};

/** The eight tiles of "Summary so far". Wins and losses count closed practice trades: an open position is not in them until it is closed. */
export function threadTiles(thread: Pick<Thread, "thread" | "daily">): ThreadTile[] {
  const { stats } = thread.thread;
  const closedTrades = stats.wins + stats.losses;
  const money = (value: number | undefined): string => formatSignedUsd(value ?? null, { cents: true });
  const worstDate = dateOf(thread.daily, stats.worstDayUsd);
  return [
    { id: "dates", label: "ET dates traded", value: String(stats.daysPracticed), sub: PRACTICE_COPY.journalTileDates, tone: "flat" },
    { id: "wins", label: "Wins", value: String(stats.wins), sub: PRACTICE_COPY.threadTileTrades, tone: "flat" },
    { id: "losses", label: "Losses", value: String(stats.losses), sub: PRACTICE_COPY.threadTileTrades, tone: "flat" },
    { id: "win_rate", label: "Win rate", value: winRate(stats.winRate), sub: closedTrades === 0 ? PRACTICE_COPY.threadTileNoTrades : practiceText("threadTileOfTrades", { wins: stats.wins, trades: closedTrades }), tone: "flat" },
    { id: "avg_win", label: "Avg win", value: money(stats.avgWinUsd), sub: PRACTICE_COPY.threadTilePerWin, tone: moneyTone(stats.avgWinUsd) },
    { id: "avg_loss", label: "Avg loss", value: money(stats.avgLossUsd), sub: PRACTICE_COPY.threadTilePerLoss, tone: moneyTone(stats.avgLossUsd) },
    { id: "best", label: "Best date", value: money(stats.bestDayUsd), sub: dateOf(thread.daily, stats.bestDayUsd), tone: moneyTone(stats.bestDayUsd) },
    // The worst date is the lowest result, which is a gain while no date has lost: the tile then says so.
    { id: "worst", label: "Worst date", value: money(stats.worstDayUsd), sub: stats.worstDayUsd !== undefined && stats.worstDayUsd >= 0 ? practiceText("journalTileNoLoss", { date: worstDate }) : worstDate, tone: moneyTone(stats.worstDayUsd) },
  ];
}

/** True while the thread has realized no trade: nothing to chart yet. */
export const hasNoTrades = (thread: Pick<Thread, "daily">): boolean => thread.daily.length === 0;

/** "3 open positions", "1 open position". */
export const openPositionsText = (count: number): string => `${count} open position${count === 1 ? "" : "s"}`;

/** The plan as plain rows for the recap: label and value. The two limits are optional rules counted per ET date; the entry size is the shares a ticket opens at, or "Not set". */
export function planRows(plan: PracticeThread["plan"], shares?: number): Array<{ id: string; label: string; value: string }> {
  return [
    { id: "shares", label: PRACTICE_COPY.threadShares, value: shares === undefined ? PRACTICE_COPY.threadSharesNotSet : formatNumber(shares, 0) },
    { id: "signal", label: "Trade only on a signal", value: plan.tradeOnlyOnSignal === "yes" ? "Yes" : "No" },
    { id: "max_loss", label: PRACTICE_COPY.journalMaxLossRow, value: plan.maxLossUsd === undefined ? "None" : `$${plan.maxLossUsd.toLocaleString("en-US")}` },
    { id: "max_trades", label: PRACTICE_COPY.journalMaxTradesRow, value: plan.maxTrades === undefined ? "None" : String(plan.maxTrades) },
  ];
}
