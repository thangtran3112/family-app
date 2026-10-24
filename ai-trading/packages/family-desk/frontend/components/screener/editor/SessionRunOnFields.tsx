"use client";

import type { Problem } from "@/lib/api/schemas";
import { problemsFor, type FilterForm } from "@/lib/desk/filterForm";
import { runOnLabel } from "@/lib/desk/labels";
import styles from "./editor.module.css";

const RUN_ONS: FilterForm["runOn"][] = ["bar_close_1m", "bar_close_5m", "bar_close_15m", "bar_close_1h", "premarket_0830", "daily_close", "weekly"];

export function SessionRunOnFields({ form, onChange, problems }: { form: FilterForm; onChange: (next: FilterForm) => void; problems: readonly Problem[] }) {
  // Everything under `watch` except the universe (its own field above), so a bare `watch` problem is still shown.
  const mine = problemsFor(problems, "watch").filter((problem) => !problem.path.startsWith("watch.universe"));
  return (
    <fieldset className={styles.group}>
      <legend>Session and run on</legend>
      <div role="group" aria-label="Session" className={styles.controls}>
        <label className={styles.option}>
          <input type="radio" name="filter-session" checked={form.session === "regular"} onChange={() => onChange({ ...form, session: "regular" })} />
          Regular
        </label>
        <label className={styles.option}>
          <input type="radio" name="filter-session" checked={form.session === "extended"} onChange={() => onChange({ ...form, session: "extended" })} />
          Extended
        </label>
      </div>
      <label className={styles.field}>
        <span>Run on</span>
        <select value={form.runOn} onChange={(event) => onChange({ ...form, runOn: event.target.value as FilterForm["runOn"] })}>
          {RUN_ONS.map((value) => <option key={value} value={value}>{runOnLabel(value)}</option>)}
        </select>
      </label>
      {mine.map((problem, index) => (
        <span key={index} className={styles.problem}>{problem.message}<span className={styles.problemPath}>{problem.path}</span></span>
      ))}
    </fieldset>
  );
}
