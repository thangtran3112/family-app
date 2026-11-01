"use client";

import { Field, FieldGroup, Select } from "@/components/ui/Field";
import { Segmented } from "@/components/ui/Segmented";
import type { Problem } from "@/lib/api/schemas";
import { problemsFor, type FilterForm } from "@/lib/desk/filterForm";
import { RUN_ONS, runOnLabel } from "@/lib/spec/labels";
import { fieldError } from "@/lib/desk/problems";

const SESSIONS = [
  { value: "regular", label: "Regular" },
  { value: "extended", label: "Extended" },
] as const;

export function SessionRunOnFields({ form, onChange, problems }: { form: FilterForm; onChange: (next: FilterForm) => void; problems: readonly Problem[] }) {
  // Everything under `watch` except the universe (its own field above), so a bare `watch` problem is still shown.
  const mine = problemsFor(problems, "watch").filter((problem) => !problem.path.startsWith("watch.universe"));
  return (
    <FieldGroup legend="Session and run on" error={fieldError(mine)}>
      <Field id="filter-session" label="Session" group>
        <Segmented
          value={form.session}
          options={SESSIONS}
          onChange={(session) => onChange({ ...form, session })}
        />
      </Field>
      <Field id="filter-run-on" label="Run on">
        <Select value={form.runOn} onChange={(event) => onChange({ ...form, runOn: event.target.value as FilterForm["runOn"] })}>
          {RUN_ONS.map((value) => <option key={value} value={value}>{runOnLabel(value)}</option>)}
        </Select>
      </Field>
    </FieldGroup>
  );
}
