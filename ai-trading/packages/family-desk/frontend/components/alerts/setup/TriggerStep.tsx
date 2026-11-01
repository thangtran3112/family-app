"use client";

import type { AlertStrategySpecV1 } from "@ai-trading/contracts/alert-strategy";
import type { Problem } from "@/lib/api/schemas";
import { type AlertForm } from "@/lib/desk/alertForm";
import { FREQUENCY_LABEL, runOnLabel } from "@/lib/desk/labels";
import { Field, FieldError, FieldGroup, FieldRow, Input, NumberInput, Radio, Select } from "@/components/ui/Field";
import styles from "./setup.module.css";
import { problemLine } from "@/lib/desk/problems";

const RUN_ON: readonly AlertStrategySpecV1["watch"]["runOn"][] = [
  "bar_close_1m",
  "bar_close_5m",
  "bar_close_15m",
  "bar_close_1h",
  "premarket_0830",
  "daily_close",
  "weekly",
];
const FREQUENCIES = Object.keys(FREQUENCY_LABEL) as AlertForm["frequency"][];

export function TriggerStep({ form, onChange, problems }: {
  form: AlertForm;
  onChange: (next: AlertForm) => void;
  problems: readonly Problem[];
}) {
  return (
    <section className={styles.card} aria-labelledby="alert-step-trigger">
      <h2 id="alert-step-trigger" className={styles.stepTitle}>Trigger</h2>
      <Field id="alert-run-on" label="Check on">
        <Select value={form.runOn} onChange={(event) => onChange({ ...form, runOn: event.target.value as AlertForm["runOn"] })}>
          {RUN_ON.map((runOn) => <option key={runOn} value={runOn}>{runOnLabel(runOn)}</option>)}
        </Select>
      </Field>
      <FieldGroup legend="Session">
        <FieldRow>
          <Radio name="alert-session" label="Regular" checked={form.session === "regular"} onChange={() => onChange({ ...form, session: "regular" })} />
          <Radio name="alert-session" label="Extended" checked={form.session === "extended"} onChange={() => onChange({ ...form, session: "extended" })} />
        </FieldRow>
      </FieldGroup>
      <FieldGroup legend="How often">
        <FieldRow>
          {FREQUENCIES.map((frequency) => (
            <Radio key={frequency} name="alert-frequency" label={FREQUENCY_LABEL[frequency]} checked={form.frequency === frequency} onChange={() => onChange({ ...form, frequency })} />
          ))}
        </FieldRow>
      </FieldGroup>
      <Field id="alert-cooldown" label="Cooldown (minutes)" optional>
        <NumberInput min={0} step={1} placeholder="None" value={form.cooldownMinutes} onChange={(event) => onChange({ ...form, cooldownMinutes: event.target.value })} />
      </Field>
      <Field id="alert-expires" label="Expires on" note="Leave the date empty to never expire">
        <Input type="date" className={styles.date} value={form.expiresOn} onChange={(event) => onChange({ ...form, expiresOn: event.target.value })} />
      </Field>
      {problems.map((problem, index) => <FieldError key={index}>{problemLine(problem)}</FieldError>)}
    </section>
  );
}
