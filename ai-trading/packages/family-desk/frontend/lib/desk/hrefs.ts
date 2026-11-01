// One link builder per destination (design-component-system §3.12, §4.3). The symbol link is the exception: it depends on the mode,
// so SYMBOL_HREF[lane] stays in lib/lanes.ts (cutover ruling).

/** What a new alert strategy starts from: a symbol or a watchlist (`?source=`), a saved filter (`?from=`), or an alert to edit (`?edit=`). */
export type AlertNewSource = { symbol: string } | { watchlist: number } | { filter: number } | { edit: number };

/** `/alerts/new`, opened from a symbol, a list, a filter or an existing alert. A symbol is URL-encoded. */
export function alertNewHref(source?: AlertNewSource): string {
  if (source === undefined) return "/alerts/new";
  if ("symbol" in source) return `/alerts/new?source=symbol:${encodeURIComponent(source.symbol)}`;
  if ("watchlist" in source) return `/alerts/new?source=watchlist:${source.watchlist}`;
  if ("filter" in source) return `/alerts/new?from=filter:${source.filter}`;
  return `/alerts/new?edit=${source.edit}`;
}

/** A filter in the screener's editor (`View rule` for a built-in one, `Edit` for hers). */
export const filterHref = (id: number): string => `/screener/filters?id=${id}`;

/** A strategy in the builder. */
export const strategyHref = (id: number): string => `/strategies?id=${id}`;
