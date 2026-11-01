"use client";

import type { Condition } from "@ai-trading/contracts";
import { Field, NumberInput, Select } from "@/components/ui/Field";
import { PATTERN_OPTIONS } from "@/lib/desk/conditionTree";

export type PatternCondition = Extract<Condition, { op: "pattern" }>;

const count = (text: string) => (text.trim() === "" ? undefined : Number(text));
/** Drops undefined keys so an empty trend or count is left out of the spec. */
const compact = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Condition;

/** The fields of a candlestick pattern condition: Pattern, Trend, Trend bars, Within last bars. Ids are `${idBase}-pattern`, `-trend`, `-trend-bars`, `-within-bars`. */
export function PatternFields({ condition, idBase, onChange }: { condition: PatternCondition; idBase: string; onChange: (next: Condition) => void }) {
  const edit = (changes: Record<string, unknown>) =>
    onChange(compact({ op: "pattern", pattern: condition.pattern, trend: condition.trend, trendBars: condition.trendBars, withinBars: condition.withinBars, ...changes }));
  return (
    <>
      <Field id={`${idBase}-pattern`} label="Pattern">
        <Select value={condition.pattern} onChange={(event) => edit({ pattern: event.target.value })}>
          {PATTERN_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
        </Select>
      </Field>
      <Field id={`${idBase}-trend`} label="Trend">
        <Select value={condition.trend ?? "any"} onChange={(event) => edit({ trend: event.target.value === "any" ? undefined : event.target.value })}>
          <option value="any">Any trend</option>
          <option value="after_downtrend">After a downtrend</option>
          <option value="after_uptrend">After an uptrend</option>
        </Select>
      </Field>
      <Field id={`${idBase}-trend-bars`} label="Trend bars">
        <NumberInput min={3} max={50} value={condition.trendBars ?? ""} onChange={(event) => edit({ trendBars: count(event.target.value) })} />
      </Field>
      <Field id={`${idBase}-within-bars`} label="Within last bars">
        <NumberInput min={1} max={5} value={condition.withinBars ?? ""} onChange={(event) => edit({ withinBars: count(event.target.value) })} />
      </Field>
    </>
  );
}
