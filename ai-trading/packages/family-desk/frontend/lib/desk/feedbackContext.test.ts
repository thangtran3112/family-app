import assert from "node:assert/strict";
import test from "node:test";
import {
  APP_VERSION,
  capture,
  captureRoute,
  cleanRoute,
  contextOf,
  threadOf,
  FALLBACK_ROUTE,
  reportUrl,
  routeFromReferrer,
  SCREEN_OPTIONS,
  screenFor,
  symbolOf,
} from "./feedbackContext.ts";

test("a route names its screen the way the board's Which screen? select does", () => {
  assert.equal(screenFor("/practice/screen?thread=5"), "Practice · Screen");
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
  assert.ok(SCREEN_OPTIONS.includes("Practice · Screen"));
  assert.equal(SCREEN_OPTIONS.includes("Practice · Week"), false);
  assert.equal(new Set(SCREEN_OPTIONS).size, SCREEN_OPTIONS.length);
});

test("only a path on this site, without a fragment, is accepted as the screen she came from", () => {
  assert.equal(cleanRoute("/practice/screen?thread=5"), "/practice/screen?thread=5");
  assert.equal(cleanRoute("/technicals?symbol=NVDA#chart"), "/technicals?symbol=NVDA");
  assert.equal(cleanRoute(null), null);
  assert.equal(cleanRoute(""), null);
  for (const bad of ["https://evil.example/x", "//evil.example/x", "practice", "/a\\b", "/a\nb", `/${"x".repeat(300)}`, "/feedback/new", "/feedback/new?from=/alerts"]) {
    assert.equal(cleanRoute(bad), null, bad);
  }
});

test("the route comes from the link, else from the page she was on, else the Feedback area", () => {
  assert.equal(captureRoute("/alerts", "https://trading.test/practice", "https://trading.test"), "/alerts");
  assert.equal(captureRoute(null, "https://trading.test/practice/screen?thread=5", "https://trading.test"), "/practice/screen?thread=5");
  assert.equal(captureRoute(null, "https://other.example/practice", "https://trading.test"), FALLBACK_ROUTE);
  assert.equal(captureRoute(null, "", "https://trading.test"), FALLBACK_ROUTE);
  assert.equal(captureRoute("https://evil.example", "", "https://trading.test"), FALLBACK_ROUTE);
  assert.equal(routeFromReferrer("not a url", "https://trading.test"), null);
  assert.equal(routeFromReferrer("https://trading.test/feedback/new", "https://trading.test"), null); // never the form itself
});

test("the symbol and the practice thread are read out of the route, and only when they are really there", () => {
  assert.equal(symbolOf("/technicals?symbol=nvda"), "NVDA");
  assert.equal(symbolOf("/technicals?symbol=BRK.B"), "BRK.B");
  assert.equal(symbolOf("/technicals?symbol=<script>"), null);
  assert.equal(symbolOf("/technicals"), null);
  assert.equal(threadOf("/practice/screen?thread=5"), 5);
  assert.equal(threadOf("/practice/journal?thread=7"), 7);
  assert.equal(threadOf("/practice/thread?id=9"), 9);
  assert.equal(threadOf("/practice/screen?thread=abc"), null);
  assert.equal(threadOf("/practice/screen"), null);
  assert.equal(threadOf("/practice/journal?id=5"), null);
  assert.equal(threadOf("/alerts?thread=5"), null);
});

test("capture bundles what the Desk knows, and the report's context holds only what the route carried", () => {
  const now = new Date("2026-10-26T14:12:00Z");
  const day = capture({ route: "/practice/screen?thread=5", now, appVersion: "desk-2026.10.26" });
  assert.deepEqual(day, {
    screen: "Practice · Screen",
    route: "/practice/screen?thread=5",
    symbol: null,
    threadId: 5,
    appVersion: "desk-2026.10.26",
    capturedAt: "2026-10-26T14:12:00.000Z",
  });
  assert.deepEqual(contextOf(day), { thread_id: 5 });
  const chart = capture({ route: "/technicals?symbol=NVDA", now });
  assert.deepEqual(contextOf(chart), { symbol: "NVDA" });
  assert.deepEqual(contextOf(capture({ route: "/alerts", now })), {});
  assert.equal(chart.appVersion, APP_VERSION);
});

test("the Report a problem link carries the route, encoded", () => {
  assert.equal(reportUrl("/practice/screen?thread=5"), "/feedback/new?from=%2Fpractice%2Fscreen%3Fthread%3D5");
  assert.equal(reportUrl("/feedback/new"), "/feedback/new?from=%2Ffeedback");
  assert.equal(reportUrl("https://evil.example"), "/feedback/new?from=%2Ffeedback");
});
