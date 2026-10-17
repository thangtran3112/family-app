export type TechnicalSelection = { symbol: string; timeframe: string };
export type TechnicalData<Bars, Technicals> = { bars: Bars; technicals: Technicals };

export function shouldStartTechnicalLoad(current: TechnicalSelection, next: TechnicalSelection): boolean {
  return current.symbol !== next.symbol || current.timeframe !== next.timeframe;
}

export function loadTechnicalData<Bars, Technicals>(
  symbol: string,
  timeframe: string,
  fetchers: {
    bars: (path: string) => Promise<Bars>;
    technicals: (path: string) => Promise<Technicals>;
  },
): Promise<TechnicalData<Bars, Technicals>> {
  const encodedSymbol = encodeURIComponent(symbol);
  const barsQuery = new URLSearchParams({ interval: timeframe, days: "3650", session: "regular" });
  const technicalsQuery = new URLSearchParams({ timeframe, days: "3650" });
  return Promise.all([
    fetchers.bars(`/api/desk/bars/${encodedSymbol}?${barsQuery.toString()}`),
    fetchers.technicals(`/api/desk/technicals/${encodedSymbol}?${technicalsQuery.toString()}`),
  ]).then(([bars, technicals]) => ({ bars, technicals }));
}
