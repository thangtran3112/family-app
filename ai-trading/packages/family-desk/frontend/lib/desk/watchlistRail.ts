// The list the left rail opens on (02l §b2): her first intraday list, else the first list, else null.
export function pickDefaultWatchlist<T extends { id: number; horizon: string }>(lists: ReadonlyArray<T>): T | null {
  return lists.find((list) => list.horizon === "intraday") ?? lists[0] ?? null;
}
