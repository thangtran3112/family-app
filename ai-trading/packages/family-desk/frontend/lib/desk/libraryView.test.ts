import assert from "node:assert/strict";
import test from "node:test";
import { LibraryEntrySchema, LibraryListSchema } from "../api/schemas.ts";
import { loadDeskFixture } from "../fixtures/desk-mvp/load.ts";
import { alertOnlySpec, attachLabel, attachOutcome, categoryRows, defaultsLines, exampleCaption, filterPresets, plainEnglish, whenText } from "./libraryView.ts";

const items = LibraryListSchema.parse(loadDeskFixture("library"));
const hammer = LibraryEntrySchema.parse(loadDeskFixture("library_hammer"));

test("categories: All first, then Candlesticks, Breakouts, Trend, Volume, Futures that have presets", () => {
  const rows = categoryRows(items);
  assert.equal(rows[0]!.label, "All presets");
  assert.equal(rows[0]!.count, items.length);
  assert.deepEqual(rows.slice(1).map((r) => r.id), ["candlestick", "breakout", "trend", "volume", "futures"]);
  assert.equal(rows.slice(1).reduce((sum, r) => sum + r.count, 0), items.length);
});

test("search and category narrow the list; an empty search says so by returning nothing", () => {
  assert.equal(filterPresets(items, "all", "").length, items.length);
  const hammers = filterPresets(items, "candlestick", "hammer");
  assert.ok(hammers.length > 0 && hammers.every((i) => i.category === "candlestick"));
  assert.equal(filterPresets(items, "all", "zzzz-nothing").length, 0);
  assert.equal(filterPresets(items, "futures", "").every((i) => i.category === "futures"), true);
});

test("futures presets are listed but not attachable, with the reason", () => {
  const futures = items.filter((i) => i.category === "futures");
  assert.ok(futures.length > 0);
  for (const item of futures) {
    assert.equal(item.attachable, false);
    assert.match(item.attach_blocked_reason ?? "", /IBKR/);
  }
});

test("preview text is alert-only and plain: hammer reads as a sentence, no paper order", () => {
  assert.match(plainEnglish(hammer.spec) ?? "", /^At each 15-minute close during regular hours, alert when a hammer pattern appears after a downtrend over 5 bars; notify inbox\.$/);
  assert.match(whenText(hammer.spec) ?? "", /hammer pattern/);
  const withPaper = { ...hammer.spec, then: { ...(hammer.spec.then as object), paperOrder: { side: "buy", size: { shares: 1 }, stop: { atrMultiple: 2 }, target: { r: 2 } } } };
  assert.equal(alertOnlySpec(withPaper)?.then.paperOrder, undefined);
  assert.doesNotMatch(plainEnglish(withPaper) ?? "", /paper/);
  assert.equal(plainEnglish({ nope: 1 }), null);
});

test("defaults, example caption and attach copy", () => {
  assert.deepEqual(defaultsLines(hammer.defaults), ["Severity: opportunity", "Channels: Inbox"]);
  assert.deepEqual(defaultsLines({ limits: { cooldownMinutes: 30 } }), ["Cooldown: 30 min"]);
  assert.equal(exampleCaption("Hammer", hammer.example), "Hammer on MSFT · 15m · 2026-10-23 14:45 ET");
  assert.equal(exampleCaption("Hammer", null), null);
  assert.equal(attachLabel("Day movers"), "Attach to Day movers · alert only");
  assert.equal(attachLabel(null), "Choose a watchlist to attach");
  assert.match(attachOutcome("draft", "Day movers"), /draft · alerts start when live quotes are connected$/);
  assert.equal(attachOutcome("alert_only", "Day movers"), "Attached to Day movers · alert only");
});
