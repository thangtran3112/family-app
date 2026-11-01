import assert from "node:assert/strict";
import test from "node:test";
import { createDeskApiClient, DeskApiError } from "../api/client.ts";
import { BriefSchema, ResearchSchema, TimelineSchema, ValuationSchema } from "../api/fundamentalSchemas.ts";
import { loadFundamentalFixture } from "../fixtures/desk-fundamental/load.ts";
import { containsBannedTerm, COPY } from "./freshness.ts";
import {
  axisLabel, axisTicks, blendView, briefNotStarted, briefRows, briefRunLine, consensusPeriods, earningsInText, impliedMoveText, inputLabel,
  isBadSymbolError, linePosition, methodRows, nextEarningsText, parseSymbolParam, ratingChange, reactionBars, reactionSummary, revisionCells,
  safeHref, staleMarker, stockHref, stockViewFromHash, surpriseRows, surpriseWord, targetBar, targetsView, TIMELINE_FILTERS, timelineHasMore,
  timelineRows, trackRecordTiles, verdictStale,
} from "./researchView.ts";
import { loadTimeline } from "./research.ts";

const brief = BriefSchema.parse(loadFundamentalFixture("research_brief"));
const aapl = ResearchSchema.parse(loadFundamentalFixture("research_aapl"));
const jnj = ResearchSchema.parse(loadFundamentalFixture("research_jnj"));
const valuation = ValuationSchema.parse(loadFundamentalFixture("research_valuation_aapl"));
const timeline = TimelineSchema.parse(loadFundamentalFixture("research_timeline_ko"));

const everyText = (value: unknown): string[] => (typeof value === "string" ? [value] : Array.isArray(value) ? value.flatMap(everyText) : value && typeof value === "object" ? Object.values(value).flatMap(everyText) : []);

test("the symbol param and the tab hash read safely", () => {
  assert.equal(parseSymbolParam(" aapl "), "AAPL");
  assert.equal(parseSymbolParam("BRK.B"), "BRK.B");
  for (const bad of [null, undefined, "", "a b", "<script>", "-X", "WAYTOOLONGTICKER123"]) assert.equal(parseSymbolParam(bad), null, String(bad));
  assert.equal(stockHref("BRK.B", "valuation"), "/stocks?symbol=BRK.B#valuation");
  assert.equal(stockViewFromHash(""), "overview");
  assert.equal(stockViewFromHash("valuation"), "valuation");
  assert.equal(stockViewFromHash("timeline"), "timeline");
  assert.equal(stockViewFromHash("other"), "overview");
});

test("a 422 is a bad symbol; other failures are not", () => {
  assert.equal(isBadSymbolError(new DeskApiError("http", 422)), true);
  assert.equal(isBadSymbolError(new DeskApiError("http", 503)), false);
  assert.equal(isBadSymbolError(new Error("x")), false);
});

test("the brief rows, run line and stale marker", () => {
  assert.equal(briefRunLine(brief.run), "Ran Fri 2026-10-23 · 5:05 PM ET · 4 analyzed · 1 skipped · cost $0.42");
  assert.equal(briefRunLine(null), null);
  const rows = briefRows(brief);
  assert.deepEqual(rows.map((row) => row.symbol), ["AAPL", "MSFT", "NVDA", "KO"]);
  assert.equal(rows[0]!.href, "/stocks?symbol=AAPL#overview");
  assert.equal(rows[0]!.target, "$265.00");
  assert.equal(rows[0]!.range, "$235.00–$290.00");
  assert.equal(rows[0]!.upside, "+14.5%");
  assert.equal(rows[0]!.confidence, "72%");
  assert.equal(rows[1]!.epsRev30d, "−0.6%");
  assert.equal(rows[1]!.epsRevTone, "down");
  assert.equal(rows[1]!.change, "Buy → Hold");
  assert.equal(rows[2]!.change, "New");
  assert.equal(rows[0]!.change, "Unchanged");
  assert.equal(rows[1]!.earnings, "in 5 days");
  assert.equal(rows[0]!.earnings, "—");
  // NVDA is one day stale: the brief is dated Fri 2026-10-23, so its view is Thursday's.
  assert.equal(rows[2]!.stale, "Desk AI view from Thu · today's update didn't finish");
  assert.equal(rows[0]!.stale, null);
  assert.equal(staleMarker("2026-10-23", 0), null);
  assert.equal(earningsInText(1), "in 1 day");
  assert.equal(earningsInText(0), "Today");
  assert.equal(ratingChange("sell", "buy"), "Buy → Sell");
});

