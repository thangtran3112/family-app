import type { Condition, Operand } from "@ai-trading/contracts";
import type { FilterStrategySpecV1 } from "@ai-trading/contracts/filter-strategy-spec-v1";
import type { Problem } from "../api/schemas.ts";
import { operandFor } from "./operands.ts";

// The filter editor's form model (D6, 02k §4). The form keeps typed-in text for numbers so a half-typed
// value is not lost; `formToSpec` builds the plain object the API validates. Server problems (422 and the
// preview's `problems`) carry dotted paths that `problemsFor` matches back to a field.
type RunOn = FilterStrategySpecV1["watch"]["runOn"];
export type ConditionMode = "all" | "any";

export type FilterForm = {
  name: string;
  universe: "market" | "watchlist" | "symbols";
  watchlist: string;
  symbols: string;
  /** null = not specified (stocks and ETFs). */
  assetTypes: Array<"stock" | "etf"> | null;
  minPrice: string;
  minAvgVolume: string;
  avgVolumeDays: string;
  session: "regular" | "extended";
  runOn: RunOn;
  mode: ConditionMode;
  rows: Condition[];
  rankEnabled: boolean;
  rankBy: Operand;
  rankOrder: "desc" | "asc";
  maxResults: string;
};

const text = (value: number | undefined) => (value === undefined ? "" : String(value));

export function specToForm(spec: FilterStrategySpecV1): FilterForm {
  const universe = spec.watch.universe;
  const when = spec.when;
  const mode: ConditionMode = "any" in when ? "any" : "all";
  const rows = "all" in when ? [...when.all] : "any" in when ? [...when.any] : [when];
  return {
    name: spec.name,
    universe: "market" in universe ? "market" : "watchlist" in universe ? "watchlist" : "symbols",
    watchlist: "watchlist" in universe ? universe.watchlist : "",
    symbols: "symbols" in universe ? universe.symbols.join(", ") : "",
    assetTypes: spec.assetTypes ? [...spec.assetTypes] : null,
    minPrice: text(spec.liquidity?.minPrice),
    minAvgVolume: text(spec.liquidity?.minAvgVolume),
    avgVolumeDays: text(spec.liquidity?.avgVolumeDays),
    session: spec.watch.session,
    runOn: spec.watch.runOn,
    mode,
    rows,
    rankEnabled: spec.rank !== undefined,
    rankBy: spec.rank?.by ?? operandFor({ id: "rvol", params: {} }),
    rankOrder: spec.rank?.order ?? "desc",
    maxResults: String(spec.maxResults),
  };
}

const num = (value: string): number | undefined => {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
};

export const symbolsFromText = (value: string): string[] =>
  value.split(/[\s,]+/).map((symbol) => symbol.trim().toUpperCase()).filter(Boolean);

/** The spec the API validates. Never throws: a bad number stays NaN (JSON null) and the server says why. */
export function formToSpec(form: FilterForm): Record<string, unknown> {
  const universe =
    form.universe === "market" ? { market: "us_equities" }
    : form.universe === "watchlist" ? { watchlist: form.watchlist }
    : { symbols: symbolsFromText(form.symbols) };
  const liquidity: Record<string, number> = {};
  for (const [key, value] of [["minPrice", form.minPrice], ["minAvgVolume", form.minAvgVolume], ["avgVolumeDays", form.avgVolumeDays]] as const) {
    const parsed = num(value);
    if (parsed !== undefined) liquidity[key] = parsed;
  }
  const when: Condition = form.rows.length === 1 ? form.rows[0]! : form.mode === "all" ? { all: form.rows } : { any: form.rows };
  const spec: Record<string, unknown> = {
    schemaVersion: 1,
    name: form.name,
    watch: { universe, session: form.session, runOn: form.runOn },
  };
  if (form.assetTypes) spec.assetTypes = form.assetTypes;
  if (Object.keys(liquidity).length > 0) spec.liquidity = liquidity;
  spec.when = when;
  if (form.rankEnabled) spec.rank = { by: form.rankBy, order: form.rankOrder };
  spec.maxResults = num(form.maxResults) ?? Number.NaN;
  return spec;
}

/** Unsaved changes: the form no longer builds the spec it was opened with. */
export const isDirty = (original: FilterForm, draft: FilterForm): boolean => JSON.stringify(formToSpec(original)) !== JSON.stringify(formToSpec(draft));

export const newRow = (): Condition => ({ op: "gte", left: operandFor({ id: "rvol", params: {} }), right: { value: 2 } });

export const addRow = (form: FilterForm): FilterForm => ({ ...form, rows: [...form.rows, newRow()] });
export const removeRow = (form: FilterForm, index: number): FilterForm => ({ ...form, rows: form.rows.filter((_, position) => position !== index) });
export const updateRow = (form: FilterForm, index: number, row: Condition): FilterForm => ({ ...form, rows: form.rows.map((existing, position) => (position === index ? row : existing)) });

export type RowKind = "compare" | "within_pct" | "static";
/** Rows the editor can edit field by field; anything else (nested groups, patterns, time windows) is read-only text. */
export function rowKind(condition: Condition): RowKind {
  if ("op" in condition && condition.op === "within_pct") return "within_pct";
  if ("op" in condition && ["gt", "gte", "lt", "lte", "crosses_above", "crosses_below"].includes(condition.op)) return "compare";
  return "static";
}

export const OPERATORS = [
  { op: "gt", label: "is greater than" },
  { op: "gte", label: "is at least" },
  { op: "lt", label: "is less than" },
  { op: "lte", label: "is at most" },
  { op: "crosses_above", label: "crosses above" },
  { op: "crosses_below", label: "crosses below" },
  { op: "within_pct", label: "is within % of" },
] as const;

/** Problems under a dotted path prefix (`watch.runOn`, `when.all.1`); a single-row `when` has no group index. */
export function problemsFor(problems: readonly Problem[], prefix: string): Problem[] {
  return problems.filter((problem) => problem.path === prefix || problem.path.startsWith(`${prefix}.`));
}

export function problemsForRow(problems: readonly Problem[], form: Pick<FilterForm, "mode" | "rows">, index: number): Problem[] {
  return form.rows.length === 1 ? problemsFor(problems, "when") : problemsFor(problems, `when.${form.mode}.${index}`);
}

