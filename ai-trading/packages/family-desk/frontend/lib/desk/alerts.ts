import { z } from "zod";
import {
  AlertLogSchema,
  AlertStrategiesSchema,
  AlertStrategyDetailSchema,
  AlertStrategyFiresSchema,
  AlertStrategySchema,
  AlertStrategyValidateSchema,
} from "../api/schemas.ts";
import { clientOf, deskPath, jsonInit, readInit, type RequestOptions } from "./api.ts";

export type AlertStrategyFilters = {
  status?: "active" | "paused" | "expired" | "draft";
  category?: "pattern" | "indicator" | "level" | "screener";
  symbol?: string;
  watchlistId?: number;
  sort?: "name" | "last_fired" | "status";
};

export const loadAlertStrategies = (filters: AlertStrategyFilters = {}, options?: RequestOptions) =>
  clientOf(options)(
    deskPath("/alert-strategies", { status: filters.status, category: filters.category, symbol: filters.symbol, watchlist_id: filters.watchlistId, sort: filters.sort }),
    AlertStrategiesSchema,
    readInit(options),
  );
export const loadAlertStrategy = (id: number, options?: RequestOptions) =>
  clientOf(options)(deskPath(`/alert-strategies/${id}`), AlertStrategyDetailSchema, readInit(options));
export const loadAlertFires = (id: number, limit = 10, options?: RequestOptions) =>
  clientOf(options)(deskPath(`/alert-strategies/${id}/fires`, { limit }), AlertStrategyFiresSchema, readInit(options));

/** Live validation. Problems come back as a 200 body, so a bad spec is never an exception here. */
export const validateAlertStrategy = (spec: unknown, options?: RequestOptions) =>
  clientOf(options)(deskPath("/alert-strategies/validate"), AlertStrategyValidateSchema, jsonInit("POST", { spec }, options));
export const createAlertStrategy = (spec: unknown, saveAs: "draft" | "on" = "draft", options?: RequestOptions) =>
  clientOf(options)(deskPath("/alert-strategies"), AlertStrategySchema, jsonInit("POST", { spec, save_as: saveAs }, options));
export const updateAlertStrategy = (id: number, spec: unknown, changeNote: string | null = null, options?: RequestOptions) =>
  clientOf(options)(deskPath(`/alert-strategies/${id}`), AlertStrategyDetailSchema, jsonInit("PUT", { spec, change_note: changeNote }, options));
export const pauseAlertStrategy = (id: number, options?: RequestOptions) =>
  clientOf(options)(deskPath(`/alert-strategies/${id}/pause`), AlertStrategySchema, jsonInit("POST", { reason: "user" }, options));
export const resumeAlertStrategy = (id: number, options?: RequestOptions) =>
  clientOf(options)(deskPath(`/alert-strategies/${id}/resume`), AlertStrategySchema, jsonInit("POST", {}, options));
export const deleteAlertStrategy = (id: number, options?: RequestOptions) =>
  clientOf(options)(deskPath(`/alert-strategies/${id}`), z.undefined(), { method: "DELETE", signal: options?.signal });

export type AlertLogFilters = { status?: string; symbol?: string; limit?: number; offset?: number };
export const loadAlertLog = (filters: AlertLogFilters = {}, options?: RequestOptions) =>
  clientOf(options)(deskPath("/alerts/log", { status: filters.status, symbol: filters.symbol, limit: filters.limit, offset: filters.offset }), AlertLogSchema, readInit(options));
