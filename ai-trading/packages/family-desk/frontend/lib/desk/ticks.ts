// The one axis-tick algorithm for every small SVG chart (design-component-system 3.12). Pure numbers in, round numbers out.

export type TickOptions = {
  /** About this many ticks (the step is the smallest 1, 2, 5 or 10 times a power of ten that fits `target - 1` intervals). Default 5. */
  target?: number;
  /** Never step finer than this (1 for whole-dollar axes). */
  minStep?: number;
  /** Keep every tick within [min, max] for a chart that cannot draw past its domain. Default: the ticks cover the data. */
  inside?: boolean;
};

/** Round-number ticks over [min, max]; none when the range is flat or not a number. Ticks cover the data unless `inside` is set. */
export function niceTicks(min: number, max: number, { target = 5, minStep = 0, inside = false }: TickOptions = {}): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return [];
  const raw = (max - min) / Math.max(target - 1, 1);
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / magnitude;
  const step = Math.max((norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * magnitude, minStep);
  const first = (inside ? Math.ceil(min / step - 1e-9) : Math.floor(min / step + 1e-9)) * step;
  const last = (inside ? Math.floor(max / step + 1e-9) : Math.ceil(max / step - 1e-9)) * step;
  const ticks: number[] = [];
  // Snap to the step grid and trim float noise (0.6000000000000001); + 0 turns -0 into 0.
  for (let value = first; value <= last + step / 2; value += step) ticks.push(Number((Math.round(value / step) * step).toFixed(10)) + 0);
  return ticks;
}

export type LabelAnchor = "start" | "middle" | "end";

/**
 * How wide a label prints, in the chart's own units. 7 units a character at the charts' 11 px labels, in proportion at other sizes.
 * ponytail: an estimate, a little wide on purpose (a label dropped one pixel early is harmless, one cut is not); measure with
 * getBBox or canvas measureText if a font change ever shifts it.
 */
export const textWidth = (text: string, fontPx: number): number => (text.length * fontPx * 7) / 11;

/** The left and right edge of a label of `text` anchored at `x`. */
export function labelSpan(x: number, text: string, fontPx: number, anchor: LabelAnchor): [number, number] {
  const width = textWidth(text, fontPx);
  return anchor === "end" ? [x - width, x] : anchor === "middle" ? [x - width / 2, x + width / 2] : [x, x + width];
}

/**
 * True when the whole label lies inside [lo, hi]. An axis keeps a label whole or leaves it out; it never draws one cut at the edge
 * (D-157, D-180). Every axis, SVG or canvas, asks this before it prints a label.
 */
export function fitsWhole(x: number, text: string, fontPx: number, anchor: LabelAnchor, lo: number, hi: number): boolean {
  const [left, right] = labelSpan(x, text, fontPx, anchor);
  return left >= lo && right <= hi;
}
