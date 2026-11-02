import type { PracticeMarkV1 } from "@ai-trading/contracts/replay-session-v1";
import type { OrderBody } from "../desk/replay.ts";
import { DECIMAL, SHARES_MAX, SHARES_TOO_BIG, entryMark } from "./markInput.ts";
import type { OpenTrade, PracticeOrder } from "./schemas.ts";

// The order ticket of the replay workspace: a side, a quantity and an order type, with the price fields that type needs
// and no others. Pure: the draft in, the request out. The only checks are the broker's own: a whole quantity of 1 or more
// and prices above 0, and the one size rule: the cost must fit the buying power (`buyingPowerMessage`, from what the client
// knows; the server holds the exact figure and answers the rest). A stop price is never required.

export type TicketSide = "buy" | "sell";
export type TicketType = "market" | "limit" | "stop" | "stop_limit" | "bracket";
export type TicketDraft = { side: TicketSide; type: TicketType; shares: string; limitPrice: string; stopPrice: string };
export type TicketField = "shares" | "limitPrice" | "stopPrice";

export type TicketOption = {
  value: TicketType;
  label: string;
  /** The price fields this type shows: only these. */
  limit: boolean;
  stop: boolean;
  /** Set when the Desk cannot simulate the type: the option is listed, described, and cannot be chosen. */
  unavailable?: string;
};

export const TICKET_TYPES: readonly TicketOption[] = [
  { value: "market", label: "Market", limit: false, stop: false },
  { value: "limit", label: "Limit", limit: true, stop: false },
  { value: "stop", label: "Stop", limit: false, stop: true },
  { value: "stop_limit", label: "Stop-limit", limit: true, stop: true },
  // A bracket is an entry with a stop and a target that cancel each other. The simulator fills no such pair, so the type is
  // named and not offered: a ticket that took one would report executions that never happen.
  { value: "bracket", label: "Bracket", limit: false, stop: true, unavailable: "Bracket · not simulated yet" },
];

export const typeOption = (type: TicketType): TicketOption => TICKET_TYPES.find((option) => option.value === type) ?? TICKET_TYPES[0]!;
export const typeLabel = (type: TicketType): string => typeOption(type).label;

export const initialTicket = (shares: number): TicketDraft => ({ side: "buy", type: "market", shares: String(shares), limitPrice: "", stopPrice: "" });

export const MESSAGES: Record<TicketField, string> = {
  shares: "Quantity: a whole number of 1 or more",
  limitPrice: "Limit price: a number above 0",
  stopPrice: "Stop price: a number above 0",
};

export type TicketAction = { kind: "mark"; mark: PracticeMarkV1 } | { kind: "order"; order: OrderBody };
export type TicketBuild = { ok: true; action: TicketAction } | { ok: false; field: TicketField | "type"; message: string };

const price = (text: string): number | null => {
  const value = DECIMAL.test(text.trim()) ? Number(text.trim()) : Number.NaN;
  return Number.isFinite(value) && value > 0 ? value : null;
};

/** The request a ticket sends. Market is an entry mark at the last print; limit, stop and stop-limit are orders that wait on the tape. */
export function buildTicket(draft: TicketDraft): TicketBuild {
  const option = typeOption(draft.type);
  if (option.unavailable) return { ok: false, field: "type", message: option.unavailable };
  if (!/^\d+$/.test(draft.shares.trim()) || Number(draft.shares) < 1) return { ok: false, field: "shares", message: MESSAGES.shares };
  const shares = Number(draft.shares);
  if (shares > SHARES_MAX) return { ok: false, field: "shares", message: SHARES_TOO_BIG };
  const limitPrice = option.limit ? price(draft.limitPrice) : undefined;
  if (limitPrice === null) return { ok: false, field: "limitPrice", message: MESSAGES.limitPrice };
  const stopPrice = option.stop ? price(draft.stopPrice) : undefined;
  if (stopPrice === null) return { ok: false, field: "stopPrice", message: MESSAGES.stopPrice };
  if (draft.type === "market") {
    const built = entryMark(draft.side === "buy" ? "long_entry" : "short_entry", { shares: draft.shares.trim() });
    return built.ok ? { ok: true, action: { kind: "mark", mark: built.mark } } : { ok: false, field: "shares", message: built.message };
  }
  return {
    ok: true,
    action: {
      kind: "order",
      order: {
        side: draft.side,
        orderType: draft.type as OrderBody["orderType"],
        shares,
        ...(limitPrice !== undefined ? { limitPrice } : {}),
        ...(stopPrice !== undefined ? { stopPrice } : {}),
      },
    },
  };
}

