"use client";

import { ChoiceGroup, Field, FieldGroup, Radio, Select } from "@/components/ui/Field";
import type { Problem } from "@/lib/api/schemas";
import { problemsFor, type FilterForm } from "@/lib/desk/filterForm";
import { runOnLabel } from "@/lib/desk/labels";
import { fieldError } from "@/lib/desk/problems";

const RUN_ONS: FilterForm["runOn"][] = ["bar_close_1m", "bar_close_5m", "bar_close_15m", "bar_close_1h", "premarket_0830", "daily_close", "weekly"];

export function SessionRunOnFields({ form, onChange, problems }: { form: FilterForm; onChange: (next: FilterForm) => void; problems: readonly Problem[] }) {
  // Everything under `watch` except the universe (its own field above), so a bare `watch` problem is still shown.
  const mine = problemsFor(problems, "watch").filter((problem) => !problem.path.startsWith("watch.universe"));
  return (
    <FieldGroup legend="Session and run on" error={fieldError(mine)}>
      <ChoiceGroup label="Session">
        <Radio name="filter-session" label="Regular" checked={form.session === "regular"} onChange={() => onChange({ ...form, session: "regular" })} />
        <Radio name="filter-session" label="Extended" checked={form.session === "extended"} onChange={() => onChange({ ...form, session: "extended" })} />
      </ChoiceGroup>
      <Field id="filter-run-on" label="Run on">
        <Select value={form.runOn} onChange={(event) => onChange({ ...form, runOn: event.target.value as FilterForm["runOn"] })}>
          {RUN_ONS.map((value) => <option key={value} value={value}>{runOnLabel(value)}</option>)}
        </Select>
      </Field>
    </FieldGroup>
  );
}
