"use client";

import type { ThreadTile } from "@/lib/replay/threadView";
import styles from "./threadJournal.module.css";

/**
 * The "Summary so far" tiles: label, big value, muted sub line. Each tile reads as "Label: value" to a screen reader. The
 * grid wraps to fewer columns as the centre narrows; `fourAcross` pins four a row, for a set that is a multiple of four
 * (the week's 12 read as three even rows, D-126).
 */
export function ThreadTiles({ tiles, fourAcross = false }: { tiles: ThreadTile[]; fourAcross?: boolean }) {
  return (
    <ul role="list" className={`${styles.tiles} ${fourAcross ? styles.tilesFour : ""}`}>
      {tiles.map((tile) => (
        <li key={tile.id} role="listitem" className={styles.tile}>
          <span className={styles.tileLabel}>{tile.label}</span>
          <span className="sr-only">{": "}</span>
          <span className={styles.tileValue} data-tone={tile.tone}>
            {tile.value}
          </span>
          <span className={styles.tileSub}>{tile.sub}</span>
        </li>
      ))}
    </ul>
  );
}
