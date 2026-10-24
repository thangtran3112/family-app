"use client";

import { useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { useDeskUi } from "@/components/shell/desktop/DeskContext";
import { ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import { COPY } from "@/lib/desk/freshness";
import { loadLibrary } from "@/lib/desk/library";
import { LIBRARY_FOOTNOTE, categoryRows, filterPresets, type CategoryFilter } from "@/lib/desk/libraryView";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import { loadWatchlists } from "@/lib/desk/watchlists";
import { pickDefaultWatchlist } from "@/lib/desk/watchlistRail";
import { CategoryList } from "./CategoryList";
import { PresetList } from "./PresetList";
import { PresetPreview } from "./PresetPreview";
import styles from "./library.module.css";

/** D8 Strategy library (02m §a3.6): categories | presets | preview. Attach writes an alert-only strategy. */
export function LibraryScreen() {
  const searchParams = useSearchParams();
  const { selectedListId } = useDeskUi();
  const library = useDeskQuery("library", (signal) => loadLibrary({}, { signal }));
  const lists = useDeskQuery("library-lists", (signal) => loadWatchlists({ signal }));
  const [category, setCategory] = useState<CategoryFilter>("all");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pickedListId, setPickedListId] = useState<number | null>(null);

  const items = library.data ?? [];
  const listRows = lists.data ?? [];
  const visible = filterPresets(items, category, query);
  const selected = visible.find(({ id }) => id === selectedId) ?? visible[0] ?? null;
  // Attach target: her pick in the select, then ?watchlist= (from a list's "Add preset"), then the rail's list, then her default.
  const wanted = [pickedListId, Number(searchParams.get("watchlist")), selectedListId];
  const list = wanted.map((id) => listRows.find((row) => row.id === id)).find(Boolean) ?? pickDefaultWatchlist(listRows);

  let body: ReactNode;
  if (library.data === null) {
    body = library.error === null
      ? <LoadingBlock label="Loading presets…" height={240} />
      : <ErrorBlock message={COPY.libraryUnavailable} onRetry={library.refresh} />;
  } else {
    body = (
      <div className={styles.panes}>
        <CategoryList rows={categoryRows(items)} value={category} onChange={setCategory} />
        <div className={styles.listPane}>
          <PresetList items={visible} selectedId={selected?.id ?? null} onSelect={setSelectedId} query={query} onQuery={setQuery} />
          <p className={styles.footnote}>{LIBRARY_FOOTNOTE}</p>
        </div>
        {selected && (
          <PresetPreview key={selected.id} item={selected} listId={list?.id ?? null} listName={list?.name ?? null} />
        )}
      </div>
    );
  }

  return (
    <section className={styles.screen}>
      <header className={styles.header}>
        <h1 className={styles.title}>Strategy library</h1>
        {listRows.length > 0 && (
          <label className={styles.target}>
            Attach to list
            <select
              className={styles.input}
              value={list?.id ?? ""}
              onChange={(event) => setPickedListId(Number(event.target.value))}
            >
              {listRows.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
            </select>
          </label>
        )}
      </header>
      {body}
    </section>
  );
}
