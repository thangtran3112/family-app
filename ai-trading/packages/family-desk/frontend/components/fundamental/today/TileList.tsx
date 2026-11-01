import { Delta } from "@/components/ui/Delta";
import { StatTile } from "@/components/ui/StatTile";
import type { TodayTile } from "@/lib/desk/fundamentalToday";
import styles from "../fundamental.module.css";

/** A row of label-over-value tiles. Each tile's test id is `<prefix>-<id>`; the tone repeats a signed value's meaning in colour. */
export function TileList({ tiles, label, testIdPrefix, dim = false }: { tiles: readonly TodayTile[]; label: string; testIdPrefix: string; dim?: boolean }) {
  return (
    <ul className={`${styles.tiles} ${dim ? styles.dim : ""}`} aria-label={label}>
      {tiles.map((tile) => (
        <li key={tile.id} data-testid={`${testIdPrefix}-${tile.id}`}>
          <StatTile label={tile.label} value={tile.tone === "neutral" ? tile.value : <Delta tone={tile.tone}>{tile.value}</Delta>} note={tile.note} />
        </li>
      ))}
    </ul>
  );
}
