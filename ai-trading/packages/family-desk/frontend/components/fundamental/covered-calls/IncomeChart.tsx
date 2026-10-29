import type { IncomeChart as Chart } from "@/lib/desk/coveredCallsView";
import { maskedUsd } from "@/lib/desk/mask";
import { scaleLinear } from "@/lib/desk/payoff";
import styles from "./coveredCalls.module.css";

const W = 560;
const H = 210;
const M = { left: 56, right: 8, top: 10, bottom: 26 };

/** Premium by month: bars on a numeric $ axis. While values are hidden the axis reads ••••• and the bars keep their shape. */
export function IncomeChart({ chart, masked }: { chart: Chart; masked: boolean }) {
  const slot = (W - M.left - M.right) / Math.max(chart.bars.length, 1);
  const y = (share: number) => scaleLinear(share, [0, 1], [H - M.bottom, M.top]);
  return (
    <svg className={styles.chart} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Premium by month" style={{ maxWidth: W }}>
      {chart.ticks.map((tick) => (
        <g key={tick.value}>
          <line className={tick.value === 0 ? styles.axis : styles.grid} x1={M.left} x2={W - M.right} y1={y(tick.share)} y2={y(tick.share)} />
          <text x={M.left - 6} y={y(tick.share) + 3} textAnchor="end">{tick.label}</text>
        </g>
      ))}
      {chart.bars.map((bar, index) => {
        const width = slot * 0.62;
        const left = M.left + index * slot + (slot - width) / 2;
        return (
          <g key={bar.month}>
            <rect className={styles.bar} x={left} y={y(bar.share)} width={width} height={Math.max(H - M.bottom - y(bar.share), 0)}>
              <title>{`${bar.month}: ${maskedUsd(masked, bar.premium)}`}</title>
            </rect>
            <text x={left + width / 2} y={H - M.bottom + 13} textAnchor="middle">{bar.label}</text>
          </g>
        );
      })}
    </svg>
  );
}
