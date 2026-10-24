import type { Condition, Operand, StrategySpecV1 } from "@ai-trading/contracts";
import type { FilterStrategySpecV1 } from "@ai-trading/contracts/filter-strategy-spec-v1";

export const runLabels: Record<StrategySpecV1["watch"]["runOn"], string> = {
  bar_close_1m: "each 1-minute close",
  bar_close_5m: "each 5-minute close",
  bar_close_15m: "each 15-minute close",
  bar_close_1h: "each hourly close",
  premarket_0830: "the 08:30 premarket scan",
  daily_close: "each daily close",
  weekly: "each weekly close",
};

export function describeOperand(operand: Operand): string {
  if ("value" in operand) return String(operand.value);
  if ("series" in operand) {
    if (operand.series === "vwap") return "VWAP";
    if (operand.series === "gap_pct") return "gap %";
    if (operand.series === "rvol") return `relative volume (${operand.lookbackDays} days)`;
    if (operand.series === "bias") return `technical bias (${operand.part.replaceAll("_", " ")})`;
    if ("length" in operand) return `${operand.series.toUpperCase()} (${operand.length})`;
    return operand.series.replaceAll("_", " ");
  }

  const name = operand.level.replaceAll("_", " ");
  if ("minutes" in operand) return `${operand.minutes}-minute ${name}`;
  if ("days" in operand) {
    if (operand.level === "n_day_high" || operand.level === "n_day_low") {
      return `${operand.days}-day ${operand.level.endsWith("high") ? "high" : "low"}`;
    }
    return `${operand.days}-day ${name}`;
  }
  if ("method" in operand) return `${operand.method} ${operand.period} pivot ${operand.point}`;
  return name;
}

const withArticle = (phrase: string) => `${/^[aeiou]/.test(phrase) ? "an" : "a"} ${phrase}`;

function describePattern(condition: Extract<Condition, { op: "pattern" }>): string {
  const trend = condition.trend === "after_downtrend" ? "downtrend" : condition.trend === "after_uptrend" ? "uptrend" : undefined;
  const after = trend ? ` after ${withArticle(trend)}${condition.trendBars ? ` over ${condition.trendBars} bars` : ""}` : "";
  const within = condition.withinBars && condition.withinBars > 1 ? ` within the last ${condition.withinBars} bars` : "";
  return `${withArticle(`${condition.pattern.replaceAll("_", " ")} pattern`)} appears${after}${within}`;
}

export function describeCondition(condition: Condition): string {
  if ("all" in condition) {
    return condition.all.map((item) => {
      const description = describeCondition(item);
      return "all" in item || "any" in item ? `(${description})` : description;
    }).join(" and ");
  }
  if ("any" in condition) return `either ${condition.any.map(describeCondition).join(" or ")}`;
  if ("not" in condition) return `not (${describeCondition(condition.not)})`;
  if (condition.op === "time_between") return `time is between ${condition.start} and ${condition.end}`;
  if (condition.op === "pattern") return describePattern(condition);

  const left = describeOperand(condition.left);
  const right = describeOperand(condition.right);
  if (condition.op === "within_pct") return `${left} is within ${condition.pct}% of ${right}`;
  const operator = {
    gt: "is greater than",
    gte: "is at least",
    lt: "is less than",
    lte: "is at most",
    crosses_above: "crosses above",
    crosses_below: "crosses below",
  }[condition.op];
  return `${left} ${operator} ${right}`;
}

type Universe = StrategySpecV1["watch"]["universe"] | FilterStrategySpecV1["watch"]["universe"];

/** "watchlist Day movers", "NVDA and AMD", "US stocks and ETFs", "matches of filter Abnormal volume". */
export function describeUniverse(universe: Universe, assetTypes?: FilterStrategySpecV1["assetTypes"]): string {
  if ("market" in universe) {
    const kinds = assetTypes && assetTypes.length === 1 ? (assetTypes[0] === "etf" ? "ETFs" : "stocks") : "stocks and ETFs";
    return `US ${kinds}`;
  }
  if ("watchlist" in universe) return `watchlist ${universe.watchlist}`;
  if ("filter" in universe) return `matches of filter ${universe.filter}`;
  return universe.symbols.join(", ").replace(/, ([^,]*)$/, " and $1");
}

const sessionLabel = (session: "regular" | "extended") => (session === "regular" ? "regular hours" : "extended hours");

function describeAlertSpec(spec: StrategySpecV1): string {
  const channels = spec.then.alert.channels.join(" and ");
  const paperOrder = spec.then.paperOrder;
  const paper = paperOrder
    ? `; paper ${paperOrder.side} with ${"riskUsd" in paperOrder.size ? `$${paperOrder.size.riskUsd} risk` : "the selected size"}${"atrMultiple" in paperOrder.stop ? `, stop ${paperOrder.stop.atrMultiple}× ATR` : ""}${"r" in paperOrder.target ? `, target ${paperOrder.target.r}R` : ""}`
    : "";

  return `At ${runLabels[spec.watch.runOn]} during ${sessionLabel(spec.watch.session)}, alert when ${describeCondition(spec.when)}; notify ${channels}${paper}.`;
}

const money = (value: number) => `$${value.toLocaleString("en-US")}`;

/** One sentence for a screener: where it looks, the liquidity floor, the rule, the ranking (D5 header, D6, D8). */
function describeFilterSpec(spec: FilterStrategySpecV1): string {
  const floor: string[] = [];
  if (spec.liquidity?.minPrice !== undefined) floor.push(`price above ${money(spec.liquidity.minPrice)}`);
  if (spec.liquidity?.minAvgVolume !== undefined) floor.push(`average volume above ${spec.liquidity.minAvgVolume.toLocaleString("en-US")}`);
  const floorText = floor.length ? ` with ${floor.join(" and ")}` : "";
  const rank = spec.rank
    ? `; ranked by ${describeOperand(spec.rank.by)}, ${spec.rank.order === "desc" ? "highest" : "lowest"} first`
    : "";
  const matches = `${spec.maxResults} ${spec.maxResults === 1 ? "match" : "matches"}`;
  return `At ${runLabels[spec.watch.runOn]} during ${sessionLabel(spec.watch.session)}, find ${describeUniverse(spec.watch.universe, spec.assetTypes)}${floorText} where ${describeCondition(spec.when)}${rank}; up to ${matches}.`;
}

/** Plain English for an alert strategy (alert-only or with a paper order) or a filter strategy. */
export function describeSpec(spec: StrategySpecV1 | FilterStrategySpecV1): string {
  return "then" in spec ? describeAlertSpec(spec) : describeFilterSpec(spec);
}
