"use client";

import type { CategoryFilter, CategoryRow } from "@/lib/desk/libraryView";
import styles from "./library.module.css";

/** Left pane: "All presets" plus each category with its count. The active row gets an amber edge. */
export function CategoryList({ rows, value, onChange }: { rows: CategoryRow[]; value: CategoryFilter; onChange: (id: CategoryFilter) => void }) {
  return (
    <nav className={styles.categories} aria-label="Preset categories">
      <ul className={styles.catList}>
        {rows.map((row) => (
          <li key={row.id}>
            <button
              type="button"
              className={styles.catButton}
              aria-current={row.id === value ? "true" : undefined}
              onClick={() => onChange(row.id)}
            >
              <span>{row.label}</span>
              <span className={styles.count}>{row.count}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
