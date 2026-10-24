"use client";

import { CATEGORY_FILTERS, SORTS, STATUS_FILTERS, type AlertFilterState } from "@/lib/desk/alertsView";
import { statusLabel } from "@/lib/desk/labels";
import styles from "./alerts.module.css";

const CATEGORY_LABEL: Record<(typeof CATEGORY_FILTERS)[number], string> = {
  pattern: "Pattern",
  indicator: "Indicator",
  level: "Level",
  screener: "Screener",
};

export function AlertFilters({ value, onChange }: { value: AlertFilterState; onChange: (next: AlertFilterState) => void }) {
  return (
    <div className={styles.filters}>
      <label className={styles.field}>
        Status
        <select className={styles.control} value={value.status} onChange={(event) => onChange({ ...value, status: event.target.value })}>
          <option value="">All</option>
          {STATUS_FILTERS.map((status) => <option key={status} value={status}>{statusLabel(status)}</option>)}
        </select>
      </label>
      <label className={styles.field}>
        Category
        <select className={styles.control} value={value.category} onChange={(event) => onChange({ ...value, category: event.target.value })}>
          <option value="">All</option>
          {CATEGORY_FILTERS.map((category) => <option key={category} value={category}>{CATEGORY_LABEL[category]}</option>)}
        </select>
      </label>
      <label className={styles.field}>
        Symbol
        <input
          type="text"
          className={`${styles.control} ${styles.symbolInput}`}
          value={value.symbol}
          placeholder="All symbols"
          autoComplete="off"
          onChange={(event) => onChange({ ...value, symbol: event.target.value })}
        />
      </label>
      <label className={styles.field}>
        Sort
        <select
          className={styles.control}
          value={value.sort}
          onChange={(event) => onChange({ ...value, sort: event.target.value as AlertFilterState["sort"] })}
        >
          {SORTS.map((sort) => <option key={sort.id} value={sort.id}>{sort.label}</option>)}
        </select>
      </label>
    </div>
  );
}
