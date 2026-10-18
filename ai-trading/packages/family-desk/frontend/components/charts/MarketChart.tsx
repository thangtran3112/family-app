"use client";

import { useEffect, useRef, useState } from "react";
import type {
  HistogramData,
  IChartApi,
  IPriceLine,
  ISeriesApi,
  Time,
  UTCTimestamp,
  WhitespaceData,
} from "lightweight-charts";
import { qualityLabel } from "@/lib/labels";
import { candlestickData, currentValue, lineData, type ChartBar } from "@/lib/chart-data";
import styles from "./MarketChart.module.css";

export type MarketChartOverlay = {
  id: string;
  label: string;
  color: string;
  values: Array<number | null>;
};

export type MarketChartPaneSeries = MarketChartOverlay & {
  kind: "line" | "histogram";
  negativeColor?: string;
};

export type MarketChartPane = {
  id: string;
  label: string;
  height?: number;
  series: MarketChartPaneSeries[];
  references?: Array<{ value: number; label: string }>;
};

export type MarketChartLevel = {
  label: string;
  price: number | null;
  color?: string;
};

export type MarketChartProps = {
  symbol: string;
  interval: string;
  bars: ChartBar[];
  quality: "realtime" | "delayed-15m" | "eod" | "fallback" | "unavailable";
  asOf: string | null;
  overlays?: MarketChartOverlay[];
  panes?: MarketChartPane[];
  levels?: MarketChartLevel[];
  height?: number;
};

type PaneSeriesApi =
  | { kind: "line"; series: ISeriesApi<"Line", Time> }
  | { kind: "histogram"; series: ISeriesApi<"Histogram", Time> };
type Library = typeof import("lightweight-charts");

