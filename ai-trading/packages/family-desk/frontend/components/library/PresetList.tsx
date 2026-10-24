"use client";

import type { KeyboardEvent } from "react";
import { EmptyBlock } from "@/components/ui/StateBlocks";
import type { LibraryItem } from "@/lib/api/schemas";
import styles from "./library.module.css";

const BIAS_WORD: Record<LibraryItem["bias"], string> = { bullish: "Bullish", bearish: "Bearish", neutral: "Neutral" };

/** The bias as a word, coloured to match (never colour alone). */
export function BiasChip({ bias }: { bias: LibraryItem["bias"] }) {
  return <span className={`${styles.bias} ${styles[bias]}`}>{BIAS_WORD[bias]}</span>;
}

/** Middle pane: the search box, then the rows. Arrow Up/Down move the selection and focus. */
export function PresetList({ items, selectedId, onSelect, query, onQuery }: {
  items: readonly LibraryItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  query: string;
  onQuery: (query: string) => void;
}) {
  function onKeyDown(event: KeyboardEvent<HTMLUListElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const index = items.findIndex(({ id }) => id === selectedId);
    const next = Math.min(items.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)));
    const item = items[next];
    if (!item) return;
    onSelect(item.id);
    event.currentTarget.querySelectorAll("button")[next]?.focus();
  }

  return (
    <>
      <label className={styles.search}>
        <span className={styles.srOnly}>Search presets</span>
        <input
          className={styles.input}
          type="search"
          placeholder="Search presets"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
        />
      </label>
      {items.length === 0 ? (
        <EmptyBlock title={query.trim() ? `No presets match “${query.trim()}”` : "No presets in this category"} />
      ) : (
        <ul className={styles.rows} onKeyDown={onKeyDown}>
          {items.map((item) => {
            const current = item.id === selectedId;
            return (
              <li key={item.id}>
                <button
                  type="button"
                  className={styles.row}
                  aria-current={current ? "true" : undefined}
                  tabIndex={current ? 0 : -1}
                  onClick={() => onSelect(item.id)}
                >
                  <span className={styles.rowTop}>
                    <span className={styles.rowLabel}>{item.label}</span>
                    <BiasChip bias={item.bias} />
                  </span>
                  <span className={styles.rowSummary}>{item.summary}</span>
                  {!item.attachable && <span className={styles.tag}>Not available yet</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
