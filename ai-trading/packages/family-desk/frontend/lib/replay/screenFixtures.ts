// Illustrative Screen payloads in the shapes of the generated contract (`lib/api/openapi.d.ts`). The numbers are
// made up (they are not market data); the node tests parse them with the real schemas.
import type { PracticePlan, Screen } from "./screen.ts";

const stamp = { as_of: "2026-03-10T14:00:00Z", source: "alpaca", quality: "delayed-15m", freshness: "replay" } as const;

export const planSpec = {
  schemaVersion: 2,
  startAt: "2026-03-02T09:30:00-05:00",
  screen: { filters: [{ id: 4 }, { id: 9 }], maxList: 30 },
  setup: { interval: "5m", session: "regular", armed: [] },
} as const;

export const plan: PracticePlan = {
  id: 3,
  thread_id: 1,
  spec: planSpec as unknown as PracticePlan["spec"],
  filters: [{ id: 4, name: "Gap up" }, { id: 9, name: "Abnormal volume" }],
};

export const threadBrief: Screen["thread"] = { id: 1, mode: "day", status: "active", balance: 50000, label: "SIMULATED" };

/** A Screen at 9:50 AM ET on 2026-03-10 (EDT), before any scan has run: it holds no names. */
export const emptyScreen: Screen = {
  id: 42,
  thread_id: 1,
  plan,
  day: "2026-03-10",
  weekday: "Tue",
  data_through: "2026-03-10T13:50:00Z",
  as_of: "2026-03-10T13:50:00Z",
  screen: { filters: [{ id: 4, version_id: 31, name: "Gap up" }, { id: 9, version_id: 55, name: "Abnormal volume" }], max_list: 30 },
  universe: {
    source: "desk",
    size: 131,
    scanned: 0,
    no_data: 0,
    below_floor: 0,
    matches_total: 0,
    shown: 0,
    prev_basis: false,
    filters: [],
    label: "Practice universe · 131 symbols the Desk has scanned · the live screener that morning may have scanned others",
    footnote: "Practice universe · 131 symbols the Desk has scanned · the live screener that morning may have scanned others",
  },
  columns: [],
  candidates: [],
  watch: [],
  watch_check: { starred: [], traded: [], off_watch: [], verdict: "no_trades", label: "No practice trades yet" },
  clock: "2026-03-10T13:50:00Z",
  lanes: [],
  thread: threadBrief,
  warnings: [],
  rescan: null,
  rescan_job: null,
  peek: null,
  notes: null,
  rating: null,
  created_at: "2026-03-10T13:30:05Z",
  stamp,
};

/** The same Screen after a scan at 8:30 AM ET with two names; the thread clock is at 9:50 AM ET. */
export const screen: Screen = {
  ...emptyScreen,
  data_through: "2026-03-10T12:15:00Z",
  universe: {
    ...emptyScreen.universe,
    scanned: 118,
    no_data: 6,
    below_floor: 7,
    matches_total: 34,
    shown: 2,
    prev_basis: true,
    filters: [{ id: 4, version_id: 31, name: "Gap up", scanned: 118, no_data: 0, matches_total: 20 }],
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
      prev_rvol: 1.1,
      prev_change_pct: 1.2,
      earnings_state: "reported",
      new_since_list: false,
      held_over: false,
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
      prev_rvol: null,
      prev_change_pct: -0.3,
      earnings_state: "none",
      new_since_list: false,
      held_over: false,
      metrics: { list_price: 96.4, list_change_pct: 4.1, last: 92.6, change_pct: -0.3, volume: 2400000, rvol_10d: null },
    },
  ],
  watch: [{ symbol: "SMCI", starred_clock: "2026-03-10T12:30:00Z" }],
  watch_check: { starred: ["SMCI"], traded: [], off_watch: [], verdict: "no_trades", label: "No practice trades yet" },
  warnings: ["Only 2 of the 131 scanned symbols met Gap up or Abnormal volume · loosen a filter in the Screener to widen the Screen"],
  rescan: { seq: 1, as_of: "2026-03-10T12:30:00Z", data_through: "2026-03-10T12:15:00Z", new_count: 2, created_at: "2026-03-10T12:30:05Z" },
  rescan_job: { state: "done", as_of: "2026-03-10T12:30:00Z", done: 131, total: 131, message: null },
};
