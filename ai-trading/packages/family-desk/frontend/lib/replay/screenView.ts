import {
  EMPTY_VALUE,
  changeToneAt,
  formatEtDateTimeZone,
  formatEtDay,
  formatEtTime,
  formatEtTimeZone,
  formatMetric,
  formatPrice,
  type MetricFormat,
  type Tone,
} from "../desk/format.ts";
import { formatSignedUsd } from "../desk/mask.ts";
import { PRACTICE_COPY, practiceText, prepPercent } from "../desk/freshness.ts";
import type { Candidate, Lane, Rescan, RescanJob, Screen } from "./screen.ts";
import { etHhMm } from "./time.ts";
import type { ThreadPlan } from "./threads.ts";

// The Screen, view logic (ADR-0025): her saved filters scanned at the thread's time T, with her stars and the names she opened. Pure, so the node
// tests cover it. The Screen has no list time, no day number and no review: a scan runs at T, and the ET date is only a label.

/** The page title: "Screen · Tue 2026-03-10", the ET date of T as a label. */
export const screenTitle = (screen: Pick<Screen, "day">): string => practiceText("screenTitle", { day: formatEtDay(screen.day) });

/** "118 of 131 scanned · 34 matched · showing 30": the first line under the title. */
export function screenCountsText(screen: Pick<Screen, "universe">): string {
  const { universe } = screen;
  return practiceText("screenCounts", { scanned: universe.scanned, size: universe.size, matched: universe.matches_total, shown: universe.shown });
}

/** The scan the names come from: "Scan 2 · run at Mon 2026-08-03 10:00 AM ET · data through 9:45 AM", or that none has run yet (a new Screen is empty until its first scan). */
export const rescanLabel = (scan: Pick<Rescan, "seq" | "as_of" | "data_through">): string =>
  practiceText("screenRescanLabel", { seq: scan.seq, clock: formatEtDateTimeZone(scan.as_of), through: formatEtTime(scan.data_through) });

export const scanBuiltText = (screen: Pick<Screen, "rescan">): string => (screen.rescan === null ? PRACTICE_COPY.screenNotScanned : rescanLabel(screen.rescan));

/** A new Screen holds no names until its first scan; the page then offers "Scan now" instead of an empty table. */
export const neverScanned = (screen: Pick<Screen, "rescan">): boolean => screen.rescan === null;

/** The regular session opens at this ET wall time. */
const REGULAR_OPEN = "09:30";

/** The thread clock has not reached the regular open. Only then is "until the market opens" true to say. */
export const beforeOpen = (clock: string | null): boolean => clock === null || etHhMm(clock) < REGULAR_OPEN;

/** The Desk universe is capped at this many names by dollar volume (the backend's `MAX_UNIVERSE`). */
export const UNIVERSE_CAP = 250;

/** The universe footnote with the Screen's own size, then whatever else the server said (a watchlist scope, a cap); the recorded morning's own note when the Desk recorded it. */
export function universeNote(universe: Pick<Screen["universe"], "size" | "label" | "footnote" | "membership">): string {
  // A date with a recorded morning (02o-b2) says so in the server's own words; the line about today's set is for the dates before the recording.
  if (universe.membership?.source === "universe_days") return universe.footnote;
  const extra = (universe.footnote.startsWith(universe.label) ? universe.footnote.slice(universe.label.length) : "").replace(/^ · /, "").trim();
  const base = practiceText("screenUniverse", { max: UNIVERSE_CAP, size: universe.size });
  return extra ? `${base} ${extra.charAt(0).toUpperCase()}${extra.slice(1)}.` : base;
}

/** "Source: Alpaca SIP bars up to 8:15 AM ET · nothing after the scan time is shown". */
export const sourceNote = (screen: Pick<Screen, "data_through">): string => practiceText("screenSource", { through: formatEtTimeZone(screen.data_through) });

/** "Saved filters · a name that passes either one is listed", or just "Saved filters" for one filter. */
export const filtersNote = (count: number): string => (count > 1 ? PRACTICE_COPY.screenFiltersNote : PRACTICE_COPY.screenFiltersNoteOne);

