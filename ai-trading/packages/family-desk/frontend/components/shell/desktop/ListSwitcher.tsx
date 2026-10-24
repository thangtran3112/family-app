"use client";

import styles from "./leftrail.module.css";

export function ListSwitcher({ lists, value, onChange }: { lists: Array<{ id: number; name: string }>; value: number | null; onChange: (id: number) => void }) {
  return (
    <select aria-label="Watchlist" className={styles.select} value={value ?? ""} onChange={(event) => onChange(Number(event.target.value))}>
      {lists.map((list) => (
        <option key={list.id} value={list.id}>{list.name}</option>
      ))}
    </select>
  );
}
