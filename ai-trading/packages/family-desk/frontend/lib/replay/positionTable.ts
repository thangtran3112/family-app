import { EMPTY_VALUE, changeToneAt, formatEtDateClock, formatPrice, type Tone } from "../desk/format.ts";
import { PRACTICE_COPY, practiceText } from "../desk/freshness.ts";
import { formatSignedUsd } from "../desk/mask.ts";
import type { PortfolioOrder, PortfolioPosition } from "./portfolio.ts";

// The Portfolio tab's position table, read like a broker's list of what she holds now (ADR-0025): each open position across the thread's
// lanes with the price AT the thread clock `T`, its gain or loss, how long it has been held and the orders working on it. Pure, so
// node --test covers it. Every dollar figure is SIMULATED. A figure the payload does not hold is a dash, never a computed stand-in. The
// table holds open positions only, so its P/L is the unrealized one; a closed trade's result is in Trades, not here.

/** An open position, in the numbers `GET /threads/{id}/portfolio` holds. */
export type PositionRow = {
  key: string;
  /** The lane the position lives in: its chart, and where an exit is placed. */
  sessionId: number;
  symbol: string;
  side: "long" | "short";
  /** Unsigned. */
  shares: number;
  avg: number;
  /** The price at `T`. */
  price: number;
  /** When that price is from, set only when it is old enough to say so ("last price 3d 4h old"); a name that never had a price says it is carried at cost. */
  priceNote: string | null;
  unrealized: number;
  /** "3d 4h". */
  heldFor: string;
  /** Working orders on this name. */
  orders: number;
  /** "Stop crossed Fri 2026-10-23 · 10:21 AM ET": the stop line is an alert and never exits. */
  stop: string | null;
};

/** A cell's text and the tone of its sign. `tone` null is plain text; "flat" is muted (a dash, a zero). */
export type Cell = { text: string; tone: Tone | null };

export type PositionCells = {
  side: Cell;
  shares: Cell;
  avg: Cell;
  price: Cell;
  unrealized: Cell;
  heldFor: Cell;
  orders: Cell;
};

const plain = (text: string): Cell => ({ text, tone: null });
const dash: Cell = { text: EMPTY_VALUE, tone: "flat" };
const signedUsd = (value: number): Cell => ({ text: formatSignedUsd(value, { cents: true }), tone: changeToneAt(value, 2) });

const MINUTE = 60;
const HOUR = 3600;
const DAY = 86_400;

/**
 * Elapsed thread time as two units: "3d 4h", "4h 12m", "12m", "under a minute". It is elapsed calendar time between the entry and `T`
 * (a position held over a weekend reads "3d"), never a count of trading days. Zero units are left out ("2d", not "2d 0h").
 */
export function heldForText(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < MINUTE) return PRACTICE_COPY.portfolioHeldUnderMinute;
  const days = Math.floor(seconds / DAY);
  const hours = Math.floor((seconds % DAY) / HOUR);
  const minutes = Math.floor((seconds % HOUR) / MINUTE);
  const parts = days > 0 ? [`${days}d`, hours > 0 ? `${hours}h` : ""] : hours > 0 ? [`${hours}h`, minutes > 0 ? `${minutes}m` : ""] : [`${minutes}m`];
  return parts.filter(Boolean).join(" ");
}

/** A price older than this at `T` is flagged: the name had no print since (a halt, a holiday, a weekend, a gap in the data). */
export const STALE_PRICE_S = 4 * HOUR;

export function priceNote(position: Pick<PortfolioPosition, "price_at" | "price_age_s">): string | null {
  if (position.price_at === null) return PRACTICE_COPY.portfolioNoPrice;
  if (position.price_age_s === null || position.price_age_s < STALE_PRICE_S) return null;
  return practiceText("portfolioPriceAge", { age: heldForText(position.price_age_s) });
}

