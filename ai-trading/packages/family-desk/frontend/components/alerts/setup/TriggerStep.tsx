"use client";

import type { AlertStrategySpecV1 } from "@ai-trading/contracts/alert-strategy";
import type { Problem } from "@/lib/api/schemas";
import { type AlertForm } from "@/lib/desk/alertForm";
import { FREQUENCY_LABEL, runOnLabel } from "@/lib/desk/labels";
import editorStyles from "@/components/screener/editor/editor.module.css";
import styles from "./setup.module.css";
import { problemLine } from "@/lib/desk/problemCopy";

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
      <label className={editorStyles.field}>
        <span>Check on</span>
        <select value={form.runOn} onChange={(event) => onChange({ ...form, runOn: event.target.value as AlertForm["runOn"] })}>
          {RUN_ON.map((runOn) => <option key={runOn} value={runOn}>{runOnLabel(runOn)}</option>)}
        </select>
      </label>
      <fieldset className={editorStyles.group}>
        <legend>Session</legend>
        <div className={editorStyles.controls}>
          <label className={editorStyles.option}>
            <input type="radio" name="alert-session" checked={form.session === "regular"} onChange={() => onChange({ ...form, session: "regular" })} />
            Regular
          </label>
          <label className={editorStyles.option}>
            <input type="radio" name="alert-session" checked={form.session === "extended"} onChange={() => onChange({ ...form, session: "extended" })} />
            Extended
          </label>
        </div>
      </fieldset>
      <fieldset className={editorStyles.group}>
        <legend>How often</legend>
        <div className={editorStyles.controls}>
          {FREQUENCIES.map((frequency) => (
            <label key={frequency} className={editorStyles.option}>
              <input type="radio" name="alert-frequency" checked={form.frequency === frequency} onChange={() => onChange({ ...form, frequency })} />
              {FREQUENCY_LABEL[frequency]}
            </label>
          ))}
        </div>
      </fieldset>
      <label className={editorStyles.field}>
        <span>Cooldown (minutes) <span className={editorStyles.note}>(optional)</span></span>
        <input type="number" min={0} step={1} placeholder="None" value={form.cooldownMinutes} onChange={(event) => onChange({ ...form, cooldownMinutes: event.target.value })} />
      </label>
      <label className={editorStyles.field}>
        <span>Expires on</span>
        <input type="date" className={styles.date} value={form.expiresOn} onChange={(event) => onChange({ ...form, expiresOn: event.target.value })} />
      </label>
      <p className={editorStyles.note}>Leave the date empty to never expire</p>
      {problems.map((problem, index) => (
        <span key={index} className={editorStyles.problem}>{problemLine(problem)}</span>
      ))}
    </section>
  );
}
