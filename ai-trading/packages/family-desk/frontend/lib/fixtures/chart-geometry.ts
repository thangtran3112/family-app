export type NumericPoint = Readonly<{ label: string; value: number }>;

export function divergingBars(points: readonly NumericPoint[]) {
  if (points.length === 0) return [];

  const minimum = Math.min(0, ...points.map(({ value }) => value));
  const maximum = Math.max(0, ...points.map(({ value }) => value));
  const range = maximum - minimum;
  const baselinePercent = range === 0 ? 50 : (maximum / range) * 100;

  return points.map(({ label, value }) => ({
    label,
    value,
    baselinePercent,
    topPercent: range === 0 || value < 0 ? baselinePercent : ((maximum - value) / range) * 100,
    heightPercent: range === 0 ? 0 : (Math.abs(value) / range) * 100,
  }));
}

export function lineCoordinates(
  values: readonly number[],
  width = 100,
  height = 100,
  domain?: Readonly<{ minimum: number; maximum: number }>,
) {
  if (values.length === 0) return [];

  const minimum = domain?.minimum ?? Math.min(...values);
  const maximum = domain?.maximum ?? Math.max(...values);
  const range = maximum - minimum;

  return values.map((value, index) => ({
    x: values.length === 1 ? width / 2 : (index / (values.length - 1)) * width,
    y: range === 0 ? height / 2 : ((maximum - value) / range) * height,
  }));
}

export function scalePercent(value: number, minimum: number, maximum: number): number {
  return maximum === minimum ? 50 : ((value - minimum) / (maximum - minimum)) * 100;
}
