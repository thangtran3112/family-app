import type { Operand } from "@ai-trading/contracts";
import { optionLabel, paramLabel } from "../spec/labels.ts";

// The operand picker shared by the filter editor (D6), the alert setup form (D10) and the strategy builder: a curated list of
// metrics, each with its numeric parameters and choice parameters, mapped to and from the contract's `Operand` (02k). An
// operand the list cannot express reads as null and the row is shown read-only.
export type ParamDef = { key: string; label: string; min: number; max: number; defaultValue: number };
/** A choice parameter (`line`, `part`, `method`...): one of `options`, each worded by `optionLabel`. */
export type PickDef = { key: string; label: string; options: readonly string[]; defaultValue: string };
export type OperandDef = {
  id: string;
  label: string;
  group: "Price" | "Indicators" | "Levels";
  params: readonly ParamDef[];
  /** Absent on a metric with no choice parameter. */
  picks?: readonly PickDef[];
  make: (params: Record<string, number>, picks?: Record<string, string>) => Operand;
  /** The numeric params when `operand` is exactly this metric (same keys, no more), else null. */
  read: (operand: Operand) => Record<string, number> | null;
};

type Row = { kind: "series" | "level"; id: string; label: string; group: OperandDef["group"]; params: readonly ParamDef[]; picks: readonly PickDef[] };

/** One declarative row becomes one `OperandDef`: `make` and `read` are the same for every metric. Key order is kind, picks, params, as the builder wrote them. */
function build({ kind, id, label, group, params, picks }: Row): OperandDef {
  const keys = [kind, ...picks.map((pick) => pick.key), ...params.map((param) => param.key)];
  return {
    id,
    label,
    group,
    params,
    ...(picks.length > 0 && { picks }),
    make: (values, chosen = {}) =>
      Object.fromEntries([
        [kind, id],
        ...picks.map((pick) => [pick.key, chosen[pick.key] ?? pick.defaultValue]),
        ...params.map((param) => [param.key, values[param.key]]),
      ]) as Operand,
    read: (operand) => {
      const record = operand as Record<string, unknown>;
      if (record[kind] !== id || Object.keys(record).length !== keys.length || !keys.every((key) => key in record)) return null;
      return Object.fromEntries(params.map((param) => [param.key, record[param.key] as number]));
    },
  };
}

const num = (key: string, min: number, max: number, defaultValue: number, label = paramLabel(key)): ParamDef => ({ key, label, min, max, defaultValue });
const length = (defaultValue = 14, key = "length"): ParamDef => num(key, 2, 500, defaultValue);
const smoothing = (key: string): ParamDef => num(key, 1, 500, 3);
const pick = (key: string, options: readonly string[], defaultValue = options[0]!): PickDef => ({ key, label: paramLabel(key), options, defaultValue });

type Extras = { label?: string; params?: readonly ParamDef[]; picks?: readonly PickDef[] };
const series = (id: string, group: "Price" | "Indicators", { label = optionLabel(id), params = [], picks = [] }: Extras = {}): Row => ({ kind: "series", id, label, group, params, picks });
const level = (id: string, { label = optionLabel(id), params = [], picks = [] }: Extras = {}): Row => ({ kind: "level", id, label, group: "Levels", params, picks });
const price = (id: string, label: string) => series(id, "Price", { label });
const indicator = (id: string, label: string, params: readonly ParamDef[] = []) => series(id, "Indicators", { label, params });

// The 24 rows the screener, its rank list and the alerts offer. Order and wording are pinned by operands.strategy.test.ts.
const KIT_ROWS: readonly Row[] = [
  price("close", "Close"),
  price("open", "Open"),
  price("high", "High"),
  price("low", "Low"),
  price("volume", "Volume"),
  price("vwap", "VWAP"),
  price("gap_pct", "Gap %"),
  indicator("rvol", "Relative volume (days)", [num("lookbackDays", 1, 60, 10, "Days")]),
  indicator("rsi", "RSI", [length(14)]),
  indicator("sma", "SMA", [length(20)]),
  indicator("ema", "EMA", [length(20)]),
  indicator("atr", "ATR", [length(14)]),
  indicator("atr_pct", "ATR % vs its median", [num("length", 2, 500, 14, "ATR length"), num("medianLength", 2, 500, 50)]),
  level("prior_day_high"),
  level("prior_day_low"),
  level("prior_day_close"),
  level("premarket_high"),
  level("premarket_low"),
  level("session_high"),
  level("session_low"),
  level("opening_range_high", { label: "Opening range high (minutes)", params: [num("minutes", 1, 120, 15)] }),
  level("opening_range_low", { label: "Opening range low (minutes)", params: [num("minutes", 1, 120, 15)] }),
  level("n_day_high", { label: "N-day high", params: [num("days", 2, 260, 20)] }),
  level("n_day_low", { label: "N-day low", params: [num("days", 2, 260, 20)] }),
];

