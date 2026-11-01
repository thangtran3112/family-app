import type { ImportState, Rating } from "../api/fundamentalSchemas.ts";
import type { Tone } from "../../components/ui/tone.ts";
import { COPY, holdingsFreshText, holdingsImportFailedText } from "./freshness.ts";

// Small view helpers every Fundamental screen shares (02n §b3): the import line and the Desk AI rating words.

/** up = a good import, warn = the import failed, neutral = importing, not connected or nothing yet. */
export type ImportLine = { text: string; tone: Tone };

/** The one line that says what the holdings are: fresh, importing, failed, not connected, or none for this user. */
export function importLine(state: ImportState): ImportLine {
  switch (state.state) {
    case "ok": {
      const base = state.statement_date ? holdingsFreshText(state.statement_date) : "Holdings imported · IBKR Flex";
      return { text: state.lots > 0 ? `${base} · ${state.lots} ${state.lots === 1 ? "lot" : "lots"}` : base, tone: "up" };
    }
    case "running":
      return { text: COPY.holdingsImporting, tone: "neutral" };
    case "failed":
      return { text: holdingsImportFailedText(state.statement_date), tone: "warn" };
    case "not_configured":
      return { text: COPY.holdingsNotConnected, tone: "neutral" };
    case "none":
      return { text: COPY.holdingsNone, tone: "neutral" };
  }
}

/** True when holdings rows may exist (a good import, or a failed one that still has the older statement). */
export const hasHoldingsData = (state: ImportState): boolean => state.state === "ok" || (state.state === "failed" && state.statement_date !== null);

const RATING_TEXT: Record<Rating, string> = { buy: "Buy", hold: "Hold", sell: "Sell" };
export const ratingText = (rating: Rating): string => RATING_TEXT[rating];

/** The not-connected sentence split so its setup step can be a link to Settings; null for every other line. */
export function setupLinkParts(text: string): { lead: string; link: string; href: string } | null {
  if (text !== COPY.holdingsNotConnected) return null;
  const link = "set up the IBKR import in Settings";
  return { lead: text.slice(0, text.length - link.length), link, href: "/settings" };
}
