"use client";

import { useMemo, useState } from "react";
import { MarketChart } from "@/components/charts/MarketChart";
import { RightRail, type RailSection } from "@/components/shell/desktop/RightRail";
import { useDeskStatus } from "@/components/shell/desktop/DeskContext";
import { AsOfLine } from "@/components/ui/AsOfLine";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import type { ChartMarkerInput, CrosshairPoint } from "@/lib/chart-data";
import { loadAlertStrategies } from "@/lib/desk/alerts";
import { loadBars, loadMarkers, loadTechnicals, type ChartSession } from "@/lib/desk/charts";
import { COPY, fillCopy, type Connection } from "@/lib/desk/freshness";
import { chartDays, HEADER_DAYS, isIntraday, timeframeLabel } from "@/lib/desk/timeframes";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import { useLiveQuote } from "@/lib/desk/useLiveQuote";
import { useShellBand } from "@/lib/desk/useViewportBand";
import {
  alertLevels,
  buildChartSeries,
  buildLevels,
  defaultIndicators,
  headerSummary,
  legendModel,
  noMarketData,
  toggleIndicator,
  type IndicatorId,
} from "@/lib/desk/workspace";
import { AlertsOnStock } from "./AlertsOnStock";
import { BottomPanel } from "./BottomPanel";
import { ChartLegend, PaneLegend } from "./ChartLegend";
import { ChartToolbar } from "./ChartToolbar";
import { KeyLevels } from "./KeyLevels";
import { RightRailSummary } from "./RightRailSummary";
import { StrategyMatches } from "./StrategyMatches";
import { SymbolHeader } from "./SymbolHeader";
import styles from "./workspace.module.css";

const humanize = (pattern: string) => pattern.replaceAll("_", " ").replace(/^\w/, (character) => character.toUpperCase());

