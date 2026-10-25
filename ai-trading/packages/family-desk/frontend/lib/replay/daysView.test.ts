import assert from "node:assert/strict";
import test from "node:test";
import { attemptsText, dayCell, orderDays, rankText, tagLabel, tagsText } from "./daysView.ts";
import { daysResponse } from "./fixtures.ts";

test("the day cell shows the weekday date only while dates are on", () => {
  assert.equal(dayCell({ day: "2026-04-07" }, true), "Tue 2026-04-07");
  assert.equal(dayCell({ day: "2026-04-07" }, false), "Hidden day");
});

test("tags read as words; gap tags carry their size when the API gives one", () => {
  assert.equal(tagLabel("gap_down", -6.2), "Gap down 6.2%");
  assert.equal(tagLabel("gap_up", 3.1), "Gap up 3.1%");
  assert.equal(tagLabel("gap_up", null), "Gap up");
  assert.equal(tagLabel("gap_down", null), "Gap down");
  assert.equal(tagLabel("heavy_volume", null), "Heavy volume");
  assert.equal(tagLabel("earnings", null), "Earnings");
  assert.equal(tagLabel("unusual_options_flow", null), "Unusual options flow", "an unknown tag reads as its words");
});

test("tag, rank and attempt cells are the exact row text", () => {
  const [first, second, third] = daysResponse.days;
  assert.equal(tagsText({ tags: first!.tags, gap_pct: first!.gap_pct }), "Gap down 6.2% · Heavy volume · Earnings");
  assert.equal(tagsText({ tags: third!.tags, gap_pct: third!.gap_pct }), "Heavy volume");
  assert.equal(rankText({ rank: first!.rank, rv_pct_rank: first!.rv_pct_rank }), "#1 · 99.6th pct");
  assert.equal(rankText({ rank: second!.rank, rv_pct_rank: second!.rv_pct_rank }), "#2 · 99.2th pct");
  assert.equal(attemptsText(0), "—");
  assert.equal(attemptsText(1), "1");
});

test("the picked symbol's days come first, then the rest, each symbol by rank", () => {
  const days = daysResponse.days;
  assert.deepEqual(orderDays(days, " tsla ").map((row) => `${row.symbol} ${row.day}`), [
    "TSLA 2026-03-11",
    "NVDA 2026-04-07",
    "NVDA 2026-02-19",
  ]);
  assert.deepEqual(orderDays(days, "NVDA").map((row) => `${row.symbol} ${row.rank}`), ["NVDA 1", "NVDA 2", "TSLA 1"]);
  assert.deepEqual(orderDays(days, "AAPL").map((row) => row.symbol), ["NVDA", "NVDA", "TSLA"], "an unlisted pick changes nothing");
  assert.equal(days[0]!.symbol, "NVDA", "the input is not reordered in place");
});
