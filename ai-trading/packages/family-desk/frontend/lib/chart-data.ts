import type {
  BusinessDay,
  CandlestickData,
  HistogramData,
  LineData,
  SeriesMarker,
  SeriesMarkerBar,
  Time,
  UTCTimestamp,
  WhitespaceData,
} from "lightweight-charts";
import { formatEtDay, formatEtTime } from "./desk/format.ts";

export type ChartBar = {
  t: string;
  o: number | null;
  h: number | null;
  l: number | null;
  c: number | null;
  v?: number | null;
  /** Pre- or after-hours bar (extended-hours shading). */
  ext?: boolean;
};

export function chartTime(value: string): Time {
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (date) {
    return { year: Number(date[1]), month: Number(date[2]), day: Number(date[3]) } satisfies BusinessDay;
  }
  const seconds = Math.floor(Date.parse(value) / 1000);
  if (!Number.isFinite(seconds)) throw new TypeError("Invalid chart timestamp");
  return seconds as UTCTimestamp;
}

export function currentValue(values: Array<number | null>): number | null {
  const value = values.at(-1);
  return value !== undefined && value !== null && Number.isFinite(value) ? value : null;
}

function timeKey(time: Time): number {
  if (typeof time === "number") return time;
  if (typeof time === "string") return Math.floor(Date.parse(time) / 1000);
  return Date.UTC(time.year, time.month - 1, time.day) / 1000;
}

function sortedUnique<T extends { time: Time }>(points: T[]): T[] {
  const byTime = new Map<number, T>();
  for (const point of points) byTime.set(timeKey(point.time), point);
  return [...byTime.entries()].sort(([left], [right]) => left - right).map(([, point]) => point);
}

export function candlestickData(bars: ChartBar[]): Array<CandlestickData<Time> | WhitespaceData<Time>> {
  return sortedUnique(bars.map((bar) => {
    const time = chartTime(bar.t);
    const values = [bar.o, bar.h, bar.l, bar.c];
    if (values.some((value) => value === null || !Number.isFinite(value))) return { time };
    return { time, open: bar.o!, high: bar.h!, low: bar.l!, close: bar.c! };
  }));
}

export function lineData(bars: ChartBar[], values: Array<number | null>): Array<LineData<Time> | WhitespaceData<Time>> {
  return sortedUnique(bars.map((bar, index) => {
    const time = chartTime(bar.t);
    const value = values[index];
    return value === null || value === undefined || !Number.isFinite(value) ? { time } : { time, value };
  }));
}

const UP_VOLUME = "#30D15866";
const DOWN_VOLUME = "#FF453A66";
const SHADE = "#141416";

/** Volume columns coloured by candle direction at 40% opacity (02l §b5). */
export function volumeData(bars: ChartBar[]): Array<HistogramData<Time> | WhitespaceData<Time>> {
  return sortedUnique(bars.map((bar) => {
    const time = chartTime(bar.t);
    if (bar.v === null || bar.v === undefined || !Number.isFinite(bar.v)) return { time };
    const up = bar.c !== null && bar.o !== null && bar.c >= bar.o;
    return { time, value: bar.v, color: up ? UP_VOLUME : DOWN_VOLUME };
  }));
}

/** Full-height columns behind extended-hours bars; regular bars are whitespace (02l §b5 session shading). */
export function shadingData(bars: ChartBar[]): Array<HistogramData<Time> | WhitespaceData<Time>> {
  return sortedUnique(bars.map((bar) => {
    const time = chartTime(bar.t);
    return bar.ext ? { time, value: 1, color: SHADE } : { time };
  }));
}

export type ChartMarkerInput = {
  /** UTC bar start. Patterns use `bar_start`, fired alerts `bar_time`; Practice marks are snapped to the bar they fall in. */
  time: string;
  /** `practice_*` are her Practice marks (arrow up below a long entry, arrow down above a short entry, a circle for an exit);
   *  `would_fire` is a replayed strategy signal and reuses the fire style (02o §d). */
  kind: "pattern" | "fire" | "practice_long" | "practice_short" | "practice_exit" | "would_fire";
  label: string;
};

const etDay = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });

