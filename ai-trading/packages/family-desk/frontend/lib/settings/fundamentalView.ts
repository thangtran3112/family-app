import type { ImportState } from "../api/fundamentalSchemas.ts";
import type { DeskApiProblem } from "../api/client.ts";
import { formatEtDay, formatEtTimeZone, EMPTY_VALUE } from "../desk/format.ts";
import {
  COVERED_CALL_DEFAULTS, COVERED_CALL_KEYS, coveredCallProblems, readCoveredCallSettings, type CoveredCallSettings, type FieldProblems,
} from "./fundamental.ts";
import type { SettingsRecord } from "./schema.ts";

// View helpers for the Fundamental Settings cards (02n §b3 FD11): account names, the import line's detail, the scan
// filter drafts. Pure, so the cards stay plain and every state is testable.

// ---- Accounts ----
export const ACCOUNT_LABEL_MAX = 40;
export const ACCOUNT_SAVE_ERROR = "Couldn't save this account · try again";
export const ACCOUNT_TYPE_OPTIONS = [
  { value: "taxable", label: "Taxable" },
  { value: "ira", label: "IRA" },
  { value: "roth", label: "Roth" },
] as const;

/** A name is trimmed, not empty and at most 40 characters. */
export function validateAccountLabel(text: string): { ok: true; label: string } | { ok: false; message: string } {
  const label = text.trim();
  if (label === "") return { ok: false, message: "Enter a name" };
  if (label.length > ACCOUNT_LABEL_MAX) return { ok: false, message: `Use ${ACCOUNT_LABEL_MAX} characters or fewer` };
  return { ok: true, label };
}

/** The server's own words for a 422, or the plain line. */
export const accountProblemText = (problems: readonly DeskApiProblem[]): string => problems[0]?.message ?? ACCOUNT_SAVE_ERROR;

// ---- Holdings import ----
export const IMPORT_SOURCE_TEXT = "IBKR Flex";
/** Waits (ms) before each re-read of the holdings after an import starts: the statement arrives in the background. */
export const IMPORT_REREAD_DELAYS_MS: readonly number[] = [2_000, 5_000, 10_000];

/** "Statement Fri 2026-10-23 · imported Sat 2026-10-24 5:15 AM ET", or "No import yet". */
export function lastImportText(state: Pick<ImportState, "statement_date" | "imported_at">): string {
  if (!state.statement_date && !state.imported_at) return "No import yet";
  const parts = [state.statement_date ? `Statement ${formatEtDay(state.statement_date)}` : null];
  if (state.imported_at) parts.push(`imported ${formatEtDay(state.imported_at)} ${formatEtTimeZone(state.imported_at)}`);
  return parts.filter((part): part is string => part !== null && part !== EMPTY_VALUE).join(" · ");
}

// ---- Covered-call scan filters ----
export type ScanDraft = Record<keyof CoveredCallSettings, string>;

export const SCAN_FIELDS: ReadonlyArray<{ key: keyof CoveredCallSettings; label: string; step: string }> = [
  { key: "min_dte", label: "Shortest expiry (days)", step: "1" },
  { key: "max_dte", label: "Longest expiry (days)", step: "1" },
  { key: "min_delta", label: "Lowest delta", step: "0.01" },
  { key: "max_delta", label: "Highest delta", step: "0.01" },
  { key: "min_open_interest", label: "Fewest open contracts", step: "1" },
  { key: "max_spread_pct", label: "Widest spread (% of mid price)", step: "0.5" },
  { key: "min_bid", label: "Lowest bid ($ per share)", step: "0.01" },
  { key: "cap_pct", label: "Cover cap (% of shares)", step: "1" },
];

export const scanDraftOf = (values: CoveredCallSettings): ScanDraft =>
  Object.fromEntries(COVERED_CALL_KEYS.map((key) => [key, String(values[key])])) as ScanDraft;

export const scanDraftFromSettings = (settings: SettingsRecord): ScanDraft => scanDraftOf(readCoveredCallSettings(settings));
export const scanDefaultsDraft = (): ScanDraft => scanDraftOf(COVERED_CALL_DEFAULTS);

/** A typed value as a number; empty or unreadable text is null (the problem check names it). */
const toNumber = (text: string): number | null => {
  if (text.trim() === "") return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
};

export const scanValuesOfDraft = (draft: ScanDraft): Record<keyof CoveredCallSettings, number | null> =>
  Object.fromEntries(COVERED_CALL_KEYS.map((key) => [key, toNumber(draft[key])])) as Record<keyof CoveredCallSettings, number | null>;

export const scanProblemsOfDraft = (draft: ScanDraft): FieldProblems => coveredCallProblems(scanValuesOfDraft(draft));

/** The values to save: only call this on a draft with no problems. */
export const scanSettingsOfDraft = (draft: ScanDraft): CoveredCallSettings => scanValuesOfDraft(draft) as CoveredCallSettings;

export const scanDraftChanged = (draft: ScanDraft, saved: ScanDraft): boolean => COVERED_CALL_KEYS.some((key) => draft[key].trim() !== saved[key]);

/** A server problem path like `covered_calls.max_dte` as the field it names; others are ignored. */
export function serverProblemsToFields(problems: readonly DeskApiProblem[]): FieldProblems {
  const fields: FieldProblems = {};
  for (const { path, message } of problems) {
    const key = path.replace(/^covered_calls\./, "") as keyof CoveredCallSettings;
    if (path.startsWith("covered_calls.") && (COVERED_CALL_KEYS as readonly string[]).includes(key)) fields[key] = message;
  }
  return fields;
}

// ---- Fundamental alert templates (gated: nothing here reads the alert routes) ----
export const ALERT_TEMPLATES = [
  { id: "covered_call_income", title: "Covered-call income", note: "A scan finds a call worth selling on a holding." },
  { id: "short_call_risk", title: "Short-call risk", note: "An open short call nears its strike or an event before expiry." },
  { id: "ai_daily_view", title: "Desk AI daily view", note: "A Desk AI rating, target or confidence change on a holding." },
] as const;
