import { BriefSchema, ResearchSchema, TimelineSchema, ValuationSchema } from "../api/fundamentalSchemas.ts";
import { clientOf, deskPath, readInit, symbolPath, type RequestOptions } from "./api.ts";

// Research loaders (02n §c3 #12 to #15). `verdict` and the brief rows are empty until the Desk AI job exists (step 5).

export const loadBrief = (date?: string, options?: RequestOptions) =>
  clientOf(options)(deskPath("/research/brief", { date }), BriefSchema, readInit(options));

export const loadResearch = (symbol: string, options?: RequestOptions) =>
  clientOf(options)(deskPath(`/research/symbols/${symbolPath(symbol)}`), ResearchSchema, readInit(options));

export const loadValuation = (symbol: string, options?: RequestOptions) =>
  clientOf(options)(deskPath(`/research/symbols/${symbolPath(symbol)}/valuation`), ValuationSchema, readInit(options));

export type TimelineKind = "earnings" | "desk_ai" | "news" | "strategy" | "filing" | "macro" | "consensus";
export const loadTimeline = (symbol: string, filters: { kind?: TimelineKind; limit?: number; offset?: number } = {}, options?: RequestOptions) =>
  clientOf(options)(deskPath(`/research/symbols/${symbolPath(symbol)}/timeline`, filters), TimelineSchema, readInit(options));
