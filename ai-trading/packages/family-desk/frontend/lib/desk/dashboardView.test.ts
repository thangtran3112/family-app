import assert from "node:assert/strict";
import test from "node:test";
import { DashboardSchema, type Dashboard } from "../api/schemas.ts";
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
    assert.equal(tile.note, "Futures deferred · not connected yet");
  }
});

test("an empty ETF tile says when it fills; a closed one says its last close", () => {
  const empty = { as_of: null, source: null, quality: "unavailable", freshness: "unavailable" } as const;
  const [none, noTime] = [stripTiles([{ symbol: "SPY", last: null, change_pct: null, stamp: empty }], "2026-10-26T11:00:00Z")[0]!, stripTiles([{ symbol: "SPY", last: null, change_pct: null, stamp: empty }])[0]!];
  assert.deepEqual([none.last, none.change, none.note], ["—", "—", "First market update Mon 7:00 AM ET"]);
  assert.equal(noTime.note, "No market data yet");
  const closed = { as_of: "2026-10-23T20:00:00Z", source: "alpaca", quality: "eod", freshness: "closed" } as const;
  assert.equal(stripTiles([{ symbol: "SPY", last: 678.12, change_pct: 0.31, stamp: closed }])[0]!.note, "Last close · Fri 4:00 PM ET");
  assert.equal(stripTiles([{ symbol: "SPY", last: 678.12, change_pct: 0.31, stamp: { ...closed, freshness: "delayed", quality: "delayed-15m" } }])[0]!.note, null);
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

test("a stale feed marks every live ETF tile with its age and leaves the other notes alone (V-Today-01)", () => {
  const live = { as_of: "2026-10-23T19:25:00Z", source: "alpaca", quality: "delayed-15m", freshness: "paused" } as const;
  const strip: Dashboard["market_strip"] = [
    { symbol: "SPY", last: 678.12, change_pct: 0.31, stamp: live },
    { symbol: "/ES", last: null, change_pct: null, stamp: { ...live, quality: "unavailable", freshness: "unavailable" } },
  ];
  const [spy, es] = stripTiles(strip, null, "Stale · 45 min ago");
  assert.equal(spy!.note, "Stale · 45 min ago");
  assert.equal(es!.note, "Futures deferred · not connected yet");
  assert.equal(stripTiles(strip)[0]!.note, null);
  const closed = { ...live, freshness: "closed", quality: "eod" } as const;
  assert.equal(stripTiles([{ symbol: "SPY", last: 678.12, change_pct: 0.31, stamp: closed }], null, "Stale · 45 min ago")[0]!.note, "Last close · Fri 3:25 PM ET");
});
