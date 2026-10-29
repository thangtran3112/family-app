import type { ImportState, Rating } from "../api/fundamentalSchemas.ts";
import { COPY, holdingsFreshText, holdingsImportFailedText } from "./freshness.ts";

// Small view helpers every Fundamental screen shares (02n §b3): the import line and the Desk AI rating words.

export type ImportTone = "ok" | "busy" | "problem" | "empty";
export type ImportLine = { text: string; tone: ImportTone };

/** The one line that says what the holdings are: fresh, importing, failed, not connected, or none for this user. */
export function importLine(state: ImportState): ImportLine {
  switch (state.state) {
    case "ok": {
      const base = state.statement_date ? holdingsFreshText(state.statement_date) : "Holdings imported · IBKR Flex";
      return { text: state.lots > 0 ? `${base} · ${state.lots} ${state.lots === 1 ? "lot" : "lots"}` : base, tone: "ok" };
    }
    case "running":
      return { text: COPY.holdingsImporting, tone: "busy" };
    case "failed":
      return { text: holdingsImportFailedText(state.statement_date), tone: "problem" };
    case "not_configured":
      return { text: COPY.holdingsNotConnected, tone: "empty" };
    case "none":
      return { text: COPY.holdingsNone, tone: "empty" };
  }
}

/** True when holdings rows may exist (a good import, or a failed one that still has the older statement). */
export const hasHoldingsData = (state: ImportState): boolean => state.state === "ok" || (state.state === "failed" && state.statement_date !== null);

const RATING_TEXT: Record<Rating, string> = { buy: "Buy", hold: "Hold", sell: "Sell" };
export const ratingText = (rating: Rating): string => RATING_TEXT[rating];
