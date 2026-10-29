import { DeskApiError } from "../api/client.ts";
import type { ImportState } from "../api/fundamentalSchemas.ts";
import { COPY } from "./freshness.ts";
import { startHoldingsImport } from "./holdings.ts";
import type { RequestOptions } from "./api.ts";

// "Import now" (02n §c3 #4), shared by Holdings and Settings. The route answers 202 with the running state; 409 when an
// import ran in the last minute, 503 when the Flex import is not set up, 404 when the import belongs to another user.

export type ImportResult = { ok: true; state: ImportState } | { ok: false; text: string };

/** The words for a failed import request; engineering detail never reaches the screen. */
export function importErrorText(error: unknown): string {
  if (error instanceof DeskApiError && error.kind === "http") {
    if (error.status === 409) return "An import ran in the last minute · try again shortly";
    if (error.status === 503) return COPY.holdingsNotConnected;
    if (error.status === 404) return COPY.holdingsNone;
  }
  return COPY.holdingsImportFailedNoData;
}

export async function runHoldingsImport(options?: RequestOptions): Promise<ImportResult> {
  try {
    return { ok: true, state: (await startHoldingsImport(options)).import };
  } catch (error) {
    return { ok: false, text: importErrorText(error) };
  }
}
