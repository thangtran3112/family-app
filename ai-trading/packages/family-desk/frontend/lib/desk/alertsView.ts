import type { AlertLogRow, AlertStrategy } from "../api/schemas.ts";
import { DeskApiError } from "../api/client.ts";
import { describeCondition } from "../spec/describe.ts";
import { parseAlertSpec } from "../spec/parse.ts";
import { formatEtStamp } from "./format.ts";
import { channelLabel, FREQUENCY_LABEL, statusLabel } from "./labels.ts";
import type { AlertStrategyFilters } from "./alerts.ts";

// View logic for the alerts screen (D9, 02m §a3.7).
export type AlertsTab = "list" | "log";
export const CATEGORY_FILTERS = ["pattern", "indicator", "level", "screener"] as const;
export const STATUS_FILTERS = ["active", "paused", "expired", "draft"] as const;
export const SORTS = [
  { id: "last_fired", label: "Last fired" },
  { id: "name", label: "Name" },
  { id: "status", label: "Status" },
] as const;

export type AlertFilterState = { status: string; category: string; symbol: string; sort: "last_fired" | "name" | "status" };
export const defaultAlertFilters = (): AlertFilterState => ({ status: "", category: "", symbol: "", sort: "last_fired" });

/** The request filters for the current UI state; empty choices are left out. */
export function toQuery(state: AlertFilterState): AlertStrategyFilters {
  return {
    status: (STATUS_FILTERS as readonly string[]).includes(state.status) ? (state.status as AlertStrategyFilters["status"]) : undefined,
    category: (CATEGORY_FILTERS as readonly string[]).includes(state.category) ? (state.category as AlertStrategyFilters["category"]) : undefined,
    symbol: state.symbol.trim().toUpperCase() || undefined,
    sort: state.sort,
  };
}

/** "Watchlist · Day movers" */
export function sourceText(source: AlertStrategy["source"]): string {
  const kind = source.kind === "filter" ? "Screener" : source.kind === "watchlist" ? "Watchlist" : "Symbol";
  return `${kind} · ${source.label}`;
}

/** The trigger in plain words (the condition only; the full sentence is in the detail pane). */
export function triggerText(strategy: Pick<AlertStrategy, "spec">): string {
  const spec = parseAlertSpec(strategy.spec);
  return spec ? describeCondition(spec.when) : "Custom rule (see JSON)";
}

export const frequencyText = (strategy: Pick<AlertStrategy, "frequency" | "cooldown_minutes">): string =>
  `${FREQUENCY_LABEL[strategy.frequency] ?? strategy.frequency}${strategy.cooldown_minutes ? ` · ${strategy.cooldown_minutes} min cooldown` : ""}`;

export const channelsText = (channels: readonly string[]): string => channels.map(channelLabel).join(", ");

export const lastFiredText = (iso: string | null): string => (iso ? formatEtStamp(iso) : "Never fired");

/** Status word plus the reason for a pause. */
export const statusText = (strategy: Pick<AlertStrategy, "status" | "paused_reason">): string =>
  strategy.status === "paused" && strategy.paused_reason ? `Paused · ${strategy.paused_reason}` : statusLabel(strategy.status);

export type RowAction = "pause" | "resume" | "turn_on" | null;
/** Which button a strategy gets: active ones pause, paused ones resume, drafts turn on; expired ones none. */
export function actionFor(strategy: Pick<AlertStrategy, "status" | "stage">): RowAction {
  if (strategy.status === "active") return "pause";
  if (strategy.status === "paused") return "resume";
  if (strategy.status === "draft" || strategy.stage === "draft") return "turn_on";
  return null;
}

export const actionLabel = (action: Exclude<RowAction, null>): string => (action === "pause" ? "Pause" : action === "resume" ? "Resume" : "Turn on");

/** Plain words for a failed pause/resume/turn on: the API's own sentence for a 409, else a generic one. */
export function actionError(error: unknown): string {
  if (error instanceof DeskApiError && error.kind === "http" && error.detail && (error.status === 409 || error.status === 422)) return error.detail;
  return "Couldn't update the alert · Try again";
}

export const LOG_STATUSES = ["delivered", "held_quiet_hours", "no_channel", "failed"] as const;

export function logRowText(row: AlertLogRow): { when: string; what: string } {
  return { when: formatEtStamp(row.created_at), what: `${row.symbol ?? "—"} · ${row.strategy_name ?? "Alert"}` };
}
