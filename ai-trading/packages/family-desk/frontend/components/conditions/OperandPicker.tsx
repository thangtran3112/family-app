"use client";

import type { Operand } from "@ai-trading/contracts";
import { choiceOf, operandDef, operandFor, type OperandDef } from "@/lib/desk/operands";
import styles from "./conditions.module.css";

const GROUPS = ["Price", "Indicators", "Levels"] as const;

export const shown = (value: number | undefined) => (value !== undefined && Number.isFinite(value) ? value : "");
export const parse = (text: string) => (text.trim() === "" ? Number.NaN : Number(text));

/** Metric select grouped by the catalog's groups, with its parameters as number inputs. Shared by the screener editor, the alert setup and RankFields. */
export function OperandPicker({ label, operand, defs, allowNumber = false, onChange }: {
  label: string;
  operand: Operand;
  defs: readonly OperandDef[];
  allowNumber?: boolean;
  onChange: (next: Operand) => void;
}) {
  const choice = choiceOf(operand);
  const isNumber = choice !== null && "value" in choice;
  const metric = choice !== null && !("value" in choice) ? choice : null;
  const params = metric ? (operandDef(metric.id)?.params ?? []) : [];
  return (
    <>
      <label className={styles.field}>
        <span>{label}</span>
        <select
          value={choice?.id ?? ""}
          onChange={(event) => onChange(operandFor(event.target.value === "value" ? { id: "value", value: 0 } : { id: event.target.value, params: {} }))}
        >
          {choice === null && <option value="">Choose</option>}
          {GROUPS.map((group) => (
            <optgroup key={group} label={group}>
              {defs.filter((def) => def.group === group).map((def) => <option key={def.id} value={def.id}>{def.label}</option>)}
            </optgroup>
          ))}
          {(allowNumber || isNumber) && <option value="value">Number</option>}
        </select>
      </label>
      {choice !== null && "value" in choice && (
        <label className={styles.field}>
          <span>Value</span>
          <input type="number" step="any" value={shown(choice.value)} onChange={(event) => onChange(operandFor({ id: "value", value: parse(event.target.value) }))} />
        </label>
      )}
      {metric && params.map((param) => (
        <label key={param.key} className={styles.field}>
          <span>{param.label}</span>
          <input
            type="number"
            min={param.min}
            max={param.max}
            value={shown(metric.params[param.key] ?? param.defaultValue)}
            onChange={(event) => onChange(operandFor({ id: metric.id, params: { ...metric.params, [param.key]: parse(event.target.value) } }))}
          />
        </label>
      ))}
    </>
  );
}
