"use client";

import { useRouter } from "next/navigation";
import { DenseTable, type DenseColumn } from "@/components/ui/DenseTable";
import { EmptyBlock } from "@/components/ui/StateBlocks";
import type { Dashboard } from "@/lib/api/schemas";
import { withPriorities } from "@/lib/desk/columns";
import { changeTone, formatPrice, formatRatio, formatSignedPct } from "@/lib/desk/format";
import { symbolHref } from "@/lib/desk/listNav";
import { biasTone } from "@/lib/desk/workspace";
import styles from "./dashboard.module.css";

type Row = Dashboard["watchlist"]["rows"][number];

const signed = (value: number | null) => (
  <span className={styles.tone} data-tone={changeTone(value)}>{formatSignedPct(value)}</span>
);

// 1180 drops vs VWAP, then RVOL (BOARD_PRIORITIES.dashboard); DenseTable reads the priorities.
const COLUMNS = withPriorities<DenseColumn<Row>>(
  [
    { key: "symbol", label: "Symbol", render: (row) => row.symbol, sortValue: (row) => row.symbol },
    { key: "last", label: "Last", align: "right", render: (row) => formatPrice(row.last), sortValue: (row) => row.last },
    { key: "change_pct", label: "Change %", align: "right", render: (row) => signed(row.change_pct), sortValue: (row) => row.change_pct },
    { key: "rvol_10d", label: "RVOL", align: "right", render: (row) => formatRatio(row.rvol_10d), sortValue: (row) => row.rvol_10d },
    { key: "vs_vwap_pct", label: "vs VWAP", align: "right", render: (row) => signed(row.vs_vwap_pct), sortValue: (row) => row.vs_vwap_pct },
    {
      key: "bias_label",
      label: "Bias",
      render: (row) => <span className={styles.tone} data-tone={biasTone(row.bias_label)}>{row.bias_label}</span>,
      sortValue: (row) => row.bias_label,
    },
  ],
  "dashboard",
);

export function WatchlistHeat({ watchlist, dim }: { watchlist: Dashboard["watchlist"]; dim: boolean }) {
  const router = useRouter();
  return (
    <section className={styles.panel}>
      <h2 className={styles.panelTitle}>{watchlist.name}</h2>
      <DenseTable
        caption="Watchlist heat"
        columns={COLUMNS}
        rows={watchlist.rows}
        rowKey={(row) => row.symbol}
        onSelect={(row) => router.push(symbolHref(row.symbol))}
        dim={dim}
        empty={<EmptyBlock title="Add symbols to start watching" />}
      />
    </section>
  );
}
