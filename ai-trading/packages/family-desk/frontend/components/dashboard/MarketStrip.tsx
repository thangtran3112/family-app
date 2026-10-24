import type { Dashboard } from "@/lib/api/schemas";
import { stripTiles, type StripTile } from "@/lib/desk/dashboardView";
import { symbolHref } from "@/lib/desk/listNav";
import styles from "./dashboard.module.css";

function Tile({ tile }: { tile: StripTile }) {
  const content = (
    <>
      <span className={styles.tileSymbol}>{tile.symbol}</span>
      <span className={styles.tileLast}>{tile.last}</span>
      <span className={styles.tone} data-tone={tile.tone}>{tile.change}</span>
      {tile.note && <span className={styles.tileNote}>{tile.note}</span>}
    </>
  );
  // Futures tiles are read-only: no link, no hover action (02m §e).
  return tile.readOnly ? <div className={styles.tile}>{content}</div> : <a className={styles.tile} href={symbolHref(tile.symbol)}>{content}</a>;
}

export function MarketStrip({ strip, dim }: { strip: Dashboard["market_strip"]; dim: boolean }) {
  return (
    <ul className={`${styles.strip} ${dim ? styles.dim : ""}`} aria-label="Market strip">
      {stripTiles(strip).map((tile) => (
        <li key={tile.symbol}>
          <Tile tile={tile} />
        </li>
      ))}
    </ul>
  );
}
