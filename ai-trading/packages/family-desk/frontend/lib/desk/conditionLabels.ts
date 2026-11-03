import type { Condition, Operand } from "@ai-trading/contracts";
import type { FilterForm } from "./filterForm.ts";
import { choiceOf, operandDef, type OperandDef } from "./operands.ts";
import { fieldLabel } from "./problems.ts";

/**
 * The summary names of one operand's number boxes, by spec path: `when.left.lookbackDays` reads "Condition · Metric · Days" and `rank.by.lookbackDays`
 * reads "Rank by · Days", because the picker labels that box "Days" (the kit's `ParamDef.label`), where `paramLabel` alone would say "Lookback (days)"
 * (D-205). `path` is where the operand sits in the spec; `fieldLabel(path)` names the picker. Every place that renders an `OperandPicker` words its
 * summary through here, so the box and its line read one label. An operand outside `defs`, or a number, has no boxes to name.
 */
export function operandParamLabels(operand: Operand, path: string, defs: readonly OperandDef[]): Record<string, string> {
  const choice = choiceOf(operand, defs);
  const def = choice && "params" in choice ? operandDef(choice.id, defs) : undefined;
  return Object.fromEntries((def?.params ?? []).map((param) => [`${path}.${param.key}`, `${fieldLabel(path)} · ${param.label}`]));
}

/**
 * The summary names of a condition's operand boxes, by spec path. Walks the same tree the editors render and words only what the unscoped
 * picker (screener, alerts) labels itself. A path not listed keeps `fieldLabel`'s wording. Pass the result as `formProblems`' `labels`.
 */
export function operandBoxLabels(when: Condition, defs: readonly OperandDef[], path = "when"): Record<string, string> {
  if ("all" in when || "any" in when) {
    const key = "all" in when ? "all" : "any";
    const children = "all" in when ? when.all : when.any;
    return Object.assign({}, ...children.map((child, index) => operandBoxLabels(child, defs, `${path}.${key}.${index}`)));
  }
  if ("not" in when) return operandBoxLabels(when.not, defs, `${path}.not`);
  if (!("left" in when)) return {};
  return { ...operandParamLabels(when.left, `${path}.left`, defs), ...operandParamLabels(when.right, `${path}.right`, defs) };
}

/** `operandBoxLabels` for a form of rows: one row is the condition itself (`when`), several sit in its group (`when.all.1`), as the form saves them. */
export const rowsBoxLabels = (form: { mode: "all" | "any"; rows: readonly Condition[] }, defs: readonly OperandDef[]): Record<string, string> =>
  operandBoxLabels(form.rows.length === 1 ? form.rows[0]! : form.mode === "all" ? { all: [...form.rows] } : { any: [...form.rows] }, defs);

/** The screener editor's operand boxes: the condition rows' and, while "Rank the matches" is on, the one under Rank by (`rank.by`). */
export const filterBoxLabels = (form: Pick<FilterForm, "mode" | "rows" | "rankEnabled" | "rankBy">, defs: readonly OperandDef[]): Record<string, string> => ({
  ...rowsBoxLabels(form, defs),
  ...(form.rankEnabled ? operandParamLabels(form.rankBy, "rank.by", defs) : {}),
});
