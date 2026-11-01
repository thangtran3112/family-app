import type { OpenTrade, ReplayJournal } from "./schemas.ts";

// The session's practice numbers (02o §a3), and the row type the swing plan checklist reads.

/** Practice P/L now: closed trades plus the open trade marked at the playhead's last price. */
export function practicePnl(journal: Pick<ReplayJournal, "trades">, openTrade: Pick<OpenTrade, "unrealized_usd"> | null): number {
  return journal.trades.reduce((sum, trade) => sum + trade.pnl_usd, 0) + (openTrade?.unrealized_usd ?? 0);
}

export const tradeCount = (journal: Pick<ReplayJournal, "trades">, openTrade: unknown): number => journal.trades.length + (openTrade ? 1 : 0);

export type PlanItem = {
  id: string;
  label: string;
  /** `off`: the plan sets no such rule (its detail says "Off" or "None"), so there is nothing to tick. */
  state: "ok" | "warn" | "pending" | "off";
  detail: string;
};
