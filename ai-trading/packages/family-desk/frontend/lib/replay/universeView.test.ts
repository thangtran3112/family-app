import assert from "node:assert/strict";
import test from "node:test";
import { containsPracticeBannedTerm } from "../desk/freshness.ts";
import { UniversePreviewSchema } from "./swingApi.ts";
import { swingSetup, universe, universePreview, universePreviewPreparing } from "./swingFixtures.ts";
import {
  addSymbol,
  clampTarget,
  excludedLines,
  fillOrderRows,
  hasEdits,
  isPreparing,
  mixOf,
  noEdits,
  normalizeSymbol,
  parseTarget,
  prepProgressText,
  previewSummary,
  removeSymbol,
  sourceChip,
  sourceLabel,
  startBlocker,
  toggleId,
  universeEntries,
  universeRowView,
  universeSummary,
} from "./universeView.ts";

test("the fixtures are real preview payloads", () => {
  assert.equal(UniversePreviewSchema.parse(universePreview).rows.length, 50);
  assert.equal(UniversePreviewSchema.parse(universePreviewPreparing).state, "preparing");
});

test("sources read as words, and a filter pick shows the filter's name", () => {
  assert.deepEqual((["watchlist", "manual", "filter", "liquidity"] as const).map(sourceLabel), ["Watchlist", "Manual", "Filter", "Liquidity"]);
  assert.equal(sourceLabel("mystery"), "mystery");
  assert.equal(sourceChip({ source: "filter", matched: ["New 20-day high"] }), "New 20-day high");
  assert.equal(sourceChip({ source: "filter", matched: ["New 20-day high", "Gap up"] }), "New 20-day high +1");
  assert.equal(sourceChip({ source: "filter", matched: [] }), "Filter");
  assert.equal(sourceChip({ source: "watchlist", matched: ["New 20-day high"] }), "Watchlist", "a watchlist pick that also matched keeps its source");
});

test("the list fills in order: watchlists, then manual adds, then filter matches, then liquidity", () => {
  const rows = [{ symbol: "L1", source: "liquidity" }, { symbol: "W1", source: "watchlist" }, { symbol: "F1", source: "filter" }, { symbol: "M1", source: "manual" }, { symbol: "W2", source: "watchlist" }, { symbol: "L2", source: "liquidity" }] as const;
  assert.deepEqual(fillOrderRows(rows).map((row) => row.symbol), ["W1", "W2", "M1", "F1", "L1", "L2"], "stable inside a source");
  assert.deepEqual(universeEntries(rows).slice(0, 2), [{ symbol: "W1", source: "watchlist" }, { symbol: "W2", source: "watchlist" }]);
  assert.deepEqual(universeEntries(universePreview.rows), universe, "the preview's rows are the contract's universe");
  assert.deepEqual(mixOf(universe), { watchlist: 9, manual: 2, filter: 6, liquidity: 33 });
});

test("the summary line is the counts as displayed, with the basis and the survivorship words", () => {
  const mix = { watchlist: 9, manual: 2, filter: 6, liquidity: 33 };
  assert.equal(
    universeSummary({ size: 50, mix }, ["New 20-day high"]),
    "50 symbols · 9 watchlist · 2 manual · 6 New 20-day high · 33 liquidity · as of the close before Day 1 · survivors only",
  );
  assert.equal(universeSummary({ size: 50, mix }, ["A", "B"]), "50 symbols · 9 watchlist · 2 manual · 6 from filters · 33 liquidity · as of the close before Day 1 · survivors only");
  assert.equal(universeSummary({ size: 10, mix: { watchlist: 3, liquidity: 7 } }), "10 symbols · 3 watchlist · 7 liquidity · as of the close before Day 1 · survivors only", "a source with none is left out");
  assert.equal(universeSummary({ size: 1, mix: { manual: 1 } }), "1 symbol · 1 manual · as of the close before Day 1 · survivors only");
  assert.equal(previewSummary(universePreview, ["New 20-day high"]), universeSummary({ size: 50, mix }, ["New 20-day high"]));
});

test("a row shows its source chip, change with a real sign, dollar volume, ATR and warnings", () => {
  const row = universeRowView({ symbol: "SMCI", source: "manual", prior_close: 41.5, chg_20d_pct: -3.456, avg_dollar_volume_20d: 912_000_000, atr_pct_14: 4.25, matched: ["Gap up", "New 20-day high"], warnings: ["below floor"] });
  assert.deepEqual(
    [row.sourceLabel, row.chip, row.priorClose, row.chg20d, row.chg20dTone, row.dollarVolume, row.atr, row.matched, row.warnings],
    ["Manual", "Manual", "41.50", "−3.5%", "down", "$912M", "4.3%", "Gap up · New 20-day high", ["below floor"]],
  );
  const gap = universeRowView({ symbol: "X", source: "liquidity", prior_close: 10, chg_20d_pct: null, avg_dollar_volume_20d: 0, atr_pct_14: null, matched: [], warnings: [] });
  assert.deepEqual([gap.chg20d, gap.chg20dTone, gap.dollarVolume, gap.atr, gap.matched], ["—", "flat", "—", "—", null]);
});

