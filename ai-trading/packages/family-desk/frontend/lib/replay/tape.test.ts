import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_BIG_PRINT_USD, feedLabel, fastTapeText, filterById, haltedTapeText, isBigPrint, paceLevel, paceText, SIZE_FILTERS, tapeQuery, tapeRows, tickTone } from "./tape.ts";
import type { TapeRow } from "./feedState.ts";

test("size chips send min size, and only Big only sends the big-print notional", () => {
  assert.equal(DEFAULT_BIG_PRINT_USD, 200_000);
  assert.deepEqual(SIZE_FILTERS.map((filter) => filter.label), ["All", "≥100", "≥1,000", "Big only"]);
  assert.deepEqual(tapeQuery(filterById("all"), 250_000), { minSize: 0, minNotional: 0 });
  assert.deepEqual(tapeQuery(filterById("100"), 250_000), { minSize: 100, minNotional: 0 }, "a size chip ignores the big-print notional");
  assert.deepEqual(tapeQuery(filterById("1000"), null), { minSize: 1000, minNotional: 0 });
  assert.deepEqual(tapeQuery(filterById("big"), null), { minSize: 0, minNotional: 200_000 }, "no API value falls back to the default");
  assert.deepEqual(tapeQuery(filterById("big"), 250_000), { minSize: 0, minNotional: 250_000 }, "the API's own big_print_usd wins");
});

test("a print is big when price times size reaches the big-print threshold", () => {
  assert.equal(isBigPrint({ price: 188.05, size: 1100 }, null), true, "206,855 clears the 200,000 default");
  assert.equal(isBigPrint({ price: 100, size: 2000 }, null), true, "exactly the threshold counts");
  assert.equal(isBigPrint({ price: 100, size: 1999 }, null), false);
  assert.equal(isBigPrint({ price: 188.05, size: 1100 }, 250_000), false);
  assert.equal(tickTone(1), "up");
  assert.equal(tickTone(-1), "down");
  assert.equal(tickTone(0), "same");
});

test("tape rows read newest first, with the limit applied to the newest rows", () => {
  const tape: TapeRow[] = [
    { t: "2026-04-07T14:07:10.000Z", price: 188, size: 100, tick: 0 },
    { t: "2026-04-07T14:07:11.000Z", price: 188.05, size: 1500, tick: 1 },
    { t: "2026-04-07T14:07:11.900Z", price: 188.04, size: 1000, tick: -1 },
  ];
  const view = { tape, tapeMeta: { feed: "sip" as const, count: 3, volume: 2600, shown: 3, bigPrintUsd: 200_000, pace: null } };
  assert.deepEqual(tapeRows(view), [
    { key: "2026-04-07T14:07:11.900Z:2", t: "2026-04-07T14:07:11.900Z", price: "188.04", size: "1,000", tone: "down", big: false },
    { key: "2026-04-07T14:07:11.000Z:1", t: "2026-04-07T14:07:11.000Z", price: "188.05", size: "1,500", tone: "up", big: true },
    { key: "2026-04-07T14:07:10.000Z:0", t: "2026-04-07T14:07:10.000Z", price: "188.00", size: "100", tone: "same", big: false },
  ]);
  assert.deepEqual(tapeRows({ tape, tapeMeta: null }, 2).map((row) => row.price), ["188.04", "188.05"]);

  const long: TapeRow[] = Array.from({ length: 130 }, () => ({ t: "2026-04-07T14:07:00.000Z", price: 100, size: 1, tick: 0 as const }));
  const capped = tapeRows({ tape: long, tapeMeta: null });
  assert.equal(capped.length, 120, "the default limit keeps a fast tape cheap to paint");
  assert.equal(capped.at(-1)?.key, "2026-04-07T14:07:00.000Z:10", "the oldest drawn row is index 10 of 130");
});

test("feed labels and the fast-tape note are the exact Practice copy", () => {
  assert.equal(feedLabel("sip"), "Consolidated tape · all US exchanges");
  assert.equal(feedLabel("iex"), "IEX prints only · about 4% of volume · bar volume is consolidated");
  assert.equal(fastTapeText({ shown: 500, count: 1043 }), "Fast tape · showing the latest 500 of 1,043 prints");
  assert.equal(fastTapeText({ shown: 2, count: 2 }), null, "nothing capped, no note");
  assert.equal(fastTapeText({ shown: 1043, count: 1043 }), null);
  assert.equal(fastTapeText(null), null);
});

test("pace text names the prints, shares, band and average when the API gives them", () => {
  assert.equal(paceText(null), "Pace · waiting for prints");
  assert.equal(paceText({ printsPerSecond: 12.4, sharesPerSecond: 3400, band: "busy", timesAverage: 1.8 }), "12 prints/s · 3,400 sh/s · Busy · 1.8x avg");
  assert.equal(paceText({ printsPerSecond: 4.5, sharesPerSecond: 800, band: null, timesAverage: null }), "4.5 prints/s · 800 sh/s", "under 10 prints/s keeps one decimal");
  assert.equal(paceText({ printsPerSecond: 15.4, sharesPerSecond: 2500, band: null, timesAverage: 2 }), "15 prints/s · 2,500 sh/s · 2x avg", "a whole multiple prints without a decimal");
  assert.equal(paceText({ printsPerSecond: 0.5, sharesPerSecond: 0, band: "quiet", timesAverage: null }), "0.5 prints/s · 0 sh/s · Quiet");
});

test("pace level fills the meter from the band, else from a log scale of shares per second", () => {
  assert.equal(paceLevel(null), 0);
  assert.equal(paceLevel({ printsPerSecond: 1, sharesPerSecond: 99_999, band: "quiet", timesAverage: null }), 0.2);
  assert.equal(paceLevel({ printsPerSecond: 1, sharesPerSecond: 0, band: "steady", timesAverage: null }), 0.5);
  assert.equal(paceLevel({ printsPerSecond: 1, sharesPerSecond: 0, band: "busy", timesAverage: null }), 0.78);
  assert.equal(paceLevel({ printsPerSecond: 1, sharesPerSecond: 0, band: "frantic", timesAverage: null }), 1);
  assert.equal(paceLevel({ printsPerSecond: 1, sharesPerSecond: 0, band: null, timesAverage: null }), 0);
  assert.equal(paceLevel({ printsPerSecond: 1, sharesPerSecond: 9, band: null, timesAverage: null }), 0.2, "log10(10) / 5");
  assert.equal(paceLevel({ printsPerSecond: 1, sharesPerSecond: 1e9, band: null, timesAverage: null }), 1, "capped at 1");
});

test("a silent tape reads as a possible halt, in seconds then minutes", () => {
  assert.equal(haltedTapeText(null), null);
  assert.equal(haltedTapeText(95), "No prints for 95 s · the stock may be halted");
  assert.equal(haltedTapeText(134 + 60), "No prints for 3 min 14 s · the stock may be halted");
});
