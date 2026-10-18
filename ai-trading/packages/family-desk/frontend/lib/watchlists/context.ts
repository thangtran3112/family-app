import { StrategySpecV1Schema, type Condition, type Operand, type StrategySpecV1 } from "@ai-trading/contracts";
import type { StrategyTemplate } from "../templates.ts";
import { canonicalWatchlistSymbol } from "./symbols.ts";

export type StrategyContext =
  | { kind: "none" }
  | { kind: "unsupported"; reasons: string[] }
  | {
      kind: "ready";
      template: StrategyTemplate;
      symbol: string;
      timeframe: string;
      runOn: StrategySpecV1["watch"]["runOn"];
      block: string;
      note?: string;
    };

export function strategyContextHref(symbol: string, timeframe: string, block: string): string {
  const params = new URLSearchParams({ template: "technical-bias-change", symbol, timeframe, block });
  return `/strategies/new?${params.toString()}`;
}

const runOnByTimeframe: Record<string, StrategySpecV1["watch"]["runOn"]> = {
  "1m": "bar_close_1m",
  "5m": "bar_close_5m",
  "15m": "bar_close_15m",
  "1h": "bar_close_1h",
  "1d": "daily_close",
  "1w": "weekly",
};

export function parseStrategyContext(
  params: URLSearchParams,
  templates: readonly StrategyTemplate[],
): StrategyContext {
  const keys = ["template", "symbol", "timeframe", "block"] as const;
  const hasContext = [...params.keys()].length > 0;
  if (!hasContext) return { kind: "none" };

  const reasons: string[] = [];
  const knownKeys = new Set<string>(keys);
  const unknownKeys = [...new Set([...params.keys()].filter((key) => !knownKeys.has(key)))];
  for (const key of unknownKeys) reasons.push(`Context parameter “${key}” is not supported.`);
  const values = new Map<string, string>();
  for (const key of keys) {
    const entries = params.getAll(key);
    if (entries.length !== 1 || !entries[0]?.trim()) {
      reasons.push(entries.length > 1 ? `“${key}” appears more than once.` : `“${key}” is missing.`);
    } else {
      values.set(key, entries[0].trim());
    }
  }

  const requestedTemplate = templates.find(({ slug }) => slug === values.get("template"));
  if (!requestedTemplate && values.has("template")) reasons.push("Template is not one of the shipped templates.");

  let symbol = "";
  if (values.has("symbol")) {
    try {
      const raw = values.get("symbol")!;
      symbol = canonicalWatchlistSymbol(raw, raw.startsWith("/") ? "future" : "stock");
      const base = templates[0]?.spec;
      if (!base || !StrategySpecV1Schema.safeParse({
        ...base,
        watch: { ...base.watch, universe: { symbols: [symbol] } },
      }).success) reasons.push("Symbol is not supported by StrategySpecV1.");
    } catch {
      reasons.push("Symbol is not supported by StrategySpecV1.");
    }
  }

  const timeframe = values.get("timeframe")?.toLowerCase() ?? "";
  const runOn = runOnByTimeframe[timeframe];
  if (!runOn && values.has("timeframe")) {
    reasons.push(timeframe === "30m" || timeframe === "4h"
      ? `${values.get("timeframe")} technicals cannot be represented by the strategy cadence contract; choose a supported cadence manually.`
      : `Timeframe “${values.get("timeframe")}" is not supported by StrategySpecV1.`);
  }

  const requestedBlock = values.get("block")?.toLowerCase() ?? "";
  let template = requestedTemplate;
  let note: string | undefined;
  if (requestedBlock === "rsi") {
    template = templates.find(({ slug }) => slug === "rsi-reversal");
    if (!template) reasons.push("The shipped RSI reversal template is unavailable.");
    else note = "RSI context uses the shipped RSI reversal rule and its authored threshold; no threshold was inferred from the URL.";
  } else if (["summary", "oscillators", "moving_averages"].includes(requestedBlock)) {
    if (requestedTemplate?.slug !== "technical-bias-change") {
      reasons.push("This bias block requires the shipped Technical bias change template.");
    }
  } else if (values.has("block")) {
    reasons.push(`Series block “${values.get("block")}" has no shipped preset; choose a template manually.`);
  }

  if (reasons.length || !template || !runOn) return { kind: "unsupported", reasons };
  return { kind: "ready", template, symbol, timeframe, runOn, block: requestedBlock, note };
}

function setBiasPart(condition: Condition, part: "summary" | "oscillators" | "moving_averages"): Condition {
  if ("all" in condition) return { all: condition.all.map((child) => setBiasPart(child, part)) };
  if ("any" in condition) return { any: condition.any.map((child) => setBiasPart(child, part)) };
  if ("not" in condition) return { not: setBiasPart(condition.not, part) };
  if (!("left" in condition)) return condition;
  const update = (operand: Operand): Operand =>
    "series" in operand && operand.series === "bias" ? { ...operand, part } : operand;
  return { ...condition, left: update(condition.left), right: update(condition.right) } as Condition;
}

export function applyStrategyContext(
  context: Extract<StrategyContext, { kind: "ready" }>,
  universe: StrategySpecV1["watch"]["universe"] = { symbols: [context.symbol] },
): StrategyTemplate {
  const spec = structuredClone(context.template.spec);
  spec.watch = { ...spec.watch, universe, runOn: context.runOn };
  if (["summary", "oscillators", "moving_averages"].includes(context.block)) {
    spec.when = setBiasPart(spec.when, context.block as "summary" | "oscillators" | "moving_averages");
  }
  return { ...context.template, spec };
}
