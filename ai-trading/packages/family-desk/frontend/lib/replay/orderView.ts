import { PRACTICE_COPY, practiceText } from "../desk/freshness.ts";
import type { HeldElsewhere } from "./daily.ts";

// The Order tab's name picker: the names of the open day (a day list's candidates, a swing board's rows), narrowed by what she types.

export type OrderName = { symbol: string; status: string; held: HeldElsewhere | null };

type Names = {
  candidates: readonly { symbol: string }[];
  sessions: readonly { symbol: string; has_open_trade: boolean }[];
  held_elsewhere: readonly HeldElsewhere[];
};

/** Where a name held elsewhere is open: the thread it belongs to, else a session of its own. */
export function heldWhere(held: HeldElsewhere): string {
  return held.thread_name ?? PRACTICE_COPY.dayHeldStandalone;
}

/** The page that ends a name held elsewhere: the day it belongs to (End day is on its Summary), or the standalone session's own page. */
export function heldHref(held: HeldElsewhere): string {
  return held.day_list_id === null ? `/practice/replay?id=${held.session_id}` : `/practice/day?id=${held.day_list_id}`;
}

/** The refusal shown before the open call when a name is held elsewhere: the open would be a 409. */
export function heldBlocked(held: HeldElsewhere): string {
  return practiceText("dayHeldBlocked", { symbol: held.symbol, where: heldWhere(held) });
}

/** Every name whose symbol contains `find` (case and spaces ignored), in the list's own order, with where the day stands on it. */
export function orderNames(list: Names, find: string): OrderName[] {
  const needle = find.trim().toUpperCase();
  const sessions = new Map(list.sessions.map((session) => [session.symbol, session]));
  const held = new Map(list.held_elsewhere.map((item) => [item.symbol, item]));
  return list.candidates
    .filter(({ symbol }) => symbol.toUpperCase().includes(needle))
    .map(({ symbol }) => {
      const elsewhere = held.get(symbol) ?? null;
      if (elsewhere !== null) return { symbol, status: practiceText("orderStatusElsewhere", { where: heldWhere(elsewhere) }), held: elsewhere };
      const session = sessions.get(symbol);
      return { symbol, status: session === undefined ? PRACTICE_COPY.orderStatusNone : session.has_open_trade ? PRACTICE_COPY.orderStatusHolding : PRACTICE_COPY.orderStatusOpened, held: null };
    });
}
