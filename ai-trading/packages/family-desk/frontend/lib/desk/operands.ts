import type { Operand } from "@ai-trading/contracts";

// The operand picker shared by the filter editor (D6) and the alert setup form (D10): a curated list of
// metrics, each with its numeric parameters, mapped to and from the contract's `Operand` (02k). An operand the
// list cannot express reads as null and the row is shown read-only.
export type ParamDef = { key: string; label: string; min: number; max: number; defaultValue: number };
export type OperandDef = {
  id: string;
  label: string;
  group: "Price" | "Indicators" | "Levels";
  params: readonly ParamDef[];
  make: (params: Record<string, number>) => Operand;
  /** The params when `operand` is this metric, else null. */
  read: (operand: Operand) => Record<string, number> | null;
};

const series = (id: string, label: string, group: OperandDef["group"] = "Price"): OperandDef => ({
  id,
  label,
  group,
  params: [],
  make: () => ({ series: id }) as Operand,
  read: (operand) => ("series" in operand && operand.series === id && Object.keys(operand).length === 1 ? {} : null),
});

const lengthSeries = (id: string, label: string, defaultValue: number): OperandDef => ({
  id,
  label,
  group: "Indicators",
  params: [{ key: "length", label: "Length", min: 2, max: 500, defaultValue }],
  make: (params) => ({ series: id, length: params.length }) as Operand,
  read: (operand) => ("series" in operand && operand.series === id && "length" in operand && Object.keys(operand).length === 2 ? { length: operand.length as number } : null),
});

const level = (id: string, label: string): OperandDef => ({
  id,
  label,
  group: "Levels",
  params: [],
  make: () => ({ level: id }) as Operand,
  read: (operand) => ("level" in operand && operand.level === id && Object.keys(operand).length === 1 ? {} : null),
});

const levelWith = (id: string, label: string, key: "minutes" | "days", param: ParamDef): OperandDef => ({
  id,
  label,
  group: "Levels",
  params: [param],
  make: (params) => ({ level: id, [key]: params[key] }) as Operand,
  read: (operand) => ("level" in operand && operand.level === id && key in operand ? { [key]: (operand as unknown as Record<string, number>)[key]! } : null),
});

export const OPERAND_CATALOG: readonly OperandDef[] = [
  series("close", "Close"),
  series("open", "Open"),
  series("high", "High"),
  series("low", "Low"),
  series("volume", "Volume"),
  series("vwap", "VWAP"),
  series("gap_pct", "Gap %"),
  {
    id: "rvol",
    label: "Relative volume (days)",
    group: "Indicators",
    params: [{ key: "lookbackDays", label: "Days", min: 1, max: 60, defaultValue: 10 }],
    make: (params) => ({ series: "rvol", lookbackDays: params.lookbackDays }) as Operand,
    read: (operand) => ("series" in operand && operand.series === "rvol" ? { lookbackDays: operand.lookbackDays as number } : null),
  },
  lengthSeries("rsi", "RSI", 14),
  lengthSeries("sma", "SMA", 20),
  lengthSeries("ema", "EMA", 20),
  lengthSeries("atr", "ATR", 14),
  {
    id: "atr_pct",
    label: "ATR % vs its median",
    group: "Indicators",
    params: [
      { key: "length", label: "ATR length", min: 2, max: 500, defaultValue: 14 },
      { key: "medianLength", label: "Median length", min: 2, max: 500, defaultValue: 50 },
    ],
    make: (params) => ({ series: "atr_pct", length: params.length, medianLength: params.medianLength }) as Operand,
    read: (operand) =>
      "series" in operand && operand.series === "atr_pct"
        ? { length: operand.length as number, medianLength: operand.medianLength as number }
        : null,
  },
  level("prior_day_high", "Prior day high"),
  level("prior_day_low", "Prior day low"),
  level("prior_day_close", "Prior day close"),
  level("premarket_high", "Premarket high"),
  level("premarket_low", "Premarket low"),
  level("session_high", "Session high"),
  level("session_low", "Session low"),
  levelWith("opening_range_high", "Opening range high (minutes)", "minutes", { key: "minutes", label: "Minutes", min: 1, max: 120, defaultValue: 15 }),
  levelWith("opening_range_low", "Opening range low (minutes)", "minutes", { key: "minutes", label: "Minutes", min: 1, max: 120, defaultValue: 15 }),
  levelWith("n_day_high", "N-day high", "days", { key: "days", label: "Days", min: 2, max: 260, defaultValue: 20 }),
  levelWith("n_day_low", "N-day low", "days", { key: "days", label: "Days", min: 2, max: 260, defaultValue: 20 }),
];

export type OperandChoice = { id: string; params: Record<string, number> } | { id: "value"; value: number };

/** Which catalog entry (and parameters) an operand is, `{ id: "value" }` for a plain number, null if neither. */
export function choiceOf(operand: Operand): OperandChoice | null {
  if ("value" in operand && Object.keys(operand).length === 1) return { id: "value", value: operand.value };
  for (const def of OPERAND_CATALOG) {
    const params = def.read(operand);
    if (params) return { id: def.id, params };
  }
  return null;
}

export const defaultParams = (def: OperandDef): Record<string, number> => Object.fromEntries(def.params.map((param) => [param.key, param.defaultValue]));

/** The operand for a choice; a catalog id with missing parameters uses the defaults. */
export function operandFor(choice: OperandChoice): Operand {
  if ("value" in choice) return { value: choice.value };
  const def = OPERAND_CATALOG.find((item) => item.id === choice.id);
  if (!def) throw new Error(`Unknown operand ${choice.id}`);
  return def.make({ ...defaultParams(def), ...choice.params });
}

export const operandDef = (id: string): OperandDef | undefined => OPERAND_CATALOG.find((item) => item.id === id);
