import { PATTERN_IDS, type Condition } from "@ai-trading/contracts";
import type { AlertStrategySpecV1 } from "@ai-trading/contracts/alert-strategy";
import type { Problem } from "../api/schemas.ts";
import { COPY, type AlertsRuntimeState } from "./freshness.ts";
import { operatorLabel } from "../spec/labels.ts";
import { symbolsFromText, type ConditionMode } from "./filterForm.ts";
import { operandFor } from "./operands.ts";
import { previewInterval } from "./screenerView.ts";

// The alert setup form (D10, 02m §a3.7): four steps (Source, Condition, Trigger, Deliver) that build an
// `AlertStrategySpecV1`. Inbox is always the first, locked channel; there is never a paper order.
type RunOn = AlertStrategySpecV1["watch"]["runOn"];
export type SourceKind = "symbol" | "watchlist" | "filter";

export type AlertForm = {
  name: string;
  sourceKind: SourceKind;
  /** One ticker or several separated by commas or spaces. */
  symbol: string;
  watchlist: string;
  filter: string;
  mode: ConditionMode;
  rows: Condition[];
  runOn: RunOn;
  session: "regular" | "extended";
  frequency: "once" | "once_per_bar" | "every_time";
  cooldownMinutes: string;
  expiresOn: string;
  telegram: boolean;
  slack: boolean;
  severity: "info" | "opportunity" | "risk";
  message: string;
};

export const DEFAULT_MESSAGE = "{symbol} {close} {time}";

export const defaultAlertForm = (): AlertForm => ({
  name: "",
  sourceKind: "symbol",
  symbol: "",
  watchlist: "",
  filter: "",
  mode: "all",
  rows: [{ op: "crosses_above", left: { series: "close" }, right: { series: "vwap" } }],
  runOn: "bar_close_15m",
  session: "regular",
  frequency: "once_per_bar",
  cooldownMinutes: "",
  expiresOn: "",
  telegram: false,
  slack: false,
  severity: "opportunity",
  message: DEFAULT_MESSAGE,
});

export type SourcePrefill = { kind: "symbol"; symbol: string } | { kind: "watchlist"; id: number } | { kind: "filter"; id: number };

/** `?source=symbol:NVDA`, `?source=watchlist:1` or `?from=filter:3` (02m §c1). */
export function parsePrefill(params: { source: string | null; from: string | null }): SourcePrefill | null {
  const raw = params.source ?? params.from;
  if (!raw) return null;
  const separator = raw.indexOf(":");
  if (separator < 0) return null;
  const kind = raw.slice(0, separator);
  const value = raw.slice(separator + 1).trim();
  if (kind === "symbol" && /^\/?[A-Za-z][A-Za-z0-9.]{0,9}$/.test(value)) return { kind, symbol: value.toUpperCase() };
  const id = Number(value);
  if ((kind === "watchlist" || kind === "filter") && Number.isInteger(id) && id > 0) return { kind, id };
  return null;
}

/** The form with its source filled from a prefill; a watchlist or filter id resolves to its name. */
export function applyPrefill(
  form: AlertForm,
  prefill: SourcePrefill | null,
  lists: ReadonlyArray<{ id: number; name: string }>,
  filters: ReadonlyArray<{ id: number; name: string }>,
): AlertForm {
  if (!prefill) return form;
  if (prefill.kind === "symbol") return { ...form, sourceKind: "symbol", symbol: prefill.symbol };
  if (prefill.kind === "watchlist") return { ...form, sourceKind: "watchlist", watchlist: lists.find((list) => list.id === prefill.id)?.name ?? form.watchlist };
  return { ...form, sourceKind: "filter", filter: filters.find((filter) => filter.id === prefill.id)?.name ?? form.filter };
}

export function alertFormFromSpec(spec: AlertStrategySpecV1): AlertForm {
  const universe = spec.watch.universe;
  const when = spec.when;
  const alert = spec.then.alert;
  return {
    ...defaultAlertForm(),
    name: spec.name,
    sourceKind: "symbols" in universe ? "symbol" : "watchlist" in universe ? "watchlist" : "filter",
    symbol: "symbols" in universe ? universe.symbols.join(", ") : "",
    watchlist: "watchlist" in universe ? universe.watchlist : "",
    filter: "filter" in universe ? universe.filter : "",
    mode: "any" in when ? "any" : "all",
    rows: "all" in when ? [...when.all] : "any" in when ? [...when.any] : [when],
    runOn: spec.watch.runOn,
    session: spec.watch.session,
    frequency: alert.frequency ?? "once_per_bar",
    cooldownMinutes: spec.limits?.cooldownMinutes === undefined ? "" : String(spec.limits.cooldownMinutes),
    expiresOn: alert.expiresOn ?? "",
    telegram: alert.channels.includes("telegram"),
    slack: alert.channels.includes("slack"),
    severity: alert.severity ?? "opportunity",
    message: alert.message ?? "",
  };
}

const sourceName = (form: AlertForm): string =>
  form.sourceKind === "symbol" ? symbolsFromText(form.symbol).join(" ") || "Symbol" : form.sourceKind === "watchlist" ? form.watchlist || "Watchlist" : form.filter || "Filter";

/** Used when she leaves the name empty. */
export const nameFor = (form: AlertForm): string => (form.name.trim() || `${sourceName(form)} alert`).slice(0, 80);

