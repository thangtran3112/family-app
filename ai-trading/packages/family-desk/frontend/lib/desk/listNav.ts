// Keyboard helpers for the top bar's symbol search and popovers (02l §b6: keyboard shortcuts in tooltips).

/** Next active index in a list. Wraps at both ends; -1 when there is nothing to move through. */
export function moveActive(current: number, key: "ArrowDown" | "ArrowUp" | "Home" | "End", length: number): number {
  if (length === 0) return -1;
  if (key === "Home") return 0;
  if (key === "End") return length - 1;
  if (key === "ArrowDown") return current < 0 || current >= length - 1 ? 0 : current + 1;
  return current <= 0 ? length - 1 : current - 1;
}

/** Cmd+K on macOS, Ctrl+K elsewhere. */
export function isSearchShortcut(event: { key: string; metaKey: boolean; ctrlKey: boolean }): boolean {
  return (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";
}

export const symbolHref = (symbol: string): string => `/technicals?symbol=${encodeURIComponent(symbol)}#chart`;