/** What the client knows of the account: the thread's numbers and this name's position. Other names' holds and working orders are the server's. */
export type PowerBasis = {
  /** The thread's balance (booked trades included). */
  balance: number;
  /** A swing thread's free cash, already net of its open holds; null for a day thread. */
  freeCash: number | null;
  /** This name's open position. */
  trade: Pick<OpenTrade, "side" | "shares" | "entry_price"> | null;
  /** The last print: what a market order costs. */
  last: number | null;
};

const dollars = (value: number): string => `$${value.toLocaleString("en-US")}`;

/**
 * Buying power is the only size rule, the server's own: the shares that open or add to the position cost shares x price (a market
 * order at the last print, a limit order at its limit, a stop at its trigger) and must fit the free cash. Shares that close the
 * position need no cash; a flip gets the closed position's cash and P/L back first. The client cannot see other names' holds or
 * working orders, so it takes the most cash the account can have (never refusing what the server would take) and the server's
 * "Not enough practice cash" covers the rest. Returns the refusal, or null when the order fits or the draft is not complete yet.
 */
export function buyingPowerMessage(draft: TicketDraft, basis: PowerBasis | null): string | null {
  if (basis === null) return null;
  const option = typeOption(draft.type);
  if (option.unavailable || !/^\d+$/.test(draft.shares.trim())) return null;
  const shares = Number(draft.shares);
  if (shares < 1 || shares > SHARES_MAX) return null;
  const at = draft.type === "market" ? basis.last : price(option.limit ? draft.limitPrice : draft.stopPrice);
  if (at === null) return null;
  const { trade, freeCash } = basis;
  const buying = draft.side === "buy";
  const closes = trade !== null && (trade.side === "long") === !buying ? Math.min(trade.shares, shares) : 0;
  const opens = shares - closes;
  if (opens === 0) return null;
  const held = trade === null ? 0 : trade.entry_price * trade.shares;
  let free = freeCash ?? basis.balance;
  if (closes > 0) free += (trade!.side === "long" ? 1 : -1) * (at - trade!.entry_price) * closes + (freeCash === null ? 0 : held);
  else if (freeCash === null) free -= held;
  const cost = opens * at;
  if (Math.round(cost * 100) <= Math.round(free * 100)) return null;
  return `Exceeds buying power · this order costs ${dollars(Math.ceil(cost))}, buying power is ${dollars(Math.max(0, Math.floor(free)))}`;
}

const money = (value: number): string => value.toFixed(2);
const sideWord = (side: TicketSide): string => (side === "buy" ? "Buy" : "Sell");

/** "Buy 100 AAPL · Limit 49.50": the order as the ticket will send it. */
export function ticketSummary(draft: TicketDraft, symbol: string): string {
  const option = typeOption(draft.type);
  const quantity = /^\d+$/.test(draft.shares.trim()) && Number(draft.shares) >= 1 ? Number(draft.shares).toLocaleString("en-US") : "—";
  const levels = [
    option.stop ? `stop ${price(draft.stopPrice) === null ? "—" : money(price(draft.stopPrice)!)}` : null,
    option.limit ? `limit ${price(draft.limitPrice) === null ? "—" : money(price(draft.limitPrice)!)}` : null,
  ].filter((part) => part !== null);
  return `${sideWord(draft.side)} ${quantity} ${symbol} · ${option.label}${levels.length ? ` · ${levels.join(" · ")}` : ""}`;
}

/** A working or finished order as one line: "Buy 10 · Limit 49.50", "Sell 5 · Stop-limit 51.00 / 51.20". */
export function orderLine(order: PracticeOrder): string {
  const kind = order.type === "limit" ? "Limit" : order.type === "stop" ? "Stop" : "Stop-limit";
  const levels = [order.stop_price, order.limit_price].filter((value): value is number => value !== null).map(money).join(" / ");
  return `${sideWord(order.side)} ${order.shares.toLocaleString("en-US")} · ${kind} ${levels}`;
}

/** What became of an order, in the words of the tape: "Working", "Filled at 49.50", "Cancelled · Not enough practice cash · $450 free". */
export function orderStatusText(order: PracticeOrder): string {
  if (order.status === "working") return order.triggered_at ? "Working · stop triggered" : "Working";
  if (order.status === "filled") return `Filled at ${order.fill_price === null ? "—" : money(order.fill_price)}`;
  return order.reason ? `Cancelled · ${order.reason}` : "Cancelled";
}
