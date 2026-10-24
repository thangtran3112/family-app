import assert from "node:assert/strict";
import test from "node:test";
import { loadDeskFixture } from "../fixtures/desk-mvp/load.ts";
import { TechnicalsSchema } from "../api/schemas.ts";
import { countsLine, formatScore, gaugeAriaLabel, historyBanner, needleGeometry, pivotRows, STRATEGY_GAUGE_EMPTY, verdictText, whatChangedText } from "./summary.ts";

const technicals = TechnicalsSchema.parse(loadDeskFixture("technicals_nvda_15m"));

test("counts line matches 02l D4", () => {
  assert.equal(countsLine({ buy: 9, neutral: 3, sell: 2 }), "Buy 9 · Neutral 3 · Sell 2");
  assert.equal(countsLine(null), "Vote counts unavailable");
});

test("needle runs from the left edge at -1 over the top at 0 to the right edge at +1", () => {
  const left = needleGeometry(-1, 61, 90, 90)!;
  assert.ok(Math.abs(left.x2 - 29) < 1e-9 && Math.abs(left.y2 - 90) < 1e-9);
  const top = needleGeometry(0, 61, 90, 90)!;
  assert.ok(Math.abs(top.x2 - 90) < 1e-9 && Math.abs(top.y2 - 29) < 1e-9);
  const right = needleGeometry(1, 61, 90, 90)!;
  assert.ok(Math.abs(right.x2 - 151) < 1e-9);
  assert.equal(needleGeometry(5, 61, 90, 90)!.degrees, 0, "scores clamp");
  assert.equal(needleGeometry(null, 61, 90, 90), null);
});

test("score text and aria label state label and counts, not just colour", () => {
  assert.equal(formatScore(0.33), "+0.33");
  assert.equal(formatScore(-0.176), "−0.18");
  assert.equal(formatScore(null), "—");
  const label = gaugeAriaLabel("Summary", "Buy", 0.33, { buy: 9, neutral: 3, sell: 2 });
  assert.equal(label, "Summary: Buy, score +0.33. Buy 9 · Neutral 3 · Sell 2");
});

test("verdict and what-changed lines", () => {
  assert.equal(verdictText("Sell", "15m"), "Sell on 15m");
  assert.equal(verdictText("warming up", "1W"), "Warming up on 1W");
  assert.match(whatChangedText(technicals), /^Moved from Strong Sell to Sell at \d{1,2}:\d{2} [AP]M$/);
  assert.equal(whatChangedText({ bias_ready: true, bias_history: { history: [], last_change_in_window: null } }), "No change in the last 20 bars");
  assert.equal(whatChangedText({ bias_ready: false, bias_history: null }), "Bias is still warming up");
});

test("history banner only when bias is not ready", () => {
  assert.equal(historyBanner({ bias_ready: false }, "1W"), "Not enough history for 1W yet");
  assert.equal(historyBanner({ bias_ready: true }, "1W"), null);
  assert.equal(STRATEGY_GAUGE_EMPTY, "Attach a strategy to see its vote");
});

test("pivot rows run S3 to R3 with all three methods", () => {
  const rows = pivotRows(technicals.pivots);
  assert.deepEqual(rows.map((r) => r.point), ["S3", "S2", "S1", "P", "R1", "R2", "R3"]);
  assert.equal(rows[3]!.classic, technicals.pivots.classic.P);
  assert.equal(typeof rows[0]!.fibonacci, "number");
  assert.equal(pivotRows({ classic: {}, fibonacci: {}, camarilla: {} })[0]!.classic, null);
});
