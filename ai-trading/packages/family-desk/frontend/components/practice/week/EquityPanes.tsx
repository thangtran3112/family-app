"use client";

import { useMemo } from "react";
import { MarketChart } from "@/components/charts/MarketChart";
import { DenseTable, type DenseColumn } from "@/components/ui/DenseTable";
import { WEEK_TEXT, equityCaption, equityRows, type EquityDayRow } from "@/lib/replay/weekScreen";
import type { EquitySeries } from "@/lib/replay/weekView";
import styles from "./week.module.css";

const BALANCE = "#E5E5EA";
const EQUITY = "#FFB020";

const COLUMNS: DenseColumn<EquityDayRow>[] = [
  { key: "day", label: "Day", render: (row) => row.day },
  { key: "week", label: "This week", render: (row) => (row.inWeek ? "Yes" : "") },
  { key: "balance", label: "Balance", align: "right", render: (row) => row.balance },
  { key: "equity", label: "Equity", align: "right", render: (row) => row.equity },
];

/**
 * Balance and equity at each close from Day 1, drawn on `MarketChart` as two lines on one money scale with this week
 * shaded (the chart's session shading, fed by the series' flat bars). The axis names no day and no date, so the same
 * numbers sit under the chart as a caption and a table: a screen reader and a keyboard get the whole picture too.
 */
export function EquityPanes({ series }: { series: EquitySeries }) {
  const overlays = useMemo(
    () => [
      { id: "balance", label: WEEK_TEXT.legendBalance, color: BALANCE, values: series.balance },
      { id: "equity", label: WEEK_TEXT.legendEquity, color: EQUITY, values: series.equity },
    ],
    [series],
  );
  const rows = useMemo(() => equityRows(series), [series]);

  return (
    <div className={styles.chartBlock}>
      <ul className={styles.legend} aria-label="Chart key">
        <li className={styles.legendItem}><span className={`${styles.swatch} ${styles.swatchBalance}`} aria-hidden="true" />{WEEK_TEXT.legendBalance}</li>
        <li className={styles.legendItem}><span className={`${styles.swatch} ${styles.swatchEquity}`} aria-hidden="true" />{WEEK_TEXT.legendEquity}</li>
        <li className={styles.legendItem}><span className={`${styles.swatch} ${styles.swatchWeek}`} aria-hidden="true" />{WEEK_TEXT.legendWeek}</li>
      </ul>
      <MarketChart
        symbol="Balance and equity"
        interval="1d"
        bars={series.bars}
        quality="eod"
        asOf={null}
        overlays={overlays}
        sessionShading
        lastPricePill={false}
        hideDates
        rowLabels={rows.map((row) => row.day)}
        chrome="bare"
        height={300}
      />
      <p className={styles.hint}>{equityCaption(series)}</p>
      <details className={styles.details}>
        <summary className={styles.summary}>{WEEK_TEXT.byDayTitle}</summary>
        <DenseTable caption={WEEK_TEXT.byDayTitle} columns={COLUMNS} rows={rows} rowKey={(row) => String(row.dayNo)} density="compact" />
      </details>
    </div>
  );
}
