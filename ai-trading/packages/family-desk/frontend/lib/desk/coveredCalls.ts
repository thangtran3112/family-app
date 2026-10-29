import { CandidatesSchema, CoverageSchema, IncomeSchema, RollSchema, ShortCallsSchema } from "../api/fundamentalSchemas.ts";
import { clientOf, deskPath, readInit, type RequestOptions } from "./api.ts";

// Covered-call loaders (02n §c3 #6 to #10). The numbers are the engine's; the screens format them and never recompute.

export const loadCoverage = (options?: RequestOptions) => clientOf(options)(deskPath("/covered-calls/coverage"), CoverageSchema, readInit(options));

export const loadCandidates = (symbol: string, accountId?: number, options?: RequestOptions) =>
  clientOf(options)(deskPath("/covered-calls/candidates", { symbol, account_id: accountId }), CandidatesSchema, readInit(options));

export const loadShortCalls = (options?: RequestOptions) => clientOf(options)(deskPath("/covered-calls/short-calls"), ShortCallsSchema, readInit(options));

export const loadRoll = (callId: number, options?: RequestOptions) =>
  clientOf(options)(deskPath(`/covered-calls/short-calls/${callId}/roll`), RollSchema, readInit(options));

export const loadIncome = (months = 12, options?: RequestOptions) => clientOf(options)(deskPath("/covered-calls/income", { months }), IncomeSchema, readInit(options));
