import type {
  DailyBar,
  DailyBlock,
  Hold,
  IndicatorBar,
  Indicators,
  Market,
  OpenTrade,
  Paused,
  ReplayBar,
  ReplayDelta,
  ReplayFeed,
  ReplayInterval,
  ReplayLevels,
  ReplayPace,
  ReplaySignal,
  StripRow,
  TapeFeed,
} from "./schemas.ts";
import { inRegularWindow } from "../indicators.ts";
import { ms } from "./time.ts";

// What the browser holds of a replay: only what the server has revealed. This module merges `feed` and
// `advance` answers; it never slices, trims, or filters by the playhead (the server owns the reveal boundary,
// 02o decision 1). The only cut is the tape's display cap, which keeps the newest rows.

export const TAPE_CAP = 500;
export const PACE_WINDOW_S = 10;
export const QUIET_AFTER_S = 30;

export type TapeRow = { t: string; price: number; size: number; tick: -1 | 0 | 1 };
export type TapeMeta = { feed: TapeFeed; count: number; volume: number; shown: number; bigPrintUsd: number | null; pace: ReplayPace | null };
/** One advance: the playhead span it covered and the prints it carried. */
export type PaceSample = { fromMs: number; toMs: number; count: number; volume: number };

/** The server's indicator rows, one per bar open (a closed bar, or the forming candle), oldest first. */
export type IndicatorTable = { interval: ReplayInterval; asOfBar: string | null; rows: IndicatorBar[] };

export type ReplayView = {
  interval: ReplayInterval;
  /** Closed display bars (lookback plus the revealed window), oldest first, one per start time. */
  bars: ReplayBar[];
  forming: Omit<ReplayBar, "ext"> | null;
  /** Start of the replay window inside `bars` (the lookback sits before it); null when the feed omitted it. */
  windowStart: string | null;
  tape: TapeRow[];
  tapeMeta: TapeMeta | null;
  paceSamples: PaceSample[];
  signals: ReplaySignal[];
  levels: ReplayLevels;
  last: { price: number; at: string } | null;
  /** Seconds with no eligible print once that passes a minute (the server's tape marker); null while prints flow. */
  quietS: number | null;
  openTrade: OpenTrade | null;
  revealedThrough: string;
  /** The thread's own time T from this payload (ADR-0022): uncapped, never extrapolated by the server. Null for a standalone or swing session. */
  threadTime: string | null;
  /** How far this payload's data runs: `min(T, tape end)` for an open day-thread name, the playhead for every other session. */
  dataThrough: string;
  /** The exchange at T (a day thread's payloads): the phase, the day's tape end, this name's last bar and when the next day's data starts. */
  market: Market | null;
  /** The server's EMA 9/21, VWAP, RSI and MACD for the bars held (and the forming candle), from the same cut as the price: the chart and the left rail read these. */
  indicators: IndicatorTable | null;
  /** The day list's shared clock (null for a standalone session) and whether this name's playhead is behind it. */
  dayClock: string | null;
  behindClock: boolean;
  /** The thread clock runs on the server right now (ADR-0018). False when it is paused, at the close, or this is not a day thread. */
  clockRunning: boolean;
  /** Market seconds per wall second while it runs (1 when it does not). */
  clockSpeed: number;
  atEnd: boolean;
  /** Swing only (null for a day session): the day strip at the day clock, the latest answer wins. */
  strip: StripRow[] | null;
  /** Swing only: the Daily chart's bars through the prior close and this name's hold marker (a feed answer). */
  daily: DailyBlock | null;
  /** Swing only: the forming day candle, the latest answer wins. */
  dailyForming: DailyBar | null;
  /** Swing only: the stop that paused the last advance, kept for the toast until she dismisses it or the next advance. */
  paused: Paused | null;
};

/** Indicator rows keyed by bar open: a later answer replaces the same bar, new bars append, order stays ascending. */
function mergeIndicators(existing: IndicatorTable | null, incoming: Indicators | null | undefined): IndicatorTable | null {
  if (incoming == null) return existing;
  const kept = existing !== null && existing.interval === incoming.interval ? existing.rows : [];
  const byTime = new Map<number, IndicatorBar>(kept.map((row) => [ms(row.t), row]));
  for (const row of incoming.rows) byTime.set(ms(row.t), row);
  return { interval: incoming.interval, asOfBar: incoming.as_of_bar, rows: [...byTime.entries()].sort(([a], [b]) => a - b).map(([, row]) => row) };
}

/**
 * The one time a name's screen shows: the payload's own thread time T. A swing or standalone session has no T, so its time is its playhead, or the
 * day list's shared clock when a name was left behind it (the thread's time, not that name's older playhead).
 */
