import type { ReactNode } from "react";
import { statTileTag } from "@/lib/desk/primitivesView";
import styles from "./StatTile.module.css";

/**
 * One headline number: a caps label, the value, an optional delta (a `<Delta>`) and an optional note under them. With an `href` the tile is
 * a plain link (full navigation); without one it is read-only: no link, no hover. Replaces every local `.tile*`.
 */
export function StatTile({ label, value, delta, note, href, className }: { label: ReactNode; value: ReactNode; delta?: ReactNode; note?: ReactNode; href?: string; className?: string }) {
  const cls = `${styles.root} ${className ?? ""}`;
  const content = (
    <>
      <span className={styles.label}>{label}</span>
      <span className={styles.value}>{value}</span>
      {delta !== undefined && <span className={styles.delta}>{delta}</span>}
      {note && <span className={styles.note}>{note}</span>}
    </>
  );
  return statTileTag(href) === "a" ? <a className={cls} href={href}>{content}</a> : <div className={cls}>{content}</div>;
}
