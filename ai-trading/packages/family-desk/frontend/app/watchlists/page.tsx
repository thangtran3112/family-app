"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import Link from "next/link";
import { StrategySpecV1Schema } from "@ai-trading/contracts";
import { z } from "zod";
import { AddSymbol } from "@/components/watchlists/AddSymbol";
import { FlipCard } from "@/components/watchlists/FlipCard";
import { SlotMeter } from "@/components/watchlists/SlotMeter";
import { WatchlistTable } from "@/components/watchlists/WatchlistTable";
import { deskFetch } from "@/lib/api/client";
import {
  WatchlistOutSchema,
  WatchlistsResponseSchema,
  WatchlistItemsSchema,
  StrategyVersionsResponseSchema,
  StrategiesResponseSchema,
  SignalsResponseSchema,
} from "@/lib/api/schemas";
import { signalCountsBySymbol, signalsSinceEtStart } from "@/lib/watchlists/signals";
import styles from "@/components/watchlists/watchlists.module.css";

type Watchlist = ReturnType<typeof WatchlistsResponseSchema.parse>[number];
type Item = ReturnType<typeof WatchlistItemsSchema.parse>[number];
type Strategy = ReturnType<typeof StrategiesResponseSchema.parse>[number];
type Version = ReturnType<typeof StrategyVersionsResponseSchema.parse>[number];
type StrategyRow = { strategy: Strategy; currentVersion: Version | null };
type View = "rows" | "cards";

const horizons = ["intraday", "swing", "long_term"] as const;

function horizonLabel(value: string): string {
  return value === "long_term" ? "Long-term" : value === "intraday" ? "Intraday" : "Swing";
}

function strategyUsesList(version: Version | null, listName: string): boolean {
  if (!version) return false;
  const parsed = StrategySpecV1Schema.safeParse(version.spec);
  return parsed.success
    && "watchlist" in parsed.data.watch.universe
    && parsed.data.watch.universe.watchlist === listName;
}

