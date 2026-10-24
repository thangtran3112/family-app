import assert from "node:assert/strict";
import test from "node:test";
import { DashboardSchema } from "../api/schemas.ts";
import { loadDeskFixture } from "../fixtures/desk-mvp/load.ts";
import { eventRows, matchCards, stripTiles } from "./dashboardView.ts";

const dashboard = DashboardSchema.parse(loadDeskFixture("dashboard"));

test("market strip: SPY QQQ IWM real, /ES and /NQ unavailable and read-only", () => {
  const tiles = stripTiles(dashboard.market_strip);
  assert.deepEqual(tiles.map((t) => t.symbol), ["SPY", "QQQ", "IWM", "/ES", "/NQ"]);
  const spy = tiles[0]!;
  assert.equal(spy.unavailable, false);
  assert.match(spy.change, /^[+−]\d+\.\d{2}%$/);
  assert.equal(spy.readOnly, false);
  for (const tile of tiles.slice(3)) {
    assert.deepEqual([tile.unavailable, tile.readOnly, tile.last, tile.change], [true, true, "—", "—"]);
    assert.equal(tile.note, "Waiting for IBKR · not connected yet");
  }
});

test("a live futures tile is read-only with its own note", () => {
  const [tile] = stripTiles([{ symbol: "/ES", last: 5000, change_pct: 0.4, stamp: { as_of: null, source: "ibkr", quality: "realtime", freshness: "live" } }]);
  assert.deepEqual([tile!.readOnly, tile!.unavailable, tile!.note], [true, false, "Futures · read only"]);
});

test("screener cards show the count, cadence and at most three symbols", () => {
  const cards = matchCards(dashboard.screener_matches);
  assert.ok(cards.length > 0);
  for (const card of cards) {
    assert.match(card.count, /^\d+ of \d+$/);
    assert.ok(card.top.length <= 3);
  }
  assert.equal(matchCards([{ ...dashboard.screener_matches[0]!, matches_total: 0, top: [] }])[0]!.empty, true);
});

test("events sort by date then symbol with plain timing", () => {
  const rows = eventRows(dashboard.events);
  assert.deepEqual(rows.map((r) => r.symbol), ["GOOGL", "MSFT", "AAPL", "AMZN", "META"]);
  assert.equal(rows[0]!.day, "Wed 2026-10-28");
  assert.equal(rows[0]!.timing, "Earnings · After close");
});