test("the track record always shows; an empty brief is the not-started state", () => {
  assert.deepEqual(trackRecordTiles(brief.track_record), [{ label: "Calls", value: "2" }, { label: "Settled", value: "0" }, { label: "Pending", value: "2" }]);
  assert.deepEqual(trackRecordTiles({ calls: 0, settled: 0, pending: 0 }).map((tile) => tile.value), ["0", "0", "0"]);
  assert.equal(briefNotStarted({ run: null, rows: [] }), true);
  assert.equal(briefNotStarted(brief), false);
  assert.equal(briefNotStarted({ run: null, rows: brief.rows }), false);
  assert.equal(COPY.deskAiNotStarted, "Desk AI starts after its first daily run (5:05 PM ET)");
});

test("consensus periods, surprises, revisions and next earnings", () => {
  const consensus = aapl.consensus!;
  assert.deepEqual(consensusPeriods(consensus.quarters)[0], { period: "Q4 2026", eps: "$2.04", analysts: "31" });
  assert.equal(consensusPeriods([{ period: "FY2028", eps_estimate: null, analysts: null }])[0]!.eps, "—");
  const surprises = surpriseRows(consensus.surprises);
  assert.deepEqual(surprises.map((row) => row.word), ["Beat", "Miss"]);
  assert.equal(surprises[0]!.surprise, "+2.0%");
  assert.equal(surprises[1]!.surprise, "−1.0%");
  assert.equal(surpriseWord(0), "In line");
  assert.equal(surpriseWord(null), "—");
  assert.deepEqual(revisionCells(consensus.revisions).map((cell) => cell.text), ["+0.4%", "+1.4%", "+2.9%"]);
  // JNJ has no snapshot history yet: every revision says so in words, never a zero.
  assert.deepEqual(revisionCells(jnj.consensus!.revisions).map((cell) => cell.text), ["Needs more history", "Needs more history", "Needs more history"]);
  assert.deepEqual(revisionCells(jnj.consensus!.revisions).map((cell) => cell.tone), ["neutral", "neutral", "neutral"], "no history carries the shared neutral tone");
  assert.equal(nextEarningsText(consensus.next_earnings), "Thu 2027-01-28 · after close");
  assert.equal(nextEarningsText(null), "—");
  assert.deepEqual(targetsView(aapl.targets!), { low: "$189.75", mean: "$259.17", high: "$312.39", counts: "24 Buy · 9 Hold · 2 Sell" });
});

test("the verdict's range bar keeps the price and targets on one line", () => {
  const bar = targetBar({ low: 235, base: 265, high: 290 }, 231.4);
  assert.ok(bar.price !== null && bar.price < bar.low, "a price under the low target sits left of it");
  assert.ok(bar.low < bar.base && bar.base < bar.high);
  for (const value of [bar.low, bar.base, bar.high, bar.price!]) assert.ok(value >= 0 && value <= 100);
  assert.equal(targetBar({ low: 235, base: 265, high: 290 }, null).price, null);
  assert.equal(linePosition(5, 0, 0), 50);
  assert.equal(linePosition(-5, 0, 10), 0);
  assert.equal(linePosition(50, 0, 10), 100);
  assert.equal(verdictStale(0, "2026-10-23T21:05:00Z"), null);
  assert.equal(verdictStale(2, "2026-10-21T21:05:00Z"), "Desk AI view from Wed · today's update didn't finish");
});

test("valuation methods, their inputs in words and the engine's fallback sentences", () => {
  const rows = methodRows(valuation.methods);
  assert.deepEqual(rows.map((row) => row.label), ["Discounted cash flow", "Owner earnings", "EV / EBITDA", "Residual income"]);
  assert.deepEqual(rows.map((row) => row.value), ["$259.17", "$242.97", "$222.14", "$273.05"]);
  assert.ok(rows[0]!.inputs.includes("Discount rate 8.6%"));
  assert.ok(rows[2]!.inputs.includes("Forward P/E 28.4"));
  assert.deepEqual(rows[2]!.fallbacks, ["EBITDA multiple: the sector median, no five-year history"]);
  assert.equal(methodRows([{ id: "dcf", value: null, inputs: { growth_pct: null }, fallbacks: [] }])[0]!.value, "Not enough data");
  assert.equal(methodRows([{ id: "dcf", value: null, inputs: { growth_pct: null }, fallbacks: [] }])[0]!.inputs[0], "Growth: —");
  assert.equal(inputLabel("something_new_pct"), "Something new");
  const blend = blendView(valuation.blend, valuation.price)!;
  assert.deepEqual([blend.blend, blend.price, blend.word, blend.blendPct], ["$253.92", "$231.40", "Blend is above the price", 100]);
  assert.equal(blendView(null, 231.4), null);
  assert.equal(blendView(253.92, null), null);
});

