import type { IChartApi, ISeriesApi, SeriesType, Time } from "lightweight-charts";
import { timeKey } from "./chart-data.ts";

// One library series is rebuilt in full whenever a point is added to it: `update` marks the series' data dirty and the next draw maps every row of it into
// a drawing item (colours and all). A 1m replay chart holds 6,000 bars in each of its six or so series, so a new bar rebuilt about 36,000 items, in the draw
// and in `update` itself, on every bar: the cost that was left of D-212 (D-217). A `ChunkedSeries` is the same series cut into runs of `size` points, each run its
// own library series, so a new bar dirties only the newest run (at most `size` points) and the older runs are never touched again. Short charts (a daily chart,
// a short intraday one) stay one run: the same single series as before.
//
// Cutting the series alone does not help: when a bar adds a time to the chart, the library hands EVERY series its whole data again (not only the one that got the
// point), and each series then rebuilds all its drawing items on the next draw. A series that is not visible is skipped by that draw, though, so the older runs that
// lie outside the view are hidden (`cull`) and the newest run stays shown: a new bar then costs the runs in view, not all 6,000 bars of every series.

export const CHUNK_BARS = 500;

let made = 0;

type LibSeries = ISeriesApi<SeriesType, Time>;
type Pill = { lastValueVisible: boolean; priceLineVisible: boolean };
type Run<P> = {
  series: LibSeries;
  /** Time key of the first point this run owns (Infinity while it holds none), and of the newest point it holds. */
  first: number;
  last: number;
  /** Points this run owns: the one it repeats from the run before (`join`) is not counted. */
  own: number;
  lastPoint: P | null;
  shown: Pill | null;
  visible: boolean;
};

/**
 * What the chart feeds a series: `setData` and `update`, as `syncSeries` calls them, plus the few things the chart does to the series itself. The price
 * tag and the last-price line belong to the newest run only (an older run's last value is not the value now), whatever the caller asks for.
 */
export class ChunkedSeries<P extends { time: Time }> {
  private readonly runs: Run<P>[] = [];
  private readonly options: Record<string, unknown> = {};
  private readonly pill: Pill;
  /** Changes when a run is added or removed, so what hangs on the runs (stacking order, markers, price lines) knows to be done again. */
  version = 0;
  private readonly id = ++made;

  /** Names this series and its runs as they are now: it differs after a run comes or goes, and from every other `ChunkedSeries`. */
  get stamp(): string {
    return `${this.id}.${this.version}`;
  }

  private readonly chart: IChartApi;
  private readonly create: () => LibSeries;
  private readonly join: boolean;
  private readonly size: number;

  /**
   * `create` adds one library series to the chart, with the options the series starts with. `join` repeats the last point of a run as the first of the
   * next, so a line is not broken between two runs. `pill` is the tag and last-price line the newest run starts with.
   */
  constructor(chart: IChartApi, create: () => LibSeries, join: boolean, pill: Partial<Pill> = {}, size = CHUNK_BARS) {
    this.chart = chart;
    this.create = create;
    this.join = join;
    this.size = size;
    this.pill = { lastValueVisible: pill.lastValueVisible ?? true, priceLineVisible: pill.priceLineVisible ?? true };
    this.addRun();
  }

  /** The newest run: the series a price line, the price scale's formatter or a coordinate is asked of. Undefined once the series is gone. */
  get tail(): LibSeries | undefined {
    return this.runs[this.runs.length - 1]?.series;
  }

  /** Every run's series, oldest first. */
  get all(): LibSeries[] {
    return this.runs.map((run) => run.series);
  }

  /** The time span each run owns, oldest first: a run owns the times from its first point up to the first point of the next. For the markers, which hang on a run. */
  spans(): Array<{ series: LibSeries; from: number; to: number }> {
    return this.runs.map((run, index) => ({ series: run.series, from: run.first, to: this.runs[index + 1]?.first ?? Number.POSITIVE_INFINITY }));
  }

