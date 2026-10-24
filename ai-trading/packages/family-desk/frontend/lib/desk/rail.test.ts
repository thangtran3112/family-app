import assert from "node:assert/strict";
import test from "node:test";
import { activeRailTab, toggleRailTab } from "./rail.ts";

const tabs = [{ id: "summary", label: "Summary" }, { id: "alerts", label: "Alerts" }, { id: "levels", label: "Levels" }];

test("a tab opens, a second click closes it, another tab replaces it", () => {
  assert.equal(toggleRailTab(null, "summary"), "summary");
  assert.equal(toggleRailTab("summary", "summary"), null);
  assert.equal(toggleRailTab("summary", "levels"), "levels");
});

test("an open tab that disappears reads as closed", () => {
  assert.equal(activeRailTab("alerts", tabs), "alerts");
  assert.equal(activeRailTab("gone", tabs), null);
  assert.equal(activeRailTab(null, tabs), null);
});
