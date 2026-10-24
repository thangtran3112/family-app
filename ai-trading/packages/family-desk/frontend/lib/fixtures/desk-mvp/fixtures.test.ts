import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import type { ZodType } from "zod";
import {
  AlertLogSchema,
  AlertStrategiesSchema,
  AlertStrategyDetailSchema,
  AlertStrategyFiresSchema,
  AlertStrategySchema,
  AlertStrategyValidateSchema,
  AlertsResponseSchema,
  BarsSchema,
  DashboardSchema,
  LibraryEntrySchema,
  LibraryListSchema,
  MarkersSchema,
  ScreenerFilterDetailSchema,
  ScreenerFiltersSchema,
  ScreenerPreviewSchema,
  ScreenerResultsSchema,
  ScreenerUniverseSchema,
  SettingsChannelsSchema,
  SignalsResponseSchema,
  StatusSchema,
  SymbolSearchResponseSchema,
  TechnicalsSchema,
  WatchlistTableSchema,
  WatchlistsResponseSchema,
} from "../../api/schemas.ts";
import { parseErrorBody } from "../../api/client.ts";
import { loadDeskFixture } from "./load.ts";

const schemas: Record<string, ZodType> = {
  alert_strategies: AlertStrategiesSchema,
  alert_strategy_2: AlertStrategyDetailSchema,
  alert_strategy_2_fires: AlertStrategyFiresSchema,
  alert_strategy_validate: AlertStrategyValidateSchema,
  alert_strategy_validate_problem: AlertStrategyValidateSchema,
  alerts: AlertsResponseSchema,
  alerts_log: AlertLogSchema,
  bars_nvda_15m: BarsSchema,
  bars_nvda_1d: BarsSchema,
  bars_nvda_5m_extended: BarsSchema,
  chart_markers_msft_15m: MarkersSchema,
  dashboard: DashboardSchema,
  library: LibraryListSchema,
  library_attach: AlertStrategySchema,
  library_hammer: LibraryEntrySchema,
  screener_filter_1: ScreenerFilterDetailSchema,
  screener_filter_1_results: ScreenerResultsSchema,
  screener_filter_copy: ScreenerFilterDetailSchema,
  screener_filters: ScreenerFiltersSchema,
  screener_preview: ScreenerPreviewSchema,
  screener_universe: ScreenerUniverseSchema,
  settings_channels: SettingsChannelsSchema,
  signals: SignalsResponseSchema,
  status: StatusSchema,
  symbols_search: SymbolSearchResponseSchema,
  technicals_nvda_15m: TechnicalsSchema,
  technicals_spy_1d: TechnicalsSchema,
  watchlist_1_table: WatchlistTableSchema,
  watchlists: WatchlistsResponseSchema,
};

const fixtureDir = new URL("./api/", import.meta.url);

test("every fixture parses with its response schema", () => {
  for (const [name, schema] of Object.entries(schemas)) {
    const result = schema.safeParse(loadDeskFixture(name));
    assert.ok(result.success, `${name}: ${result.success ? "" : result.error.message}`);
  }
});

test("every fixture file has a schema or is the 422 error body", () => {
  const names = readdirSync(fixtureDir).map((file) => file.replace(/\.json$/, "")).sort();
  assert.deepEqual(names.filter((name) => !(name in schemas)), ["alert_strategy_create_422"]);
  assert.deepEqual(parseErrorBody(loadDeskFixture("alert_strategy_create_422")).problems, [
    { path: "then.alert.channels", message: "the first alert channel must be inbox" },
  ]);
});

test("schemas reject malformed payloads", () => {
  const status = loadDeskFixture("status") as Record<string, unknown>;
  assert.equal(StatusSchema.safeParse({ ...status, alerts: { state: "exploded", unread: 1 } }).success, false);
  const bars = loadDeskFixture("bars_nvda_15m") as { bars: Array<Record<string, unknown>> };
  assert.equal(BarsSchema.safeParse({ ...bars, bars: [{ ...bars.bars[0], c: Number.NaN }] }).success, false);
  const dashboard = loadDeskFixture("dashboard") as Record<string, unknown>;
  assert.equal(DashboardSchema.safeParse({ ...dashboard, market_strip: [{ symbol: "SPY" }] }).success, false);
});

test("the copies match the backend fixtures byte for byte", () => {
  const backend = new URL("../../../../backend/tests/fixtures/desk-mvp/api/", import.meta.url);
  if (!existsSync(backend)) return; // standalone checkout: nothing to compare
  for (const file of readdirSync(backend).filter((name) => name.endsWith(".json"))) {
    assert.equal(
      readFileSync(new URL(file, fixtureDir), "utf8"),
      readFileSync(new URL(file, backend), "utf8"),
      `${file} drifted: run node scripts/sync-desk-fixtures.mjs`,
    );
  }
});
