export type AssetType = "stock" | "future";

export function canonicalWatchlistSymbol(value: string, assetType: AssetType): string {
  let symbol = value.trim().toUpperCase();
  if (assetType === "future" && !symbol.startsWith("/")) symbol = `/${symbol}`;
  if (assetType === "stock" && symbol.startsWith("/")) {
    throw new Error("A futures symbol must use Future asset type.");
  }
  return symbol;
}

export function marketSymbolForItem(symbol: string, assetType: string): string | null {
  if (assetType !== "stock" && assetType !== "future") return null;
  try {
    return canonicalWatchlistSymbol(symbol, assetType);
  } catch {
    return null;
  }
}

export function watchlistItemDeletePath(watchlistId: number, storedSymbol: string): string {
  return `/api/desk/watchlists/${watchlistId}/items/${encodeURIComponent(storedSymbol)}`;
}
