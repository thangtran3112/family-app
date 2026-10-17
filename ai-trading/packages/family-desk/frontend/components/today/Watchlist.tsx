"use client";

import { useEffect, useState } from "react";
import type { z } from "zod";
import { Labeled } from "../Labeled.tsx";
import type { Quote } from "../../lib/stream.ts";
import { openQuoteStream } from "../../lib/stream.ts";
import { BarsSchema } from "../../lib/api/schemas.ts";
import {
  countSignalsToday,
  dailyChange,
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
} from "../../lib/today.ts";
import type { Quality } from "../../lib/labels.ts";
import styles from "./today.module.css";

type OwnedWatchlist = Awaited<ReturnType<typeof loadOwnedWatchlists>>[number];
type WatchlistItem = OwnedWatchlist["items"][number];
type DailyBars = z.infer<typeof BarsSchema>;

function assetType(value: string): AssetType | null {
  return value === "stock" || value === "future" ? value : null;
}

export function TodayWatchlist() {
  const [watchlists, setWatchlists] = useState<OwnedWatchlist[] | null>(null);
  const [watchlistError, setWatchlistError] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [signals, setSignals] = useState<TodaySignal[] | null>(null);
  const [signalsError, setSignalsError] = useState(false);

  useEffect(() => {
    let active = true;
    loadOwnedWatchlists()
      .then((items) => {
        if (!active) return;
        setWatchlists(items);
        setSelectedId((current) => items.some((item) => item.id === current) ? current : items[0]?.id ?? null);
      })
      .catch(() => {
        if (active) setWatchlistError(true);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    loadTodaySignals()
      .then((items) => {
        if (active) setSignals(items);
      })
      .catch(() => {
        if (active) setSignalsError(true);
      });
    return () => {
      active = false;
    };
  }, []);

  const selected = watchlists?.find((item) => item.id === selectedId) ?? watchlists?.[0];
  const today = newYorkDate(new Date().toISOString()) ?? "";

  return (
    <section className={`${styles.panel} ${styles.watchlistPanel}`} aria-labelledby="today-watchlist-title" aria-busy={watchlists === null && !watchlistError}>
      <header className={styles.panelHeading}>
        <div>
          <p className={styles.eyebrow}>OWNED SYMBOLS</p>
          <h2 id="today-watchlist-title">Watchlists</h2>
        </div>
        {selected && <span className={styles.muted}>{selected.items.length} symbols</span>}
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
                  aria-pressed={watchlist.id === selected?.id}
                  className={watchlist.id === selected?.id ? styles.activeTab : styles.tab}
                  key={watchlist.id}
                  onClick={() => setSelectedId(watchlist.id)}
                  type="button"
                >
                  {watchlist.name}
                </button>
              ))}
            </div>
          )}
          {!selected || selected.items.length === 0 ? (
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
                  {selected.items.map((item) => (
                    <WatchlistRow
                      item={item}
                      key={`${item.asset_type}:${item.symbol}`}
                      signals={signals}
                      signalsError={signalsError}
                      today={today}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {signalsError && <p className={styles.muted} role="status">Today&apos;s signal counts are unavailable.</p>}
        </>
      )}
    </section>
  );
}

function WatchlistRow({
  item,
  signals,
  signalsError,
  today,
}: Readonly<{ item: WatchlistItem; signals: TodaySignal[] | null; signalsError: boolean; today: string }>) {
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
  const signalCount = signalsError || signals === null || !today || !kind
    ? null
    : countSignalsToday(signals, item.symbol, today);
  const priceQuality: Quality = quote?.quality ?? "unavailable";
  const changeQuality: Quality = dailyBars?.quality ?? "unavailable";

  return (
    <tr>
      <th scope="row" className={styles.symbolCell}>
        <span>{item.symbol}</span>
        <span className={styles.symbolMeta}>
          {kind ? kind : "unsupported asset"}{item.backfill === "pending" ? " · backfilling" : ""}
        </span>
      </th>
      <td>
        <Labeled label="Last" value={formatPrice(quote?.close)} quality={priceQuality} />
        {quote && <span className={styles.asOf}>{quoteAsOfCaption(quote.as_of, quote.quality)}</span>}
        {streamError && !quote && <span className={styles.symbolMeta}>Stream unavailable</span>}
      </td>
      <td><Labeled label="Daily change" value={formatChange(change)} quality={changeQuality} /></td>
      <td><span className={styles.signalCount}>{signalCount ?? "not available"}</span></td>
    </tr>
  );
}
