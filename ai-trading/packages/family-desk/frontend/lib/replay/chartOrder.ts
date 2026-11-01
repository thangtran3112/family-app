import type { TicketDraft, TicketSide, TicketType } from "./ticket.ts";

// Click-to-order from the replay chart (owner directive 2026-11-01): a click on a price offers Buy and Sell at that price, the
// way a broker's chart does. Pure: the click's price and the last print in, the ticket draft out. The draft goes through the
// ordinary ticket path (`buildTicket`, the server's cash check), so a chart order is never a second way to place one.

/** How close (px) the cursor must be to a level's line to name it, and to snap a click onto it. */
export const LEVEL_HIT_PX = 6;

const cents = (price: number): number => Math.round(price * 100);

/** A click's price in whole cents: the server refuses a fraction of a cent. */
export const roundToCents = (price: number): number => cents(price) / 100;

/** The level whose line is nearest `y` (px from the top of the pane), within `LEVEL_HIT_PX`; null when none is that close. `toY` is the price scale's own conversion. */
export function nearestLevel<T extends { price: number | null }>(levels: readonly T[], y: number, toY: (price: number) => number | null): T | null {
  let found: T | null = null;
  let best = LEVEL_HIT_PX + 1;
  for (const level of levels) {
    const at = level.price === null ? null : toY(level.price);
    if (at === null) continue;
    const distance = Math.abs(at - y);
    if (distance < best) {
      best = distance;
      found = level;
    }
  }
  return found;
}

/**
 * The order type a click at `price` means for `side` against the last print, the way a broker reads a chart click: a buy
 * below the market waits as a limit and above it as a stop (a breakout); a sell mirrors it. At the last print it is a market
 * order. The server refuses a stop on the wrong side of the last price, so a stop is only ever chosen on the right one.
 */
export function chartOrderType(side: TicketSide, price: number, last: number): Extract<TicketType, "market" | "limit" | "stop"> {
  const diff = cents(price) - cents(last);
  if (diff === 0) return "market";
  return (diff < 0) === (side === "buy") ? "limit" : "stop";
}

/** The ticket as the chart click sets it: the ticket's own quantity, with the type and the one price that type takes. */
export function chartOrderDraft(ticket: TicketDraft, side: TicketSide, price: number, last: number): TicketDraft {
  const type = chartOrderType(side, price, last);
  const text = price.toFixed(2);
  return { ...ticket, side, type, limitPrice: type === "limit" ? text : "", stopPrice: type === "stop" ? text : "" };
}

/** The button text: "Buy limit 184.00", "Sell stop 183.50", "Buy market". */
export function chartOrderLabel(side: TicketSide, price: number, last: number): string {
  const type = chartOrderType(side, price, last);
  return `${side === "buy" ? "Buy" : "Sell"} ${type}${type === "market" ? "" : ` ${price.toFixed(2)}`}`;
}
