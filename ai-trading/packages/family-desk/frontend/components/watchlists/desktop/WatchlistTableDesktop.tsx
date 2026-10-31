"use client";

import { useRouter } from "next/navigation";
import { useDeskUi } from "@/components/shell/desktop/DeskContext";
import { DenseTable, type DenseColumn } from "@/components/ui/DenseTable";
import type { WatchlistTable } from "@/lib/api/schemas";
import { withPriorities } from "@/lib/desk/columns";
import { changeTone, formatPrice, formatRatio, formatSignedPct } from "@/lib/desk/format";
import { SYMBOL_HREF } from "@/lib/lanes";
import { biasTone } from "@/lib/desk/workspace";
import { strategyChips } from "@/lib/desk/watchlistView";
import styles from "./watchlistDesktop.module.css";

type Row = WatchlistTable["rows"][number];

// 1180 drops RVOL, then the bias label (lib/desk/columns.ts, BOARD_PRIORITIES.watchlist).
const COLUMNS = withPriorities<DenseColumn<Row>>(
  [
    {
      key: "symbol",
      label: "Symbol",
      fill: true,
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
      render: (row) => {
        const { shown, hidden } = strategyChips(row.tags);
        const rest = hidden.map((chip) => chip.text).join(", ");
        return (
          <>
            {shown.map((chip, index) => (
              <span key={index} className={chip.armed ? styles.armedChip : styles.chip} title={chip.text}>{chip.text}</span>
            ))}
            {hidden.length > 0 && (
              <span className={styles.chip} title={rest}>
                +{hidden.length}
                <span className={styles.srOnly}> more: {rest}</span>
              </span>
            )}
          </>
        );
      },
    },
  ],
  "watchlist",
);

export function WatchlistTableDesktop({ rows, dim }: { rows: WatchlistTable["rows"]; dim: boolean }) {
  const router = useRouter();
  // Watchlists is shared by Technical and Fundamental: a row opens that mode's symbol page (ADR-0014).
  const { lane } = useDeskUi();
  return (
    <DenseTable
      caption="Watchlist"
      columns={COLUMNS}
      rows={rows}
      rowKey={(row) => row.symbol}
      dim={dim}
      onSelect={(row) => {
        const href = SYMBOL_HREF[lane]?.(row.symbol);
        if (href) router.push(href);
      }}
      rowActions={(row) => (
        <a href={`/alerts/new?source=symbol:${encodeURIComponent(row.symbol)}`} className={styles.link}>+ Alert</a>
      )}
    />
  );
}
