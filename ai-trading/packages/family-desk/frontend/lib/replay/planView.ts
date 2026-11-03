import type { OpenTrade, ReplayJournal } from "./schemas.ts";

// The lane's practice numbers (02o §a3).

/** Practice P/L now: closed trades plus the open trade marked at the thread's last price. */
export function practicePnl(journal: Pick<ReplayJournal, "trades">, openTrade: Pick<OpenTrade, "unrealized_usd"> | null): number {
  return journal.trades.reduce((sum, trade) => sum + trade.pnl_usd, 0) + (openTrade?.unrealized_usd ?? 0);
}

export const tradeCount = (journal: Pick<ReplayJournal, "trades">, openTrade: unknown): number => journal.trades.length + (openTrade ? 1 : 0);
