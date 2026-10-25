"use client";

import type { ReactNode } from "react";
import { DenseTable, type DenseColumn } from "@/components/ui/DenseTable";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import { withPriorities } from "@/lib/desk/columns";
import { PRACTICE_COPY, practiceText } from "@/lib/desk/freshness";
import { attemptsText, dayCell, orderDays, rankText, tagsText } from "@/lib/replay/daysView";
import type { ReplayDay } from "@/lib/replay/schemas";
import styles from "./hub.module.css";

type Props = {
  /** Rows for the current query; empty while loading or failed. */
  days: readonly ReplayDay[];
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  /** The typed symbol, uppercased ("" when none). */
  symbol: string;
  /** Her watchlist symbols (the ones with notable days). */
  symbols: readonly string[];
  showDates: boolean;
  onShowDates: (show: boolean) => void;
  onPick: (row: ReplayDay) => void;
};

const columnsFor = (showDates: boolean): DenseColumn<ReplayDay>[] => [
  { key: "symbol", label: "Symbol", render: (row) => <span className={styles.symbol}>{row.symbol}</span> },
  { key: "day", label: "Day", render: (row) => dayCell(row, showDates) },
  { key: "weekday", label: "Weekday", render: (row) => row.weekday },
  { key: "rank", label: "Volatility", render: (row) => rankText(row) },
  { key: "tags", label: "Tags", render: (row) => tagsText(row) },
  { key: "attempts", label: "Attempts", align: "right", render: (row) => attemptsText(row.attempts) },
];

/** Notable days (02o decision 3, §a2): spoiler-free, dates hidden until "Show dates" is on. */
export function NotableDaysTable({ days, loading, error, onRetry, symbol, symbols, showDates, onShowDates, onPick }: Props) {
  // The hint only once her symbol list has loaded: until then nothing says whether the typed symbol is on it.
  const customSymbol = symbols.length > 0 && symbol !== "" && !symbols.includes(symbol);
  let body: ReactNode;
  if (loading) body = <LoadingBlock label={PRACTICE_COPY.loadingDays} height={120} />;
  else if (error !== null) body = <ErrorBlock subject="practice day list" onRetry={onRetry} />;
  else if (days.length === 0) {
    body = <EmptyBlock title={symbol ? practiceText("noNotableDays", { symbol }) : "No notable days yet"} />;
  } else {
    body = (
      <DenseTable
        caption="Notable days"
        columns={withPriorities(columnsFor(showDates), "practiceDays")}
        rows={orderDays(days, symbol)}
        rowKey={(row) => `${row.symbol}:${row.day}`}
        rowActions={(row) => (
          <button type="button" className={styles.small} aria-label={`Practice ${row.symbol}`} onClick={() => onPick(row)}>
            Practice
          </button>
        )}
      />
    );
  }

  return (
    <section id="notable-days" aria-labelledby="notable-title" className={styles.section}>
      <div className={styles.sectionHead}>
        <h2 id="notable-title" className={styles.sectionTitle}>Notable days</h2>
        <label className={styles.switch}>
          <input type="checkbox" role="switch" className={styles.check} checked={showDates} onChange={(event) => onShowDates(event.target.checked)} />
          Show dates
        </label>
      </div>
      <p className={styles.muted}>{PRACTICE_COPY.notableHeader}</p>
      {customSymbol && <p className={styles.muted}>{PRACTICE_COPY.notableCustomHint}</p>}
      {body}
    </section>
  );
}
