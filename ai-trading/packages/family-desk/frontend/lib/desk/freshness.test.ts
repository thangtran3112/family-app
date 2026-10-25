import assert from "node:assert/strict";
import test from "node:test";
import {
  alertsBanner,
  asOfLine,
  BANNED_TERMS,
  containsBannedTerm,
  COPY,
  emptyScanText,
  loadErrorText,
  marketDataLine,
  marketPillShort,
  marketPillText,
  notEnoughHistoryText,
  resolveFreshness,
  statusBarText,
  wrongLaneText,
  type FreshnessInput,
  type FreshnessState,
} from "./freshness.ts";

const now = new Date("2026-10-23T20:10:00Z");
const stamp = (freshness: "live" | "delayed" | "closed" | "paused" | "unavailable", quality: "realtime" | "delayed-15m" | "eod" | "fallback" | "unavailable" = "delayed-15m", as_of: string | null = "2026-10-23T20:00:00Z") =>
  ({ freshness, quality, as_of, source: "alpaca" });

// One row per 02l §c3 state: the input that produces it and the exact wording.
const rows: Array<[FreshnessState, FreshnessInput, string]> = [
  ["live", { stamp: stamp("live", "realtime"), session: "regular", now }, "Live"],
  ["delayed", { stamp: stamp("delayed"), session: "regular", now }, "Delayed 15 min"],
  ["updating", { stamp: stamp("delayed"), session: "regular", connection: "updating", now }, "Updating quotes…"],
  ["reconnecting", { stamp: stamp("delayed", "delayed-15m", "2026-10-23T14:41:12Z"), session: "regular", connection: "reconnecting", now }, "Reconnecting… · last update 10:41:12 AM ET"],
  ["paused", { stamp: stamp("paused", "delayed-15m", "2026-10-23T20:08:00Z"), session: "regular", now }, "Quotes paused · last update 2 min ago"],
  ["backup", { stamp: stamp("delayed", "fallback"), session: "regular", now }, "Using backup quotes · may differ slightly from IBKR"],
  ["closed", { stamp: stamp("closed"), session: "closed", now }, "Market closed · showing last close"],
  ["pre_market", { stamp: stamp("delayed", "delayed-15m", "2026-10-23T12:12:00Z"), session: "pre", now }, "Pre-market · 8:12 AM ET"],
  ["after_hours", { stamp: stamp("delayed"), session: "after", now }, "After hours"],
  ["unavailable", { stamp: stamp("unavailable", "unavailable", null), session: "regular", now }, "Quotes unavailable right now · trying again"],
];

test("every 02l §c3 freshness state resolves to its exact wording", () => {
  for (const [state, input, label] of rows) {
    const view = resolveFreshness(input);
    assert.equal(view.state, state);
    assert.equal(view.label, label);
  }
  assert.deepEqual(rows.map(([state]) => state).sort(), Object.keys(COPY).filter((key) => ["live", "delayed", "updating", "reconnecting", "paused", "backup", "closed", "pre_market", "after_hours", "unavailable"].includes(key)).sort());
});

test("the as-of line is dated and names its source", () => {
  assert.equal(asOfLine({ freshness: "closed", quality: "eod", as_of: "2026-10-15T20:00:00Z", source: "alpaca" }), "As of last close · Thu 2026-10-15 · 4:00 PM ET · Alpaca");
  assert.equal(asOfLine({ freshness: "delayed", quality: "delayed-15m", as_of: "2026-10-15T19:45:00Z", source: "alpaca" }), "As of 3:45 PM ET · Delayed 15 min · Alpaca");
  assert.equal(asOfLine({ freshness: "delayed", quality: "eod", as_of: "2026-10-15", source: null }), "As of Thu 2026-10-15 · End of day");
  assert.equal(asOfLine({ freshness: "unavailable", quality: "unavailable", as_of: null, source: null }), "No update yet");
  assert.equal(asOfLine(null), "No update yet");
});

test("a closed market with no quotes yet reads as closed, never as a red retry", () => {
  const none = { ...stamp("unavailable", "unavailable", null), source: null };
  const view = resolveFreshness({ stamp: none, session: "closed", feed: true, now });
  assert.deepEqual([view.state, view.label, view.tone, view.dim], ["closed", "Market closed · showing last close", "muted", false]);
  assert.equal(statusBarText({ stamp: none, session: "closed", feed: true, now }), "Market closed · showing last close");
  assert.equal(resolveFreshness({ stamp: none, session: "pre", feed: true, now }).state, "unavailable"); // an open session retries
  assert.equal(resolveFreshness({ stamp: none, session: "closed", now }).state, "unavailable"); // one symbol the Desk cannot read
});

test("precedence: a dropped connection beats everything, a missing stamp reads as updating", () => {
  assert.equal(resolveFreshness({ stamp: stamp("unavailable", "unavailable", null), connection: "reconnecting" }).state, "reconnecting");
  assert.equal(resolveFreshness({ stamp: null }).state, "updating");
  assert.equal(resolveFreshness({ stamp: stamp("paused"), connection: "updating" }).state, "paused");
  assert.equal(resolveFreshness({ stamp: stamp("delayed", "fallback"), session: "after" }).state, "backup");
});

