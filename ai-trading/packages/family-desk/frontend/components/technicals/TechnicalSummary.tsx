"use client";

import { MarketChart } from "@/components/charts/MarketChart";
import { RightRail, type RailSection } from "@/components/shell/desktop/RightRail";
import { useDeskStatus } from "@/components/shell/desktop/DeskContext";
import { AsOfLine } from "@/components/ui/AsOfLine";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import { AlertsOnStock } from "@/components/workspace/AlertsOnStock";
import { KeyLevels } from "@/components/workspace/KeyLevels";
import { StrategyMatches } from "@/components/workspace/StrategyMatches";
import { SymbolHeader } from "@/components/workspace/SymbolHeader";
import { loadAlertStrategies } from "@/lib/desk/alerts";
import { loadBars, loadTechnicals } from "@/lib/desk/charts";
import { historyBanner } from "@/lib/desk/summary";
import { chartDays, HEADER_DAYS, SUMMARY_TIMEFRAMES, timeframeLabel } from "@/lib/desk/timeframes";
import { COPY, fillCopy, type Connection } from "@/lib/desk/freshness";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import { useLiveQuote } from "@/lib/desk/useLiveQuote";
import { headerSummary, noMarketData } from "@/lib/desk/workspace";
import { BiasGauge } from "./Gauges";
import { IndicatorTables } from "./IndicatorTables";
import { PivotsTable } from "./PivotsTable";
import { StrategyVotesGauge } from "./StrategyVotesGauge";
import { SummaryFootnote } from "./SummaryFootnote";
import { TimeframeTabs } from "./TimeframeTabs";
import { WhatChangedLine } from "./WhatChangedLine";
import styles from "./technicalsDesktop.module.css";


/** D4: timeframe tabs, four half-dial gauges, what changed, vote and pivot tables; the right rail keeps a mini chart. */
export function TechnicalSummary({ symbol, timeframe, onTimeframe }: { symbol: string; timeframe: string; onTimeframe: (api: string) => void }) {
  const { status } = useDeskStatus();
  const marketOpen = status !== null && status.market.session !== "closed";
  const refresh = marketOpen ? 60_000 : undefined;

  const technicals = useDeskQuery(`summary:${symbol}:${timeframe}`, (signal) => loadTechnicals(symbol, timeframe, 3650, { signal }), { intervalMs: refresh });
  const bars = useDeskQuery(`summary-bars:${symbol}:${timeframe}`, (signal) => loadBars(symbol, timeframe, { days: chartDays(timeframe) }, { signal }), { intervalMs: refresh });
  const strategies = useDeskQuery(`alert-strategies:${symbol}`, (signal) => loadAlertStrategies({ symbol }, { signal }));
  // The header's day change reads daily bars on every timeframe (V-Technicals-01).
  const daily = useDeskQuery(`daily:${symbol}`, (signal) => loadBars(symbol, "1d", { days: HEADER_DAYS }, { signal }), { intervalMs: refresh });
  const live = useLiveQuote(symbol);

  const barRows = bars.data?.bars ?? [];
  const connection: Connection = technicals.connection === "reconnecting" || live.connection === "reconnecting" ? "reconnecting" : technicals.updating ? "updating" : "ok";
  const dailyRows = daily.data?.bars ?? [];
  const summary = headerSummary(live.quote, dailyRows, barRows);
  const noData = bars.data !== null && daily.data !== null && noMarketData(live.quote, dailyRows, barRows);
  const label = timeframeLabel(timeframe);
  const banner = technicals.data ? historyBanner(technicals.data, label) : null;

  const railSections: RailSection[] = [
    {
      id: "chart",
      label: "Chart",
      node: bars.data ? (
        <>
          <MarketChart symbol={symbol} interval={timeframe} bars={barRows} quality={bars.data.quality} asOf={bars.data.as_of} height={180} chrome="bare" lastPricePill />
          <a className={styles.openChart} href="#chart">Open full chart</a>
        </>
      ) : <LoadingBlock label="Loading chart…" height={120} />,
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
    { id: "levels", label: "Levels", node: technicals.data ? <KeyLevels technicals={technicals.data} /> : <LoadingBlock label="Loading levels…" height={80} /> },
  ];

  let body;
  if (technicals.loading) body = <LoadingBlock label="Loading technical summary…" height={320} />;
  else if (technicals.data === null) body = <ErrorBlock subject="summary" onRetry={technicals.refresh} />;
  else if (noData) {
    body = (
      <div role="status">
        <EmptyBlock title={fillCopy(COPY.noMarketData, { symbol })}>{COPY.noMarketDataHint}</EmptyBlock>
      </div>
    );
  } else {
    const data = technicals.data;
    const unavailable = data.quality === "unavailable";
    body = (
      <>
        {technicals.updating && <p className={styles.updating} role="status">{COPY.updating}</p>}
        {banner && <p className={styles.history} role="status">{banner}</p>}
        <div className={styles.gauges}>
          <BiasGauge size="large" title="Oscillators" gauge={data.gauges.oscillators} quality={data.quality} asOf={data.as_of} unavailable={unavailable} />
          <BiasGauge size="large" title="Summary" gauge={data.gauges.summary} quality={data.quality} asOf={data.as_of} unavailable={unavailable} />
          <BiasGauge size="large" title="Moving averages" gauge={data.gauges.moving_averages} quality={data.quality} asOf={data.as_of} unavailable={unavailable} />
          <StrategyVotesGauge gauge={data.gauges.strategies} quality={data.quality} asOf={data.as_of} />
        </div>
        <WhatChangedLine technicals={data} />
        <IndicatorTables technicals={data} timeframe={timeframe} showPivots={false} plain />
        <PivotsTable pivots={data.pivots} quality={data.quality} asOf={data.as_of} />
        <AsOfLine stamp={data.stamp} />
        <SummaryFootnote />
      </>
    );
  }

  return (
    <div className={styles.page}>
      <SymbolHeader
        symbol={symbol}
        name={null}
        summary={summary}
        stamp={technicals.data?.stamp ?? null}
        session={live.quote?.session ?? status?.market.session}
        connection={connection}
        view="summary"
        notice={noData ? COPY.noMarketDataBadge : undefined}
      />
      <div className={styles.tabs}><TimeframeTabs options={SUMMARY_TIMEFRAMES} value={timeframe} onChange={onTimeframe} /></div>
      <div className={styles.content} data-dim={connection === "reconnecting" ? "true" : undefined}>{body}</div>
      <RightRail sections={railSections} label="Symbol context" />
    </div>
  );
}
