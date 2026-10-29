import assert from "node:assert/strict";
import test from "node:test";
import { loadFundamentalFixture } from "../fixtures/desk-fundamental/load.ts";
import {
  BriefSchema, CandidatesSchema, CoverageSchema, HoldingsSchema, ImportResponseSchema, IncomeSchema, LotsSchema, ResearchSchema,
  RollSchema, ShortCallsSchema, TimelineSchema, ValuationSchema,
} from "./fundamentalSchemas.ts";
import type { ZodType } from "zod";

// Every frozen fixture of a real endpoint parses with the schema its screen uses (02n §h step 3b).
const cases: Array<[string, ZodType]> = [
  ["holdings", HoldingsSchema],
  ["holdings_account_2", HoldingsSchema],
  ["holdings_import", ImportResponseSchema],
  ["holdings_lots_aapl", LotsSchema],
  ["covered_calls_coverage", CoverageSchema],
  ["covered_calls_candidates_aapl_1", CandidatesSchema],
  ["covered_calls_candidates_aapl_2", CandidatesSchema],
  ["covered_calls_candidates_ko", CandidatesSchema],
  ["covered_calls_short_calls", ShortCallsSchema],
  ["covered_calls_roll_jnj", RollSchema],
  ["covered_calls_roll_ko", RollSchema],
  ["covered_calls_income", IncomeSchema],
  ["covered_calls_income_3", IncomeSchema],
  ["research_brief", BriefSchema],
  ["research_aapl", ResearchSchema],
  ["research_jnj", ResearchSchema],
  ["research_valuation_aapl", ValuationSchema],
  ["research_valuation_nvda", ValuationSchema],
  ["research_timeline_ko", TimelineSchema],
  ["research_timeline_ko_news", TimelineSchema],
];

for (const [name, schema] of cases) {
  test(`fixture ${name} parses`, () => {
    assert.doesNotThrow(() => schema.parse(loadFundamentalFixture(name)));
  });
}

test("a NaN or a missing field is rejected", () => {
  const holdings = loadFundamentalFixture("holdings") as { totals: { cost: unknown } };
  assert.equal(HoldingsSchema.safeParse({ ...holdings, totals: { ...holdings.totals, cost: Number.NaN } }).success, false);
  assert.equal(HoldingsSchema.safeParse({}).success, false);
});
