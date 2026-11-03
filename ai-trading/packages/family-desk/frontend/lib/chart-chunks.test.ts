import assert from "node:assert/strict";
import test from "node:test";
import type { UTCTimestamp } from "lightweight-charts";
import { ChunkedSeries } from "./chart-chunks.ts";

// The library series the chunks stand on, as far as `ChunkedSeries` drives one: it keeps its points by time, refuses a point older than its newest (as
// the library's `update` does) and remembers the options it was given.
type Point = { time: UTCTimestamp; value?: number };
const at = (time: number) => time as UTCTimestamp;
class FakeSeries {
  points: Point[] = [];
  options: Record<string, unknown> = {};
  setData(points: Point[]) {
    this.points = [...points];
  }
  update(point: Point) {
    const last = this.points[this.points.length - 1];
    if (last && point.time < last.time) throw new Error("Cannot update oldest data");
    if (last && point.time === last.time) this.points[this.points.length - 1] = point;
    else this.points.push(point);
  }
  applyOptions(options: Record<string, unknown>) {
    Object.assign(this.options, options);
  }
}
class FakeChart {
  added: FakeSeries[] = [];
  removed: FakeSeries[] = [];
  removeSeries(series: FakeSeries) {
    this.removed.push(series);
  }
}
const make = (join: boolean, size = 5) => {
  const chart = new FakeChart();
  const group = new ChunkedSeries<Point>(
    chart as never,
    () => {
      const series = new FakeSeries();
      chart.added.push(series);
      return series as never;
    },
    join,
    {},
    size,
  );
  return { chart, group };
};
const run = (series: unknown) => (series as FakeSeries).points.map((point) => point.time);
const points = (count: number, from = 1): Point[] => Array.from({ length: count }, (_, index) => ({ time: at(from + index), value: from + index }));

test("a short series is one run: the single series a chart had before", () => {
  const { chart, group } = make(true);
  group.setData(points(5));
  assert.equal(chart.added.length, 1);
  assert.deepEqual(run(group.tail), [1, 2, 3, 4, 5]);
});

test("setData cuts the points into runs of the given size, a line repeating the last point of the run before", () => {
  const stand = make(false);
  stand.group.setData(points(12));
  assert.deepEqual(stand.group.all.map(run), [[1, 2, 3, 4, 5], [6, 7, 8, 9, 10], [11, 12]]);
  const line = make(true);
  line.group.setData(points(12));
  assert.deepEqual(line.group.all.map(run), [[1, 2, 3, 4, 5], [5, 6, 7, 8, 9, 10], [10, 11, 12]]);
});

test("updates fill the newest run, replace its newest point, and start a run when it is full", () => {
  const { group } = make(true);
  group.setData(points(4));
  group.update({ time: at(5), value: 5 });
  group.update({ time: at(5), value: 50 }); // the forming candle again: no new point
  assert.deepEqual(group.all.map((series) => (series as unknown as FakeSeries).points.map((point) => point.value)), [[1, 2, 3, 4, 50]]);
  group.update({ time: at(6), value: 6 });
  assert.deepEqual(group.all.map(run), [[1, 2, 3, 4, 5], [5, 6]], "the full run is left alone and the new one joins on at its last point");
  for (let time = 7; time <= 11; time += 1) group.update({ time: at(time), value: time });
  assert.deepEqual(group.all.map(run), [[1, 2, 3, 4, 5], [5, 6, 7, 8, 9, 10], [10, 11]]);
});

test("the same points fed by setData or by update leave the same runs", () => {
  for (const join of [false, true]) {
    const whole = make(join);
    whole.group.setData(points(23));
    const grown = make(join);
    grown.group.setData(points(3));
    for (const point of points(20, 4)) grown.group.update(point);
    assert.deepEqual(grown.group.all.map(run), whole.group.all.map(run), `join ${join}`);
  }
});

test("a point older than the newest throws, as the library's update does", () => {
  const { group } = make(false);
  group.setData(points(7));
  assert.throws(() => group.update({ time: at(3) }));
});

test("fewer points drop the runs that are no longer needed", () => {
  const { chart, group } = make(false);
  group.setData(points(12));
  group.setData(points(6));
  assert.equal(group.all.length, 2);
  assert.equal(chart.removed.length, 1);
  assert.deepEqual(group.all.map(run), [[1, 2, 3, 4, 5], [6]]);
  group.setData([]);
  assert.equal(group.all.length, 1);
  assert.deepEqual(run(group.tail), []);
});

test("only the newest run carries the price tag and the last-price line, whatever was asked", () => {
  const { chart, group } = make(false);
  group.applyOptions({ lastValueVisible: true, priceLineVisible: true, color: "red" });
  group.setData(points(12));
  const shown = chart.added.map((series) => [series.options.lastValueVisible, series.options.priceLineVisible, series.options.color]);
  assert.deepEqual(shown, [[false, false, "red"], [false, false, "red"], [true, true, "red"]], "a run made later has the options set so far");
  group.update({ time: at(13), value: 13 });
  group.update({ time: at(14), value: 14 });
  group.update({ time: at(15), value: 15 });
  group.update({ time: at(16), value: 16 });
  assert.deepEqual(chart.added.map((series) => series.options.lastValueVisible), [false, false, false, true], "the tag moved to the run that started");
  group.applyOptions({ lastValueVisible: false });
  assert.deepEqual(chart.added.map((series) => series.options.lastValueVisible), [false, false, false, false]);
});

test("each run owns the times from its first point up to the next run's, and the crosshair reads whichever run holds the bar", () => {
  const { group } = make(true);
  group.setData(points(12));
  assert.deepEqual(group.spans().map(({ from, to }) => [from, to]), [[1, 6], [6, 11], [11, Number.POSITIVE_INFINITY]]);
  const seen = new Map<unknown, unknown>([[group.all[1], { value: 7 }]]);
  assert.deepEqual(group.read(seen), { value: 7 });
  assert.equal(group.read(new Map()), undefined);
});

test("destroy removes every run, and the stamp changes when a run comes or goes", () => {
  const { chart, group } = make(false);
  const first = group.stamp;
  group.setData(points(12));
  assert.notEqual(group.stamp, first);
  const before = group.stamp;
  group.update({ time: at(13), value: 13 });
  assert.equal(group.stamp, before, "a point into the newest run changes no run");
  group.destroy();
  assert.equal(chart.removed.length, 3);
});

test("cull hides the older runs that lie outside the view and keeps the newest shown", () => {
  const { chart, group } = make(false);
  group.setData(points(23)); // runs 1-5, 6-10, 11-15, 16-20, 21-23
  const visible = () => chart.added.map((series) => series.options.visible !== false);
  group.cull(7, 12);
  assert.deepEqual(visible(), [false, true, true, false, true], "the second and third hold times 7 to 12; the newest is never hidden");
  group.cull(1, 23);
  assert.deepEqual(visible(), [true, true, true, true, true], "the view reaches every run again");
  group.cull(30, 40);
  assert.deepEqual(visible(), [false, false, false, false, true], "a view past the data still shows the newest run");
  const calls = chart.added.map((series) => series.options.visible);
  group.cull(30, 40);
  assert.deepEqual(chart.added.map((series) => series.options.visible), calls, "no change, no call");
});
