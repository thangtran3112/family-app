"use client";

import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import { chartPalette } from "@/lib/desk/chartPalette";
import { ChunkedSeries } from "@/lib/chart-chunks";
import type {
  HistogramData,
  IChartApi,
  IPriceLine,
  ISeriesApi,
  ISeriesMarkersPluginApi,
  SeriesMarker,
  SeriesType,
  Time,
  WhitespaceData,
} from "lightweight-charts";
import { formatChartAsOf, formatPrice } from "@/lib/desk/format";
import { qualityPhrase } from "@/lib/desk/freshness";
import { nearestLevel, roundToCents } from "@/lib/replay/chartOrder";
import type { ChartType } from "@/lib/replay/chartPrefs";
import {
  attachPinchZoom,
  axisTagPrices,
  candlestickData,
  chartTime,
  clearTickLabel,
  drawnTagYs,
  crosshairPoint,
  followsNewest,
  sourceTimeLabel,
  replayTickLabel,
  currentValue,
  lineData,
  paneHeights,
  pinnedRange,
  rightOffsetOption,
  seriesMarkers,
  shadingData,
  syncSeries,
  valueAtOrBefore,
  timeKey,
  valueRuns,
  volumeData,
  wholeAxisLabel,
  type ChartBar,
  type ChartMarkerInput,
  type CrosshairPoint,
  type SeriesFed,
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

/** A chart of money over a stand-in timeline (the week review's balance and equity): what each bar's day is called on the time axis ("D1"), and how a dollar reads on the price axis and its pills. */
export type MarketChartMoneyAxis = {
  days: readonly string[];
  label: (price: number) => string;
  tick: (price: number) => string;
};

export type MarketChartLevel = {
  /** What a settings toggle filters by; the chart itself ignores it. */
  id?: string;
  label: string;
  price: number | null;
  color?: string;
  /** Dashed by default; pivots and prior-day levels are dotted (02l §b5). */
  style?: "dashed" | "dotted";
  /** The line only: no title and no price pill on the chart. The caller names it in a `ChartLegend` (in normal flow, so levels close in price never print over each other or the candles). */
  plain?: boolean;
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
  /** Index of the session's first bar (the bars before it are lookback). Before the open, with no session bar revealed yet, the followed chart waits there; from the first session bar on it follows the newest bar. */
  sessionStart?: number;
  /** Axis ticks read as time of day ("11:00 AM") with "Oct 22" at day changes, instead of a date on every tick. On for followed charts. */
  clockTicks?: boolean;
  /** One label per bar for the data table when the bars sit on a stand-in timeline ("D1", "D2"): its own times say nothing. A real timeline names its rows by date and time. */
  rowLabels?: readonly string[];
  /** Money, not a price: day names on the time axis, dollars on the price axis, and room above and below the lines for the top label and the library's logo (D-087, D-128). */
  moneyAxis?: MarketChartMoneyAxis;
  /** Start time of a bar to bring into view with the crosshair on it (a click in the signals rail). `at` changes on every click, so the same bar can be asked for twice. */
  focus?: { time: string; at: number } | null;
  /** Replay: a level line carries no title, only its number on the price axis; its name (`label`) shows in a tooltip while the cursor is on the line. */
  levelTips?: boolean;
  /** Price ticks keep clear of the tags and of the pane's edge (D-199, D-200), as the replay chart's do; a chart with indicator panes cannot (see the formatter). */
  guardAxis?: boolean;
  /** Replay click-to-order: a click on the price pane picks a price (snapped onto a level line when it is on one) and draws what this returns beside the click, with a dashed line at the price. `close` dismisses it. Escape and a press elsewhere dismiss it too. */
  renderPick?: (price: number, close: () => void) => ReactNode;
  /** One legend per indicator pane (same order as `panes`), drawn at the top of its pane wherever the layout puts it. */
  paneLegends?: ReactNode[];
};

/** Bars shown on the first draw of a followed chart, and the room right of the newest bar: a marker label is centred on its bar and clipped at the price axis, so it needs about half a label of room. */
const FOLLOW_VISIBLE_BARS = 90;
const FOLLOW_RIGHT_PAD = 10;
/** Bars beyond each edge of the view whose runs stay shown, so a scroll finds them drawn. */
const CULL_MARGIN_BARS = 100;

// The Desk colours come from chartPalette (canvas cannot read the CSS variables). PRICE is the line and area colour: not white
// (EMA 9), not green or red (those mean up and down).
const { up: UP, down: DOWN, price: PRICE, clear: CLEAR } = chartPalette;

const DEFAULT_PANE_HEIGHT = 120;

/** The room the click-to-order popover takes beside a click (the stylesheet's width; the height is its usual): it opens to the left of the click, or higher, to stay inside the chart. */
const PICK_WIDTH = 232;
const PICK_HEIGHT = 152;

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
type TickFormat = (time: Time, tickType: number) => string;
type MainKind = "Candlestick" | "Bar" | "Line" | "Area";
type MainSeries = ISeriesApi<SeriesType, Time>;
/** A series the chart feeds in runs (`ChunkedSeries`): the price series, the volume, the session shading, each stretch of a line. */
type Runs = ChunkedSeries<{ time: Time }>;
type Candle = ReturnType<typeof candlestickData>[number];
/** The crosshair's bar lookup, shaped like a series so the same tail feed keeps it up to date. */
type Lookup = { map: Map<string, Candle>; setData(points: Candle[]): void; update(point: Candle): void };

const MAIN_KIND: Record<ChartType, MainKind> = { candles: "Candlestick", hollow: "Candlestick", bars: "Bar", line: "Line", area: "Area" };

function addMainRun(library: Library, chart: IChartApi, kind: MainKind): MainSeries {
  switch (kind) {
    case "Bar": return chart.addSeries(library.BarSeries, { upColor: UP, downColor: DOWN, openVisible: true, thinBars: false }) as MainSeries;
    case "Line": return chart.addSeries(library.LineSeries, { color: PRICE, lineWidth: 2, crosshairMarkerVisible: true }) as MainSeries;
    case "Area": return chart.addSeries(library.AreaSeries, { lineColor: PRICE, topColor: chartPalette.priceFillTop, bottomColor: chartPalette.priceFillBottom, lineWidth: 2 }) as MainSeries;
    case "Candlestick": return chart.addSeries(library.CandlestickSeries, { upColor: UP, downColor: DOWN, wickUpColor: UP, wickDownColor: DOWN, borderVisible: false }) as MainSeries;
  }
}

/** The price series: a line or an area is joined from run to run, bars and candles stand alone. */
const addMainSeries = (library: Library, chart: IChartApi, kind: MainKind): Runs =>
  new ChunkedSeries(chart, () => addMainRun(library, chart, kind), kind === "Line" || kind === "Area");

/** Gives each series of the main pane its place in the stack, bottom first (a later series is drawn over an earlier one): the session shading, the price series, the lines, the volume. */
function restack(groups: Array<Runs | null>): void {
  let place = 0;
  // Only a series that is not where it belongs is moved: a run added at the top is the one to move, and the rest then are in place.
  for (const group of groups) {
    for (const series of group?.all ?? []) {
      if (series.seriesOrder() !== place) series.setSeriesOrder(place);
      place += 1;
    }
  }
}

/** The markers hang on the run of the price series that holds their bar; a run with none has no plugin at all. */
function placeMarkers(library: Library, group: Runs, plugins: Map<MainSeries, ISeriesMarkersPluginApi<Time>>, list: SeriesMarker<Time>[]) {
  const spans = group.spans();
  const live = new Set(spans.map(({ series }) => series));
  for (const [series, plugin] of plugins) {
    if (live.has(series)) continue;
    try {
      plugin.detach();
    } catch {
      // the run is gone with its plugin
    }
    plugins.delete(series);
  }
  for (const { series, from, to } of spans) {
    const mine = list.filter((marker) => timeKey(marker.time) >= from && timeKey(marker.time) < to);
    const plugin = plugins.get(series);
    if (plugin) plugin.setMarkers(mine);
    else if (mine.length > 0) plugins.set(series, library.createSeriesMarkers(series, mine));
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

// The library formats the crosshair and every tick on every redraw: build each format once (D-217).
const utcMonthDay = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
const etMonthDayClock = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

export function formatChartTime(time: Time): string {
  if (typeof time === "object") return utcMonthDay.format(new Date(Date.UTC(time.year, time.month - 1, time.day)));
  return etMonthDayClock.format(new Date(typeof time === "number" ? time * 1000 : time));
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

/**
 * The chart's data table: every bar as a row, for screen readers and keyboard users. It depends on the bars alone, so it is memoised: a crosshair
 * move re-renders `MarketChart` (the level tooltip, the legend above it) many times a second, and 6,000 rows of formatted cells cost ~0.5 s a pass,
 * a main-thread stall on every move of the replay chart (D-201). The rows exist only while the disclosure is open: a closed `<details>` shows and reads
 * nothing, and React still walked all 6,000 row fibres in every commit (~25 ms) for each new bar of a followed chart (D-206). Open, each row is memoised
 * on its bar (below), so a refresh patches the newest row only.
 */
const ChartDataTable = memo(function ChartDataTable({ bars, rowLabels }: { bars: ChartBar[]; rowLabels?: readonly string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <details className={styles.dataTable} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Chart data table · {bars.length} source bars</summary>
      <div className={styles.tableScroll}>
        <table>
          <thead><tr><th scope="col">Time (ET)</th><th scope="col">Open</th><th scope="col">High</th><th scope="col">Low</th><th scope="col">Close</th></tr></thead>
          <tbody>{open && bars.map((bar, index) => <ChartDataRow key={`${bar.t}-${index}`} bar={bar} label={rowLabels?.[index]} />)}</tbody>
        </table>
      </div>
    </details>
  );
});

/** One row of the data table. A refresh passes on the same bar objects but the newest (the replay's merge keeps them), so only the newest row is formatted and patched: 6,000 rows of `sourceTimeLabel` and `formatValue` cost ~0.55 s a pass (D-206). */
const ChartDataRow = memo(function ChartDataRow({ bar, label }: { bar: ChartBar; label?: string }) {
  return <tr><th scope="row">{label ?? sourceTimeLabel(bar.t)}</th><td>{formatValue(bar.o)}</td><td>{formatValue(bar.h)}</td><td>{formatValue(bar.l)}</td><td>{formatValue(bar.c)}</td></tr>;
});

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
  sessionStart,
  clockTicks = false,
  rowLabels,
  moneyAxis,
  focus = null,
  paneLegends,
  levelTips = false,
  guardAxis = false,
  renderPick,
}: MarketChartProps) {
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const library = useRef<Library | null>(null);
  const main = useRef<Runs | null>(null);
  const mainKind = useRef<MainKind>("Candlestick");
  // The crosshair's OHLC by bar time. It is fed like a series (`syncSeries`): from the first changed bar on, not 6,000 entries again for each new bar (D-206).
  const barAt = useRef<Lookup>({
    map: new Map(),
    setData(points) {
      this.map = new Map(points.map((point) => [timeId(point.time), point]));
    },
    update(point) {
      this.map.set(timeId(point.time), point);
    },
  });
  // What each series was last given (by series object), so a refresh sends only what changed.
  const fed = useRef(new WeakMap<object, SeriesFed>());
  const markersFed = useRef<{ bars: ChartBar[]; markers: ChartMarkerInput[]; version: number } | null>(null);
  // One line per run of values of each overlay (`valueRuns`), keyed `id@first bar`: a session's stretch of VWAP is its own series (D-231).
  const overlaySeries = useRef(new Map<string, { id: string; series: Runs; look: string }>());
  const paneSeries = useRef(new Map<string, PaneSeriesApi>());
  const priceLines = useRef<IPriceLine[]>([]);
  // What the price series and its level lines were last set up from: a new bar changes neither, and each call to the library invalidates the chart (D-217).
  const mainLook = useRef("");
  const linesFor = useRef<{ series: MainSeries; levels: MarketChartLevel[]; levelTips: boolean } | null>(null);
  const panePriceLines = useRef(new Map<string, IPriceLine[]>());
  const volumeSeries = useRef<Runs | null>(null);
  const shadeSeries = useRef<Runs | null>(null);
  const markerPlugins = useRef(new Map<MainSeries, ISeriesMarkersPluginApi<Time>>());
  // Which runs the stacking order was last set for (`restack`): it is set again only when a run comes or goes.
  const stacked = useRef("");
  // Hides the runs of the series that lie outside the view (`ChunkedSeries.cull`); set by the data effect, which knows the bars, and called whenever the view moves.
  const cullRuns = useRef<() => void>(() => {});
  const crosshairCallback = useRef(onCrosshair);
  const fitKey = useRef<string | null>(null);
  const lastIndex = useRef(-1);
  const rightOffset = useRef<number | null>(null);
  const tickFormat = useRef<TickFormat | null>(null);
  const priceTickFormat = useRef<((prices: readonly number[]) => string[]) | null>(null);
  const paneSignature = useRef("");
  const paneLayout = useRef(panes);
  const [ready, setReady] = useState(false);
  const [paneTops, setPaneTops] = useState<number[]>([]);
  // Level tooltips and click-to-order read the newest levels from inside the chart's own event handlers.
  const levelsRef = useRef(levels);
  const levelTipsRef = useRef(levelTips);
  const pickEnabled = useRef(false);
  const pickBox = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const [pick, setPick] = useState<{ price: number; left: number; top: number } | null>(null);
  if (renderPick === undefined && pick !== null) setPick(null); // ordering became unavailable: an old pick must not come back with it

  useEffect(() => {
    crosshairCallback.current = onCrosshair;
  }, [onCrosshair]);

  useEffect(() => {
    levelsRef.current = levels;
    levelTipsRef.current = levelTips;
    pickEnabled.current = renderPick !== undefined;
  }, [levels, levelTips, renderPick]);

  useEffect(() => {
    paneLayout.current = panes;
  }, [panes]);

  useEffect(() => {
    let cancelled = false;
    const overlayMap = overlaySeries.current;
    const markerMap = markerPlugins.current;
    const paneMap = paneSeries.current;
    const paneLinesMap = panePriceLines.current;
    const lookup = barAt.current;
    let resizeWatch: ResizeObserver | null = null;
    let detachPinch: (() => void) | null = null;
    let detachRelabel: (() => void) | null = null;
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
      // A trackpad pinch (ctrl+wheel) zooms about the cursor at the fingers' pace; the library's own handler is a tenth as fast.
      detachPinch = attachPinchZoom(container.current, currentChart);
      // The library keeps each tick's label from the first time it formats it, until options are applied again, and ours leaves a label out by
      // where its tick sits (D-180). A label formatted in a layout that has since moved (the first after the data changes, before the range
      // lands) kept its answer, so the axis printed nothing for seconds after an interval switch (D-187). Apply the formatter again whenever the
      // view moves or resizes, once per frame.
      const scale = currentChart.timeScale();
      let relabel = 0;
      const relabelSoon = () => {
        cancelAnimationFrame(relabel);
        relabel = requestAnimationFrame(() => {
          if (tickFormat.current) currentChart.applyOptions({ timeScale: { tickMarkFormatter: tickFormat.current } });
          // The price ticks answer to where the tags are drawn, which moves with the last bar in view (D-200).
          if (priceTickFormat.current) currentChart.applyOptions({ localization: { tickmarksPriceFormatter: priceTickFormat.current } });
        });
      };
      const cullSoon = () => cullRuns.current();
      scale.subscribeVisibleLogicalRangeChange(relabelSoon);
      scale.subscribeVisibleLogicalRangeChange(cullSoon);
      scale.subscribeSizeChange(relabelSoon);
      detachRelabel = () => {
        cancelAnimationFrame(relabel);
        scale.unsubscribeVisibleLogicalRangeChange(relabelSoon);
        scale.unsubscribeVisibleLogicalRangeChange(cullSoon);
        scale.unsubscribeSizeChange(relabelSoon);
      };
      resizeWatch = new ResizeObserver(() => {
        const tops = layoutPanes(currentChart, paneLayout.current);
        setPaneTops((current) => (sameTops(current, tops) ? current : tops));
      });
      resizeWatch.observe(container.current);
      mainKind.current = "Candlestick";
      main.current = addMainSeries(module, currentChart, mainKind.current);
      const levelAt = (y: number) => {
        const series = main.current?.tail;
        return series ? nearestLevel(levelsRef.current, y, (price) => series.priceToCoordinate(price)) : null;
      };
      currentChart.subscribeCrosshairMove((param) => {
        if (levelTipsRef.current) {
          const hit = param.point && (param.paneIndex ?? 0) === 0 ? levelAt(param.point.y) : null;
          setTip(hit && param.point ? { x: param.point.x, y: param.point.y, text: hit.label } : null);
        }
        const callback = crosshairCallback.current;
        if (!callback || !main.current) return;
        if (!param.time || !param.point) {
          callback(null);
          return;
        }
        const values: Record<string, { value?: number } | undefined> = {};
        for (const { id, series } of overlaySeries.current.values()) values[id] ??= series.read(param.seriesData) as { value?: number } | undefined;
        for (const [id, entry] of paneSeries.current) values[id] = param.seriesData.get(entry.series) as { value?: number } | undefined;
        const volumeEntry = volumeSeries.current?.read(param.seriesData);
        callback(crosshairPoint(
          param.time,
          barAt.current.map.get(timeId(param.time)) as Parameters<typeof crosshairPoint>[1],
          volumeEntry as Parameters<typeof crosshairPoint>[2],
          values,
        ));
      });
      currentChart.subscribeClick((param) => {
        const series = main.current?.tail;
        if (!pickEnabled.current || !series || !param.point || (param.paneIndex ?? 0) !== 0) return;
        const price = levelAt(param.point.y)?.price ?? series.coordinateToPrice(param.point.y);
        if (price === null || !(price > 0)) return;
        const wrap = container.current;
        const { x, y } = param.point;
        setPick({
          price: roundToCents(price),
          left: wrap && x + 12 + PICK_WIDTH > wrap.clientWidth ? Math.max(0, x - 12 - PICK_WIDTH) : x + 12,
          top: Math.max(0, Math.min(y - 24, (wrap?.clientHeight ?? 0) - PICK_HEIGHT)),
        });
      });
      setReady(true);
    });
    return () => {
      cancelled = true;
      resizeWatch?.disconnect();
      detachPinch?.();
      detachRelabel?.();
      tickFormat.current = null;
      priceTickFormat.current = null;
      chart.current?.remove();
      chart.current = null;
      main.current = null;
      lookup.map.clear();
      fed.current = new WeakMap();
      markersFed.current = null;
      volumeSeries.current = null;
      shadeSeries.current = null;
      markerMap.clear();
      stacked.current = "";
      cullRuns.current = () => {};
      fitKey.current = null;
      lastIndex.current = -1;
      rightOffset.current = null;
      paneSignature.current = "";
      overlayMap.clear();
      paneMap.clear();
      priceLines.current = [];
      mainLook.current = "";
      linesFor.current = null;
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
      for (const plugin of markerPlugins.current.values()) plugin.detach();
      markerPlugins.current.clear();
      markersFed.current = null;
      priceLines.current = [];
      mainLook.current = "";
      linesFor.current = null;
      const old = main.current;
      main.current = null; // the library formats ticks while a series goes and while one comes: they see no price series then
      old.destroy();
      mainKind.current = wantKind;
      main.current = addMainSeries(chartLibrary, currentChart, wantKind);
    }
    const mainRuns = main.current;
    // The price series' look is set when it changes, not on every bar: a series that is told its options again rebuilds the colour of each of its 6,000 points (D-217).
    const look = `${chartType}|${lastPricePill}`;
    if (mainLook.current !== look) {
      if (wantKind === "Candlestick") mainRuns.applyOptions(candleStyle(chartType));
      mainRuns.applyOptions({ lastValueVisible: lastPricePill, priceLineVisible: lastPricePill });
      mainLook.current = look;
    }

    const dayName = moneyAxis ? new Map(bars.map((bar, index) => [timeId(chartTime(bar.t)), moneyAxis.days[index] ?? ""])) : null;
    const timeLabel = dayName ? (time: Time) => dayName.get(timeId(time)) ?? "" : formatChartTime;
    // The right offset goes in only when it changes: the library scrolls to it every time it is set, so setting it on each data update snapped a chart she had scrolled back to the newest bar.
    const wantedOffset = follow ? FOLLOW_RIGHT_PAD : 0;
    // The library centres a tick label on its tick and clips it at the axis edge ("0 AM" for "04:00 AM", D-180): a label that would not
    // print whole is left out instead. The axis is the time scale's width and a tick's place is the library's own answer for its time.
    const wholeLabel = (label: string, time: Time) => {
      const scale = currentChart.timeScale();
      return wholeAxisLabel(label, scale.timeToCoordinate(time), scale.width());
    };
    const tickLabel = dayName || !(follow || clockTicks) ? (time: Time) => timeLabel(time) : (time: Time, tickType: number) => replayTickLabel(time, tickType);
    const formatTick: TickFormat = (time, tickType) => wholeLabel(tickLabel(time, tickType), time);
    tickFormat.current = formatTick;
    // The tags on the price axis (the overlays' last values, the level lines' numbers, the last price) are the numbers that matter; a tick label
    // under one is left out, never cut (D-181, D-196), and so is one the pane's edge would cut (D-199). The library prints a series' tag at the
    // last bar in view and stacks crowded tags apart, so the tags are measured where it draws them, not at the newest value's price (D-200).
    // The money axis and the charts that opt in (`levelTips`, `guardAxis`) do this; a chart with indicator panes does not, because the library
    // takes one tick formatter for every price scale and the panes' scales are not this one.
    const closes = bars.map((bar) => bar.c ?? null);
    const drawnTags = () => {
      const series = main.current?.tail;
      // Not `series.getPane()`: the library formats ticks while a chart-type switch is removing the old series, and a removed series throws there.
      const height = currentChart.panes()[0]?.getHeight();
      if (!series || height === undefined) return { ys: [], height: null };
      const range = currentChart.timeScale().getVisibleLogicalRange();
      const right = range ? range.to : bars.length - 1;
      const prices = axisTagPrices(overlays.map(({ values }) => valueAtOrBefore(values, right)), levels, lastPricePill ? valueAtOrBefore(closes, right) : null);
      const ys = prices.flatMap((price) => {
        const y = series.priceToCoordinate(price);
        return y === null ? [] : [y];
      });
      const centre = valueAtOrBefore(closes, right);
      return { ys: drawnTagYs(ys, height, centre === null ? null : series.priceToCoordinate(centre)), height };
    };
    const clearsTags = moneyAxis !== undefined || ((levelTips || guardAxis) && panes.length === 0);
    const priceTick = moneyAxis ? moneyAxis.tick : (price: number) => main.current?.tail?.priceFormatter().format(price) ?? "";
    const tickmarksPriceFormatter = (prices: readonly number[]) => {
      const { ys, height } = drawnTags();
      return prices.map((price) => clearTickLabel(priceTick(price), main.current?.tail?.priceToCoordinate(price) ?? null, ys, height));
    };
    priceTickFormat.current = clearsTags ? tickmarksPriceFormatter : null;
    currentChart.applyOptions({
      timeScale: {
        timeVisible: interval !== "1d" && interval !== "1w",
        tickMarkFormatter: formatTick,
        ...rightOffsetOption(rightOffset.current, wantedOffset),
      },
      localization: {
        timeFormatter: timeLabel,
        ...(moneyAxis ? { priceFormatter: moneyAxis.label } : {}),
        ...(clearsTags ? { tickmarksPriceFormatter } : {}),
      },
    });
    rightOffset.current = wantedOffset;
    if (moneyAxis) currentChart.priceScale("right").applyOptions({ scaleMargins: { top: 0.12, bottom: 0.14 } });

    // An overlay is one line per run of its values (`valueRuns`): a line never joins two runs, so VWAP does not run across the pre-market (D-231).
    // Only the run that reaches the newest bar shows its axis tag; an older run's last value is not the value now.
    const wantedLines = new Set<string>();
    overlays.forEach((overlay) => {
      const lineStyle = overlay.style === "dashed" ? chartLibrary.LineStyle.Dashed : chartLibrary.LineStyle.Solid;
      for (const [from, to] of valueRuns(overlay.values)) {
        const key = `${overlay.id}@${bars[from]!.t}`;
        wantedLines.add(key);
        const newest = to === bars.length;
        let line = overlaySeries.current.get(key);
        if (!line) {
          // No full-width dotted line at the last value: it sits within cents of the last-price line, where her marks land. The axis tag stays.
          const created = new ChunkedSeries(
            currentChart,
            () => currentChart.addSeries(chartLibrary.LineSeries, { color: overlay.color, lineWidth: 2, priceLineVisible: false }) as MainSeries,
            true,
            { priceLineVisible: false },
          );
          line = { id: overlay.id, series: created, look: "" };
          overlaySeries.current.set(key, line);
        }
        // Options are applied only when they change: each call to the library invalidates the chart, and a session's line is one of several.
        const look = `${overlay.color}|${overlay.label}|${lineStyle}|${newest}`;
        if (line.look !== look) {
          line.series.applyOptions({ color: overlay.color, title: overlay.label, lineStyle, lastValueVisible: newest });
          line.look = look;
        }
        syncSeries(line.series, fed.current, bars.slice(from, to), overlay.values.slice(from, to), "", lineData);
      }
    });
    for (const [key, line] of overlaySeries.current) {
      if (!wantedLines.has(key)) {
        line.series.destroy();
        overlaySeries.current.delete(key);
      }
    }

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
          const negative = item.negativeColor ?? chartPalette.down;
          syncSeries(entry.series, fed.current, bars, item.values, `${item.color}|${negative}`, (b, v) => histogramData(b, v, item.color, negative));
          entry.series.applyOptions({ title: item.label, color: item.color });
        } else if (item.kind === "line" && entry.kind === "line") {
          syncSeries(entry.series, fed.current, bars, item.values, "", lineData);
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

    // The level lines are drawn again only when the levels (or the series they sit on) change, not for each new bar. They sit on the newest run of the price series.
    const lineSeries = mainRuns.tail!;
    const placedLines = linesFor.current;
    if (!placedLines || placedLines.series !== lineSeries || placedLines.levels !== levels || placedLines.levelTips !== levelTips) {
      for (const line of priceLines.current) {
        try {
          placedLines?.series.removePriceLine(line);
        } catch {
          // the run they sat on is gone, and the lines with it
        }
      }
      priceLines.current = levels.flatMap(({ label, price, color, style, plain }) => {
        if (price === null || !Number.isFinite(price)) return [];
        return [lineSeries.createPriceLine({
          price,
          title: plain || levelTips ? "" : label,
          color: color ?? chartPalette.muted,
          lineStyle: style === "dotted" ? chartLibrary.LineStyle.Dotted : chartLibrary.LineStyle.Dashed,
          lineWidth: 1,
          axisLabelVisible: !plain,
        })];
      });
      linesFor.current = { series: lineSeries, levels, levelTips };
    }

    // Before the data changes: where is the view? If it is parked at the newest bar (within a bar or two), it stays there.
    const visible = keepRange ?? currentChart.timeScale().getVisibleLogicalRange();
    // The series are fed from the first bar that changed (`syncSeries`): a new bar of a 6,000-bar chart is one `update`, not 6,000 points built and sent again.
    syncSeries(barAt.current, fed.current, bars, null, "", candlestickData);
    if (wantKind === "Line" || wantKind === "Area") syncSeries(mainRuns, fed.current, bars, closes, "", lineData);
    else syncSeries(mainRuns, fed.current, bars, null, "", candlestickData);

    if (volume && !volumeSeries.current) {
      volumeSeries.current = new ChunkedSeries(
        currentChart,
        () => {
          const added = currentChart.addSeries(chartLibrary.HistogramSeries, {
            priceScaleId: "",
            priceFormat: { type: "volume" },
            lastValueVisible: false,
            priceLineVisible: false,
          });
          added.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
          return added as MainSeries;
        },
        false,
        { lastValueVisible: false, priceLineVisible: false },
      );
    } else if (!volume && volumeSeries.current) {
      volumeSeries.current.destroy();
      volumeSeries.current = null;
    }
    if (volumeSeries.current) syncSeries(volumeSeries.current, fed.current, bars, null, "", volumeData);

    if (sessionShading && !shadeSeries.current) {
      shadeSeries.current = new ChunkedSeries(
        currentChart,
        () => {
          const added = currentChart.addSeries(chartLibrary.HistogramSeries, {
            priceScaleId: "extended-hours",
            priceFormat: { type: "volume" },
            lastValueVisible: false,
            priceLineVisible: false,
          });
          added.priceScale().applyOptions({ scaleMargins: { top: 0, bottom: 0 }, visible: false });
          return added as MainSeries;
        },
        false,
        { lastValueVisible: false, priceLineVisible: false },
      );
    } else if (!sessionShading && shadeSeries.current) {
      shadeSeries.current.destroy();
      shadeSeries.current = null;
    }
    if (shadeSeries.current) syncSeries(shadeSeries.current, fed.current, bars, null, "", shadingData);

    // Bottom to top: the session shading (behind the candles and lines: a later series is drawn on top, the week shading hid the equity lines), the price series,
    // the lines, the volume. A run is a series of its own, so the order is set again whenever one is added or removed.
    const stack = [shadeSeries.current, mainRuns, ...[...overlaySeries.current.values()].map(({ series }) => series), volumeSeries.current];
    const stackKey = stack.map((group) => group?.stamp ?? "-").join(",");
    if (stacked.current !== stackKey) {
      restack(stack);
      stacked.current = stackKey;
    }

    const placed = markersFed.current;
    // No markers before and none now: a new bar has nothing to place, and setting an empty list still invalidates the chart (D-217).
    const stillNone = placed !== null && placed.version === mainRuns.version && placed.markers.length === 0 && markers.length === 0;
    if (!stillNone && (!placed || placed.bars !== bars || placed.markers !== markers || placed.version !== mainRuns.version)) {
      placeMarkers(chartLibrary, mainRuns, markerPlugins.current, seriesMarkers(bars, markers));
      markersFed.current = { bars, markers, version: mainRuns.version };
    }

    // Fit on a new symbol or timeframe (or the first data), not on every refresh, so zoom survives a refetch.
    const key = `${symbol}:${interval}`;
    const count = barAt.current.map.size;
    // Before the open the view waits at the session's first bar; from the first session bar on a followed chart shows the newest bars (D-186).
    const waiting = sessionStart === undefined ? null : pinnedRange(count, sessionStart, firstDraw + FOLLOW_RIGHT_PAD - 1, firstDraw);
    if (bars.length && fitKey.current !== key) {
      if (follow) currentChart.timeScale().setVisibleLogicalRange(waiting ?? { from: Math.max(0, count - firstDraw), to: count - 1 + FOLLOW_RIGHT_PAD });
      else currentChart.timeScale().fitContent();
      fitKey.current = key;
    } else if (keepRange) {
      currentChart.timeScale().setVisibleLogicalRange(keepRange);
    } else if (followsNewest(follow, visible, lastIndex.current, waiting)) {
      // The view keeps its zoom and the newest bar goes back to its place at once, as a load puts it. `scrollToRealTime` is a 400 ms animation on the
      // library's own frame clock; under a held clock (every e2e page runs on a fixed one) it stopped part-way, with the right offset at 66 to 79 slots
      // instead of 10, and the newest bars sat bunched to the left of a blank plot with the ticks behind them (D-195). Still before the open the
      // view stays where it waits.
      currentChart.timeScale().scrollToPosition(FOLLOW_RIGHT_PAD, false);
    }
    lastIndex.current = count - 1;

    // The older runs that lie outside the view are hidden, so a new bar rebuilds the drawing items of the runs in view and not of all 6,000 bars (D-217).
    cullRuns.current = () => {
      const groups = [main.current, volumeSeries.current, shadeSeries.current, ...[...overlaySeries.current.values()].map(({ series }) => series)];
      const range = currentChart.timeScale().getVisibleLogicalRange();
      if (range === null || bars.length === 0) {
        for (const group of groups) group?.cull(Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY);
        return;
      }
      const keyAt = (index: number) => timeKey(chartTime(bars[Math.min(bars.length - 1, Math.max(0, index))]!.t));
      const from = keyAt(Math.floor(range.from) - CULL_MARGIN_BARS);
      const to = keyAt(Math.ceil(range.to) + CULL_MARGIN_BARS);
      for (const group of groups) group?.cull(from, to);
    };
    cullRuns.current();
  }, [ready, symbol, interval, bars, overlays, panes, levels, levelTips, markers, sessionShading, volume, lastPricePill, follow, firstDraw, sessionStart, clockTicks, chartType, moneyAxis, guardAxis]);

  // Click-to-order: a dashed line with its price on the axis at the picked price, for as long as the pick is open. Declared after
  // the data effect, whose series swap (a chart-type change) it follows: the cleanup removes the line from the old series first.
  const pickPrice = renderPick !== undefined && pick !== null ? pick.price : null;
  useEffect(() => {
    const series = main.current?.tail;
    const chartLibrary = library.current;
    if (pickPrice === null || !ready || !series || !chartLibrary) return;
    const line = series.createPriceLine({ price: pickPrice, title: "", color: chartPalette.text, lineStyle: chartLibrary.LineStyle.Dashed, lineWidth: 1, axisLabelVisible: true });
    return () => {
      // The line sits on the run that was newest when it was drawn; a chart-type change, or the chart going, has removed that run and the line with it.
      try {
        series.removePriceLine(line);
      } catch {
        // gone with its run
      }
    };
  }, [pickPrice, ready, chartType]);

  // Escape closes the pick before the workspace's own Escape (full screen, a form) sees it; a press anywhere else closes it too.
  useEffect(() => {
    if (pickPrice === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopImmediatePropagation();
      setPick(null);
    };
    const onDown = (event: PointerEvent) => {
      if (event.target instanceof Node && pickBox.current?.contains(event.target)) return;
      setPick(null);
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown, true);
    };
  }, [pickPrice]);

  // Move the crosshair to the asked-for bar, scrolling it into view when it is off screen. Never touches the data.
  useEffect(() => {
    const currentChart = chart.current;
    const candleSeries = main.current?.tail;
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
  const stamp = formatChartAsOf(asOf);
  const bare = chrome === "bare";
  return (
    <section
      className={`${styles.chartCard} ${bare ? styles.bare : ""}`}
      aria-label={`${symbol} ${interval} market chart`}
      data-dim={dimmed ? "true" : undefined}
    >
      {!bare && <header className={styles.chartHeader}>
        <h2>{interval.toUpperCase()} chart · {symbol}</h2>
        <p><span>{qualityPhrase(quality)}</span>{stamp !== "" && <span>{stamp}</span>}</p>
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
        {levelTips && tip && <div className={styles.levelTip} role="tooltip" style={{ left: tip.x + 12, top: Math.max(0, tip.y - 32) }}>{tip.text}</div>}
        {renderPick && pick && (
          <div ref={pickBox} className={styles.pick} style={{ left: pick.left, top: pick.top }}>
            {renderPick(pick.price, () => setPick(null))}
          </div>
        )}
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
      <ChartDataTable bars={bars} rowLabels={rowLabels} />
      <footer className={styles.chartFooter}><a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">Charts by TradingView</a></footer>
      </div>
    </section>
  );
}
