"use client";

import { Fragment } from "react";
import type { Problem } from "@/lib/api/schemas";
import { problemsFor, type FilterForm } from "@/lib/desk/filterForm";
import styles from "./editor.module.css";
import { problemText } from "@/lib/desk/problems";

const FIELDS = [
  { key: "minPrice", label: "Minimum price ($)" },
  { key: "minAvgVolume", label: "Minimum average volume" },
  { key: "avgVolumeDays", label: "Average volume days" },
] as const;

export function LiquidityFields({ form, onChange, problems }: { form: FilterForm; onChange: (next: FilterForm) => void; problems: readonly Problem[] }) {
  return (
    <fieldset className={styles.group}>
      <legend>Liquidity floor</legend>
      {FIELDS.map(({ key, label }) => (
        <Fragment key={key}>
          <label className={styles.field}>
            <span>{label}</span>
            <input type="number" step="any" value={form[key]} onChange={(event) => onChange({ ...form, [key]: event.target.value })} />
          </label>
          {problemsFor(problems, `liquidity.${key}`).map((problem, index) => (
            <span key={index} className={styles.problem}>{problemText(problem)}</span>
          ))}
        </Fragment>
      ))}
      {problems.filter((problem) => problem.path === "liquidity").map((problem, index) => (
        <span key={index} className={styles.problem}>{problemText(problem)}</span>
      ))}
    </fieldset>
  );
}
