import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import test from "node:test";
import {
  activeNavItem,
  AVATAR_MENU,
  FUTURES_HOME,
  hasMoreLeftRail,
  hasPracticeLeftRail,
  isNavActive,
  isPracticePath,
  isRegisteredPath,
  isReplayWorkspacePath,
  LANE_HOME,
  LANE_LABEL,
  LANE_STORAGE_KEY,
  LANES,
  lanesForPath,
  LEFT_RAIL_TABS,
  modeFor,
  MORE_SECTIONS,
  moreSectionFor,
  PRIMARY_NAV,
  readLanePreference,
  shows,
  SYMBOL_HREF,
  writeLanePreference,
} from "./lanes.ts";

// The global-modes seam (ADR-0014, design-modes-cutover §3.3): four tables in lanes.ts decide which routes, tabs, shell
// sections and left-rail tabs each mode shows. These invariants keep the tables honest as rows move between modes.

/** Every `app/**​/page.tsx` as a route path: `app/practice/day/page.tsx` is `/practice/day`. */
function appPages(): string[] {
  const app = new URL("../app/", import.meta.url);
  return (readdirSync(app, { recursive: true }) as string[])
    .filter((file) => file === "page.tsx" || file.endsWith("/page.tsx"))
    .map((file) => `/${file.replace(/\/?page\.tsx$/, "")}`);
}

test("three modes, Technical first, each with a full-word label", () => {
  assert.deepEqual(LANES, ["technical", "fundamental", "backtest"]);
  assert.deepEqual(LANES.map((lane) => LANE_LABEL[lane]), ["Technical", "Fundamental", "Backtest"]);
});

test("completeness: every app page has its own row in the route table, so a new page cannot fall back silently", () => {
  const pages = appPages();
  assert.ok(pages.length >= 30, `the walk found the pages (${pages.length})`);
  for (const path of pages) assert.equal(isRegisteredPath(path), true, `${path} has no row in ROUTE_LANES`);
  assert.equal(isRegisteredPath("/unknown-page"), false);
});

test("each route lists its modes; the first one is where a link from another mode lands", () => {
  const cases: Array<[string, string[]]> = [
    ["/", ["technical", "fundamental", "backtest"]],
    ["/today", ["technical", "fundamental", "backtest"]],
    ["/screener/filters", ["technical"]],
    ["/watchlists", ["technical", "fundamental"]],
    ["/alerts/new", ["technical"]],
    ["/strategies/new", ["technical"]],
    ["/technicals", ["technical"]],
    ["/futures", ["technical"]],
    ["/futures/specs", ["technical", "fundamental"]],
    ["/futures/read", ["fundamental"]],
    ["/holdings", ["fundamental"]],
    ["/covered-calls", ["fundamental"]],
    ["/stocks", ["fundamental"]],
    ["/ask", ["fundamental", "technical"]],
    ["/practice", ["backtest"]],
    ["/practice/replay", ["backtest"]],
    ["/practice/journal", ["backtest"]],
    ["/practice/week", ["backtest"]],
    ["/backtests", ["backtest"]],
    ["/paper", ["backtest"]],
    ["/settings", ["technical", "fundamental", "backtest"]],
    ["/more", ["technical", "fundamental", "backtest"]],
    ["/feedback", ["technical", "fundamental", "backtest"]],
    ["/feedback/new", ["technical", "fundamental", "backtest"]],
    ["/holdings/", ["fundamental"]],
    ["/futures/read/", ["fundamental"]],
  ];
  for (const [path, modes] of cases) assert.deepEqual(lanesForPath(path), modes, path);
  // A 404 never switches the mode.
  assert.deepEqual(lanesForPath("/unknown-page"), LANES);
});

test("modeFor: an owned route ignores the stored mode; a shared route keeps it when listed, else takes the first listed", () => {
  assert.equal(modeFor("/holdings", null, "technical"), "fundamental");
  assert.equal(modeFor("/practice/replay", null, "fundamental"), "backtest");
  assert.equal(modeFor("/screener", null, "backtest"), "technical");
  assert.equal(modeFor("/watchlists", null, "fundamental"), "fundamental");
  assert.equal(modeFor("/watchlists", null, "backtest"), "technical");
  assert.equal(modeFor("/ask", null, "backtest"), "fundamental");
  assert.equal(modeFor("/settings", null, "backtest"), "backtest");
  assert.equal(modeFor("/", null, "fundamental"), "fundamental");
  // ?mode= wins only when the route lists it; junk is ignored.
  assert.equal(modeFor("/", "fundamental", "technical"), "fundamental");
  assert.equal(modeFor("/", "backtest", "technical"), "backtest");
  assert.equal(modeFor("/holdings", "technical", "technical"), "fundamental");
  assert.equal(modeFor("/", "nonsense", "fundamental"), "fundamental");
});

test("no tab, home or account link leads out of its mode", () => {
  for (const lane of LANES) {
    assert.ok(PRIMARY_NAV[lane].length > 0, lane);
    for (const item of PRIMARY_NAV[lane]) assert.ok(lanesForPath(item.href).includes(lane), `${lane} tab ${item.label} → ${item.href}`);
    const home = new URL(LANE_HOME[lane], "http://desk");
    assert.ok(lanesForPath(home.pathname).includes(lane), `${lane} home ${LANE_HOME[lane]}`);
    assert.equal(modeFor(home.pathname, home.searchParams.get("mode"), lane === "technical" ? "fundamental" : "technical"), lane, `${lane} home opens in ${lane}`);
    for (const item of AVATAR_MENU) assert.ok(lanesForPath(item.href).includes(lane), `${lane} avatar ${item.href}`);
  }
});

