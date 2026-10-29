import assert from "node:assert/strict";
import test from "node:test";
import { CandidatesSchema, CoverageSchema, IncomeSchema, RollSchema, ShortCallsSchema } from "../api/fundamentalSchemas.ts";
import { loadFundamentalFixture } from "../fixtures/desk-fundamental/load.ts";
import {
  accountLabel, assignmentNoteText, capText, chainState, costToCloseText, coverageReason, defaultCoverageRow, distinctFlags, flagsText, flagText, formatDelta, formatScore,
  formatYield, incomeChart, incomeView, ivRankLine, monthLabel, moneynessWords, NEEDS_TRADES_TEXT, NO_MATCH_TEXT, NO_RISKS, NO_INCOME_TEXT, opportunityText,
  REASON_WORDS, topRisk,
} from "./coveredCallsView.ts";
import { containsBannedTerm } from "./freshness.ts";
import { MASK } from "./mask.ts";

const candidates = CandidatesSchema.parse(loadFundamentalFixture("covered_calls_candidates_aapl_1"));
const coverage = CoverageSchema.parse(loadFundamentalFixture("covered_calls_coverage"));
const calls = ShortCallsSchema.parse(loadFundamentalFixture("covered_calls_short_calls"));

test("engine fractions read as percents and nothing prints null or NaN", () => {
  const top = candidates.candidates[0]!;
  assert.equal(formatYield(top.annualized_yield), "16.1%");
  assert.equal(formatYield(top.premium_yield), "1.2%");
  assert.equal(formatYield(top.upside_cap), "5.9%");
  assert.equal(formatYield(top.return_if_called), "7.1%");
  assert.equal(formatYield(null), "—");
  assert.equal(formatYield(Number.NaN), "—");
  assert.equal(formatDelta(top.delta), "0.28");
  assert.equal(formatDelta(null), "—");
  assert.equal(formatScore(top.score), "2.25");
});

test("the reason is a word map while values are hidden and the API sentence once shown", () => {
  const under = coverage.rows.find((row) => row.reason === "under_one_contract")!;
  assert.equal(coverageReason(under, false), "150 shares: under one contract at a 50% cap");
  assert.equal(coverageReason(under, true), "Under one contract at the cap");
  for (const row of coverage.rows) {
    const masked = coverageReason(row, true);
    assert.equal(masked, REASON_WORDS[row.reason]);
    assert.equal(/\d/.test(masked), false, `no count in "${masked}"`);
    assert.equal(containsBannedTerm(masked), false);
  }
  assert.equal(capText(50), "Cap 50% of shares");
  assert.equal(capText(33.3), "Cap 33.3% of shares");
});

test("flags, accounts and risks in words", () => {
  assert.equal(flagText("cover_tax_advantaged_first"), "Cover the IRA first");
  assert.equal(flagText("some_new_flag"), "Some new flag");
  assert.equal(flagsText([]), "None");
  assert.equal(flagsText(["short_term_lots", "ex_dividend_before_expiry"]), "Short-term lots, Ex-dividend before expiry");
  assert.deepEqual(distinctFlags(candidates.candidates), ["cover_tax_advantaged_first"]);
  const accounts = [{ id: 1, label: "Taxable" }];
  assert.equal(accountLabel(accounts, 1), "Taxable");
  assert.equal(accountLabel(accounts, 99), "Account");
  assert.equal(topRisk(calls[0]!.risks), NO_RISKS);
  assert.equal(topRisk(calls[1]!.risks), "Delta is above 0.50: assignment is now more likely than not");
  assert.match(moneynessWords(-5.55), /^5\.[56]% below the strike$/);
  assert.equal(moneynessWords(2), "2.0% above the strike");
  assert.equal(moneynessWords(0), "At the strike");
  assert.equal(moneynessWords(null), "—");
});

