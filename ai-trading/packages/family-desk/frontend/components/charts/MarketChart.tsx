"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { chartPalette } from "@/lib/desk/chartPalette";
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
import { formatPrice } from "@/lib/desk/format";
import { qualityPhrase } from "@/lib/desk/freshness";
import type { ChartType } from "@/lib/replay/chartPrefs";
import {
  candlestickData,
  chartTime,
  crosshairPoint,
  formatChartClock,
  sourceTimeLabel,
  replayTickLabel,
  currentValue,
  lineData,
  paneHeights,
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
  /** What a settings toggle filters by; the chart itself ignores it. */
  id?: string;
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
  /** How the price series is drawn (replay chart settings). Candles by default; hollow only restyles the candles, the others swap the series. */
  chartType?: ChartType;
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
  /** Bars on the first draw of a followed chart (90 by default). */
  firstDraw?: number;
  /** Replay of a hidden day: axis, crosshair and data table show the time of day only, never the date. */
  hideDates?: boolean;
  /** Axis ticks read as time of day ("11:00 AM") with "Oct 22" at day changes, instead of a date on every tick. On for followed and hidden-date charts. */
  clockTicks?: boolean;
  /** One label per bar for the data table while dates are hidden ("D-3", "Day 6"): a stand-in timeline's own times say nothing. */
  rowLabels?: readonly string[];
  /** Start time of a bar to bring into view with the crosshair on it (a click in the signals rail). `at` changes on every click, so the same bar can be asked for twice. */
  focus?: { time: string; at: number } | null;
  /** One legend per indicator pane (same order as `panes`), drawn at the top of its pane wherever the layout puts it. */
  paneLegends?: ReactNode[];
};

/** Bars shown on the first draw of a followed chart, and the room right of the newest bar: a marker label is centred on its bar and clipped at the price axis, so it needs about half a label of room. */
const FOLLOW_VISIBLE_BARS = 90;
const FOLLOW_RIGHT_PAD = 10;

// The Desk colours come from chartPalette (canvas cannot read the CSS variables). PRICE is the line and area colour: not white
// (EMA 9), not green or red (those mean up and down).
const { up: UP, down: DOWN, price: PRICE, clear: CLEAR } = chartPalette;

const DEFAULT_PANE_HEIGHT = 120;

/** Indicator panes keep their pixel height while there is room and the price pane takes the rest, never less than
 * PRICE_PANE_SHARE of the chart (`paneHeights`). `setHeight` on one pane rescales the others, so the second call shrank
 * the first to about 30 px: set every pane's stretch factor from pixels instead, and again whenever the chart is
 * resized (stretch factors are shares, so a resize would rescale them). Returns the top of each indicator pane. */
function layoutPanes(chart: IChartApi, panes: MarketChartPane[]): number[] {
  const apis = chart.panes();
  const total = apis.reduce((sum, pane) => sum + pane.getHeight(), 0);
  if (panes.length === 0 || apis.length < panes.length + 1 || total <= 0) return [];
  const heights = paneHeights(total, panes.map((pane) => pane.height ?? DEFAULT_PANE_HEIGHT));
  heights.forEach((height, index) => apis[index]?.setStretchFactor(height));
  return panes.map((_, index) => heights.slice(0, index + 1).reduce((sum, height) => sum + height, 0));
}

const sameTops = (a: number[], b: number[]) => a.length === b.length && a.every((top, index) => Math.round(top) === Math.round(b[index]!));

type PaneSeriesApi =
  | { kind: "line"; series: ISeriesApi<"Line", Time> }
  | { kind: "histogram"; series: ISeriesApi<"Histogram", Time> };
type Library = typeof import("lightweight-charts");
type MainKind = "Candlestick" | "Bar" | "Line" | "Area";
type MainSeries = ISeriesApi<MainKind, Time>;

const MAIN_KIND: Record<ChartType, MainKind> = { candles: "Candlestick", hollow: "Candlestick", bars: "Bar", line: "Line", area: "Area" };

