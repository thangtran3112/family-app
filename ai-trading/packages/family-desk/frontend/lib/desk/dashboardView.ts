import type { Dashboard } from "../api/schemas.ts";
import { changeTone, formatEtDay, formatPrice, formatSignedPct, type Tone } from "./format.ts";
import { COPY } from "./freshness.ts";
import { runOnLabel, timingLabel } from "./labels.ts";

// View models for the dashboard (D2): the API rows turned into display text once, in lib, so the
// components stay plain and every state is testable.

export type StripTile = {
  symbol: string;
  last: string;
  change: string;
  tone: Tone;
  unavailable: boolean;
  /** Futures tiles are read-only: no link, no actions (02m §e). */
  readOnly: boolean;
  note: string | null;
};

export function stripTiles(strip: Dashboard["market_strip"]): StripTile[] {
  return strip.map((tile) => {
    const readOnly = tile.symbol.startsWith("/");
    const unavailable = tile.stamp.freshness === "unavailable" || tile.last === null;
    return {
      symbol: tile.symbol,
      last: unavailable ? "—" : formatPrice(tile.last),
      change: unavailable ? "—" : formatSignedPct(tile.change_pct),
      tone: unavailable ? "flat" : changeTone(tile.change_pct),
      unavailable,
      readOnly,
      note: unavailable && readOnly ? COPY.futuresNotConnected : readOnly ? COPY.futuresReadOnly : null,
    };
  });
}

export type MatchCard = { id: number; name: string; count: string; whenLabel: string; top: string[]; empty: boolean };

export function matchCards(matches: Dashboard["screener_matches"]): MatchCard[] {
  return matches.map((match) => ({
    id: match.filter_id,
    name: match.name,
    count: `${match.matches_total} of ${match.scanned}`,
    whenLabel: runOnLabel(match.run_on),
    top: match.top.slice(0, 3),
    empty: match.matches_total === 0,
  }));
}

export type EventRow = { symbol: string; day: string; timing: string };
export function eventRows(events: Dashboard["events"]): EventRow[] {
  return [...events]
    .sort((a, b) => a.date.localeCompare(b.date) || a.symbol.localeCompare(b.symbol))
    .map((event) => ({ symbol: event.symbol, day: formatEtDay(event.date), timing: `Earnings · ${timingLabel(event.timing)}` }));
}

/** Signals are newest first from the API; the panel shows at most this many. */
export const SIGNAL_LIMIT = 20;