test("symbols left out are listed under the table with their neutral reason", () => {
  assert.deepEqual(excludedLines(universePreview.excluded), ["2 symbols left out · Not enough price history for this whole range: NEWCO, FRSH"]);
  assert.deepEqual(excludedLines([{ symbol: "A", reason: "r1" }, { symbol: "B", reason: "r2" }, { symbol: "C", reason: "r1" }]), ["2 symbols left out · r1: A, C", "1 symbol left out · r2: B"]);
  assert.deepEqual(excludedLines([]), []);
});

test("prep progress, polling and why Start is off", () => {
  assert.equal(prepProgressText(universePreviewPreparing), "Preparing as-of data · 96 of 133 (72%) · this can take several minutes · watchlist and manual picks are ready");
  assert.equal(prepProgressText(universePreview), "As-of data is ready");
  assert.equal(isPreparing(universePreviewPreparing), true);
  assert.equal(isPreparing(universePreview), false);
  assert.equal(isPreparing(null), false);
  assert.equal(startBlocker(null), "Build the universe first");
  assert.equal(startBlocker(universePreviewPreparing), "Wait for the data to finish · 96 of 133 (72%)");
  assert.equal(startBlocker({ ...universePreview, rows: universePreview.rows.slice(0, 5) }), "Pick at least 10 symbols · you have 5");
  assert.equal(startBlocker({ ...universePreview, rows: universePreview.rows.slice(0, 10) }), null);
  assert.equal(startBlocker(universePreview), null);
});

test("adding a symbol trims, upper-cases, and refuses what is not a symbol or already there", () => {
  assert.equal(normalizeSymbol("  brk.b "), "BRK.B");
  const first = addSymbol(noEdits(), " nvda ");
  assert.deepEqual([first.edits, first.problem], [{ add: ["NVDA"], remove: [] }, null]);
  assert.equal(addSymbol(first.edits, "NVDA").problem, "NVDA is already on the list");
  assert.deepEqual(addSymbol(first.edits, "NVDA").edits, first.edits);
  assert.equal(addSymbol(noEdits(), "AAPL", ["AAPL", "MSFT"]).problem, "AAPL is already on the list");
  assert.equal(addSymbol(noEdits(), "123").problem, "123 is not a stock symbol");
  assert.equal(addSymbol(noEdits(), "TOOLONGSYMBOL").problem, "TOOLONGSYMBOL is not a stock symbol");
  assert.equal(addSymbol(noEdits(), "  ").problem, "Type a symbol, like NVDA");
  assert.equal(addSymbol({ add: [], remove: ["AAPL"] }, "aapl", ["MSFT"]).problem, null);
  const many = { add: Array.from({ length: 50 }, (_, index) => `S${index}`), remove: [] };
  assert.equal(addSymbol(many, "ZZZ").problem, "You can add or remove up to 50 symbols by hand");
});

test("removing drops a hand add, remembers any other pick, and adding it back undoes the remove", () => {
  assert.deepEqual(removeSymbol({ add: ["NVDA", "AMD"], remove: [] }, "nvda"), { add: ["AMD"], remove: [] });
  const removed = removeSymbol(noEdits(), "AAPL");
  assert.deepEqual(removed, { add: [], remove: ["AAPL"] });
  assert.equal(removeSymbol(removed, "AAPL"), removed, "removing twice changes nothing");
  assert.deepEqual(addSymbol(removed, "AAPL").edits, noEdits());
  assert.equal(hasEdits(removed), true);
  assert.equal(hasEdits(noEdits()), false);
});

test("the target size is a whole number from 10 to 50", () => {
  assert.deepEqual([5, 10, 33.4, 50, 80, Number.NaN].map(clampTarget), [10, 10, 33, 50, 50, 50]);
  assert.deepEqual(["", "25", " 7 ", "1,000", "abc"].map(parseTarget), [50, 25, 10, 50, 50]);
});

test("lists and filters toggle up to their limit", () => {
  assert.deepEqual(toggleId([1, 2], 3, 3), [1, 2, 3]);
  assert.deepEqual(toggleId([1, 2, 3], 4, 3), [1, 2, 3], "a fourth filter is refused");
  assert.deepEqual(toggleId([1, 2, 3], 2, 3), [1, 3]);
});

test("every string the universe helpers build avoids the Practice banned words", () => {
  const built = [
    universeSummary({ size: 50, mix: { watchlist: 9, manual: 2, filter: 6, liquidity: 33 } }, ["New 20-day high"]),
    previewSummary(universePreview),
    prepProgressText(universePreviewPreparing),
    prepProgressText(universePreview),
    startBlocker(null),
    startBlocker(universePreviewPreparing),
    startBlocker({ ...universePreview, rows: [] }),
    ...excludedLines(universePreview.excluded),
    addSymbol(noEdits(), "123").problem,
    addSymbol(noEdits(), "").problem,
    addSymbol({ add: ["X"], remove: [] }, "X").problem,
    ...universePreview.rows.slice(0, 12).flatMap((row) => {
      const view = universeRowView(row);
      return [view.chip, view.sourceLabel, view.matched, view.priorClose, view.chg20d, view.dollarVolume, view.atr, ...view.warnings];
    }),
  ];
  for (const text of built) if (text != null) assert.equal(containsPracticeBannedTerm(text), false, text);
  assert.equal(swingSetup.universe.length, 50);
});
