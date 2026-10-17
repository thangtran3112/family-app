"use client";

import { useEffect, useState, type KeyboardEvent } from "react";
import { BarsSchema, TechnicalsSchema, WatchlistItemsSchema } from "@/lib/api/schemas";
import { deskFetch } from "@/lib/api/client";
import { BiasGauge } from "@/components/technicals/Gauges";
import { loadTechnicalData } from "@/lib/technicals/load";
import { qualityLabel } from "@/lib/labels";
import { openQuoteStream, type Quote } from "@/lib/stream.ts";
import { cardBackValue } from "@/lib/watchlists/cardBack";
import { strategyContextHref } from "@/lib/watchlists/context";
import styles from "./watchlists.module.css";

type Item = ReturnType<typeof WatchlistItemsSchema.parse>[number];
type Bars = ReturnType<typeof BarsSchema.parse>;
type Technicals = ReturnType<typeof TechnicalsSchema.parse>;
type Timeframe = "5m" | "15m" | "1h" | "1D" | "1W";

const timeframes: Timeframe[] = ["5m", "15m", "1h", "1D", "1W"];
const timeframeApi: Record<Timeframe, string> = {
  "5m": "5m",
  "15m": "15m",
  "1h": "1h",
  "1D": "1d",
  "1W": "1w",
};