test("the primary nav per mode: Practice leaves Technical for Backtest; Fundamental keeps its five", () => {
  assert.deepEqual(PRIMARY_NAV.technical.map((item) => item.label), ["Today", "Screener", "Watchlists", "Alerts", "Strategies"]);
  assert.deepEqual(PRIMARY_NAV.fundamental.map((item) => item.label), ["Today", "Holdings", "Covered calls", "Stocks", "Futures"]);
  assert.deepEqual(PRIMARY_NAV.fundamental.map((item) => item.href), ["/", "/holdings", "/covered-calls", "/stocks", "/futures/read"]);
  assert.deepEqual(PRIMARY_NAV.backtest.map((item) => [item.label, item.href]), [["Practice", "/practice"], ["Journal", "/practice/journal"]]);
  assert.deepEqual(AVATAR_MENU.map((item) => item.label), ["Settings", "More", "Feedback"]);
  assert.equal(PRIMARY_NAV.technical.find((item) => item.label === "Strategies")?.href, "/strategies/library");
});

test("only the longest matching tab is active: Journal alone on the journal, Practice on the week review", () => {
  const active = (lane: "technical" | "fundamental" | "backtest", path: string) => activeNavItem(PRIMARY_NAV[lane], path)?.label;
  assert.equal(active("backtest", "/practice/journal"), "Journal");
  assert.equal(active("backtest", "/practice/replay"), "Practice");
  assert.equal(active("backtest", "/practice/week"), "Practice");
  assert.equal(active("backtest", "/practice"), "Practice");
  assert.equal(active("technical", "/strategies/new"), "Strategies");
  assert.equal(active("technical", "/today"), "Today");
  assert.equal(active("technical", "/screener/filters"), "Screener");
  assert.equal(active("technical", "/settings"), undefined);
  assert.equal(active("fundamental", "/futures/read"), "Futures");
  assert.equal(isNavActive("/", "/today"), true);
  assert.equal(isNavActive("/", "/screener"), false);
  assert.equal(isNavActive("/alerts", "/alerts/new"), true);
  assert.equal(isNavActive("/strategies/library", "/alerts", "/strategies"), false);
});

test("shell sections per mode: Backtest has no search, market pill, freshness, bell or live status line", () => {
  for (const section of ["search", "marketPill", "freshness", "alertsBell", "statusQuotes", "statusAlerts"] as const) {
    assert.equal(shows("technical", section), true, section);
    assert.equal(shows("fundamental", section), true, section);
    assert.equal(shows("backtest", section), false, section);
  }
  for (const section of ["mask", "fundamentalSettings"] as const) {
    assert.deepEqual(LANES.filter((lane) => shows(lane, section)), ["fundamental"], section);
  }
});

test("left-rail tabs per mode", () => {
  assert.deepEqual(LEFT_RAIL_TABS, { technical: ["watchlists", "filters"], fundamental: ["holdings", "watchlists"], backtest: ["watchlists"] });
});

test("a symbol opens in the mode's own symbol page; Backtest has no live symbol link", () => {
  assert.equal(SYMBOL_HREF.technical?.("BRK.B"), "/technicals?symbol=BRK.B#chart");
  assert.equal(SYMBOL_HREF.fundamental?.("AAPL"), "/stocks?symbol=AAPL#overview");
  assert.equal(SYMBOL_HREF.backtest, null);
  for (const lane of LANES) {
    const href = SYMBOL_HREF[lane]?.("X");
    if (href) assert.ok(lanesForPath(new URL(href, "http://desk").pathname).includes(lane), `${lane} symbol link stays in ${lane}`);
  }
});

test("the stored mode keeps the desk.lane key, accepts backtest, and survives a missing or throwing storage", () => {
  const store = new Map<string, string>();
  const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value) };
  assert.equal(LANE_STORAGE_KEY, "desk.lane");
  assert.equal(readLanePreference(storage), "technical");
  for (const lane of LANES) {
    writeLanePreference(storage, lane);
    assert.equal(store.get(LANE_STORAGE_KEY), lane);
    assert.equal(readLanePreference(storage), lane);
  }
  store.set(LANE_STORAGE_KEY, "nonsense");
  assert.equal(readLanePreference(storage), "technical");
  assert.equal(readLanePreference(null), "technical");
  const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
  assert.equal(readLanePreference(broken), "technical");
  assert.doesNotThrow(() => writeLanePreference(broken, "technical"));
});

test("Practice routes: band and the replay-only left rail", () => {
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

test("every Practice route owns the left slot, so the global watchlists never show there; no other route does", () => {
  for (const path of ["/practice", "/practice/", "/practice/thread", "/practice/week", "/practice/replay", "/practice/day", "/practice/journal", "/practice/day/"]) {
    assert.equal(hasPracticeLeftRail(path), true, path);
  }
  for (const path of ["/", "/watchlists", "/screener", "/practices", "/paper", "/backtests", "/settings"]) assert.equal(hasPracticeLeftRail(path), false, path);
});

test("the futures specs page is shared, so its way back is the active mode's own futures screen, never the other mode's", () => {
  for (const lane of ["technical", "fundamental"] as const) {
    assert.deepEqual(lanesForPath(FUTURES_HOME[lane].href), [lane], `${lane} -> ${FUTURES_HOME[lane].href}`);
  }
  assert.deepEqual(FUTURES_HOME.technical, { href: "/futures", label: "Back to futures swing" });
  assert.deepEqual(FUTURES_HOME.fundamental, { href: "/futures/read", label: "Back to futures" });
});
