// Illustrative practice-thread payloads in the shapes of the thread endpoints (`ai_trading/api/schemas/threads.py`, the
// `PracticeThreadV1` contract). The numbers are made up (SIMULATED, not market data); the node tests parse them with the
// real schemas and the components can be developed against them. The curve and the dated rows agree with the stats.
import type { CurvePoint, Thread, ThreadBrief, ThreadClockBrief, ThreadDate, ThreadSummary } from "./threads.ts";

export const threadBrief: ThreadBrief = {
  id: 1,
  mode: "day",
  status: "active",
  balance: 50123,
  label: "Simulated money · practice only, never a real account",
};

const plan = { stopNoteOnEntry: "yes", tradeOnlyOnSignal: "yes", maxLossUsd: 600, maxTrades: 3, planNote: "Trade only VWAP reclaims. Stop at a real level. One trade at a time." } as const;

/** Tue 2026-03-10, 9:41 AM ET, paused: the thread's time `T`. */
export const threadClockBrief: ThreadClockBrief = {
  clock: "2026-03-10T13:41:00Z",
  running: false,
  speed: 1,
  start_at: "2026-02-23T14:30:00Z",
  pause: null,
};

export const activeThread: ThreadSummary = {
  thread: {
    schemaVersion: 1,
    id: 1,
    name: "Freestyle · Oct 5",
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
  clock: threadClockBrief,
  positions_open: 2,
  last_activity_at: "2026-10-23T20:41:00Z",
  label: "Simulated money · practice only, never a real account",
};

const dates: Array<[ThreadDate["weekday"], string, number, number]> = [
  ["Mon", "2026-02-23", 2, -182],
  ["Tue", "2026-02-24", 3, -65],
  ["Wed", "2026-02-25", 2, 40],
  ["Fri", "2026-02-27", 4, 240],
  ["Mon", "2026-03-02", 1, -22],
  ["Wed", "2026-03-04", 1, 112],
];

let running = 50000;
/** The ET dates that have a realized trade, oldest first. A date with no trade has no row. */
export const threadDays: ThreadDate[] = dates.map(([weekday, day, trades, pnl], index) => {
  running += pnl;
  return { n: index + 1, day, weekday, trades, pnl_usd: pnl, balance: running };
});

export const threadCurve: CurvePoint[] = [
  { n: 0, day: null, balance: 50000 },
  ...threadDays.map((day) => ({ n: day.n, day: day.day, balance: day.balance })),
];

export const thread: Thread = { ...activeThread, daily: threadDays, curve: threadCurve };

/** A thread with no trade yet: the balance is the starting balance, nothing is open and there is nothing to chart. */
export const freshThread: Thread = {
  thread: {
    ...activeThread.thread,
    id: 2,
    stats: { balance: 50000, daysPracticed: 0, daysSkipped: 0, wins: 0, losses: 0 },
  },
  clock: { ...threadClockBrief, clock: "2026-02-23T14:30:00Z" },
  positions_open: 0,
  last_activity_at: null,
  daily: [],
  curve: [{ n: 0, day: null, balance: 50000 }],
  label: activeThread.label,
};

/** A closed thread: its clock stopped where it was, and its positions stay open at that time. */
export const closedThread: Thread = {
  ...thread,
  thread: { ...thread.thread, id: 3, status: "closed", closedAt: "2026-03-06T21:00:00Z" },
};
