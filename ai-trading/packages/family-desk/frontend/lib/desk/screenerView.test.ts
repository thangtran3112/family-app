import assert from "node:assert/strict";
import test from "node:test";
import { ScreenerFiltersSchema, ScreenerResultsSchema, ScreenerUniverseSchema } from "../api/schemas.ts";
import { loadDeskFixture } from "../fixtures/desk-mvp/load.ts";
import { columnsForBand, droppedKeys } from "./columns.ts";
import { cellText, cellValue, filterIdFromParam, groupFilters, pickFilter, previewInterval, resultColumns, resultsState, universeDetails, universeLine } from "./screenerView.ts";
import { parseFilterSpec } from "../spec/parse.ts";
import { describeSpec } from "../spec/describe.ts";
import { ScreenerFilterDetailSchema } from "../api/schemas.ts";

const filters = ScreenerFiltersSchema.parse(loadDeskFixture("screener_filters"));
const results = ScreenerResultsSchema.parse(loadDeskFixture("screener_filter_1_results"));
const universe = ScreenerUniverseSchema.parse(loadDeskFixture("screener_universe"));

test("seeds are the read-only defaults, hers come after", () => {
  const { defaults, mine } = groupFilters(filters);
  assert.ok(defaults.length > 0 && defaults.every((f) => f.read_only));
  assert.ok(mine.every((f) => !f.read_only));
  assert.equal(defaults.length + mine.length, filters.length);
});

test("the filter in the URL wins, else the first; junk params read as none", () => {
  assert.equal(pickFilter(filters, filters[2]!.id)?.id, filters[2]!.id);
  assert.equal(pickFilter(filters, 99999)?.id, filters[0]!.id);
  assert.equal(pickFilter([], null), null);
  assert.equal(filterIdFromParam("3"), 3);
  assert.deepEqual(["x", "0", "-2", "1.5", null].map(filterIdFromParam), [null, null, null, null, null]);
});

test("columns follow table_columns and drop matched since, ATR %, volume at 1180", () => {
  const columns = resultColumns(results.table_columns);
  assert.deepEqual(columns.map((c) => c.key), results.table_columns.map((c) => c.key));
  const dropped = droppedKeys(columns);
  assert.ok(dropped.every((key) => ["matched_since", "atr_pct_14", "volume"].includes(key)));
  assert.deepEqual(columns.filter((c) => !dropped.includes(c.key)).map((c) => c.key), columnsForBand(columns, "1180").map((c) => c.key));
  assert.equal(columns.find((c) => c.format === "time")?.align, "left");
});

test("cells read the metric columns, matched_since and operands, and format by column", () => {
  const match = results.matches[0]!;
  for (const column of resultColumns(results.table_columns)) {
    const text = cellText(match, column);
    assert.doesNotMatch(text, /null|NaN|undefined/);
  }
  assert.equal(cellValue(match, "matched_since"), match.matched_since);
  assert.equal(cellValue(match, "rank_value"), match.rank_value);
  assert.equal(cellValue(match, "nope"), null);
  assert.equal(cellText(match, { key: "change_pct", format: "pct_signed" }).startsWith("+"), true);
});

test("universe line and details are plain words", () => {
  assert.equal(universeLine(universe), `Scanned ${universe.scanned} US stocks and ETFs · as of last close Fri 2026-10-23`);
  assert.equal(universeLine({ scanned: 5, stamp: { ...universe.stamp, freshness: "delayed" } }), "Scanned 5 US stocks and ETFs · as of 4:00 PM ET");
  assert.equal(universeLine({ scanned: 0, stamp: { ...universe.stamp, as_of: null } }), "Scanned 0 US stocks and ETFs · no scan yet");
  const details = universeDetails(universe);
  assert.ok(details[0]!.startsWith("Scan basis: "));
  assert.ok(details.some((line) => line.startsWith("Liquidity floor: price above $5")));
});

test("results state covers scanning, error, empty and ready", () => {
  assert.equal(resultsState({ loading: true, hasResults: false, failed: false, matches: 0 }), "scanning");
  assert.equal(resultsState({ loading: false, hasResults: false, failed: true, matches: 0 }), "error");
  assert.equal(resultsState({ loading: false, hasResults: true, failed: false, matches: 0 }), "empty");
  assert.equal(resultsState({ loading: false, hasResults: true, failed: false, matches: 9 }), "ready");
  assert.equal(previewInterval("bar_close_15m"), "15m");
  assert.equal(previewInterval("daily_close"), "1d");
});

test("the fixture filter's spec parses and describes in one sentence", () => {
  const detail = ScreenerFilterDetailSchema.parse(loadDeskFixture("screener_filter_1"));
  const spec = parseFilterSpec(detail.spec);
  assert.ok(spec);
  assert.match(describeSpec(spec), /^At .+, find .+ where .+; up to \d+ matches?\.$/);
  assert.equal(parseFilterSpec({ nonsense: true }), null);
});
