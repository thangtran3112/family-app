import { AccountOutSchema, HoldingsSchema, ImportResponseSchema, LotsSchema } from "../api/fundamentalSchemas.ts";
import { clientOf, deskPath, jsonInit, readInit, symbolPath, type RequestOptions } from "./api.ts";

// Holdings loaders (02n §c3 #2 to #5): the Flex import and the accounts. Nothing here reads an account number; the
// API never returns one.

export const loadHoldings = (accountId?: number, options?: RequestOptions) =>
  clientOf(options)(deskPath("/holdings", { account_id: accountId }), HoldingsSchema, readInit(options));

export const loadLots = (symbol: string, options?: RequestOptions) =>
  clientOf(options)(deskPath(`/holdings/${symbolPath(symbol)}/lots`), LotsSchema, readInit(options));

/** 202 with the running state; 409 when one ran in the last minute, 503 when the import is not set up, 404 for another user. */
export const startHoldingsImport = (options?: RequestOptions) =>
  clientOf(options)(deskPath("/holdings/import"), ImportResponseSchema, jsonInit("POST", {}, options));

export const patchAccount = (id: number, body: { label?: string; type?: "taxable" | "ira" | "roth" }, options?: RequestOptions) =>
  clientOf(options)(deskPath(`/accounts/${id}`), AccountOutSchema, jsonInit("PATCH", body, options));
