import assert from "node:assert/strict";
import test from "node:test";
import { STRATEGY_TEMPLATES } from "../templates.ts";
import { optionLabel, paramLabel, subLabel, versionNote } from "./labels.ts";

test("V-Strategies-03: builder parameter names read as trader words, not identifiers", () => {
  assert.equal(paramLabel("riskUsd"), "Risk per trade ($)");
  assert.equal(paramLabel("smoothK"), "%K smoothing");
  assert.equal(paramLabel("smoothD"), "%D smoothing");
  assert.equal(paramLabel("lookbackDays"), "Lookback (days)");
  assert.equal(paramLabel("pctOfBook"), "% of book");
  assert.equal(paramLabel("maxTradesPerDay"), "Max trades per day");
  assert.equal(paramLabel("cooldownMinutes"), "Cooldown (minutes)");
  assert.equal(paramLabel("unmappedThing"), "Unmapped thing");
});

test("option labels: operators, series, levels, run-on and size types are plain English", () => {
  assert.equal(optionLabel("crosses_above"), "crosses above");
  assert.equal(optionLabel("gte"), "is at least");
  assert.equal(optionLabel("gt"), "is greater than");
  assert.equal(optionLabel("williams_r"), "Williams %R");
  assert.equal(optionLabel("stoch_rsi"), "Stochastic RSI");
  assert.equal(optionLabel("bull_bear_power"), "Bull/Bear Power");
  assert.equal(optionLabel("vwap"), "VWAP");
  assert.equal(optionLabel("rsi"), "RSI");
  assert.equal(optionLabel("opening_range_high"), "Opening range high");
  assert.equal(optionLabel("bar_close_1m"), "Every 1-minute close");
  assert.equal(optionLabel("premarket_0830"), "08:30 premarket scan");
  assert.equal(optionLabel("riskUsd"), "Risk per trade ($)");
  assert.equal(optionLabel("atrMultiple"), "ATR multiple");
  assert.equal(optionLabel("watchlist"), "A watchlist");
  assert.equal(optionLabel("symbols"), "Specific symbols");
  assert.equal(optionLabel("series"), "Indicator");
  assert.equal(optionLabel("value"), "Number");
  assert.equal(optionLabel("compare"), "Compare two things");
  assert.equal(optionLabel("some_new_id"), "some new id", "unknown ids fall back to spaced words");
});

test("every id a shipped template uses has a label other than its own identifier", () => {
  const ids = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") {
      for (const [key, inner] of Object.entries(value)) {
        if (["series", "level", "op", "runOn"].includes(key) && typeof inner === "string") ids.add(inner);
        if (["line", "part", "method"].includes(key) === false) walk(inner);
      }
    }
  };
  for (const { spec } of STRATEGY_TEMPLATES) walk(spec);
  assert.ok(ids.size > 10);
  for (const id of ids) {
    const label = optionLabel(id);
    assert.equal(/[_]|^[a-z]+[A-Z]/.test(label), false, `${id} → ${label}`);
  }
});

test("V-Strategies-07: internal version notes read as words", () => {
  assert.equal(versionNote("seeded"), "Starter version");
  assert.equal(versionNote(null), "Saved version");
  assert.equal(versionNote("Tightened the stop"), "Tightened the stop");
});

test("a sub-field label reads as a phrase under its parent", () => {
  assert.equal(subLabel("Left side", "smoothK"), "Left side %K smoothing");
  assert.equal(subLabel("Left side", "lookbackDays"), "Left side lookback (days)");
  assert.equal(subLabel("Left side", "rsiLength"), "Left side RSI length");
});
