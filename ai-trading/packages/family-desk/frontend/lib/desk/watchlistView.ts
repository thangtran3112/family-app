import type { Tone } from "../../components/ui/tone.ts";
import { DeskApiError } from "../api/client.ts";
import type { WatchlistTableRow } from "../api/schemas.ts";
import { formatEtTime } from "./format.ts";

// View and manage-mode logic for the watchlist table (D7, 02m §a3.5).

/** "Hammer 15m · 10:15 AM" for a pattern that fired, "ORB armed" for a strategy still watching. */
export function tagLine(tags: WatchlistTableRow["tags"]): string[] {
  return tags.map((tag) => (tag.kind === "pattern" && tag.at ? `${tag.label} · ${formatEtTime(tag.at)}` : tag.label));
}

/** Chips a watchlist row shows before the rest fold into "+N": three long ones pushed the table to 982 px inside 808. */
export const STRATEGY_CHIPS_SHOWN = 2;

/** A chip is its text and a tone: a strategy still watching is `warn` (amber), a pattern that fired is `neutral`. */
export type StrategyChip = { text: string; tone: Tone };

/** The first chips for a row's Strategy cell, and the ones folded into its "+N" chip. */
export function strategyChips(tags: WatchlistTableRow["tags"], max: number = STRATEGY_CHIPS_SHOWN): { shown: StrategyChip[]; hidden: StrategyChip[] } {
  const lines = tagLine(tags);
  const chips = tags.map((tag, index) => ({ text: lines[index]!, tone: tag.kind === "armed" ? ("warn" as const) : ("neutral" as const) }));
  return { shown: chips.slice(0, max), hidden: chips.slice(max) };
}

export const NAME_MAX = 80;

/** NFKC-normalised and trimmed, the same rule the API applies (1 to 80 characters). */
export const normalizeListName = (name: string): string => name.normalize("NFKC").trim();

/** A plain message for a list name that cannot be used, or null. `current` is the name being renamed. */
export function validateListName(name: string, existing: readonly string[], current?: string): string | null {
  const value = normalizeListName(name);
  if (value.length === 0) return "Give the list a name";
  if (value.length > NAME_MAX) return `Use ${NAME_MAX} characters or fewer`;
  const taken = existing.some((other) => other !== current && other.toLowerCase() === value.toLowerCase());
  return taken ? `You already have a list called “${value}”` : null;
}

/** Move one symbol by `delta` places (-1 up, +1 down); out of range leaves the order alone. */
export function moveSymbol(symbols: readonly string[], from: number, delta: number): string[] {
  const to = from + delta;
  if (from < 0 || from >= symbols.length || to < 0 || to >= symbols.length) return [...symbols];
  const next = [...symbols];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}

/** The order as `PUT /order` wants it, or null while nothing changed (so Save stays off). */
export const orderChange = (original: readonly string[], draft: readonly string[]): string[] | null =>
  original.length === draft.length && original.every((symbol, index) => symbol === draft[index]) ? null : [...draft];

/** What went wrong with a manage-mode request, in words she can act on. */
export function manageErrorMessage(error: unknown, action: "rename" | "delete" | "add" | "remove" | "reorder"): string {
  if (error instanceof DeskApiError && error.kind === "http") {
    if (error.detail && (error.status === 409 || error.status === 422)) return error.detail;
    if (error.status === 409 && action === "rename") return "You already have a list with that name";
    if (error.status === 409 && action === "delete") return "An alert strategy still uses this list. Pause or remove it first";
    if (error.status === 422 && action === "reorder") return "The list changed. Reload it and try again";
  }
  return "Couldn't save that change · Try again";
}
