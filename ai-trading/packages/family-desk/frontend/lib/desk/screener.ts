import {
  ScreenerFilterDetailSchema,
  ScreenerFiltersSchema,
  ScreenerPreviewSchema,
  ScreenerResultsSchema,
  ScreenerUniverseSchema,
} from "../api/schemas.ts";
import { z } from "zod";
import { clientOf, deskPath, jsonInit, readInit, type RequestOptions } from "./api.ts";

export type ScreenerSession = "regular" | "extended";

export const loadFilters = (options?: RequestOptions) => clientOf(options)(deskPath("/screener/filters"), ScreenerFiltersSchema, readInit(options));
export const loadFilterDetail = (id: number, options?: RequestOptions) =>
  clientOf(options)(deskPath(`/screener/filters/${id}`), ScreenerFilterDetailSchema, readInit(options));
export const loadFilterResults = (id: number, session?: ScreenerSession, options?: RequestOptions) =>
  clientOf(options)(deskPath(`/screener/filters/${id}/results`, { session }), ScreenerResultsSchema, readInit(options));
export const loadUniverse = (options?: RequestOptions) => clientOf(options)(deskPath("/screener/universe"), ScreenerUniverseSchema, readInit(options));

/** Unsaved spec in, live match count out. 422 problems come back as 200 with `problems` (02m §a1). */
export const previewFilter = (spec: unknown, options?: RequestOptions) =>
  clientOf(options)(deskPath("/screener/preview"), ScreenerPreviewSchema, jsonInit("POST", { spec }, options));

/** Copy a seed or her own filter into an editable one, or create from a full spec. */
export const createFilter = (body: { copy_of: number } | { spec: unknown }, options?: RequestOptions) =>
  clientOf(options)(deskPath("/screener/filters"), ScreenerFilterDetailSchema, jsonInit("POST", body, options));
export const updateFilter = (id: number, spec: unknown, changeNote: string | null = null, options?: RequestOptions) =>
  clientOf(options)(deskPath(`/screener/filters/${id}`), ScreenerFilterDetailSchema, jsonInit("PUT", { spec, change_note: changeNote }, options));
export const deleteFilter = (id: number, options?: RequestOptions) =>
  clientOf(options)(deskPath(`/screener/filters/${id}`), z.undefined(), { method: "DELETE", signal: options?.signal });
