"use client";

import { MarketChart } from "@/components/charts/MarketChart";
import { ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import { loadBars } from "@/lib/desk/charts";
import { symbolHref } from "@/lib/desk/listNav";
import { previewInterval } from "@/lib/desk/screenerView";
import { chartDays } from "@/lib/desk/timeframes";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import styles from "./screener.module.css";

/** Right-rail preview of the selected row, at the timeframe the filter runs on. No indicator panes. */
export function PreviewPane({ symbol, runOn }: { symbol: string | null; runOn: string }) {
  if (symbol === null) return <p className={styles.muted}>Select a row to preview its chart</p>;
  return <Preview symbol={symbol} interval={previewInterval(runOn)} />;
}

function Preview({ symbol, interval }: { symbol: string; interval: "15m" | "1d" }) {
  const bars = useDeskQuery(`preview:${symbol}:${interval}`, (signal) => loadBars(symbol, interval, { days: chartDays(interval) }, { signal }));
  if (bars.loading) return <LoadingBlock label="Loading chart…" height={200} />;
  if (bars.data === null) return <ErrorBlock subject="chart" onRetry={bars.refresh} />;
  return (
    <div className={styles.preview}>
      <div className={styles.previewHead}>
        <a href={symbolHref(symbol)} className={styles.symbol}>{symbol}</a>
        <a href={symbolHref(symbol)} className={styles.link}>Open chart</a>
      </div>
      <MarketChart
        symbol={symbol}
        interval={interval}
        bars={bars.data.bars}
        quality={bars.data.quality}
        asOf={bars.data.as_of}
        lastPricePill
        chrome="bare"
        height={260}
      />
    </div>
  );
}
