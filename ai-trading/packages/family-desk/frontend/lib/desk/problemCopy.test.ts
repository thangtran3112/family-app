import assert from "node:assert/strict";
import test from "node:test";
import { StrategySpecV1Schema } from "@ai-trading/contracts";
import { fieldLabel, plainMessage, plainProblem, problemLine } from "./problemCopy.ts";

test("V-ALERTS-01: the empty-symbols error reads as an instruction, with no schema words or JSON path", () => {
  const server = { path: "watch.universe.symbols", message: "List should have at least 1 item after validation, not 0" };
  assert.deepEqual(plainProblem(server), { field: "Symbols", text: "Add at least 1 symbol." });
  assert.equal(problemLine(server), "Symbols: Add at least 1 symbol.");
  for (const leak of ["watch.", "after validation", "List should", "universe"]) assert.equal(problemLine(server).includes(leak), false, leak);
});

test("pydantic and zod messages for the same mistake read the same", () => {
  assert.equal(plainMessage("String should have at least 1 character", "name"), "Fill this in.");
  assert.equal(plainMessage("Too small: expected string to have >=1 characters", "name"), "Fill this in.");
  assert.equal(plainMessage("Field required", "name"), "Fill this in.");
  assert.equal(plainMessage("Too small: expected array to have >=1 items", "then.alert.channels"), "Add at least 1 channel.");
  assert.equal(plainMessage("List should have at least 2 items after validation, not 1", "when.all"), "Add at least 2 items.");
  assert.equal(plainMessage("Too small: expected number to be >=1", "limits.maxTradesPerDay"), "Must be 1 or more.");
  assert.equal(plainMessage("Input should be greater than or equal to 0", "limits.cooldownMinutes"), "Must be 0 or more.");
  assert.equal(plainMessage("Too big: expected number to be <=12", "limits.maxTradesPerDay"), "Must be 12 or less.");
  assert.equal(plainMessage("Input should be less than or equal to 1440", "limits.cooldownMinutes"), "Must be 1440 or less.");
  assert.equal(plainMessage("Invalid input: expected number, received NaN", "limits.cooldownMinutes"), "Enter a number.");
  assert.equal(plainMessage("Input should be a valid number", "limits.cooldownMinutes"), "Enter a number.");
  assert.equal(plainMessage("Invalid input: expected int, received number", "limits.maxOpenPositions"), "Use a whole number.");
  assert.equal(plainMessage("Invalid input", "then.paperOrder.size"), "Check this value.");
});

test("a message already in plain words passes through unchanged", () => {
  assert.equal(plainMessage("the first alert channel must be inbox", "then.alert.channels"), "the first alert channel must be inbox");
});

test("field labels name the form control, never the schema path", () => {
  const cases: Record<string, string> = {
    name: "Name",
    "watch.universe.symbols": "Symbols",
    "watch.universe.watchlist": "Watchlist",
    "watch.universe.filter": "Screener filter",
    "watch.session": "Session",
    "watch.runOn": "Run on",
    "limits.cooldownMinutes": "Cooldown (minutes)",
    "limits.maxPositionUsd": "Max position size ($)",
    "limits.flatBy": "Flat by (ET)",
    "then.alert.channels": "Alert channels",
    "then.paperOrder.size.riskUsd": "Paper order · Risk per trade ($)",
    "then.paperOrder.stop.atrMultiple": "Paper order · Stop ATR multiple",
    when: "Condition",
    "when.all.1.right": "Condition 2 · right side",
    "when.left.smoothK": "Condition · left side · %K smoothing",
    "when.any.0.left.lookbackDays": "Condition 1 · left side · Lookback (days)",
    "limits.somethingNew": "Something new",
  };
  for (const [path, label] of Object.entries(cases)) assert.equal(fieldLabel(path), label, path);
});

test("every real spec error stays free of camelCase identifiers and dotted paths", () => {
  const base = {
    schemaVersion: 1, name: "x", watch: { universe: { watchlist: "A" }, session: "regular", runOn: "bar_close_1m" },
    when: { op: "gte", left: { series: "close" }, right: { value: 1 } }, then: { alert: { channels: ["inbox"] } },
  };
  const bad = [
    { ...base, name: "" },
    { ...base, watch: { ...base.watch, universe: { symbols: [] } } },
    { ...base, limits: { maxTradesPerDay: 99, cooldownMinutes: Number.NaN, maxOpenPositions: 1.5 } },
    { ...base, when: { op: "crosses_above", left: { series: "stochastic", line: "k", length: 14, smoothK: 0, smoothD: 3 }, right: { value: 1 } } },
    { ...base, then: { alert: { channels: [] }, paperOrder: { side: "buy", size: { riskUsd: Number.NaN }, stop: { atrMultiple: 99 }, target: { r: 2 } } } },
  ];
  for (const spec of bad) {
    const result = StrategySpecV1Schema.safeParse(spec);
    assert.equal(result.success, false);
    if (result.success) continue;
    for (const issue of result.error.issues) {
      const line = problemLine({ path: issue.path.join("."), message: issue.message });
      assert.equal(/[a-z][A-Z]/.test(line), false, line);
      assert.equal(/\w\.\w/.test(line), false, line);
      assert.equal(/Too small|Too big|expected/.test(line), false, line);
    }
  }
});
