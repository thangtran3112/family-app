export type AssetType = "stock" | "future";

export function canonicalWatchlistSymbol(value: string, assetType: AssetType): string {
  let symbol = value.trim().toUpperCase();
  if (assetType === "future" && !symbol.startsWith("/")) symbol = `/${symbol}`;
  if (assetType === "stock" && symbol.startsWith("/")) {
    throw new Error("A futures symbol must use Future asset type.");
  }
  return symbol;
}
