"use client";

import { useEffect, useMemo, useState } from "react";
import type { z } from "zod";
import { MarketChart } from "../charts/MarketChart.tsx";
import { Labeled } from "../Labeled.tsx";
import { PositionFixture } from "./PositionFixture.tsx";
import { BarsSchema } from "../../lib/api/schemas.ts";
import { deskFetch } from "../../lib/api/client.ts";
import type { Quote } from "../../lib/stream.ts";
import { openQuoteStream } from "../../lib/stream.ts";
import { formatPrice, marketSymbol, quoteAsOfCaption } from "../../lib/today.ts";
import {
  chartBarsPath,
  chartContextKey,
  chartPresentation,
  chartResponseMatchesSelection,
  chartSnapshotFor,
  TODAY_CHART_INTERVALS,
  type TodayChartInterval,
  type TodayChartSelection,
} from "../../lib/today-chart.ts";
import styles from "./today.module.css";

type Bars = z.infer<typeof BarsSchema>;

const intervalLabels: Record<TodayChartInterval, string> = {
  "1m": "1m",
  "5m": "5m",
  "15m": "15m",
  "30m": "30m",
  "1h": "1h",
  "4h": "4h",
  "1d": "1D",
  "1w": "1W",
};

export function PriceChart({ symbol, assetType }: Readonly<{ symbol: string; assetType: "stock" | "future" }>) {
  const [interval, setInterval] = useState<TodayChartInterval>("5m");
  const [quoteState, setQuoteState] = useState<{ symbol: string; quote: Quote } | null>(null);
  const [quoteErrorSymbol, setQuoteErrorSymbol] = useState<string | null>(null);
  const apiSymbol = marketSymbol(symbol, assetType);
  const quote = quoteState?.symbol === apiSymbol ? quoteState.quote : null;

  useEffect(() => openQuoteStream(apiSymbol, (next) => {
    setQuoteState({ symbol: apiSymbol, quote: next });
    setQuoteErrorSymbol(null);
  }, () => setQuoteErrorSymbol(apiSymbol)), [apiSymbol]);

  return (
    <section className={styles.priceChart} aria-label={`${symbol} market chart`}>
      <header className={styles.chartHeading}>
        <div>
          <p className={styles.eyebrow}>{assetType === "future" ? "FUTURE" : "STOCK"}</p>
          <h2>{symbol}</h2>
          {quote && <p className={styles.asOf}>{quoteAsOfCaption(quote.as_of, quote.quality)}</p>}
          {!quote && (
            <p className={styles.asOf} role="status">
              {quoteErrorSymbol === apiSymbol ? "Quote stream unavailable" : "Waiting for a stored quote"}
            </p>
          )}
        </div>
        <Labeled label="Last" value={quote ? formatPrice(quote.close) : null} quality={quote?.quality ?? "unavailable"} />
      </header>
      <div className={styles.chartToolbar} role="group" aria-label="Chart interval">
        {TODAY_CHART_INTERVALS.map((value) => (
          <button
            aria-pressed={value === interval}
            className={value === interval ? styles.activeInterval : styles.interval}
            key={value}
            onClick={() => setInterval(value)}
            type="button"
          >
            {intervalLabels[value]}
          </button>
        ))}
      </div>
      <ChartBody key={`${apiSymbol}:${interval}`} selection={{ symbol, asset_type: assetType, interval }} />
      <PositionFixture />
    </section>
  );
}

function ChartBody({ selection }: Readonly<{ selection: TodayChartSelection }>) {
  const { symbol, asset_type: assetType, interval } = selection;
  const context = chartContextKey(selection);
  const path = chartBarsPath(selection);
  const [snapshot, setSnapshot] = useState<{ context: string; value: Bars } | null>(null);
  const [errorContext, setErrorContext] = useState<string | null>(null);
  const barsResponse = chartSnapshotFor(snapshot, selection);
  const chartData = useMemo(() => barsResponse ? chartPresentation(barsResponse) : null, [barsResponse]);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    deskFetch(path, BarsSchema, { signal: controller.signal })
      .then((value) => {
        if (!active) return;
        if (!chartResponseMatchesSelection(value, { symbol, asset_type: assetType, interval })) {
          setErrorContext(context);
          return;
        }
        setSnapshot({ context, value });
      })
      .catch(() => {
        if (active && !controller.signal.aborted) setErrorContext(context);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [assetType, context, interval, path, symbol]);

  if (!barsResponse && errorContext === context) {
    return <p className={styles.chartError} role="alert">Closed bars could not be loaded. Try again later.</p>;
  }
  if (!chartData) return <p className={styles.chartLoading} role="status">Loading closed bars…</p>;

  return (
    <MarketChart
      symbol={marketSymbol(selection.symbol, selection.asset_type)}
      interval={selection.interval}
      {...chartData}
    />
  );
}
