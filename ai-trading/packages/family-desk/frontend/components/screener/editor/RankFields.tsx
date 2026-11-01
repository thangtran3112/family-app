"use client";

import type { Problem } from "@/lib/api/schemas";
import { problemsFor, type FilterForm } from "@/lib/desk/filterForm";
import { OPERAND_CATALOG } from "@/lib/desk/operands";
import { OperandPicker } from "@/components/conditions/OperandPicker";
import styles from "./editor.module.css";
import { problemText } from "@/lib/desk/problems";

// Ranking takes a series, so the level operands (prior day high, N-day high, …) are left out.
const SERIES = OPERAND_CATALOG.filter((def) => def.group !== "Levels");

export function RankFields({ form, onChange, problems }: { form: FilterForm; onChange: (next: FilterForm) => void; problems: readonly Problem[] }) {
  return (
    <fieldset className={styles.group}>
      <legend>Rank</legend>
      <label className={styles.option}>
        <input type="checkbox" checked={form.rankEnabled} onChange={(event) => onChange({ ...form, rankEnabled: event.target.checked })} />
        Rank the matches
      </label>
      {form.rankEnabled && (
        <>
          <OperandPicker label="Rank by" operand={form.rankBy} defs={SERIES} onChange={(rankBy) => onChange({ ...form, rankBy })} />
          <div role="group" aria-label="Order" className={styles.controls}>
            <label className={styles.option}>
              <input type="radio" name="rank-order" checked={form.rankOrder === "desc"} onChange={() => onChange({ ...form, rankOrder: "desc" })} />
              Highest first
            </label>
            <label className={styles.option}>
              <input type="radio" name="rank-order" checked={form.rankOrder === "asc"} onChange={() => onChange({ ...form, rankOrder: "asc" })} />
              Lowest first
            </label>
          </div>
        </>
      )}
      {problemsFor(problems, "rank").map((problem, index) => (
        <span key={index} className={styles.problem}>{problemText(problem)}</span>
      ))}
    </fieldset>
  );
}
