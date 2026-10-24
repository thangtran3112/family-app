import { BarsSchema, MarkersSchema, SignalsResponseSchema, TechnicalsSchema } from "../api/schemas.ts";
import { clientOf, deskPath, readInit, symbolPath, type RequestOptions } from "./api.ts";

export type ChartSession = "regular" | "extended";

export const loadBars = (symbol: string, interval: string, { days = 5, session = "regular" as ChartSession } = {}, options?: RequestOptions) =>
  clientOf(options)(deskPath(`/bars/${symbolPath(symbol)}`, { interval, days, session }), BarsSchema, readInit(options));

export const loadTechnicals = (symbol: string, timeframe: string, days = 3650, options?: RequestOptions) =>
  clientOf(options)(deskPath(`/technicals/${symbolPath(symbol)}`, { timeframe, days }), TechnicalsSchema, readInit(options));

export const loadMarkers = (
  symbol: string,
  timeframe: string,
  { from, to, allPatterns }: { from?: string; to?: string; allPatterns?: boolean } = {},
  options?: RequestOptions,
) =>
  clientOf(options)(
    deskPath(`/charts/${symbolPath(symbol)}/markers`, { timeframe, from, to, all_patterns: allPatterns ? true : undefined }),
    MarkersSchema,
    readInit(options),
  );

export const loadSignals = ({ symbol, since, limit = 50 }: { symbol?: string; since?: string; limit?: number } = {}, options?: RequestOptions) =>
  clientOf(options)(deskPath("/signals", { symbol, since, limit }), SignalsResponseSchema, readInit(options));