  /** The value the library holds for the crosshair's bar: whichever run has it. */
  read(seriesData: ReadonlyMap<unknown, unknown>): unknown {
    for (const run of this.runs) {
      const found = seriesData.get(run.series);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  applyOptions(options: Record<string, unknown>): void {
    const { lastValueVisible, priceLineVisible, ...rest } = options;
    if (typeof lastValueVisible === "boolean") this.pill.lastValueVisible = lastValueVisible;
    if (typeof priceLineVisible === "boolean") this.pill.priceLineVisible = priceLineVisible;
    if (Object.keys(rest).length > 0) {
      Object.assign(this.options, rest);
      for (const run of this.runs) run.series.applyOptions(rest);
    }
    this.syncPill();
  }

  setData(points: P[]): void {
    const count = Math.max(1, Math.ceil(points.length / this.size));
    while (this.runs.length < count) this.addRun();
    while (this.runs.length > count) this.dropRun();
    this.runs.forEach((run, index) => {
      const from = index * this.size;
      const own = points.slice(from, from + this.size);
      const given = this.join && index > 0 ? [points[from - 1]!, ...own] : own;
      run.series.setData(given);
      run.own = own.length;
      run.first = own.length > 0 ? timeKey(own[0]!.time) : Number.POSITIVE_INFINITY;
      run.last = given.length > 0 ? timeKey(given[given.length - 1]!.time) : Number.NEGATIVE_INFINITY;
      run.lastPoint = given[given.length - 1] ?? null;
    });
  }

  /** Adds a point at the end, or replaces the newest one. A point older than the newest throws, as the library's own `update` does. */
  update(point: P): void {
    const key = timeKey(point.time);
    let run = this.runs[this.runs.length - 1]!;
    if (key > run.last && run.own >= this.size) {
      const full = run;
      run = this.addRun();
      if (this.join && full.lastPoint !== null) {
        run.series.setData([full.lastPoint]);
        run.last = full.last;
      }
    }
    run.series.update(point);
    if (key > run.last) {
      run.own += 1;
      run.last = key;
    }
    if (run.first === Number.POSITIVE_INFINITY) run.first = key;
    run.lastPoint = point;
  }

  /**
   * Shows the runs that hold a time from `from` to `to` (time keys) and hides the others, except the newest run, which stays shown: its price tag and last-price line
   * are the chart's whatever part is in view. A hidden run keeps its data; it draws again, and rebuilds once, when the view reaches it.
   */
  cull(from: number, to: number): void {
    const last = this.runs.length - 1;
    this.runs.forEach((run, index) => {
      const wanted = index === last || (run.first <= to && run.last >= from);
      if (run.visible === wanted) return;
      run.series.applyOptions({ visible: wanted });
      run.visible = wanted;
    });
  }

  destroy(): void {
    while (this.runs.length > 0) this.dropRun();
  }

  private addRun(): Run<P> {
    const series = this.create();
    if (Object.keys(this.options).length > 0) series.applyOptions(this.options);
    const run: Run<P> = { series, first: Number.POSITIVE_INFINITY, last: Number.NEGATIVE_INFINITY, own: 0, lastPoint: null, shown: null, visible: true };
    this.runs.push(run);
    this.version += 1;
    this.syncPill();
    return run;
  }

  private dropRun(): void {
    // The run stays the newest until the library has taken it out: removing a series makes the library format its ticks, and that asks for the newest run.
    const run = this.runs[this.runs.length - 1]!;
    this.chart.removeSeries(run.series);
    this.runs.pop();
    this.version += 1;
    if (this.runs.length > 0) this.syncPill();
  }

  private syncPill(): void {
    const last = this.runs.length - 1;
    this.runs.forEach((run, index) => {
      const want: Pill = index === last ? this.pill : { lastValueVisible: false, priceLineVisible: false };
      if (run.shown?.lastValueVisible === want.lastValueVisible && run.shown.priceLineVisible === want.priceLineVisible) return;
      run.series.applyOptions(want);
      run.shown = { ...want };
    });
  }
}
