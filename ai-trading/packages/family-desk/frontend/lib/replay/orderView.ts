import { PRACTICE_COPY } from "../desk/freshness.ts";

// The Order tab's name picker: the names of the open day (a day list's candidates, a swing board's rows), narrowed by what she types.

export type OrderName = { symbol: string; status: string };

type Names = {
  candidates: readonly { symbol: string }[];
  sessions: readonly { symbol: string; has_open_trade: boolean }[];
};

/** Every name whose symbol contains `find` (case and spaces ignored), in the list's own order, with where the day stands on it. */
export function orderNames(list: Names, find: string): OrderName[] {
  const needle = find.trim().toUpperCase();
  const sessions = new Map(list.sessions.map((session) => [session.symbol, session]));
  return list.candidates
    .filter(({ symbol }) => symbol.toUpperCase().includes(needle))
    .map(({ symbol }) => {
      const session = sessions.get(symbol);
      return { symbol, status: session === undefined ? "" : session.has_open_trade ? PRACTICE_COPY.orderStatusHolding : PRACTICE_COPY.orderStatusOpened };
    });
}
