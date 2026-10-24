import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { FilterStrategySpecV1Schema } from "@ai-trading/contracts/filter-strategy-spec-v1";
import { AlertStrategySpecV1Schema } from "@ai-trading/contracts/alert-strategy";
import { describeSpec, describeUniverse } from "./describe.ts";

const dir = new URL("../../../contracts/templates/filters/", import.meta.url);
const filters = readdirSync(dir).filter((file) => file.endsWith(".json")).map((file) => ({
  file,
  spec: FilterStrategySpecV1Schema.parse(JSON.parse(readFileSync(new URL(file, dir), "utf8"))),
}));

test("describes Abnormal volume in one plain sentence", () => {
  const { spec } = filters.find(({ file }) => file === "abnormal-volume.json")!;
  assert.equal(
    describeSpec(spec),
    "At each 15-minute close during regular hours, find US stocks and ETFs with price above $5 and average volume above 500,000 where relative volume (10 days) is at least 2.5; ranked by relative volume (10 days), highest first; up to 50 matches.",
  );
});

test("every shipped filter template has a readable description", () => {
  assert.equal(filters.length, 10);
  for (const { file, spec } of filters) {
    const text = describeSpec(spec);
    assert.match(text, /^At .+, find .+ where .+; up to \d+ matches?\.$/, file);
    assert.doesNotMatch(text, /undefined|null|NaN|\[object/, file);
  }
});

test("describes optional parts: no floor, no rank, one match, ETFs only", () => {
  const base = filters.find(({ file }) => file === "52-week-breakout.json")!.spec;
  const minimal = { ...base, liquidity: undefined, rank: undefined, maxResults: 1, assetTypes: ["etf" as const] };
  assert.equal(
    describeSpec(minimal),
    "At each daily close during regular hours, find US ETFs where close crosses above 252-day high; up to 1 match.",
  );
});

test("describes the universe of every source kind", () => {
  assert.equal(describeUniverse({ market: "us_equities" }), "US stocks and ETFs");
  assert.equal(describeUniverse({ watchlist: "Day movers" }), "watchlist Day movers");
  assert.equal(describeUniverse({ symbols: ["NVDA", "AMD", "TSLA"] }), "NVDA, AMD and TSLA");
  assert.equal(describeUniverse({ symbols: ["NVDA"] }), "NVDA");
  assert.equal(describeUniverse({ filter: "Abnormal volume" }), "matches of filter Abnormal volume");
});

test("an alert strategy spec still describes as an alert, and a paper order never appears in alert-only text", () => {
  const spec = AlertStrategySpecV1Schema.parse({
    schemaVersion: 1,
    name: "ORB 15m",
    watch: { universe: { watchlist: "Day movers" }, session: "regular", runOn: "bar_close_15m" },
    when: { op: "gt", left: { series: "close" }, right: { level: "opening_range_high", minutes: 15 } },
    then: { alert: { channels: ["inbox", "telegram"] } },
  });
  const text = describeSpec(spec);
  assert.equal(text, "At each 15-minute close during regular hours, alert when close is greater than 15-minute opening range high; notify inbox and telegram.");
  assert.doesNotMatch(text, /paper/);
});
