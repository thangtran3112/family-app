"use client";

import { useMemo } from "react";
import { BarsSchema, TechnicalsSchema } from "@/lib/api/schemas";
import { calcEMAWithGaps, calcMACDWithGaps, calcRSIWithGaps } from "@/lib/indicators-with-gaps";
import { MarketChart } from "@/components/charts/MarketChart";
import { chartPalette } from "@/lib/desk/chartPalette";

type Bars = ReturnType<typeof BarsSchema.parse>;
type Technicals = ReturnType<typeof TechnicalsSchema.parse>;

export function RsiMacdChart({ bars, technicals, interval }: { bars: Bars; technicals: Technicals; interval: string }) {
  const indicators = useMemo(() => {
    const close = bars.bars.map(({ c }) => c);
    const macd = calcMACDWithGaps(close);
    return {
      ema20: calcEMAWithGaps(close, 20),
      ema50: calcEMAWithGaps(close, 50),
      rsi: calcRSIWithGaps(close, 14),
      macdLine: macd.dif,
      macdSignal: macd.signal,
      macdHistogram: macd.histogram,
    };
  }, [bars.bars]);
  const levels = Object.entries(technicals.pivots.classic).map(([label, price]) => ({
    label: `Classic ${label}`,
    price,
    color: label === "P" ? chartPalette.amber : chartPalette.muted,
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
        { id: "ema20", label: "EMA20", color: chartPalette.amber, values: indicators.ema20 },
        { id: "ema50", label: "EMA50", color: chartPalette.ai, values: indicators.ema50 },
      ]}
      panes={[
        {
          id: "rsi",
          label: "RSI (14)",
          height: 100,
          references: [{ value: 70, label: "70" }, { value: 30, label: "30" }],
          series: [{ id: "rsi-line", label: "RSI (14)", color: chartPalette.text, kind: "line", values: indicators.rsi }],
        },
        {
          id: "macd",
          label: "MACD (12, 26, 9)",
          height: 120,
          references: [{ value: 0, label: "Zero" }],
          series: [
            { id: "macd-histogram", label: "MACD histogram", color: chartPalette.up, negativeColor: chartPalette.down, kind: "histogram", values: indicators.macdHistogram },
            { id: "macd-line", label: "MACD", color: chartPalette.text, kind: "line", values: indicators.macdLine },
            { id: "macd-signal", label: "Signal", color: chartPalette.amber, kind: "line", values: indicators.macdSignal },
          ],
        },
      ]}
      levels={levels}
    />
  );
}
