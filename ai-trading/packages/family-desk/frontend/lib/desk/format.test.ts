import assert from "node:assert/strict";
import test from "node:test";
import {
  changeTone,
  formatAgo,
  formatCompact,
  formatAsOfText,
  formatEtClock,
  formatEtDay,
  formatEtStamp,
  formatEtTime,
  formatEtTimeZone,
  formatEtWeekdayTime,
  formatLastCloseLine,
  formatMetric,
  formatPrice,
  formatRatio,
  formatSignedPct,
  initialOf,
} from "./format.ts";

test("Eastern time formatting follows daylight saving", () => {
  assert.equal(formatEtTime("2026-10-23T19:45:00Z"), "3:45 PM");
  assert.equal(formatEtTimeZone("2026-10-23T20:00:00Z"), "4:00 PM ET");
  assert.equal(formatEtTime("2026-12-01T14:30:00Z"), "9:30 AM");
  assert.equal(formatEtClock("2026-10-23T14:41:12Z"), "10:41:12 AM ET");
  assert.equal(formatEtStamp("2026-10-23T19:45:00Z"), "2026-10-23 15:45");
  assert.equal(formatEtDay("2026-10-23T20:00:00Z"), "Fri 2026-10-23");
  assert.equal(formatEtDay("2026-10-28"), "Wed 2026-10-28");
  assert.equal(formatEtWeekdayTime("2026-10-26T13:30:00Z"), "Mon 9:30 AM ET");
  assert.equal(formatLastCloseLine("2026-10-23T20:00:00Z", "Alpaca"), "As of last close · Fri 2026-10-23 · 4:00 PM ET · Alpaca");
});

test("signed percent carries a sign and a real minus", () => {
  assert.equal(formatSignedPct(2.14), "+2.14%");
  assert.equal(formatSignedPct(-0.87), "−0.87%");
  assert.equal(formatSignedPct(0), "0.00%");
  assert.equal(formatSignedPct(-0.001), "0.00%");
  assert.equal(formatSignedPct(1.1, 1), "+1.1%");
});

test("numbers format compactly and never leak null or NaN", () => {
  assert.equal(formatCompact(12_883_312), "12.9M");
  assert.equal(formatCompact(950), "950");
  assert.equal(formatPrice(210.9975), "211.00");
  assert.equal(formatPrice(0.1234), "0.1234");
  assert.equal(formatRatio(0.98), "0.98×");
  for (const value of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
    for (const text of [formatPrice(value), formatSignedPct(value), formatCompact(value), formatRatio(value), formatMetric("number", value)]) {
      assert.equal(text, "—");
      assert.doesNotMatch(text, /null|NaN|undefined|Infinity/);
    }
  }
  assert.equal(formatMetric("pct_signed", 49.642), "+49.64%");
  assert.equal(formatMetric("time", "2026-10-23T18:00:00Z"), "2:00 PM");
  assert.equal(formatMetric("time", 5), "—");
});

test("tones, relative time and initials", () => {
  assert.equal(changeTone(1), "up");
  assert.equal(changeTone(-1), "down");
  assert.equal(changeTone(0), "flat");
  assert.equal(changeTone(null), "flat");
  const now = new Date("2026-10-23T20:10:00Z");
  assert.equal(formatAgo("2026-10-23T20:09:40Z", now), "just now");
  assert.equal(formatAgo("2026-10-23T20:08:00Z", now), "2 min ago");
  assert.equal(formatAgo("2026-10-23T17:10:00Z", now), "3 hr ago");
  assert.equal(formatAgo(null, now), "—");
  assert.equal(initialOf("willa"), "W");
  assert.equal(initialOf(null), "?");
});

test("a plain date has no time of day and never slides to the evening before", () => {
  assert.equal(formatEtTime("2026-10-23"), "—");
  assert.equal(formatEtTimeZone("2026-10-23"), "—");
  assert.equal(formatEtStamp("2026-10-23"), "—");
  assert.equal(formatEtClock("2026-10-23"), "—");
  assert.equal(formatEtDay("2026-10-23"), "Fri 2026-10-23");
  assert.equal(formatAsOfText("2026-10-23"), "Fri 2026-10-23");
  assert.equal(formatAsOfText("2026-10-23T19:45:00+00:00"), "3:45 PM ET");
  assert.equal(formatAsOfText(null), "—");
});
