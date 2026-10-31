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