export const stopCrossedText = (iso: string): string => practiceText("portfolioStopCrossed", { when: formatEtDateClock(iso, { seconds: false }) });

/** One row per open position; `orders` are the thread's working orders, counted per name. */
export function positionRow(position: PortfolioPosition, orders: readonly Pick<PortfolioOrder, "symbol" | "status">[] = []): PositionRow {
  return {
    key: `${position.session_id}`,
    sessionId: position.session_id,
    symbol: position.symbol,
    side: position.side,
    shares: position.shares,
    avg: position.avg_cost,
    price: position.price,
    priceNote: priceNote(position),
    unrealized: position.unrealized_usd,
    heldFor: heldForText(position.held_for_s),
    orders: orders.filter((order) => order.symbol === position.symbol && order.status === "working").length,
    stop: position.stop_hit_at === null ? null : stopCrossedText(position.stop_hit_at),
  };
}

export const positionRows = (positions: readonly PortfolioPosition[], orders: readonly PortfolioOrder[]): PositionRow[] => positions.map((position) => positionRow(position, orders));

/** The cells of one row. Shares are signed ("300", "−100"): long positive, short negative. */
export function positionCells(row: PositionRow): PositionCells {
  return {
    side: plain(row.side === "short" ? PRACTICE_COPY.portfolioSideShort : PRACTICE_COPY.portfolioSideLong),
    shares: plain(row.side === "short" ? `−${row.shares.toLocaleString("en-US")}` : row.shares.toLocaleString("en-US")),
    avg: plain(formatPrice(row.avg)),
    price: plain(formatPrice(row.price)),
    unrealized: signedUsd(row.unrealized),
    heldFor: plain(row.heldFor),
    orders: row.orders === 0 ? dash : plain(String(row.orders)),
  };
}

/** The open P/L over every row, to the cent: the table's footer. */
export const openPnl = (rows: readonly Pick<PositionRow, "unrealized">[]): number => Math.round(rows.reduce((sum, row) => sum + row.unrealized, 0) * 100) / 100;

/** "No open positions" / "1 open position" / "3 open positions". */
export function positionsCountText(count: number): string {
  return count === 0 ? PRACTICE_COPY.threadPositionsNone : count === 1 ? PRACTICE_COPY.threadPositionsOne : practiceText("threadPositionsMany", { count });
}

// ---- working orders -------------------------------------------------------------------------------------------------

export type OrderRow = {
  key: string;
  symbol: string;
  /** "Sell stop", "Buy limit", "Buy stop limit". */
  kind: string;
  shares: string;
  /** The limit and/or stop price, "98.00" or "98.00 / 97.50" (stop / limit). */
  price: string;
  /** "GTC" or "Day". */
  tif: string;
  /** "until Fri 2026-10-23 · 8:00 PM ET" for a Day order; "—" for GTC. */
  expires: string;
  reduceOnly: boolean;
};

const TYPE_WORD = { limit: "limit", stop: "stop", stop_limit: "stop limit" } as const;

export function orderRows(orders: readonly PortfolioOrder[]): OrderRow[] {
  return orders
    .filter((order) => order.status === "working")
    .map((order) => ({
      key: String(order.id),
      symbol: order.symbol,
      kind: `${order.side === "buy" ? "Buy" : "Sell"} ${TYPE_WORD[order.type]}`,
      shares: order.shares.toLocaleString("en-US"),
      price: [order.stop_price, order.limit_price].filter((price): price is number => price !== null).map((price) => formatPrice(price)).join(" / ") || EMPTY_VALUE,
      tif: order.tif === "day" ? PRACTICE_COPY.portfolioTifDay : PRACTICE_COPY.portfolioTifGtc,
      expires: order.tif === "day" && order.expires_at !== null ? practiceText("portfolioOrderUntil", { when: formatEtDateClock(order.expires_at, { seconds: false }) }) : EMPTY_VALUE,
      reduceOnly: order.reduce_only,
    }));
}
