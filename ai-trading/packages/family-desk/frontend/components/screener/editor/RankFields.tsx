"use client";

import { OperandPicker } from "@/components/conditions/OperandPicker";
import { Checkbox, ChoiceGroup, FieldGroup, Radio } from "@/components/ui/Field";
import type { Problem } from "@/lib/api/schemas";
import { problemsFor, type FilterForm } from "@/lib/desk/filterForm";
import { OPERAND_CATALOG } from "@/lib/desk/operands";
import { fieldError } from "@/lib/desk/problems";

// Ranking takes a series, so the level operands (prior day high, N-day high, …) are left out.
const SERIES = OPERAND_CATALOG.filter((def) => def.group !== "Levels");

export function RankFields({ form, onChange, problems }: { form: FilterForm; onChange: (next: FilterForm) => void; problems: readonly Problem[] }) {
  return (
    <FieldGroup legend="Rank" error={fieldError(problemsFor(problems, "rank"))}>
      <Checkbox label="Rank the matches" checked={form.rankEnabled} onChange={(event) => onChange({ ...form, rankEnabled: event.target.checked })} />
      {form.rankEnabled && (
        <>
          <OperandPicker label="Rank by" operand={form.rankBy} defs={SERIES} onChange={(rankBy) => onChange({ ...form, rankBy })} />
          <ChoiceGroup label="Order">
            <Radio name="rank-order" label="Highest first" checked={form.rankOrder === "desc"} onChange={() => onChange({ ...form, rankOrder: "desc" })} />
            <Radio name="rank-order" label="Lowest first" checked={form.rankOrder === "asc"} onChange={() => onChange({ ...form, rankOrder: "asc" })} />
          </ChoiceGroup>
        </>
      )}
    </FieldGroup>
  );
}