test("only live shows a dot and only dropped or unavailable quotes dim", () => {
  assert.equal(resolveFreshness(rows[0][1]).dot, true);
  assert.equal(resolveFreshness(rows[1][1]).dot, false);
  assert.equal(resolveFreshness(rows[3][1]).dim, true);
  assert.equal(resolveFreshness(rows[9][1]).dim, true);
  assert.equal(resolveFreshness(rows[6][1]).dim, false);
  assert.equal(resolveFreshness(rows[0][1]).tone, "up");
  assert.equal(resolveFreshness(rows[9][1]).tone, "down");
});

test("status bar, market data rows and the market pill use plain wording", () => {
  assert.equal(statusBarText(rows[0][1]), "Quotes live · Alpaca");
  assert.equal(statusBarText({ stamp: { ...stamp("live", "realtime"), source: "ibkr" }, session: "regular" }), "Quotes live · IBKR");
  assert.equal(statusBarText(rows[1][1]), "Quotes: Alpaca · Delayed 15 min");
  assert.equal(statusBarText(rows[6][1]), "Quotes: Alpaca · Market closed");
  assert.equal(statusBarText(rows[4][1]), "Quotes paused · last update 2 min ago");
  assert.equal(marketDataLine("Quotes", { source: "alpaca", quality: "delayed-15m" }), "Quotes: Alpaca · Delayed 15 min");
  assert.equal(marketDataLine("Scans", { source: "ibkr", quality: "realtime" }), "Scans: IBKR · Live");
  assert.equal(marketDataLine("Quotes", null), "Quotes: Unavailable");
  assert.equal(marketDataLine("Quotes", { source: null, quality: "unavailable" }), "Quotes: Not updated yet");
  assert.equal(marketDataLine("Scans", { source: null, quality: "unavailable" }), "Scans: Not run yet");
  assert.equal(marketDataLine("Quotes", { source: "alpaca", quality: "eod" }), "Quotes: Alpaca · End of day");
  assert.equal(marketPillText("regular", null), "Market open");
  assert.equal(marketPillText("pre", null), "Pre-market");
  assert.equal(marketPillText("after", null), "After hours");
  assert.equal(marketPillText("closed", "2026-10-26T13:30:00Z"), "Market closed · opens Mon 9:30 AM ET");
  assert.equal(marketPillText("closed", null), "Market closed");
  assert.deepEqual((["regular", "pre", "after", "closed"] as const).map(marketPillShort), ["Open", "Pre-market", "After hours", "Closed"]);
});

test("alerts banner, empty scan, load error and wrong lane copy", () => {
  assert.equal(alertsBanner("running"), null);
  assert.equal(alertsBanner("paused_no_quotes"), "Alerts paused until quotes return");
  assert.match(alertsBanner("paused_by_user") ?? "", /paused/);
  assert.equal(alertsBanner("not_started"), "Alerts start when live quotes are connected");
  assert.equal(emptyScanText("2026-10-26T14:15:00Z"), "No matches right now · next scan 10:15 AM");
  assert.equal(emptyScanText(null), "No matches right now");
  assert.equal(loadErrorText("chart"), "Couldn't load this chart · Try again");
  assert.equal(wrongLaneText("Fundamental"), "This screen belongs to the Fundamental view");
  assert.equal(notEnoughHistoryText("1W"), "Not enough history for 1W yet");
  assert.equal(COPY.ordersOff, "Trading is off in the Desk · place orders in IBKR");
  assert.equal(COPY.noSignalsToday, "No signals yet today · your strategies are watching");
  assert.equal(COPY.advice, "Signals, not advice · you place every trade yourself in IBKR");
});

test("the copy table and every rendered label avoid the banned words", () => {
  for (const [key, text] of Object.entries(COPY)) {
    assert.equal(containsBannedTerm(text), false, `COPY.${key} contains a banned term: ${text}`);
  }
  for (const [, input] of rows) {
    assert.equal(containsBannedTerm(resolveFreshness(input).label), false);
    assert.equal(containsBannedTerm(statusBarText(input)), false);
  }
  assert.equal(BANNED_TERMS.length > 10, true);
  for (const bad of ["Core async update", "fetch failed", "stream closed", "socket", "polling", "timeout", "value is null", "NaN", "stale cache", "hydrate", "Error 503", "HTTP 404", "503 error", "404 Not Found", "undefined"]) {
    assert.equal(containsBannedTerm(bad), true, bad);
  }
  assert.equal(containsBannedTerm("Reconnecting… · last update 10:41:12 AM ET"), false);
  for (const fine of ["9 of 131", "NVDA 210.99 +0.50%", "Scanned 131 US stocks and ETFs", "Volume 12,883,312"]) assert.equal(containsBannedTerm(fine), false, fine);
});
