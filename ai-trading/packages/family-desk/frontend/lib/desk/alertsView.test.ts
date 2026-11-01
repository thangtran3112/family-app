import assert from "node:assert/strict";
import test from "node:test";
import { DeskApiError } from "../api/client.ts";
import { AlertLogSchema, AlertStrategiesSchema } from "../api/schemas.ts";
import { loadDeskFixture } from "../fixtures/desk-mvp/load.ts";
import { actionError, actionFor, actionLabel, channelsText, defaultAlertFilters, frequencyText, lastFiredText, deliveryTone, logRowText, sourceText, statusText, statusTone, toQuery, triggerText } from "./alertsView.ts";

const strategies = AlertStrategiesSchema.parse(loadDeskFixture("alert_strategies"));
const log = AlertLogSchema.parse(loadDeskFixture("alerts_log"));

test("filters become request params; junk and empty values are dropped", () => {
  assert.deepEqual(toQuery(defaultAlertFilters()), { status: undefined, category: undefined, symbol: undefined, sort: "last_fired" });
  assert.deepEqual(toQuery({ status: "paused", category: "pattern", symbol: " nvda ", sort: "name" }), { status: "paused", category: "pattern", symbol: "NVDA", sort: "name" });
  assert.equal(toQuery({ ...defaultAlertFilters(), status: "weird" }).status, undefined);
});

test("rows read in plain words", () => {
  const vwap = strategies.find((s) => s.name === "VWAP reclaim")!;
  assert.equal(sourceText({ kind: "watchlist", id: 1, label: "Day movers" }), "Watchlist · Day movers");
  assert.equal(sourceText({ kind: "filter", id: 3, label: "Abnormal volume" }), "Screener · Abnormal volume");
  assert.equal(triggerText(vwap), "close crosses above VWAP and time is between 09:45 and 15:30");
  assert.equal(triggerText({ spec: { broken: true } }), "Custom rule (see JSON)");
  assert.equal(frequencyText({ frequency: "once_per_bar", cooldown_minutes: 30 }), "Once per bar close · 30 min cooldown");
  assert.equal(frequencyText({ frequency: "every_time", cooldown_minutes: null }), "Every time");
  assert.equal(channelsText(["inbox", "telegram"]), "Inbox, Telegram");
  assert.equal(lastFiredText(null), "Never fired");
  assert.match(lastFiredText("2026-10-23T14:15:00Z"), /^2026-10-23 10:15$/);
  assert.equal(statusText({ status: "paused", paused_reason: "user" }), "Paused · user");
  assert.equal(statusText({ status: "active", paused_reason: null }), "Active");
});

test("the row action follows the status", () => {
  assert.equal(actionFor({ status: "active", stage: "alert_only" }), "pause");
  assert.equal(actionFor({ status: "paused", stage: "alert_only" }), "resume");
  assert.equal(actionFor({ status: "draft", stage: "draft" }), "turn_on");
  assert.equal(actionFor({ status: "expired", stage: "alert_only" }), null);
  assert.deepEqual((["pause", "resume", "turn_on"] as const).map(actionLabel), ["Pause", "Resume", "Turn on"]);
});

test("a 409 shows the API sentence; anything else a generic one with no code", () => {
  assert.equal(actionError(new DeskApiError("http", 409, { detail: "Alerts start when live quotes are connected" })), "Alerts start when live quotes are connected");
  const generic = actionError(new DeskApiError("http", 503));
  assert.equal(generic, "Couldn't update the alert · Try again");
  assert.doesNotMatch(generic, /503/);
  assert.equal(actionError(new DeskApiError("http", 404, { detail: "Not Found" })), "Couldn't update the alert · Try again");
});

test("log rows show delivery wording, with held and no-channel visible", () => {
  assert.ok(log.length > 0);
  assert.ok(new Set(log.map((r) => r.status)).size >= 2);
  const text = logRowText(log[0]!);
  assert.match(text.when, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.doesNotMatch(text.what, /null|undefined/);
  assert.equal(logRowText({ ...log[0]!, symbol: null, strategy_name: null }).what, "— · Alert");
});

test("status and delivery map onto the tone model: a word plus colour, warn for a hold", () => {
  assert.deepEqual((["active", "paused", "draft", "expired"] as const).map(statusTone), ["up", "warn", "neutral", "neutral"]);
  assert.deepEqual(["delivered", "failed", "held_quiet_hours", "no_channel"].map(deliveryTone), ["up", "down", "warn", "warn"]);
});
