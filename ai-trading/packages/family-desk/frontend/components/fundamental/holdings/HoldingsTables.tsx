"use client";

import { DenseTable, type DenseColumn } from "@/components/ui/DenseTable";
import { withPriorities } from "@/lib/desk/columns";
import type { SortValue } from "@/lib/desk/sort";
import { holdingViews, type HoldingView } from "@/lib/desk/holdingsView";
import { METRIC_META, metricCell, metricLabel } from "@/lib/desk/metricColumns";
import type { HoldingRow } from "@/lib/api/fundamentalSchemas";
import type { MetricKey } from "@/lib/settings/fundamental";
import { AiRatingChip } from "../shared/AiRatingChip";
import fund from "../fundamental.module.css";
import styles from "./holdings.module.css";

const tone = (value: { text: string; tone: "up" | "down" | "flat" }) => <span className={fund.tone} data-tone={value.tone}>{value.text}</span>;

function SymbolCell({ view }: { view: HoldingView }) {
  return (
    <span className={styles.symbolCell}>
      <a className={styles.symbolLink} title={view.name} href={`/stocks?symbol=${encodeURIComponent(view.symbol)}#overview`} onClick={(event) => event.stopPropagation()}>{view.symbol}</a>
    </span>
  );
}

const POSITION_COLUMNS: DenseColumn<HoldingView>[] = withPriorities<DenseColumn<HoldingView>>(
  [
    { key: "symbol", label: "Symbol", render: (view) => <SymbolCell view={view} />, sortValue: (view) => view.symbol, firstSort: "asc" },
    { key: "shares", label: "Shares", align: "right", render: (view) => view.shares },
    { key: "avg_cost", label: "Avg cost", align: "right", render: (view) => view.avgCost },
    { key: "last", label: "Last", align: "right", render: (view) => view.last, sortValue: (view) => view.row.last },
    { key: "change_pct", label: "Chg %", align: "right", render: (view) => tone(view.change), sortValue: (view) => view.row.change_pct },
    { key: "market_value", label: "Value", align: "right", render: (view) => view.value, sortValue: (view) => view.row.market_value },
    { key: "weight_pct", label: "Weight", align: "right", render: (view) => view.weight, sortValue: (view) => view.row.weight_pct },
    { key: "unrealized_pct", label: "Unrl %", align: "right", render: (view) => tone(view.unrealized), sortValue: (view) => view.row.unrealized_pct },
    { key: "coverable", label: "Coverable", align: "right", render: (view) => view.coverable },
    { key: "open_calls", label: "Open", align: "right", render: (view) => view.openCalls },
    { key: "next_earnings", label: "Earnings", align: "right", render: (view) => view.nextEarnings, sortValue: (view) => view.row.next_earnings, firstSort: "asc" },
    { key: "ai_rating", label: "AI", render: (view) => <AiRatingChip rating={view.row.ai_rating} compact /> },
  ],
  "fundHoldings",
);

/** The positions: one row per held symbol (02n §b3 FD3). */
export function PositionsTable({ rows, masked, selected, onSelect }: { rows: readonly HoldingRow[]; masked: boolean; selected: string | null; onSelect: (symbol: string) => void }) {
  return (
    <div className={fund.tight}>
      <DenseTable
        caption="Holdings"
        columns={POSITION_COLUMNS}
        rows={holdingViews(rows, masked)}
        rowKey={(view) => view.symbol}
        density="compact"
        selectedKey={selected}
        onSelect={(view) => onSelect(view.symbol)}
        initialSort={{ key: "weight_pct", direction: "desc" }}
      />
    </div>
  );
}

function sortValueOf(row: HoldingRow, key: MetricKey): SortValue {
  const value = row.fundamentals[key];
  return typeof value === "number" || typeof value === "string" ? value : null;
}

/** The chosen metric columns (`settings.fundamental_columns`) beside the symbol, in their own table so no table scrolls sideways. */
export function FundamentalsTable({ rows, chosen, masked, selected, onSelect }: { rows: readonly HoldingRow[]; chosen: readonly MetricKey[]; masked: boolean; selected: string | null; onSelect: (symbol: string) => void }) {
  const columns: DenseColumn<HoldingRow>[] = [
    { key: "symbol", label: "Symbol", render: (row) => <strong>{row.symbol}</strong> },
    ...chosen.map((key): DenseColumn<HoldingRow> => ({
      key,
      label: metricLabel(key),
      align: METRIC_META[key].kind === "rating" ? "left" : "right",
      sortValue: (row) => sortValueOf(row, key),
      render: (row) => {
        const cell = metricCell(key, row.fundamentals, masked);
        if (cell.rating) return <AiRatingChip rating={cell.rating} />;
        return cell.tone ? <span className={fund.tone} data-tone={cell.tone}>{cell.text}</span> : cell.text;
      },
    })),
  ];
  return (
    <div className={fund.tight}>
      <DenseTable caption="Fundamentals" columns={columns} rows={rows} rowKey={(row) => row.symbol} selectedKey={selected} onSelect={(row) => onSelect(row.symbol)} density="compact" />
    </div>
  );
}
