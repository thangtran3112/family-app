"use client";

import type { Condition, Operand } from "@ai-trading/contracts";
import { Button } from "@/components/ui/Button";
import type { Problem } from "@/lib/api/schemas";
import { OPERATORS, addRow, problemsForRow, removeRow, rowKind, updateRow, type FilterForm } from "@/lib/desk/filterForm";
import { OPERAND_CATALOG, choiceOf } from "@/lib/desk/operands";
import { describeCondition } from "@/lib/spec/describe";
import { problemText } from "@/lib/desk/problems";
import { OperandPicker, parse, shown } from "./OperandPicker";
import styles from "./conditions.module.css";

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
  const remove = (
    <Button aria-label={`Remove condition ${index + 1}`} onClick={() => onChange(removeRow(form, index))}>
      Remove
    </Button>
  );
  const rowProblems = problemsForRow(problems, form, index).map((problem, position) => (
    <span key={position} className={styles.problem}>{problemText(problem)}</span>
  ));
  // Nested groups, patterns and time windows, or an operand the picker cannot express, stay read-only text.
  const cond = rowKind(condition) === "static" ? null : (condition as CompareLike);
  if (cond === null || choiceOf(cond.left) === null || choiceOf(cond.right) === null) {
    return (
      <div className={styles.condition}>
        <div className={styles.controls}>
          <p className={styles.static}>{describeCondition(condition)}</p>
          {remove}
        </div>
        {rowProblems}
      </div>
    );
  }
  const set = (next: Condition) => onChange(updateRow(form, index, next));
  return (
    <div className={styles.condition}>
      <div className={styles.controls}>
        <OperandPicker label="Metric" operand={cond.left} defs={OPERAND_CATALOG} onChange={(left) => set({ ...cond, left })} />
        <label className={styles.field}>
          <span>Operator</span>
          <select value={cond.op} onChange={(event) => set(withOperator(cond, event.target.value))}>
            {OPERATORS.map(({ op, label }) => <option key={op} value={op}>{label}</option>)}
          </select>
        </label>
        {cond.op === "within_pct" && (
          <label className={styles.field}>
            <span>Within %</span>
            <input type="number" min={0} max={100} step="any" value={shown(cond.pct)} onChange={(event) => set({ ...cond, pct: parse(event.target.value) })} />
          </label>
        )}
        <OperandPicker label="Compared with" operand={cond.right} defs={OPERAND_CATALOG} allowNumber onChange={(right) => set({ ...cond, right })} />
        {remove}
      </div>
      {rowProblems}
    </div>
  );
}

export function ConditionRows({ form, onChange, problems }: { form: FilterForm; onChange: (next: FilterForm) => void; problems: readonly Problem[] }) {
  // Group-level problems (`when` or `when.all`) belong to no single row, so they show under the list.
  const groupProblems = form.rows.length > 1 ? problems.filter((problem) => problem.path === "when" || problem.path === `when.${form.mode}`) : [];
  return (
    <fieldset className={styles.group}>
      <legend>Conditions</legend>
      {form.rows.length > 1 && (
        <div role="group" aria-label="Match" className={styles.controls}>
          <label className={styles.option}>
            <input type="radio" name="condition-mode" checked={form.mode === "all"} onChange={() => onChange({ ...form, mode: "all" })} />
            All of these
          </label>
          <label className={styles.option}>
            <input type="radio" name="condition-mode" checked={form.mode === "any"} onChange={() => onChange({ ...form, mode: "any" })} />
            Any of these
          </label>
        </div>
      )}
      {form.rows.map((condition, index) => (
        <ConditionRow key={index} condition={condition} index={index} form={form} onChange={onChange} problems={problems} />
      ))}
      {groupProblems.map((problem, index) => (
        <span key={index} className={styles.problem}>{problemText(problem)}</span>
      ))}
      <div className={styles.controls}>
        <Button onClick={() => onChange(addRow(form))}>Add condition</Button>
      </div>
    </fieldset>
  );
}
