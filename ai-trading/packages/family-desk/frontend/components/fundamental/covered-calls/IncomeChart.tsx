import { MiniChartFrame } from "@/components/charts/MiniChartFrame";
import type { IncomeChart as Chart } from "@/lib/desk/coveredCallsView";
import { maskedUsd } from "@/lib/desk/mask";
import { scaleLinear } from "@/lib/desk/payoff";
import styles from "./coveredCalls.module.css";

const W = 560;
const H = 210;
const M = { left: 56, right: 8, top: 10, bottom: 26 };
const BOX = { width: W, height: H, ...M };

/** Premium by month: bars on a numeric $ axis. While values are hidden the axis reads ••••• and the bars keep their shape. */
export function IncomeChart({ chart, masked }: { chart: Chart; masked: boolean }) {
  const slot = (W - M.left - M.right) / Math.max(chart.bars.length, 1);
  const y = (share: number) => scaleLinear(share, [0, 1], [H - M.bottom, M.top]);
  return (
    <MiniChartFrame
      box={BOX}
      label="Premium by month"
      maxWidth={W}
      yTicks={chart.ticks.map((tick) => ({ key: tick.value, y: y(tick.share), label: tick.label, zero: tick.value === 0 }))}
      xLabels={chart.bars.map((bar, index) => ({ x: M.left + index * slot + slot / 2, label: bar.label }))}
    >
      {chart.bars.map((bar, index) => {
        const width = slot * 0.62;
        const left = M.left + index * slot + (slot - width) / 2;
        return (
          <g key={bar.month}>
            <rect className={styles.bar} x={left} y={y(bar.share)} width={width} height={Math.max(H - M.bottom - y(bar.share), 0)}>
              <title>{`${bar.month}: ${maskedUsd(masked, bar.premium)}`}</title>
            </rect>
          </g>
        );
      })}
    </MiniChartFrame>
  );
}
