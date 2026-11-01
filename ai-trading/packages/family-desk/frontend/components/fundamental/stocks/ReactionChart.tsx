import { MiniChartFrame } from "@/components/charts/MiniChartFrame";
import type { Valuation } from "@/lib/api/fundamentalSchemas";
import { axisLabel, reactionBars } from "@/lib/desk/researchView";
import local from "./stocks.module.css";

const W = 640;
const H = 220;
const LEFT = 48;
const TOP = 12;
const BOTTOM = 28;
const BOX = { width: W, height: H, left: LEFT, right: 0, top: TOP, bottom: BOTTOM };

/** Price move on each earnings report, oldest first, with a numeric axis in percent. Small SVG: no chart library. */
export function ReactionChart({ series }: { series: NonNullable<Valuation["earnings_reaction"]>["series"] }) {
  const { bars, axis } = reactionBars(series);
  const plotH = H - TOP - BOTTOM;
  const mid = TOP + plotH / 2;
  const y = (tick: number) => mid - (tick / axis.top) * (plotH / 2);
  const slot = (W - LEFT) / Math.max(bars.length, 1);
  const barW = Math.min(36, slot * 0.6);
  return (
    <MiniChartFrame
      box={BOX}
      label={`Price move on each of the last ${bars.length} earnings reports, ${bars.map((bar) => `${bar.label} ${bar.text}`).join(", ")}`}
      yTicks={axis.ticks.map((tick) => ({ key: tick, y: y(tick), label: axisLabel(tick), zero: tick === 0 }))}
      xLabels={bars.map((bar, index) => ({ x: LEFT + index * slot + slot / 2, label: bar.label }))}
    >
      {bars.map((bar, index) => {
        const height = (Math.abs(bar.value) / axis.top) * (plotH / 2);
        const x = LEFT + index * slot + (slot - barW) / 2;
        return (
          <g key={bar.date}>
            <rect className={local.bar} data-tone={bar.tone} x={x} y={bar.value >= 0 ? mid - height : mid} width={barW} height={Math.max(height, 1)}><title>{`${bar.date}: ${bar.text}`}</title></rect>
          </g>
        );
      })}
    </MiniChartFrame>
  );
}
