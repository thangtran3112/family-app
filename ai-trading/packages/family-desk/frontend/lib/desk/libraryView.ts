import { StrategySpecV1Schema, type StrategySpecV1 } from "@ai-trading/contracts";
import type { LibraryEntry, LibraryItem } from "../api/schemas.ts";
import { formatEtStamp } from "./format.ts";
import { categoryLabel, channelLabel } from "./labels.ts";
import { describeCondition, describeSpec } from "../spec/describe.ts";

// View logic for the strategy library (D8, 02m §a3.6).
export const CATEGORY_ORDER = ["candlestick", "breakout", "trend", "volume", "futures"] as const;
export type CategoryFilter = "all" | (typeof CATEGORY_ORDER)[number];
export const LIBRARY_FOOTNOTE = "Pattern rules are fixed in v1";

export type CategoryRow = { id: CategoryFilter; label: string; count: number };

/** "All" plus the categories that have presets, in the board's order (Candlesticks · Breakouts · Trend · Volume · Futures). */
export function categoryRows(items: readonly LibraryItem[]): CategoryRow[] {
  const rows: CategoryRow[] = [{ id: "all", label: "All presets", count: items.length }];
  for (const category of CATEGORY_ORDER) {
    const count = items.filter((item) => item.category === category).length;
    if (count > 0) rows.push({ id: category, label: categoryLabel(category), count });
  }
  return rows;
}

export function filterPresets(items: readonly LibraryItem[], category: CategoryFilter, query: string): LibraryItem[] {
  const needle = query.trim().toLowerCase();
  return items.filter(
    (item) => (category === "all" || item.category === category) && (needle === "" || `${item.label} ${item.summary}`.toLowerCase().includes(needle)),
  );
}

export const attachLabel = (listName: string | null): string => (listName ? `Attach to ${listName} · alert only` : "Choose a watchlist to attach");

/** The template as an alert-only strategy: a paper order in the template never reaches the screen. */
export function alertOnlySpec(spec: unknown): StrategySpecV1 | null {
  const parsed = StrategySpecV1Schema.safeParse(spec);
  if (!parsed.success) return null;
  const { paperOrder: _paperOrder, ...alert } = parsed.data.then;
  void _paperOrder;
  return { ...parsed.data, then: alert };
}

export const plainEnglish = (spec: unknown): string | null => {
  const alertOnly = alertOnlySpec(spec);
  return alertOnly ? describeSpec(alertOnly) : null;
};
export const whenText = (spec: unknown): string | null => {
  const alertOnly = alertOnlySpec(spec);
  return alertOnly ? describeCondition(alertOnly.when) : null;
};

/** The defaults block: severity, channels, limits, in plain words. */
export function defaultsLines(defaults: LibraryEntry["defaults"]): string[] {
  const lines: string[] = [];
  const severity = defaults.severity;
  if (typeof severity === "string") lines.push(`Severity: ${severity}`);
  const channels = defaults.channels;
  if (Array.isArray(channels) && channels.length > 0) lines.push(`Channels: ${channels.map((channel) => channelLabel(String(channel))).join(", ")}`);
  const limits = defaults.limits;
  if (typeof limits === "object" && limits !== null) {
    const cooldown = (limits as Record<string, unknown>).cooldownMinutes;
    if (typeof cooldown === "number") lines.push(`Cooldown: ${cooldown} min`);
  }
  return lines;
}

/** "Hammer on MSFT · 15m · 2026-10-23 14:45 ET" for a real occurrence, null when the API found none. */
export function exampleCaption(label: string, example: LibraryEntry["example"]): string | null {
  return example ? `${label} on ${example.symbol} · ${example.timeframe} · ${formatEtStamp(example.bar_time)} ET` : null;
}

/** What the Attach button reports once the strategy exists. */
export const attachOutcome = (stage: "draft" | "alert_only", listName: string): string =>
  stage === "draft" ? `Attached to ${listName} as a draft · alerts start when live quotes are connected` : `Attached to ${listName} · alert only`;