export default function WatchlistsPage() {
  const [watchlists, setWatchlists] = useState<Watchlist[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState("");
  const [listRevision, setListRevision] = useState(0);
  const [listName, setListName] = useState("");
  const [horizon, setHorizon] = useState<(typeof horizons)[number]>("swing");
  const [creatingList, setCreatingList] = useState(false);
  const [createError, setCreateError] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [itemsError, setItemsError] = useState("");
  const [itemsRevision, setItemsRevision] = useState(0);
  const [removingSymbols, setRemovingSymbols] = useState<Set<string>>(new Set());
  const [strategies, setStrategies] = useState<StrategyRow[]>([]);
  const [strategiesLoading, setStrategiesLoading] = useState(true);
  const [strategiesError, setStrategiesError] = useState(false);
  const [strategiesRevision, setStrategiesRevision] = useState(0);
  const [signalResult, setSignalResult] = useState<{ key: string; counts: Record<string, number> } | null>(null);
  const [signalErrorKey, setSignalErrorKey] = useState<string | null>(null);
  const [signalRevision, setSignalRevision] = useState(0);
  const [view, setView] = useState<View>("rows");
  const [flippedSymbols, setFlippedSymbols] = useState<Set<string>>(new Set());

  const selected = watchlists.find(({ id }) => id === selectedId) ?? null;
  const signalKey = `${selectedId ?? "none"}:${items.map(({ symbol }) => symbol).join("\u0000")}`;
  const signalCounts = signalResult?.key === signalKey ? signalResult.counts : {};
  const signalsLoading = items.length > 0 && signalResult?.key !== signalKey && signalErrorKey !== signalKey;
  const signalsError = signalErrorKey === signalKey;
  const allFlipped = items.length > 0 && items.every(({ symbol }) => flippedSymbols.has(symbol));

  useEffect(() => {
    let current = true;
    void deskFetch("/api/desk/watchlists", WatchlistsResponseSchema).then((result) => {
      if (!current) return;
      setWatchlists(result);
      setSelectedId((selectedNow) => result.some(({ id }) => id === selectedNow) ? selectedNow : result[0]?.id ?? null);
      if (result.length) setItemsLoading(true);
    }).catch(() => {
      if (current) setListError("Could not load your watchlists. Retry to check the Desk API.");
    }).finally(() => { if (current) setListLoading(false); });
    return () => { current = false; };
  }, [listRevision]);

  useEffect(() => {
    let current = true;
    void deskFetch("/api/desk/strategies", StrategiesResponseSchema).then(async (rows) => {
      const withVersions = await Promise.all(rows.map(async (strategy) => {
        if (strategy.current_version_id === null) return { strategy, currentVersion: null };
        const versions = await deskFetch(`/api/desk/strategies/${strategy.id}/versions`, StrategyVersionsResponseSchema);
        return {
          strategy,
          currentVersion: versions.find(({ id }) => id === strategy.current_version_id) ?? null,
        };
      }));
      if (current) setStrategies(withVersions);
    }).catch(() => {
      if (current) setStrategiesError(true);
    }).finally(() => {
      if (current) setStrategiesLoading(false);
    });
    return () => { current = false; };
  }, [strategiesRevision]);

  useEffect(() => {
    if (selectedId === null) return;
    let current = true;
    void deskFetch(`/api/desk/watchlists/${selectedId}/items`, WatchlistItemsSchema).then((result) => {
      if (current) setItems(result);
    }).catch(() => {
      if (current) setItemsError("Could not load symbols for this watchlist. Retry to check the Desk API.");
    }).finally(() => {
      if (current) setItemsLoading(false);
    });
    return () => { current = false; };
  }, [selectedId, itemsRevision]);

  useEffect(() => {
    if (selectedId === null || !items.length) return;
    let current = true;
    const key = signalKey;
    const since = signalsSinceEtStart(new Date());
    void (async () => {
      const signals: { symbol: string }[] = [];
      for (let offset = 0; ; offset += 200) {
        const query = new URLSearchParams({ since, limit: "200", offset: String(offset) });
        const page = await deskFetch(`/api/desk/signals?${query.toString()}`, SignalsResponseSchema);
        signals.push(...page);
        if (page.length < 200) break;
      }
      return signalCountsBySymbol(signals);
    })().then((counts) => {
      if (current) {
        setSignalResult({ key, counts });
        setSignalErrorKey(null);
      }
    }).catch(() => {
      if (current) setSignalErrorKey(key);
    }).finally(() => {
      // The view derives loading from the active key and the last completed result.
    });
    return () => { current = false; };
  }, [items, selectedId, signalKey, signalRevision]);

  function retryWatchlists() {
    setListLoading(true);
    setListError("");
    setListRevision((value) => value + 1);
  }

  function retryStrategies() {
    setStrategiesLoading(true);
    setStrategiesError(false);
    setStrategiesRevision((value) => value + 1);
  }

  function refreshItems() {
    setItemsLoading(true);
    setItemsError("");
    setItemsRevision((value) => value + 1);
  }

  function chooseWatchlist(id: number) {
    if (id === selectedId) return;
    setSelectedId(id);
    setItems([]);
    setItemsLoading(true);
    setItemsError("");
    setFlippedSymbols(new Set());
  }

  async function createWatchlist(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!listName.trim()) return;
    setCreatingList(true);
    setCreateError("");
    try {
      const created = await deskFetch("/api/desk/watchlists", WatchlistOutSchema, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: listName, horizon }),
      });
      setWatchlists((rows) => [...rows, created]);
      setItems([]);
      setItemsLoading(true);
      setItemsError("");
      setSelectedId(created.id);
      setListName("");
    } catch (cause) {
      setCreateError(cause instanceof Error ? cause.message : "Could not create watchlist.");
    } finally {
      setCreatingList(false);
    }
  }

  async function removeSymbol(symbol: string) {
    if (selectedId === null) return;
    setRemovingSymbols((current) => new Set(current).add(symbol));
    try {
      const pathSymbol = encodeURIComponent(symbol);
      await deskFetch(`/api/desk/watchlists/${selectedId}/items/${pathSymbol}`, z.undefined(), { method: "DELETE" });
      setItemsRevision((value) => value + 1);
      setItemsLoading(true);
      setItemsError("");
      setFlippedSymbols((current) => {
        const next = new Set(current);
        next.delete(symbol);
        return next;
      });
    } catch (cause) {
      setItemsError(cause instanceof Error ? cause.message : "Could not remove symbol.");
    } finally {
      setRemovingSymbols((current) => {
        const next = new Set(current);
        next.delete(symbol);
        return next;
      });
    }
  }

  const usedBy = useMemo(() => selected
    ? strategies.filter(({ currentVersion }) => strategyUsesList(currentVersion, selected.name))
    : [], [selected, strategies]);

  function flipAll() {
    const next = !allFlipped;
    setFlippedSymbols(next ? new Set(items.map(({ symbol }) => symbol)) : new Set());
  }

  function flipOne(symbol: string) {
    const next = new Set(flippedSymbols);
    if (next.has(symbol)) next.delete(symbol);
    else next.add(symbol);
    setFlippedSymbols(next);
  }

  return (
    <main className={styles.page}>
      <header className={styles.pageHeader}>
        <div>
          <p className={styles.eyebrow}>MARKET DATA · OWNER WATCHLISTS</p>
          <h1>Watchlists</h1>
          <p className={styles.muted}>Prices and technicals use actual Desk data with source quality and as-of time.</p>
        </div>
        <SlotMeter />
      </header>

      <div className={styles.layout}>
        <aside className={styles.listRail} aria-label="Your watchlists">
          <h2>Your lists</h2>
          {listLoading && <p className={styles.feedback} role="status">Loading watchlists…</p>}
          {listError && <div className={styles.error} role="alert">{listError}<button className={styles.textButton} onClick={retryWatchlists} type="button">Retry</button></div>}
          <nav className={styles.listNav} aria-label="Select watchlist">
            {watchlists.map((watchlist) => (
              <button
                aria-pressed={selectedId === watchlist.id}
                className={`${styles.listChoice} ${selectedId === watchlist.id ? styles.listChoiceSelected : ""}`}
                key={watchlist.id}
                onClick={() => chooseWatchlist(watchlist.id)}
                type="button"
              >
                <span className={styles.listName}>{watchlist.name}</span>
                <span className={styles.horizon}>{horizonLabel(watchlist.horizon)}</span>
                <span className={styles.listMeta}>
                  {selectedId === watchlist.id
                    ? `${itemsLoading ? "Loading symbols…" : `${items.length} symbols`} · ${strategiesLoading ? "Loading strategies…" : strategiesError ? "Strategies unavailable" : `${usedBy.length} strategies`}`
                    : "Owned watchlist"}
                </span>
              </button>
            ))}
          </nav>
          <form className={styles.createList} onSubmit={createWatchlist}>
            <h3>Create a list</h3>
            <label className={styles.field}>
              <span>Name</span>
              <input autoComplete="off" maxLength={80} onChange={(event) => setListName(event.currentTarget.value)} required value={listName} />
            </label>
            <label className={styles.field}>
              <span>Horizon</span>
              <select onChange={(event) => setHorizon(event.currentTarget.value as (typeof horizons)[number])} value={horizon}>
                {horizons.map((value) => <option key={value} value={value}>{horizonLabel(value)}</option>)}
              </select>
            </label>
            <button className={styles.primaryButton} disabled={creatingList || !listName.trim()} type="submit">
              {creatingList ? "Creating…" : "Create watchlist"}
            </button>
            {createError && <p className={styles.error} role="alert">{createError}</p>}
          </form>
        </aside>

        <section className={styles.content} aria-labelledby="selected-watchlist-title">
          {selected ? <>
            <header className={styles.contentHeader}>
              <div>
                <p className={styles.eyebrow}>{horizonLabel(selected.horizon)}</p>
                <h2 id="selected-watchlist-title">{selected.name}</h2>
                <p className={styles.muted}>
                  {itemsLoading ? "Loading symbols" : `${items.length} symbols`} · {strategiesLoading ? "Loading current strategies" : strategiesError ? "Strategy data unavailable" : `${usedBy.length} current strategies watch this list`}
                </p>
              </div>
              <div className={styles.viewControls} aria-label="Watchlist view">
                <button aria-pressed={view === "rows"} onClick={() => setView("rows")} type="button">Rows</button>
                <button aria-pressed={view === "cards"} onClick={() => setView("cards")} type="button">Flip cards</button>
              </div>
            </header>
            <AddSymbol key={selected.id} onAdded={refreshItems} watchlistId={selected.id} />
            {itemsError && <div className={styles.error} role="alert">{itemsError}<button className={styles.textButton} onClick={refreshItems} type="button">Retry</button></div>}
            {signalsError && <div className={styles.error} role="alert">Could not load today&apos;s owned signals. Counts are unavailable, not zero.<button className={styles.textButton} onClick={() => { setSignalResult(null); setSignalErrorKey(null); setSignalRevision((value) => value + 1); }} type="button">Retry</button></div>}
            {itemsLoading && <p className={styles.feedback} role="status">Loading symbols…</p>}
            {!itemsLoading && !itemsError && items.length === 0 && (
              <div className={styles.emptyState}>
                <h3>No symbols in this list yet</h3>
                <p>Add a stock ticker or a slash-prefixed futures root. New items show backfill status from the API.</p>
              </div>
            )}
            {items.length > 0 && <>
              <div hidden={view !== "rows"}>
                <WatchlistTable
                  items={items}
                  listName={selected.name}
                  onRemove={removeSymbol}
                  removingSymbols={removingSymbols}
                  signalCounts={signalCounts}
                  signalsError={signalsError}
                  signalsLoading={signalsLoading}
                />
              </div>
              <div hidden={view !== "cards"}>
                <div className={styles.cardToolbar}>
                  <p className={styles.muted}>Focus a card and press F, or use its flip button.</p>
                  <button aria-pressed={allFlipped} className={styles.secondaryButton} onClick={flipAll} type="button">
                    {allFlipped ? "Show all fronts" : "Flip all"}
                  </button>
                </div>
                <div className={styles.cardGrid}>
                  {items.map((item) => (
                    <FlipCard
                      active={view === "cards"}
                      flipped={flippedSymbols.has(item.symbol)}
                      item={item}
                      key={item.symbol}
                      onFlip={() => flipOne(item.symbol)}
                      onRemove={() => removeSymbol(item.symbol)}
                      removing={removingSymbols.has(item.symbol)}
                    />
                  ))}
                </div>
              </div>
            </>}
          </> : <div className={styles.emptyState}>
            <h2>{listLoading ? "Loading your lists…" : watchlists.length ? "Select a watchlist" : "Create your first watchlist"}</h2>
            <p>{watchlists.length ? "Choose an owned list to see its actual symbols and data." : "Create a list here or start from Today. No sample watchlists or symbols are inserted."}</p>
            {!watchlists.length && <Link className={styles.primaryLink} href="/">Go to Today</Link>}
          </div>}
        </section>

        <aside className={styles.detailRail}>
          <section className={styles.sidePanel} aria-labelledby="used-by-title">
            <p className={styles.eyebrow} id="used-by-title">Used by</p>
            {strategiesLoading && <p className={styles.feedback} role="status">Loading current strategy versions…</p>}
            {strategiesError && <p className={styles.error} role="alert">Could not load owned strategies. <button className={styles.textButton} onClick={retryStrategies} type="button">Retry</button></p>}
            {!strategiesLoading && !strategiesError && selected && usedBy.length === 0 && (
              <p className={styles.muted}>No current strategy version watches this list.</p>
            )}
            {!strategiesLoading && !strategiesError && usedBy.map(({ strategy }) => (
              <a className={styles.strategyRow} href={`/strategies?id=${strategy.id}`} key={strategy.id}>
                <span>{strategy.name}</span>
                <span className={`${styles.stageBadge} ${strategy.stage === "draft" ? styles.stageDraft : ""}`}>
                  {strategy.stage === "draft" ? "Draft" : strategy.stage.replaceAll("_", " ")}
                </span>
              </a>
            ))}
            {selected && <p className={styles.muted}>Matched by exact watchlist name in each strategy&apos;s current version. Drafts remain drafts.</p>}
          </section>
          <section className={styles.sidePanel}>
            <p className={styles.eyebrow}>Backfill status</p>
            <p className={styles.muted}>Pending symbols are still waiting for stored history. Pending does not claim an active background job.</p>
          </section>
        </aside>
      </div>
    </main>
  );
}
