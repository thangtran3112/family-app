import assert from "node:assert/strict";
import test from "node:test";
import { createDeskApiClient, DeskApiError } from "../api/client.ts";
import { loadDeskFixture } from "../fixtures/desk-mvp/load.ts";
import { query } from "./api.ts";
import { addWatchlistItem, createWatchlist, deleteWatchlist, loadWatchlistItems, loadWatchlistTable, loadWatchlists, removeWatchlistItem, renameWatchlist, reorderWatchlist } from "./watchlists.ts";
import { createAlertStrategy, deleteAlertStrategy, loadAlertFires, loadAlertLog, loadAlertStrategies, loadAlertStrategy, pauseAlertStrategy, resumeAlertStrategy, updateAlertStrategy, validateAlertStrategy } from "./alerts.ts";
import { loadBars, loadMarkers, loadSignals, loadTechnicals } from "./charts.ts";
import { loadDashboard } from "./dashboard.ts";
import { attachPreset, loadLibrary, loadLibraryEntry } from "./library.ts";
import { createFilter, deleteFilter, loadFilterDetail, loadFilterResults, loadFilters, loadUniverse, previewFilter, updateFilter } from "./screener.ts";
import { linkTelegram, loadChannels, loadSettings, saveSettings, testChannel } from "./settings.ts";
import { loadAlertInbox, loadMe, loadStatus, markAlertRead, markAllAlertsRead, searchSymbols } from "./status.ts";

type Call = { method: string; path: string; body: unknown };

