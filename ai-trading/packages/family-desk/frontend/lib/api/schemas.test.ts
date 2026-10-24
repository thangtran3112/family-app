import assert from "node:assert/strict";
import test from "node:test";
import {
  BarsSchema,
  FuturesSpecsSchema,
  MeSchema,
  StatusSchema,
  TechnicalsSchema,
  WatchlistItemsSchema,
} from "./schemas.ts";

const bar = {
  t: "2026-10-20T14:35:00Z",
  o: 10,
  h: 12,
  l: 9,
  c: 11,
  v: 500,
  ext: false,
};

const stamp = { as_of: "2026-10-20T14:35:00Z", source: "alpaca", quality: "delayed-15m", freshness: "delayed" };

const warmingTechnicals = {
  symbol: "AAPL",
  quality: "eod",
  as_of: "2024-12-31",
  timeframe: "1d",
  bars_used: 12,
  first_bar: null,
  last_bar: null,
  bias_ready: false,
  indicators: null,
  bias_history: null,
  levels: null,
  stamp,
  gauges: {
    summary: { label: "warming up", score: null, counts: null },
    oscillators: { label: "warming up", score: null, counts: null },
    moving_averages: { label: "warming up", score: null, counts: null },
    strategies: null,
  },
  moving_averages: {
    sma_10: { values: { value: 101.89 }, action: "Buy" },
    sma_200: { values: { value: null }, action: null },
  },
  oscillators: {
    rsi: { values: { value: 100 }, action: "Neutral" },
    stoch_rsi: { values: { k: null }, action: null },
  },
  pivots: { classic: { P: 101 }, fibonacci: {}, camarilla: {} },
  rsi: 100,
  macd: { line: null, signal: null, histogram: null },
  volatility: { atr14: 2, atr_percent: 2, label: null },
  card_back: {
    symbol: "AAPL",
    timeframe: "1D",
    bias_label: null,
    bias_score: null,
    oscillators: {},
    moving_averages: {},
    atr_pct_label: "warming up",
    pivots: {},
  },
};

test("new read schemas accept representative live, warm-up, unavailable, and empty responses", () => {
  const validBars = {
    symbol: "AAPL",
    interval: "5m",
    quality: "fallback",
    as_of: bar.t,
    stamp,
    bars: [bar],
  };
  assert.deepEqual(BarsSchema.parse(validBars), validBars);
  assert.deepEqual(
    BarsSchema.parse({ symbol: "AAPL", interval: "1d", quality: "unavailable", as_of: null, stamp, bars: [] }),
    { symbol: "AAPL", interval: "1d", quality: "unavailable", as_of: null, stamp, bars: [] },
  );
  assert.deepEqual(
    BarsSchema.parse({ ...validBars, interval: "1d", as_of: "2024-12-31", bars: [{ ...bar, t: "2024-12-31" }] }),
    { ...validBars, interval: "1d", as_of: "2024-12-31", bars: [{ ...bar, t: "2024-12-31" }] },
  );

  assert.deepEqual(TechnicalsSchema.parse(warmingTechnicals), warmingTechnicals);
  const unavailableTechnicals = {
    ...warmingTechnicals,
    quality: "unavailable",
    as_of: null,
    moving_averages: {},
    oscillators: {},
    pivots: { classic: {}, fibonacci: {}, camarilla: {} },
    rsi: null,
    macd: { line: null, signal: null, histogram: null },
    volatility: { atr14: null, atr_percent: null, label: null },
    card_back: {
      ...warmingTechnicals.card_back,
      atr_pct_label: "normal",
      oscillators: {},
      moving_averages: {},
      pivots: {},
    },
  };
  assert.deepEqual(TechnicalsSchema.parse(unavailableTechnicals), unavailableTechnicals);

  for (const timeframe of ["1D", "1W", "1h", "5m", "15m", "30m", "4h", "1m"]) {
    assert.equal(
      TechnicalsSchema.safeParse({
        ...warmingTechnicals,
        card_back: { ...warmingTechnicals.card_back, timeframe },
      }).success,
      true,
    );
  }
  for (const interval of ["1d", "1w", "1h", "5m", "15m", "30m", "4h", "1m"]) {
    assert.equal(BarsSchema.safeParse({ ...validBars, interval }).success, true);
  }

  const futures = [
    {
      root: "ES",
      mini: "ES",
      micro: "MES",
      multiplier: 50,
      tick_size: 0.25,
      session: { open_time: "18:00", close_time: "17:00" },
      roll_dates: ["2026-12-14"],
      approx_margin: null,
      margin_as_of: null,
    },
  ];
  assert.deepEqual(FuturesSpecsSchema.parse(futures), futures);
  assert.deepEqual(StatusSchema.parse({
    gateway: "not_configured",
    data_sources: "unknown",
    streaming_slots: { used: 0, max: 70 },
    backups: null,
    reconciliation: null,
    market: { session: "closed", next_open: "2026-10-26T13:30:00Z", last_close: "2026-10-23T20:00:00Z" },
    quotes: stamp,
    scans: { ...stamp, next_run_at: null },
    alerts: { state: "running", unread: 0 },
  }), {
    gateway: "not_configured",
    data_sources: "unknown",
    streaming_slots: { used: 0, max: 70 },
    backups: null,
    reconciliation: null,
    market: { session: "closed", next_open: "2026-10-26T13:30:00Z", last_close: "2026-10-23T20:00:00Z" },
    quotes: stamp,
    scans: { ...stamp, next_run_at: null },
    alerts: { state: "running", unread: 0 },
  });
  assert.deepEqual(MeSchema.parse({ email: "desk-user" }), { email: "desk-user" });
  assert.deepEqual(WatchlistItemsSchema.parse([
    { symbol: "AAPL", asset_type: "stock", backfill: "ready" },
    { symbol: "/ES", asset_type: "future", backfill: "pending" },
  ]), [
    { symbol: "AAPL", asset_type: "stock", backfill: "ready" },
    { symbol: "/ES", asset_type: "future", backfill: "pending" },
  ]);
});

