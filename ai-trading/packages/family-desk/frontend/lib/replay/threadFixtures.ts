// Illustrative practice-thread payloads in the shapes of the thread endpoints (`ai_trading/api/schemas/threads.py`, the
// `PracticeThreadV1` contract). The numbers are made up (SIMULATED, not market data); the node tests parse them with the
// real schemas and the components can be developed against them. The curve and the daily rows agree with the stats.
import type { CurvePoint, Thread, ThreadBrief, ThreadDay, ThreadSummary } from "./threads.ts";

export const threadBrief: ThreadBrief = {
  id: 1,
  mode: "day",
  status: "active",
  balance: 50123,
  today_pnl_usd: 112,
  label: "Simulated money · practice only, never a real account",
};

const plan = { stopNoteOnEntry: "yes", tradeOnlyOnSignal: "yes", maxLossUsd: 600, maxTrades: 3, planNote: "Trade only VWAP reclaims. Stop at a real level. One trade at a time." } as const;

export const activeThread: ThreadSummary = {
  thread: {
    schemaVersion: 1,
    id: 1,
    mode: "day",
    startingBalance: 50000,
    status: "active",
    plan,
    createdAt: "2026-10-05T14:00:00Z",
    stats: {
      balance: 50123,
      daysPracticed: 6,
      daysSkipped: 2,
      wins: 9,
      losses: 5,
      winRate: 0.64,
      avgWinUsd: 44,
      avgLossUsd: -54,
      bestDayUsd: 240,
      worstDayUsd: -182,
      adherenceFirstPct: 71,
      adherenceLastPct: 83,
    },
  },
  today: { day_list_id: 41, day: "2026-03-10", weekday: "Tue", day_no: 8, status: "practicing", trades: 1, pnl_usd: 112 },
  last_day: null,
  last_activity_at: "2026-10-23T20:41:00Z",
  label: "Simulated money · practice only, never a real account",
};

const days: Array<[ThreadDay["weekday"], ThreadDay["kind"], number, number, number | null]> = [
  ["Mon", "practiced", 2, -182, 71],
  ["Tue", "practiced", 3, -65, 67],
  ["Wed", "practiced", 2, 40, 80],
  ["Thu", "skipped", 0, 0, null],
  ["Fri", "practiced", 4, 240, 83],
  ["Mon", "practiced", 1, -22, 100],
  ["Tue", "skipped", 0, 0, null],
  ["Wed", "practiced", 1, 112, 83],
];

const dates = ["2026-02-23", "2026-02-24", "2026-02-25", "2026-02-26", "2026-02-27", "2026-03-02", "2026-03-03", "2026-03-04"];

let running = 50000;
export const threadDays: ThreadDay[] = days.map(([weekday, kind, trades, pnl, adherence], index) => {
  running += pnl;
  return { n: index + 1, day_list_id: 30 + index, day: dates[index]!, weekday, kind, trades, pnl_usd: pnl, adherence_pct: adherence, balance: running };
});

export const threadCurve: CurvePoint[] = [
  { n: 0, day: null, balance: 50000 },
  ...threadDays.map((day) => ({ n: day.n, day: day.day, balance: day.balance })),
];

export const thread: Thread = { ...activeThread, last_day: threadDays.at(-1) ?? null, daily: threadDays, curve: threadCurve };

/** A thread with no ended day yet: the balance is the starting balance and there is nothing to chart. */
export const freshThread: Thread = {
  thread: {
    ...activeThread.thread,
    id: 2,
    stats: { balance: 50000, daysPracticed: 0, daysSkipped: 0, wins: 0, losses: 0 },
  },
  today: null,
  last_day: null,
  last_activity_at: null,
  daily: [],
  curve: [{ n: 0, day: null, balance: 50000 }],
  label: activeThread.label,
};

export const closedThread: Thread = {
  ...thread,
  thread: { ...thread.thread, id: 3, status: "closed", closedAt: "2026-03-06T21:00:00Z" },
  today: null,
};
