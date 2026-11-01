"use client";

import type { Operand } from "@ai-trading/contracts";
import { useId } from "react";
import { Field, NumberInput, Select } from "@/components/ui/Field";
import { choiceOf, operandDef, operandFor, type OperandDef } from "@/lib/desk/operands";

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
  const uid = useId();
  const choice = choiceOf(operand);
  const isNumber = choice !== null && "value" in choice;
  const metric = choice !== null && !("value" in choice) ? choice : null;
  const params = metric ? (operandDef(metric.id)?.params ?? []) : [];
  return (
    <>
      <Field id={`${uid}-metric`} label={label}>
        <Select
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
        </Select>
      </Field>
      {choice !== null && "value" in choice && (
        <Field id={`${uid}-value`} label="Value">
          <NumberInput step="any" value={shown(choice.value)} onChange={(event) => onChange(operandFor({ id: "value", value: parse(event.target.value) }))} />
        </Field>
      )}
      {metric && params.map((param) => (
        <Field key={param.key} id={`${uid}-${param.key}`} label={param.label}>
          <NumberInput
            min={param.min}
            max={param.max}
            value={shown(metric.params[param.key] ?? param.defaultValue)}
            onChange={(event) => onChange(operandFor({ id: metric.id, params: { ...metric.params, [param.key]: parse(event.target.value) } }))}
          />
        </Field>
      ))}
    </>
  );
}
