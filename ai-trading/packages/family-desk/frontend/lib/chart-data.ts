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
import { fitsWhole } from "./desk/ticks.ts";

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

/** What a series was last drawn from: the bars (and the values laid on them), and a key for anything else that shapes its points (a colour). */
export type SeriesFed = { bars: readonly ChartBar[]; values: readonly (number | null)[] | null; key: string };
/** The part of a library series the feed uses. */
export type Feedable<P> = { setData(data: P[]): void; update(point: P): void };

/**
 * Where the data of a series starts to differ from what it was last given, or -1 when all of it has to be sent: the first draw, a different key, fewer
 * bars, or a change anywhere before the newest bar held. A refresh of a followed chart changes the newest bar (the forming candle closes) and appends
 * the ones after it, and the bars before are the same objects (the replay's merge keeps them), so this is a scan of references, microseconds for 6,000 bars.
 * A result equal to `bars.length` means there is nothing to send.
 */
export function changedFrom(fed: SeriesFed | undefined, bars: readonly ChartBar[], values: readonly (number | null)[] | null, key: string): number {
  if (!fed || fed.key !== key || fed.bars.length === 0 || bars.length < fed.bars.length || (values === null) !== (fed.values === null)) return -1;
  const held = fed.bars.length;
  let from = 0;
  while (from < held && fed.bars[from] === bars[from]) from += 1;
  if (values !== null && fed.values !== null) {
    if (values.length < held) return -1;
    let at = 0;
    while (at < held && fed.values[at] === values[at]) at += 1;
    from = Math.min(from, at);
  }
  return from < held - 1 ? -1 : from;
}

/**
 * Brings a library series up to `bars`: all of the data on a first draw or after a change behind the newest bar, otherwise only the bars from the first
 * change on (`update` replaces the newest point and appends the rest). The library's `setData` and the point builders cost as much as the series is long,
 * and a followed chart did them for 6,000 bars on every new bar (D-206). `build` makes the points of the bars and values it is given. Returns the first
 * bar sent, or -1 for all of them.
 */
