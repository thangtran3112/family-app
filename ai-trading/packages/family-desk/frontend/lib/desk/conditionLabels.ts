import type { Condition } from "@ai-trading/contracts";
import { choiceOf, operandDef, type OperandDef } from "./operands.ts";
import { fieldLabel } from "./problems.ts";

/**
 * The summary names of a condition's operand boxes, by spec path: `when.left.lookbackDays` reads "Condition · Metric · Days" because the
 * Metric picker labels that box "Days" (the kit's `ParamDef.label`), where `paramLabel` alone would say "Lookback (days)" (D-205).
 * Walks the same tree the editors render and words only what the unscoped picker (screener, alerts) labels itself. A path not listed
 * keeps `fieldLabel`'s wording. Pass the result as `formProblems`' `labels`.
 */
export function operandBoxLabels(when: Condition, defs: readonly OperandDef[], path = "when"): Record<string, string> {
  if ("all" in when || "any" in when) {
    const key = "all" in when ? "all" : "any";
    const children = "all" in when ? when.all : when.any;
    return Object.assign({}, ...children.map((child, index) => operandBoxLabels(child, defs, `${path}.${key}.${index}`)));
  }
  if ("not" in when) return operandBoxLabels(when.not, defs, `${path}.not`);
  const labels: Record<string, string> = {};
  for (const side of ["left", "right"] as const) {
    const operand = "left" in when ? when[side] : null;
    const choice = operand ? choiceOf(operand, defs) : null;
    const def = choice && "params" in choice ? operandDef(choice.id, defs) : undefined;
    for (const param of def?.params ?? []) labels[`${path}.${side}.${param.key}`] = `${fieldLabel(`${path}.${side}`)} · ${param.label}`;
  }
  return labels;
}

/** `operandBoxLabels` for a form of rows: one row is the condition itself (`when`), several sit in its group (`when.all.1`), as the form saves them. */
export const rowsBoxLabels = (form: { mode: "all" | "any"; rows: readonly Condition[] }, defs: readonly OperandDef[]): Record<string, string> =>
  operandBoxLabels(form.rows.length === 1 ? form.rows[0]! : form.mode === "all" ? { all: [...form.rows] } : { any: [...form.rows] }, defs);