/** The thread's risk plan in one sentence: "trade only on a signal, max loss $600, up to 3 trades per ET date". The limits are optional and count per ET date of T. */
export function riskPlanText(plan: Pick<ThreadPlan, "tradeOnlyOnSignal" | "maxLossUsd" | "maxTrades">): string {
  const parts = [
    plan.tradeOnlyOnSignal === "yes" ? "trade only on a signal" : null,
    plan.maxLossUsd === undefined ? null : `max loss $${plan.maxLossUsd.toLocaleString("en-US")}`,
    plan.maxTrades === undefined ? null : `up to ${plan.maxTrades} ${plan.maxTrades === 1 ? "trade" : "trades"} per ET date`,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? PRACTICE_COPY.screenRiskNone : practiceText("screenRiskFrom", { plan: parts.join(", ") });
}

// ---- the candidate table -----------------------------------------------------------------------------------

const FORMATS: ReadonlySet<string> = new Set<MetricFormat>(["price", "pct", "pct_signed", "compact", "ratio", "number", "time"]);

/** One column of the Screen: the API's own metric columns, plus the columns built from the candidate itself (D-018). */
export type ScreenColumn = {
  key: string;
  label: string;
  format: string;
  /** The cell's value; null reads as a dash. */
  value: (row: Candidate) => number | string | null;
  /** The payload has no value for this column in this scan: every cell is an honest dash, never a stand-in. */
  missing?: boolean;
  /** The column moves with the thread clock (it reads the candidate's `live` block); the others are fixed at the scan. */
  live?: boolean;
  /** The metric this column reads from the candidate, when it is one of the server's metric columns. */
  source?: string;
};

/** The metric columns that follow the thread clock once the regular session has opened (`data/metrics.py`: the partial day's `last`, change, volume,
 *  gap, VWAP, RVOL and 52-week high). ATR % and RSI stay on closed daily bars, so they never repaint and are not here. */
const CLOCK_METRICS = new Set(["last", "change_pct", "volume", "rvol_10d", "gap_pct_open", "vs_vwap_pct", "high_252d", "dist_to_252d_high_pct"]);

/** Whether the table moves with the thread clock: null before the read carries a clock and for a thread that is closed (the read carries no `live` block). `today`: the
 *  regular session has opened at the clock, so the metric columns can move too; before that only the price does (extended hours). */
export function liveState(screen: Pick<Screen, "candidates">): { today: boolean } | null {
  const lives = screen.candidates.flatMap((row) => (row.live ? [row.live] : []));
  return lives.length === 0 ? null : { today: lives.some((live) => live.today) };
}

/** How the table follows the thread clock. `today`: the regular session has opened at the clock, so the metric columns move too, not only the price. `pending`: the read at the clock has not landed yet. */
export type FollowState = { today: boolean; pending: boolean };

/**
 * Whether the table follows the thread clock, and how far. It does while the thread is active (a closed thread has no live read: its time is frozen),
 * so its columns are the settled set from the first paint (D-159): until the read at the clock lands, the columns the clock moves are there with
 * `pending` cells, never missing, and nothing re-lays out when it lands. `today` is the read's own once it is in; before it, the clock's own estimate
 * (a regular bar closes a minute after the open).
 */
export function followState(
  screen: Pick<Screen, "clock" | "thread">,
  rows: Pick<Screen, "candidates">,
  read: { landed: boolean; failed: boolean },
): FollowState | null {
  // A closed thread, or no names (the empty state shows, not a table): nothing follows the clock.
  if (screen.thread?.status === "closed" || rows.candidates.length === 0) return null;
  return { today: liveState(rows)?.today ?? etHhMm(screen.clock) > REGULAR_OPEN, pending: !read.landed && !read.failed };
}

/** "Prev volume" and "Volume" both read "Volume now" once they follow the clock. */
const nowLabel = (label: string): string => {
  const bare = label.replace(/^Prev /, "");
  return `${bare.charAt(0).toUpperCase()}${bare.slice(1)} now`;
};

const EARNINGS_FORMAT = "earnings";

/** The earnings cell: a report before the open, "None" for a name whose report history was read and holds none, and nothing (a dash) for a name that was not checked (D-018). */
const earningsText = (state: Candidate["earnings_state"]): string | null =>
  state === "reported" ? PRACTICE_COPY.screenReported : state === "none" ? PRACTICE_COPY.screenEarningsNone : null;

/**
 * The table's columns in the order of P7: scan price, prev close, prev RVOL, prev change %, ATR %, RSI, earnings, then the rest of the
 * server's columns and the time the match began. Prev close, prev RVOL and prev change % are the previous session's own figures on the
 * candidate (`prior_close`, `prev_rvol`, `prev_change_pct`), whether the scan ran before or after the open (D-018). A scan read before
 * the open also relabels the server's `rvol_10d` and `change_pct` as the same previous-session figures, so those two are not drawn twice; a scan
 * stored before the candidate carried them reads them from that block, and a dash where it has neither.
 */
export function screenColumns(screen: Pick<Screen, "columns" | "universe">, live: { today: boolean } | null = null): ScreenColumn[] {
  const prevBasis = screen.universe.prev_basis;
  const have = new Map(screen.columns.map((column) => [column.key, column]));
  const used = new Set<string>(["matched_since"]);
  const metric = (key: string) => (row: Candidate) => row.metrics[key] ?? null;
  const plain = (key: string): ScreenColumn[] => {
    const column = have.get(key);
    if (!column || used.has(key)) return [];
    used.add(key);
    return [{ key, label: column.label, format: column.format, value: metric(key), source: key }];
  };
  if (prevBasis) for (const key of ["last", "rvol_10d", "change_pct"]) used.add(key);
  const stored = (own: (row: Candidate) => number | null, source: string) => (row: Candidate) =>
    own(row) ?? (prevBasis ? metric(source)(row) : null);

  // Following the clock, the scan-time move from the prior close gives way to the one at the clock; the scan price stays as the reference.
  if (live) used.add("list_change_pct"); // replaced by the move at the clock
  const head = live
    ? [
        ...plain("list_price").map((column) => ({ ...column, label: PRACTICE_COPY.screenPriceAtScan })),
        { key: "price_now", label: "Price now", format: "price", value: (row: Candidate) => row.live?.price ?? null, live: true },
        { key: "change_now", label: "vs prev close % now", format: "pct_signed", value: (row: Candidate) => row.live?.change_pct ?? null, live: true },
      ]
    : [...plain("list_price"), ...plain("list_change_pct")];
  const prev: ScreenColumn[] = [
    { key: "prev_close", label: "Prev close", format: "price", value: (row) => row.prior_close },
    { key: "prev_rvol", label: "Prev RVOL", format: "ratio", value: stored((row) => row.prev_rvol, "rvol_10d") },
    { key: "prev_change_pct", label: "Prev change %", format: "pct_signed", value: stored((row) => row.prev_change_pct, "change_pct") },
  ];
  const core = [...plain("atr_pct_14"), ...plain("rsi_14")];
  const rest = screen.columns.flatMap((column) => plain(column.key));
  const earnings: ScreenColumn = { key: "earnings", label: "Earnings", format: EARNINGS_FORMAT, value: (row) => earningsText(row.earnings_state) };
  const since = have.get("matched_since");
  const tail: ScreenColumn[] = since ? [{ key: "matched_since", label: since.label, format: since.format, value: (row) => row.matched_since }] : [];
  const columns = [...head, ...prev, ...core, earnings, ...rest, ...tail];
  if (!live?.today) return columns;
  return columns.map((column) => {
    const source = column.source;
    if (source === undefined || !CLOCK_METRICS.has(source)) return column;
    // A name with no live block (its bars are unavailable) keeps the scan-time value rather than a made-up one.
    return { ...column, label: nowLabel(column.label), live: true, value: (row: Candidate) => (row.live ? (row.live.metrics[source] ?? null) : column.value(row)) };
  });
}

/** A cell's text: a dash for a value the payload does not hold. */
export function screenCellText(column: ScreenColumn, row: Candidate): string {
  const value = column.value(row);
  if (column.format === EARNINGS_FORMAT) return value === null ? EMPTY_VALUE : String(value);
  if (column.format === "time") return formatMetric("time", value);
  const format = FORMATS.has(column.format) ? (column.format as MetricFormat) : "number";
  return formatMetric(format, typeof value === "number" ? value : null);
}

export function screenCellTone(column: ScreenColumn, row: Candidate): Tone | null {
  const value = column.value(row);
  return column.format === "pct_signed" && typeof value === "number" ? changeToneAt(value, 2) : null;
}

/** "Gap up · Abnormal volume" */
export const filtersText = (row: Pick<Candidate, "filters">): string => row.filters.join(" · ");

export const isStarred = (watch: readonly { symbol: string }[], symbol: string): boolean => watch.some((star) => star.symbol === symbol);

/** The next stars after a click: a starred name comes off, any other goes on the end. A Screen has no cap on stars. */
export function toggledStars(watch: readonly { symbol: string }[], symbol: string): string[] {
  const symbols = watch.map((star) => star.symbol);
  return symbols.includes(symbol) ? symbols.filter((item) => item !== symbol) : [...symbols, symbol];
}

/** What the server says about the scan: a filter still waiting for its first bar of the day, and why a Screen is short. */
export const screenWarnings = (screen: Pick<Screen, "warnings">): readonly string[] => screen.warnings;

// ---- the names she opened (lanes) -------------------------------------------------------------------------------------

/** The names she holds right now (a non-zero position, long or short), first. Then the flat ones in the order she opened them. */
export const heldFirst = (lanes: readonly Lane[]): Lane[] => [...lanes.filter((lane) => lane.has_open_trade), ...lanes.filter((lane) => !lane.has_open_trade)];

/** "Long 100 @ $812.40 · +$214.00 at the clock" for a held name, "Flat" for one with no open position. The figure is the position marked at T. */
export function laneLine(lane: Pick<Lane, "position">): string {
  const trade = lane.position;
  if (trade === null) return PRACTICE_COPY.screenLaneFlat;
  return `${trade.side === "long" ? "Long" : "Short"} ${trade.shares.toLocaleString("en-US")} @ $${formatPrice(trade.entry_price)} · ${formatSignedUsd(trade.unrealized_usd, { cents: true })}`;
}

// ---- re-scan at the thread clock (02o-b2) ----------------------------------------------------------------------

/** A scan is offered on an active thread: it runs at T, whatever T is. A closed thread's Screen no longer scans (409). */
export const canRescan = (screen: Pick<Screen, "thread">): boolean => screen.thread?.status !== "closed";

/** The names the repopulated Screen kept because she opened or starred them and the scan no longer matches them. */
export const heldOverCount = (screen: Pick<Screen, "candidates">): number => screen.candidates.filter((candidate) => candidate.held_over).length;

/** "2 of 2 matched · 1 new in this scan", then "· 1 kept because you opened or starred them" when the Screen kept names. */
export function rescanCounts(screen: Pick<Screen, "universe" | "rescan" | "candidates">): string {
  const base = practiceText("screenRescanCounts", { shown: screen.universe.shown, matched: screen.universe.matches_total, fresh: screen.rescan?.new_count ?? 0 });
  const held = heldOverCount(screen);
  return held > 0 ? `${base} · ${practiceText("screenRescanKept", { held })}` : base;
}

/** A scan is reading right now: the screen polls itself until it is not. */
export const rescanRunning = (screen: Pick<Screen, "rescan_job">): boolean => screen.rescan_job?.state === "running";

/** The Screen already shows a scan run at the thread clock (or later): another scan now would read the same thing. */
export const rescanCurrent = (screen: Pick<Screen, "clock" | "rescan">): boolean =>
  screen.rescan !== null && Date.parse(screen.clock) <= Date.parse(screen.rescan.as_of);

/** Whole percent of the symbols read (0 until the job has counted them). */
export const rescanPercent = (job: Pick<RescanJob, "done" | "total">): number => prepPercent(job.done, job.total);

/** The running scan in words that move: counting the names, "read 37 of 134 names (27%)", then applying the filters once all are read. */
export function rescanProgressText(job: Pick<RescanJob, "as_of" | "done" | "total">): string {
  const clock = formatEtTimeZone(job.as_of);
  if (job.total === 0) return practiceText("screenRescanCounting", { clock });
  if (job.done >= job.total) return practiceText("screenRescanFiltering", { clock, total: job.total });
  return practiceText("screenRescanProgress", { clock, done: job.done, total: job.total, pct: rescanPercent(job) });
}

/** The thread clock has moved since the scan ran: the scan is older than the screen's clock. */
export function rescanStaleText(screen: Pick<Screen, "clock" | "rescan">): string | null {
  if (screen.rescan === null || Date.parse(screen.clock) <= Date.parse(screen.rescan.as_of)) return null;
  return practiceText("screenRescanStale", { clock: formatEtTimeZone(screen.clock) });
}
