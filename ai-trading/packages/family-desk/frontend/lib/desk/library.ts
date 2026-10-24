import { AlertStrategySchema, LibraryEntrySchema, LibraryListSchema } from "../api/schemas.ts";
import { clientOf, deskPath, jsonInit, readInit, type RequestOptions } from "./api.ts";

export const loadLibrary = ({ category, q }: { category?: string; q?: string } = {}, options?: RequestOptions) =>
  clientOf(options)(deskPath("/library", { category, q }), LibraryListSchema, readInit(options));
export const loadLibraryEntry = (id: string, options?: RequestOptions) =>
  clientOf(options)(deskPath(`/library/${encodeURIComponent(id)}`), LibraryEntrySchema, readInit(options));
export const attachPreset = (
  id: string,
  body: { watchlist_id: number; channels?: string[]; severity?: string },
  options?: RequestOptions,
) => clientOf(options)(deskPath(`/library/${encodeURIComponent(id)}/attach`), AlertStrategySchema, jsonInit("POST", body, options));
