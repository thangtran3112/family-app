import assert from "node:assert/strict";
import test from "node:test";
import { AlertStrategySpecV1Schema } from "@ai-trading/contracts/alert-strategy";
import { AlertStrategiesSchema } from "../api/schemas.ts";
import { loadDeskFixture } from "../fixtures/desk-mvp/load.ts";
import {
  alertFormFromSpec,
  alertFormToSpec,
  ALERT_OPERATORS,
  applyPrefill,
  defaultAlertForm,
  groupProblems,
  isAlertFormDirty,
  miniChartModel,
  nameFor,
  operatorOf,
  parsePrefill,
  stepOf,
  turnOnState,
  withOperator,
} from "./alertForm.ts";

const form = (changes: Partial<ReturnType<typeof defaultAlertForm>> = {}) => ({ ...defaultAlertForm(), symbol: "NVDA", ...changes });

test("the default form builds a valid alert-only spec: inbox first, no paper order", () => {
  const spec = alertFormToSpec(form());
  const parsed = AlertStrategySpecV1Schema.safeParse(spec);
  assert.equal(parsed.success, true, parsed.success ? "" : parsed.error.message);
  assert.deepEqual((spec.then as { alert: { channels: string[] } }).alert.channels, ["inbox"]);
  assert.equal("paperOrder" in (spec.then as object), false);
  assert.equal(spec.name, "NVDA alert");
});

test("source kinds map to the three universes and names fall back to the source", () => {
  assert.deepEqual((alertFormToSpec(form({ symbol: "nvda, amd" })).watch as { universe: unknown }).universe, { symbols: ["NVDA", "AMD"] });
  assert.deepEqual((alertFormToSpec(form({ sourceKind: "watchlist", watchlist: "Day movers" })).watch as { universe: unknown }).universe, { watchlist: "Day movers" });
  assert.deepEqual((alertFormToSpec(form({ sourceKind: "filter", filter: "Abnormal volume" })).watch as { universe: unknown }).universe, { filter: "Abnormal volume" });
  assert.equal(nameFor(form({ sourceKind: "watchlist", watchlist: "Day movers" })), "Day movers alert");
  assert.equal(nameFor(form({ name: "  My alert " })), "My alert");
  assert.equal(nameFor(form({ name: "x".repeat(200) })).length, 80);
});

test("deliver step: Telegram and Slack follow inbox; cooldown, expiry and message are optional", () => {
  const spec = alertFormToSpec(form({ telegram: true, slack: true, cooldownMinutes: "30", expiresOn: "2026-12-31", message: "" }));
  assert.deepEqual((spec.then as { alert: { channels: string[] } }).alert.channels, ["inbox", "telegram", "slack"]);
  assert.deepEqual(spec.limits, { cooldownMinutes: 30 });
  assert.equal((spec.then as { alert: { expiresOn: string } }).alert.expiresOn, "2026-12-31");
  assert.equal("message" in (spec.then as { alert: object }).alert, false);
  assert.equal(AlertStrategySpecV1Schema.safeParse(spec).success, true);
});

test("every fixture alert strategy survives edit-form and back", () => {
  const strategies = AlertStrategiesSchema.parse(loadDeskFixture("alert_strategies"));
  for (const strategy of strategies) {
    const parsed = AlertStrategySpecV1Schema.safeParse(strategy.spec);
    if (!parsed.success) continue; // seeds with extra fields are shown read-only elsewhere
    const edit = alertFormFromSpec(parsed.data);
    const back = AlertStrategySpecV1Schema.safeParse(alertFormToSpec(edit));
    assert.equal(back.success, true, strategy.name);
    assert.equal(isAlertFormDirty(edit, alertFormFromSpec(parsed.data)), false);
  }
});

test("dirty tracking sees edits to any step", () => {
  const original = form();
  assert.equal(isAlertFormDirty(original, form()), false);
  assert.equal(isAlertFormDirty(original, form({ symbol: "AMD" })), true);
  assert.equal(isAlertFormDirty(original, form({ frequency: "once" })), true);
  assert.equal(isAlertFormDirty(original, form({ telegram: true })), true);
});

