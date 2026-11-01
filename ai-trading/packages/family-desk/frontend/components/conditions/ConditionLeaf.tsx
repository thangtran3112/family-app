"use client";

import type { Condition, Operand } from "@ai-trading/contracts";
import { useId, type ReactNode } from "react";
import { Field, FieldError, FieldRow, NumberInput, ReadOnlyValue, Select } from "@/components/ui/Field";
import type { Problem } from "@/lib/api/schemas";
import { withOperator } from "@/lib/desk/conditionTree";
import { OPERATORS, problemsFor, rowKind } from "@/lib/desk/filterForm";
import { choiceOf, type OperandDef } from "@/lib/desk/operands";
import { fieldError } from "@/lib/desk/problems";
import { describeCondition } from "@/lib/spec/describe";
import type { CompareOperator } from "@/lib/spec/labels";
import { OperandPicker, parse, shown } from "./OperandPicker";
import styles from "./conditions.module.css";

type CompareLike = Extract<Condition, { left: Operand; right: Operand }>;

/**
 * One comparison, field by field: Metric, Operator, Within % (for `within_pct`), Compared with. `path` is the condition's place in the spec;
 * every problem at or below it shows under the controls. A condition the pickers cannot express (a nested group, a pattern, a time window,
 * an operand outside `defs`) reads as text. `actions` (a Remove button) ends the row. `scope` words each parameter after its picker
 * ("Metric length"), for a row that holds two. Render it inside the caller's wrapper.
 */
export function ConditionLeaf({ condition, path, defs, onChange, problems, actions, disabled = false, scope = false }: {
  condition: Condition;
  path: string;
  defs: readonly OperandDef[];
  onChange: (next: Condition) => void;
  problems: readonly Problem[];
  actions?: ReactNode;
  disabled?: boolean;
  scope?: boolean;
}) {
  const uid = useId();
  const error = fieldError(problemsFor(problems, path));
  const cond = rowKind(condition) === "static" ? null : (condition as CompareLike);
  if (cond === null || choiceOf(cond.left, defs) === null || choiceOf(cond.right, defs) === null) {
    return (
      <>
        <FieldRow>
          <ReadOnlyValue>{describeCondition(condition)}</ReadOnlyValue>
          {actions}
        </FieldRow>
        {error && <FieldError>{error}</FieldError>}
      </>
    );
  }
  return (
    <>
      <FieldRow className={styles.controls}>
        <OperandPicker label="Metric" operand={cond.left} defs={defs} scope={scope} disabled={disabled} onChange={(left) => onChange({ ...cond, left })} />
        <Field id={`${uid}-operator`} label="Operator">
          <Select disabled={disabled} value={cond.op} onChange={(event) => onChange(withOperator(cond, event.target.value as CompareOperator))}>
            {OPERATORS.map(({ op, label }) => <option key={op} value={op}>{label}</option>)}
          </Select>
        </Field>
        {cond.op === "within_pct" && (
          <Field id={`${uid}-pct`} label="Within %">
            <NumberInput disabled={disabled} min={0} max={100} step="any" value={shown(cond.pct)} onChange={(event) => onChange({ ...cond, pct: parse(event.target.value) })} />
          </Field>
        )}
        <OperandPicker label="Compared with" operand={cond.right} defs={defs} allowNumber scope={scope} disabled={disabled} onChange={(right) => onChange({ ...cond, right })} />
        {actions}
      </FieldRow>
      {error && <FieldError>{error}</FieldError>}
    </>
  );
}
