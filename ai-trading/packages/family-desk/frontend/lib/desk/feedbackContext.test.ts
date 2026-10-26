import assert from "node:assert/strict";
import test from "node:test";
import {
  APP_VERSION,
  capture,
  captureRoute,
  cleanRoute,
  contextOf,
  dayListOf,
  FALLBACK_ROUTE,
  reportUrl,
  routeFromReferrer,
  SCREEN_OPTIONS,
  screenFor,
  symbolOf,
} from "./feedbackContext.ts";

test("a route names its screen the way the board's Which screen? select does", () => {
  assert.equal(screenFor("/practice/day?id=5"), "Practice · Day list");
  assert.equal(screenFor("/practice/replay"), "Practice · Replay");
  assert.equal(screenFor("/practice"), "Practice");
  assert.equal(screenFor("/alerts/new"), "Alerts · New alert strategy");
  assert.equal(screenFor("/alerts"), "Alerts");
  assert.equal(screenFor("/technicals?symbol=NVDA#chart"), "Technicals");
  assert.equal(screenFor("/"), "Today");
  assert.equal(screenFor("/today"), "Today");
  assert.equal(screenFor("/settings/"), "Settings");
  assert.equal(screenFor("/feedback?id=14"), "Feedback");
  assert.equal(screenFor("/somewhere-new"), "Today"); // an unknown route falls back; the select lets her correct it
  assert.ok(SCREEN_OPTIONS.includes("Practice · Day list"));
  assert.equal(new Set(SCREEN_OPTIONS).size, SCREEN_OPTIONS.length);
});

test("only a path on this site, without a fragment, is accepted as the screen she came from", () => {
  assert.equal(cleanRoute("/practice/day?id=5"), "/practice/day?id=5");
  assert.equal(cleanRoute("/technicals?symbol=NVDA#chart"), "/technicals?symbol=NVDA");
  assert.equal(cleanRoute(null), null);
  assert.equal(cleanRoute(""), null);
  for (const bad of ["https://evil.example/x", "//evil.example/x", "practice", "/a\\b", "/a\nb", `/${"x".repeat(300)}`, "/feedback/new", "/feedback/new?from=/alerts"]) {
    assert.equal(cleanRoute(bad), null, bad);
  }
});

test("the route comes from the link, else from the page she was on, else the Feedback area", () => {
  assert.equal(captureRoute("/alerts", "https://trading.test/practice", "https://trading.test"), "/alerts");
  assert.equal(captureRoute(null, "https://trading.test/practice/day?id=5", "https://trading.test"), "/practice/day?id=5");
  assert.equal(captureRoute(null, "https://other.example/practice", "https://trading.test"), FALLBACK_ROUTE);
  assert.equal(captureRoute(null, "", "https://trading.test"), FALLBACK_ROUTE);
  assert.equal(captureRoute("https://evil.example", "", "https://trading.test"), FALLBACK_ROUTE);
  assert.equal(routeFromReferrer("not a url", "https://trading.test"), null);
  assert.equal(routeFromReferrer("https://trading.test/feedback/new", "https://trading.test"), null); // never the form itself
});

test("the symbol and the practice day are read out of the route, and only when they are really there", () => {
  assert.equal(symbolOf("/technicals?symbol=nvda"), "NVDA");
  assert.equal(symbolOf("/technicals?symbol=BRK.B"), "BRK.B");
  assert.equal(symbolOf("/technicals?symbol=<script>"), null);
  assert.equal(symbolOf("/technicals"), null);
  assert.equal(dayListOf("/practice/day?id=5"), 5);
  assert.equal(dayListOf("/practice/day?id=abc"), null);
  assert.equal(dayListOf("/practice/day"), null);
  assert.equal(dayListOf("/practice/journal?id=5"), null);
});

test("capture bundles what the Desk knows, and the report's context holds only what the route carried", () => {
  const now = new Date("2026-10-26T14:12:00Z");
  const day = capture({ route: "/practice/day?id=5", now, appVersion: "desk-2026.10.26" });
  assert.deepEqual(day, {
    screen: "Practice · Day list",
    route: "/practice/day?id=5",
    symbol: null,
    dayListId: 5,
    appVersion: "desk-2026.10.26",
    capturedAt: "2026-10-26T14:12:00.000Z",
  });
  assert.deepEqual(contextOf(day), { day_list_id: 5 });
  const chart = capture({ route: "/technicals?symbol=NVDA", now });
  assert.deepEqual(contextOf(chart), { symbol: "NVDA" });
  assert.deepEqual(contextOf(capture({ route: "/alerts", now })), {});
  assert.equal(chart.appVersion, APP_VERSION);
});

test("the Report a problem link carries the route, encoded", () => {
  assert.equal(reportUrl("/practice/day?id=5"), "/feedback/new?from=%2Fpractice%2Fday%3Fid%3D5");
  assert.equal(reportUrl("/feedback/new"), "/feedback/new?from=%2Ffeedback");
  assert.equal(reportUrl("https://evil.example"), "/feedback/new?from=%2Ffeedback");
});
