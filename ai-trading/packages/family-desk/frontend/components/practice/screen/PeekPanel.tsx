"use client";

import { useMemo, useState } from "react";
import { MarketChart, type MarketChartLevel } from "@/components/charts/MarketChart";
import { ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import { TabPanel, Tabs } from "@/components/ui/Tabs";
import { ChartLegend } from "@/components/workspace/ChartLegend";
import { EMPTY_VALUE, formatPrice, formatSignedPct, signTone } from "@/lib/desk/format";
import { levelsLegend } from "@/lib/desk/workspace";
import { PRACTICE_COPY } from "@/lib/desk/freshness";
import type { Candidate, Peek } from "@/lib/replay/screen";
import styles from "./screen.module.css";
import { FactList } from "@/components/ui/FactList";

const AMBER = "#FFB020";
const PEEK_TABS_ID = "peek-view";
/** The chart's height in the drawer: tall enough to tell levels apart, short enough that the chart, its legend and the three fact rows fit a 768 px laptop without scrolling. */
const PEEK_CHART_HEIGHT = 320;

/** The levels are `plain` lines: the legend under the title names them, so no tag prints over the candles or over a level close in price. */
function levelLines(peek: Peek, view: "daily" | "today"): MarketChartLevel[] {
  const { levels } = peek;
  const rows: MarketChartLevel[] = [{ label: PRACTICE_COPY.screenPeekPrice, price: peek.list_price ?? null, color: AMBER, style: "dashed", plain: true }];
  if (view === "daily") return rows;
  return [
    ...rows,
    { label: "Prior close", price: levels.prior_close ?? null, style: "dotted", plain: true },
    { label: "Prior high", price: levels.prior_high ?? null, style: "dotted", plain: true },
    { label: "Prior low", price: levels.prior_low ?? null, style: "dotted", plain: true },
    { label: "Premarket high", price: levels.premarket_high ?? null, style: "dotted", plain: true },
    { label: "Premarket low", price: levels.premarket_low ?? null, style: "dotted", plain: true },
  ];
}

/**
 * Peek (02o-b v1): one candidate's chart before the open, cut at the time of the scan. The daily bars are the
 * Screen's own share-adjusted frame (never the raw one), each on its real date. The Screen
 * shows it in a drawer (`ui/Dialog` size "drawer"), wide enough for the chart and its level legend.
 */
export function PeekPanel({
  symbol,
  row,
  peek,
  loading,
  failed,
  onRetry,
}: {
  symbol: string;
  /** The Screen row of the peeked name: its prev close, scan-price change and earnings flag (P7's facts under the chart). */
  row: Candidate | null;
  peek: Peek | null;
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
}) {
  const [view, setView] = useState<"daily" | "today">("today");
  const levels = useMemo(() => (peek ? levelLines(peek, view) : []), [peek, view]);
  const legend = useMemo(() => levelsLegend(PRACTICE_COPY.screenPeekLevels, levels), [levels]);

  if (failed) return <ErrorBlock subject="chart" onRetry={onRetry} />;
  if (loading || peek === null) return <LoadingBlock label={`Loading the ${symbol} chart…`} height={PEEK_CHART_HEIGHT} />;

  const showToday = view === "today" && peek.minutes.length > 0;
  return (
    <div className={styles.peek}>
      <div className={styles.peekHead}>
        <h3 className={styles.peekTitle}>{peek.symbol}</h3>
        <Tabs
          idBase={PEEK_TABS_ID}
          label="Peek view"
          size="md"
          track={false}
          value={view}
          tabs={[{ id: "today", label: PRACTICE_COPY.screenPeekToday }, { id: "daily", label: "Daily" }]}
          onChange={setView}
        />
      </div>
      <TabPanel idBase={PEEK_TABS_ID} id={view}>
      {legend.items.length > 0 && <div data-testid="peek-levels"><ChartLegend model={legend} /></div>}
      {showToday ? (
        <MarketChart
          symbol={peek.symbol}
          interval="1m"
          bars={peek.minutes.map((bar) => ({ ...bar, ext: true }))}
          quality="delayed-15m"
          asOf={peek.data_through}
          levels={levels}
          volume
          clockTicks
          sessionShading
          guardAxis
          chrome="bare"
          height={PEEK_CHART_HEIGHT}
        />
      ) : (
        <MarketChart
          symbol={peek.symbol}
          interval="1d"
          bars={peek.daily}
          quality="eod"
          asOf={null}
          levels={levels}
          volume
          guardAxis
          chrome="bare"
          height={PEEK_CHART_HEIGHT}
        />
      )}
      </TabPanel>
      <p className={styles.muted}>{view === "daily" || !showToday ? PRACTICE_COPY.screenPeekDaily : PRACTICE_COPY.screenPeekMinutes}</p>
      {row && <PeekFacts row={row} />}
    </div>
  );
}

/** Prev close, the list price against it, and the earnings state: dashes where the payload has no value (a name not checked reads a dash, not "none"). */
function PeekFacts({ row }: { row: Candidate }) {
  const change = row.metrics.list_change_pct ?? null;
  return (
    <FactList
      divided
      facts={[
        { id: "prev", label: PRACTICE_COPY.screenPeekPrevClose, value: row.prior_close === null ? EMPTY_VALUE : formatPrice(row.prior_close) },
        { id: "vs", label: PRACTICE_COPY.screenPeekVsPrev, value: change === null ? EMPTY_VALUE : formatSignedPct(change, 2), tone: change === null ? undefined : signTone(change) },
        { id: "earnings", label: PRACTICE_COPY.screenPeekEarnings, value: row.earnings_state === null ? EMPTY_VALUE : row.earnings_state === "reported" ? PRACTICE_COPY.screenPeekEarningsFlagged : PRACTICE_COPY.screenPeekEarningsNone },
      ]}
    />
  );
}
