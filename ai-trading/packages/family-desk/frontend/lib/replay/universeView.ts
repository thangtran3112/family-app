import { EMPTY_VALUE, changeTone, formatCompact, formatPct, formatPrice, formatSignedPct, type Tone } from "../desk/format.ts";
import { PRACTICE_COPY, practiceText } from "../desk/freshness.ts";
import type { SwingSource, UniverseExcluded, UniversePreview, UniverseRow } from "./swingApi.ts";

// The swing setup's universe builder (02p c1, c3), view logic: the fill order and counts as displayed, source chips,
// warnings, the prep progress line, hand edits (add and remove) and the target size. Pure, so the node tests cover it.
// Every figure on a row is as of the close before Day 1 (`basis_day`).

export const MIN_UNIVERSE = 10;
export const MAX_UNIVERSE = 50;
/** The most hand edits one preview request carries (the API bound). */
export const MAX_EDITS = 50;
export const MAX_WATCHLISTS = 20;
export const MAX_FILTERS = 3;

/** Fill order: her watchlists, then manual adds, then filter matches, then liquidity. */
export const SOURCE_ORDER: readonly SwingSource[] = ["watchlist", "manual", "filter", "liquidity"];

const SOURCE_LABELS: Record<SwingSource, string> = { watchlist: "Watchlist", manual: "Manual", filter: "Filter", liquidity: "Liquidity" };

/** "Watchlist" / "Manual" / "Filter" / "Liquidity"; an unknown tag reads as it is. */
export const sourceLabel = (source: string): string => SOURCE_LABELS[source as SwingSource] ?? source;

/** The chip on a row: the filter's own name for a filter pick ("New 20-day high", "+1" with a second match), else the source. */
export function sourceChip(row: Pick<UniverseRow, "source" | "matched">): string {
  if (row.source !== "filter" || row.matched.length === 0) return sourceLabel(row.source);
  return row.matched.length === 1 ? row.matched[0]! : `${row.matched[0]} +${row.matched.length - 1}`;
}

/** The rows in fill order (stable inside a source), as the API already returns them. */
export function fillOrderRows<T extends Pick<UniverseRow, "source">>(rows: readonly T[]): T[] {
  const rank = (row: T) => {
    const index = SOURCE_ORDER.indexOf(row.source);
    return index === -1 ? SOURCE_ORDER.length : index;
  };
  return rows.map((row, index) => ({ row, index })).sort((a, b) => rank(a.row) - rank(b.row) || a.index - b.index).map(({ row }) => row);
}

/** What the contract's `universe` carries: the symbol and its source tag, in fill order. */
export const universeEntries = (rows: readonly Pick<UniverseRow, "symbol" | "source">[]): Array<{ symbol: string; source: SwingSource }> =>
  fillOrderRows(rows).map(({ symbol, source }) => ({ symbol, source }));

/** Counts by source tag, from rows or from a contract universe. */
export function mixOf(entries: readonly { source: string }[]): Partial<Record<SwingSource, number>> {
  const mix: Partial<Record<SwingSource, number>> = {};
  for (const entry of entries) {
    if ((SOURCE_ORDER as readonly string[]).includes(entry.source)) mix[entry.source as SwingSource] = (mix[entry.source as SwingSource] ?? 0) + 1;
  }
  return mix;
}

/**
 * "50 symbols · 9 watchlist · 2 manual · 6 New 20-day high · 33 liquidity · as of the close before Day 1 · survivors only".
 * A source with no symbols is left out. One picked filter lends its name to the count; several read "from filters".
 */
export function universeSummary(
  universe: { size: number; mix: Partial<Record<SwingSource, number>> | Record<string, number> },
  filterNames: readonly string[] = [],
): string {
  const mix = universe.mix as Record<string, number | undefined>;
  const filterLabel = filterNames.length === 1 ? filterNames[0]! : "from filters";
  const parts = [`${universe.size} ${universe.size === 1 ? "symbol" : "symbols"}`];
  for (const source of SOURCE_ORDER) {
    const count = mix[source] ?? 0;
    if (count > 0) parts.push(`${count} ${source === "filter" ? filterLabel : source}`);
  }
  parts.push(PRACTICE_COPY.swingBasis, PRACTICE_COPY.swingSurvivors);
  return parts.join(" · ");
}

/** The preview's counts as the same summary line. */
export const previewSummary = (preview: Pick<UniversePreview, "counts">, filterNames: readonly string[] = []): string =>
  universeSummary({ size: preview.counts.total, mix: preview.counts }, filterNames);

// -- rows -----------------------------------------------------------------------------------------------------

export type UniverseRowView = {
  symbol: string;
  source: SwingSource;
  /** "Watchlist", "Manual", "Filter", "Liquidity". */
  sourceLabel: string;
  chip: string;
  priorClose: string;
  /** "+4.1%" over the 20 sessions before Day 1. */
  chg20d: string;
  chg20dTone: Tone;
  /** "$12.9M" average dollar volume over 20 sessions. */
  dollarVolume: string;
  atr: string;
  matched: string | null;
  /** The API's plain words, for example "below floor". */
  warnings: string[];
};