function markerStyle(marker: ChartMarkerInput): Pick<SeriesMarkerBar<Time>, "position" | "shape" | "color" | "text"> {
  switch (marker.kind) {
    case "pattern": return { position: "belowBar", shape: "arrowUp", color: "#F2F2F4", text: marker.label };
    case "fire": return { position: "aboveBar", shape: "circle", color: "#FFB020", text: "🔔" };
    case "would_fire": return { position: "aboveBar", shape: "circle", color: "#FFB020", text: `🔔 ${marker.label}` };
    case "practice_long": return { position: "belowBar", shape: "arrowUp", color: "#30D158", text: marker.label };
    case "practice_short": return { position: "aboveBar", shape: "arrowDown", color: "#FF453A", text: marker.label };
    case "practice_exit": return { position: "inBar", shape: "circle", color: "#F2F2F4", text: marker.label };
  }
}

/**
 * Pattern labels below the bar, an amber bell above it for each fired alert (02l §b5), and Practice marks
 * (02o §d). A marker that matches no loaded bar is dropped; the library needs them sorted by time.
 */
export function seriesMarkers(bars: ChartBar[], markers: ChartMarkerInput[]): SeriesMarker<Time>[] {
  if (bars.length === 0) return [];
  const daily = /^\d{4}-\d{2}-\d{2}$/.test(bars[0]!.t);
  const have = new Set(bars.map((bar) => timeKey(chartTime(bar.t))));
  const placed = markers.flatMap((marker): Array<{ key: number; marker: SeriesMarker<Time> }> => {
    const time = chartTime(daily ? etDay.format(new Date(marker.time)) : marker.time);
    const key = timeKey(time);
    if (!have.has(key)) return [];
    return [{ key, marker: { time, ...markerStyle(marker) } }];
  });
  return placed.sort((a, b) => a.key - b.key).map(({ marker }) => marker);
}

/** What the legend shows under the cursor; null values mean "no data at this bar". */
export type CrosshairPoint = {
  time: Time;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  /** Overlay and pane series by id (`ema9`, `rsi:rsi-line`). */
  values: Record<string, number | null>;
};

type SeriesPoint = { value?: number; open?: number; high?: number; low?: number; close?: number } | undefined;
const num = (value: number | undefined) => (value !== undefined && Number.isFinite(value) ? value : null);

export function crosshairPoint(
  time: Time,
  candle: SeriesPoint,
  volume: SeriesPoint,
  values: Record<string, SeriesPoint>,
): CrosshairPoint {
  return {
    time,
    open: num(candle?.open),
    high: num(candle?.high),
    low: num(candle?.low),
    close: num(candle?.close),
    volume: num(volume?.value),
    values: Object.fromEntries(Object.entries(values).map(([id, point]) => [id, num(point?.value)])),
  };
}

/** "10:05 AM" in New York; empty for a business-day time (daily bars have no clock). */
export function formatChartClock(time: Time): string {
  if (typeof time === "object") return "";
  const date = new Date(typeof time === "number" ? time * 1000 : time);
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit" }).format(date);
}

/** Replay axes: time of day on time ticks, "Oct 22" on day ticks, nothing for a day tick when dates are hidden. `tickType` is the library's TickMarkType (3 and up are time ticks). */
export function replayTickLabel(time: Time, tickType: number, hideDates: boolean): string {
  if (tickType >= 3) return formatChartClock(time);
  if (hideDates || typeof time === "object") return "";
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" }).format(new Date(typeof time === "number" ? time * 1000 : time));
}

/**
 * The "Source time" cell of a chart's data table. Dates hidden: the caller's label for the row when it has one ("D-3",
 * "Day 6"; a stand-in timeline's own clock time says nothing), else the time of day.
 */
export function sourceTimeLabel(t: string, index: number, hideDates: boolean, rowLabels?: readonly string[]): string {
  // Dates shown: the New York day and time ("Fri 2026-10-23 10:07 AM"), never the raw UTC string (V-Technicals-05).
  if (!hideDates) return /^\d{4}-\d{2}-\d{2}$/.test(t) ? formatEtDay(t) : `${formatEtDay(t)} ${formatEtTime(t)}`;
  return rowLabels?.[index] ?? formatChartClock(Math.floor(Date.parse(t) / 1000) as UTCTimestamp);
}

/** The least share of the chart the price pane keeps when the indicator panes ask for more than the rest. */
export const PRICE_PANE_SHARE = 0.6;

/**
 * Pixel heights `[price, ...panes]` for a chart `total` px tall (V-Technicals-04). Indicator panes keep their own height
 * while there is room; when there is not, they shrink in proportion so the price pane keeps PRICE_PANE_SHARE of the
 * chart. Two 120 px panes in a 406 px chart had left the candles about 90 px.
 */
