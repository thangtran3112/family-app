import { formatClock, formatNumber } from "../desk/format.ts";
import { formatSignedUsd } from "../desk/mask.ts";
import type { OpenTrade, ReplayJournal, ReplaySession, TapeFeed } from "./schemas.ts";

// Live read of the plan against the session so far (02o §a3 plan checklist): ticks, never blocks, never asks for a stop.

type Plan = ReplaySession["spec"]["plan"];

/** Practice P/L now: closed trades plus the open trade marked at the playhead's last price. */
export function practicePnl(journal: Pick<ReplayJournal, "trades">, openTrade: Pick<OpenTrade, "unrealized_usd"> | null): number {
  return journal.trades.reduce((sum, trade) => sum + trade.pnl_usd, 0) + (openTrade?.unrealized_usd ?? 0);
}

export const tradeCount = (journal: Pick<ReplayJournal, "trades">, openTrade: unknown): number => journal.trades.length + (openTrade ? 1 : 0);

/** The plan's max loss is set and the practice P/L is at or below it. A tick on the checklist, nothing more. */
export function maxLossReached(pnl: number, plan: Pick<Plan, "maxLossUsd">): boolean {
  return plan.maxLossUsd !== undefined && pnl <= -plan.maxLossUsd;
}

export type PlanItem = {
  id: string;
  label: string;
  /** `off`: the plan sets no such rule (its detail says "Off" or "None"), so there is nothing to tick. */
  state: "ok" | "warn" | "pending" | "off";
  detail: string;
};

/** The plan's note, if she wrote one. */
export const planNote = (plan: Pick<Plan, "note">): string | null => plan.note ?? null;

/** Every rule of the thread plan against the session so far (D-021): a rule the plan leaves off still has its row, reading Off or None. */
export function planChecklist(plan: Plan, journal: Pick<ReplayJournal, "trades">, openTrade: OpenTrade | null): PlanItem[] {
  const closed = journal.trades;
  const total = tradeCount(journal, openTrade);

  const missing = closed.filter((trade) => trade.stop_price == null).length + (openTrade && openTrade.stop_price == null ? 1 : 0);
  const stop: PlanItem =
    plan.stopRequired === "yes"
      ? {
          id: "stop",
          label: "Stop note on every entry",
          state: total === 0 ? "pending" : missing > 0 ? "warn" : "ok",
          detail: total === 0 ? "No trades yet" : `${total - missing} of ${total}`,
        }
      : { id: "stop", label: "Stop note on every entry", state: "off", detail: "Off" };

  const off = closed.filter((trade) => !trade.on_signal).length;
  const signal: PlanItem =
    plan.signalOnly === "yes"
      ? {
          id: "signal",
          label: "Trade only on a signal",
          state: closed.length === 0 ? "pending" : off > 0 ? "warn" : "ok",
          detail: closed.length === 0 ? "No closed trades yet" : `${closed.length - off} of ${closed.length}`,
        }
      : { id: "signal", label: "Trade only on a signal", state: "off", detail: "Off" };

  const pnl = practicePnl(journal, openTrade);
  const maxLoss: PlanItem =
    plan.maxLossUsd !== undefined
      ? {
          id: "max_loss",
          label: `Max loss ${formatSignedUsd(-plan.maxLossUsd, { cents: true }).replace("−", "")}`,
          state: maxLossReached(pnl, plan) ? "warn" : "ok",
          detail: `${formatSignedUsd(pnl, { cents: true })} so far`,
        }
      : { id: "max_loss", label: "Max loss", state: "off", detail: "None" };

  const maxTrades: PlanItem =
    plan.maxTrades !== undefined
      ? { id: "max_trades", label: `Max trades ${plan.maxTrades}`, state: total > plan.maxTrades ? "warn" : "ok", detail: `${formatNumber(total, 0)} of ${plan.maxTrades}` }
      : { id: "max_trades", label: "Max trades", state: "off", detail: "None" };

  return [stop, signal, maxLoss, maxTrades];
}

/** The session block of the left rail (P2): who and which attempt, the window, and the candle interval with the tape's feed. */
export function sessionFacts(
  spec: Pick<ReplaySession["spec"], "symbol" | "window" | "session" | "interval">,
  attempt: number,
  feed: TapeFeed | null,
): Array<{ id: string; label: string; value: string }> {
  const tape = feed === null ? null : feed === "sip" ? "consolidated" : "IEX only";
  return [
    { id: "symbol", label: "Symbol · attempt", value: `${spec.symbol} · attempt ${attempt}` },
    { id: "window", label: `Window (${spec.session})`, value: `${formatClock(spec.window.from)} – ${formatClock(spec.window.to)} ET` },
    { id: "interval", label: "Interval · tape", value: tape === null ? spec.interval : `${spec.interval} · ${tape}` },
  ];
}