// The other 19 contract operands, with the contract's bounds and the builder's defaults. Only the strategy builder offers them.
const STRATEGY_ROWS: readonly Row[] = [
  ...["cci", "momentum", "williams_r", "vwma", "hull_ma"].map((id) => series(id, "Indicators", { params: [length()] })),
  series("macd", "Indicators", { picks: [pick("line", ["line", "signal", "histogram"], "histogram")], params: [length(12, "fast"), length(26, "slow"), length(9, "signal")] }),
  series("stochastic", "Indicators", { picks: [pick("line", ["k", "d"])], params: [length(), smoothing("smoothK"), smoothing("smoothD")] }),
  series("stoch_rsi", "Indicators", { picks: [pick("line", ["k", "d"])], params: [smoothing("smoothK"), smoothing("smoothD"), length(14, "rsiLength"), length(14, "stochLength")] }),
  series("adx", "Indicators", { picks: [pick("line", ["adx", "plus_di", "minus_di"])], params: [length()] }),
  series("awesome_oscillator", "Indicators", { params: [length(5, "fast"), length(34, "slow")] }),
  series("bull_bear_power", "Indicators", { picks: [pick("line", ["bull", "bear"])], params: [length(13)] }),
  series("ultimate_oscillator", "Indicators", { params: [length(7, "fast"), length(14, "mid"), length(28, "slow")] }),
  series("ichimoku", "Indicators", { picks: [pick("line", ["conversion", "base", "span_a", "span_b"])], params: [length(9, "conversionLength"), length(26, "baseLength"), length(52, "spanBLength")] }),
  series("bias", "Indicators", { picks: [pick("part", ["oscillators", "moving_averages", "summary"], "summary")] }),
  level("overnight_high"),
  level("overnight_low"),
  level("support", { params: [num("days", 20, 260, 50)] }),
  level("resistance", { params: [num("days", 20, 260, 50)] }),
  level("pivot", { picks: [pick("method", ["classic", "fibonacci", "camarilla"]), pick("period", ["session", "week", "month"]), pick("point", ["P", "R1", "R2", "R3", "S1", "S2", "S3"])] }),
];

/** What the screener, its rank list and the alerts offer. Growing it moves their lists; add to `STRATEGY_OPERAND_CATALOG` instead. */
export const OPERAND_CATALOG: readonly OperandDef[] = KIT_ROWS.map(build);

/** Every series and level the contract allows (27 and 16): the 24 kit rows first, then the rest. The builder's catalog. */
export const STRATEGY_OPERAND_CATALOG: readonly OperandDef[] = [...KIT_ROWS, ...STRATEGY_ROWS].map(build);

export type OperandChoice = { id: string; params: Record<string, number>; picks?: Record<string, string> } | { id: "value"; value: number };

/** Which entry of `defs` (and parameters) an operand is, `{ id: "value" }` for a plain number, null if neither. */
export function choiceOf(operand: Operand, defs: readonly OperandDef[] = OPERAND_CATALOG): OperandChoice | null {
  if ("value" in operand && Object.keys(operand).length === 1) return { id: "value", value: operand.value };
  for (const def of defs) {
    const params = def.read(operand);
    if (params) {
      return def.picks
        ? { id: def.id, params, picks: Object.fromEntries(def.picks.map((item) => [item.key, (operand as unknown as Record<string, string>)[item.key]!])) }
        : { id: def.id, params };
    }
  }
  return null;
}

export const defaultParams = (def: OperandDef): Record<string, number> => Object.fromEntries(def.params.map((param) => [param.key, param.defaultValue]));
export const defaultPicks = (def: OperandDef): Record<string, string> => Object.fromEntries((def.picks ?? []).map((item) => [item.key, item.defaultValue]));

/** The operand for a choice; an id with missing parameters or picks uses the defaults. Throws for an id that `defs` lacks. */
export function operandFor(choice: OperandChoice, defs: readonly OperandDef[] = OPERAND_CATALOG): Operand {
  if ("value" in choice) return { value: choice.value };
  const def = defs.find((item) => item.id === choice.id);
  if (!def) throw new Error(`Unknown operand ${choice.id}`);
  return def.make({ ...defaultParams(def), ...choice.params }, { ...defaultPicks(def), ...choice.picks });
}

export const operandDef = (id: string, defs: readonly OperandDef[] = OPERAND_CATALOG): OperandDef | undefined => defs.find((item) => item.id === id);
