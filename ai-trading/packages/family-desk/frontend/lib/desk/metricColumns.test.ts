import assert from "node:assert/strict";
import test from "node:test";
import { loadFundamentalFixture } from "../fixtures/desk-fundamental/load.ts";
import { HoldingsSchema } from "../api/fundamentalSchemas.ts";
import { METRIC_KEYS } from "../settings/fundamental.ts";
import { containsBannedTerm } from "./freshness.ts";
import { ALL_METRICS, METRIC_META, metricCell, metricLabel } from "./metricColumns.ts";
import { MASK } from "./mask.ts";

const aapl = HoldingsSchema.parse(loadFundamentalFixture("holdings")).rows.find((row) => row.symbol === "AAPL")!.fundamentals;

test("every metric key has a label and a kind", () => {
  assert.deepEqual(Object.keys(METRIC_META).sort(), [...METRIC_KEYS].sort());
  assert.equal(ALL_METRICS.length, 18);
  assert.equal(metricLabel("fwd_pe"), "Fwd P/E");
});

test("metric cells format by kind and never print a missing value", () => {
  assert.deepEqual(metricCell("fwd_pe", aapl, true), { text: "28.4", tone: null, rating: null });
  assert.deepEqual(metricCell("fcf_yield_pct", aapl, true), { text: "3.1%", tone: null, rating: null });
  assert.deepEqual(metricCell("eps_rev_30d_pct", aapl, true), { text: "+1.4%", tone: "up", rating: null });
  assert.deepEqual(metricCell("dist_to_252d_high_pct", aapl, true), { text: "−3.1%", tone: "down", rating: null });
  assert.equal(metricCell("next_earnings", aapl, true).text, "2027-01-28");
  assert.equal(metricCell("ai_target_base", aapl, true).text, "$265.00");
  assert.equal(metricCell("ai_rating", aapl, true).rating, "buy");
  // Nothing known: a dash, whatever the kind.
  for (const key of METRIC_KEYS) assert.equal(metricCell(key, {}, false).text, "—");
  assert.equal(metricCell("ex_dividend", aapl, false).text, "—");
});

test("the coverable count is a contract count: hidden while values are hidden", () => {
  assert.equal(metricCell("cc_coverable", aapl, true).text, MASK);
  assert.equal(metricCell("cc_coverable", aapl, false).text, "3");
  for (const key of METRIC_KEYS) assert.equal(containsBannedTerm(metricCell(key, aapl, false).text), false, key);
});