function addMainSeries(library: Library, chart: IChartApi, kind: MainKind): MainSeries {
  switch (kind) {
    case "Bar": return chart.addSeries(library.BarSeries, { upColor: UP, downColor: DOWN, openVisible: true, thinBars: false });
    case "Line": return chart.addSeries(library.LineSeries, { color: PRICE, lineWidth: 2, crosshairMarkerVisible: true });
    case "Area": return chart.addSeries(library.AreaSeries, { lineColor: PRICE, topColor: chartPalette.priceFillTop, bottomColor: chartPalette.priceFillBottom, lineWidth: 2 });
    case "Candlestick": return chart.addSeries(library.CandlestickSeries, { upColor: UP, downColor: DOWN, wickUpColor: UP, wickDownColor: DOWN, borderVisible: false });
  }
}

/** Hollow is the candle series restyled: up bars empty and down bars filled, so direction reads from shape, not colour alone. */
function candleStyle(type: ChartType) {
  return type === "hollow"
    ? { upColor: CLEAR, downColor: DOWN, borderUpColor: UP, borderDownColor: DOWN, wickUpColor: UP, wickDownColor: DOWN, borderVisible: true }
    : { upColor: UP, downColor: DOWN, borderUpColor: UP, borderDownColor: DOWN, wickUpColor: UP, wickDownColor: DOWN, borderVisible: false };
}

/** The lookup key of a bar's time, for the crosshair's OHLC (a line or area series reports only a value). */
const timeId = (time: Time): string => (typeof time === "object" ? `${time.year}-${time.month}-${time.day}` : String(time));

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

