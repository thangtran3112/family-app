"use client";

import { useMemo, useState } from "react";
import { MarketChart, type MarketChartLevel } from "@/components/charts/MarketChart";
import { ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import { PRACTICE_COPY } from "@/lib/desk/freshness";
import type { Peek } from "@/lib/replay/daily";
import { peekDailyBars } from "@/lib/replay/dayView";
import styles from "./day.module.css";

const AMBER = "#FFB020";

function levelLines(peek: Peek, view: "daily" | "today"): MarketChartLevel[] {
  const { levels } = peek;
  const rows: MarketChartLevel[] = [{ label: "List price", price: peek.list_price ?? null, color: AMBER, style: "dashed" }];
  if (view === "daily") return rows;
  return [
    ...rows,
    { label: "Prior close", price: levels.prior_close ?? null, style: "dotted" },
    { label: "Prior high", price: levels.prior_high ?? null, style: "dotted" },
    { label: "Prior low", price: levels.prior_low ?? null, style: "dotted" },
    { label: "Premarket high", price: levels.premarket_high ?? null, style: "dotted" },
    { label: "Premarket low", price: levels.premarket_low ?? null, style: "dotted" },
  ];
}

/**
 * Peek (02o-b v1): one candidate's chart before the open, cut at the time the list was built. The daily bars are the
 * list's own share-adjusted frame (never the raw one), and with dates hidden they sit on a stand-in timeline.
 */
export function PeekPanel({
  symbol,
  peek,
  loading,
  failed,
  onRetry,
  hideDates,
}: {
  symbol: string | null;
  peek: Peek | null;
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
  hideDates: boolean;
}) {
  const [view, setView] = useState<"daily" | "today">("today");
  const daily = useMemo(() => (peek ? peekDailyBars(peek.daily, hideDates) : []), [peek, hideDates]);
  const levels = useMemo(() => (peek ? levelLines(peek, view) : []), [peek, view]);

  if (symbol === null) return <p className={styles.muted}>{PRACTICE_COPY.dayPeekNone}</p>;
  if (failed) return <ErrorBlock subject="chart" onRetry={onRetry} />;
  if (loading || peek === null) return <LoadingBlock label={`Loading the ${symbol} chart…`} height={240} />;

  const showToday = view === "today" && peek.minutes.length > 0;
  return (
    <div className={styles.peek}>
      <div className={styles.peekHead}>
        <h3 className={styles.peekTitle}>{peek.symbol}</h3>
        <div role="tablist" aria-label="Peek view" className={styles.tabs}>
          {(["today", "daily"] as const).map((tab) => (
            <button key={tab} type="button" role="tab" aria-selected={view === tab} className={styles.tab} onClick={() => setView(tab)}>
              {tab === "today" ? PRACTICE_COPY.dayPeekToday : "Daily"}
            </button>
          ))}
        </div>
      </div>
      {showToday ? (
        <MarketChart
          symbol={peek.symbol}
          interval="1m"
          bars={peek.minutes.map((bar) => ({ ...bar, ext: true }))}
          quality="delayed-15m"
          asOf={peek.data_through}
          levels={levels}
          volume
          hideDates={hideDates}
          clockTicks
          sessionShading
          chrome="bare"
          height={260}
        />
      ) : (
        <MarketChart
          symbol={peek.symbol}
          interval="1d"
          bars={daily}
          quality="eod"
          asOf={null}
          levels={levels}
          volume
          hideDates={hideDates}
          chrome="bare"
          height={260}
        />
      )}
      <p className={styles.muted}>{view === "daily" || !showToday ? PRACTICE_COPY.dayPeekDaily : "Premarket bars through the list's data time"}</p>
    </div>
  );
}
