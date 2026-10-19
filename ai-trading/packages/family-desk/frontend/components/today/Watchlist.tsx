"use client";

import { useEffect, useState } from "react";
import type { z } from "zod";
import { Labeled } from "../Labeled.tsx";
import type { Quote } from "../../lib/stream.ts";
import { openQuoteStream } from "../../lib/stream.ts";
import { BarsSchema } from "../../lib/api/schemas.ts";
import { firstChartSelection } from "../../lib/today-chart.ts";
import {
  countSignalsToday,
  dailyChange,
  derivedChangeQuality,
  formatChange,
  formatPrice,
  loadDailyBars,
  loadOwnedWatchlists,
  loadTodaySignals,
  marketSymbol,
  newYorkDate,
  previousDailyClose,
  quoteAsOfCaption,
  type AssetType,
  type TodaySignal,
  type TodaySignalsResult,
} from "../../lib/today.ts";
import type { Quality } from "../../lib/labels.ts";
import styles from "./today.module.css";

type OwnedWatchlist = Awaited<ReturnType<typeof loadOwnedWatchlists>>[number];
type WatchlistItem = OwnedWatchlist["items"][number];
type DailyBars = z.infer<typeof BarsSchema>;

function assetType(value: string): AssetType | null {
  return value === "stock" || value === "future" ? value : null;
}

export type TodaySelection = { symbol: string; asset_type: AssetType };

