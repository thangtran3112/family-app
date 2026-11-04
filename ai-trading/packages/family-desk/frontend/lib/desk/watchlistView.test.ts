import assert from "node:assert/strict";
import test from "node:test";
import { DeskApiError } from "../api/client.ts";
import { WatchlistTableSchema } from "../api/schemas.ts";
import { loadDeskFixture } from "../fixtures/desk-mvp/load.ts";
import { backfillBanner, isBackfilling, manageErrorMessage, moveSymbol, normalizeListName, orderChange, strategyChips, tagLine, validateListName } from "./watchlistView.ts";
import { droppedKeys, withPriorities } from "./columns.ts";

const table = WatchlistTableSchema.parse(loadDeskFixture("watchlist_1_table"));

test("tag lines show pattern times and armed strategies", () => {
  const tagged = table.rows.find((row) => row.tags.length > 0)!;
  const lines = tagLine(tagged.tags);
  assert.equal(lines.length, tagged.tags.length);
  assert.ok(lines.every((line) => !/null|undefined/.test(line)));
  assert.deepEqual(tagLine([{ kind: "pattern", label: "Hammer 15m", at: "2026-10-23T14:15:00Z" }, { kind: "armed", label: "ORB armed", at: null }]), ["Hammer 15m · 10:15 AM", "ORB armed"]);
  assert.deepEqual(tagLine([]), []);
});

test("a row with many strategies shows two chips and counts the rest, so the Actions column stays in view (V-Watchlists-01)", () => {
  const tags = [
    { kind: "armed" as const, label: "ORB 15m armed", at: null },
    { kind: "armed" as const, label: "VWAP reclaim armed", at: null },
    { kind: "pattern" as const, label: "Hammer 15m", at: "2026-10-23T14:15:00Z" },
    { kind: "armed" as const, label: "High-of-day break armed", at: null },
  ];
  const { shown, hidden } = strategyChips(tags);
  assert.deepEqual(shown, [{ text: "ORB 15m armed", tone: "warn" }, { text: "VWAP reclaim armed", tone: "warn" }]);
  assert.deepEqual(hidden, [{ text: "Hammer 15m · 10:15 AM", tone: "neutral" }, { text: "High-of-day break armed", tone: "warn" }]);
  assert.deepEqual(strategyChips(tags.slice(0, 2)).hidden, []);
  assert.deepEqual(strategyChips([]), { shown: [], hidden: [] });
});

test("list names: empty, long, duplicate (ignoring case) and renaming to itself", () => {
  assert.equal(validateListName("  ", []), "Give the list a name");
  assert.equal(validateListName("x".repeat(81), []), "Use 80 characters or fewer");
  assert.equal(validateListName("swing", ["Day movers", "Swing"]), "You already have a list called “swing”");
  assert.equal(validateListName("Swing", ["Day movers", "Swing"], "Swing"), null);
  assert.equal(validateListName("Core", ["Day movers", "Swing"]), null);
  assert.equal(normalizeListName("  ｆｕｌｌ  "), "full");
});

test("moving a symbol up or down keeps a permutation and stops at the ends", () => {
  assert.deepEqual(moveSymbol(["A", "B", "C"], 1, -1), ["B", "A", "C"]);
  assert.deepEqual(moveSymbol(["A", "B", "C"], 1, 1), ["A", "C", "B"]);
  assert.deepEqual(moveSymbol(["A", "B", "C"], 0, -1), ["A", "B", "C"]);
  assert.deepEqual(moveSymbol(["A", "B", "C"], 2, 1), ["A", "B", "C"]);
  assert.deepEqual(moveSymbol(["A", "B", "C"], 5, 1), ["A", "B", "C"]);
});

test("Save only has something to send after the order changed", () => {
  assert.equal(orderChange(["A", "B"], ["A", "B"]), null);
  assert.deepEqual(orderChange(["A", "B"], ["B", "A"]), ["B", "A"]);
});

test("manage errors use plain words, the API detail first", () => {
  assert.equal(manageErrorMessage(new DeskApiError("http", 409, { detail: "Already used by ORB 15m" }), "delete"), "Already used by ORB 15m");
  assert.equal(manageErrorMessage(new DeskApiError("http", 409), "rename"), "You already have a list with that name");
  assert.match(manageErrorMessage(new DeskApiError("http", 409), "delete"), /alert strategy still uses this list/);
  assert.match(manageErrorMessage(new DeskApiError("http", 422), "reorder"), /changed/);
  assert.equal(manageErrorMessage(new Error("boom"), "add"), "Couldn't save that change · Try again");
  assert.doesNotMatch(manageErrorMessage(new DeskApiError("http", 503), "add"), /503/);
  assert.equal(manageErrorMessage(new DeskApiError("http", 404, { detail: "Not Found" }), "add"), "Couldn't save that change · Try again");
});

test("a narrow pane drops RVOL then bias label on the watchlist table", () => {
  const columns = withPriorities(["symbol", "last", "change_pct", "rvol_10d", "bias_label", "tags"].map((key) => ({ key })), "watchlist");
  assert.deepEqual(droppedKeys(columns), ["rvol_10d", "bias_label"]);
});

// D-246: a futures symbol never reads `ready` from an older API (no daily-bar source), so it must not hold the banner.
const item = (symbol: string, asset_type: "stock" | "future", backfill: "ready" | "pending") => ({ symbol, asset_type, backfill });

test("a futures item is never backfilling: it has no history source to wait for, whatever the API says", () => {
  assert.equal(isBackfilling(item("/ES", "future", "pending")), false);
  assert.equal(isBackfilling(item("/ES", "future", "ready")), false);
  assert.equal(isBackfilling(item("AAPL", "stock", "pending")), true);
  assert.equal(isBackfilling(item("AAPL", "stock", "ready")), false);
});

test("the banner counts only the symbols that can still fill: one future plus two stocks reads 2, and it clears with the stocks", () => {
  const filling = [item("/ES", "future", "pending"), item("CHWY", "stock", "pending"), item("ETSY", "stock", "pending")];
  assert.equal(backfillBanner(filling), "Backfilling history for 2 symbols");
  assert.equal(backfillBanner([item("/ES", "future", "pending"), item("CHWY", "stock", "ready"), item("ETSY", "stock", "pending")]), "Backfilling history for 1 symbol");
  assert.equal(backfillBanner([item("/ES", "future", "pending"), item("CHWY", "stock", "ready"), item("ETSY", "stock", "ready")]), null);
  assert.equal(backfillBanner([item("/ES", "future", "pending")]), null);
  assert.equal(backfillBanner([]), null);
});