/** One precision per column (2 dp, 4 under $1), not whatever digits the value happens to carry (V-Technicals-05). */
function formatValue(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value) ? "unavailable" : formatPrice(value);
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
  chartType = "candles",
  markers = [],
  sessionShading = false,
  volume = false,
  onCrosshair,
  lastPricePill = true,
  chrome = "card",
  dimmed = false,
  follow = false,
  firstDraw = FOLLOW_VISIBLE_BARS,
  hideDates = false,
  clockTicks = false,
  rowLabels,
  focus = null,
  paneLegends,
}: MarketChartProps) {
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const library = useRef<Library | null>(null);
  const main = useRef<MainSeries | null>(null);
  const mainKind = useRef<MainKind>("Candlestick");
  const barAt = useRef(new Map<string, ReturnType<typeof candlestickData>[number]>());
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
  const paneLayout = useRef(panes);
  const [ready, setReady] = useState(false);
  const [paneTops, setPaneTops] = useState<number[]>([]);

  useEffect(() => {
    crosshairCallback.current = onCrosshair;
  }, [onCrosshair]);

  useEffect(() => {
    paneLayout.current = panes;
  }, [panes]);

  useEffect(() => {
    let cancelled = false;
    const overlayMap = overlaySeries.current;
    const paneMap = paneSeries.current;
    const paneLinesMap = panePriceLines.current;
    let resizeWatch: ResizeObserver | null = null;
    void import("lightweight-charts").then((module) => {
      if (cancelled || !container.current) return;
      library.current = module;
      const currentChart = module.createChart(container.current, {
        autoSize: true,
        height: 300,
        // The library draws the hovered series last by default. The session shading is a full-height opaque histogram, so
        // hovering it painted it over the lines and candles (D-072): series stay in the order set below.
        hoveredSeriesOnTop: false,
        layout: {
          background: { type: module.ColorType.Solid, color: chartPalette.ground },
          textColor: chartPalette.muted,
          fontFamily: "Inter, system-ui, sans-serif",
        },
        grid: {
          vertLines: { color: chartPalette.hairline },
          horzLines: { color: chartPalette.hairline },
        },
        crosshair: {
          mode: module.CrosshairMode.Normal,
          vertLine: { color: chartPalette.muted, style: module.LineStyle.Dashed, width: 1, labelBackgroundColor: chartPalette.amber },
          horzLine: { color: chartPalette.muted, style: module.LineStyle.Dashed, width: 1, labelBackgroundColor: chartPalette.amber },
        },
        rightPriceScale: { borderColor: chartPalette.hairline },
        timeScale: {
          borderColor: chartPalette.hairline,
          timeVisible: true,
          secondsVisible: false,
          tickMarkFormatter: (time: Time) => formatChartTime(time),
        },
        localization: { locale: "en-US", timeFormatter: formatChartTime },
      });
      chart.current = currentChart;
      resizeWatch = new ResizeObserver(() => {
        const tops = layoutPanes(currentChart, paneLayout.current);
        setPaneTops((current) => (sameTops(current, tops) ? current : tops));
      });
      resizeWatch.observe(container.current);
      mainKind.current = "Candlestick";
      main.current = addMainSeries(module, currentChart, mainKind.current);
      currentChart.subscribeCrosshairMove((param) => {
        const callback = crosshairCallback.current;
        if (!callback || !main.current) return;
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
          barAt.current.get(timeId(param.time)) as Parameters<typeof crosshairPoint>[1],
          volumeEntry as Parameters<typeof crosshairPoint>[2],
          values,
        ));
      });
      setReady(true);
    });
    return () => {
      cancelled = true;
      resizeWatch?.disconnect();
      chart.current?.remove();
      chart.current = null;
      main.current = null;
      barAt.current.clear();
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
    if (!ready || !currentChart || !chartLibrary || !main.current) return;

    // A different series kind replaces the price series in one go (rapid changes just set the final state). The markers and
    // price lines belong to the old series, so they are dropped here and re-created on the new one below; the visible range
    // is put back after the data, so zoom and scroll survive the switch.
    const wantKind = MAIN_KIND[chartType];
    const keepRange = mainKind.current !== wantKind ? currentChart.timeScale().getVisibleLogicalRange() : null;
    if (mainKind.current !== wantKind) {
      markerPlugin.current?.detach();
      markerPlugin.current = null;
      priceLines.current = [];
      currentChart.removeSeries(main.current);
      mainKind.current = wantKind;
      main.current = addMainSeries(chartLibrary, currentChart, wantKind);
      // Behind the overlays, in front of the session shading.
      main.current.setSeriesOrder(shadeSeries.current ? 1 : 0);
    }
    const mainSeries = main.current;
    if (wantKind === "Candlestick") mainSeries.applyOptions(candleStyle(chartType));

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
        // No full-width dotted line at the last value: it sits within cents of the last-price line, where her marks land. The axis tag stays.
        series = currentChart.addSeries(chartLibrary.LineSeries, { color: overlay.color, lineWidth: 2, priceLineVisible: false });
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
          entry.series.setData(histogramData(bars, item.values, item.color, item.negativeColor ?? chartPalette.down));
          entry.series.applyOptions({ title: item.label, color: item.color });
        } else if (item.kind === "line" && entry.kind === "line") {
          entry.series.setData(lineData(bars, item.values));
          entry.series.applyOptions({ title: item.label, color: item.color });
        }
      }
      if (pane.series[0]) {
        const firstId = `${pane.id}:${pane.series[0].id}`;
        const first = paneSeries.current.get(firstId)?.series;
        const lines: IPriceLine[] = [];
        for (const reference of pane.references ?? []) {
          const line = first?.createPriceLine({
            price: reference.value,
            title: reference.label,
            color: chartPalette.mutedFaint,
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
    const tops = layoutPanes(currentChart, panes);
    setPaneTops((current) => (sameTops(current, tops) ? current : tops));

    for (const line of priceLines.current) mainSeries.removePriceLine(line);
    priceLines.current = levels.flatMap(({ label, price, color, style }) => {
      if (price === null || !Number.isFinite(price)) return [];
      return [mainSeries.createPriceLine({
        price,
        title: label,
        color: color ?? chartPalette.muted,
        lineStyle: style === "dotted" ? chartLibrary.LineStyle.Dotted : chartLibrary.LineStyle.Dashed,
        lineWidth: 1,
        axisLabelVisible: true,
      })];
    });

    mainSeries.applyOptions({ lastValueVisible: lastPricePill, priceLineVisible: lastPricePill });
    // Before the data changes: was the view parked at the newest bar (within a bar or two)? Then it stays there.
    const visible = keepRange ?? currentChart.timeScale().getVisibleLogicalRange();
    const atNewest = visible === null || visible.to >= lastIndex.current - 1.5;
    const candleData = candlestickData(bars);
    barAt.current = new Map(candleData.map((point) => [timeId(point.time), point]));
    if (wantKind === "Line" || wantKind === "Area") (mainSeries as ISeriesApi<"Line", Time>).setData(lineData(bars, bars.map((bar) => bar.c)));
    else (mainSeries as ISeriesApi<"Candlestick", Time>).setData(candleData);

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
      shadeSeries.current.setSeriesOrder(0); // behind the candles and lines (a later series is drawn on top: the week shading hid the equity lines)
    } else if (!sessionShading && shadeSeries.current) {
      currentChart.removeSeries(shadeSeries.current);
      shadeSeries.current = null;
    }
    shadeSeries.current?.setData(shadingData(bars));

    if (!markerPlugin.current) markerPlugin.current = chartLibrary.createSeriesMarkers(mainSeries, []);
    markerPlugin.current.setMarkers(seriesMarkers(bars, markers));

    // Fit on a new symbol or timeframe (or the first data), not on every refresh, so zoom survives a refetch.
    const key = `${symbol}:${interval}`;
    const count = candleData.length;
    if (bars.length && fitKey.current !== key) {
      if (follow) currentChart.timeScale().setVisibleLogicalRange({ from: Math.max(0, count - firstDraw), to: count - 1 + FOLLOW_RIGHT_PAD });
      else currentChart.timeScale().fitContent();
      fitKey.current = key;
    } else if (keepRange) {
      currentChart.timeScale().setVisibleLogicalRange(keepRange);
    } else if (follow && atNewest) {
      currentChart.timeScale().scrollToRealTime();
    }
    lastIndex.current = count - 1;
  }, [ready, symbol, interval, bars, overlays, panes, levels, markers, sessionShading, volume, lastPricePill, follow, firstDraw, hideDates, clockTicks, chartType]);

  // Move the crosshair to the asked-for bar, scrolling it into view when it is off screen. Never touches the data.
  useEffect(() => {
    const currentChart = chart.current;
    const candleSeries = main.current;
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
        <p><span>{qualityPhrase(quality)}</span><span>{formatAsOf(asOf)}</span></p>
      </header>}
      {!bare && (overlays.length > 0 || panes.length > 0) && <div className={styles.chartLegend}>
        {overlays.map((overlay) => <span key={overlay.id}><i style={{ backgroundColor: overlay.color }} />{overlay.label}</span>)}
        {panes.map((pane) => <span key={pane.id}><strong>{pane.label}</strong> · {pane.series.map(({ label }) => label).join(" · ")}</span>)}
      </div>}
      <div className={styles.canvasWrap} style={height === "fill" ? { flex: "1 1 0", minHeight: 0 } : { height }}>
        <div ref={container} className={styles.canvas} aria-hidden="true" />
        {paneLegends?.map((node, index) => paneTops[index] === undefined ? null : (
          <div key={panes[index]?.id ?? index} className={styles.paneLegend} style={{ top: paneTops[index] + 4 }}>{node}</div>
        ))}
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
            <thead><tr><th scope="col">Time (ET)</th><th scope="col">Open</th><th scope="col">High</th><th scope="col">Low</th><th scope="col">Close</th></tr></thead>
            <tbody>{bars.map((bar, index) => (
              <tr key={`${bar.t}-${index}`}><th scope="row">{sourceTimeLabel(bar.t, index, hideDates, rowLabels)}</th><td>{formatValue(bar.o)}</td><td>{formatValue(bar.h)}</td><td>{formatValue(bar.l)}</td><td>{formatValue(bar.c)}</td></tr>
            ))}</tbody>
          </table>
        </div>
      </details>
      <footer className={styles.chartFooter}><a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">Charts by TradingView</a></footer>
      </div>
    </section>
  );
}
