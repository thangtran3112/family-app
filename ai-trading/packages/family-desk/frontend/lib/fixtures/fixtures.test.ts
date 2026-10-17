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

test("fixture banner names the phase when the screen will be wired", () => {
  assert.equal(fixtureBannerText(6), "Fixture — wired in Phase 6");
  assert.equal(fixtureBannerText("6b"), "Fixture — wired in Phase 6b");
});
