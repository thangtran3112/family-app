import assert from "node:assert/strict";
import { test } from "node:test";
import { FilterStrategySpecV1Schema } from "../src/filter-strategy-spec-v1.ts";
import { jsonFiles } from "./fixtures.ts";

const valid = jsonFiles("fixtures/filter-strategy-spec-v1/valid");
const invalid = jsonFiles("fixtures/filter-strategy-spec-v1/invalid");
const defaults = jsonFiles("templates/filters");

test("fixture folders are not empty", () => {
  assert.ok(valid.length >= 9 && invalid.length >= 36);
});

for (const [name, spec] of [...valid, ...defaults]) {
  test(`accepts ${name}`, () => {
    const result = FilterStrategySpecV1Schema.safeParse(spec);
    assert.ok(result.success, JSON.stringify(result.error?.issues));
  });
}

for (const [name, spec] of invalid) {
  test(`rejects ${name}`, () => {
    assert.equal(FilterStrategySpecV1Schema.safeParse(spec).success, false);
  });
}

// Section c1 of the plan, as data: the ten screener defaults, nothing more and nothing less.
const RVOL10 = { series: "rvol", lookbackDays: 10 };
const GAP = { series: "gap_pct" };
const ATR_PCT = { series: "atr_pct", length: 14, medianLength: 50 };
const RSI14 = { series: "rsi", length: 14 };
const value = (n: number) => ({ value: n });
const compare = (op: string, left: object, right: object) => ({ op, left, right });
const rank = (by: object, order: "desc" | "asc") => ({ by, order });

const C1_DEFAULTS: Record<string, { session: string; runOn: string; when: object; rank: object }> = {
  "abnormal-volume.json": {
    session: "regular",
    runOn: "bar_close_15m",
    when: compare("gte", RVOL10, value(2.5)),
    rank: rank(RVOL10, "desc"),
  },
  "high-volatility.json": {
    session: "regular",
    runOn: "daily_close",
    when: compare("gte", ATR_PCT, value(4)),
    rank: rank(ATR_PCT, "desc"),
  },
  "gap-up.json": {
    session: "extended",
    runOn: "premarket_0830",
    when: { all: [compare("gte", GAP, value(3)), compare("gte", RVOL10, value(1.5))] },
    rank: rank(GAP, "desc"),
  },
  "gap-down.json": {
    session: "extended",
    runOn: "premarket_0830",
    when: compare("lte", GAP, value(-3)),
    rank: rank(GAP, "asc"),
  },
  "new-20-day-high.json": {
    session: "regular",
    runOn: "daily_close",
    when: compare("crosses_above", { series: "close" }, { level: "n_day_high", days: 20 }),
    rank: rank(RVOL10, "desc"),
  },
  "52-week-breakout.json": {
    session: "regular",
    runOn: "daily_close",
    when: compare("crosses_above", { series: "close" }, { level: "n_day_high", days: 252 }),
    rank: rank(RVOL10, "desc"),
  },
  "oversold-rsi.json": {
    session: "regular",
    runOn: "daily_close",
    when: compare("lt", RSI14, value(30)),
    rank: rank(RSI14, "asc"),
  },
  "overbought-rsi.json": {
    session: "regular",
    runOn: "daily_close",
    when: compare("gt", RSI14, value(70)),
    rank: rank(RSI14, "desc"),
  },
  "above-vwap-on-volume.json": {
    session: "regular",
    runOn: "bar_close_5m",
    when: { all: [compare("gt", { series: "close" }, { series: "vwap" }), compare("gte", RVOL10, value(2))] },
    rank: rank(RVOL10, "desc"),
  },
  "top-movers.json": {
    session: "regular",
    runOn: "bar_close_15m",
    when: compare("gte", GAP, value(4)),
    rank: rank(GAP, "desc"),
  },
};

test("exactly the ten section c1 defaults ship", () => {
  assert.deepEqual(
    defaults.map(([name]) => name).sort(),
    Object.keys(C1_DEFAULTS).sort(),
  );
});

for (const [name, spec] of defaults) {
  test(`${name} matches section c1, with the shared liquidity floor`, () => {
    const { session, runOn, when, rank: ranking } = C1_DEFAULTS[name]!;
    const { name: title, ...rest } = spec as { name: string };
    assert.ok(title.length >= 1 && title.length <= 80);
    assert.deepEqual(rest, {
      schemaVersion: 1,
      watch: { universe: { market: "us_equities" }, session, runOn },
      liquidity: { minPrice: 5, minAvgVolume: 500000 },
      when,
      rank: ranking,
      maxResults: 50,
    });
  });
}
