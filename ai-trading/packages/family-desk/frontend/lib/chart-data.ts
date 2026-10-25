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