/** D3: symbol header, toolbar, chart with legend/markers/levels, bottom panel; summary, alerts and levels in the right rail. */
export function ChartWorkspace({ symbol, timeframe, onTimeframe }: { symbol: string; timeframe: string; onTimeframe: (api: string) => void }) {
  const { status } = useDeskStatus();
  const [session, setSession] = useState<ChartSession>("regular");
  const [indicators, setIndicators] = useState<ReadonlySet<IndicatorId>>(defaultIndicators);
  // The bottom panel is open at 1440; at 1180 it starts collapsed so the chart keeps its height.
  const band = useShellBand();
  const [bottomOverride, setBottomOverride] = useState<boolean | null>(null);
  const bottomCollapsed = bottomOverride ?? band === "1180";
  const [crosshair, setCrosshair] = useState<CrosshairPoint | null>(null);

  const marketOpen = status !== null && status.market.session !== "closed";
  const refresh = marketOpen ? 60_000 : undefined;
  // Technicals have no 1m timeframe: the rail reads 5m while the chart is on 1m.
  const technicalsTimeframe = timeframe === "1m" ? "5m" : timeframe;

  const bars = useDeskQuery(`bars:${symbol}:${timeframe}:${session}`, (signal) => loadBars(symbol, timeframe, { days: chartDays(timeframe), session }, { signal }), { intervalMs: refresh });
  const technicals = useDeskQuery(`technicals:${symbol}:${technicalsTimeframe}`, (signal) => loadTechnicals(symbol, technicalsTimeframe, 3650, { signal }), { intervalMs: refresh });
  const markers = useDeskQuery(`markers:${symbol}:${timeframe}`, (signal) => loadMarkers(symbol, timeframe, {}, { signal }), { intervalMs: refresh });
  const strategies = useDeskQuery(`alert-strategies:${symbol}`, (signal) => loadAlertStrategies({ symbol }, { signal }));
  // The header's day change reads daily bars on every timeframe (V-Technicals-01).
  const daily = useDeskQuery(`daily:${symbol}`, (signal) => loadBars(symbol, "1d", { days: HEADER_DAYS }, { signal }), { intervalMs: refresh });
  const live = useLiveQuote(symbol);

  const barRows = useMemo(() => bars.data?.bars ?? [], [bars.data]);
  const series = useMemo(() => buildChartSeries(barRows, indicators, timeframe), [barRows, indicators, timeframe]);
  const levels = useMemo(() => buildLevels(technicals.data, alertLevels(strategies.data ?? [])), [technicals.data, strategies.data]);
  const chartMarkers = useMemo<ChartMarkerInput[]>(
    () => [
      ...(markers.data?.patterns ?? []).map((marker) => ({ time: marker.bar_start, kind: "pattern" as const, label: humanize(marker.pattern) })),
      ...(markers.data?.fires ?? []).map((fire) => ({ time: fire.bar_time, kind: "fire" as const, label: fire.strategy_name })),
    ],
    [markers.data],
  );

  const connection: Connection = bars.connection === "reconnecting" || live.connection === "reconnecting" ? "reconnecting" : bars.updating ? "updating" : "ok";
  const dailyRows = daily.data?.bars ?? [];
  const summary = headerSummary(live.quote, dailyRows, barRows);
  // Nothing stored for the symbol at all (a typo, a symbol the Desk does not carry): one plain empty state instead of
  // "trying again" and "warming up", which promised data that never comes (V-Technicals-03).
  const noData = bars.data !== null && daily.data !== null && noMarketData(live.quote, dailyRows, barRows);
  const sessionState = live.quote?.session ?? status?.market.session;
  const stamp = live.quote ? { as_of: live.quote.as_of, source: live.quote.source ?? bars.data?.stamp.source ?? null, quality: live.quote.quality, freshness: live.quote.freshness ?? bars.data?.stamp.freshness ?? "delayed" } : (bars.data?.stamp ?? null);
  const label = timeframeLabel(timeframe);
  const legend = legendModel(symbol, label, barRows, series.overlays, crosshair);

  const allRailSections: RailSection[] = [
    {
      id: "summary",
      label: "Summary",
      node: technicals.data ? <RightRailSummary technicals={technicals.data} timeframeLabel={timeframeLabel(technicalsTimeframe)} /> : railState(technicals.error !== null, "technicals", "technical summary", technicals.refresh),
    },
    {
      id: "alerts",
      label: "Alerts",
      node: (
        <>
          <AlertsOnStock symbol={symbol} strategies={strategies.data} failed={strategies.data === null && strategies.error !== null} onRetry={strategies.refresh} />
          <StrategyMatches gauge={technicals.data?.gauges.strategies ?? null} />
        </>
      ),
    },
    {
      id: "levels",
      label: "Levels",
      node: technicals.data ? <KeyLevels technicals={technicals.data} /> : railState(technicals.error !== null, "levels", "level list", technicals.refresh),
    },
  ];
  const railSections = noData ? allRailSections.filter((section) => section.id === "alerts") : allRailSections;

  let chartArea;
  if (bars.loading) chartArea = <LoadingBlock label="Loading chart…" height={420} />;
  else if (bars.data === null) chartArea = <ErrorBlock subject="chart" onRetry={bars.refresh} />;
  else if (noData) {
    chartArea = (
      <div role="status">
        <EmptyBlock title={fillCopy(COPY.noMarketData, { symbol })}>{COPY.noMarketDataHint}</EmptyBlock>
      </div>
    );
  } else {
    chartArea = (
      <div className={styles.chartArea}>
        <MarketChart
          symbol={symbol}
          interval={timeframe}
          bars={barRows}
          quality={bars.data.quality}
          asOf={bars.data.as_of}
          overlays={series.overlays}
          panes={series.panes}
          levels={levels}
          markers={chartMarkers}
          sessionShading={session === "extended"}
          volume={series.volume}
          lastPricePill
          onCrosshair={setCrosshair}
          chrome="bare"
          height="fill"
          clockTicks={isIntraday(timeframe)}
          dimmed={connection === "reconnecting"}
          paneLegends={series.panes.map((pane) => (
            <PaneLegend
              key={pane.id}
              label={pane.label}
              items={pane.series.map((item) => ({ label: item.label, color: item.color, value: legendValue(item.id, pane.id, item.values, crosshair) }))}
              onClose={() => setIndicators((current) => toggleIndicator(current, pane.id as IndicatorId))}
            />
          ))}
        />
        <div className={styles.legend}><ChartLegend model={legend} /></div>
      </div>
    );
  }

  return (
    <div className={styles.workspace}>
      <SymbolHeader symbol={symbol} name={null} summary={summary} stamp={stamp} session={sessionState} connection={connection} view="chart" notice={noData ? COPY.noMarketDataBadge : undefined} />
      <ChartToolbar
        timeframe={timeframe}
        onTimeframe={onTimeframe}
        session={session}
        onSession={setSession}
        indicators={indicators}
        onToggleIndicator={(id) => setIndicators((current) => toggleIndicator(current, id))}
        alertHref={`/alerts/new?source=symbol:${encodeURIComponent(symbol)}`}
      />
      <div className={styles.chartSlot}>{chartArea}</div>
      {bars.data && !noData && <div className={styles.asOf}><AsOfLine stamp={bars.data.stamp} /></div>}
      {!noData && <BottomPanel symbol={symbol} timeframeLabel={timeframeLabel(technicalsTimeframe)} technicals={technicals.data} collapsed={bottomCollapsed} onToggle={() => setBottomOverride(!bottomCollapsed)} />}
      <RightRail sections={railSections} label="Symbol context" />
    </div>
  );
}

function railState(failed: boolean, loading: string, subject: string, retry: () => void) {
  return failed ? <ErrorBlock subject={subject} onRetry={retry} /> : <LoadingBlock label={`Loading ${loading}…`} height={80} />;
}

function legendValue(seriesId: string, paneId: string, values: Array<number | null>, point: CrosshairPoint | null): string {
  const value = point ? (point.values[`${paneId}:${seriesId}`] ?? null) : (values.at(-1) ?? null);
  return value === null ? "—" : value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}
