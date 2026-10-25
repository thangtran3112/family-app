"use client";

import { useEffect, useRef, useState } from "react";
import type {
  HistogramData,
  IChartApi,
  IPriceLine,
  ISeriesApi,
  ISeriesMarkersPluginApi,
  Time,
  UTCTimestamp,
  WhitespaceData,
} from "lightweight-charts";
import { qualityLabel } from "@/lib/labels";
import {
  candlestickData,
  chartTime,
  crosshairPoint,
  formatChartClock,
  replayTickLabel,
  currentValue,
  lineData,
  seriesMarkers,
  shadingData,
  volumeData,
  type ChartBar,
  type ChartMarkerInput,
  type CrosshairPoint,
} from "@/lib/chart-data";
import styles from "./MarketChart.module.css";

export type MarketChartOverlay = {
  id: string;
  label: string;
  color: string;
  values: Array<number | null>;
  /** Told apart by colour and line style (02l §b5): EMA 21 is dashed. */
  style?: "solid" | "dashed";
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
  /** Dashed by default; pivots and prior-day levels are dotted (02l §b5). */
  style?: "dashed" | "dotted";
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
  height?: number | "fill";
  /** Pattern labels below the bar and fired-alert bells above it. */
  markers?: ChartMarkerInput[];
  /** Shade pre- and after-hours bars (`bars[].ext`). */
  sessionShading?: boolean;
  /** Volume columns in the bottom 20% of the main pane at 40% opacity. */
  volume?: boolean;
  /** Called on every cursor move with the values under the crosshair; null when it leaves the chart. */
  onCrosshair?: (point: CrosshairPoint | null) => void;
  /** Last price label on the price axis in the up/down colour (on by default, as before). */
  lastPricePill?: boolean;
  /** The workspace draws its own header, legend and value row; the card chrome is dropped. */
  chrome?: "card" | "bare";
  /** Values stay visible but dimmed (the quote connection dropped). */
  dimmed?: boolean;
  /** Replay (02o §d): keep the newest bar in view after an update unless she scrolled back. The first draw shows the latest bars, not the whole history. */
  follow?: boolean;
  /** Replay of a hidden day: axis, crosshair and data table show the time of day only, never the date. */
  hideDates?: boolean;
  /** Axis ticks read as time of day ("11:00 AM") with "Oct 22" at day changes, instead of a date on every tick. On for followed and hidden-date charts. */
  clockTicks?: boolean;
  /** Start time of a bar to bring into view with the crosshair on it (a click in the signals rail). `at` changes on every click, so the same bar can be asked for twice. */
  focus?: { time: string; at: number } | null;
};

/** Bars shown on the first draw of a followed chart, and the room left of the right edge. */
const FOLLOW_VISIBLE_BARS = 90;
const FOLLOW_RIGHT_PAD = 6;

type PaneSeriesApi =
  | { kind: "line"; series: ISeriesApi<"Line", Time> }
  | { kind: "histogram"; series: ISeriesApi<"Histogram", Time> };
type Library = typeof import("lightweight-charts");

