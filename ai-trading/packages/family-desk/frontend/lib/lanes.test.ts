import assert from "node:assert/strict";
import test from "node:test";
import {
  AVATAR_MENU,
  hasPracticeLeftRail,
  isNavActive,
  isPracticePath,
  isReplayWorkspacePath,
  isWrongLane,
  laneForPath,
  LANE_STORAGE_KEY,
  otherLane,
  PRIMARY_NAV,
  readLanePreference,
  writeLanePreference,
} from "./lanes.ts";

test("every desktop route maps to a lane; the MVP routes are technical", () => {
  for (const path of ["/", "/today", "/screener", "/screener/filters", "/watchlists", "/alerts", "/alerts/new", "/strategies", "/strategies/library", "/strategies/new", "/practice", "/practice/replay", "/practice/journal", "/technicals", "/futures", "/futures/specs", "/settings", "/more"]) {
    assert.equal(laneForPath(path), "technical", path);
  }
  for (const path of ["/holdings", "/covered-calls", "/stocks", "/paper", "/backtests", "/ask", "/holdings/"]) {
    assert.equal(laneForPath(path), "fundamental", path);
  }
  assert.equal(laneForPath("/unknown-page"), "technical");
});

test("wrong-lane routes show the interstitial in the other lane only", () => {
  assert.equal(isWrongLane("technical", "/holdings"), true);
  assert.equal(isWrongLane("technical", "/screener"), false);
  assert.equal(isWrongLane("fundamental", "/holdings"), false);
  assert.equal(isWrongLane("fundamental", "/screener"), true);
  assert.equal(otherLane("technical"), "fundamental");
});

test("technical primary nav and the avatar menu match 02l §b2", () => {
  assert.deepEqual(PRIMARY_NAV.technical.map((item) => item.label), ["Today", "Screener", "Watchlists", "Alerts", "Strategies", "Practice"]);
  assert.deepEqual(AVATAR_MENU.map((item) => item.label), ["Settings", "More"]);
  assert.equal(isNavActive("/", "/today"), true);
  assert.equal(isNavActive("/", "/screener"), false);
  assert.equal(isNavActive("/screener", "/screener/filters"), true);
  assert.equal(isNavActive("/strategies/library", "/strategies/new", "/strategies"), true);
  assert.equal(isNavActive("/strategies/library", "/alerts", "/strategies"), false);
  assert.equal(PRIMARY_NAV.technical.find((item) => item.label === "Strategies")?.href, "/strategies/library");
  assert.equal(isNavActive("/alerts", "/alerts/new"), true);
});

test("the lane preference survives a missing or throwing storage", () => {
  const store = new Map<string, string>();
  const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value) };
  assert.equal(readLanePreference(storage), "technical");
  writeLanePreference(storage, "fundamental");
  assert.equal(store.get(LANE_STORAGE_KEY), "fundamental");
  assert.equal(readLanePreference(storage), "fundamental");
  assert.equal(readLanePreference(null), "technical");
  const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
  assert.equal(readLanePreference(broken), "technical");
  assert.doesNotThrow(() => writeLanePreference(broken, "technical"));
});

test("Practice routes: nav highlight, band and the replay-only left rail", () => {
  assert.equal(PRIMARY_NAV.technical.find((item) => item.label === "Practice")?.href, "/practice");
  assert.equal(isNavActive("/practice", "/practice/replay"), true);
  assert.equal(isNavActive("/practice", "/strategies"), false);
  for (const path of ["/practice", "/practice/", "/practice/replay", "/practice/journal"]) assert.equal(isPracticePath(path), true, path);
  for (const path of ["/", "/practices", "/strategies"]) assert.equal(isPracticePath(path), false, path);
  assert.equal(isReplayWorkspacePath("/practice/replay"), true);
  assert.equal(isReplayWorkspacePath("/practice/replay/"), true);
  assert.equal(isReplayWorkspacePath("/practice/journal"), false);
  assert.equal(isReplayWorkspacePath("/practice"), false);
});

test("the replay, the day list and the journal own the left rail", () => {
  for (const path of ["/practice/replay", "/practice/day", "/practice/journal", "/practice/day/"]) assert.equal(hasPracticeLeftRail(path), true, path);
  for (const path of ["/practice", "/", "/watchlists", "/practice/other"]) assert.equal(hasPracticeLeftRail(path), false, path);
});