test("prefill: symbol, watchlist id and filter id resolve; junk is ignored", () => {
  assert.deepEqual(parsePrefill({ source: "symbol:nvda", from: null }), { kind: "symbol", symbol: "NVDA" });
  assert.deepEqual(parsePrefill({ source: "symbol:/ES", from: null }), { kind: "symbol", symbol: "/ES" });
  assert.deepEqual(parsePrefill({ source: "watchlist:2", from: null }), { kind: "watchlist", id: 2 });
  assert.deepEqual(parsePrefill({ source: null, from: "filter:3" }), { kind: "filter", id: 3 });
  for (const junk of ["", "symbol:", "symbol:1234", "watchlist:x", "filter:0", "nonsense"]) assert.equal(parsePrefill({ source: junk, from: null }), null, junk);
  const lists = [{ id: 2, name: "Swing" }];
  const filters = [{ id: 3, name: "Abnormal volume" }];
  assert.equal(applyPrefill(form(), { kind: "watchlist", id: 2 }, lists, filters).watchlist, "Swing");
  assert.equal(applyPrefill(form(), { kind: "filter", id: 3 }, lists, filters).sourceKind, "filter");
  assert.equal(applyPrefill(form(), { kind: "filter", id: 9 }, lists, filters).filter, "");
  assert.deepEqual(applyPrefill(form(), null, lists, filters), form());
});

test("operators: the TradingView set plus pattern, switching keeps operands", () => {
  assert.deepEqual(ALERT_OPERATORS.map((o) => o.label), ["Crossing up", "Crossing down", "Greater than", "At least", "Less than", "At most", "Within % of", "Pattern detected"]);
  const row = form().rows[0]!;
  assert.equal(operatorOf(row), "crosses_above");
  const less = withOperator(row, "lt");
  assert.deepEqual(less, { op: "lt", left: { series: "close" }, right: { series: "vwap" } });
  assert.deepEqual(withOperator(less, "within_pct"), { op: "within_pct", left: { series: "close" }, right: { series: "vwap" }, pct: 1 });
  assert.deepEqual(withOperator(row, "pattern"), { op: "pattern", pattern: "hammer" });
  assert.deepEqual(withOperator({ op: "pattern", pattern: "doji" }, "gt"), { op: "gt", left: { series: "close" }, right: { value: 0 } });
  assert.equal(operatorOf({ op: "time_between", start: "09:30", end: "10:00" }), null);
});

test("mini chart: a number the price is compared with becomes a level, a pattern a label", () => {
  const level = form({ rows: [{ op: "crosses_above", left: { series: "close" }, right: { value: 215.5 } }] });
  assert.deepEqual(miniChartModel(level, ["NVDA"]), { symbol: "NVDA", level: 215.5, levelLabel: "Alert level 215.5", patternLabel: null, interval: "15m" });
  const pattern = form({ rows: [{ op: "pattern", pattern: "bullish_engulfing" }], runOn: "daily_close" });
  assert.deepEqual(miniChartModel(pattern, ["NVDA"]), { symbol: "NVDA", level: null, levelLabel: null, patternLabel: "Bullish engulfing", interval: "1d" });
  assert.equal(miniChartModel(form({ symbol: "N" }), []).symbol, null, "a half-typed ticker is not charted");
});

test("Turn on is disabled until the alert runtime starts", () => {
  assert.deepEqual(turnOnState("not_started"), { enabled: false, reason: "Alerts start when live quotes are connected" });
  assert.deepEqual(turnOnState(null), { enabled: false, reason: "Alerts start when live quotes are connected" });
  assert.deepEqual(turnOnState("running"), { enabled: true, reason: null });
  assert.deepEqual(turnOnState("paused_no_quotes"), { enabled: true, reason: null });
});

test("server problems sort into steps", () => {
  assert.deepEqual(["name", "watch.universe.symbols", "when.all.1.right", "watch.runOn", "limits.cooldownMinutes", "then.alert.channels", "mystery"].map(stepOf), ["source", "source", "condition", "trigger", "trigger", "deliver", "other"]);
  const groups = groupProblems([{ path: "then.alert.channels", message: "the first alert channel must be inbox" }, { path: "when", message: "x" }]);
  assert.equal(groups.deliver.length, 1);
  assert.equal(groups.condition.length, 1);
});
