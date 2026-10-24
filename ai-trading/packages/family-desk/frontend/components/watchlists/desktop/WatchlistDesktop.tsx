"use client";

import { useState, type ReactNode } from "react";
import { useDeskStatus, useDeskUi } from "@/components/shell/desktop/DeskContext";
import { RightRail } from "@/components/shell/desktop/RightRail";
import { AddSymbol } from "@/components/watchlists/AddSymbol";
import { FreshnessBadge } from "@/components/ui/FreshnessBadge";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import { COPY } from "@/lib/desk/freshness";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import { loadWatchlistItems, loadWatchlists, loadWatchlistTable } from "@/lib/desk/watchlists";
import { pickDefaultWatchlist } from "@/lib/desk/watchlistRail";
import { slotsText } from "@/lib/watchlists/slots";
import { ManageMode } from "./ManageMode";
import { StrategiesOnList } from "./StrategiesOnList";
import { WatchlistTableDesktop } from "./WatchlistTableDesktop";
import styles from "./watchlistDesktop.module.css";

/** D7 Watchlists (02m §a3.5): one list's dense table, manage mode, and the strategies on it in the right rail. */
export function WatchlistDesktop() {
  const { selectedListId, setSelectedListId, invalidate } = useDeskUi();
  const { status } = useDeskStatus();
  const slots = status?.streaming_slots ?? null;
  const [manage, setManage] = useState(false);
  const lists = useDeskQuery("watchlists", (signal) => loadWatchlists({ signal }));
  const listRows = lists.data ?? [];
  // A selection that is no longer one of her lists (just deleted) falls back to the default list.
  const activeId = listRows.some((list) => list.id === selectedListId) ? selectedListId : (pickDefaultWatchlist(listRows)?.id ?? null);
  const active = listRows.find((list) => list.id === activeId) ?? null;
  const table = useDeskQuery(
    `watchlist-table:${activeId}`,
    (signal) => loadWatchlistTable(activeId ?? 0, { signal }),
    { intervalMs: 60_000, enabled: activeId !== null },
  );
  const items = useDeskQuery(`watchlist-items:${activeId}`, (signal) => loadWatchlistItems(activeId ?? 0, { signal }), { enabled: activeId !== null });

  function refreshSymbols() {
    table.refresh();
    items.refresh();
    invalidate("watchlists");
  }

  function deleted() {
    const next = listRows.find((list) => list.id !== activeId);
    if (next) setSelectedListId(next.id);
    setManage(false);
    listsChanged();
  }

  // The left rail shows the same lists: tell it too.
  function listsChanged() {
    lists.refresh();
    invalidate("watchlists");
  }

  let body: ReactNode;
  if (lists.data === null) {
    body = lists.error === null ? <LoadingBlock label="Loading watchlists…" /> : <ErrorBlock subject="watchlist" onRetry={lists.refresh} />;
  } else if (manage) {
    body = active && items.data === null
      ? items.error === null ? <LoadingBlock label="Loading symbols…" /> : <ErrorBlock subject="watchlist" onRetry={items.refresh} />
      : (
        <ManageMode
          key={activeId ?? "none"}
          list={active}
          lists={listRows}
          items={items.data ?? []}
          onChanged={refreshSymbols}
          onListsChanged={listsChanged}
          onDeleted={deleted}
        />
      );
  } else if (active === null) {
    body = (
      <EmptyBlock title="Add symbols to start watching">
        <button type="button" className={`${styles.button} ${styles.primary}`} onClick={() => setManage(true)}>Create a list</button>
      </EmptyBlock>
    );
  } else if (table.data === null) {
    body = table.error === null ? <LoadingBlock label="Loading symbols…" /> : <ErrorBlock subject="watchlist" onRetry={table.refresh} />;
  } else if (table.data.rows.length === 0) {
    body = (
      <EmptyBlock title="Add symbols to start watching">
        <AddSymbol watchlistId={active.id} onAdded={refreshSymbols} />
      </EmptyBlock>
    );
  } else {
    const backfilling = (items.data ?? []).filter((item) => item.backfill === "pending").length;
    body = (
      <>
        {table.updating && <p className={styles.caption}>{COPY.updating}</p>}
        {backfilling > 0 && (
          <p className={styles.caption}>Backfilling history for {backfilling} {backfilling === 1 ? "symbol" : "symbols"}</p>
        )}
        <WatchlistTableDesktop rows={table.data.rows} dim={table.connection === "reconnecting"} />
      </>
    );
  }

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <div className={styles.titleGroup}>
          <h1 className={styles.title}>{active?.name ?? "Watchlists"}</h1>
          {active && <FreshnessBadge stamp={table.data?.stamp ?? null} connection={table.connection} />}
        </div>
        <div className={styles.actions}>
          <button type="button" className={styles.button} aria-pressed={manage} onClick={() => setManage(!manage)}>Manage</button>
          <span className={styles.slots}>Quote slots: {slotsText(slots)}</span>
        </div>
      </header>
      <div className={styles.body}>{body}</div>
      {active && (
        <RightRail
          label="Strategies on this list"
          sections={[{ id: "strategies", label: "Strategies", node: <StrategiesOnList listId={active.id} listName={active.name} /> }]}
        />
      )}
    </div>
  );
}
