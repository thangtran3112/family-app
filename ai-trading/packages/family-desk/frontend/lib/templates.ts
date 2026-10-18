import { StrategySpecV1Schema, type StrategySpecV1 } from "@ai-trading/contracts";
import futuresOvernightRangeBreak from "../../contracts/templates/futures-overnight-range-break.json" with { type: "json" };
import gapAndGo from "../../contracts/templates/gap-and-go.json" with { type: "json" };
import nDayBreakout from "../../contracts/templates/n-day-breakout.json" with { type: "json" };
import orbBreakout from "../../contracts/templates/orb-breakout.json" with { type: "json" };
import premarketHighBreak from "../../contracts/templates/premarket-high-break.json" with { type: "json" };
import pullbackToAverage from "../../contracts/templates/pullback-to-average.json" with { type: "json" };
import rsiReversal from "../../contracts/templates/rsi-reversal.json" with { type: "json" };
import technicalBiasChange from "../../contracts/templates/technical-bias-change.json" with { type: "json" };
import volumeSpike from "../../contracts/templates/volume-spike.json" with { type: "json" };
import vwapLoss from "../../contracts/templates/vwap-loss.json" with { type: "json" };
import vwapReclaim from "../../contracts/templates/vwap-reclaim.json" with { type: "json" };

export type StrategyTemplate = { slug: string; spec: StrategySpecV1 };

export const STRATEGY_TEMPLATES: StrategyTemplate[] = [
  { slug: "futures-overnight-range-break", spec: StrategySpecV1Schema.parse(futuresOvernightRangeBreak) },
  { slug: "gap-and-go", spec: StrategySpecV1Schema.parse(gapAndGo) },
  { slug: "n-day-breakout", spec: StrategySpecV1Schema.parse(nDayBreakout) },
  { slug: "orb-breakout", spec: StrategySpecV1Schema.parse(orbBreakout) },
  { slug: "premarket-high-break", spec: StrategySpecV1Schema.parse(premarketHighBreak) },
  { slug: "pullback-to-average", spec: StrategySpecV1Schema.parse(pullbackToAverage) },
  { slug: "rsi-reversal", spec: StrategySpecV1Schema.parse(rsiReversal) },
  { slug: "technical-bias-change", spec: StrategySpecV1Schema.parse(technicalBiasChange) },
  { slug: "volume-spike", spec: StrategySpecV1Schema.parse(volumeSpike) },
  { slug: "vwap-loss", spec: StrategySpecV1Schema.parse(vwapLoss) },
  { slug: "vwap-reclaim", spec: StrategySpecV1Schema.parse(vwapReclaim) },
];
