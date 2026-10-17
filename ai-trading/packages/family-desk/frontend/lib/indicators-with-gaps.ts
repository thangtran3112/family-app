import { calcEMA, calcMACD, calcRSI } from "./indicators.ts";

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
