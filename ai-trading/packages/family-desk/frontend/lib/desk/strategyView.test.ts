import assert from "node:assert/strict";
import test from "node:test";
import { stageLabel, stageTone } from "./strategyView.ts";

test("a stage reads as a word and a tone: draft is quiet, alert-only and paper are warn", () => {
  assert.deepEqual(["draft", "alert_only", "paper"].map(stageLabel), ["Draft", "Alert only", "Paper"]);
  assert.deepEqual(["draft", "alert_only", "paper", "retired"].map(stageTone), ["neutral", "warn", "warn", "neutral"]);
  assert.equal(stageLabel("live_trading"), "live trading");
});
