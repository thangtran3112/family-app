// Illustrative Practice payloads in the shapes of the generated contract (`lib/api/openapi.d.ts`). The numbers are
// made up (they are not market data); the node tests parse them with the real schemas, and the components can be
// developed against them.
import type { ReplayDays } from "./schemas.ts";

export const stamp = { as_of: "2026-04-07T14:07:00Z", source: "alpaca", quality: "delayed-15m", freshness: "replay" } as const;

export const daysResponse: ReplayDays = {
  days: [
    { symbol: "NVDA", day: "2026-04-07", weekday: "Tue", rank: 1, rv_pct_rank: 99.6, gap_pct: -6.2, tags: ["gap_down", "heavy_volume", "earnings"], attempts: 0 },
    { symbol: "NVDA", day: "2026-02-19", weekday: "Thu", rank: 2, rv_pct_rank: 99.2, gap_pct: 3.1, tags: ["gap_up"], attempts: 1 },
    { symbol: "TSLA", day: "2026-03-11", weekday: "Wed", rank: 1, rv_pct_rank: 99.6, gap_pct: null, tags: ["heavy_volume"], attempts: 0 },
  ],
  symbols: ["NVDA", "TSLA"],
  lookback_sessions: 252,
  stamp,
};

export const spec = {
  schemaVersion: 1,
  symbol: "NVDA",
  day: "2026-04-07",
  window: { from: "09:30", to: "16:00" },
  session: "regular",
  interval: "5m",
  shares: 100,
  armed: [{ source: "alert_strategy", id: 7 }],
  plan: { stopRequired: "yes", signalOnly: "no", maxLossUsd: 200 },
  hideDate: "no",
} as const;

export const journal = {
  totals: { pnl_usd: -42, r_total: -0.4, trades: 3, wins: 1, losses: 2, scratches: 0, win_rate: 0.333, avg_win_usd: 63, avg_loss_usd: -52.5, largest_loss_usd: -71 },
  trades: [
    { no: 1, side: "long", entry_at: "2026-04-07T13:47:00Z", entry_price: 187.42, exit_at: "2026-04-07T14:02:00Z", exit_price: 188.05, shares: 100, pnl_usd: 63, r: 1.21, stop_price: 186.9, on_signal: true, exit_source: "her" },
    { no: 2, side: "short", entry_at: "2026-04-07T14:20:00Z", entry_price: 188.4, exit_at: "2026-04-07T14:31:00Z", exit_price: 189.1, shares: 100, pnl_usd: -70, r: -1, stop_price: 189.1, on_signal: false, exit_source: "her" },
    { no: 3, side: "long", entry_at: "2026-04-07T15:10:00Z", entry_price: 189.5, exit_at: "2026-04-07T20:00:00Z", exit_price: 189.45, shares: 100, pnl_usd: -5, r: null, stop_price: null, on_signal: false, exit_source: "auto" },
  ],
  adherence: {
    score_pct: 75,
    hint: null,
    checks: [
      { id: "stop_set", label: "Stop note on every entry", applicable: true, passed: false, detail: "2 of 3" },
      { id: "max_loss", label: "No entry after max loss", applicable: true, passed: true, detail: "ok" },
    ],
  },
  signals_vs_trades: [{ time: "2026-04-07T13:45:00Z", name: "ORB 15m", close: 187.1, chg_15m_pct: 0.4, chg_30m_pct: -0.2, her: "entered 2 min later" }],
  pnl_series: [{ t: "2026-04-07T14:02:00Z", pnl_usd: 63 }, { t: "2026-04-07T14:31:00Z", pnl_usd: -7 }],
};

export const mark = { id: 3, seq: 1, kind: "long_entry", at: "2026-04-07T13:47:00Z", price: 187.42, shares: 100, stop_price: 186.9, note: "ORB hold", trade_no: 1, source: "her" } as const;

export const openTrade = { trade_no: 1, side: "long", shares: 100, entry_price: 187.42, stop_price: 186.9, last_price: 188.05, unrealized_usd: 63, r: 1.21 } as const;

export const session = {
  id: 12,
  attempt: 1,
  status: "active",
  spec,
  window_start: "2026-04-07T13:30:00Z",
  window_end: "2026-04-07T20:00:00Z",
  revealed_through: "2026-04-07T14:07:00Z",
  tape_feed: "sip",
  armed: [{ source: "alert_strategy", id: 7, version_id: 31, name: "ORB 15m", bias: "bullish", fires_so_far: 1 }],
  marks: [mark],
  open_trade: openTrade,
  journal,
  notes: null,
  rating: null,
  created_at: "2026-04-07T13:29:40Z",
  ended_at: null,
  stamp,
} as const;

export const sessionSummary = {
  id: 12,
  symbol: "NVDA",
  day: "2026-04-07",
  attempt: 1,
  status: "active",
  hide_date: "no",
  revealed_through: "2026-04-07T14:07:00Z",
  window_end: "2026-04-07T20:00:00Z",
  trades: 1,
  pnl_usd: 63,
  adherence_pct: null,
  updated_at: "2026-04-07T14:07:12Z",
} as const;

export const delta = {
  revealed_through: "2026-04-07T14:07:12Z",
  at_end: false,
  bars: [{ t: "2026-04-07T14:00:00Z", o: 187.2, h: 187.6, l: 186.95, c: 187.41, v: 1203344, ext: false }],
  forming: { t: "2026-04-07T14:05:00Z", o: 187.41, h: 188.1, l: 187.3, c: 188.05, v: 402118 },
  prints: {
    feed: "sip",
    rows: [["2026-04-07T14:07:11.482Z", 188.05, 200, 1], ["2026-04-07T14:07:11.900Z", 188.04, 1500, -1]],
    count: 1043,
    volume: 81234,
    shown: 2,
    big_print_usd: 200000,
    pace: { window_s: 10, prints_per_s: 12.4, shares_per_s: 3400, x_of_avg: 1.8, band: "busy" },
  },
  signals: [{ source: "alert_strategy", id: 7, name: "ORB 15m", bias: "bullish", bar_time: "2026-04-07T13:30:00Z", bar_close: "2026-04-07T13:45:00Z", close: 187.1, evidence: { close: 187.1 } }],
  levels: { prior_close: 195.4, session_high: 188.6, session_low: 183.2, opening_range_high: 187.3, opening_range_low: 184.9 },
  last: { price: 188.05, at: "2026-04-07T14:07:11.482Z" },
  open_trade: openTrade,
  stamp,
};

export const feed = { ...delta, interval: "5m", window_start: "2026-04-07T13:30:00Z" };

export const markResult = { mark, open_trade: openTrade, journal };