function formatTime(time: Time): string {
  if (typeof time === "object") {
    const date = new Date(Date.UTC(time.year, time.month - 1, time.day));
    return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" }).format(date);
  }
  const date = new Date(typeof time === "number" ? time * 1000 : time);
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

function formatAsOf(value: string | null): string {
  if (value === null) return "as of unavailable";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `as of ${value}`;
  return `as of ${formatTime(Math.floor(Date.parse(value) / 1000) as UTCTimestamp)}`;
}

function formatValue(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value)
    ? "unavailable"
    : value.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

function histogramData(
  bars: ChartBar[],
  values: Array<number | null>,
  positiveColor: string,
  negativeColor: string,
): Array<HistogramData<Time> | WhitespaceData<Time>> {
  return lineData(bars, values).map((point) => {
    if (!("value" in point)) return point;
    return { ...point, color: point.value < 0 ? negativeColor : positiveColor };
  });
}

export function MarketChart({
  symbol,
  interval,
  bars,
  quality,
  asOf,
  overlays = [],
  panes = [],
  levels = [],
  height = 440,
}: MarketChartProps) {
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const library = useRef<Library | null>(null);
  const candles = useRef<ISeriesApi<"Candlestick", Time> | null>(null);
  const overlaySeries = useRef(new Map<string, ISeriesApi<"Line", Time>>());
  const paneSeries = useRef(new Map<string, PaneSeriesApi>());
  const priceLines = useRef<IPriceLine[]>([]);
  const panePriceLines = useRef(new Map<string, IPriceLine[]>());
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const overlayMap = overlaySeries.current;
    const paneMap = paneSeries.current;
    const paneLinesMap = panePriceLines.current;
    void import("lightweight-charts").then((module) => {
      if (cancelled || !container.current) return;
      library.current = module;
      const currentChart = module.createChart(container.current, {
        autoSize: true,
        height: 300,
        layout: {
          background: { type: module.ColorType.Solid, color: "#000000" },
          textColor: "#9B9BA1",
          fontFamily: "Inter, system-ui, sans-serif",
        },
        grid: {
          vertLines: { color: "#2C2C30" },
          horzLines: { color: "#2C2C30" },
        },
        rightPriceScale: { borderColor: "#2C2C30" },
        timeScale: {
          borderColor: "#2C2C30",
          timeVisible: true,
          secondsVisible: false,
          tickMarkFormatter: (time: Time) => formatTime(time),
        },
        localization: { locale: "en-US", timeFormatter: formatTime },
      });
      chart.current = currentChart;
      candles.current = currentChart.addSeries(module.CandlestickSeries, {
        upColor: "#30D158",
        downColor: "#FF453A",
        wickUpColor: "#30D158",
        wickDownColor: "#FF453A",
        borderVisible: false,
      });
      setReady(true);
    });
    return () => {
      cancelled = true;
      chart.current?.remove();
      chart.current = null;
      candles.current = null;
      overlayMap.clear();
      paneMap.clear();
      priceLines.current = [];
      paneLinesMap.clear();
    };
  // Chart lifecycle is mount/unmount only; data changes update series below.
  }, []);

  useEffect(() => {
    const currentChart = chart.current;
    const chartLibrary = library.current;
    const candleSeries = candles.current;
    if (!ready || !currentChart || !chartLibrary || !candleSeries) return;

    currentChart.applyOptions({ timeScale: { timeVisible: interval !== "1d" && interval !== "1w" } });

    const wantedOverlays = new Set(overlays.map(({ id }) => id));
    for (const [id, series] of overlaySeries.current) {
      if (!wantedOverlays.has(id)) {
        currentChart.removeSeries(series);
        overlaySeries.current.delete(id);
      }
    }
    overlays.forEach((overlay) => {
      let series = overlaySeries.current.get(overlay.id);
      if (!series) {
        series = currentChart.addSeries(chartLibrary.LineSeries, { color: overlay.color, lineWidth: 2 });
        overlaySeries.current.set(overlay.id, series);
      }
      series.applyOptions({ color: overlay.color, title: overlay.label });
      series.setData(lineData(bars, overlay.values));
    });

    const wantedPaneSeries = new Set(panes.flatMap(({ id, series }) => series.map((item) => `${id}:${item.id}`)));
    for (const [id, entry] of paneSeries.current) {
      if (!wantedPaneSeries.has(id)) {
        currentChart.removeSeries(entry.series);
        paneSeries.current.delete(id);
      }
    }
    for (const [id, lines] of panePriceLines.current) {
      const entry = paneSeries.current.get(id);
      for (const line of lines) entry?.series.removePriceLine(line);
    }
    panePriceLines.current.clear();
    panes.forEach((pane, paneIndex) => {
      const chartPaneIndex = paneIndex + 1;
      for (const item of pane.series) {
        const id = `${pane.id}:${item.id}`;
        let entry = paneSeries.current.get(id);
        if (entry && entry.kind !== item.kind) {
          currentChart.removeSeries(entry.series);
          paneSeries.current.delete(id);
          entry = undefined;
        }
        if (!entry && item.kind === "histogram") {
          entry = { kind: "histogram", series: currentChart.addSeries(chartLibrary.HistogramSeries, { color: item.color, base: 0 }, chartPaneIndex) };
          paneSeries.current.set(id, entry);
        } else if (!entry && item.kind === "line") {
          entry = { kind: "line", series: currentChart.addSeries(chartLibrary.LineSeries, { color: item.color, lineWidth: 2 }, chartPaneIndex) };
          paneSeries.current.set(id, entry);
        }
        if (!entry) continue;
        if (item.kind === "histogram" && entry.kind === "histogram") {
          entry.series.setData(histogramData(bars, item.values, item.color, item.negativeColor ?? "#FF453A"));
          entry.series.applyOptions({ title: item.label, color: item.color });
        } else if (item.kind === "line" && entry.kind === "line") {
          entry.series.setData(lineData(bars, item.values));
          entry.series.applyOptions({ title: item.label, color: item.color });
        }
      }
      const paneApi = currentChart.panes()[chartPaneIndex];
      if (paneApi && pane.height) paneApi.setHeight(pane.height);
      if (pane.series[0]) {
        const firstId = `${pane.id}:${pane.series[0].id}`;
        const first = paneSeries.current.get(firstId)?.series;
        const lines: IPriceLine[] = [];
        for (const reference of pane.references ?? []) {
          const line = first?.createPriceLine({
            price: reference.value,
            title: reference.label,
            color: "#9B9BA166",
            lineStyle: chartLibrary.LineStyle.Dashed,
            lineWidth: 1,
            axisLabelVisible: false,
            lineVisible: true,
          });
          if (line) lines.push(line);
        }
        panePriceLines.current.set(firstId, lines);
      }
    });

    for (const line of priceLines.current) candleSeries.removePriceLine(line);
    priceLines.current = levels.flatMap(({ label, price, color }) => {
      if (price === null || !Number.isFinite(price)) return [];
      return [candleSeries.createPriceLine({
        price,
        title: label,
        color: color ?? "#9B9BA1",
        lineStyle: chartLibrary.LineStyle.Dashed,
        lineWidth: 1,
        axisLabelVisible: true,
      })];
    });

    candleSeries.setData(candlestickData(bars));
    if (bars.length) currentChart.timeScale().fitContent();
  }, [ready, symbol, interval, bars, overlays, panes, levels]);

  const lastBar = bars.at(-1);
  return (
    <section className={styles.chartCard} aria-label={`${symbol} ${interval} market chart`}>
      <header className={styles.chartHeader}>
        <h2>{interval.toUpperCase()} chart · {symbol}</h2>
        <p><span>{qualityLabel(quality)}</span><span>{formatAsOf(asOf)}</span></p>
      </header>
      {(overlays.length > 0 || panes.length > 0) && <div className={styles.chartLegend}>
        {overlays.map((overlay) => <span key={overlay.id}><i style={{ backgroundColor: overlay.color }} />{overlay.label}</span>)}
        {panes.map((pane) => <span key={pane.id}><strong>{pane.label}</strong> · {pane.series.map(({ label }) => label).join(" · ")}</span>)}
      </div>}
      <div className={styles.canvasWrap} style={{ height }}>
        <div ref={container} className={styles.canvas} aria-hidden="true" />
        {bars.length === 0 && <p className={styles.empty} role="status">No closed bars available for this symbol and timeframe.</p>}
      </div>
      <div className={styles.currentValues} aria-label="Latest chart values">
        <span>Last close <strong>{formatValue(lastBar?.c)}</strong></span>
        {overlays.map((overlay) => (
          <span key={overlay.id}>{overlay.label} <strong>{formatValue(currentValue(overlay.values))}</strong></span>
        ))}
        {panes.flatMap((pane) => pane.series.map((series) => (
          <span key={`${pane.id}:${series.id}`}>{series.label} <strong>{formatValue(currentValue(series.values))}</strong></span>
        )))}
      </div>
      <details className={styles.dataTable}>
        <summary>Chart data table · {bars.length} source bars</summary>
        <div className={styles.tableScroll}>
          <table>
            <thead><tr><th scope="col">Source time</th><th scope="col">Open</th><th scope="col">High</th><th scope="col">Low</th><th scope="col">Close</th></tr></thead>
            <tbody>{bars.map((bar, index) => (
              <tr key={`${bar.t}-${index}`}><th scope="row">{bar.t}</th><td>{formatValue(bar.o)}</td><td>{formatValue(bar.h)}</td><td>{formatValue(bar.l)}</td><td>{formatValue(bar.c)}</td></tr>
            ))}</tbody>
          </table>
        </div>
      </details>
      <footer className={styles.chartFooter}><a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">Charts by TradingView</a></footer>
    </section>
  );
}
