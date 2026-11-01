"use client";

import type { Condition, Operand } from "@ai-trading/contracts";
import { Button } from "@/components/ui/Button";
import { ChoiceGroup, Field, FieldError, FieldGroup, FieldRow, NumberInput, Radio, ReadOnlyValue, Select } from "@/components/ui/Field";
import type { Problem } from "@/lib/api/schemas";
import { OPERATORS, addRow, problemsForRow, removeRow, rowKind, updateRow, type FilterForm } from "@/lib/desk/filterForm";
import { OPERAND_CATALOG, choiceOf } from "@/lib/desk/operands";
import { fieldError } from "@/lib/desk/problems";
import { describeCondition } from "@/lib/spec/describe";
import { OperandPicker, parse, shown } from "./OperandPicker";
import styles from "./conditions.module.css";
import { useId } from "react";

type CompareLike = Extract<Condition, { left: Operand; right: Operand }>;
type CompareOp = Exclude<CompareLike["op"], "within_pct">;

function withOperator(cond: CompareLike, op: string): Condition {
  return op === "within_pct"
    ? { op: "within_pct", left: cond.left, right: cond.right, pct: 1 }
    : { op: op as CompareOp, left: cond.left, right: cond.right };
}

function ConditionRow({ condition, index, form, onChange, problems }: {
  condition: Condition;
  index: number;
  form: FilterForm;
  onChange: (next: FilterForm) => void;
  problems: readonly Problem[];
}) {
  const uid = useId();
  const remove = (
    <Button aria-label={`Remove condition ${index + 1}`} onClick={() => onChange(removeRow(form, index))}>
      Remove
    </Button>
  );
  const rowError = fieldError(problemsForRow(problems, form, index));
  // Nested groups, patterns and time windows, or an operand the picker cannot express, stay read-only text.
  const cond = rowKind(condition) === "static" ? null : (condition as CompareLike);
  if (cond === null || choiceOf(cond.left) === null || choiceOf(cond.right) === null) {
    return (
      <div className={styles.condition}>
        <FieldRow>
          <ReadOnlyValue>{describeCondition(condition)}</ReadOnlyValue>
          {remove}
        </FieldRow>
        {rowError && <FieldError>{rowError}</FieldError>}
      </div>
    );
  }
  const set = (next: Condition) => onChange(updateRow(form, index, next));
  return (
    <div className={styles.condition}>
      <FieldRow className={styles.controls}>
        <OperandPicker label="Metric" operand={cond.left} defs={OPERAND_CATALOG} onChange={(left) => set({ ...cond, left })} />
        <Field id={`${uid}-operator`} label="Operator">
          <Select value={cond.op} onChange={(event) => set(withOperator(cond, event.target.value))}>
            {OPERATORS.map(({ op, label }) => <option key={op} value={op}>{label}</option>)}
          </Select>
        </Field>
        {cond.op === "within_pct" && (
          <Field id={`${uid}-pct`} label="Within %">
            <NumberInput min={0} max={100} step="any" value={shown(cond.pct)} onChange={(event) => set({ ...cond, pct: parse(event.target.value) })} />
          </Field>
        )}
        <OperandPicker label="Compared with" operand={cond.right} defs={OPERAND_CATALOG} allowNumber onChange={(right) => set({ ...cond, right })} />
        {remove}
      </FieldRow>
      {rowError && <FieldError>{rowError}</FieldError>}
    </div>
  );
}

export function ConditionRows({ form, onChange, problems }: { form: FilterForm; onChange: (next: FilterForm) => void; problems: readonly Problem[] }) {
  // Group-level problems (`when` or `when.all`) belong to no single row, so they show under the list.
  const groupError = fieldError(form.rows.length > 1 ? problems.filter((problem) => problem.path === "when" || problem.path === `when.${form.mode}`) : []);
  return (
    <FieldGroup legend="Conditions" error={groupError}>
      {form.rows.length > 1 && (
        <ChoiceGroup label="Match">
          <Radio name="condition-mode" label="All of these" checked={form.mode === "all"} onChange={() => onChange({ ...form, mode: "all" })} />
          <Radio name="condition-mode" label="Any of these" checked={form.mode === "any"} onChange={() => onChange({ ...form, mode: "any" })} />
        </ChoiceGroup>
      )}
      {form.rows.map((condition, index) => (
        <ConditionRow key={index} condition={condition} index={index} form={form} onChange={onChange} problems={problems} />
      ))}
      <FieldRow>
        <Button onClick={() => onChange(addRow(form))}>Add condition</Button>
      </FieldRow>
    </FieldGroup>
  );
}
