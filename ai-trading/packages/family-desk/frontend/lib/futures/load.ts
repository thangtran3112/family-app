export type SymbolResponse = { symbol: string };

export type FuturesSnapshot<Bars extends SymbolResponse, Technicals extends SymbolResponse> = {
  symbol: string;
  bars: Bars;
  daily: Technicals;
  fourHour: Technicals;
};

export async function loadFuturesSnapshot<Bars extends SymbolResponse, Technicals extends SymbolResponse>(
  root: string,
  fetchBars: (path: string) => Promise<Bars>,
  fetchTechnicals: (path: string) => Promise<Technicals>,
): Promise<FuturesSnapshot<Bars, Technicals>> {
  const symbol = root.startsWith("/") ? root : `/${root}`;
  const encoded = encodeURIComponent(symbol);
  const [bars, daily, fourHour] = await Promise.all([
    fetchBars(`/api/desk/bars/${encoded}?interval=1d&days=3650`),
    fetchTechnicals(`/api/desk/technicals/${encoded}?timeframe=1d&days=3650`),
    fetchTechnicals(`/api/desk/technicals/${encoded}?timeframe=4h&days=3650`),
  ]);
  if (bars.symbol !== symbol || daily.symbol !== symbol || fourHour.symbol !== symbol) {
    throw new Error("Futures data response symbol did not match the request.");
  }
  return { symbol, bars, daily, fourHour };
}

export function snapshotForContract<Bars extends SymbolResponse, Technicals extends SymbolResponse>(
  snapshot: FuturesSnapshot<Bars, Technicals> | null,
  symbol: string,
): FuturesSnapshot<Bars, Technicals> | null {
  return snapshot?.symbol === symbol ? snapshot : null;
}
