import assert from "node:assert/strict";
import test from "node:test";
import * as ask from "./ask.ts";
import * as backtests from "./backtests.ts";
import * as coveredCalls from "./covered-calls.ts";
import * as holdings from "./holdings.ts";
import * as paper from "./paper.ts";
import * as stocks from "./stocks.ts";
import { fixtureBannerText } from "./banner.ts";

const fixtures = [paper, holdings, ask, coveredCalls, stocks, backtests];
const paperData = paper as unknown as Record<string, unknown>;
const coveredCallData = coveredCalls as unknown as Record<string, unknown>;
const stockData = stocks as unknown as Record<string, unknown>;
const backtestData = backtests as unknown as Record<string, unknown>;

function assertNear(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) < 0.001, `expected ${actual} to be near ${expected}`);
}

function assertNoQualityKey(value: unknown, path = "fixture"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoQualityKey(item, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      assert.notEqual(key, "quality", `${path}.${key} must not imply live data quality`);
      assertNoQualityKey(child, `${path}.${key}`);
    }
  }
}

test("fixture exports contain no data-quality key at any depth", () => {
  fixtures.forEach((fixture) => assertNoQualityKey(fixture));
});

test("fixture banner says the screen is a preview, with no internal phase number", () => {
  assert.equal(fixtureBannerText(), "Preview · not connected yet");
});

test("stocks fixtures include research, calibration, and earnings widgets", () => {
  const longTerm = stockData.stockLongTerm as Record<string, unknown>;
  const brief = stockData.stockBrief as Record<string, unknown>;
  const trackRecord = stockData.stockTrackRecord as Record<string, unknown>;
  const valuation = stockData.stockValuation as Record<string, unknown>;

  assert.ok(longTerm.rating);
  assert.ok(longTerm.confidence);
  assert.ok(longTerm.ratingChange);
  assert.ok(longTerm.priceTargetComparison);
  assert.ok(stockData.stockEpsRevisions);
  assert.ok(stockData.stockAnalystDistribution);
  assert.ok(stockData.stockVoting);
  assert.ok(stockData.stockAlertSettings);
  assert.ok(brief.alerts);
  assert.ok(brief.verdicts);
  assert.ok(trackRecord.confidenceCalibration);
  assert.ok(trackRecord.targetHitRate);
  assert.ok(trackRecord.settledLessons);
  assert.ok(valuation.blend);
  assert.ok(valuation.scenarios);
  assert.ok(valuation.assumptions);
  assert.ok(stockData.stockEarningsReaction);
  assert.equal(longTerm.rating, "Buy");
  assert.equal((longTerm.ratingChange as Record<string, unknown>).from, "Hold");
  assert.equal((trackRecord.targetHitRate as Record<string, unknown>).rate, "40%");
  assert.equal((valuation.blend as Record<string, unknown>).value, "$240");
});

test("paper and covered-call fixtures preserve provenance and review panels", () => {
  assert.ok(paperData.paperFillJournal);
  assert.ok(coveredCallData.coveredCallPayoff);
  assert.ok(coveredCallData.assignmentHistory);
  assert.ok(coveredCallData.weeklyDigest);
  const avgoCandidates = (coveredCallData.coveredCallCandidates as Array<Record<string, unknown>>).filter((candidate) => candidate.symbol === "AVGO");
  assert.deepEqual(avgoCandidates.map((candidate) => candidate.score), ["23.2", "20.2", "13.7"]);
  assert.equal((coveredCallData.coveredCallPayoff as Record<string, unknown>).breakeven, "$345.95/share");
  const fill = (paperData.paperFillJournal as Array<Record<string, unknown>>)[0];
  assert.equal(fill?.version, "v3");
  assert.equal(fill?.signalId, "SAMPLE-SIG-001");
});

test("backtest fixtures include benchmark curve, drawdown, annual returns, and risk metrics", () => {
  const metrics = backtestData.backtestMetrics as Array<Record<string, unknown>>;
  assert.ok(backtestData.backtestEquityCurve);
  assert.ok(backtestData.backtestDrawdown);
  assert.ok(backtestData.backtestYearlyReturns);
  for (const metric of ["Sharpe", "Average win / loss", "Expectancy", "Exposure", "Longest losing streak"]) {
    assert.ok(metrics.some((item) => item.label === metric), `missing ${metric}`);
  }
  const returns = backtestData.backtestYearlyReturns as Array<Record<string, unknown>>;
  assert.equal(returns.find((item) => item.label === "2022")?.value, -4.9);
  const compoundReturn = returns.reduce((factor, item) => factor * (1 + Number(item.value) / 100), 1);
  assertNear(compoundReturn, 1.803);
  const curve = backtestData.backtestEquityCurve as { points: Array<Record<string, unknown>>; benchmarkTotalReturn: string };
  assert.equal(curve.points.at(-1)?.strategy, 180.3);
  assert.equal(curve.points.at(-1)?.benchmark, 250);
  assert.equal(curve.benchmarkTotalReturn, "+150.0%");
});