export function TodayWatchlist({
  selected,
  onSelect,
}: Readonly<{ selected: TodaySelection | null; onSelect: (selection: TodaySelection | null) => void }>) {
  const [watchlists, setWatchlists] = useState<OwnedWatchlist[] | null>(null);
  const [watchlistError, setWatchlistError] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [signalResult, setSignalResult] = useState<TodaySignalsResult | null>(null);
  const [signalsError, setSignalsError] = useState(false);

  useEffect(() => {
    let active = true;
    loadOwnedWatchlists()
      .then((items) => {
        if (!active) return;
        setWatchlists(items);
        setSelectedId((current) => items.some((item) => item.id === current) ? current : items[0]?.id ?? null);
        const firstSelection = firstChartSelection(items[0]?.items ?? []);
        if (firstSelection) onSelect(firstSelection);
      })
      .catch(() => {
        if (active) setWatchlistError(true);
      });
    return () => {
      active = false;
    };
  }, [onSelect]);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    loadTodaySignals(undefined, { signal: controller.signal })
      .then((result) => {
        if (active) setSignalResult(result);
      })
      .catch(() => {
        if (active) setSignalsError(true);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, []);

  const activeWatchlist = watchlists?.find((item) => item.id === selectedId) ?? watchlists?.[0];
  const today = newYorkDate(new Date().toISOString()) ?? "";

  return (
    <section className={`${styles.panel} ${styles.watchlistPanel}`} aria-labelledby="today-watchlist-title" aria-busy={watchlists === null && !watchlistError}>
      <header className={styles.panelHeading}>
        <div>
          <p className={styles.eyebrow}>OWNED SYMBOLS</p>
          <h2 id="today-watchlist-title">Watchlists</h2>
        </div>
        {activeWatchlist && <span className={styles.muted}>{activeWatchlist.items.length} symbols</span>}
      </header>
      {watchlistError ? (
        <p className={styles.error} role="alert">Watchlists could not be loaded. Try again later.</p>
      ) : watchlists === null ? (
        <p className={styles.muted} role="status">Loading watchlists…</p>
      ) : watchlists.length === 0 ? (
        <p className={styles.empty}>No watchlists yet.</p>
      ) : (
        <>
          {watchlists.length > 1 && (
            <div className={styles.watchlistTabs} aria-label="Choose watchlist">
              {watchlists.map((watchlist) => (
                <button
                  aria-pressed={watchlist.id === activeWatchlist?.id}
                  className={watchlist.id === activeWatchlist?.id ? styles.activeTab : styles.tab}
                  key={watchlist.id}
                  onClick={() => {
                    setSelectedId(watchlist.id);
                    onSelect(firstChartSelection(watchlist.items));
                  }}
                  type="button"
                >
                  {watchlist.name}
                </button>
              ))}
            </div>
          )}
          {!activeWatchlist || activeWatchlist.items.length === 0 ? (
            <p className={styles.empty}>No symbols in this watchlist.</p>
          ) : (
            <div className={styles.tableScroller}>
              <table className={styles.watchlistTable}>
                <thead>
                  <tr>
                    <th scope="col">Symbol</th>
                    <th scope="col">Last</th>
                    <th scope="col">Day</th>
                    <th scope="col">Signals</th>
                  </tr>
                </thead>
                <tbody>
                  {activeWatchlist.items.map((item) => (
                    <WatchlistRow
                      item={item}
                      key={`${item.asset_type}:${item.symbol}`}
                      selected={selected?.symbol === item.symbol && selected.asset_type === item.asset_type}
                      onSelect={onSelect}
                      signals={signalResult?.signals ?? null}
                      signalsComplete={signalResult?.complete === true}
                      signalsError={signalsError}
                      today={today}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {signalsError && <p className={styles.muted} role="status">Today&apos;s signal counts are unavailable.</p>}
          {signalResult && !signalResult.complete && !signalsError && (
            <p className={styles.muted} role="status">Today&apos;s signal totals are incomplete; exact counts are hidden.</p>
          )}
        </>
      )}
      <footer>
        <a className={styles.primaryLink} href="/watchlists">Manage watchlists</a>
      </footer>
    </section>
  );
}

function WatchlistRow({
  item,
  selected,
  onSelect,
  signals,
  signalsComplete,
  signalsError,
  today,
}: Readonly<{
  item: WatchlistItem;
  selected: boolean;
  onSelect: (selection: TodaySelection | null) => void;
  signals: TodaySignal[] | null;
  signalsComplete: boolean;
  signalsError: boolean;
  today: string;
}>) {
  const kind = assetType(item.asset_type);
  const apiSymbol = kind ? marketSymbol(item.symbol, kind) : item.symbol;
  const [quote, setQuote] = useState<Quote | null>(null);
  const [streamError, setStreamError] = useState(false);
  const [dailyBars, setDailyBars] = useState<DailyBars | null>(null);

  useEffect(() => {
    if (!kind) return;
    return openQuoteStream(apiSymbol, (nextQuote) => {
      setQuote(nextQuote);
      setStreamError(false);
    }, () => setStreamError(true));
  }, [apiSymbol, kind]);

  useEffect(() => {
    let active = true;
    if (!kind) return () => { active = false; };
    loadDailyBars(item.symbol, kind)
      .then((result) => {
        if (active) setDailyBars(result);
      })
      .catch(() => {
        if (active) setDailyBars(null);
      });
    return () => {
      active = false;
    };
  }, [item.symbol, kind]);

  const previousClose = quote ? previousDailyClose(dailyBars?.bars ?? [], quote.as_of) : null;
  const change = quote ? dailyChange(quote.close, previousClose) : null;
  const changeProvenance = derivedChangeQuality(
    change,
    quote?.quality ?? null,
    dailyBars?.quality ?? null,
  );
  const signalCount = signalsError || signals === null || !signalsComplete || !today || !kind
    ? null
    : countSignalsToday(signals, { symbol: item.symbol, asset_type: kind }, today);
  const priceQuality: Quality = quote?.quality ?? "unavailable";

  return (
    <tr>
      <th scope="row" className={styles.symbolCell}>
        {kind ? (
          <button
            aria-label={`Show chart for ${item.symbol}`}
            aria-pressed={selected}
            className={selected ? styles.symbolSelected : styles.symbolButton}
            onClick={() => onSelect({ symbol: item.symbol, asset_type: kind })}
            type="button"
          >
            {item.symbol}
          </button>
        ) : <span>{item.symbol}</span>}
        <span className={styles.symbolMeta}>
          {kind ? kind : "unsupported asset"}{item.backfill === "pending" ? " · backfilling" : ""}
        </span>
      </th>
      <td>
        <Labeled label="Last" value={formatPrice(quote?.close)} quality={priceQuality} />
        {quote && <span className={styles.asOf}>{quoteAsOfCaption(quote.as_of, quote.quality)}</span>}
        {streamError && !quote && <span className={styles.symbolMeta}>Stream unavailable</span>}
      </td>
      <td>
        <Labeled
          label="Daily change"
          value={formatChange(change)}
          quality={changeProvenance.quality}
          baselineQuality={changeProvenance.baselineQuality}
        />
      </td>
      <td><span className={styles.signalCount}>{signalCount ?? "not available"}</span></td>
    </tr>
  );
}
