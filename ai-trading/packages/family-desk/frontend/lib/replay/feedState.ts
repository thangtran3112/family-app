import type {
  DailyBar,
  DailyBlock,
  Hold,
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
  /** The day list's shared clock (null for a standalone session) and whether this name's playhead is behind it. */
  dayClock: string | null;
  behindClock: boolean;
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
    dayClock: feed.day_clock,
    behindClock: feed.behind_clock,
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
    dayClock: delta.day_clock,
    behindClock: delta.behind_clock,
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
  return view.forming ? mergeBars(view.bars, [{ ...view.forming, ext: view.bars.at(-1)?.ext ?? false }]) : view.bars;
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
