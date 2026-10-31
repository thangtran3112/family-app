import assert from "node:assert/strict";
import test from "node:test";
import { CHART_PREFS_KEY, CHART_TYPES, defaultChartPrefs, readChartPrefs, setChartType, togglePref, visibleOverlays, writeChartPrefs } from "./chartPrefs.ts";

const memory = (initial?: string) => {
  const items = new Map<string, string>(initial === undefined ? [] : [[CHART_PREFS_KEY, initial]]);
  return { items, getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => void items.set(key, value) };
};

test("the defaults are today's chart: candles, every line and level on", () => {
  assert.deepEqual(defaultChartPrefs(), {
    v: 1,
    type: "candles",
    on: { vwap: true, ema9: true, ema21: true, volume: true, prior_close: true, session: true, opening_range: true },
  });
  assert.deepEqual(CHART_TYPES, ["candles", "hollow", "bars", "line", "area"]);
});

test("a missing, empty, broken or throwing store reads as the defaults", () => {
  assert.deepEqual(readChartPrefs(null), defaultChartPrefs());
  assert.deepEqual(readChartPrefs(memory()), defaultChartPrefs());
  for (const bad of ["", "not json", "null", "42", "[]", "\"candles\"", "{}"]) assert.deepEqual(readChartPrefs(memory(bad)), defaultChartPrefs(), bad);
  const throwing = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
  assert.deepEqual(readChartPrefs(throwing), defaultChartPrefs());
});

test("every field falls back on its own, so a stale or hand-edited value never breaks the chart", () => {
  const stored = JSON.stringify({ v: 1, type: "zigzag", on: { vwap: false, ema9: "yes", ema21: 0, session: false } });
  assert.deepEqual(readChartPrefs(memory(stored)), {
    ...defaultChartPrefs(),
    on: { vwap: false, ema9: true, ema21: true, volume: true, prior_close: true, session: false, opening_range: true },
  }, "a toggle that is missing or malformed gets its own default (on), not off");
  assert.equal(readChartPrefs(memory(JSON.stringify({ type: "line" }))).type, "line");
  assert.deepEqual(readChartPrefs(memory(JSON.stringify({ type: "area", on: "off" }))).on, defaultChartPrefs().on);
});

test("write then read round-trips, under desk.replayChart in the documented shape", () => {
  const store = memory();
  const prefs = togglePref(setChartType(defaultChartPrefs(), "hollow"), "ema21");
  writeChartPrefs(store, prefs);
  assert.deepEqual(JSON.parse(store.items.get("desk.replayChart")!), { v: 1, type: "hollow", on: { vwap: true, ema9: true, ema21: false, volume: true, prior_close: true, session: true, opening_range: true } });
  assert.deepEqual(readChartPrefs(store), prefs);
});

test("a full quota or private mode keeps the setting in memory instead of throwing", () => {
  const full = { getItem: () => null, setItem: () => { throw new DOMException("quota", "QuotaExceededError"); } };
  assert.doesNotThrow(() => writeChartPrefs(full, defaultChartPrefs()));
  assert.doesNotThrow(() => writeChartPrefs(null, defaultChartPrefs()));
});

test("togglePref and setChartType return a new object and touch one thing", () => {
  const start = defaultChartPrefs();
  const next = togglePref(start, "vwap");
  assert.equal(next.on.vwap, false);
  assert.equal(start.on.vwap, true, "the old object is untouched");
  assert.deepEqual({ ...next.on, vwap: true }, start.on);
  assert.equal(togglePref(next, "vwap").on.vwap, true);
  assert.equal(setChartType(start, "bars").type, "bars");
  assert.equal(start.type, "candles");
});

test("visibleOverlays drops only the overlays she turned off", () => {
  const lines = [{ id: "vwap" }, { id: "ema9" }, { id: "ema21" }];
  assert.deepEqual(visibleOverlays(lines, defaultChartPrefs()).map((line) => line.id), ["vwap", "ema9", "ema21"]);
  assert.deepEqual(visibleOverlays(lines, togglePref(defaultChartPrefs(), "ema21")).map((line) => line.id), ["vwap", "ema9"]);
  assert.deepEqual(visibleOverlays([...lines, { id: "sma50" }], togglePref(defaultChartPrefs(), "vwap")).map((line) => line.id), ["ema9", "ema21", "sma50"], "an id the settings do not know stays");
});