export function syncSeries<P>(
  series: Feedable<P>,
  fed: WeakMap<object, SeriesFed>,
  bars: readonly ChartBar[],
  values: readonly (number | null)[] | null,
  key: string,
  build: (bars: ChartBar[], values: Array<number | null>) => P[],
): number {
  const from = changedFrom(fed.get(series), bars, values, key);
  fed.set(series, { bars, values, key });
  const all = () => {
    series.setData(build(bars as ChartBar[], (values ?? []) as Array<number | null>));
    return -1;
  };
  if (from < 0) return all();
  if (from >= bars.length) return from;
  try {
    for (const point of build(bars.slice(from), values === null ? [] : values.slice(from))) series.update(point);
  } catch {
    return all(); // the library refuses an older time than its newest: send everything instead
  }
  return from;
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
  if (bars.length === 0 || markers.length === 0) return [];
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

/** Replay axes: time of day on time ticks, "Oct 22" on day ticks. `tickType` is the library's TickMarkType (3 and up are time ticks). */
export function replayTickLabel(time: Time, tickType: number): string {
  if (tickType >= 3) return formatChartClock(time);
  if (typeof time === "object") return "";
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" }).format(new Date(typeof time === "number" ? time * 1000 : time));
}

/** The library's axis type size (`layout.fontSize`, 12 by default): the chart sets no other. */
const AXIS_FONT_PX = 12;

/**
 * A time-axis label, or "" when it would print cut off at the edge of the axis (D-180). The library centres each label on its tick and
 * clips it at the edge, so the first tick of a narrow chart read "0 AM" for "04:00 AM". `x` is the tick's place on the axis, null
 * when the chart cannot say (the label stays). An axis may drop a label; it may not cut one (D-157).
 */
export function wholeAxisLabel(label: string, x: number | null, axisWidth: number): string {
  return label === "" || x === null || fitsWhole(x, label, AXIS_FONT_PX, "middle", 0, axisWidth) ? label : "";
}

/** How far apart (px) a price-axis tick label and a last-value tag must be to read apart: half the tag's height plus half the label's. */
export const TAG_CLEARANCE = 16;

/** The height (px) of a price-axis tag in the library: its type plus 2.5 px of padding above and below (17 px at 12 px type). */
export const TAG_HEIGHT = AXIS_FONT_PX + 2 * ((2.5 / 12) * AXIS_FONT_PX);

/**
 * A price-axis tick label, or "" when it would not print whole: a last-value tag (the "Equity $51,457.00" pill) already sits on it, the tag
 * being the number that matters (D-181), or the pane's edge would cut it (D-199: "368.00" sat on the bottom edge and lost its lower half).
 * `y` is the tick's place on the axis, `tagYs` where the tags are drawn (`drawnTagYs`), `paneHeight` the axis' height; without one the
 * edge gives no verdict. An axis may drop a label; it may not cut one (D-180).
 */
export function clearTickLabel(label: string, y: number | null, tagYs: readonly number[], paneHeight: number | null = null): string {
  if (y === null) return label;
  if (paneHeight !== null && (y < AXIS_FONT_PX / 2 || y > paneHeight - AXIS_FONT_PX / 2)) return "";
  return tagYs.every((tag) => Math.abs(tag - y) >= TAG_CLEARANCE) ? label : "";
}

/**
 * Where the library draws its price-axis tags (D-200): `ys` are the tags' prices on the axis (`priceToCoordinate`), the answer their places,
 * in the same order. A tag sits on its price unless it would overlap another, and then the library pushes it a tag height off the one
 * nearer the centre, so a tag crowded by its neighbours is drawn up to several tag heights from its price and covers a tick that was clear of
 * the price. This is the library's own `_fixLabelOverlap` (5.2) for tags of one height: the tags above `centerY` (the main series' own tag,
 * the one it takes for the centre; the middle of the pane when unknown) stack upward, those below stack downward, and a tag within half
 * its height of the pane's edge is pulled inside. Calibration: `TAG_HEIGHT`, if the chart's type size ever changes.
 */
export function drawnTagYs(ys: readonly number[], paneHeight: number, centerY: number | null = null): number[] {
  const half = Math.floor(TAG_HEIGHT / 2);
  const center = centerY ?? paneHeight / 2;
  const at = ys.map((y) => (y > -half && y < half ? half : y > paneHeight - half && y < paneHeight + half ? paneHeight - half : y));
  const above = ys.flatMap((y, i) => (y <= center ? [i] : [])).sort((a, b) => ys[b]! - ys[a]!);
  const below = ys.flatMap((y, i) => (y > center ? [i] : []));
  if (above.length > 0 && below.length > 0) below.push(above[0]!);
  below.sort((a, b) => ys[a]! - ys[b]!);
  const stack = (views: number[], direction: 1 | -1) => {
    if (views.length === 0) return;
    let groupStart = 0;
    let room = Math.max(0, direction === 1 ? paneHeight / 2 - (at[views[0]!]! - TAG_HEIGHT / 2) : at[views[0]!]! - TAG_HEIGHT / 2 - paneHeight / 2);
    for (let n = 1; n < views.length; n++) {
      const [view, prev] = [views[n]!, views[n - 1]!];
      const [coordinate, prevCoordinate] = [at[view]!, at[prev]!];
      if (direction === 1 ? coordinate > prevCoordinate - TAG_HEIGHT : coordinate < prevCoordinate + TAG_HEIGHT) {
        at[view] = prevCoordinate - TAG_HEIGHT * direction;
        const edge = at[view]! - (direction * TAG_HEIGHT) / 2;
        if ((direction === 1 ? edge < 0 : edge > paneHeight) && room > 0) {
          // The group is up against the pane's edge: it moves back along the axis, as far as there is room.
          const shift = Math.min(direction === 1 ? -1 - edge : edge - paneHeight, room);
          for (const moved of views.slice(groupStart)) at[moved] = at[moved]! + direction * shift;
          room -= shift;
        }
      } else {
        groupStart = n;
        room = direction === 1 ? prevCoordinate - TAG_HEIGHT - coordinate : coordinate - (prevCoordinate + TAG_HEIGHT);
      }
    }
  };
  stack(above, 1);
  stack(below, -1);
  return at;
}

/**
 * The value a series' axis tag shows: the library prints the one at the last bar in view, so a chart scrolled back shows an older value than
 * the newest (D-200). `right` is the visible range's right edge as a bar index; the nearest value at or before it, null when there is none.
 */
export function valueAtOrBefore(values: readonly (number | null)[], right: number): number | null {
  for (let index = Math.min(Math.ceil(right), values.length - 1); index >= 0; index--) {
    const value = values[index];
    if (value !== null && value !== undefined) return value;
  }
  return null;
}

/**
 * The prices of the tags on a chart's price axis, for `clearTickLabel` to keep ticks out from under: each overlay's last value, each level line
 * that prints its number (a `plain` one prints none), and the last price. On the replay chart that is the session high and low, the prior close,
 * her position and stop, the last price and the lines' last values (D-181, D-196).
 */
export function axisTagPrices(overlayLasts: readonly (number | null)[], levels: readonly { price: number | null; plain?: boolean }[], last: number | null): number[] {
  return [...overlayLasts, ...levels.map((level) => (level.plain ? null : level.price)), last].filter((price): price is number => price !== null && Number.isFinite(price));
}

/** The "Source time" cell of a chart's data table: the New York day and time ("Fri 2026-10-23 10:07 AM"), never the raw UTC string (V-Technicals-05). */
export function sourceTimeLabel(t: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(t) ? formatEtDay(t) : `${formatEtDay(t)} ${formatEtTime(t)}`;
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

/**
 * Where a followed replay chart waits before the open: from `anchor` (the session's first bar) over `span` slots, so the axis starts at the
 * open, not in the pre-open lookback (D-099). Null from the first session bar on: the chart then follows the newest bar with the lookback
 * to its left. A pinned chart with a few session bars drew them against the left edge of a blank plot, and a time axis has ticks only at
 * bars, so it printed no label at all (D-186).
 */
export function pinnedRange(count: number, anchor: number, span: number): LogicalRange | null {
  return count <= anchor ? { from: anchor, to: anchor + span } : null;
}

/**
 * Does an update move a followed chart to its newest bar? Not before the open (`waiting`, D-186), and not once she has scrolled back: the view
 * is hers when its right edge is more than a bar and a half behind the newest bar the chart had (`visible` is the view before the update).
 * Otherwise it is parked at the newest bar and goes with it, from the first session bar on, whatever the data came from (the clock's Play,
 * a Pause in another window, the clock route: D-195).
 */
export function followsNewest(follow: boolean, visible: LogicalRange | null, lastIndex: number, waiting: LogicalRange | null): boolean {
  return follow && waiting === null && (visible === null || visible.to >= lastIndex - 1.5);
}

/**
 * The `rightOffset` to send to the time scale: nothing when it is already in force. The library moves the view to the offset
 * every time the option is set, even to the value it already has, so sending it with each data update snapped a chart she had
 * scrolled back (to read last week) to the newest bar the moment the next bar or refresh arrived.
 */
export function rightOffsetOption(applied: number | null, wanted: number): { rightOffset?: number } {
  return applied === wanted ? {} : { rightOffset: wanted };
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
