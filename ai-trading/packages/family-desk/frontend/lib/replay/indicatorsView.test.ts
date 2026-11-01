import assert from "node:assert/strict";
import test from "node:test";
import type { Bars } from "../api/schemas.ts";
import { indicatorGroups, rsiState } from "./indicatorsView.ts";

// 60 one-minute bars from 9:30 ET on 2026-10-15 (13:30 UTC), closing along `close(i)`.
const barsFor = (close: (i: number) => number, count = 60): Bars["bars"] =>
  Array.from({ length: count }, (_, i) => {
    const c = close(i);
    return { t: new Date(Date.UTC(2026, 9, 15, 13, 30 + i)).toISOString(), o: c, h: c + 0.1, l: c - 0.1, c, v: 1000, ext: false };
  });

const row = (groups: ReturnType<typeof indicatorGroups>, id: string) => groups.flatMap((group) => group.rows).find((item) => item.id === id)!;

test("an accelerating climb reads overbought, bullish, with the price above VWAP and both EMAs", () => {
  const groups = indicatorGroups(barsFor((i) => 100 + i * i * 0.004), "1m");
  assert.deepEqual(groups.map((group) => group.id), ["momentum", "trend"]);
  assert.deepEqual(groups[0]!.rows.map((item) => item.id), ["rsi", "macd", "macd-signal", "macd-histogram"]);
  assert.deepEqual(groups[1]!.rows.map((item) => item.id), ["vwap", "ema9", "ema21"]);
  assert.deepEqual([row(groups, "rsi").value, row(groups, "rsi").state, row(groups, "rsi").tone], ["100", "Overbought", "warn"]);
  assert.deepEqual([row(groups, "macd").state, row(groups, "macd").tone], ["Bullish", "up"]);
  assert.equal(row(groups, "macd-histogram").tone, "up");
  assert.match(row(groups, "macd-histogram").value, /^\+/);
  for (const id of ["vwap", "ema9", "ema21"]) assert.deepEqual([row(groups, id).state, row(groups, id).tone], ["Price above", "up"], id);
});

test("an accelerating fall reads oversold, bearish, with the price below every line", () => {
  const groups = indicatorGroups(barsFor((i) => 150 - i * i * 0.004), "1m");
  assert.deepEqual([row(groups, "rsi").value, row(groups, "rsi").state], ["0", "Oversold"]);
  assert.deepEqual([row(groups, "macd").state, row(groups, "macd").tone], ["Bearish", "down"]);
  assert.match(row(groups, "macd-histogram").value, /^−/);
  for (const id of ["vwap", "ema9", "ema21"]) assert.deepEqual([row(groups, id).state, row(groups, id).tone], ["Price below", "down"], id);
});

test("too few bars show a dash and say the value is warming up, never a number", () => {
  const groups = indicatorGroups(barsFor((i) => 100 + i, 5), "1m");
  for (const id of ["rsi", "macd", "macd-signal", "macd-histogram"]) assert.equal(row(groups, id).value, "—", id);
  assert.equal(row(groups, "rsi").state, "Warming up");
  assert.equal(row(groups, "macd").state, "Warming up");
  assert.equal(row(groups, "ema21").state, "Warming up");
  assert.deepEqual(indicatorGroups([], "1m").map((group) => group.rows.length), [4, 3], "the rows stay, empty");
});

test("the daily view has no VWAP", () => {
  const groups = indicatorGroups(barsFor((i) => 100 + i, 40), "1d");
  assert.deepEqual(groups[1]!.rows.map((item) => item.id), ["ema9", "ema21"]);
});

test("RSI is a state only at the 70 and 30 lines", () => {
  assert.equal(rsiState(70).state, "Overbought");
  assert.equal(rsiState(69.9).state, "Neutral");
  assert.equal(rsiState(30).state, "Oversold");
  assert.equal(rsiState(30.1).state, "Neutral");
  assert.equal(rsiState(null).state, "Warming up");
});