export function universeRowView(row: UniverseRow): UniverseRowView {
  return {
    symbol: row.symbol,
    source: row.source,
    sourceLabel: sourceLabel(row.source),
    chip: sourceChip(row),
    priorClose: formatPrice(row.prior_close),
    chg20d: formatSignedPct(row.chg_20d_pct, 1),
    chg20dTone: changeTone(row.chg_20d_pct),
    dollarVolume: row.avg_dollar_volume_20d > 0 ? `$${formatCompact(row.avg_dollar_volume_20d)}` : EMPTY_VALUE,
    atr: formatPct(row.atr_pct_14, 1),
    matched: row.matched.length === 0 ? null : row.matched.join(" · "),
    warnings: row.warnings,
  };
}

/** Lines under the table for the symbols left out, grouped by the API's neutral reason (it names no date). */
export function excludedLines(excluded: readonly UniverseExcluded[]): string[] {
  const byReason = new Map<string, string[]>();
  for (const item of excluded) byReason.set(item.reason, [...(byReason.get(item.reason) ?? []), item.symbol]);
  return [...byReason].map(([reason, symbols]) =>
    practiceText("swingExcluded", { n: symbols.length, noun: symbols.length === 1 ? "symbol" : "symbols", reason, names: symbols.join(", ") }),
  );
}

// -- prep ------------------------------------------------------------------------------------------------------

/** True while the pool prep still fetches symbols: poll the preview again. */
export const isPreparing = (preview: Pick<UniversePreview, "state"> | null): boolean => preview?.state === "preparing";

/** "Preparing as-of data · 96 of 133 · watchlist and manual picks are ready", or "As-of data is ready". */
export function prepProgressText(preview: Pick<UniversePreview, "state" | "prep">): string {
  return preview.state === "ready" ? PRACTICE_COPY.swingPrepReady : practiceText("swingPrepProgress", { done: preview.prep.done, total: preview.prep.total });
}

/** Why `Start swing thread` is off, in plain words; null when the table is ready to start from. */
export function startBlocker(preview: Pick<UniversePreview, "state" | "prep" | "rows"> | null): string | null {
  if (preview === null) return PRACTICE_COPY.swingBuildFirst;
  if (preview.state === "preparing") return practiceText("swingWaitForData", { done: preview.prep.done, total: preview.prep.total });
  if (preview.rows.length < MIN_UNIVERSE) return practiceText("swingNeedMore", { min: MIN_UNIVERSE, n: preview.rows.length });
  return null;
}

// -- hand edits --------------------------------------------------------------------------------------------------

/** The adds and removes on top of her lists and fills; they go to the preview as `add` and `remove`. */
export type UniverseEdits = { add: string[]; remove: string[] };
export const noEdits = (): UniverseEdits => ({ add: [], remove: [] });
export const hasEdits = (edits: UniverseEdits): boolean => edits.add.length > 0 || edits.remove.length > 0;

export const SYMBOL_PATTERN = /^[A-Z][A-Z0-9.]{0,9}$/;

/** "  nvda " to "NVDA". */
export const normalizeSymbol = (raw: string): string => raw.trim().toUpperCase();

export type EditResult = { edits: UniverseEdits; problem: string | null };

/**
 * Adds a typed symbol. A removed symbol comes back by leaving `remove`; a symbol already on the list (`present`) or
 * already added is refused in plain words, and so is anything that is not a stock symbol. The API is the final judge.
 */
export function addSymbol(edits: UniverseEdits, raw: string, present: readonly string[] = []): EditResult {
  const symbol = normalizeSymbol(raw);
  if (!SYMBOL_PATTERN.test(symbol)) return { edits, problem: symbol === "" ? PRACTICE_COPY.swingTypeSymbol : practiceText("swingNotSymbol", { symbol }) };
  if (edits.remove.includes(symbol)) return { edits: { ...edits, remove: edits.remove.filter((item) => item !== symbol) }, problem: null };
  if (edits.add.includes(symbol) || present.includes(symbol)) return { edits, problem: practiceText("swingAlreadyListed", { symbol }) };
  if (edits.add.length >= MAX_EDITS) return { edits, problem: practiceText("swingTooManyEdits", { max: MAX_EDITS }) };
  return { edits: { ...edits, add: [...edits.add, symbol] }, problem: null };
}

/** Removes a symbol from the list: a hand add just goes away, any other pick is remembered in `remove`. */
export function removeSymbol(edits: UniverseEdits, raw: string): UniverseEdits {
  const symbol = normalizeSymbol(raw);
  if (edits.add.includes(symbol)) return { ...edits, add: edits.add.filter((item) => item !== symbol) };
  if (edits.remove.includes(symbol) || edits.remove.length >= MAX_EDITS) return edits;
  return { ...edits, remove: [...edits.remove, symbol] };
}

// -- target size -------------------------------------------------------------------------------------------------

/** The target size as a whole number from 10 to 50. */
export const clampTarget = (value: number): number => (Number.isFinite(value) ? Math.min(MAX_UNIVERSE, Math.max(MIN_UNIVERSE, Math.round(value))) : MAX_UNIVERSE);

/** A typed target; an empty or unreadable box reads as the default (50). */
export const parseTarget = (text: string): number => (text.trim() === "" ? MAX_UNIVERSE : clampTarget(Number(text.replaceAll(",", ""))));

/** Picks or drops a list id or filter id, up to `max` of them. */
export function toggleId(ids: readonly number[], id: number, max: number): number[] {
  if (ids.includes(id)) return ids.filter((item) => item !== id);
  return ids.length >= max ? [...ids] : [...ids, id];
}
