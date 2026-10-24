import { AlertOutSchema, AlertReadAllSchema, AlertsResponseSchema, MeSchema, StatusSchema, SymbolSearchResponseSchema } from "../api/schemas.ts";
import { clientOf, deskPath, jsonInit, readInit, symbolPath, type RequestOptions } from "./api.ts";

export const loadStatus = (options?: RequestOptions) => clientOf(options)(deskPath("/status"), StatusSchema, readInit(options));
export const loadMe = (options?: RequestOptions) => clientOf(options)(deskPath("/me"), MeSchema, readInit(options));

export const searchSymbols = (text: string, limit = 8, options?: RequestOptions) =>
  clientOf(options)(deskPath("/symbols/search", { q: text.trim(), limit }), SymbolSearchResponseSchema, readInit(options));

export type AlertInboxFilters = { unread?: boolean; symbol?: string; strategyId?: number; limit?: number; offset?: number };
export const loadAlertInbox = (filters: AlertInboxFilters = {}, options?: RequestOptions) =>
  clientOf(options)(
    deskPath("/alerts", { unread: filters.unread, symbol: filters.symbol, strategy_id: filters.strategyId, limit: filters.limit, offset: filters.offset }),
    AlertsResponseSchema,
    readInit(options),
  );

export const markAlertRead = (id: number, options?: RequestOptions) =>
  clientOf(options)(deskPath(`/alerts/${id}/read`), AlertOutSchema, jsonInit("POST", {}, options));
export const markAllAlertsRead = (options?: RequestOptions) =>
  clientOf(options)(deskPath("/alerts/read-all"), AlertReadAllSchema, jsonInit("POST", {}, options));

export { symbolPath };
