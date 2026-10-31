import Link from "next/link";
import type { ScreenerFilter, ScreenerPreview } from "@/lib/api/schemas";
import { formatNumber } from "@/lib/desk/format";
import { symbolHref } from "@/lib/desk/listNav";
import { previewNotes } from "@/lib/desk/screenerView";
import styles from "./editor.module.css";

/** The live check runs now on the stored bars; `lastRun` is the scheduled run the screener shows, named beside it so
 * the two counts are never read as the same thing (V-SCR-03). */
export function LiveMatches({ preview, lastRun, loading, failed }: {
  preview: ScreenerPreview | null;
  lastRun: ScreenerFilter["last_run"];
  loading: boolean;
  failed: boolean;
}) {
  if (loading) return <p className={styles.note} role="status">Checking matches…</p>;
  if (failed) return <p className={styles.note}>Preview unavailable right now</p>;
  if (!preview || preview.matches_total === null) return <p className={styles.note}>Preview unavailable · Save to run</p>;
  const [count, ...context] = previewNotes(preview, lastRun);
  return (
    <div className={styles.panel}>
      <p className={styles.bigNumber}>{formatNumber(preview.matches_total, 0)}</p>
      <p className={styles.note}>{count}</p>
      {context.map((note) => <p key={note} className={styles.note}>{note}</p>)}
      <ul className={styles.matchList}>
        {preview.top.slice(0, 5).map((row) => (
          <li key={row.symbol} className={styles.matchRow}>
            <Link href={symbolHref(row.symbol)} className={styles.symbol}>{row.symbol}</Link>
            <span>{formatNumber(row.rank_value)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
