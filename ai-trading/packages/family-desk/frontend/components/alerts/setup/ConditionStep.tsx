"use client";

import type { Condition, Operand } from "@ai-trading/contracts";
import type { Problem } from "@/lib/api/schemas";
import { OperandPicker } from "@/components/screener/editor/ConditionRows";
import { ALERT_OPERATORS, PATTERN_OPTIONS, operatorOf, withOperator, type AlertForm, type AlertOperatorId } from "@/lib/desk/alertForm";
import { problemsForRow } from "@/lib/desk/filterForm";
import { OPERAND_CATALOG, choiceOf } from "@/lib/desk/operands";
import { describeCondition } from "@/lib/spec/describe";
import editorStyles from "@/components/screener/editor/editor.module.css";
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
        <div role="group" aria-label="Match" className={editorStyles.controls}>
          <label className={editorStyles.option}>
            <input type="radio" name="alert-match" checked={form.mode === "all"} onChange={() => onChange({ ...form, mode: "all" })} />
            All of these
          </label>
          <label className={editorStyles.option}>
            <input type="radio" name="alert-match" checked={form.mode === "any"} onChange={() => onChange({ ...form, mode: "any" })} />
            Any of these
          </label>
        </div>
      )}
      {form.rows.map((row, index) => (
        <div key={index} className={editorStyles.condition}>
          <div className={editorStyles.controls}>
            <ConditionFields row={row} onChange={(next) => setRow(index, next)} />
            <button
              type="button"
              className={editorStyles.button}
              aria-label={`Remove condition ${index + 1}`}
              disabled={form.rows.length === 1}
              onClick={() => onChange({ ...form, rows: form.rows.filter((_, position) => position !== index) })}
            >
              Remove
            </button>
          </div>
          {rowProblems[index]!.map((problem, position) => (
            <span key={position} className={editorStyles.problem}>{problemLine(problem)}</span>
          ))}
        </div>
      ))}
      {loose.map((problem, index) => (
        <span key={index} className={editorStyles.problem}>{problemLine(problem)}</span>
      ))}
      <div className={editorStyles.controls}>
        <button type="button" className={editorStyles.button} onClick={() => onChange({ ...form, rows: [...form.rows, BLANK_ROW] })}>Add condition</button>
      </div>
    </section>
  );
}

/** One row's fields. Patterns and comparisons the picker can express are editable; anything else reads as text. */
function ConditionFields({ row, onChange }: { row: Condition; onChange: (next: Condition) => void }) {
  const operator = (
    <label className={editorStyles.field}>
      <span>Operator</span>
      <select value={operatorOf(row) ?? ""} onChange={(event) => onChange(withOperator(row, event.target.value as AlertOperatorId))}>
        {ALERT_OPERATORS.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
      </select>
    </label>
  );

  if (isPattern(row)) {
    const edit = (changes: Record<string, unknown>) =>
      onChange(compact({ op: "pattern", pattern: row.pattern, trend: row.trend, trendBars: row.trendBars, withinBars: row.withinBars, ...changes }));
    return (
      <>
        {operator}
        <label className={editorStyles.field}>
          <span>Pattern</span>
          <select value={row.pattern} onChange={(event) => edit({ pattern: event.target.value })}>
            {PATTERN_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>
        </label>
        <label className={editorStyles.field}>
          <span>Trend</span>
          <select value={row.trend ?? "any"} onChange={(event) => edit({ trend: event.target.value === "any" ? undefined : event.target.value })}>
            <option value="any">Any trend</option>
            <option value="after_downtrend">After a downtrend</option>
            <option value="after_uptrend">After an uptrend</option>
          </select>
        </label>
        <label className={editorStyles.field}>
          <span>Trend bars</span>
          <input type="number" min={3} max={50} value={row.trendBars ?? ""} onChange={(event) => edit({ trendBars: count(event.target.value) })} />
        </label>
        <label className={editorStyles.field}>
          <span>Within last bars</span>
          <input type="number" min={1} max={5} value={row.withinBars ?? ""} onChange={(event) => edit({ withinBars: count(event.target.value) })} />
        </label>
      </>
    );
  }

  if (isCompare(row) && choiceOf(row.left) !== null && choiceOf(row.right) !== null) {
    return (
      <>
        <OperandPicker label="Metric" operand={row.left} defs={OPERAND_CATALOG} onChange={(left) => onChange({ ...row, left })} />
        {operator}
        {"pct" in row && (
          <label className={editorStyles.field}>
            <span>Within %</span>
            <input type="number" min={0} max={100} step="any" value={Number.isFinite(row.pct) ? row.pct : ""} onChange={(event) => onChange({ ...row, pct: number(event.target.value) })} />
          </label>
        )}
        <OperandPicker label="Compared with" operand={row.right} defs={OPERAND_CATALOG} allowNumber onChange={(right) => onChange({ ...row, right })} />
      </>
    );
  }

  return <p className={editorStyles.static}>{describeCondition(row)}</p>;
}