/** A client over a fake fetch that answers each request from a fixture and records what it saw. */
function fakeDesk(answer: string | null, status = 200) {
  const calls: Call[] = [];
  const client = createDeskApiClient(
    async (input, init) => {
      const url = input as URL;
      calls.push({ method: init?.method ?? "GET", path: url.pathname + url.search, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
      return answer === null ? new Response(null, { status }) : Response.json(loadDeskFixture(answer), { status });
    },
    () => ({ href: "https://trading.test/" }),
  );
  return { client, calls };
}

test("query() skips unset values and encodes the rest", () => {
  assert.equal(query({ a: 1, b: undefined, c: null, d: "", e: "x y", f: false }), "?a=1&e=x+y&f=false");
  assert.equal(query({}), "");
});

test("status, search and inbox loaders", async () => {
  let d = fakeDesk("status");
  assert.equal((await loadStatus({ client: d.client })).market.session, "closed");
  assert.deepEqual(d.calls[0], { method: "GET", path: "/api/desk/status", body: undefined });
  d = fakeDesk("symbols_search");
  assert.equal((await searchSymbols(" NV ", 8, { client: d.client })).length > 0, true);
  assert.equal(d.calls[0].path, "/api/desk/symbols/search?q=NV&limit=8");
  d = fakeDesk("alerts");
  await loadAlertInbox({ unread: true, symbol: "NVDA", limit: 20 }, { client: d.client });
  assert.equal(d.calls[0].path, "/api/desk/alerts?unread=true&symbol=NVDA&limit=20");
  d = fakeDesk("alerts");
  await loadAlertInbox({}, { client: d.client });
  assert.equal(d.calls[0].path, "/api/desk/alerts");
  const me = fakeDesk(null);
  await assert.rejects(loadMe({ client: me.client }), DeskApiError);
  d = fakeDesk("alerts");
  await assert.rejects(markAlertRead(5, { client: d.client })); // the fixture is a list, not one alert
  assert.deepEqual(d.calls[0], { method: "POST", path: "/api/desk/alerts/5/read", body: {} });
  await assert.rejects(markAllAlertsRead({ client: fakeDesk("alerts").client }));
});

test("dashboard and chart loaders build the documented URLs", async () => {
  let d = fakeDesk("dashboard");
  await loadDashboard(2, { client: d.client });
  assert.equal(d.calls[0].path, "/api/desk/dashboard?watchlist_id=2");
  d = fakeDesk("dashboard");
  await loadDashboard(undefined, { client: d.client });
  assert.equal(d.calls[0].path, "/api/desk/dashboard");
  d = fakeDesk("bars_nvda_15m");
  await loadBars("NVDA", "15m", { days: 5, session: "extended" }, { client: d.client });
  assert.equal(d.calls[0].path, "/api/desk/bars/NVDA?interval=15m&days=5&session=extended");
  d = fakeDesk("bars_nvda_15m");
  await loadBars("/ES", "5m", undefined, { client: d.client });
  assert.equal(d.calls[0].path, "/api/desk/bars/%2FES?interval=5m&days=5&session=regular");
  d = fakeDesk("technicals_nvda_15m");
  await loadTechnicals("NVDA", "15m", undefined, { client: d.client });
  assert.equal(d.calls[0].path, "/api/desk/technicals/NVDA?timeframe=15m&days=3650");
  d = fakeDesk("chart_markers_msft_15m");
  await loadMarkers("MSFT", "15m", { allPatterns: true }, { client: d.client });
  assert.equal(d.calls[0].path, "/api/desk/charts/MSFT/markers?timeframe=15m&all_patterns=true");
  d = fakeDesk("signals");
  await loadSignals({ symbol: "NVDA", limit: 10 }, { client: d.client });
  assert.equal(d.calls[0].path, "/api/desk/signals?symbol=NVDA&limit=10");
});

test("screener loaders read, preview, copy, save and archive", async () => {
  let d = fakeDesk("screener_filters");
  assert.equal((await loadFilters({ client: d.client })).length > 0, true);
  d = fakeDesk("screener_filter_1");
  await loadFilterDetail(1, { client: d.client });
  assert.equal(d.calls[0].path, "/api/desk/screener/filters/1");
  d = fakeDesk("screener_filter_1_results");
  await loadFilterResults(1, "extended", { client: d.client });
  assert.equal(d.calls[0].path, "/api/desk/screener/filters/1/results?session=extended");
  d = fakeDesk("screener_universe");
  await loadUniverse({ client: d.client });
  d = fakeDesk("screener_preview");
  const spec = { schemaVersion: 1 };
  await previewFilter(spec, { client: d.client });
  assert.deepEqual(d.calls[0], { method: "POST", path: "/api/desk/screener/preview", body: { spec } });
  d = fakeDesk("screener_filter_copy");
  await createFilter({ copy_of: 3 }, { client: d.client });
  assert.deepEqual(d.calls[0].body, { copy_of: 3 });
  d = fakeDesk("screener_filter_copy");
  await updateFilter(11, spec, "tweak", { client: d.client });
  assert.deepEqual(d.calls[0], { method: "PUT", path: "/api/desk/screener/filters/11", body: { spec, change_note: "tweak" } });
  d = fakeDesk(null, 204);
  await deleteFilter(11, { client: d.client });
  assert.deepEqual(d.calls[0], { method: "DELETE", path: "/api/desk/screener/filters/11", body: undefined });
});

test("watchlist loaders cover the table, manage mode and the 409 rename guard", async () => {
  let d = fakeDesk("watchlists");
  await loadWatchlists({ client: d.client });
  d = fakeDesk("watchlist_1_table");
  assert.equal((await loadWatchlistTable(1, { client: d.client })).watchlist.name, "Day movers");
  d = fakeDesk("watchlists");
  await assert.rejects(loadWatchlistItems(1, { client: d.client }));
  assert.equal(d.calls[0].path, "/api/desk/watchlists/1/items");
  d = fakeDesk(null, 204);
  await removeWatchlistItem(1, "/ES", { client: d.client });
  assert.equal(d.calls[0].path, "/api/desk/watchlists/1/items/%2FES");
  d = fakeDesk(null, 204);
  await deleteWatchlist(1, { client: d.client });
  assert.equal(d.calls[0].method, "DELETE");
  await assert.rejects(renameWatchlist(1, "Swing", { client: fakeDesk(null, 409).client }), (error: unknown) => error instanceof DeskApiError && error.status === 409);
  await assert.rejects(createWatchlist("x", "swing", { client: fakeDesk(null, 500).client }));
  await assert.rejects(addWatchlistItem(1, "NVDA", "stock", { client: fakeDesk(null, 500).client }));
  d = fakeDesk("watchlists");
  await assert.rejects(reorderWatchlist(1, ["NVDA", "AMD"], { client: d.client }));
  assert.deepEqual(d.calls[0], { method: "PUT", path: "/api/desk/watchlists/1/order", body: { symbols: ["NVDA", "AMD"] } });
});

test("library and alert strategy loaders", async () => {
  let d = fakeDesk("library");
  assert.equal((await loadLibrary({ category: "candlestick", q: "ham" }, { client: d.client })).length > 0, true);
  assert.equal(d.calls[0].path, "/api/desk/library?category=candlestick&q=ham");
  d = fakeDesk("library_hammer");
  await loadLibraryEntry("hammer", { client: d.client });
  d = fakeDesk("library_attach", 201);
  await attachPreset("hammer", { watchlist_id: 1, channels: ["inbox"] }, { client: d.client });
  assert.deepEqual(d.calls[0], { method: "POST", path: "/api/desk/library/hammer/attach", body: { watchlist_id: 1, channels: ["inbox"] } });

  d = fakeDesk("alert_strategies");
  await loadAlertStrategies({ status: "paused", watchlistId: 1, sort: "last_fired" }, { client: d.client });
  assert.equal(d.calls[0].path, "/api/desk/alert-strategies?status=paused&watchlist_id=1&sort=last_fired");
  d = fakeDesk("alert_strategy_2");
  await loadAlertStrategy(2, { client: d.client });
  d = fakeDesk("alert_strategy_2_fires");
  await loadAlertFires(2, 5, { client: d.client });
  assert.equal(d.calls[0].path, "/api/desk/alert-strategies/2/fires?limit=5");
  d = fakeDesk("alert_strategy_validate_problem");
  const validated = await validateAlertStrategy({ x: 1 }, { client: d.client });
  assert.equal(validated.problems[0].path, "then.alert.channels");
  d = fakeDesk("library_attach", 201);
  await createAlertStrategy({ x: 1 }, "draft", { client: d.client });
  assert.deepEqual(d.calls[0].body, { spec: { x: 1 }, save_as: "draft" });
  const rejected = fakeDesk("alert_strategy_create_422", 422);
  await assert.rejects(createAlertStrategy({ x: 1 }, "draft", { client: rejected.client }), (error: unknown) =>
    error instanceof DeskApiError && error.status === 422 && error.problems[0].message === "the first alert channel must be inbox");
  d = fakeDesk("alert_strategy_2");
  await updateAlertStrategy(2, { x: 1 }, null, { client: d.client });
  assert.deepEqual(d.calls[0], { method: "PUT", path: "/api/desk/alert-strategies/2", body: { spec: { x: 1 }, change_note: null } });
  d = fakeDesk("library_attach");
  await pauseAlertStrategy(2, { client: d.client });
  assert.deepEqual(d.calls[0].body, { reason: "user" });
  d = fakeDesk("library_attach");
  await resumeAlertStrategy(2, { client: d.client });
  assert.equal(d.calls[0].path, "/api/desk/alert-strategies/2/resume");
  d = fakeDesk(null, 204);
  await deleteAlertStrategy(2, { client: d.client });
  d = fakeDesk("alerts_log");
  await loadAlertLog({ status: "failed", limit: 25 }, { client: d.client });
  assert.equal(d.calls[0].path, "/api/desk/alerts/log?status=failed&limit=25");
});

test("settings and channel loaders", async () => {
  let d = fakeDesk("settings_channels");
  assert.equal((await loadChannels({ client: d.client })).length, 3);
  d = fakeDesk(null, 500);
  await assert.rejects(loadSettings({ client: d.client }));
  await assert.rejects(saveSettings({ pause_all: true }, { client: fakeDesk(null, 500).client }));
  await assert.rejects(linkTelegram("123", { client: fakeDesk(null, 422).client }));
  d = fakeDesk(null, 500);
  await assert.rejects(testChannel("telegram", { client: d.client }));
  assert.equal(d.calls[0].path, "/api/desk/settings/channels/telegram/test");
});
