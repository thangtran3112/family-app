"use client";

import { FieldGroup, Field, NumberInput } from "@/components/ui/Field";
import type { Problem } from "@/lib/api/schemas";
import { AVG_VOLUME_DAYS_HINT, AVG_VOLUME_DAYS_MAX, AVG_VOLUME_DAYS_MIN, DEFAULT_AVG_VOLUME_DAYS, problemsFor, type FilterForm } from "@/lib/desk/filterForm";
import { fieldError } from "@/lib/desk/problems";
import { paramLabel } from "@/lib/spec/labels";

type Entry = { key: "minPrice" | "minAvgVolume" | "avgVolumeDays"; label: string; hint?: string; min?: number; max?: number; placeholder?: string };

// The labels come from the one table the error summary reads (lib/spec/labels.ts), so the two cannot name a field differently (D-205).
const FIELDS: readonly Entry[] = [
  { key: "minPrice", label: paramLabel("minPrice") },
  { key: "minAvgVolume", label: paramLabel("minAvgVolume") },
  // A blank is the default (the server counts 20 sessions): the box says so, with the range the contract accepts (D-197).
  { key: "avgVolumeDays", label: paramLabel("avgVolumeDays"), hint: AVG_VOLUME_DAYS_HINT, min: AVG_VOLUME_DAYS_MIN, max: AVG_VOLUME_DAYS_MAX, placeholder: String(DEFAULT_AVG_VOLUME_DAYS) },
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
