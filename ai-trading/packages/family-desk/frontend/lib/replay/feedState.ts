import type {
  IndicatorBar,
  Indicators,
  Market,
  OpenTrade,
  ReplayBar,
  ReplayDelta,
  ReplayFeed,
  ReplayInterval,
  ReplayLevels,
  ReplayPace,
  ReplaySignal,
  TapeFeed,
} from "./schemas.ts";
import { inRegularWindow } from "../indicators.ts";
import { ms } from "./time.ts";

// What the browser holds of a lane's chart: only what the server has revealed, which is the thread's time T and nothing after it. This module
// merges `feed` and `advance` answers; it never slices, trims, or filters by the playhead (the server owns the reveal boundary, 02o decision 1).
// Bars are keyed by their start instant, so a lane that a Jump carried over several sessions holds the bars of every one of them in order, with
// no assumption that they share a day. The only cut is the tape's display cap, which keeps the newest rows.

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
  /** The thread's own time T from this payload (ADR-0022): never extrapolated by the server. Null for a legacy standalone session. */
  threadTime: string | null;
  /** How far this payload's data runs: the last bar at or before T (T itself in the regular session, the tape's end overnight). */
  dataThrough: string;
  /** The exchange at T: the phase, the tape end of the latest session, this name's last bar and when the next open is. */
  market: Market | null;
  /** The server's EMA 9/21, VWAP, RSI and MACD for the bars held (and the forming candle), from the same cut as the price: the chart and the left rail read these. */
  indicators: IndicatorTable | null;
  /** The thread clock at this read (null for a legacy standalone session) and whether this name's playhead is behind it. */
  threadClock: string | null;
  behindClock: boolean;
  /** The thread clock runs on the server right now (ADR-0018). False when it is paused (also at the horizon) or the lane has no thread. */
  clockRunning: boolean;
  /** Market seconds per wall second while it runs (1 when it does not). */
  clockSpeed: number;
  atEnd: boolean;
};

/** True when two flat records hold the same values (a bar, an indicator row). */
const sameRecord = (a: object, b: object): boolean => {
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
};

/** Keeps `previous` when `next` says the same, so a poll that brings nothing new hands the chart nothing new (D-206). For the small records of an answer (levels, the open trade, the forming candle). */
const unchanged = <T,>(previous: T, next: T): T => (previous === next || JSON.stringify(previous) === JSON.stringify(next) ? previous : next);

/**
 * Rows keyed by start time, ascending: a later answer replaces the row with the same start, new ones append. An answer continues the series at its
 * tail (the newest row again, newer ones after it), so it is folded in without touching the rest: a row that is the same as the one held stays that
 * very object, and an answer that changes nothing returns `existing` itself. The 6,000 bars of a 1m lookback are then neither re-keyed, re-sorted nor
 * re-drawn by every poll (D-206). An answer that reaches back past the newest row takes the general path: the rows keyed, sorted, and the later one wins.
 */
function mergeByStart<T extends { t: string }>(existing: readonly T[], incoming: readonly T[]): T[] {
  if (incoming.length === 0) return existing as T[];
  let merged: T[] | null = null;
  let tail = existing.length === 0 ? Number.NEGATIVE_INFINITY : ms(existing[existing.length - 1]!.t);
  for (const item of incoming) {
    const start = ms(item.t);
    if (start > tail) {
      merged ??= existing.slice();
      merged.push(item);
      tail = start;
    } else if (start === tail) {
      const held = (merged ?? existing)[(merged ?? existing).length - 1]!;
      if (sameRecord(held, item)) continue;
      merged ??= existing.slice();
      merged[merged.length - 1] = item;
    } else {
      const byTime = new Map<number, T>();
      for (const row of existing) byTime.set(ms(row.t), row);
      for (const row of incoming) byTime.set(ms(row.t), row);
      return [...byTime.entries()].sort(([a], [b]) => a - b).map(([, row]) => row);
    }
  }
  return merged ?? (existing as T[]);
}

