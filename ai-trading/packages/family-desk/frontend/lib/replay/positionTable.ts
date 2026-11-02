import { EMPTY_VALUE, changeToneAt, formatPrice, formatSignedPct, type Tone } from "../desk/format.ts";
import { formatSignedUsd } from "../desk/mask.ts";
import type { PortfolioRow } from "./dayView.ts";
import { stopCrossedText } from "./dayView.ts";
import type { Hold } from "./schemas.ts";
import { daysHeldText, holdStopText } from "./swing.ts";
import { formatBalance } from "./threadView.ts";

// The Portfolio tab's position table, read like a broker's (Interactive Brokers: Last, Change, Position, Avg price, Value, P&L).
// One row model for both threads: a day thread's names (the day list) and a swing thread's carried holds. Pure, so node --test covers
// it. Every dollar figure is SIMULATED. A figure the payload does not hold is a dash, never a computed stand-in.

/** A name's position, in the numbers each mode's payload holds. `null` is "the payload has no such number". */
export type PositionRow = {
  key: string;
  symbol: string;
  /** null: flat (no open position). */
  side: "long" | "short" | null;
  /** Unsigned; null when flat. */
  shares: number | null;
  /** The mark at the thread clock; null when flat. */
  last: number | null;
  /** The close before the mark's session; null when the payload has none (a swing hold carries no prior close). */
  priorClose: number | null;
  /** The average price the open position was built at; null when flat. */
  avg: number | null;
  unrealized: number | null;
  /** Closed trades' P/L; null when nothing has been sold or closed. */
  realized: number | null;
  /** "Day 3 of hold"; swing only. */
  held: string | null;
  /** Day only: the name the chart is on, and one behind the thread clock. */
  current: boolean;
  behind: boolean;
  /** "Stop crossed 10:21": the stop paused play on this position. */
  stop: string | null;
};

/** A cell's text and the tone of its sign. `tone` null is plain text; "flat" is muted (a dash, a zero, "Flat"). */
export type Cell = { text: string; tone: Tone | null };

export type PositionCells = {
  last: Cell;
  change: Cell;
  changePct: Cell;
  position: Cell;
  avg: Cell;
  value: Cell;
  unrealized: Cell;
  realized: Cell;
  total: Cell;
};

const dash: Cell = { text: EMPTY_VALUE, tone: "flat" };
const plain = (text: string): Cell => ({ text, tone: null });
const signedUsd = (value: number | null): Cell => (value === null ? dash : { text: formatSignedUsd(value, { cents: true }), tone: changeToneAt(value, 2) });
const price = (value: number | null): Cell => (value === null ? dash : plain(formatPrice(value)));

/** The cells of one row. Position is signed shares ("300", "−100"); value is that position at the mark, so a short is negative. */
export function positionCells(row: PositionRow): PositionCells {
  const held = row.side !== null && row.shares !== null;
  const signed = !held ? null : row.side === "short" ? -row.shares! : row.shares!;
  const change = row.last !== null && row.priorClose !== null && row.priorClose > 0 ? row.last - row.priorClose : null;
  const changePct = change === null ? null : (100 * change) / row.priorClose!;
  const total = row.realized === null && row.unrealized === null ? null : (row.realized ?? 0) + (row.unrealized ?? 0);
  return {
    last: price(row.last),
    change: signedUsd(change),
    changePct: changePct === null ? dash : { text: formatSignedPct(changePct), tone: changeToneAt(changePct, 2) },
    position: signed === null ? { text: "Flat", tone: "flat" } : plain(signed < 0 ? `−${(-signed).toLocaleString("en-US")}` : signed.toLocaleString("en-US")),
    avg: price(row.avg),
    value: signed === null || row.last === null ? dash : plain(formatBalance(signed * row.last)),
    unrealized: signedUsd(row.unrealized),
    realized: signedUsd(row.realized),
    total: signedUsd(total),
  };
}

/** A day-list name. Realized shows once the name has a closed trade; the prior close comes from the list's own candidates. */
export const dayPositionRow = (row: PortfolioRow): PositionRow => ({
  key: row.symbol,
  symbol: row.symbol,
  side: row.side,
  shares: row.position?.shares ?? null,
  last: row.position?.last_price ?? null,
  priorClose: row.priorClose,
  avg: row.position?.entry_price ?? null,
  unrealized: row.unrealized,
  realized: row.trades > 0 ? row.realized : null,
  held: null,
  current: row.current,
  behind: row.behind,
  stop: row.stopHitAt === null ? null : stopCrossedText(row.stopHitAt),
});

/** An open swing hold, marked at its last finished close (`last_close`). It has no prior close and nothing realized yet. */
export const swingPositionRow = (hold: Hold): PositionRow => ({
  key: String(hold.id),
  symbol: hold.symbol,
  side: hold.side,
  shares: hold.shares,
  last: hold.last_close,
  priorClose: null,
  avg: hold.entry_price,
  unrealized: hold.unrealized_usd,
  realized: null,
  held: daysHeldText(hold.days_held),
  current: false,
  behind: false,
  stop: hold.stop_hit === "yes" ? holdStopText(hold) : null,
});
