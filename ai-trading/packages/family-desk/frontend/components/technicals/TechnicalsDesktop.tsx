"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { ChartWorkspace } from "@/components/workspace/ChartWorkspace";
import { CHART_TIMEFRAMES, SUMMARY_TIMEFRAMES, timeframeFromQuery } from "@/lib/desk/timeframes";
import { useHash, viewFromHash } from "@/lib/desk/useHash";
import { TechnicalSummary } from "./TechnicalSummary";

const normalizeSymbol = (value: string) => value.trim().toUpperCase();

/** `/technicals?symbol=NVDA&timeframe=15m#chart|#summary`: D3 and D4 share one route (02m §c1). */
export function TechnicalsDesktop() {
  const params = useSearchParams();
  const router = useRouter();
  const view = viewFromHash(useHash());
  const symbol = normalizeSymbol(params.get("symbol") ?? "") || "AAPL";
  const options = view === "chart" ? CHART_TIMEFRAMES : SUMMARY_TIMEFRAMES;
  const timeframe = timeframeFromQuery(params.get("timeframe"), options).api;

  const onTimeframe = (api: string) => {
    const next = new URLSearchParams({ symbol, timeframe: api });
    router.replace(`/technicals?${next.toString()}#${view}`);
  };

  return view === "chart"
    ? <ChartWorkspace key={symbol} symbol={symbol} timeframe={timeframe} onTimeframe={onTimeframe} />
    : <TechnicalSummary key={symbol} symbol={symbol} timeframe={timeframe} onTimeframe={onTimeframe} />;
}
