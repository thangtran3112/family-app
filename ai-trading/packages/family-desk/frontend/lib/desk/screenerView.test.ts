import assert from "node:assert/strict";
import test from "node:test";
import { ScreenerFiltersSchema, ScreenerResultsSchema, ScreenerUniverseSchema } from "../api/schemas.ts";
import { loadDeskFixture } from "../fixtures/desk-mvp/load.ts";
import { columnsForBand, droppedKeys } from "./columns.ts";
import {
  NEW_FILTER_SPEC,
  QUICK_FILTERS,
  applyQuickFilters,
  cellText,
  cellValue,
  filterIdFromParam,
  groupFilters,
  matchCaption,
  missingFilterNote,
  neverScanned,
  pickFilter,
  previewInterval,
  previewNotes,
  quickFiltersActive,
  resultColumns,
  resultsState,
  scanLine,
  universeDetails,
  type QuickPicks,
} from "./screenerView.ts";
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

test("the scan line counts and dates this filter's own run, not the universe (V-SCR-02, A-SCR-04)", () => {
  // the fixture run scanned 131 at 3:45 PM ET; a universe of another size must not leak into the line
  assert.equal(scanLine(results), "Scanned 131 symbols at 3:45 PM ET Fri 2026-10-23");
  assert.equal(scanLine({ ...results, scanned: 7 }).startsWith("Scanned 7 symbols"), true);
  // a premarket gap scan says its own 8:30 time, and names the symbols that had no bars that day
  assert.equal(
    scanLine({ ...results, scanned: 129, no_data_on_eval_day: 2, evaluation_point: "2026-10-23T12:30:00Z" }),
    "Scanned 129 symbols at 8:30 AM ET Fri 2026-10-23 · 2 had no bars that day",
  );
});

test("the universe details never print a second 'scanned' count beside the run's", () => {
  const details = universeDetails(universe);
  assert.ok(details[0]!.startsWith("Scan basis: "));
  assert.ok(details.some((line) => line.startsWith("Liquidity floor: price above $5")));
  assert.equal(details.some((line) => /scanned/i.test(line)), false, details.join(" | "));
  assert.ok(details.includes(`Universe now: ${universe.candidates} candidates, ${universe.scanned} pass the liquidity floor`));
});

test("the match caption explains a capped table and the quick-filter narrowing (V-SCR-09)", () => {
  assert.equal(matchCaption({ matches_total: 9, matches_returned: 9 }, 9, false), "9 matches");
  assert.equal(matchCaption({ matches_total: 1, matches_returned: 1 }, 1, false), "1 match");
  assert.equal(matchCaption({ matches_total: 9, matches_returned: 8 }, 8, false), "Showing the top 8 of 9 matches");
  assert.equal(matchCaption({ matches_total: 65, matches_returned: 8 }, 3, true), "3 of 8 rows pass your quick filters · 65 matched the scan");
});

test("the editor preview says what it checked and how that differs from the last scan (V-SCR-03)", () => {
  const lastRun = { evaluation_point: "2026-10-23T19:45:00Z", matches_total: 9, scanned: 131 };
  assert.deepEqual(previewNotes({ scanned: 3 }, lastRun), [
    "matches of 3 symbols, checked now on stored bars",
    "Last scan: 9 of 131 at 3:45 PM ET Fri 2026-10-23",
    "The preview and the last scan checked different symbols, so their counts differ.",
  ]);
  assert.deepEqual(previewNotes({ scanned: 131 }, lastRun), [
    "matches of 131 symbols, checked now on stored bars",
    "Last scan: 9 of 131 at 3:45 PM ET Fri 2026-10-23",
  ]);
  assert.deepEqual(previewNotes({ scanned: 1 }, null), ["matches of 1 symbol, checked now on stored bars"]);
});

test("a filter id that is gone says so instead of silently showing another filter (A-SCR-17)", () => {
  const shown = pickFilter(filters, 99999)!;
  assert.equal(missingFilterNote(filters, 99999), `That filter was deleted or isn't available · showing ${shown.name}`);
  assert.equal(missingFilterNote(filters, filters[1]!.id), null);
  assert.equal(missingFilterNote(filters, null), null);
  assert.equal(missingFilterNote([], 5), null);
});

const row = (symbol: string, columns: Record<string, number | null>) => ({ ...results.matches[0]!, symbol, columns });

test("quick filters narrow the rows on the standard trader bands; an unknown value never passes (A-SCR-02)", () => {
  const rows = [
    row("MOMO", { last: 6.27, change_pct: 49.6, rvol_10d: 12, avg_volume_20d: 666_063, rsi_14: 79.7, gap_pct_open: 66.6, dist_to_252d_high_pct: -3 }),
    row("BIG", { last: 410, change_pct: -6.2, rvol_10d: 1.1, avg_volume_20d: 25_000_000, rsi_14: 28, gap_pct_open: -1, dist_to_252d_high_pct: -30 }),
    row("NODATA", { last: 12, change_pct: null, rvol_10d: null }),
  ];
  const symbols = (picks: QuickPicks) => applyQuickFilters(rows, picks).map((match) => match.symbol);
  assert.deepEqual(symbols({}), ["MOMO", "BIG", "NODATA"]);
  // the canonical small-cap momentum scan: price $2 to $20, up 10% or more, relative volume 5x or more
  assert.deepEqual(symbols({ price: "2-20", change: "up10", rvol: "5x" }), ["MOMO"]);
  assert.deepEqual(symbols({ change: "down5" }), ["BIG"]);
  assert.deepEqual(symbols({ rsi: "oversold" }), ["BIG"]);
  assert.deepEqual(symbols({ rsi: "overbought" }), ["MOMO"]);
  assert.deepEqual(symbols({ avgVolume: "1m" }), ["BIG"]);
  assert.deepEqual(symbols({ high52: "within5" }), ["MOMO"]);
  assert.deepEqual(symbols({ price: "over50" }), ["BIG"]);
  // bounds are inclusive: exactly $20 is in "$2 to $20" and "$20 and over"
  assert.deepEqual(applyQuickFilters([row("EDGE", { last: 20 })], { price: "2-20" }).length, 1);
  assert.deepEqual(applyQuickFilters([row("EDGE", { last: 20 })], { price: "over20" }).length, 1);
  // every band names a column the API sends, and its ids are unique per filter
  for (const quick of QUICK_FILTERS) {
    assert.ok(quick.column in results.matches[0]!.columns, quick.column);
    assert.equal(new Set(quick.bands.map((band) => band.id)).size, quick.bands.length, quick.key);
  }
  assert.equal(quickFiltersActive({}), false);
  assert.equal(quickFiltersActive({ price: "" }), false);
  assert.equal(quickFiltersActive({ price: "2-20" }), true);
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

test("a filter no scan has run yet is told apart from one that ran and matched nothing", () => {
  assert.equal(neverScanned({ as_of: null, freshness: "unavailable" }), true);
  assert.equal(neverScanned(results.stamp), false);
  assert.equal(neverScanned({ as_of: "2026-10-23T20:00:00Z", freshness: "unavailable" }), false);
});

test("the new-filter form starts from a spec the contract parses, with a name of its own", () => {
  const spec = parseFilterSpec(NEW_FILTER_SPEC);
  assert.ok(spec);
  assert.equal(spec.name, "New filter");
  assert.match(describeSpec(spec), /^At .+, find .+ where .+; up to \d+ matches?\.$/);
});
