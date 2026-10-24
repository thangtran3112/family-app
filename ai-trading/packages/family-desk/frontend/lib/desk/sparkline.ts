// A small area sparkline as SVG path data (the fire thumbnail on D9). Pure, so it is testable and needs no
// chart library for a 40-bar picture.
export type Sparkline = { line: string; area: string; last: { x: number; y: number } | null; up: boolean };

export function sparkline(values: ReadonlyArray<number | null>, width: number, height: number, pad = 2): Sparkline {
  const points = values.flatMap((value, index) => (value !== null && Number.isFinite(value) ? [{ index, value }] : []));
  if (points.length < 2) return { line: "", area: "", last: null, up: true };
  const min = Math.min(...points.map((point) => point.value));
  const max = Math.max(...points.map((point) => point.value));
  const span = max - min || 1;
  const step = (width - pad * 2) / Math.max(values.length - 1, 1);
  const xy = points.map(({ index, value }) => ({ x: pad + index * step, y: pad + (1 - (value - min) / span) * (height - pad * 2) }));
  const line = xy.map((point, position) => `${position === 0 ? "M" : "L"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" ");
  const first = xy[0]!;
  const last = xy[xy.length - 1]!;
  const floor = (height - pad).toFixed(1);
  const area = `${line} L${last.x.toFixed(1)} ${floor} L${first.x.toFixed(1)} ${floor} Z`;
  return { line, area, last, up: points[points.length - 1]!.value >= points[0]!.value };
}
