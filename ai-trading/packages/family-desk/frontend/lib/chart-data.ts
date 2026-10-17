import type {
  BusinessDay,
  CandlestickData,
  LineData,
  Time,
  UTCTimestamp,
  WhitespaceData,
} from "lightweight-charts";

export type ChartBar = { t: string; o: number | null; h: number | null; l: number | null; c: number | null };

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
