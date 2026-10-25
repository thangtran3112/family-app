import { formatNumber } from "../desk/format.ts";
import { formatUsd } from "./journalView.ts";
import type { OpenTrade, ReplayJournal, ReplaySession } from "./schemas.ts";

// Live read of the plan against the session so far (02o §a3 plan checklist): ticks, never blocks.

type Plan = ReplaySession["spec"]["plan"];

/** Practice P/L now: closed trades plus the open trade marked at the playhead's last price. */
export function practicePnl(journal: Pick<ReplayJournal, "trades">, openTrade: Pick<OpenTrade, "unrealized_usd"> | null): number {
  return journal.trades.reduce((sum, trade) => sum + trade.pnl_usd, 0) + (openTrade?.unrealized_usd ?? 0);
}

export const tradeCount = (journal: Pick<ReplayJournal, "trades">, openTrade: unknown): number => journal.trades.length + (openTrade ? 1 : 0);

/** The plan says stop for the day: max loss set and the practice P/L at or below it. A warning, not a block. */
export function maxLossReached(pnl: number, plan: Pick<Plan, "maxLossUsd">): boolean {
  return plan.maxLossUsd !== undefined && pnl <= -plan.maxLossUsd;
}

export type PlanItem = { id: string; label: string; state: "ok" | "warn" | "pending"; detail: string };

export function planChecklist(plan: Plan, journal: Pick<ReplayJournal, "trades">, openTrade: OpenTrade | null): PlanItem[] {
  const items: PlanItem[] = [];
  const closed = journal.trades;
  if (plan.stopRequired === "yes") {
    const missing = closed.filter((trade) => trade.stop_price == null).length + (openTrade && openTrade.stop_price == null ? 1 : 0);
    const total = tradeCount(journal, openTrade);
    items.push({
      id: "stop",
      label: "Stop note on every entry",
      state: total === 0 ? "pending" : missing > 0 ? "warn" : "ok",
      detail: total === 0 ? "No trades yet" : `${total - missing} of ${total}`,
    });
  }
  if (plan.signalOnly === "yes") {
    const off = closed.filter((trade) => !trade.on_signal).length;
    items.push({
      id: "signal",
      label: "Trade only on a signal",
      state: closed.length === 0 ? "pending" : off > 0 ? "warn" : "ok",
      detail: closed.length === 0 ? "No closed trades yet" : `${closed.length - off} of ${closed.length}`,
    });
  }
  if (plan.maxLossUsd !== undefined) {
    const pnl = practicePnl(journal, openTrade);
    items.push({
      id: "max_loss",
      label: `Max loss ${formatUsd(-plan.maxLossUsd).replace("−", "")}`,
      state: maxLossReached(pnl, plan) ? "warn" : "ok",
      detail: `${formatUsd(pnl)} so far`,
    });
  }
  if (plan.maxTrades !== undefined) {
    const total = tradeCount(journal, openTrade);
    items.push({ id: "max_trades", label: `Max trades ${plan.maxTrades}`, state: total > plan.maxTrades ? "warn" : "ok", detail: `${formatNumber(total, 0)} of ${plan.maxTrades}` });
  }
  return items;
}