test("nested technical schema rejects missing pivot methods and non-finite values", () => {
  assert.equal(
    TechnicalsSchema.safeParse({ ...warmingTechnicals, pivots: { classic: {}, fibonacci: {} } }).success,
    false,
  );
  assert.equal(
    TechnicalsSchema.safeParse({ ...warmingTechnicals, macd: { line: Infinity, signal: null, histogram: null } }).success,
    false,
  );
});

test("technicals volatility accepts measured values or honest unknowns only", () => {
  for (const label of ["low", "normal", "high", null]) {
    assert.equal(
      TechnicalsSchema.safeParse({
        ...warmingTechnicals,
        volatility: { atr14: 1.25, atr_percent: 0.5, label },
      }).success,
      true,
    );
  }
  assert.equal(
    TechnicalsSchema.safeParse({
      ...warmingTechnicals,
      volatility: { atr14: null, atr_percent: null, label: "warming up" },
    }).success,
    false,
  );
  assert.equal(
    TechnicalsSchema.safeParse({
      ...warmingTechnicals,
      volatility: { atr14: null, atr_percent: null, label: "normal" },
    }).success,
    false,
  );
});

test("as-of values accept source dates and UTC timestamps, not other offsets", () => {
  const bars = {
    symbol: "AAPL",
    interval: "1m",
    quality: "realtime",
    as_of: bar.t,
    stamp,
    bars: [bar],
  };

  assert.equal(BarsSchema.safeParse({ ...bars, as_of: "2026-10-20T14:35:00+00:00" }).success, true);
  assert.equal(BarsSchema.safeParse({ ...bars, as_of: "2026-10-20T14:35:00-05:00" }).success, false);
});

test("numeric API response schemas reject non-finite values", () => {
  assert.equal(BarsSchema.safeParse({
    symbol: "AAPL",
    interval: "1m",
    quality: "realtime",
    as_of: bar.t,
    stamp,
    bars: [{ ...bar, c: Number.POSITIVE_INFINITY }],
  }).success, false);
  assert.equal(FuturesSpecsSchema.safeParse([{
    root: "ES",
    mini: "ES",
    micro: "MES",
    multiplier: 50,
    tick_size: Number.POSITIVE_INFINITY,
    session: { open_time: "18:00", close_time: "17:00" },
    roll_dates: [],
    approx_margin: null,
    margin_as_of: null,
  }]).success, false);
  assert.equal(StatusSchema.safeParse({
    gateway: "not_configured",
    data_sources: "unknown",
    streaming_slots: { used: Number.POSITIVE_INFINITY, max: 70 },
    backups: null,
    reconciliation: null,
    market: { session: "closed", next_open: "2026-10-26T13:30:00Z", last_close: "2026-10-23T20:00:00Z" },
    quotes: stamp,
    scans: { ...stamp, next_run_at: null },
    alerts: { state: "running", unread: 0 },
  }).success, false);
});
