import assert from "node:assert/strict";
import test from "node:test";
import {
  AVATAR_MENU,
  FUTURES_HOME,
  hasMoreLeftRail,
  hasPracticeLeftRail,
  isNavActive,
  isPracticePath,
  isReplayWorkspacePath,
  isWrongLane,
  LANES,
  laneForPath,
  LANE_STORAGE_KEY,
  MORE_SECTIONS,
  moreSectionFor,
  otherLane,
  PRIMARY_NAV,
  readLanePreference,
  writeLanePreference,
} from "./lanes.ts";

test("every desktop route maps to a lane; the shared routes render the active lane's variant", () => {
  for (const path of ["/screener", "/screener/filters", "/alerts", "/alerts/new", "/strategies", "/strategies/library", "/strategies/new", "/practice", "/practice/replay", "/practice/journal", "/technicals", "/futures", "/feedback", "/feedback/new"]) {
    assert.equal(laneForPath(path), "technical", path);
  }
  for (const path of ["/", "/today", "/watchlists", "/settings", "/more", "/futures/specs", "/today/", "/futures/specs/"]) {
    assert.equal(laneForPath(path), "shared", path);
  }
  for (const path of ["/holdings", "/covered-calls", "/stocks", "/futures/read", "/paper", "/backtests", "/ask", "/holdings/", "/futures/read/"]) {
    assert.equal(laneForPath(path), "fundamental", path);
  }
  assert.equal(laneForPath("/unknown-page"), "technical");
});

test("wrong-lane routes show the interstitial in the other lane only; shared routes never do", () => {
  assert.equal(isWrongLane("technical", "/holdings"), true);
  assert.equal(isWrongLane("technical", "/screener"), false);
  assert.equal(isWrongLane("fundamental", "/holdings"), false);
  assert.equal(isWrongLane("fundamental", "/screener"), true);
  assert.equal(isWrongLane("technical", "/futures/read"), true);
  assert.equal(isWrongLane("fundamental", "/futures"), true);
  for (const lane of ["technical", "fundamental"] as const) {
    for (const path of ["/", "/today", "/watchlists", "/settings", "/more", "/futures/specs"]) assert.equal(isWrongLane(lane, path), false, `${lane} ${path}`);
  }
  assert.equal(otherLane("technical"), "fundamental");
});

test("the Fundamental primary nav is Today, Holdings, Covered calls, Stocks, Futures (02n §b1)", () => {
  assert.deepEqual(PRIMARY_NAV.fundamental.map((item) => item.label), ["Today", "Holdings", "Covered calls", "Stocks", "Futures"]);
  assert.deepEqual(PRIMARY_NAV.fundamental.map((item) => item.href), ["/", "/holdings", "/covered-calls", "/stocks", "/futures/read"]);
  // Every Fundamental tab opens a route its own lane may show.
  for (const item of PRIMARY_NAV.fundamental) assert.notEqual(laneForPath(item.href), "technical", item.href);
  assert.equal(isNavActive("/", "/today"), true);
  assert.equal(isNavActive("/covered-calls", "/covered-calls"), true);
  assert.equal(isNavActive("/futures/read", "/futures/read"), true);
});

test("technical primary nav and the avatar menu match 02l §b2", () => {
  assert.deepEqual(PRIMARY_NAV.technical.map((item) => item.label), ["Today", "Screener", "Watchlists", "Alerts", "Strategies", "Practice"]);
  assert.deepEqual(AVATAR_MENU.map((item) => item.label), ["Settings", "More", "Feedback"]);
  assert.equal(AVATAR_MENU.find((item) => item.label === "Feedback")?.href, "/feedback");
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

test("Settings, More and the Feedback log swap the watchlists for the Settings & More sections", () => {
  for (const path of ["/settings", "/more", "/feedback", "/feedback/new", "/feedback/", "/settings/"]) assert.equal(hasMoreLeftRail(path), true, path);
  for (const path of ["/", "/alerts", "/practice", "/feedbacks", "/feedback/other", "/holdings"]) assert.equal(hasMoreLeftRail(path), false, path);
  // The Practice panel and the More sections never both claim one route.
  for (const path of ["/practice/replay", "/practice/day", "/practice/journal", "/settings", "/more", "/feedback", "/feedback/new"]) {
    assert.equal(hasPracticeLeftRail(path) && hasMoreLeftRail(path), false, path);
  }
});

test("the More rail lists the Settings sections and Feedback, and selects the one the address points at", () => {
  assert.deepEqual(MORE_SECTIONS.map((section) => section.label), ["Defaults", "Alert channels", "Data sources", "Brokers", "Strategies", "Feedback"]);
  assert.equal(moreSectionFor("/feedback", ""), "feedback");
  assert.equal(moreSectionFor("/feedback/new", "#settings-trading"), "feedback");
  assert.equal(moreSectionFor("/settings", ""), "defaults");
  assert.equal(moreSectionFor("/settings", "#settings-trading"), "brokers");
  assert.equal(moreSectionFor("/more", "#settings-strategies"), "strategies");
  assert.equal(moreSectionFor("/settings", "#unknown"), "defaults");
});

test("the replay, the day list and the journal own the left rail", () => {
  for (const path of ["/practice/replay", "/practice/day", "/practice/journal", "/practice/day/"]) assert.equal(hasPracticeLeftRail(path), true, path);
  for (const path of ["/practice", "/", "/watchlists", "/practice/other"]) assert.equal(hasPracticeLeftRail(path), false, path);
});

test("the futures specs page is shared, so its way back is the active lane's own futures screen, never the other lane's interstitial", () => {
  for (const lane of LANES) {
    assert.equal(isWrongLane(lane, FUTURES_HOME[lane].href), false, `${lane} -> ${FUTURES_HOME[lane].href}`);
  }
  assert.deepEqual(FUTURES_HOME.technical, { href: "/futures", label: "Back to futures swing" });
  assert.deepEqual(FUTURES_HOME.fundamental, { href: "/futures/read", label: "Back to futures" });
});
