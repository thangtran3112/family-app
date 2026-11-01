import assert from "node:assert/strict";
import test from "node:test";
import { CandidatesSchema, CoverageSchema, HoldingsSchema, LotsSchema, ResearchSchema, ShortCallsSchema } from "../api/fundamentalSchemas.ts";
import { loadFundamentalFixture } from "../fixtures/desk-fundamental/load.ts";
import { containsBannedTerm } from "./freshness.ts";
import { accountLabel, accountOptions, callsCard, eventLines, holdingsEmptyText, holdingViews, lotViews, railRows, shortCallViews, totalsTiles } from "./holdingsView.ts";
import { MASK } from "./mask.ts";

const holdings = HoldingsSchema.parse(loadFundamentalFixture("holdings"));
const lots = LotsSchema.parse(loadFundamentalFixture("holdings_lots_aapl"));
const coverage = CoverageSchema.parse(loadFundamentalFixture("covered_calls_coverage"));
const shortCalls = ShortCallsSchema.parse(loadFundamentalFixture("covered_calls_short_calls"));
const research = ResearchSchema.parse(loadFundamentalFixture("research_aapl"));

const strings = (value: unknown): string[] => (typeof value === "string" ? [value] : value && typeof value === "object" ? Object.entries(value).filter(([key]) => key !== "row").flatMap(([, item]) => strings(item)) : []);
const clean = (value: unknown) => strings(value).forEach((text) => assert.equal(containsBannedTerm(text), false, text));

test("the account filter names accounts by alias and type, never a broker number", () => {
  assert.deepEqual(accountOptions(holdings.accounts), [
    { id: null, label: "All accounts" },
    { id: 1, label: "Taxable · Taxable" },
    { id: 2, label: "IRA · IRA" },
  ]);
});

test("an account shows by its alias", () => {
  assert.equal(accountLabel(holdings.accounts, 2), "IRA");
  assert.equal(accountLabel(holdings.accounts, 9), "Account 9");
});

test("masked rows hide dollars, shares and contracts and keep prices, percentages and dates", () => {
  const aapl = holdingViews(holdings.rows, true).find((row) => row.symbol === "AAPL")!;
  assert.equal(aapl.shares, MASK);
  assert.equal(aapl.value, MASK);
  assert.equal(aapl.coverable, MASK);
  assert.equal(aapl.openCalls, MASK);
  assert.equal(aapl.avgCost, "$166.49");
  assert.equal(aapl.last, "$231.40");
  assert.deepEqual(aapl.change, { text: "+0.80%", tone: "up" });
  assert.equal(aapl.weight, "43.1%");
  assert.equal(aapl.unrealized.text, "+39.0%");
  assert.equal(aapl.nextEarnings, "Thu 2027-01-28");
  const shown = holdingViews(holdings.rows, false).find((row) => row.symbol === "AAPL")!;
  assert.deepEqual([shown.shares, shown.value, shown.coverable, shown.openCalls], ["900", "$208,260", "3", "1"]);
  clean(holdingViews(holdings.rows, true));
  clean(holdingViews(holdings.rows, false));
});

test("totals tiles hide the dollars and keep the percentages", () => {
  const masked = totalsTiles(holdings.totals, true);
  assert.deepEqual(masked.map((tile) => tile.value), [MASK, MASK, MASK, MASK]);
  assert.equal(masked.find((tile) => tile.key === "day")?.note, "+0.52% today");
  assert.equal(masked.find((tile) => tile.key === "unrealized")?.note, "+27.5%");
  assert.deepEqual(masked.map((tile) => tile.tone), ["neutral", "up", "up", "neutral"], "plain totals carry the shared neutral tone, signed ones the sign");
  const shown = totalsTiles(holdings.totals, false);
  assert.deepEqual(shown.map((tile) => tile.value), ["$483,720", "+$2,521", "+$104,280", "$379,440"]);
  clean(masked);
});

test("the left rail lists the biggest weight first", () => {
  assert.deepEqual(railRows(holdings.rows).map((row) => row.symbol), ["AAPL", "JNJ", "KO", "MSFT", "NVDA"]);
  assert.equal(railRows(holdings.rows)[0]?.weight, "43.1%");
});

test("an empty or unconnected import says why and shows no numbers", () => {
  const base = holdings.import;
  assert.equal(holdingsEmptyText(base, holdings.rows.length), null);
  assert.equal(holdingsEmptyText(base, 0), "No holdings imported for you");
  assert.equal(holdingsEmptyText({ ...base, state: "not_configured", statement_date: null, lots: 0 }, 0), "Holdings aren't connected yet · set up the IBKR import in Settings");
  assert.equal(holdingsEmptyText({ ...base, state: "running", statement_date: null }, 0), "Importing holdings…");
  assert.equal(holdingsEmptyText({ ...base, state: "failed", statement_date: "2026-10-22" }, 3), null);
  assert.equal(holdingsEmptyText({ ...base, state: "running" }, 3), null);
});

test("lots mask their share counts and keep cost per share, term and gain", () => {
  const masked = lotViews(lots.lots, true);
  assert.deepEqual(masked.map((lot) => lot.shares), [MASK, MASK, MASK]);
  assert.equal(masked[0]?.cost, "$152.30");
  assert.equal(masked[0]?.term, "Long term");
  assert.equal(masked[0]?.gain.text, "+51.9%");
  assert.equal(lotViews(lots.lots, false)[0]?.shares, "400");
  clean(masked);
});

test("short calls read in words, with their risks, and a quiet call says so", () => {
  const [aapl, ko] = shortCallViews(shortCalls, true);
  assert.equal(aapl?.title, "$245.00 call · Fri 2026-11-20 · 28 days left");
  assert.equal(aapl?.contracts, `${MASK} contract`);
  assert.deepEqual(aapl?.risks, ["No risk flagged"]);
  assert.equal(ko?.risks.length, 3);
  assert.equal(ko?.risks[1], "Within 2% of the strike with 7 days or fewer left");
  assert.equal(ko?.moneyness, "−0.83% from the strike");
  clean([aapl, ko]);
});

test("the calls card hides contract counts and says when option quotes are not connected", () => {
  const candidates = CandidatesSchema.parse(loadFundamentalFixture("covered_calls_candidates_aapl_1"));
  const card = callsCard("AAPL", coverage.rows, shortCalls, candidates, true);
  assert.deepEqual([card.coverable, card.openCalls], [MASK, MASK]);
  assert.deepEqual(card.best, { annualized: "16.1%", strike: "$245.00", expiry: "Fri 2026-11-20", bid: "$2.85" });
  assert.equal(card.note, null);
  assert.equal(callsCard("AAPL", coverage.rows, shortCalls, candidates, false).coverable, "3");
  const offline = { ...candidates, candidates: [], chain_stamp: { as_of: null, source: null, quality: "unavailable", freshness: "unavailable" } } as typeof candidates;
  assert.equal(callsCard("AAPL", coverage.rows, shortCalls, offline, true).note, "Option quotes connect after the Alpaca setup");
  assert.equal(callsCard("AAPL", coverage.rows, shortCalls, null, true).note, null);
});

test("events give earnings with timing and an ex-dividend date or the word that it is unknown", () => {
  const row = holdings.rows.find((item) => item.symbol === "AAPL")!;
  const lines = eventLines(row, research);
  assert.equal(lines[0]?.text, "Thu 2027-01-28 · After close");
  assert.equal(lines[1]?.text, "Ex-dividend date unknown · check before selling a call");
  assert.equal(eventLines(null, null)[0]?.text, "Date not known yet");
  clean(lines);
});
