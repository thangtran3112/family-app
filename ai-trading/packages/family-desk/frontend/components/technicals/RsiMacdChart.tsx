"use client";

import { useMemo } from "react";
import { BarsSchema, TechnicalsSchema } from "@/lib/api/schemas";
import { calcEMA, calcMACD, calcRSI } from "@/lib/indicators";
import { MarketChart } from "@/components/charts/MarketChart";

type Bars = ReturnType<typeof BarsSchema.parse>;
type Technicals = ReturnType<typeof TechnicalsSchema.parse>;

function finiteValues(values: Array<number | null>): Array<number | null> {
  return values.map((value) => value !== null && Number.isFinite(value) ? value : null);
}

export function RsiMacdChart({ bars, technicals, interval }: { bars: Bars; technicals: Technicals; interval: string }) {
  const indicators = useMemo(() => {
    const close = bars.bars.map(({ c }) => c ?? Number.NaN);
    const macd = calcMACD(close);
    return {
      ema20: finiteValues(calcEMA(close, 20)),
      ema50: finiteValues(calcEMA(close, 50)),
      rsi: finiteValues(calcRSI(close, 14)),
      macdLine: finiteValues(macd.dif),
      macdSignal: finiteValues(macd.signal),
      macdHistogram: finiteValues(macd.histogram),
    };
  }, [bars.bars]);
  const levels = Object.entries(technicals.pivots.classic).map(([label, price]) => ({
    label: `Classic ${label}`,
    price,
    color: label === "P" ? "#FFB020" : "#9B9BA1",
  }));

  return (
    <MarketChart
      symbol={bars.symbol}
      interval={interval}
      bars={bars.bars}
      quality={bars.quality}
      asOf={bars.as_of}
      height={500}
      overlays={[
        { id: "ema20", label: "EMA20", color: "#FFB020", values: indicators.ema20 },
        { id: "ema50", label: "EMA50", color: "#A78BFA", values: indicators.ema50 },
      ]}
      panes={[
        {
          id: "rsi",
          label: "RSI (14)",
          height: 100,
          references: [{ value: 70, label: "70" }, { value: 30, label: "30" }],
          series: [{ id: "rsi-line", label: "RSI (14)", color: "#F2F2F4", kind: "line", values: indicators.rsi }],
        },
        {
          id: "macd",
          label: "MACD (12, 26, 9)",
          height: 120,
          references: [{ value: 0, label: "Zero" }],
          series: [
            { id: "macd-histogram", label: "MACD histogram", color: "#30D158", negativeColor: "#FF453A", kind: "histogram", values: indicators.macdHistogram },
            { id: "macd-line", label: "MACD", color: "#F2F2F4", kind: "line", values: indicators.macdLine },
            { id: "macd-signal", label: "Signal", color: "#FFB020", kind: "line", values: indicators.macdSignal },
          ],
        },
      ]}
      levels={levels}
    />
  );
}
