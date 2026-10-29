import type { TodayTile } from "@/lib/desk/fundamentalToday";
import styles from "../fundamental.module.css";

/** A row of label-over-value tiles. Each tile's test id is `<prefix>-<id>`; the tone repeats a signed value's meaning in colour. */
export function TileList({ tiles, label, testIdPrefix, dim = false }: { tiles: readonly TodayTile[]; label: string; testIdPrefix: string; dim?: boolean }) {
  return (
    <ul className={`${styles.tiles} ${dim ? styles.dim : ""}`} aria-label={label}>
      {tiles.map((tile) => (
        <li key={tile.id} className={styles.tile} data-testid={`${testIdPrefix}-${tile.id}`}>
          <span className={styles.tileLabel}>{tile.label}</span>
          <span className={`${styles.tileValue} ${styles.tone}`} data-tone={tile.tone}>{tile.value}</span>
          {tile.note && <span className={styles.tileNote}>{tile.note}</span>}
        </li>
      ))}
    </ul>
  );
}
