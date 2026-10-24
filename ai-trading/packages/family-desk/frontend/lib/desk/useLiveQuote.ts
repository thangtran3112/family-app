"use client";

import { useEffect, useState } from "react";
import { openQuoteStream, type Quote } from "../stream.ts";
import type { Connection } from "./freshness.ts";

export type LiveQuote = { quote: Quote | null; connection: Connection };

/**
 * Last price for one symbol from the shared quote connection (lib/stream.ts multiplexes subscribers).
 * A dropped connection reads as "reconnecting" while the last quote stays; the next quote clears it.
 */
export function useLiveQuote(symbol: string | null): LiveQuote {
  const [state, setState] = useState<{ symbol: string | null; quote: Quote | null; down: boolean }>({ symbol, quote: null, down: false });

  useEffect(() => {
    if (!symbol) return;
    return openQuoteStream(
      symbol,
      (quote) => setState({ symbol, quote, down: false }),
      () => setState((current) => ({ symbol, quote: current.symbol === symbol ? current.quote : null, down: true })),
    );
  }, [symbol]);

  // A quote for another symbol never shows (the symbol changed before the first new quote).
  const current = state.symbol === symbol ? state : { symbol, quote: null, down: false };
  return { quote: current.quote, connection: current.down ? "reconnecting" : "ok" };
}
