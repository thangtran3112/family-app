"use client";

import type { Condition } from "@ai-trading/contracts";
import { Field, Input } from "@/components/ui/Field";

export type TimeWindowCondition = Extract<Condition, { op: "time_between" }>;

export function TimeWindowFields({ condition, idBase, onChange }: { condition: TimeWindowCondition; idBase: string; onChange: (next: Condition) => void }) {
  return (
    <>
      <Field id={`${idBase}-start`} label="Start (ET)">
        <Input inputMode="numeric" placeholder="09:30" value={condition.start} onChange={(event) => onChange({ ...condition, start: event.currentTarget.value })} />
      </Field>
      <Field id={`${idBase}-end`} label="End (ET)">
        <Input inputMode="numeric" placeholder="16:00" value={condition.end} onChange={(event) => onChange({ ...condition, end: event.currentTarget.value })} />
      </Field>
    </>
  );
}
