"use client";

import type { ReactNode } from "react";
import { Delta } from "@/components/ui/Delta";
import { DenseTable, type DenseColumn } from "@/components/ui/DenseTable";
import { useFreshness } from "@/components/ui/Freshness";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import type { WatchlistTableRow } from "@/lib/api/schemas";
import { formatPrice } from "@/lib/desk/format";
import { COPY } from "@/lib/desk/freshness";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import type { ShellBand } from "@/lib/desk/viewport";
import { loadWatchlists, loadWatchlistTable } from "@/lib/desk/watchlists";
import { pickDefaultWatchlist } from "@/lib/desk/watchlistRail";
import { SYMBOL_HREF } from "@/lib/lanes";
import { useDeskUi } from "./DeskContext";
import { ListSwitcher } from "./ListSwitcher";
import styles from "./leftrail.module.css";

export function WatchlistsPanel({ band }: { band: ShellBand }) {
  const { lane, selectedListId, setSelectedListId, revisions } = useDeskUi();
  const lists = useDeskQuery("rail-watchlists", (signal) => loadWatchlists({ signal }), { revision: revisions.watchlists });
  const listRows = lists.data ?? [];
  const activeId = selectedListId ?? pickDefaultWatchlist(listRows)?.id ?? null;
  // The fetcher only runs while `enabled` is true, so the `?? 0` fallback is never requested.
  const table = useDeskQuery(
    `rail-table-${activeId}`,
    (signal) => loadWatchlistTable(activeId ?? 0, { signal }),
    { intervalMs: 60_000, enabled: activeId !== null, revision: revisions.watchlists },
  );
  const stale = useFreshness({ stamp: table.data?.stamp ?? null, connection: table.connection }).stale;

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
      fill: true,
      render: (row) => {
        // A symbol opens the mode's own symbol page (ADR-0014). Backtest has none, and no Practice route shows this rail.
        const href = SYMBOL_HREF[lane]?.(row.symbol);
        const text = (
          <>
            {row.symbol}
            {band === "1440" && <span className={styles.name}>{row.name}</span>}
          </>
        );
        if (!href) return <span className={styles.symbol}>{text}</span>;
        return <a href={href} className={styles.symbol}>{text}</a>;
      },
    },
    { key: "last", label: "Last", align: "right", render: (row) => formatPrice(row.last) },
    {
      key: "change",
      label: "Chg %",
      align: "right",
      render: (row) => <Delta value={row.change_pct} />,
    },
    {
      key: "tag",
      label: "Tag",
      render: (row) => {
        if (row.tags.length === 0) return null;
        const labels = row.tags.map((tag) => tag.label).join(", ");
        return (
          <span className={styles.tagDot} title={labels}>
            <span className="sr-only">Strategy tag: {labels}</span>
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
          dim={stale}
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
