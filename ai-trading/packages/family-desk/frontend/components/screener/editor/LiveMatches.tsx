import Link from "next/link";
import type { ScreenerPreview } from "@/lib/api/schemas";
import { formatNumber } from "@/lib/desk/format";
import { symbolHref } from "@/lib/desk/listNav";
import styles from "./editor.module.css";

export function LiveMatches({ preview, loading, failed }: { preview: ScreenerPreview | null; loading: boolean; failed: boolean }) {
  if (loading) return <p className={styles.note} role="status">Checking matches…</p>;
  if (failed) return <p className={styles.note}>Preview unavailable right now</p>;
  if (!preview || preview.matches_total === null) return <p className={styles.note}>Preview unavailable · Save to run</p>;
  return (
    <div className={styles.panel}>
      <p className={styles.bigNumber}>{formatNumber(preview.matches_total, 0)}</p>
      <p className={styles.note}>matches of {formatNumber(preview.scanned, 0)} scanned</p>
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
