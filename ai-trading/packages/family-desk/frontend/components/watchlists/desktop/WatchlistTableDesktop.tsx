"use client";

import { useRouter } from "next/navigation";
import { DenseTable, type DenseColumn } from "@/components/ui/DenseTable";
import type { WatchlistTable } from "@/lib/api/schemas";
import { withPriorities } from "@/lib/desk/columns";
import { changeTone, formatPrice, formatRatio, formatSignedPct } from "@/lib/desk/format";
import { symbolHref } from "@/lib/desk/listNav";
import { biasTone } from "@/lib/desk/workspace";
import { tagLine } from "@/lib/desk/watchlistView";
import styles from "./watchlistDesktop.module.css";

type Row = WatchlistTable["rows"][number];

// 1180 drops RVOL, then the bias label (lib/desk/columns.ts, BOARD_PRIORITIES.watchlist).
const COLUMNS = withPriorities<DenseColumn<Row>>(
  [
    {
      key: "symbol",
      label: "Symbol",
      render: (row) => (
        <span className={styles.symbol}>
          {row.symbol}
          <span className={styles.name}>{row.name}</span>
        </span>
      ),
    },
    { key: "last", label: "Last", align: "right", sortValue: (row) => row.last, render: (row) => formatPrice(row.last) },
    {
      key: "change_pct",
      label: "Chg %",
      align: "right",
      sortValue: (row) => row.change_pct,
      render: (row) => <span className={styles[changeTone(row.change_pct)]}>{formatSignedPct(row.change_pct)}</span>,
    },
    {
      key: "rvol_10d",
      label: "RVOL",
      align: "right",
      sortValue: (row) => row.rvol_10d,
      render: (row) => formatRatio(row.rvol_10d),
    },
    {
      key: "bias_label",
      label: "Bias",
      render: (row) => <span className={styles[biasTone(row.bias_label)]}>{row.bias_label}</span>,
    },
    {
      key: "tags",
      label: "Strategy",
      render: (row) =>
        tagLine(row.tags).map((text, index) => (
          <span key={index} className={row.tags[index]?.kind === "armed" ? styles.armedChip : styles.chip}>{text}</span>
        )),
    },
  ],
  "watchlist",
);

export function WatchlistTableDesktop({ rows, dim }: { rows: WatchlistTable["rows"]; dim: boolean }) {
  const router = useRouter();
  return (
    <DenseTable
      caption="Watchlist"
      columns={COLUMNS}
      rows={rows}
      rowKey={(row) => row.symbol}
      dim={dim}
      onSelect={(row) => router.push(symbolHref(row.symbol))}
      rowActions={(row) => (
        <a href={`/alerts/new?source=symbol:${encodeURIComponent(row.symbol)}`} className={styles.link}>+ Alert</a>
      )}
    />
  );
}