export function FlipCard({
  item,
  active,
  flipped,
  onFlip,
  onRemove,
  removing,
}: {
  item: Item;
  active: boolean;
  flipped: boolean;
  onFlip: () => void;
  onRemove: () => void;
  removing: boolean;
}) {
  const [timeframe, setTimeframe] = useState<Timeframe>("15m");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [data, setData] = useState<{ symbol: string; timeframe: Timeframe; bars: Bars; technicals: Technicals } | null>(null);
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const [retryRevision, setRetryRevision] = useState(0);
  const requestKey = `${item.symbol}:${timeframe}`;
  const dataIsCurrent = data?.symbol === item.symbol && data.timeframe === timeframe;
  const bars = dataIsCurrent ? data.bars : null;
  const technicals = dataIsCurrent ? data.technicals : null;
  const loading = active && !dataIsCurrent && failedKey !== requestKey;
  const error = failedKey === requestKey;

  useEffect(() => {
    if (!active) return;
    return openQuoteStream(item.symbol, setQuote);
  }, [active, item.symbol]);

  useEffect(() => {
    if (!active) return;
    let current = true;
    void loadTechnicalData(item.symbol, timeframeApi[timeframe], {
      bars: (path) => deskFetch(path, BarsSchema),
      technicals: (path) => deskFetch(path, TechnicalsSchema),
    }).then(({ bars: nextBars, technicals: nextTechnicals }) => {
      if (!current) return;
      setData({ symbol: item.symbol, timeframe, bars: nextBars, technicals: nextTechnicals });
      setFailedKey(null);
    }).catch(() => {
      if (current) setFailedKey(requestKey);
    });
    return () => { current = false; };
  }, [active, item.symbol, timeframe, retryRevision, requestKey]);

  function setTimeframeAndClear(next: Timeframe) {
    setFailedKey(null);
    setTimeframe(next);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    const target = event.target;
    if (event.key.toLowerCase() !== "f" || event.repeat || target instanceof HTMLElement && (
      target.isContentEditable || target.matches("input, textarea, select")
    )) return;
    event.preventDefault();
    onFlip();
  }

  const barClose = bars?.bars.at(-1)?.c;
  const price = quote?.close ?? barClose;
  const priceQuality = quote?.quality ?? bars?.quality ?? "unavailable";
  const priceAsOf = quote?.as_of ?? bars?.as_of ?? null;
  const signal = !technicals
    ? "not available"
    : technicals.quality === "unavailable"
    ? "Unavailable"
    : technicals.gauges.summary.label;
  const query = new URLSearchParams({ symbol: item.symbol, timeframe: timeframeApi[timeframe] });
  const strategyHref = strategyContextHref(item.symbol, timeframeApi[timeframe], "summary");

  return (
    <article className={styles.flipCard} onKeyDown={handleKeyDown} tabIndex={0} aria-label={`${item.symbol} technicals flip card`}>
      <div className={styles.cardHeading}>
        <div>
          <strong className={styles.symbol}>{item.symbol}</strong>
          <span className={styles.assetType}>{item.asset_type === "future" ? "Future" : "Stock"}</span>
          {item.backfill === "pending" && <span className={styles.pending}>Backfilling history</span>}
        </div>
        <button
          aria-label={flipped ? `Show ${item.symbol} price front` : `Show ${item.symbol} technical back`}
          className={styles.flipButton}
          onClick={onFlip}
          type="button"
        >
          Flip
        </button>
      </div>

      <div className={`${styles.cardFace} ${flipped ? styles.cardFaceHidden : ""}`} aria-hidden={flipped} inert={flipped}>
        <div className={styles.priceLine}>
          <strong className={styles.cardPrice}>{cardBackValue(price)}</strong>
          <span className={styles.signalGroup}>
            <span className={styles.signalTag}>{loading ? "Loading signal…" : signal}</span>
            {technicals && <span className={styles.sourceLine}>Signal · {qualityLabel(technicals.quality)} · {technicals.as_of ?? "as of unavailable"}</span>}
          </span>
        </div>
        <p className={styles.sourceLine}>
          {qualityLabel(priceQuality)} · {priceAsOf ? `as of ${priceAsOf}` : "as of unavailable"}
        </p>
        <div className={styles.timeframes} aria-label={`${item.symbol} card timeframe`}>
          {timeframes.map((option) => (
            <button
              aria-pressed={timeframe === option}
              key={option}
              onClick={() => setTimeframeAndClear(option)}
              type="button"
            >{option}</button>
          ))}
        </div>
        {error && <div className={styles.error} role="alert">Could not load actual bars and technicals. <button className={styles.textButton} onClick={() => { setFailedKey(null); setRetryRevision((value) => value + 1); }} type="button">Retry</button></div>}
        {loading && <p className={styles.feedback} role="status">Loading {timeframe} data…</p>}
        <div className={styles.frontActions}>
          <a href={`/technicals?${query.toString()}`}>Full technicals</a>
          <button className={styles.primaryButton} onClick={onFlip} type="button">View card back</button>
        </div>
      </div>

      <div className={`${styles.cardFace} ${!flipped ? styles.cardFaceHidden : ""}`} aria-hidden={!flipped} inert={!flipped}>
        {technicals ? <>
          <p className={styles.sourceLine}>Backend technicals · {qualityLabel(technicals.quality)} · {technicals.as_of ?? "as of unavailable"}</p>
          <BiasGauge
            asOf={technicals.as_of}
            gauge={technicals.gauges.summary}
            quality={technicals.quality}
            title="Desk Technical Bias"
            unavailable={technicals.quality === "unavailable"}
          />
          <p className={styles.cardBackBias}>
            Card back · {technicals.card_back.bias_label ?? "not available"} · {cardBackValue(technicals.card_back.bias_score)}
          </p>
          <section className={styles.metricBlock} aria-label="Backend oscillator values">
            <h3>Oscillators · {qualityLabel(technicals.quality)} · {technicals.as_of ?? "as of unavailable"}</h3>
            <dl>{Object.entries(technicals.card_back.oscillators).map(([name, value]) => (
              <div key={name}><dt>{name.replaceAll("_", " ")}</dt><dd>{cardBackValue(value)}</dd></div>
            ))}</dl>
          </section>
          <section className={styles.metricBlock} aria-label="Backend moving average values">
            <h3>Moving averages · {qualityLabel(technicals.quality)} · {technicals.as_of ?? "as of unavailable"}</h3>
            <dl>{Object.entries(technicals.card_back.moving_averages).map(([name, value]) => (
              <div key={name}><dt>{name.replaceAll("_", " ")}</dt><dd>{cardBackValue(value)}</dd></div>
            ))}</dl>
          </section>
          <section className={styles.metricBlock} aria-label="Non-voting volatility">
            <h3>Volatility · no vote · {qualityLabel(technicals.quality)} · {technicals.as_of ?? "as of unavailable"}</h3>
            <dl>
              <div><dt>ATR (14)</dt><dd>{cardBackValue(technicals.volatility.atr14)}</dd></div>
              <div><dt>ATR as % of price</dt><dd>{technicals.volatility.atr_percent === null ? "not available" : `${cardBackValue(technicals.volatility.atr_percent)}%`}</dd></div>
              <div><dt>Volatility label</dt><dd>{technicals.quality === "unavailable" ? "Unavailable" : technicals.volatility.label ?? "Warming up"}</dd></div>
            </dl>
          </section>
          <section className={styles.metricBlock} aria-label="Backend pivot values">
            <h3>Pivots · {qualityLabel(technicals.quality)} · {technicals.as_of ?? "as of unavailable"}</h3>
            <dl>{Object.entries(technicals.card_back.pivots).map(([name, value]) => (
              <div key={name}><dt>{name}</dt><dd>{cardBackValue(value)}</dd></div>
            ))}</dl>
            {!Object.keys(technicals.card_back.pivots).length && <p>Not available</p>}
          </section>
        </> : <p className={styles.feedback}>{loading ? "Loading actual backend values…" : "Backend technicals not available."}</p>}
        <p className={styles.pending}>Make strategy opens a reviewable draft setup; it does not save or activate it.</p>
        <div className={styles.frontActions}>
          <a href={`/technicals?${query.toString()}`}>Full technicals</a>
          <a className={styles.primaryLink} href={strategyHref}>Make strategy</a>
        </div>
        <button className={styles.removeButton} disabled={removing} onClick={onRemove} type="button">
          {removing ? "Removing…" : `Remove ${item.symbol}`}
        </button>
      </div>
    </article>
  );
}
