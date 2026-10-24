"use client";

import { MarketChart, type MarketChartLevel } from "@/components/charts/MarketChart";
import editorStyles from "@/components/screener/editor/editor.module.css";
import { ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import { miniChartModel, type AlertForm, type MiniChartModel } from "@/lib/desk/alertForm";
import { loadBars } from "@/lib/desk/charts";
import { chartDays } from "@/lib/desk/timeframes";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";

/** The condition's level or pattern drawn on the first symbol's bars (D10 right pane). */
export function MiniChart({ form, resolvedSymbols }: { form: AlertForm; resolvedSymbols: readonly string[] }) {
  const model = miniChartModel(form, resolvedSymbols);
  if (model.symbol === null) return <p className={editorStyles.note}>Pick a symbol to see its chart</p>;
  return <Chart model={{ ...model, symbol: model.symbol }} />;
}

function Chart({ model }: { model: MiniChartModel & { symbol: string } }) {
  const bars = useDeskQuery(`setup-bars:${model.symbol}:${model.interval}`, (signal) =>
    loadBars(model.symbol, model.interval, { days: chartDays(model.interval) }, { signal }),
  );
  if (bars.loading) return <LoadingBlock label="Loading chart…" height={120} />;
  if (bars.data === null) return <ErrorBlock subject="chart" onRetry={bars.refresh} />;
  const levels: MarketChartLevel[] = model.level === null ? [] : [{ label: "🔔 Alert level", price: model.level, color: "#FFB020", style: "dashed" }];
  return (
    <div className={editorStyles.panel}>
      <MarketChart
        symbol={model.symbol}
        interval={model.interval}
        bars={bars.data.bars}
        quality={bars.data.quality}
        asOf={bars.data.as_of}
        chrome="bare"
        height={200}
        lastPricePill
        levels={levels}
      />
      <p className={editorStyles.note}>{model.levelLabel ?? (model.patternLabel ? `Looks for: ${model.patternLabel}` : "Shows the latest bars")}</p>
    </div>
  );
}