/** Indicator rows keyed by bar open: a later answer replaces the same bar, new bars append, order stays ascending. Nothing new returns `existing`. */
function mergeIndicators(existing: IndicatorTable | null, incoming: Indicators | null | undefined): IndicatorTable | null {
  if (incoming == null) return existing;
  const same = existing !== null && existing.interval === incoming.interval;
  const rows = mergeByStart(same ? existing.rows : [], incoming.rows);
  return same && rows === existing.rows && existing.asOfBar === incoming.as_of_bar ? existing : { interval: incoming.interval, asOfBar: incoming.as_of_bar, rows };
}

/**
 * The one time a name's screen shows: the payload's own thread time T. A legacy standalone session has no T, so its time is its playhead, or the
 * thread clock when a name was left behind it (the thread's time, not that name's older playhead).
 */
export const viewClock = (view: Pick<ReplayView, "threadTime" | "revealedThrough" | "threadClock">): string =>
  view.threadTime ?? (view.threadClock !== null && ms(view.threadClock) > ms(view.revealedThrough) ? view.threadClock : view.revealedThrough);

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

/** Bars keyed by start time: a later answer replaces the same bar, new bars append, order stays ascending. Nothing new returns `existing`, and a bar that did not change stays the same object. */
export const mergeBars = (existing: readonly ReplayBar[], incoming: readonly ReplayBar[]): ReplayBar[] => mergeByStart(existing, incoming);

function mergeSignals(existing: readonly ReplaySignal[], incoming: readonly ReplaySignal[]): ReplaySignal[] {
  if (incoming.length === 0) return existing as ReplaySignal[];
  const key = (signal: ReplaySignal) => `${signal.source}:${signal.id}:${signal.bar_time}`;
  const seen = new Map(existing.map((signal) => [key(signal), signal]));
  for (const signal of incoming) seen.set(key(signal), signal);
  return unchanged(existing as ReplaySignal[], [...seen.values()].sort((a, b) => ms(a.bar_close) - ms(b.bar_close)));
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
    threadClock: feed.day_clock,
    behindClock: feed.behind_clock,
    clockRunning: feed.thread_clock?.running === true,
    clockSpeed: feed.thread_clock?.speed ?? 1,
    atEnd: feed.at_end,
  };
}

/**
 * The follow poll of a window: bring the lane to the thread clock, and say where this window's view ends. The server has one playhead per session,
 * so a second window on the same name finds it already moved; the answer starts at `since` instead, and the merge below is by bar start, so a bar
 * that arrives twice is one bar (D-198).
 */
export const syncTarget = (view: Pick<ReplayView, "revealedThrough"> | null) => ({ sync: true as const, ...(view === null ? {} : { since: view.revealedThrough }) });

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
    forming: unchanged(view.forming, delta.forming),
    tape: rows.length === 0 ? view.tape : [...view.tape, ...rows].slice(-TAPE_CAP),
    tapeMeta: tapeMetaOf(delta.prints),
    paceSamples: [...view.paceSamples, sample].filter((item) => item.toMs > next - 60_000),
    signals: mergeSignals(view.signals, delta.signals),
    levels: unchanged(view.levels, delta.levels),
    last: delta.last ?? view.last,
    quietS: delta.quiet_s,
    openTrade: unchanged(view.openTrade, delta.open_trade),
    revealedThrough: delta.revealed_through,
    threadTime: delta.thread_time ?? null,
    dataThrough: delta.data_through,
    market: unchanged(view.market, delta.market ?? null),
    indicators: mergeIndicators(view.indicators, delta.indicators),
    threadClock: delta.day_clock,
    behindClock: delta.behind_clock,
    clockRunning: delta.thread_clock?.running === true,
    clockSpeed: delta.thread_clock?.speed ?? 1,
    atEnd: delta.at_end,
  };
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