export function paneHeights(total: number, wanted: readonly number[]): number[] {
  const asked = wanted.reduce((sum, height) => sum + height, 0);
  const price = Math.max(total - asked, total * PRICE_PANE_SHARE);
  const room = total - price;
  return [price, ...wanted.map((height) => (asked > 0 ? (height * room) / asked : 0))];
}

// -- trackpad pinch ---------------------------------------------------------------------------------------------------

/**
 * Chrome and Edge send a trackpad pinch as `wheel` events with `ctrlKey` set and a `deltaY` of a few px. lightweight-charts
 * treats them like a mouse wheel (a tenth of the bar spacing per 100 px), so a pinch zoomed about a tenth as far as the
 * fingers moved (30 events of 2 px: 1.06x, measured in Chromium). The chart handles `ctrl+wheel` itself with this gain.
 * Calibration knob: log-zoom per px of `deltaY`; raise it if a pinch still feels slow, lower it if it overshoots.
 */
export const PINCH_GAIN = 0.01;
/** One event's px are capped: a ctrl+mouse-wheel notch reports 100 px and must not be a 2.7x jump. */
const PINCH_MAX_PX = 30;
/** Firefox reports wheel deltas in lines. */
const PX_PER_LINE = 16;

/** The zoom for one pinch event: above 1 zooms in (fingers apart, negative `deltaY`), below 1 zooms out. */
export function pinchFactor(deltaY: number, deltaMode = 0): number {
  const px = deltaMode === 0 ? deltaY : deltaY * PX_PER_LINE;
  return Math.exp(-Math.max(-PINCH_MAX_PX, Math.min(PINCH_MAX_PX, px)) * PINCH_GAIN);
}

export type LogicalRange = { from: number; to: number };

/**
 * The visible range after zooming by `factor` with the point `x` px from the left edge of a `width` px chart staying on the
 * same bar. Mirrors the library's own geometry (`count = to - from + 1 = width / barSpacing`, the right edge at `to`) and
 * uses the bar's float index, because `coordinateToLogical` rounds up to a whole bar and would make the anchor jump.
 */
export function zoomedRange(range: LogicalRange, x: number, width: number, factor: number): LogicalRange {
  const spacing = width / (range.to - range.from + 1);
  const anchor = range.to - (width - 1 - x) / spacing;
  const zoomed = spacing * factor;
  const to = anchor + (width - 1 - x) / zoomed;
  return { from: to - width / zoomed + 1, to };
}

type PinchChart = {
  timeScale(): {
    width(): number;
    getVisibleLogicalRange(): LogicalRange | null;
    setVisibleLogicalRange(range: LogicalRange): void;
  };
};

/**
 * Zoom the chart on a trackpad pinch (`ctrl+wheel`), anchored under the cursor, and keep the library's slower wheel handler
 * from also seeing it. A plain wheel (mouse wheel, two-finger scroll) is left to the library. The listener is on `target`
 * (the chart's container) in the capture phase, so it runs before the library's own listener on the element inside it.
 * Returns the function that removes it.
 *
 * `setVisibleLogicalRange` only queues the range: the library applies it when it draws, on the next frame, and
 * `getVisibleLogicalRange` keeps answering with the old one until then. A second event in the same frame would start from
 * the old range and lose the first, so the range asked for is kept until `nextFrame` fires (after the library's own draw,
 * which was queued first).
 */
export function attachPinchZoom(
  target: HTMLElement,
  chart: PinchChart,
  nextFrame: (callback: () => void) => unknown = (callback) => requestAnimationFrame(callback),
): () => void {
  let queued: LogicalRange | null = null;
  const onWheel = (event: WheelEvent) => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const scale = chart.timeScale();
    const range = queued ?? scale.getVisibleLogicalRange();
    const width = scale.width();
    if (range === null || width <= 1 || range.to < range.from) return;
    const x = Math.max(0, Math.min(width - 1, event.clientX - target.getBoundingClientRect().left));
    queued = zoomedRange(range, x, width, pinchFactor(event.deltaY, event.deltaMode));
    scale.setVisibleLogicalRange(queued);
    nextFrame(() => { queued = null; });
  };
  target.addEventListener("wheel", onWheel, { capture: true, passive: false });
  return () => target.removeEventListener("wheel", onWheel, { capture: true });
}
