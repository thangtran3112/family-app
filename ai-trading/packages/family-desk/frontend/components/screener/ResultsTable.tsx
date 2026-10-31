"use client";

import { useMemo } from "react";
import { DenseTable, type DenseColumn } from "@/components/ui/DenseTable";
import type { ScreenerResults } from "@/lib/api/schemas";
import { columnFromSpec } from "@/lib/desk/columns";
import { cellValue, matchCaption, resultColumns } from "@/lib/desk/screenerView";
import styles from "./screener.module.css";

type Match = ScreenerResults["matches"][number];

/** D5 results: columns follow the filter's `table_columns`; the symbol column stays pinned while the table scrolls.
 * `rows` are the run's matches after any quick filters (`quick`). */
export function ResultsTable({
  results,
  rows,
  quick,
  selected,
  onSelect,
  dim,
}: {
  results: ScreenerResults;
  rows: Match[];
  quick: boolean;
  selected: string | null;
  onSelect: (symbol: string) => void;
  dim: boolean;
}) {
  const columns = useMemo<DenseColumn<Match>[]>(
    () => [
      { key: "symbol", label: "Symbol", align: "left", render: (match) => <strong>{match.symbol}</strong>, sortValue: (match) => match.symbol },
      ...resultColumns(results.table_columns).map((column): DenseColumn<Match> =>
        columnFromSpec(column, (match) => cellValue(match, column.key), (text, tone) => <span className={styles[tone]}>{text}</span>),
      ),
    ],
    [results.table_columns],
  );

  return (
    <>
      <p className={styles.caption} role="status">{matchCaption(results, rows.length, quick)}</p>
      <DenseTable
        caption="Screener matches"
        columns={columns}
        rows={rows}
        rowKey={(match) => match.symbol}
        scrollX
        selectedKey={selected}
        onSelect={(match) => onSelect(match.symbol)}
        rowActions={(match) => (
          <a href={`/alerts/new?source=symbol:${encodeURIComponent(match.symbol)}`} className={styles.link}>+ Alert</a>
        )}
        dim={dim}
      />
    </>
  );
}
