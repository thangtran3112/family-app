"use client";

import { FieldGroup, Field, NumberInput } from "@/components/ui/Field";
import type { Problem } from "@/lib/api/schemas";
import { AVG_VOLUME_DAYS_HINT, AVG_VOLUME_DAYS_MAX, AVG_VOLUME_DAYS_MIN, DEFAULT_AVG_VOLUME_DAYS, problemsFor, type FilterForm } from "@/lib/desk/filterForm";
import { fieldError } from "@/lib/desk/problems";

type Entry = { key: "minPrice" | "minAvgVolume" | "avgVolumeDays"; label: string; hint?: string; min?: number; max?: number; placeholder?: string };

const FIELDS: readonly Entry[] = [
  { key: "minPrice", label: "Minimum price ($)" },
  { key: "minAvgVolume", label: "Minimum average volume" },
  // A blank is the default (the server counts 20 sessions): the box says so, with the range the contract accepts (D-197).
  { key: "avgVolumeDays", label: "Average volume days", hint: AVG_VOLUME_DAYS_HINT, min: AVG_VOLUME_DAYS_MIN, max: AVG_VOLUME_DAYS_MAX, placeholder: String(DEFAULT_AVG_VOLUME_DAYS) },
];

export function LiquidityFields({ form, onChange, problems }: { form: FilterForm; onChange: (next: FilterForm) => void; problems: readonly Problem[] }) {
  return (
    <FieldGroup legend="Liquidity floor" error={fieldError(problems.filter((problem) => problem.path === "liquidity"))}>
      {FIELDS.map(({ key, label, hint, ...limits }) => (
        <Field key={key} id={`filter-${key}`} label={label} hint={hint} error={fieldError(problemsFor(problems, `liquidity.${key}`))}>
          <NumberInput step="any" {...limits} value={form[key]} onChange={(event) => onChange({ ...form, [key]: event.target.value })} />
        </Field>
      ))}
    </FieldGroup>
  );
}