export function formatChartTime(time: Time): string {
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
  return `as of ${formatChartTime(Math.floor(Date.parse(value) / 1000) as UTCTimestamp)}`;
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
  markers = [],
  sessionShading = false,
  volume = false,
  onCrosshair,
  lastPricePill = true,
  chrome = "card",
  dimmed = false,
  follow = false,
  hideDates = false,
  clockTicks = false,
  focus = null,
}: MarketChartProps) {
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const library = useRef<Library | null>(null);
  const candles = useRef<ISeriesApi<"Candlestick", Time> | null>(null);
  const overlaySeries = useRef(new Map<string, ISeriesApi<"Line", Time>>());
  const paneSeries = useRef(new Map<string, PaneSeriesApi>());
  const priceLines = useRef<IPriceLine[]>([]);
  const panePriceLines = useRef(new Map<string, IPriceLine[]>());
  const volumeSeries = useRef<ISeriesApi<"Histogram", Time> | null>(null);
  const shadeSeries = useRef<ISeriesApi<"Histogram", Time> | null>(null);
  const markerPlugin = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const crosshairCallback = useRef(onCrosshair);
  const fitKey = useRef<string | null>(null);
  const lastIndex = useRef(-1);
  const paneSignature = useRef("");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    crosshairCallback.current = onCrosshair;
  }, [onCrosshair]);

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
        crosshair: {
          mode: module.CrosshairMode.Normal,
          vertLine: { color: "#9B9BA1", style: module.LineStyle.Dashed, width: 1, labelBackgroundColor: "#FFB020" },
          horzLine: { color: "#9B9BA1", style: module.LineStyle.Dashed, width: 1, labelBackgroundColor: "#FFB020" },
        },
        rightPriceScale: { borderColor: "#2C2C30" },
        timeScale: {
          borderColor: "#2C2C30",
          timeVisible: true,
          secondsVisible: false,
          tickMarkFormatter: (time: Time) => formatChartTime(time),
        },
        localization: { locale: "en-US", timeFormatter: formatChartTime },
      });
      chart.current = currentChart;
      candles.current = currentChart.addSeries(module.CandlestickSeries, {
        upColor: "#30D158",
        downColor: "#FF453A",
        wickUpColor: "#30D158",
        wickDownColor: "#FF453A",
        borderVisible: false,
      });
      currentChart.subscribeCrosshairMove((param) => {
        const callback = crosshairCallback.current;
        const candleSeries = candles.current;
        if (!callback || !candleSeries) return;
        if (!param.time || !param.point) {
          callback(null);
          return;
        }
        const values: Record<string, { value?: number } | undefined> = {};
        for (const [id, series] of overlaySeries.current) values[id] = param.seriesData.get(series) as { value?: number } | undefined;
        for (const [id, entry] of paneSeries.current) values[id] = param.seriesData.get(entry.series) as { value?: number } | undefined;
        const volumeEntry = volumeSeries.current ? param.seriesData.get(volumeSeries.current) : undefined;
        callback(crosshairPoint(
          param.time,
          param.seriesData.get(candleSeries) as Parameters<typeof crosshairPoint>[1],
          volumeEntry as Parameters<typeof crosshairPoint>[2],
          values,
        ));
      });
      setReady(true);
    });
    return () => {
      cancelled = true;
      chart.current?.remove();
      chart.current = null;
      candles.current = null;
      volumeSeries.current = null;
      shadeSeries.current = null;
      markerPlugin.current = null;
      fitKey.current = null;
      lastIndex.current = -1;
      paneSignature.current = "";
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

    const timeLabel = hideDates ? formatChartClock : formatChartTime;
    currentChart.applyOptions({
      timeScale: {
        timeVisible: interval !== "1d" && interval !== "1w",
        tickMarkFormatter: follow || hideDates || clockTicks ? (time: Time, tickType: number) => replayTickLabel(time, tickType, hideDates) : (time: Time) => timeLabel(time),
        rightOffset: follow ? FOLLOW_RIGHT_PAD : 0,
      },
      localization: { timeFormatter: timeLabel },
    });

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
      series.applyOptions({
        color: overlay.color,
        title: overlay.label,
        lineStyle: overlay.style === "dashed" ? chartLibrary.LineStyle.Dashed : chartLibrary.LineStyle.Solid,
      });
      series.setData(lineData(bars, overlay.values));
    });

    // When panes are added, removed or reordered the library renumbers them, so series that stay would sit in the
    // wrong pane. Rebuild the pane series from scratch whenever the pane layout changes.
    const signature = panes.map((pane) => `${pane.id}[${pane.series.map((item) => `${item.id}:${item.kind}`).join(",")}]`).join("|");
    if (signature !== paneSignature.current) {
      for (const entry of paneSeries.current.values()) currentChart.removeSeries(entry.series);
      paneSeries.current.clear();
      paneSignature.current = signature;
    }

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
    priceLines.current = levels.flatMap(({ label, price, color, style }) => {
      if (price === null || !Number.isFinite(price)) return [];
      return [candleSeries.createPriceLine({
        price,
        title: label,
        color: color ?? "#9B9BA1",
        lineStyle: style === "dotted" ? chartLibrary.LineStyle.Dotted : chartLibrary.LineStyle.Dashed,
        lineWidth: 1,
        axisLabelVisible: true,
      })];
    });

    candleSeries.applyOptions({ lastValueVisible: lastPricePill, priceLineVisible: lastPricePill });
    // Before the data changes: was the view parked at the newest bar (within a bar or two)? Then it stays there.
    const visible = currentChart.timeScale().getVisibleLogicalRange();
    const atNewest = visible === null || visible.to >= lastIndex.current - 1.5;
    const candleData = candlestickData(bars);
    candleSeries.setData(candleData);

    if (volume && !volumeSeries.current) {
      volumeSeries.current = currentChart.addSeries(chartLibrary.HistogramSeries, {
        priceScaleId: "",
        priceFormat: { type: "volume" },
        lastValueVisible: false,
        priceLineVisible: false,
      });
      volumeSeries.current.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    } else if (!volume && volumeSeries.current) {
      currentChart.removeSeries(volumeSeries.current);
      volumeSeries.current = null;
    }
    volumeSeries.current?.setData(volumeData(bars));

    if (sessionShading && !shadeSeries.current) {
      shadeSeries.current = currentChart.addSeries(chartLibrary.HistogramSeries, {
        priceScaleId: "extended-hours",
        priceFormat: { type: "volume" },
        lastValueVisible: false,
        priceLineVisible: false,
      });
      shadeSeries.current.priceScale().applyOptions({ scaleMargins: { top: 0, bottom: 0 }, visible: false });
    } else if (!sessionShading && shadeSeries.current) {
      currentChart.removeSeries(shadeSeries.current);
      shadeSeries.current = null;
    }
    shadeSeries.current?.setData(shadingData(bars));

    if (!markerPlugin.current) markerPlugin.current = chartLibrary.createSeriesMarkers(candleSeries, []);
    markerPlugin.current.setMarkers(seriesMarkers(bars, markers));

    // Fit on a new symbol or timeframe (or the first data), not on every refresh, so zoom survives a refetch.
    const key = `${symbol}:${interval}`;
    const count = candleData.length;
    if (bars.length && fitKey.current !== key) {
      if (follow) currentChart.timeScale().setVisibleLogicalRange({ from: Math.max(0, count - FOLLOW_VISIBLE_BARS), to: count - 1 + FOLLOW_RIGHT_PAD });
      else currentChart.timeScale().fitContent();
      fitKey.current = key;
    } else if (follow && atNewest) {
      currentChart.timeScale().scrollToRealTime();
    }
    lastIndex.current = count - 1;
  }, [ready, symbol, interval, bars, overlays, panes, levels, markers, sessionShading, volume, lastPricePill, follow, hideDates, clockTicks]);

  // Move the crosshair to the asked-for bar, scrolling it into view when it is off screen. Never touches the data.
  useEffect(() => {
    const currentChart = chart.current;
    const candleSeries = candles.current;
    if (!focus || !ready || !currentChart || !candleSeries) return;
    const index = bars.findIndex((bar) => bar.t === focus.time);
    const bar = bars[index];
    if (!bar || bar.c === null) return;
    const scale = currentChart.timeScale();
    const range = scale.getVisibleLogicalRange();
    if (range && (index < range.from || index > range.to)) {
      const half = (range.to - range.from) / 2;
      scale.setVisibleLogicalRange({ from: index - half, to: index + half });
    }
    currentChart.setCrosshairPosition(bar.c, chartTime(bar.t), candleSeries);
  // Runs when a new focus is asked for, not when bars refresh.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.at, ready]);

  const lastBar = bars.at(-1);
  const bare = chrome === "bare";
  return (
    <section
      className={`${styles.chartCard} ${bare ? styles.bare : ""}`}
      aria-label={`${symbol} ${interval} market chart`}
      data-dim={dimmed ? "true" : undefined}
    >
      {!bare && <header className={styles.chartHeader}>
        <h2>{interval.toUpperCase()} chart · {symbol}</h2>
        <p><span>{qualityLabel(quality)}</span><span>{formatAsOf(asOf)}</span></p>
      </header>}
      {!bare && (overlays.length > 0 || panes.length > 0) && <div className={styles.chartLegend}>
        {overlays.map((overlay) => <span key={overlay.id}><i style={{ backgroundColor: overlay.color }} />{overlay.label}</span>)}
        {panes.map((pane) => <span key={pane.id}><strong>{pane.label}</strong> · {pane.series.map(({ label }) => label).join(" · ")}</span>)}
      </div>}
      <div className={styles.canvasWrap} style={height === "fill" ? { flex: "1 1 0", minHeight: 0 } : { height }}>
        <div ref={container} className={styles.canvas} aria-hidden="true" />
        {bars.length === 0 && <p className={styles.empty} role="status">No closed bars available for this symbol and timeframe.</p>}
      </div>
      {!bare && <div className={styles.currentValues} aria-label="Latest chart values">
        <span>Last close <strong>{formatValue(lastBar?.c)}</strong></span>
        {overlays.map((overlay) => (
          <span key={overlay.id}>{overlay.label} <strong>{formatValue(currentValue(overlay.values))}</strong></span>
        ))}
        {panes.flatMap((pane) => pane.series.map((series) => (
          <span key={`${pane.id}:${series.id}`}>{series.label} <strong>{formatValue(currentValue(series.values))}</strong></span>
        )))}
      </div>}
      <div className={styles.footerRow}>
      <details className={styles.dataTable}>
        <summary>Chart data table · {bars.length} source bars</summary>
        <div className={styles.tableScroll}>
          <table>
            <thead><tr><th scope="col">Source time</th><th scope="col">Open</th><th scope="col">High</th><th scope="col">Low</th><th scope="col">Close</th></tr></thead>
            <tbody>{bars.map((bar, index) => (
              <tr key={`${bar.t}-${index}`}><th scope="row">{hideDates ? formatChartClock(Math.floor(Date.parse(bar.t) / 1000) as UTCTimestamp) : bar.t}</th><td>{formatValue(bar.o)}</td><td>{formatValue(bar.h)}</td><td>{formatValue(bar.l)}</td><td>{formatValue(bar.c)}</td></tr>
            ))}</tbody>
          </table>
        </div>
      </details>
      <footer className={styles.chartFooter}><a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">Charts by TradingView</a></footer>
      </div>
    </section>
  );
}
