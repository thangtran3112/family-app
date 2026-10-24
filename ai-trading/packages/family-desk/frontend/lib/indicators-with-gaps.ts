import { calcEMA, calcMA, calcMACD, calcRSI, calcVWAP } from "./indicators.ts";

type NullableValues = Array<number | null>;

function finiteSegments(values: NullableValues, calculate: (segment: number[]) => NullableValues): NullableValues {
  const output = new Array<number | null>(values.length).fill(null);
  let start = 0;
  while (start < values.length) {
    while (start < values.length && (values[start] === null || !Number.isFinite(values[start]))) start++;
    if (start === values.length) break;
    let end = start;
    while (end < values.length && values[end] !== null && Number.isFinite(values[end])) end++;
    const segment = values.slice(start, end) as number[];
    calculate(segment).forEach((value, index) => {
      output[start + index] = value !== null && Number.isFinite(value) ? value : null;
    });
    start = end;
  }
  return output;
}

export function calcEMAWithGaps(values: NullableValues, period: number): NullableValues {
  return finiteSegments(values, (segment) => calcEMA(segment, period));
}

export function calcMAWithGaps(values: NullableValues, period: number): NullableValues {
  return finiteSegments(values, (segment) => calcMA(segment, period));
}

export function calcRSIWithGaps(values: NullableValues, period = 14): NullableValues {
  return finiteSegments(values, (segment) => calcRSI(segment, period));
}

export function calcMACDWithGaps(values: NullableValues) {
  const dif = new Array<number | null>(values.length).fill(null);
  const signal = new Array<number | null>(values.length).fill(null);
  const histogram = new Array<number | null>(values.length).fill(null);
  let start = 0;
  while (start < values.length) {
    while (start < values.length && (values[start] === null || !Number.isFinite(values[start]))) start++;
    if (start === values.length) break;
    let end = start;
    while (end < values.length && values[end] !== null && Number.isFinite(values[end])) end++;
    const result = calcMACD(values.slice(start, end) as number[]);
    for (let index = 0; index < end - start; index++) {
      dif[start + index] = Number.isFinite(result.dif[index]) ? result.dif[index] : null;
      signal[start + index] = Number.isFinite(result.signal[index]) ? result.signal[index] : null;
      histogram[start + index] = Number.isFinite(result.histogram[index]) ? result.histogram[index] : null;
    }
    start = end;
  }
  return { dif, signal, histogram };
}

export type NullableVwapBar = { t: string; h: number | null; l: number | null; c: number | null; v: number | null };

/**
 * VWAP over bars that may have gaps. A gap bar reads as unknown and contributes nothing; it does not
 * restart the session sum (VWAP only resets at the New York trading day, unlike the warm-up indicators).
 */
export function calcVWAPWithGaps(bars: NullableVwapBar[]): NullableValues {
  const output = new Array<number | null>(bars.length).fill(null);
  const known: number[] = [];
  const complete: Array<{ t: string; h: number; l: number; c: number; v: number }> = [];
  bars.forEach((bar, index) => {
    const { h, l, c, v } = bar;
    if (h === null || l === null || c === null || v === null || ![h, l, c, v].every(Number.isFinite)) return;
    known.push(index);
    complete.push({ t: bar.t, h, l, c, v });
  });
  calcVWAP(complete).forEach((value, position) => {
    output[known[position]!] = value !== null && Number.isFinite(value) ? value : null;
  });
  return output;
}
