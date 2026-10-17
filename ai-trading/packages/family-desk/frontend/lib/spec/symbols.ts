export function symbolsFromDraft(draft: string): string[] {
  return draft.split(",").map((symbol) => symbol.trim());
}

export function symbolsToDraft(symbols: readonly string[]): string {
  return symbols.join(",");
}