export const viewClock = (view: Pick<ReplayView, "threadTime" | "revealedThrough" | "dayClock">): string =>
  view.threadTime ?? (view.dayClock !== null && ms(view.dayClock) > ms(view.revealedThrough) ? view.dayClock : view.revealedThrough);

const toRow = ([t, price, size, tick]: ReplayDelta["prints"]["rows"][number]): TapeRow => ({ t, price, size, tick });

function tapeMetaOf(prints: ReplayDelta["prints"]): TapeMeta {
  return {
    feed: prints.feed,
    count: prints.count,
    volume: prints.volume,
    shown: prints.shown,
    bigPrintUsd: prints.big_print_usd ?? null,
    pace: prints.pace ?? null,
  };
}

/** Bars keyed by start time: a later answer replaces the same bar, new bars append, order stays ascending. */
export function mergeBars(existing: readonly ReplayBar[], incoming: readonly ReplayBar[]): ReplayBar[] {
  if (incoming.length === 0) return existing as ReplayBar[];
  const byTime = new Map<number, ReplayBar>();
  for (const bar of existing) byTime.set(ms(bar.t), bar);
  for (const bar of incoming) byTime.set(ms(bar.t), bar);
  return [...byTime.entries()].sort(([a], [b]) => a - b).map(([, bar]) => bar);
}

function mergeSignals(existing: readonly ReplaySignal[], incoming: readonly ReplaySignal[]): ReplaySignal[] {
  const key = (signal: ReplaySignal) => `${signal.source}:${signal.id}:${signal.bar_time}`;
  const seen = new Map(existing.map((signal) => [key(signal), signal]));
  for (const signal of incoming) seen.set(key(signal), signal);
  return [...seen.values()].sort((a, b) => ms(a.bar_close) - ms(b.bar_close));
}

/** A fresh view from a `feed` answer: resume, an interval switch, or a new tape filter. */
export function viewFromFeed(feed: ReplayFeed, interval: ReplayInterval): ReplayView {
  return {
    interval: feed.interval ?? interval,
    bars: mergeBars([], feed.bars),
    forming: feed.forming,
    windowStart: feed.window_start ?? null,
    tape: feed.prints.rows.map(toRow).slice(-TAPE_CAP),
    tapeMeta: tapeMetaOf(feed.prints),
    paceSamples: [],
    signals: mergeSignals([], feed.signals),
    levels: feed.levels,
    last: feed.last,
    quietS: feed.quiet_s,
    openTrade: feed.open_trade,
    revealedThrough: feed.revealed_through,
    threadTime: feed.thread_time ?? null,
    dataThrough: feed.data_through,
    market: feed.market ?? null,
    indicators: mergeIndicators(null, feed.indicators),
    dayClock: feed.day_clock,
    behindClock: feed.behind_clock,
    clockRunning: feed.thread_clock?.running === true,
    clockSpeed: feed.thread_clock?.speed ?? 1,
    atEnd: feed.at_end,
    strip: feed.strip ?? null,
    daily: feed.daily ?? null,
    dailyForming: feed.daily?.forming ?? null,
    paused: null,
  };
}

/** Folds one `advance` answer into the view. The playhead only moves forward, even if an answer arrives late. */
export function applyAdvance(view: ReplayView, delta: ReplayDelta): ReplayView {
  const previous = ms(view.revealedThrough);
  const next = ms(delta.revealed_through);
  if (next < previous) return view;
  const rows = delta.prints.rows.map(toRow);
  const sample: PaceSample = { fromMs: previous, toMs: next, count: delta.prints.count, volume: delta.prints.volume };
  return {
    ...view,
    bars: mergeBars(view.bars, delta.bars),
    forming: delta.forming,
    tape: rows.length === 0 ? view.tape : [...view.tape, ...rows].slice(-TAPE_CAP),
    tapeMeta: tapeMetaOf(delta.prints),
    paceSamples: [...view.paceSamples, sample].filter((item) => item.toMs > next - 60_000),
    signals: mergeSignals(view.signals, delta.signals),
    levels: delta.levels,
    last: delta.last ?? view.last,
    quietS: delta.quiet_s,
    openTrade: delta.open_trade,
    revealedThrough: delta.revealed_through,
    threadTime: delta.thread_time ?? null,
    dataThrough: delta.data_through,
    market: delta.market ?? null,
    indicators: mergeIndicators(view.indicators, delta.indicators),
    dayClock: delta.day_clock,
    behindClock: delta.behind_clock,
    clockRunning: delta.thread_clock?.running === true,
    clockSpeed: delta.thread_clock?.speed ?? 1,
    atEnd: delta.at_end,
    // The latest value stands; an answer without a strip (a day session) leaves what the view had.
    strip: delta.strip ?? view.strip,
    dailyForming: delta.daily_forming ?? view.dailyForming,
    // A pause belongs to the advance that found it: the next advance clears it.
    paused: delta.paused ?? null,
  };
}