test("IV rank says how far the history is, and the chain state separates not connected from no match", () => {
  assert.equal(ivRankLine({ iv_rank: null, iv_history_sessions: 6 }), "IV rank needs more history · opportunity alerts start later (6 of 60 sessions)");
  assert.equal(ivRankLine({ iv_rank: 62.4, iv_history_sessions: 80 }), "IV rank 62");
  assert.equal(chainState(candidates), "ready");
  const ko = CandidatesSchema.parse(loadFundamentalFixture("covered_calls_candidates_ko"));
  assert.equal(chainState(ko), "no_match");
  assert.equal(chainState({ ...candidates, candidates: [], chain_stamp: { as_of: null, source: null, quality: "unavailable", freshness: "unavailable" } }), "not_connected");
  assert.equal(containsBannedTerm(NO_MATCH_TEXT), false);
});

test("the opportunity banner needs the engine's flag and a top call", () => {
  assert.equal(opportunityText({ ...candidates, opportunity: false }), null);
  assert.equal(opportunityText({ ...candidates, opportunity: true, candidates: [] }), null);
  assert.equal(opportunityText({ ...candidates, opportunity: true }), "Opportunity: a 2026-11-20 $245 call on AAPL yields 16.1% a year");
});

test("the income chart scales bars to the tallest month and masks the axis, never the shape", () => {
  const income = IncomeSchema.parse(loadFundamentalFixture("covered_calls_income"));
  const shown = incomeChart(income.by_month, false);
  assert.equal(shown.bars.length, 12);
  assert.deepEqual(shown.ticks.map((tick) => tick.label), ["$0", "$200", "$400", "$600"]);
  assert.ok(shown.bars.every((bar) => bar.share >= 0 && bar.share <= 1));
  // The tallest month (Aug, $790) fills the chart, and the highest tick ($600) sits under it.
  assert.equal(Math.max(...shown.bars.map((bar) => bar.share)), 1);
  assert.equal(shown.ticks[3]!.share.toFixed(3), (600 / 790).toFixed(3));
  const masked = incomeChart(income.by_month, true);
  assert.deepEqual(masked.bars, shown.bars);
  assert.ok(masked.ticks.every((tick) => tick.label === MASK));
  assert.equal(monthLabel("2026-10"), "Oct");
  assert.equal(monthLabel("2026-01"), "Jan 2026");
  assert.equal(monthLabel("bad"), "bad");
});

test("income states: ok, needs the Trades section, or nothing yet", () => {
  const income = IncomeSchema.parse(loadFundamentalFixture("covered_calls_income"));
  assert.equal(incomeView(income, false).kind, "ok");
  assert.deepEqual(incomeView({ state: "needs_trades", by_month: [] }, false), { kind: "needs_trades" });
  assert.deepEqual(incomeView({ state: "ok", by_month: [] }, false), { kind: "empty" });
  assert.equal(incomeChart([], false).ticks.length, 0);
  for (const text of [NEEDS_TRADES_TEXT, NO_INCOME_TEXT]) assert.equal(containsBannedTerm(text), false);
});

test("the first row with something to sell opens first, and the roll price line is honest without a quote", () => {
  assert.equal(defaultCoverageRow(coverage.rows)?.symbol, "AAPL");
  assert.equal(defaultCoverageRow([{ coverable: 0, symbol: "X" }])?.symbol, "X");
  assert.equal(defaultCoverageRow([]), null);
  assert.equal(costToCloseText(1.2), "$1.20 a share");
  assert.equal(costToCloseText(null), "Option quotes connect after the Alpaca setup");
  const roll = RollSchema.parse(loadFundamentalFixture("covered_calls_roll_jnj"));
  assert.equal(costToCloseText(roll.cost_to_close), "Option quotes connect after the Alpaca setup");
});

test("the assignment note says it is not tax advice once", () => {
  const roll = RollSchema.parse(loadFundamentalFixture("covered_calls_roll_jnj"));
  assert.equal(assignmentNoteText(roll.assignment_note), roll.assignment_note.text);
  assert.equal((assignmentNoteText(roll.assignment_note).match(/not tax advice/gi) ?? []).length, 1);
  assert.equal(assignmentNoteText({ text: "Taxable: assignment may be a taxable sale." }), "Taxable: assignment may be a taxable sale. Not tax advice");
});
