"use client";

import type { Condition, Operand } from "@ai-trading/contracts";
import type { Problem } from "@/lib/api/schemas";
import { OperandPicker } from "@/components/conditions/OperandPicker";
import { ALERT_OPERATORS, PATTERN_OPTIONS, operatorOf, withOperator, type AlertForm, type AlertOperatorId } from "@/lib/desk/alertForm";
import { problemsForRow } from "@/lib/desk/filterForm";
import { OPERAND_CATALOG, choiceOf } from "@/lib/desk/operands";
import { describeCondition } from "@/lib/spec/describe";
import { Button } from "@/components/ui/Button";
import { ChoiceGroup, Field, FieldError, FieldRow, NumberInput, Radio, ReadOnlyValue, Select } from "@/components/ui/Field";
import styles from "./setup.module.css";
import { problemLine } from "@/lib/desk/problems";

type CompareCondition = Extract<Condition, { left: Operand; right: Operand }>;
type PatternCondition = Extract<Condition, { op: "pattern" }>;
const isCompare = (row: Condition): row is CompareCondition => "left" in row && "right" in row;
const isPattern = (row: Condition): row is PatternCondition => "op" in row && row.op === "pattern";

const BLANK_ROW: Condition = { op: "crosses_above", left: { series: "close" }, right: { series: "vwap" } };
const number = (text: string) => (text.trim() === "" ? Number.NaN : Number(text));
const count = (text: string) => (text.trim() === "" ? undefined : Number(text));
/** Drops undefined keys so an empty trend or count is left out of the spec. */
const compact = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Condition;

export function ConditionStep({ form, onChange, problems }: {
  form: AlertForm;
  onChange: (next: AlertForm) => void;
  problems: readonly Problem[];
}) {
  const rowProblems = form.rows.map((_, index) => problemsForRow(problems, form, index));
  const loose = problems.filter((problem) => !rowProblems.some((list) => list.includes(problem)));
  const setRow = (index: number, next: Condition) => onChange({ ...form, rows: form.rows.map((row, position) => (position === index ? next : row)) });

  return (
    <section className={styles.card} aria-labelledby="alert-step-condition">
      <h2 id="alert-step-condition" className={styles.stepTitle}>Condition</h2>
      {form.rows.length > 1 && (
        <ChoiceGroup label="Match">
          <Radio name="alert-match" label="All of these" checked={form.mode === "all"} onChange={() => onChange({ ...form, mode: "all" })} />
          <Radio name="alert-match" label="Any of these" checked={form.mode === "any"} onChange={() => onChange({ ...form, mode: "any" })} />
        </ChoiceGroup>
      )}
      {form.rows.map((row, index) => (
        <div key={index} className={styles.condition}>
          <FieldRow className={styles.controls}>
            <ConditionFields row={row} index={index} onChange={(next) => setRow(index, next)} />
            <Button
              aria-label={`Remove condition ${index + 1}`}
              disabled={form.rows.length === 1}
              onClick={() => onChange({ ...form, rows: form.rows.filter((_, position) => position !== index) })}
            >
              Remove
            </Button>
          </FieldRow>
          {rowProblems[index]!.map((problem, position) => <FieldError key={position}>{problemLine(problem)}</FieldError>)}
        </div>
      ))}
      {loose.map((problem, index) => <FieldError key={index}>{problemLine(problem)}</FieldError>)}
      <FieldRow>
        <Button onClick={() => onChange({ ...form, rows: [...form.rows, BLANK_ROW] })}>Add condition</Button>
      </FieldRow>
    </section>
  );
}

/** One row's fields. Patterns and comparisons the picker can express are editable; anything else reads as text. */
function ConditionFields({ row, index, onChange }: { row: Condition; index: number; onChange: (next: Condition) => void }) {
  const fieldId = (name: string) => `alert-condition-${index}-${name}`;
  const operator = (
    <Field id={fieldId("operator")} label="Operator">
      <Select value={operatorOf(row) ?? ""} onChange={(event) => onChange(withOperator(row, event.target.value as AlertOperatorId))}>
        {ALERT_OPERATORS.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
      </Select>
    </Field>
  );

  if (isPattern(row)) {
    const edit = (changes: Record<string, unknown>) =>
      onChange(compact({ op: "pattern", pattern: row.pattern, trend: row.trend, trendBars: row.trendBars, withinBars: row.withinBars, ...changes }));
    return (
      <>
        {operator}
        <Field id={fieldId("pattern")} label="Pattern">
          <Select value={row.pattern} onChange={(event) => edit({ pattern: event.target.value })}>
            {PATTERN_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
          </Select>
        </Field>
        <Field id={fieldId("trend")} label="Trend">
          <Select value={row.trend ?? "any"} onChange={(event) => edit({ trend: event.target.value === "any" ? undefined : event.target.value })}>
            <option value="any">Any trend</option>
            <option value="after_downtrend">After a downtrend</option>
            <option value="after_uptrend">After an uptrend</option>
          </Select>
        </Field>
        <Field id={fieldId("trend-bars")} label="Trend bars">
          <NumberInput min={3} max={50} value={row.trendBars ?? ""} onChange={(event) => edit({ trendBars: count(event.target.value) })} />
        </Field>
        <Field id={fieldId("within-bars")} label="Within last bars">
          <NumberInput min={1} max={5} value={row.withinBars ?? ""} onChange={(event) => edit({ withinBars: count(event.target.value) })} />
        </Field>
      </>
    );
  }

  if (isCompare(row) && choiceOf(row.left) !== null && choiceOf(row.right) !== null) {
    return (
      <>
        <OperandPicker label="Metric" operand={row.left} defs={OPERAND_CATALOG} onChange={(left) => onChange({ ...row, left })} />
        {operator}
        {"pct" in row && (
          <Field id={fieldId("pct")} label="Within %">
            <NumberInput min={0} max={100} step="any" value={Number.isFinite(row.pct) ? row.pct : ""} onChange={(event) => onChange({ ...row, pct: number(event.target.value) })} />
          </Field>
        )}
        <OperandPicker label="Compared with" operand={row.right} defs={OPERAND_CATALOG} allowNumber onChange={(right) => onChange({ ...row, right })} />
      </>
    );
  }

  return <ReadOnlyValue>{describeCondition(row)}</ReadOnlyValue>;
}
