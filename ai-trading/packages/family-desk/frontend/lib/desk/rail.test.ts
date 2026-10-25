import assert from "node:assert/strict";
import test from "node:test";
import { activeRailTab, activeRailTabs, openRailTab, toggleRailTab, toggleRailTabs } from "./rail.ts";

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

test("stacked drawers: a tab never closes another one", () => {
  assert.deepEqual(toggleRailTabs([], "tape"), ["tape"]);
  assert.deepEqual(toggleRailTabs(["tape"], "practice"), ["tape", "practice"]);
  assert.deepEqual(toggleRailTabs(["tape", "practice"], "tape"), ["practice"]);
  assert.deepEqual(openRailTab(["tape"], "tape"), ["tape"]);
  assert.deepEqual(openRailTab(["tape"], "practice"), ["tape", "practice"]);
});

test("open sections keep the page's order and drop the ones that disappeared", () => {
  assert.deepEqual(activeRailTabs(["levels", "summary", "gone"], tabs), ["summary", "levels"]);
  assert.deepEqual(activeRailTabs([], tabs), []);
});
