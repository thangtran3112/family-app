import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

// The left rail on REAL TSLA bars (Alpaca SIP, the shared golden fixture `contracts/fixtures/indicator-golden-v1`). The daily
// numbers are TA-Lib's at the last bar (RSI 55.3117, MACD 6.3644 / 5.2864 / 1.0780, EMA 9 371.6967, EMA 21 365.1723).
// The minute numbers are the backend's `core/indicators.py` on the same 150 closes (RSI 61.936, MACD 0.1508 / -0.1831 /
// 0.3338, EMA 9 370.6293, EMA 21 370.2604) and the independent session-VWAP loop (373.1022): one number on the chart, in
// the rail and in the API.
const golden = JSON.parse(readFileSync(new URL("../../../contracts/fixtures/indicator-golden-v1/golden.json", import.meta.url), "utf8")) as {
  daily: { rows: [string, number, number, number][] };
  minutes: { rows: [string, number, number, number, number, string][] };
};
const valuesOf = (groups: ReturnType<typeof indicatorGroups>) => Object.fromEntries(groups.flatMap((group) => group.rows).map((item) => [item.id, [item.value, item.state]]));

test("the rail on 300 real TSLA daily bars reads TA-Lib's numbers", () => {
  const bars: Bars["bars"] = golden.daily.rows.map(([t, h, l, c]) => ({ t, o: c, h, l, c, v: 1_000_000, ext: false }));
  assert.deepEqual(valuesOf(indicatorGroups(bars, "1d")), {
    rsi: ["55.3", "Neutral"],
    macd: ["+6.36", "Bullish"],
    "macd-signal": ["+5.29", ""],
    "macd-histogram": ["+1.08", ""],
    ema9: ["371.70", "Price above"],
    ema21: ["365.17", "Price above"],
  });
});

test("the rail on 150 real TSLA minute bars reads the session VWAP of the regular session only, and the backend's numbers", () => {
  const bars: Bars["bars"] = golden.minutes.rows.map(([t, h, l, c, v, phase]) => ({ t, o: c, h, l, c, v, ext: phase !== "regular" }));
  assert.deepEqual(valuesOf(indicatorGroups(bars, "1m")), {
    rsi: ["61.9", "Neutral"],
    macd: ["+0.15", "Bullish"],
    "macd-signal": ["−0.18", ""],
    "macd-histogram": ["+0.33", ""],
    vwap: ["373.10", "Price below"],
    ema9: ["370.63", "Price above"],
    ema21: ["370.26", "Price above"],
  });
});

test("VWAP says in words when the one-minute bars it is built from are not there, and never 'Warming up' for that (D-168)", () => {
  const bars = barsFor((i) => 100 + i, 40);
  assert.deepEqual([row(indicatorGroups(bars, "15m", { values: null, status: "loading" }), "vwap").value, row(indicatorGroups(bars, "15m", { values: null, status: "loading" }), "vwap").state], ["—", "Reading 1-minute bars"]);
  assert.equal(row(indicatorGroups(bars, "15m", { values: null, status: "unavailable" }), "vwap").state, "1-minute bars unavailable");
  const ready = indicatorGroups(bars, "15m", { values: bars.map(() => 123.45), status: "ready" });
  assert.equal(row(ready, "vwap").value, "123.45", "the value comes from the session VWAP, not from these bars");
  assert.notEqual(row(ready, "vwap").state, "Warming up");
});