test("the earnings reaction: summary, axis and one bar per report oldest first", () => {
  const reaction = valuation.earnings_reaction!;
  assert.deepEqual(reactionSummary(reaction), [
    { label: "Reports", value: "8" },
    { label: "Average move", value: "3.3%" },
    { label: "Average vs SPY", value: "+0.33%" },
    { label: "Beats", value: "5 · average +2.38% vs SPY" },
    { label: "Misses", value: "3 · average −3.10% vs SPY" },
  ]);
  const { bars, axis } = reactionBars(reaction.series);
  assert.equal(bars.length, 8);
  assert.equal(bars[0]!.date, "2024-10-23");
  assert.equal(bars.at(-1)!.date, "2026-07-22");
  assert.deepEqual(axis.ticks, [-10, -5, 0, 5, 10]);
  // The biggest move (-5.0 on 2025-07-23 or +6.1 on 2026-01-21) is at most half the chart tall.
  assert.ok(bars.every((bar) => bar.heightPct <= 50));
  assert.equal(bars.find((bar) => bar.date === "2026-01-21")!.text, "+6.1%");
  assert.equal(bars.find((bar) => bar.date === "2025-07-23")!.tone, "down");
  assert.deepEqual(axisTicks(0.4).ticks, [-0.4, -0.2, 0, 0.2, 0.4]);
  assert.equal(axisTicks(0).top, 1);
  assert.equal(axisTicks(Number.NaN).top, 1);
  assert.deepEqual(axisTicks(18).ticks.at(-1), 20);
  assert.equal(axisLabel(0), "0%");
  assert.equal(axisLabel(-5), "−5%");
  assert.equal(axisLabel(2.5), "+2.5%");
});

test("the implied move is a number when quotes exist and the copy-table row when they do not", () => {
  assert.equal(impliedMoveText(4.6), "Options imply a move of ±4.6%");
  assert.equal(impliedMoveText(null), "Option quotes connect after the Alpaca setup");
});

test("timeline rows, filters, links and pagination", () => {
  const rows = timelineRows(timeline.items);
  assert.equal(rows.length, 7);
  assert.equal(rows[0]!.when, "Thu 2026-10-29");
  assert.equal(rows[0]!.kind, "Macro");
  assert.equal(rows[2]!.isAi, true);
  assert.deepEqual(rows[4]!.link, { href: "https://example.com/news/ko", external: true });
  assert.equal(rows[0]!.link, null);
  assert.deepEqual(TIMELINE_FILTERS.map((filter) => filter.label), ["All", "Earnings", "Desk AI", "News", "Strategy", "Filings"]);
  assert.deepEqual(TIMELINE_FILTERS.map((filter) => filter.kind), [undefined, "earnings", "desk_ai", "news", "strategy", "filing"]);
  assert.equal(timelineHasMore(7, 7), false);
  assert.equal(timelineHasMore(20, 55), true);
  assert.deepEqual(safeHref("/technicals?symbol=KO"), { href: "/technicals?symbol=KO", external: false });
  for (const bad of ["javascript:alert(1)", "//evil.example/x", "data:text/html,x", "ftp://x", "/a\\b", "", null]) assert.equal(safeHref(bad), null, String(bad));
});

test("the timeline loader sends the kind and the page", async () => {
  const seen: string[] = [];
  const client = createDeskApiClient(async (input) => {
    const url = input as URL;
    seen.push(url.pathname + url.search);
    return Response.json(timeline);
  }, () => ({ href: "https://trading.test/" }));
  await loadTimeline("KO", { kind: "news", limit: 20, offset: 40 }, { client });
  await loadTimeline("KO", {}, { client });
  assert.deepEqual(seen, ["/api/desk/research/symbols/KO/timeline?kind=news&limit=20&offset=40", "/api/desk/research/symbols/KO/timeline"]);
});

test("nothing the Research screens print carries banned wording", () => {
  const texts = everyText([
    briefRunLine(brief.run), briefRows(brief), trackRecordTiles(brief.track_record), consensusPeriods(aapl.consensus!.quarters), surpriseRows(aapl.consensus!.surprises),
    revisionCells(jnj.consensus!.revisions), targetsView(aapl.targets!), methodRows(valuation.methods), blendView(valuation.blend, valuation.price),
    reactionSummary(valuation.earnings_reaction!), impliedMoveText(null), timelineRows(timeline.items),
  ]);
  assert.ok(texts.length > 50);
  for (const text of texts) assert.equal(containsBannedTerm(text), false, text);
});
