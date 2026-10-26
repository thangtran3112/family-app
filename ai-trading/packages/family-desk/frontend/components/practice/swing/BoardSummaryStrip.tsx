import { SimulatedBadge } from "@/components/practice/thread/SimulatedBadge";
import { lateStarsText } from "@/lib/replay/boardView";
import { daySummaryTiles, stopHitText } from "@/lib/replay/swing";
import type { SwingDaySummary } from "@/lib/replay/swingApi";
import dayStyles from "../day/day.module.css";
import styles from "./board.module.css";

/**
 * What an ended swing day shows in place of a review (02p b6, d1): one strip of tiles (realized, overnight gap,
 * intraday, equity change, balance, equity, entries and exits, stop crossings), then each crossing told as watched or
 * while she was away, and the names starred after the open. All SIMULATED.
 */
export function BoardSummaryStrip({ summary }: { summary: SwingDaySummary }) {
  const late = lateStarsText(summary.late_stars);
  return (
    <section className={styles.summary} aria-label="Day summary">
      <div className={styles.summaryHead}>
        <h2 className={dayStyles.sectionTitle}>Day summary</h2>
        <SimulatedBadge />
      </div>
      <ul className={styles.summaryTiles}>
        {daySummaryTiles(summary).map((tile) => (
          <li key={tile.id} className={styles.summaryTile}>
            <span className={styles.tileLabel}>{tile.label}</span>
            <span className={`${styles.tileValue} ${styles[tile.tone]}`}>{tile.value}</span>
            {tile.sub && <span className={styles.tileHint}>{tile.sub}</span>}
          </li>
        ))}
      </ul>
      {summary.stop_hits.length > 0 && (
        <ul className={styles.lines} aria-label="Stop crossings">
          {summary.stop_hits.map((hit) => <li key={`${hit.symbol}-${hit.at}`}>{stopHitText(hit)}</li>)}
        </ul>
      )}
      {late && <p className={dayStyles.muted}>{late}</p>}
    </section>
  );
}
