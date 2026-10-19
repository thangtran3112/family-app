export const WATCHLIST_CARD_TIMEFRAMES = ["5m", "15m", "1h", "1D", "1W"] as const;
export type WatchlistCardTimeframe = typeof WATCHLIST_CARD_TIMEFRAMES[number];

const technicalsIntervals: Record<WatchlistCardTimeframe, string> = {
  "5m": "5m",
  "15m": "15m",
  "1h": "1h",
  "1D": "1d",
  "1W": "1w",
};

export function selectCardTimeframe(current: WatchlistCardTimeframe, requested: string): WatchlistCardTimeframe {
  return WATCHLIST_CARD_TIMEFRAMES.find((timeframe) => timeframe === requested) ?? current;
}

export function technicalsTimeframe(timeframe: WatchlistCardTimeframe): string {
  return technicalsIntervals[timeframe];
}
