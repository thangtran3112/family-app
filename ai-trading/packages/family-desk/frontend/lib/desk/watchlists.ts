import { z } from "zod";
import { WatchlistItemOutSchema, WatchlistItemsSchema, WatchlistOutSchema, WatchlistsResponseSchema, WatchlistTableSchema } from "../api/schemas.ts";
import { clientOf, deskPath, jsonInit, readInit, symbolPath, type RequestOptions } from "./api.ts";

export const loadWatchlists = (options?: RequestOptions) => clientOf(options)(deskPath("/watchlists"), WatchlistsResponseSchema, readInit(options));
export const loadWatchlistTable = (id: number, options?: RequestOptions) =>
  clientOf(options)(deskPath(`/watchlists/${id}/table`), WatchlistTableSchema, readInit(options));
export const loadWatchlistItems = (id: number, options?: RequestOptions) =>
  clientOf(options)(deskPath(`/watchlists/${id}/items`), WatchlistItemsSchema, readInit(options));

export const createWatchlist = (name: string, horizon: "intraday" | "swing" | "long_term" = "intraday", options?: RequestOptions) =>
  clientOf(options)(deskPath("/watchlists"), WatchlistOutSchema, jsonInit("POST", { name, horizon }, options));
export const renameWatchlist = (id: number, name: string, options?: RequestOptions) =>
  clientOf(options)(deskPath(`/watchlists/${id}`), WatchlistOutSchema, jsonInit("PATCH", { name }, options));
export const deleteWatchlist = (id: number, options?: RequestOptions) =>
  clientOf(options)(deskPath(`/watchlists/${id}`), z.undefined(), { method: "DELETE", signal: options?.signal });
export const addWatchlistItem = (id: number, symbol: string, assetType: "stock" | "future" = "stock", options?: RequestOptions) =>
  clientOf(options)(deskPath(`/watchlists/${id}/items`), WatchlistItemOutSchema, jsonInit("POST", { symbol, asset_type: assetType }, options));
export const removeWatchlistItem = (id: number, symbol: string, options?: RequestOptions) =>
  clientOf(options)(deskPath(`/watchlists/${id}/items/${symbolPath(symbol)}`), z.undefined(), { method: "DELETE", signal: options?.signal });
export const reorderWatchlist = (id: number, symbols: string[], options?: RequestOptions) =>
  clientOf(options)(deskPath(`/watchlists/${id}/order`), WatchlistItemsSchema, jsonInit("PUT", { symbols }, options));
