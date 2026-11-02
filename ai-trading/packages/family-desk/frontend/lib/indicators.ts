// Adapted from Vibe-Trading `frontend/src/lib/indicators.ts` at commit
// `8be01c8fe25f25c2e699ea8d2ab0b322f58c8c9e`, MIT License. Copied unchanged except
// `tradingDay` and `calcVWAP` at the end (Family Desk additions, 02m §a3.3), and three audit changes
// (2026-11-01) that make these functions agree with the backend's `core/indicators.py`, the single source of
// truth: `calcEMA` seeds with the first value (not an SMA), `calcRSI` reads 50 when nothing moved, and
// `calcVWAP` leaves out pre- and after-hours bars (a future's by the New York clock). `lib/indicators.golden.test.ts` pins all three against
// `contracts/fixtures/indicator-golden-v1`. See `indicators.LICENSE` and `packages/family-desk/THIRD_PARTY_NOTICES.md`.
type N = number | null;

export function calcMA(data: number[], period: number): N[] {
  return data.map((_, i) => {
    if (i < period - 1) return null;
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += data[j];
    return s / period;
  });
}

/**
 * EMA with alpha = 2 / (period + 1), seeded with the FIRST value and unknown (null) until `period` values exist:
 * the backend's `ema` (pandas `ewm(adjust=False, min_periods=period)`). TA-Lib and StockCharts seed with the SMA of
 * the first `period` values instead; the two differ only by a transient that decays by (1 - alpha) per bar
 * (about 1e-12 after 300 bars of a 21-EMA).
 */
export function calcEMA(data: number[], period: number): N[] {
  const k = 2 / (period + 1);
  const out: N[] = [];
  let ema: number | null = null;
  for (let i = 0; i < data.length; i++) {
    ema = ema === null ? data[i] : data[i] * k + ema * (1 - k);
    out.push(i < period - 1 ? null : ema);
  }
  return out;
}

export function calcBOLL(data: number[], period = 20, mult = 2) {
  const mid = calcMA(data, period);
  const upper: N[] = [];
  const lower: N[] = [];
  for (let i = 0; i < data.length; i++) {
    if (mid[i] === null) { upper.push(null); lower.push(null); continue; }
    let sq = 0;
    for (let j = i - period + 1; j <= i; j++) sq += (data[j] - mid[i]!) ** 2;
    const std = Math.sqrt(sq / period);
    upper.push(mid[i]! + mult * std);
    lower.push(mid[i]! - mult * std);
  }
  return { upper, mid, lower };
}

export function calcMACD(data: number[], fast = 12, slow = 26, sig = 9) {
  const ef = calcEMA(data, fast);
  const es = calcEMA(data, slow);
  const dif: N[] = data.map((_, i) =>
    ef[i] !== null && es[i] !== null ? ef[i]! - es[i]! : null
  );

  // Signal = EMA of non-null DIF values
  const valid: number[] = [];
  const idx: number[] = [];
  dif.forEach((v, i) => { if (v !== null) { valid.push(v); idx.push(i); } });
  const sigEma = calcEMA(valid, sig);

  const signal: N[] = new Array(data.length).fill(null);
  const hist: N[] = new Array(data.length).fill(null);
  idx.forEach((ii, j) => {
    if (sigEma[j] !== null) {
      signal[ii] = sigEma[j];
      hist[ii] = dif[ii]! - sigEma[j]!;
    }
  });
  return { dif, signal, histogram: hist };
}

export function calcRSI(data: number[], period = 14): N[] {
  if (data.length < period + 1) return data.map(() => null);
  const out: N[] = new Array(data.length).fill(null);
  let avgG = 0, avgL = 0;
  for (let i = 1; i <= period; i++) {
    const c = data[i] - data[i - 1];
    if (c > 0) avgG += c; else avgL -= c;
  }
  avgG /= period;
  avgL /= period;
  out[period] = rsiValue(avgG, avgL);
  for (let i = period + 1; i < data.length; i++) {
    const c = data[i] - data[i - 1];
    avgG = (avgG * (period - 1) + (c > 0 ? c : 0)) / period;
    avgL = (avgL * (period - 1) + (c < 0 ? -c : 0)) / period;
    out[i] = rsiValue(avgG, avgL);
  }
  return out;
}

/** 100 when there were no losses, 0 when there were no gains, 50 when nothing moved (the backend's `rsi`). */
function rsiValue(avgG: number, avgL: number): number {
  if (avgG === 0 && avgL === 0) return 50;
  return avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
}

export function calcKDJ(highs: number[], lows: number[], closes: number[], period = 9) {
  const n = closes.length;
  const k: N[] = new Array(n).fill(null);
  const d: N[] = new Array(n).fill(null);
  const j: N[] = new Array(n).fill(null);
  if (n < period) return { k, d, j };

  let pk = 50, pd = 50;
  for (let i = period - 1; i < n; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let p = i - period + 1; p <= i; p++) {
      if (highs[p] > hi) hi = highs[p];
      if (lows[p] < lo) lo = lows[p];
    }
    const rsv = hi === lo ? 50 : ((closes[i] - lo) / (hi - lo)) * 100;
    pk = (pk * 2 + rsv) / 3;
    pd = (pd * 2 + pk) / 3;
    k[i] = pk;
    d[i] = pd;
    j[i] = 3 * pk - 2 * pd;
  }
  return { k, d, j };
}

// ---- Family Desk addition (not part of the Vibe-Trading original). ----

const etDayFormat = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });

/** The New York trading day of a bar: `YYYY-MM-DD` for a timestamp, the date itself for a daily bar. */
export function tradingDay(t: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : etDayFormat.format(new Date(t));
}

export type VwapBar = { t: string; h: number; l: number; c: number; v: number; ext?: boolean };

const etClockFormat = new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/**
 * Whether a bar starts in the 09:30-16:00 New York window: the regular session, the only bars the backend's `session_vwap` counts
 * (`annotate(bars, "future")` calls the overnight Globex session from 18:00 and the 16:00-17:00 window "pre" and "post").
 * The API never flags a futures bar `ext`, so the clock decides; the same clock settles a forming bar, which has no flag yet (D-168).
 * ponytail: no calendar; a CME early close needs none, because no bar follows it until Globex reopens at 18:00.
 */
export function inRegularWindow(t: string): boolean {
  const clock = etClockFormat.format(new Date(t));
  return clock >= "09:30" && clock < "16:00";
}

/**
 * Session-anchored VWAP of the typical price (h+l+c)/3, reset at each New York trading day. A pre- or after-hours bar
 * (`ext`) reads unknown and adds nothing: the backend's `session_vwap` covers the regular session only. A future
 * is the same window (09:30-16:00 New York), found by the clock instead of `ext`.
 */
export function calcVWAP(bars: VwapBar[], asset: "stock" | "future" = "stock"): N[] {
  let day = "";
  let priceVolume = 0;
  let volume = 0;
  return bars.map((bar) => {
    if (asset === "future" ? !inRegularWindow(bar.t) : bar.ext) return null;
    const barDay = tradingDay(bar.t);
    if (barDay !== day) {
      day = barDay;
      priceVolume = 0;
      volume = 0;
    }
    priceVolume += ((bar.h + bar.l + bar.c) / 3) * bar.v;
    volume += bar.v;
    return volume > 0 ? priceVolume / volume : null;
  });
}
