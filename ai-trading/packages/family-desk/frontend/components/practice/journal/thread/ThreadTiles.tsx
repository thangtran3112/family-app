"use client";

import type { ThreadTile } from "@/lib/replay/threadView";
import styles from "./threadJournal.module.css";

/** The "Summary so far" tiles: label, big value, muted sub line. Each tile reads as "Label: value" to a screen reader. */
export function ThreadTiles({ tiles }: { tiles: ThreadTile[] }) {
  return (
    <ul role="list" className={styles.tiles}>
      {tiles.map((tile) => (
        <li key={tile.id} role="listitem" className={styles.tile}>
          <span className={styles.tileLabel}>{tile.label}</span>
          <span className={styles.srOnly}>{": "}</span>
          <span className={styles.tileValue} data-tone={tile.tone}>
            {tile.value}
          </span>
          <span className={styles.tileSub}>{tile.sub}</span>
        </li>
      ))}
    </ul>
  );
}
