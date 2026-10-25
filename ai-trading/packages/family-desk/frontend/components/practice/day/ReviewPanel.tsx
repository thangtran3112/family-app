"use client";

import { DenseTable, type DenseColumn } from "@/components/ui/DenseTable";
import { EmptyBlock } from "@/components/ui/StateBlocks";
import { withPriorities } from "@/lib/desk/columns";
import { formatPrice } from "@/lib/desk/format";
import { PRACTICE_COPY } from "@/lib/desk/freshness";
import type { DayJournal, DayReview, ReviewRow } from "@/lib/replay/daily";
import { journalLine, moveText, pickedLabel, selectionText } from "@/lib/replay/dayView";
import { UniverseFootnote } from "./UniverseFootnote";
import styles from "./day.module.css";

const tone = (value: number | null): string => (value === null || value === 0 ? styles.flat : value > 0 ? styles.up : styles.down);
function Move({ value }: { value: number | null }) {
  return <span className={tone(value)}>{moveText(value)}</span>;
}

const COLUMNS: DenseColumn<ReviewRow>[] = [
  { key: "rank", label: "Rank", align: "right", render: (row) => row.rank ?? "—" },
  { key: "symbol", label: "Symbol", render: (row) => <span className={styles.symbol}>{row.symbol}</span> },
  { key: "picked", label: "Yours", render: (row) => pickedLabel(row) },
  { key: "list_price", label: "List price", align: "right", render: (row) => formatPrice(row.list_price) },
  { key: "move_pct", label: "Move to window end", align: "right", render: (row) => <Move value={row.move_pct} /> },
  { key: "close_move_pct", label: "Move to close", align: "right", render: (row) => <Move value={row.close_move_pct} /> },
  { key: "high_pct", label: "High after open", align: "right", render: (row) => <Move value={row.high_pct} /> },
  { key: "low_pct", label: "Low after open", align: "right", render: (row) => <Move value={row.low_pct} /> },
  { key: "range_pct", label: "Range", align: "right", render: (row) => (row.range_pct === null ? "—" : `${row.range_pct.toFixed(2)}%`) },
];

/** The list review (02o-b v1): every candidate's move from its list price, ranked by size, with her names marked. It
 *  looks past the playhead, so it only exists once the day has ended. */
export function ReviewPanel({ review, journal, footnote }: { review: DayReview; journal: DayJournal | null; footnote: string }) {
  const selection = selectionText(review);
  return (
    <section className={styles.section} aria-label="How the list moved">
      <h2 className={styles.sectionTitle}>{PRACTICE_COPY.reviewTitle}</h2>
      <ul className={styles.tiles}>
        <li className={styles.tile}>
          <span className={styles.tileLabel}>Selection</span>
          <span className={styles.tileValue} style={{ fontSize: "var(--text-row)" }}>{selection ?? PRACTICE_COPY.reviewNoPicks}</span>
          <UniverseFootnote text={footnote} />
        </li>
        {journal && (
          <li className={styles.tile}>
            <span className={styles.tileLabel}>Your day</span>
            <span className={styles.tileValue} style={{ fontSize: "var(--text-row)" }}>{journalLine(journal)}</span>
            <span className={styles.tileHint}>Practice prices · no spread, slippage, or fees</span>
          </li>
        )}
      </ul>
      <p className={styles.muted}>{PRACTICE_COPY.reviewNote}</p>
      <DenseTable
        caption="How the list moved"
        columns={withPriorities(COLUMNS, "practiceReview")}
        rows={review.rows}
        rowKey={(row) => row.symbol}
        empty={<EmptyBlock title={PRACTICE_COPY.reviewEmpty} />}
      />
    </section>
  );
}
