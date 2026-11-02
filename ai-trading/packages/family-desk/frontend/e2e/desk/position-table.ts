import type { Locator } from "@playwright/test";

// The Portfolio tab's position table (`PositionTable`): one row per name, read by its column header ("Ticker", "Last", "Change", "Position",
// "Avg price", "Value", "Unrealized P/L", "Realized P/L", "Total P/L"). The table drops the columns that do not fit its pane, so a spec reads
// only the ones that never drop (Ticker, Last, Position, Avg price, Total P/L) unless it checks the width it runs at.

/** The row of one name in the position table inside `portfolio` (the Portfolio region, or the swing holds region). */
export const positionRow = (portfolio: Locator, symbol: string): Locator => portfolio.getByRole("row", { name: new RegExp(`\\b${symbol}\\b`) });

/** One name's cells by column header; a dropped column is not in the record. */
export async function positionCells(portfolio: Locator, symbol: string): Promise<Record<string, string>> {
  const heads = await portfolio.getByRole("columnheader").allTextContents();
  const cells = await positionRow(portfolio, symbol).getByRole("cell").allTextContents();
  return Object.fromEntries(heads.map((head, index) => [head.trim(), (cells[index] ?? "").trim()]));
}
