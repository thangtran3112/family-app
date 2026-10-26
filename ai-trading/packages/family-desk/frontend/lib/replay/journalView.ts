import { formatEtTime, formatNumber, formatPrice, formatPct, EMPTY_VALUE, type Tone } from "../desk/format.ts";
import { practiceText, PRACTICE_COPY } from "../desk/freshness.ts";
import type { JournalTrade, ReplayJournal, SignalVsTrade } from "./schemas.ts";
import { swingDayTitle } from "./swing.ts";
import type { SwingDayList } from "./swingApi.ts";

// Journal screen view logic (02o §a4, §c5): money and R formatting, the summary tiles, and the honest empty states.

const MINUS = "−";

/** "+$63.00" / "−$42.00" / "$0.00": the sign is the cue, colour is secondary. */
export function formatUsd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return EMPTY_VALUE;
  const text = Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (Number(text.replaceAll(",", "")) === 0) return `$${text}`;
  return `${value > 0 ? "+" : MINUS}$${text}`;
}

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
    { id: "pnl", label: "Practice P/L", value: formatUsd(totals.pnl_usd), tone: moneyTone(totals.pnl_usd) },
    { id: "r", label: "Total R", value: none ? EMPTY_VALUE : formatR(totals.r_total), tone: none ? "flat" : moneyTone(totals.r_total) },
    { id: "trades", label: "Trades", value: String(totals.trades), tone: "flat" },
    { id: "win_rate", label: "Win rate", value: totals.win_rate == null ? EMPTY_VALUE : formatPct(totals.win_rate * 100, 0), tone: "flat" },
    { id: "avg_win", label: "Average win", value: formatUsd(totals.avg_win_usd), tone: moneyTone(totals.avg_win_usd) },
    { id: "avg_loss", label: "Average loss", value: formatUsd(totals.avg_loss_usd), tone: moneyTone(totals.avg_loss_usd) },
    { id: "largest_loss", label: "Largest loss", value: formatUsd(totals.largest_loss_usd), tone: moneyTone(totals.largest_loss_usd) },
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
    exit: `${formatEtTime(trade.exit_at)} · ${formatPrice(trade.exit_price)}${trade.exit_source === "auto" ? " (auto, window end)" : ""}`,
    shares: formatNumber(trade.shares, 0),
    pnl: formatUsd(trade.pnl_usd),
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

/** "No practice trades this session · 3 signals would have fired" or without the signal count when there were none. */
export function noTradesText(signalCount: number): string {
  if (signalCount === 0) return PRACTICE_COPY.noTradesJournal;
  return practiceText("noTradesJournalSignals", { signals: `${signalCount} signal${signalCount === 1 ? "" : "s"}` });
}

export const tradesCountText = (count: number): string => `${count} practice trade${count === 1 ? "" : "s"}`;

/** "Session over · 3 practice trades · See journal". */
export const sessionOverText = (tradeCount: number): string => practiceText("sessionOver", { trades: tradesCountText(tradeCount) });

/**
 * Whether the journal masks the session's date. An open session always does. An ended one reveals it (nothing is left to
 * spoil) unless it belongs to a swing thread that is still going: a swing day ending does not end the thread, and one
 * date gives every later day's date.
 */
export function journalDatesHidden(session: { status: string; spec: { hideDate: "yes" | "no" }; thread: { mode: string; status: string } | null }): boolean {
  if (session.spec.hideDate !== "yes") return false;
  return session.status !== "ended" || (session.thread?.mode === "swing" && session.thread.status === "active");
}

/** "Day 3 of 15 · Week 1 · Wed" for a swing session's journal while dates are hidden; "Hidden day" until the day list answers. */
export const swingJournalDay = (list: Pick<SwingDayList, "day_no" | "of" | "week_no" | "weekday" | "day"> | null): string =>
  list === null ? PRACTICE_COPY.hiddenDay : swingDayTitle(list, true);
