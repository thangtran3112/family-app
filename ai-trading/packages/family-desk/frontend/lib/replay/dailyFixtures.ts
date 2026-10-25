// Illustrative daily-list payloads in the shapes of the generated contract (`lib/api/openapi.d.ts`). The numbers are
// made up (they are not market data); the node tests parse them with the real schemas.
import type { DayList, PracticePlan } from "./daily.ts";
import { threadBrief } from "./threadFixtures.ts";

const stamp = { as_of: "2026-03-09T13:15:00Z", source: "alpaca", quality: "delayed-15m", freshness: "replay" } as const;

export const planSpec = {
  schemaVersion: 1,
  firstDay: "2026-03-02",
  sessions: 20,
  hideDates: "yes",
  screen: { filters: [{ id: 4 }, { id: 9 }], listAt: "08:30", maxList: 30 },
  setup: {
    window: { from: "09:30", to: "11:30" },
    session: "regular",
    interval: "5m",
    shares: 100,
    armed: [],
    plan: { stopRequired: "yes", signalOnly: "no", maxLossUsd: 200 },
  },
} as const;

export const plan: PracticePlan = {
  id: 3,
  thread_id: 1,
  spec: planSpec as unknown as PracticePlan["spec"],
  sessions: 20,
  days_opened: 6,
  filters: [{ id: 4, name: "Gap up" }, { id: 9, name: "Abnormal volume" }],
  current: { id: 41, day_no: 6, status: "ended" },
  next_day: "2026-03-10",
  next_weekday: "Tue",
  next_day_no: 7,
  finished: false,
  prep: { state: "done", done: 131, total: 131, failed: 2 },
};

export const dayList: DayList = {
  id: 42,
  plan,
  day: "2026-03-10",
  weekday: "Tue",
  day_no: 7,
  of: 20,
  status: "listed",
  list_at: "2026-03-10T12:30:00Z",
  data_through: "2026-03-10T12:15:00Z",
  screen: { filters: [{ id: 4, version_id: 31, name: "Gap up" }, { id: 9, version_id: 55, name: "Abnormal volume" }], list_at: "08:30", max_list: 30 },
  universe: {
    source: "desk",
    size: 131,
    scanned: 118,
    no_data: 6,
    below_floor: 7,
    matches_total: 34,
    shown: 2,
    prev_basis: true,
    filters: [{ id: 4, version_id: 31, name: "Gap up", scanned: 118, no_data: 0, matches_total: 20 }],
    label: "Practice universe · 131 symbols the Desk has scanned · the live screener that morning may have scanned others",
    footnote: "Practice universe · 131 symbols the Desk has scanned · the live screener that morning may have scanned others",
  },
  columns: [
    { key: "list_price", label: "List price", format: "price" },
    { key: "list_change_pct", label: "vs prev close %", format: "pct_signed" },
    { key: "last", label: "Prev close", format: "price" },
    { key: "change_pct", label: "Prev change %", format: "pct_signed" },
    { key: "volume", label: "Prev volume", format: "compact" },
    { key: "rvol_10d", label: "Prev RVOL", format: "ratio" },
    { key: "matched_since", label: "Since", format: "time" },
  ],
  candidates: [
    {
      rank: 1,
      symbol: "SMCI",
      filters: ["Gap up", "Abnormal volume"],
      rank_value: 8.4,
      matched_since: "2026-03-10T12:30:00Z",
      operands: { gap_pct: 8.4 },
      list_price: 41.12,
      price_at: "2026-03-10T12:15:00Z",
      prior_close: 37.9,
      reported_before_open: true,
      metrics: { list_price: 41.12, list_change_pct: 8.5, last: 37.9, change_pct: 1.2, volume: 1820000, rvol_10d: 1.1 },
    },
    {
      rank: 2,
      symbol: "ANET",
      filters: ["Gap up"],
      rank_value: 4.1,
      matched_since: "2026-03-10T12:30:00Z",
      operands: { gap_pct: 4.1 },
      list_price: 96.4,
      price_at: "2026-03-10T12:15:00Z",
      prior_close: 92.6,
      reported_before_open: false,
      metrics: { list_price: 96.4, list_change_pct: 4.1, last: 92.6, change_pct: -0.3, volume: 2400000, rvol_10d: null },
    },
  ],
  watch: [{ symbol: "SMCI", starred_clock: "2026-03-10T12:30:00Z" }],
  clock: null,
  sessions: [],
  thread: threadBrief,
  warnings: ["Only 2 of the 131 scanned symbols met Gap up and Abnormal volume · loosen a filter in the Screener to widen the next days' lists"],
  peek: null,
  journal: null,
  review: null,
  notes: null,
  rating: null,
  created_at: "2026-03-10T12:30:05Z",
  ended_at: null,
  stamp,
};

export const endedDayList: DayList = {
  ...dayList,
  status: "ended",
  clock: "2026-03-10T15:30:00Z",
  sessions: [{ id: 12, symbol: "SMCI", status: "ended" }],
  journal: { sessions: [{ id: 12, symbol: "SMCI", trades: 1, pnl_usd: 63, adherence_pct: 100 }], trades: 1, pnl_usd: 63 },
  review: {
    window_end: "2026-03-10T15:30:00Z",
    of: 2,
    rows: [
      { symbol: "SMCI", list_price: 41.12, window_end_price: 42.4, move_pct: 3.11, close_price: 43, close_move_pct: 4.57, high_pct: 4.2, low_pct: -0.4, range_pct: 4.6, rank: 1, picked: "traded" },
      { symbol: "ANET", list_price: 96.4, window_end_price: 96.1, move_pct: -0.31, close_price: 95, close_move_pct: -1.45, high_pct: 0.5, low_pct: -0.9, range_pct: 1.4, rank: 2, picked: null },
    ],
    selection: { picks: [{ symbol: "SMCI", kind: "traded", move_pct: 3.11, rank: 1 }], median_abs_move_pct: 1.71, picks_avg_abs_move_pct: 3.11 },
  },
  ended_at: "2026-03-10T15:31:00Z",
};
