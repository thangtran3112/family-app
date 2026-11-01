"use client";

import { FieldGroup, Field, NumberInput } from "@/components/ui/Field";
import type { Problem } from "@/lib/api/schemas";
import { problemsFor, type FilterForm } from "@/lib/desk/filterForm";
import { fieldError } from "@/lib/desk/problems";

const FIELDS = [
  { key: "minPrice", label: "Minimum price ($)" },
  { key: "minAvgVolume", label: "Minimum average volume" },
  { key: "avgVolumeDays", label: "Average volume days" },
] as const;

export function LiquidityFields({ form, onChange, problems }: { form: FilterForm; onChange: (next: FilterForm) => void; problems: readonly Problem[] }) {
  return (
    <FieldGroup legend="Liquidity floor" error={fieldError(problems.filter((problem) => problem.path === "liquidity"))}>
      {FIELDS.map(({ key, label }) => (
        <Field key={key} id={`filter-${key}`} label={label} error={fieldError(problemsFor(problems, `liquidity.${key}`))}>
          <NumberInput step="any" value={form[key]} onChange={(event) => onChange({ ...form, [key]: event.target.value })} />
        </Field>
      ))}
    </FieldGroup>
  );
}
