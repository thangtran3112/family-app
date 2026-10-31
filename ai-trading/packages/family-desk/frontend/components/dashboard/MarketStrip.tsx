import { Delta } from "@/components/ui/Delta";
import { StatTile } from "@/components/ui/StatTile";
import type { Dashboard } from "@/lib/api/schemas";
import { stripTiles, type StripTile } from "@/lib/desk/dashboardView";
import { symbolHref } from "@/lib/desk/listNav";
import styles from "./dashboard.module.css";

// Futures tiles are read-only: no link, no hover action (02m §e).
function Tile({ tile }: { tile: StripTile }) {
  return (
    <StatTile
      href={tile.readOnly ? undefined : symbolHref(tile.symbol)}
      label={tile.symbol}
      value={tile.last}
      delta={<Delta tone={tile.tone}>{tile.change}</Delta>}
      note={tile.note}
    />
  );
}

export function MarketStrip({ strip, nextUpdateAt, dim, staleMark = null }: { strip: Dashboard["market_strip"]; nextUpdateAt: string | null; dim: boolean; staleMark?: string | null }) {
  return (
    <ul className={`${styles.strip} ${dim ? styles.dim : ""}`} aria-label="Market strip">
      {stripTiles(strip, nextUpdateAt, staleMark).map((tile) => (
        <li key={tile.symbol}>
          <Tile tile={tile} />
        </li>
      ))}
    </ul>
  );
}
