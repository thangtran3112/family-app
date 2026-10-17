import type { Condition, Operand, StrategySpecV1 } from "@ai-trading/contracts";

const runLabels: Record<StrategySpecV1["watch"]["runOn"], string> = {
  bar_close_1m: "each 1-minute close",
  bar_close_5m: "each 5-minute close",
  bar_close_15m: "each 15-minute close",
  bar_close_1h: "each hourly close",
  premarket_0830: "the 08:30 premarket scan",
  daily_close: "each daily close",
  weekly: "each weekly close",
};

function describeOperand(operand: Operand): string {
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

function describeCondition(condition: Condition): string {
  if ("all" in condition) {
    return condition.all.map((item) => {
      const description = describeCondition(item);
      return "all" in item || "any" in item ? `(${description})` : description;
    }).join(" and ");
  }
  if ("any" in condition) return `either ${condition.any.map(describeCondition).join(" or ")}`;
  if ("not" in condition) return `not (${describeCondition(condition.not)})`;
  if (condition.op === "time_between") return `time is between ${condition.start} and ${condition.end}`;

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

export function describeSpec(spec: StrategySpecV1): string {
  const session = spec.watch.session === "regular" ? "regular hours" : "extended hours";
  const channels = spec.then.alert.channels.join(" and ");
  const paperOrder = spec.then.paperOrder;
  const paper = paperOrder
    ? `; paper ${paperOrder.side} with ${"riskUsd" in paperOrder.size ? `$${paperOrder.size.riskUsd} risk` : "the selected size"}${"atrMultiple" in paperOrder.stop ? `, stop ${paperOrder.stop.atrMultiple}× ATR` : ""}${"r" in paperOrder.target ? `, target ${paperOrder.target.r}R` : ""}`
    : "";

  return `At ${runLabels[spec.watch.runOn]} during ${session}, alert when ${describeCondition(spec.when)}; notify ${channels}${paper}.`;
}
