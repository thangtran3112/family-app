import { PRACTICE_COPY, practiceText } from "../desk/freshness.ts";
import type { HeldElsewhere } from "./daily.ts";

// A name held open elsewhere (another day, thread or standalone session): where it is, how to get there, and the refusal before an open that would be a 409.

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
