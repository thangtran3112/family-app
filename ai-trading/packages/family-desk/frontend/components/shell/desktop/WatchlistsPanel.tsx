"use client";

import type { ReactNode } from "react";
import { DenseTable, type DenseColumn } from "@/components/ui/DenseTable";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import type { WatchlistTableRow } from "@/lib/api/schemas";
import { changeTone, formatPrice, formatSignedPct } from "@/lib/desk/format";
import { COPY } from "@/lib/desk/freshness";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import type { ShellBand } from "@/lib/desk/viewport";
import { loadWatchlists, loadWatchlistTable } from "@/lib/desk/watchlists";
import { pickDefaultWatchlist } from "@/lib/desk/watchlistRail";
import { useDeskUi } from "./DeskContext";
import { ListSwitcher } from "./ListSwitcher";
import styles from "./leftrail.module.css";

export function WatchlistsPanel({ band }: { band: ShellBand }) {
  const { selectedListId, setSelectedListId } = useDeskUi();
  const lists = useDeskQuery("rail-watchlists", (signal) => loadWatchlists({ signal }));
  const listRows = lists.data ?? [];
  const activeId = selectedListId ?? pickDefaultWatchlist(listRows)?.id ?? null;
  // The fetcher only runs while `enabled` is true, so the `?? 0` fallback is never requested.
  const table = useDeskQuery(
    `rail-table-${activeId}`,
    (signal) => loadWatchlistTable(activeId ?? 0, { signal }),
    { intervalMs: 60_000, enabled: activeId !== null },
  );

  const empty = (
    <EmptyBlock title="Add symbols to start watching">
      <a href="/watchlists" className={styles.link}>Open Watchlists</a>
    </EmptyBlock>
  );

  if (lists.data === null) {
    return lists.error === null ? <LoadingBlock label="Loading watchlists…" /> : <ErrorBlock subject="watchlist" onRetry={lists.refresh} />;
  }
  if (activeId === null) return empty;

  const columns: DenseColumn<WatchlistTableRow>[] = [
    {
      key: "symbol",
      label: "Symbol",
      render: (row) => (
        <a href={`/technicals?symbol=${encodeURIComponent(row.symbol)}#chart`} className={styles.symbol}>
          {row.symbol}
          {band === "1440" && <span className={styles.name}>{row.name}</span>}
        </a>
      ),
    },
    { key: "last", label: "Last", align: "right", render: (row) => formatPrice(row.last) },
    {
      key: "change",
      label: "Chg %",
      align: "right",
      render: (row) => <span className={styles[changeTone(row.change_pct)]}>{formatSignedPct(row.change_pct)}</span>,
    },
    {
      key: "tag",
      label: "Tag",
      render: (row) => {
        if (row.tags.length === 0) return null;
        const labels = row.tags.map((tag) => tag.label).join(", ");
        return (
          <span className={styles.tagDot} title={labels}>
            <span className={styles.srOnly}>Strategy tag: {labels}</span>
          </span>
        );
      },
    },
  ];

  let body: ReactNode;
  if (table.data === null) {
    body = table.error === null ? <LoadingBlock label="Loading symbols…" /> : <ErrorBlock subject="watchlist" onRetry={table.refresh} />;
  } else {
    body = (
      <>
        {table.updating && <p className={styles.caption}>{COPY.updating}</p>}
        <DenseTable
          caption="Watchlist symbols"
          columns={columns}
          rows={table.data.rows}
          rowKey={(row) => row.symbol}
          band={band}
          density="compact"
          dim={table.connection === "reconnecting"}
          empty={empty}
        />
      </>
    );
  }

  return (
    <div className={styles.body}>
      <ListSwitcher lists={listRows} value={activeId} onChange={setSelectedListId} />
      {body}
    </div>
  );
}
