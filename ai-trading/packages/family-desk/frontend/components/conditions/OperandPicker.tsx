"use client";

import type { Operand } from "@ai-trading/contracts";
import { useId } from "react";
import { Field, NumberInput, Select } from "@/components/ui/Field";
import { choiceOf, operandDef, operandFor, type OperandDef } from "@/lib/desk/operands";
import { optionLabel, subLabel } from "@/lib/spec/labels";

const GROUPS = ["Price", "Indicators", "Levels"] as const;

export const shown = (value: number | undefined) => (value !== undefined && Number.isFinite(value) ? value : "");
export const parse = (text: string) => (text.trim() === "" ? Number.NaN : Number(text));

/**
 * Metric select grouped by the catalog's groups, with its choice parameters as selects and its number parameters as inputs. Shared by the screener editor, the alert setup and RankFields.
 * The metric is looked up in `defs`, not the global catalog, so a picker given the strategy catalog offers all 43 metrics.
 * `scope` words each parameter after the picker ("Metric length", "Compared with fast length") for a row that holds two pickers; off, a parameter reads "Length".
 */
export function OperandPicker({ label, operand, defs, allowNumber = false, scope = false, onChange }: {
  label: string;
  operand: Operand;
  defs: readonly OperandDef[];
  allowNumber?: boolean;
  scope?: boolean;
  onChange: (next: Operand) => void;
}) {
  const uid = useId();
  const choice = choiceOf(operand, defs);
  const isNumber = choice !== null && "value" in choice;
  const metric = choice !== null && !("value" in choice) ? choice : null;
  const def = metric ? operandDef(metric.id, defs) : undefined;
  return (
    <>
      <Field id={`${uid}-metric`} label={label}>
        <Select
          value={choice?.id ?? ""}
          onChange={(event) => onChange(operandFor(event.target.value === "value" ? { id: "value", value: 0 } : { id: event.target.value, params: {} }, defs))}
        >
          {choice === null && <option value="">Choose</option>}
          {GROUPS.map((group) => (
            <optgroup key={group} label={group}>
              {defs.filter((item) => item.group === group).map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </optgroup>
          ))}
          {(allowNumber || isNumber) && <option value="value">Number</option>}
        </Select>
      </Field>
      {choice !== null && "value" in choice && (
        <Field id={`${uid}-value`} label="Value">
          <NumberInput step="any" value={shown(choice.value)} onChange={(event) => onChange(operandFor({ id: "value", value: parse(event.target.value) }, defs))} />
        </Field>
      )}
      {metric && def?.picks?.map((item) => (
        <Field key={item.key} id={`${uid}-${item.key}`} label={scope ? subLabel(label, item.key) : item.label}>
          <Select
            value={metric.picks?.[item.key] ?? item.defaultValue}
            onChange={(event) => onChange(operandFor({ id: metric.id, params: metric.params, picks: { ...metric.picks, [item.key]: event.target.value } }, defs))}
          >
            {item.options.map((option) => <option key={option} value={option}>{optionLabel(option)}</option>)}
          </Select>
        </Field>
      ))}
      {metric && def?.params.map((param) => (
        <Field key={param.key} id={`${uid}-${param.key}`} label={scope ? subLabel(label, param.key) : param.label}>
          <NumberInput
            min={param.min}
            max={param.max}
            value={shown(metric.params[param.key] ?? param.defaultValue)}
            onChange={(event) => onChange(operandFor({ id: metric.id, params: { ...metric.params, [param.key]: parse(event.target.value) }, picks: metric.picks }, defs))}
          />
        </Field>
      ))}
    </>
  );
}
