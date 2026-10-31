"use client";

import { QUICK_FILTERS, quickFiltersActive, type QuickPicks } from "@/lib/desk/screenerView";
import styles from "./screener.module.css";

/** A-SCR-02: the standard screener bands as one row of labelled selects, narrowing the results in place. */
export function QuickFilters({ picks, onChange }: { picks: QuickPicks; onChange: (next: QuickPicks) => void }) {
  return (
    <div role="group" aria-label="Quick filters" className={styles.quick}>
      {QUICK_FILTERS.map((quick) => (
        <label key={quick.key} className={styles.quickField}>
          <span>{quick.label}</span>
          <select
            value={picks[quick.key] ?? ""}
            data-active={Boolean(picks[quick.key])}
            onChange={(event) => onChange({ ...picks, [quick.key]: event.target.value })}
          >
            <option value="">Any</option>
            {quick.bands.map((band) => (
              <option key={band.id} value={band.id}>{band.label}</option>
            ))}
          </select>
        </label>
      ))}
      {quickFiltersActive(picks) && (
        <button type="button" className={`${styles.button} ${styles.quickClear}`} onClick={() => onChange({})}>Clear</button>
      )}
    </div>
  );
}