/** Clears the stop pause (she dismissed the toast). */
export const dismissPause = (view: ReplayView): ReplayView => (view.paused === null ? view : { ...view, paused: null });

/** Takes the day strip and the Daily block from a fresh `feed` answer and leaves the rest alone (after a mark moved a hold). */
export function applyFeedSwing(view: ReplayView, feed: ReplayFeed): ReplayView {
  if (ms(feed.revealed_through) < ms(view.revealedThrough)) return view;
  return { ...view, strip: feed.strip ?? view.strip, daily: feed.daily ?? view.daily, dailyForming: feed.daily?.forming ?? view.dailyForming };
}

/** The Daily chart's data with the newest forming candle in place: bars through the prior close, the forming candle, the hold marker. */
export function dailyBlock(view: Pick<ReplayView, "daily" | "dailyForming">): DailyBlock | null {
  return view.daily === null ? null : { ...view.daily, forming: view.dailyForming ?? view.daily.forming };
}

/**
 * Moves this name's hold marker after a mark: an open hold gets (or keeps) its marker with the new stop, a closed hold or
 * none removes it. A hold entered today has no earlier marker, so it starts at `today` (the session's day). A day
 * session has no Daily block and is returned as it is.
 */
export function withHoldMarker(view: ReplayView, hold: Pick<Hold, "status" | "side" | "entry_price" | "stop_price"> | null, today: string): ReplayView {
  if (view.daily === null) return view;
  const old = view.daily.holds[0];
  const holds =
    hold === null || hold.status !== "open"
      ? []
      : [{ entry_t: old?.entry_t ?? today, side: hold.side, entry_price: hold.entry_price, stop_price: hold.stop_price }];
  return { ...view, daily: { ...view.daily, holds } };
}

/** The chart's bars: closed bars plus the forming one (replacing a closed bar with the same start). */
export function chartBars(view: Pick<ReplayView, "bars" | "forming">): ReplayBar[] {
  // The forming bar's session comes from its own start time, not from the bar before it: the bar that starts at 9:30 follows a pre-market
  // bar but is the first regular one (it would otherwise read "extended hours" and hold the VWAP at "—" until the next bar, D-168).
  return view.forming ? mergeBars(view.bars, [{ ...view.forming, ext: !inRegularWindow(view.forming.t) }]) : view.bars;
}

/**
 * Prints and shares per market second over the last `PACE_WINDOW_S` seconds before the playhead. The API's own
 * `pace` wins; without it the numbers come from the counts of the last advances (each carries its whole span's
 * `count` and `volume`, so a capped tape stays honest).
 */
export type PaceView = { windowS: number; printsPerSecond: number; sharesPerSecond: number; band: "quiet" | "steady" | "busy" | "frantic" | null; timesAverage: number | null };

export function paceOf(view: Pick<ReplayView, "tapeMeta" | "paceSamples" | "revealedThrough">): PaceView | null {
  const server = view.tapeMeta?.pace;
  if (server) {
    return { windowS: server.window_s, printsPerSecond: server.prints_per_s, sharesPerSecond: server.shares_per_s, band: server.band ?? null, timesAverage: server.x_of_avg ?? null };
  }
  const end = ms(view.revealedThrough);
  const start = end - PACE_WINDOW_S * 1000;
  let count = 0;
  let volume = 0;
  let covered = 0;
  for (const sample of view.paceSamples) {
    const from = Math.max(sample.fromMs, start);
    const span = sample.toMs - from;
    if (span <= 0) continue;
    const share = span / (sample.toMs - sample.fromMs);
    count += sample.count * share;
    volume += sample.volume * share;
    covered += span;
  }
  if (covered <= 0) return null;
  const seconds = covered / 1000;
  return { windowS: PACE_WINDOW_S, printsPerSecond: count / seconds, sharesPerSecond: volume / seconds, band: null, timesAverage: null };
}

/** No print in the last 30 market seconds before the playhead (and the tape has started). */
export function isQuietTape(view: Pick<ReplayView, "tape" | "revealedThrough" | "windowStart">): boolean {
  const end = ms(view.revealedThrough);
  const last = view.tape.at(-1);
  if (!last) return view.windowStart !== null && end - ms(view.windowStart) >= QUIET_AFTER_S * 1000;
  return end - ms(last.t) >= QUIET_AFTER_S * 1000;
}
