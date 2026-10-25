"use client";

import { SIZE_FILTERS, type SizeFilterId } from "@/lib/replay/tape";
import styles from "./panels.module.css";

/** Size chips `All · ≥100 · ≥1,000 · Big only`; the pressed chip is the active filter. */
export function TapeFilters({ value, onChange }: { value: SizeFilterId; onChange: (id: SizeFilterId) => void }) {
  return (
    <div role="group" aria-label="Minimum print size" className={styles.filters}>
      {SIZE_FILTERS.map((filter) => (
        <button key={filter.id} type="button" className={styles.filter} aria-pressed={filter.id === value} onClick={() => onChange(filter.id)}>
          {filter.label}
        </button>
      ))}
    </div>
  );
}
