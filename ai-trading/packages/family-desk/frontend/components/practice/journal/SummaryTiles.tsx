"use client";

import type { SummaryTile } from "@/lib/replay/journalView";
import styles from "./journal.module.css";

export type SummaryTilesProps = {
  tiles: SummaryTile[];
  /** Muted text under the Adherence tile, e.g. "Add a plan to get an adherence score". */
  hint: string | null;
};

/** Eight journal tiles in a responsive grid; each reads as "Label: value" to a screen reader. */
export function SummaryTiles({ tiles, hint }: SummaryTilesProps) {
  return (
    <ul role="list" className={styles.tiles}>
      {tiles.map((tile) => (
        <li key={tile.id} role="listitem" className={styles.tile}>
          <span className={styles.tileLabel}>{tile.label}</span>
          <span className="sr-only">{": "}</span>
          <span className={styles.tileValue} data-tone={tile.tone}>
            {tile.value}
          </span>
          {tile.id === "adherence" && hint ? (
            <>
              {" "}
              <span className={styles.tileHint}>{hint}</span>
            </>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
