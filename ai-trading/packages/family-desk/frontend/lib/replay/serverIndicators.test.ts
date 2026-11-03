import assert from "node:assert/strict";
import test from "node:test";
import { serverSeries } from "./serverIndicators.ts";

const row = (minute: number, vwap: number | null, ema9 = 10 + minute) => ({ t: `2026-04-07T14:0${minute}:00Z`, vwap, ema9, ema21: 20 + minute, rsi14: 50 + minute, macd: minute / 10, macd_signal: minute / 20, macd_hist: minute / 40 });
const bars = [0, 1, 2].map((minute) => ({ t: `2026-04-07T14:0${minute}:00Z` }));
const table = (rows: ReturnType<typeof row>[], interval = "1m") => ({ interval: interval as "1m", asOfBar: null, rows });

test("the server's rows are laid on the bars by bar open, a bar with no row reads unknown", () => {
  const series = serverSeries(bars, table([row(0, 1), row(2, 3)]), "1m");
  assert.deepEqual(series.vwap, [1, null, 3]);
  assert.deepEqual(series.ema9, [10, null, 12]);
  assert.deepEqual(series.ema21, [20, null, 22]);
  assert.deepEqual(series.rsi14, [50, null, 52]);
  assert.deepEqual(series.macd, { dif: [0, null, 0.2], signal: [0, null, 0.1], histogram: [0, null, 0.05] });
});

test("a table for another interval, or none, reads unknown everywhere", () => {
  assert.deepEqual(serverSeries(bars, table([row(0, 1)], "5m"), "1m").ema9, [null, null, null]);
  assert.deepEqual(serverSeries(bars, null, "1m").vwap, [null, null, null]);
  assert.deepEqual(serverSeries([], null, "1m").macd, { dif: [], signal: [], histogram: [] });
});

test("the forming candle without a VWAP of its own reads the one before it (D-168), only when it has a row", () => {
  const forming = bars[2]!.t;
  assert.deepEqual(serverSeries(bars, table([row(0, 1), row(1, 2), row(2, null)]), "1m", forming).vwap, [1, 2, 2]);
  assert.deepEqual(serverSeries(bars, table([row(0, 1), row(1, 2)]), "1m", forming).vwap, [1, 2, null], "no row for it: not filled");
  assert.deepEqual(serverSeries(bars, table([row(0, 1), row(1, 2), row(2, null)]), "1m", null).vwap, [1, 2, null], "not the forming candle: not filled");
});

// The answer laid out in full, the way the first version did it: a map of the rows by start time, one lookup a bar.
function reference(barList: Array<{ t: string }>, tableIn: ReturnType<typeof table> | null, interval: string, formingAt: string | null) {
  const byStart = new Map<number, ReturnType<typeof row>>();
  if (tableIn !== null && tableIn.interval === interval) for (const item of tableIn.rows) byStart.set(Date.parse(item.t), item);
  const pick = (read: (item: ReturnType<typeof row>) => number | null) => barList.map((bar) => { const found = byStart.get(Date.parse(bar.t)); return found ? read(found) : null; });
  const out = { vwap: pick((item) => item.vwap), ema9: pick((item) => item.ema9), ema21: pick((item) => item.ema21), rsi14: pick((item) => item.rsi14), macd: { dif: pick((item) => item.macd), signal: pick((item) => item.macd_signal), histogram: pick((item) => item.macd_hist) } };
  const newest = barList.length - 1;
  if (formingAt !== null && newest > 0 && barList[newest]!.t === formingAt && out.vwap[newest] === null && byStart.has(Date.parse(barList[newest]!.t))) out.vwap[newest] = out.vwap[newest - 1] ?? null;
  return out;
}

test("a start time spelled another way still finds its row, and rows before the first bar are skipped", () => {
  const spelled = [{ t: "2026-04-07T14:00:00+00:00" }, { t: "2026-04-07T14:01:00.000Z" }];
  const rows = [{ ...row(0, 1), t: "2026-04-07T13:59:00Z" }, { ...row(1, 2), t: "2026-04-07T14:01:00Z" }];
  const series = serverSeries(spelled, table(rows), "1m");
  assert.deepEqual(series.vwap, [null, 2]);
});

test("a poll that changes only the tail gives what laying every bar out again gives (D-217)", () => {
  // A small seeded generator: the same run every time.
  let seed = 7;
  const random = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const start = Date.parse("2026-04-07T13:00:00Z");
  const at = (minute: number) => new Date(start + minute * 60_000).toISOString();
  let bars: Array<{ t: string }> = Array.from({ length: 40 }, (_, minute) => ({ t: at(minute) }));
  let rows = bars.filter(() => random() < 0.9).map((bar, index) => ({ ...row(0, index), t: bar.t, ema9: index * 1.5 }));
  for (let step = 0; step < 200; step += 1) {
    const roll = random();
    if (roll < 0.3) bars = [...bars, { t: at(bars.length) }]; // a new bar
    else if (roll < 0.45) bars = [...bars.slice(0, -1), { t: bars[bars.length - 1]!.t }]; // the forming candle comes back as a new object
    else if (roll < 0.6 && rows.length > 0) rows = [...rows.slice(0, -1), { ...rows[rows.length - 1]!, vwap: random() < 0.3 ? null : step, ema9: step }]; // the newest row moves
    else if (roll < 0.75) rows = [...rows, { ...row(0, step), t: bars[bars.length - 1]!.t, ema9: step }].filter((item, index, list) => index === list.findIndex((other) => other.t === item.t) || item === list[list.length - 1]); // a row for the newest bar
    else if (roll < 0.8 && rows.length > 3) rows = rows.slice(0, -2); // the table is cut back
    else if (roll < 0.85) rows = [...rows]; // a poll with nothing new: same rows, new array
    else if (roll < 0.88) rows = rows.map((item, index) => (index === 2 ? { ...item, ema21: step } : item)); // an old row corrected
    const forming = random() < 0.5 ? bars[bars.length - 1]!.t : null;
    const interval = random() < 0.05 ? "5m" : "1m";
    const asked = table(rows.sort((a, b) => Date.parse(a.t) - Date.parse(b.t)).filter((item, index, list) => index === 0 || item.t !== list[index - 1]!.t));
    assert.deepEqual(serverSeries(bars, asked, interval, forming), reference(bars, asked, interval, forming), `step ${step}`);
  }
});

test("rows or bars out of order are laid by their start, after calls that were in order and before ones that are (D-217)", () => {
  const a = [0, 1, 2].map((minute) => ({ t: `2026-04-07T14:0${minute}:00Z` }));
  const inOrder = table([row(0, 1), row(1, 2), row(2, 3)]);
  assert.deepEqual(serverSeries(a, inOrder, "1m").vwap, [1, 2, 3]);
  const shuffled = table([row(2, 3), row(0, 1)]);
  assert.deepEqual(serverSeries(a, shuffled, "1m").vwap, [1, null, 3], "the shuffled table, same bars");
  assert.deepEqual(serverSeries([a[2]!, a[0]!, a[1]!], inOrder, "1m").vwap, [3, 1, 2], "shuffled bars");
  assert.deepEqual(serverSeries(a, inOrder, "1m").vwap, [1, 2, 3], "and in order again");
  assert.deepEqual(serverSeries([...a, { t: "2026-04-07T14:03:00Z" }], table([row(0, 1), row(1, 2), row(2, 3), { ...row(3, 4), t: "2026-04-07T14:03:00Z" }]), "1m").vwap, [1, 2, 3, 4], "one bar on");
});