export function alertFormToSpec(form: AlertForm): Record<string, unknown> {
  const universe =
    form.sourceKind === "symbol" ? { symbols: symbolsFromText(form.symbol) }
    : form.sourceKind === "watchlist" ? { watchlist: form.watchlist }
    : { filter: form.filter };
  const when: Condition = form.rows.length === 1 ? form.rows[0]! : form.mode === "all" ? { all: form.rows } : { any: form.rows };
  const alert: Record<string, unknown> = {
    channels: ["inbox", ...(form.telegram ? ["telegram"] : []), ...(form.slack ? ["slack"] : [])],
    severity: form.severity,
    frequency: form.frequency,
  };
  if (form.expiresOn.trim()) alert.expiresOn = form.expiresOn.trim();
  if (form.message.trim()) alert.message = form.message.trim();
  const spec: Record<string, unknown> = {
    schemaVersion: 1,
    name: nameFor(form),
    watch: { universe, session: form.session, runOn: form.runOn },
    when,
    then: { alert },
  };
  const cooldown = form.cooldownMinutes.trim();
  if (cooldown) spec.limits = { cooldownMinutes: Number(cooldown) };
  return spec;
}

export const isAlertFormDirty = (original: AlertForm, draft: AlertForm): boolean => JSON.stringify(alertFormToSpec(original)) !== JSON.stringify(alertFormToSpec(draft));

// Operators: the TradingView set mapped to the contract, plus "pattern detected" (02l D10).
/** Alerts list the crossings first. Every comparison reads as in lib/spec/labels.ts; a pattern is the one operator that is not a comparison. */
const ALERT_COMPARE_ORDER = ["crosses_above", "crosses_below", "gt", "gte", "lt", "lte", "within_pct"] as const;
export const ALERT_OPERATORS = [...ALERT_COMPARE_ORDER.map((id) => ({ id, label: operatorLabel(id) })), { id: "pattern" as const, label: "a pattern appears" }];
export type AlertOperatorId = (typeof ALERT_OPERATORS)[number]["id"];

export function operatorOf(condition: Condition): AlertOperatorId | null {
  return "op" in condition && ALERT_OPERATORS.some((operator) => operator.id === condition.op) ? (condition.op as AlertOperatorId) : null;
}

/** Switch a row to another operator, keeping its operands where the new operator has them. */
export function withOperator(condition: Condition, id: AlertOperatorId): Condition {
  if (id === "pattern") return { op: "pattern", pattern: "hammer" };
  const left = "left" in condition ? condition.left : { series: "close" as const };
  const right = "right" in condition ? condition.right : operandFor({ id: "value", value: 0 });
  if (id === "within_pct") return { op: "within_pct", left, right, pct: "pct" in condition ? condition.pct : 1 };
  return { op: id, left, right };
}

export const PATTERN_OPTIONS = PATTERN_IDS.map((id) => ({ id, label: id.replaceAll("_", " ").replace(/^\w/, (c) => c.toUpperCase()) }));

export type MiniChartModel = { symbol: string | null; level: number | null; levelLabel: string | null; patternLabel: string | null; interval: "15m" | "1d" };

/** What the right-hand mini chart shows: the first resolved symbol, a number the condition compares with, or the pattern. */
export function miniChartModel(form: AlertForm, resolvedSymbols: readonly string[]): MiniChartModel {
  // Only a symbol the live check resolved (after typing stops): a half-typed ticker never triggers a chart request.
  const symbol = resolvedSymbols[0] ?? null;
  const priceSeries = new Set(["open", "high", "low", "close"]);
  let level: number | null = null;
  let patternLabel: string | null = null;
  for (const row of form.rows) {
    if ("op" in row && row.op === "pattern") patternLabel ??= PATTERN_OPTIONS.find((option) => option.id === row.pattern)?.label ?? null;
    else if ("op" in row && "left" in row) {
      if ("series" in row.left && priceSeries.has(row.left.series) && "value" in row.right) level ??= row.right.value;
      else if ("series" in row.right && priceSeries.has(row.right.series) && "value" in row.left) level ??= row.left.value;
    }
  }
  return { symbol, level, levelLabel: level === null ? null : `Alert level ${level}`, patternLabel, interval: previewInterval(form.runOn) };
}

export type TurnOn = { enabled: boolean; reason: string | null };
/** `Turn on` stays disabled until the alert runtime is on (02m §b5 item 6). */
export const turnOnState = (runtime: AlertsRuntimeState | null): TurnOn =>
  runtime === null || runtime === "not_started" ? { enabled: false, reason: COPY.alertsNotStarted } : { enabled: true, reason: null };

export type Step = "source" | "condition" | "trigger" | "deliver" | "other";
export function stepOf(path: string): Step {
  if (path === "name" || path.startsWith("watch.universe")) return "source";
  if (path.startsWith("when")) return "condition";
  if (path === "watch.runOn" || path === "watch.session" || path.startsWith("limits") || path.endsWith("frequency") || path.endsWith("expiresOn")) return "trigger";
  if (path.startsWith("then")) return "deliver";
  return "other";
}

export function groupProblems(problems: readonly Problem[]): Record<Step, Problem[]> {
  const groups: Record<Step, Problem[]> = { source: [], condition: [], trigger: [], deliver: [], other: [] };
  for (const problem of problems) groups[stepOf(problem.path)].push(problem);
  return groups;
}

