"use client";

import {
  StrategySpecV1Schema,
  type Condition,
  type Operand,
  type StrategySpecV1,
} from "@ai-trading/contracts";
import {
  formToSpec,
  groupSpecErrors,
  type SpecBlock,
  type SpecBlockErrors,
  type StrategySpecForm,
} from "@/lib/spec/form";
import type { WatchlistsResponseSchema } from "@/lib/api/schemas";
import styles from "./builder.module.css";

type Props = {
  form: StrategySpecForm;
  watchlists: ReturnType<typeof WatchlistsResponseSchema.parse>;
  onChange: (form: StrategySpecForm) => void;
  errors: SpecBlockErrors;
  readOnly?: boolean;
};
type RecordValue = Record<string, unknown>;
type SeriesOperand = Extract<Operand, { series: string }>;
type LevelOperand = Extract<Operand, { level: string }>;
type PaperOrder = NonNullable<StrategySpecV1["then"]["paperOrder"]>;

const SERIES = [
  "open", "high", "low", "close", "volume", "vwap", "gap_pct", "sma", "ema", "rsi", "atr",
  "cci", "momentum", "williams_r", "vwma", "hull_ma", "rvol", "macd", "stochastic", "stoch_rsi",
  "adx", "awesome_oscillator", "bull_bear_power", "ultimate_oscillator", "ichimoku", "atr_pct", "bias",
] as const;
const LEVELS = [
  "prior_day_high", "prior_day_low", "prior_day_close", "premarket_high", "premarket_low",
  "overnight_high", "overnight_low", "opening_range_high", "opening_range_low", "n_day_high",
  "n_day_low", "support", "resistance", "pivot",
] as const;
const SERIES_NUMBERS: Record<string, string[]> = {
  sma: ["length"], ema: ["length"], rsi: ["length"], atr: ["length"], cci: ["length"],
  momentum: ["length"], williams_r: ["length"], vwma: ["length"], hull_ma: ["length"],
  rvol: ["lookbackDays"], macd: ["fast", "slow", "signal"],
  stochastic: ["length", "smoothK", "smoothD"],
  stoch_rsi: ["smoothK", "smoothD", "rsiLength", "stochLength"], adx: ["length"],
  awesome_oscillator: ["fast", "slow"], bull_bear_power: ["length"],
  ultimate_oscillator: ["fast", "mid", "slow"],
  ichimoku: ["conversionLength", "baseLength", "spanBLength"],
  atr_pct: ["length", "medianLength"],
};
const SERIES_CHOICES: Record<string, Record<string, string[]>> = {
  macd: { line: ["line", "signal", "histogram"] },
  stochastic: { line: ["k", "d"] },
  stoch_rsi: { line: ["k", "d"] },
  adx: { line: ["adx", "plus_di", "minus_di"] },
  bull_bear_power: { line: ["bull", "bear"] },
  ichimoku: { line: ["conversion", "base", "span_a", "span_b"] },
  bias: { part: ["oscillators", "moving_averages", "summary"] },
};
const LEVEL_NUMBERS: Record<string, string[]> = {
  opening_range_high: ["minutes"], opening_range_low: ["minutes"],
  n_day_high: ["days"], n_day_low: ["days"], support: ["days"], resistance: ["days"],
};
const LEVEL_CHOICES: Record<string, Record<string, string[]>> = {
  pivot: {
    method: ["classic", "fibonacci", "camarilla"],
    period: ["session", "week", "month"],
    point: ["P", "R1", "R2", "R3", "S1", "S2", "S3"],
  },
};

function object(value: unknown): RecordValue {
  return value as RecordValue;
}

function numberText(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

function numeric(value: string): number {
  return value === "" ? Number.NaN : Number(value);
}

function conditionKind(condition: Condition): string {
  if ("all" in condition) return "all";
  if ("any" in condition) return "any";
  if ("not" in condition) return "not";
  if (condition.op === "time_between") return "time_between";
  return condition.op === "within_pct" ? "within_pct" : "compare";
}

function newCondition(kind: string): Condition {
  const comparison = { left: { series: "close" }, right: { value: 0 } };
  if (kind === "within_pct") return { ...comparison, op: "within_pct", pct: 1 } as Condition;
  if (kind === "time_between") return { op: "time_between", start: "09:30", end: "16:00" };
  if (kind === "all") return { all: [{ ...comparison, op: "gte" }] } as Condition;
  if (kind === "any") return { any: [{ ...comparison, op: "gte" }] } as Condition;
  if (kind === "not") return { not: { ...comparison, op: "gte" } } as Condition;
  return { ...comparison, op: "gte" } as Condition;
}

function changeConditionKind(current: Condition, kind: string): Condition {
  if (conditionKind(current) === kind) return current;
  if (kind === "not") return { not: current };
  if (kind === "all" || kind === "any") {
    const children = "all" in current ? current.all : "any" in current ? current.any : [current];
    return kind === "all" ? { all: children } : { any: children };
  }
  if ("not" in current) return changeConditionKind(current.not, kind);
  if ((kind === "compare" || kind === "within_pct") && "left" in current) {
    if (kind === "within_pct") {
      return { ...current, op: "within_pct", pct: "pct" in current ? current.pct : 1 } as Condition;
    }
    const comparison = { ...current } as typeof current & { pct?: number };
    delete comparison.pct;
    return { ...comparison, op: "gte" } as Condition;
  }
  if ((kind === "compare" || kind === "within_pct") && ("all" in current || "any" in current)) {
    const first = "all" in current ? current.all[0] : current.any[0];
    if (first) return changeConditionKind(first, kind);
  }
  return newCondition(kind);
}

function seriesDefaults(series: string): SeriesOperand {
  const fields: Record<string, RecordValue> = {
    rvol: { lookbackDays: 10 },
    macd: { line: "histogram", fast: 12, slow: 26, signal: 9 },
    stochastic: { line: "k", length: 14, smoothK: 3, smoothD: 3 },
    stoch_rsi: { line: "k", smoothK: 3, smoothD: 3, rsiLength: 14, stochLength: 14 },
    adx: { line: "adx", length: 14 },
    awesome_oscillator: { fast: 5, slow: 34 },
    bull_bear_power: { line: "bull", length: 13 },
    ultimate_oscillator: { fast: 7, mid: 14, slow: 28 },
    ichimoku: { line: "conversion", conversionLength: 9, baseLength: 26, spanBLength: 52 },
    atr_pct: { length: 14, medianLength: 50 },
    bias: { part: "summary" },
  };
  const selected = fields[series] ?? (SERIES_NUMBERS[series] ? { length: 14 } : {});
  return { series, ...selected } as SeriesOperand;
}

function levelDefaults(level: string): LevelOperand {
  const parameters: Record<string, RecordValue> = {
    opening_range_high: { minutes: 15 }, opening_range_low: { minutes: 15 },
    n_day_high: { days: 20 }, n_day_low: { days: 20 }, support: { days: 50 }, resistance: { days: 50 },
    pivot: { method: "classic", period: "session", point: "P" },
  };
  return { level, ...(parameters[level] ?? {}) } as LevelOperand;
}

function BlockErrors({ block, errors }: { block: SpecBlock; errors: SpecBlockErrors }) {
  const entries = errors[block];
  if (!entries?.length) return null;
  return (
    <ul className={styles.errors} aria-label={`${block} validation errors`}>
      {entries.map(({ path, message }, index) => <li key={`${path}-${index}`}><code>{path}</code>: {message}</li>)}
    </ul>
  );
}

function NumberField({
  label, value, onChange, disabled, step = "1", min, max,
}: {
  label: string;
  value: unknown;
  onChange: (value: number) => void;
  disabled: boolean;
  step?: string;
  min?: number;
  max?: number;
}) {
  return (
    <label className={styles.field}>
      <span>{label}</span>
      <input
        disabled={disabled}
        inputMode="decimal"
        max={max}
        min={min}
        onChange={(event) => onChange(numeric(event.currentTarget.value))}
        step={step}
        type="number"
        value={numberText(value)}
      />
    </label>
  );
}

function SelectField({
  label, value, options, onChange, disabled,
}: {
  label: string;
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  return (
    <label className={styles.field}>
      <span>{label}</span>
      <select disabled={disabled} onChange={(event) => onChange(event.currentTarget.value)} value={value}>
        {options.map((option) => <option key={option} value={option}>{option.replaceAll("_", " ")}</option>)}
      </select>
    </label>
  );
}

function OperandEditor({
  label, operand, onChange, disabled,
}: {
  label: string;
  operand: Operand;
  onChange: (operand: Operand) => void;
  disabled: boolean;
}) {
  const record = object(operand);
  const kind = "series" in operand ? "series" : "level" in operand ? "level" : "value";
  const update = (key: string, value: unknown) => onChange({ ...record, [key]: value } as unknown as Operand);
  const switchKind = (next: string) => onChange(next === "series"
    ? seriesDefaults("close")
    : next === "level"
      ? levelDefaults("prior_day_high")
      : { value: 0 });

  return (
    <div className={styles.operand}>
      <SelectField label={`${label} type`} value={kind} options={["series", "level", "value"]} onChange={switchKind} disabled={disabled} />
      {kind === "value" && (
        <NumberField label={`${label} value`} value={record.value} onChange={(value) => update("value", value)} disabled={disabled} step="any" />
      )}
      {kind === "series" && (
        <>
          <SelectField
            label={`${label} series`}
            value={String(record.series)}
            options={SERIES}
            onChange={(series) => onChange(seriesDefaults(series))}
            disabled={disabled}
          />
          {(SERIES_NUMBERS[String(record.series)] ?? []).map((field) => (
            <NumberField
              key={field}
              label={`${label} ${field}`}
              value={record[field]}
              onChange={(value) => update(field, value)}
              disabled={disabled}
              min={field === "lookbackDays" ? 1 : 1}
              max={field === "lookbackDays" ? 60 : 500}
            />
          ))}
          {Object.entries(SERIES_CHOICES[String(record.series)] ?? {}).flatMap(([field, options]) => {
            const current = String(record[field] ?? options[0]);
            return [<SelectField key={field} label={`${label} ${field}`} value={current} options={options} onChange={(value) => update(field, value)} disabled={disabled} />];
          })}
        </>
      )}
      {kind === "level" && (
        <>
          <SelectField
            label={`${label} level`}
            value={String(record.level)}
            options={LEVELS}
            onChange={(level) => onChange(levelDefaults(level))}
            disabled={disabled}
          />
          {(LEVEL_NUMBERS[String(record.level)] ?? []).map((field) => (
            <NumberField key={field} label={`${label} ${field}`} value={record[field]} onChange={(value) => update(field, value)} disabled={disabled} min={1} max={260} />
          ))}
          {Object.entries(LEVEL_CHOICES[String(record.level)] ?? {}).map(([field, options]) => (
            <SelectField key={field} label={`${label} ${field}`} value={String(record[field])} options={options} onChange={(value) => update(field, value)} disabled={disabled} />
          ))}
        </>
      )}
    </div>
  );
}

function ConditionEditor({
  condition, onChange, disabled, depth = 0,
}: {
  condition: Condition;
  onChange: (condition: Condition) => void;
  disabled: boolean;
  depth?: number;
}) {
  const kind = conditionKind(condition);
  if ("all" in condition || "any" in condition) {
    const key = "all" in condition ? "all" : "any";
    const children: Condition[] = "all" in condition ? condition.all : condition.any;
    const updateChildren = (next: Condition[]) => onChange(key === "all" ? { all: next } : { any: next });
    return (
      <div className={styles.condition}>
        <SelectField label="Condition group" value={key} options={["all", "any", "compare", "within_pct", "time_between", "not"]} onChange={(value) => onChange(changeConditionKind(condition, value))} disabled={disabled} />
        <p className={styles.help}>{key === "all" ? "All conditions must be true" : "Any condition may be true"}</p>
        <div className={styles.nestedConditions}>
          {children.map((child, index) => (
            <div className={styles.nestedCondition} key={`${depth}-${index}`}>
              <ConditionEditor
                condition={child}
                depth={depth + 1}
                disabled={disabled}
                onChange={(next) => updateChildren(children.map((item, itemIndex) => itemIndex === index ? next : item))}
              />
              <button
                className={styles.removeButton}
                disabled={disabled || children.length <= 1}
                onClick={() => updateChildren(children.filter((_, itemIndex) => itemIndex !== index))}
                type="button"
              >Remove condition</button>
            </div>
          ))}
        </div>
        <button
          className={styles.secondaryButton}
          disabled={disabled || children.length >= 20}
          onClick={() => updateChildren([...children, newCondition("compare")])}
          type="button"
        >Add condition</button>
      </div>
    );
  }

  if ("not" in condition) {
    return (
      <div className={styles.condition}>
        <SelectField label="Condition" value="not" options={["compare", "within_pct", "time_between", "all", "any", "not"]} onChange={(value) => onChange(changeConditionKind(condition, value))} disabled={disabled} />
        <p className={styles.help}>Not this condition</p>
        <ConditionEditor condition={condition.not} depth={depth + 1} disabled={disabled} onChange={(next) => onChange({ not: next })} />
      </div>
    );
  }

  if (condition.op === "time_between") {
    return (
      <div className={styles.condition}>
        <SelectField label="Condition" value="time_between" options={["compare", "within_pct", "time_between", "all", "any", "not"]} onChange={(value) => onChange(changeConditionKind(condition, value))} disabled={disabled} />
        <div className={styles.inlineFields}>
          <label className={styles.field}><span>Start (ET)</span><input disabled={disabled} inputMode="numeric" onChange={(event) => onChange({ ...condition, start: event.currentTarget.value })} placeholder="09:30" value={condition.start} /></label>
          <label className={styles.field}><span>End (ET)</span><input disabled={disabled} inputMode="numeric" onChange={(event) => onChange({ ...condition, end: event.currentTarget.value })} placeholder="16:00" value={condition.end} /></label>
        </div>
      </div>
    );
  }

  const comparison = condition as Extract<Condition, { left: Operand; right: Operand }>;
  const operator = comparison.op === "within_pct" ? "within_pct" : comparison.op;
  const changeOperator = (value: string) => {
    if (value === "within_pct") {
      onChange({ ...comparison, op: "within_pct", pct: 1 } as Condition);
      return;
    }
    const withoutPct = { ...comparison } as typeof comparison & { pct?: number };
    delete withoutPct.pct;
    onChange({ ...withoutPct, op: value } as Condition);
  };
  return (
    <div className={styles.condition}>
      <SelectField label="Condition" value={kind} options={["compare", "within_pct", "time_between", "all", "any", "not"]} onChange={(value) => onChange(changeConditionKind(condition, value))} disabled={disabled} />
      {kind !== "compare" && kind !== "within_pct" ? null : (
        <>
          <OperandEditor label="Left" operand={comparison.left} onChange={(left) => onChange({ ...comparison, left } as Condition)} disabled={disabled} />
          <SelectField label="Operator" value={operator} options={["gt", "gte", "lt", "lte", "crosses_above", "crosses_below", "within_pct"]} onChange={changeOperator} disabled={disabled} />
          <OperandEditor label="Right" operand={comparison.right} onChange={(right) => onChange({ ...comparison, right } as Condition)} disabled={disabled} />
          {comparison.op === "within_pct" && (
            <NumberField label="Within percent" value={(comparison as typeof comparison & { pct: number }).pct} onChange={(pct) => onChange({ ...comparison, pct } as Condition)} disabled={disabled} step="any" min={0} max={100} />
          )}
        </>
      )}
    </div>
  );
}

function LevelActionEditor({
  label, value, onChange, disabled,
}: {
  label: string;
  value: LevelOperand;
  onChange: (value: LevelOperand) => void;
  disabled: boolean;
}) {
  const record = object(value);
  const level = String(record.level);
  const update = (key: string, next: unknown) => onChange({ ...record, [key]: next } as unknown as LevelOperand);
  return (
    <div className={styles.operand}>
      <SelectField label={`${label} level`} value={level} options={LEVELS} onChange={(next) => onChange(levelDefaults(next))} disabled={disabled} />
      {(LEVEL_NUMBERS[level] ?? []).map((field) => <NumberField key={field} label={`${label} ${field}`} value={record[field]} onChange={(next) => update(field, next)} disabled={disabled} min={1} max={260} />)}
      {Object.entries(LEVEL_CHOICES[level] ?? {}).map(([field, options]) => <SelectField key={field} label={`${label} ${field}`} value={String(record[field])} options={options} onChange={(next) => update(field, next)} disabled={disabled} />)}
    </div>
  );
}

function PaperOrderEditor({
  value, onChange, disabled,
}: {
  value: PaperOrder;
  onChange: (value: PaperOrder) => void;
  disabled: boolean;
}) {
  const order = object(value);
  const size = object(order.size);
  const sizeKind = Object.keys(size)[0] ?? "shares";
  const stop = object(order.stop);
  const target = object(order.target);
  const update = (key: string, next: unknown) => onChange({ ...order, [key]: next } as unknown as PaperOrder);
  const defaultSize = (kind: string): RecordValue => ({
    riskUsd: { riskUsd: 100 }, shares: { shares: 1 }, pctOfBook: { pctOfBook: 1 }, contracts: { contracts: 1 },
  } satisfies Record<string, RecordValue>)[kind]!;

  return (
    <div className={styles.actionFields}>
      <SelectField label="Side" value={String(order.side)} options={["buy", "sell"]} onChange={(side) => update("side", side)} disabled={disabled} />
      <SelectField label="Size type" value={sizeKind} options={["riskUsd", "shares", "pctOfBook", "contracts"]} onChange={(kind) => update("size", defaultSize(kind))} disabled={disabled} />
      <NumberField label={sizeKind} value={size[sizeKind]} onChange={(amount) => update("size", { ...size, [sizeKind]: amount })} disabled={disabled} step={sizeKind === "shares" || sizeKind === "contracts" ? "1" : "any"} min={1} />
      <SelectField label="Stop type" value={"atrMultiple" in stop ? "atrMultiple" : "level"} options={["atrMultiple", "level"]} onChange={(kind) => update("stop", kind === "atrMultiple" ? { atrMultiple: 2 } : levelDefaults("prior_day_low"))} disabled={disabled} />
      {"atrMultiple" in stop
        ? <NumberField label="Stop ATR multiple" value={stop.atrMultiple} onChange={(amount) => update("stop", { atrMultiple: amount })} disabled={disabled} step="any" min={0} max={20} />
        : <LevelActionEditor label="Stop" value={order.stop as LevelOperand} onChange={(next) => update("stop", next)} disabled={disabled} />}
      <SelectField label="Target type" value={"r" in target ? "r" : "level"} options={["r", "level"]} onChange={(kind) => update("target", kind === "r" ? { r: 2 } : levelDefaults("prior_day_high"))} disabled={disabled} />
      {"r" in target
        ? <NumberField label="Target R multiple" value={target.r} onChange={(amount) => update("target", { r: amount })} disabled={disabled} step="any" min={0} max={20} />
        : <LevelActionEditor label="Target" value={order.target as LevelOperand} onChange={(next) => update("target", next)} disabled={disabled} />}
    </div>
  );
}

export function SpecForm({ form, watchlists, onChange, errors, readOnly = false }: Props) {
  const updateWatch = (patch: Partial<StrategySpecForm["watch"]>) => onChange({ ...form, watch: { ...form.watch, ...patch } });
  const universe = object(form.watch.universe);
  const isWatchlist = "watchlist" in universe;
  const currentWatchlist = isWatchlist ? String(universe.watchlist) : "";
  const watchlistNames = [...new Set([currentWatchlist, ...watchlists.map(({ name }) => name)].filter(Boolean))];
  const limits = object(form.limits ?? {});
  const hasLimits = form.limits !== undefined;
  const paperOrder = form.then.paperOrder;

  return (
    <div className={styles.specForm} aria-label="Strategy specification form">
      <section className={styles.block} aria-labelledby="watch-heading">
        <div className={styles.blockHeading}><h3 id="watch-heading">Watch</h3><span>Schema v{form.schemaVersion}</span></div>
        <div className={styles.fields}>
          <label className={styles.field}><span>Strategy name</span><input disabled={readOnly} maxLength={80} onChange={(event) => onChange({ ...form, name: event.currentTarget.value })} value={form.name} /></label>
          <SelectField label="Universe type" value={isWatchlist ? "watchlist" : "symbols"} options={["watchlist", "symbols"]} disabled={readOnly} onChange={(kind) => updateWatch({ universe: kind === "watchlist" ? { watchlist: "" } : { symbols: ["SPY"] } })} />
          {isWatchlist
            ? watchlistNames.length
              ? <SelectField label="Watchlist" value={currentWatchlist} options={watchlistNames} onChange={(watchlist) => updateWatch({ universe: { watchlist } })} disabled={readOnly} />
              : <label className={styles.field}><span>Watchlist name</span><input disabled={readOnly} maxLength={80} onChange={(event) => updateWatch({ universe: { watchlist: event.currentTarget.value } })} value={currentWatchlist} /></label>
            : <label className={styles.field}><span>Symbols (comma-separated)</span><input disabled={readOnly} onChange={(event) => updateWatch({ universe: { symbols: event.currentTarget.value.split(",").map((symbol) => symbol.trim()).filter(Boolean) } })} value={Array.isArray(universe.symbols) ? universe.symbols.join(", ") : ""} /></label>}
          <SelectField label="Session" value={form.watch.session} options={["regular", "extended"]} disabled={readOnly} onChange={(session) => updateWatch({ session: session as StrategySpecForm["watch"]["session"] })} />
          <SelectField label="Run on" value={form.watch.runOn} options={["bar_close_1m", "bar_close_5m", "bar_close_15m", "bar_close_1h", "premarket_0830", "daily_close", "weekly"]} disabled={readOnly} onChange={(runOn) => updateWatch({ runOn: runOn as StrategySpecForm["watch"]["runOn"] })} />
        </div>
        <BlockErrors block="Watch" errors={errors} />
      </section>

      <section className={styles.block} aria-labelledby="when-heading">
        <div className={styles.blockHeading}><h3 id="when-heading">When</h3><span>Closed-bar conditions</span></div>
        <ConditionEditor condition={form.when} onChange={(when) => onChange({ ...form, when })} disabled={readOnly} />
        <BlockErrors block="When" errors={errors} />
      </section>

      <section className={styles.block} aria-labelledby="then-heading">
        <div className={styles.blockHeading}><h3 id="then-heading">Then</h3><span>Actions</span></div>
        <div className={styles.fields}>
          <fieldset className={styles.channels} disabled={readOnly}>
            <legend>Alert channels</legend>
            {(["inbox", "telegram", "slack"] as const).map((channel) => (
              <label className={styles.checkOption} key={channel}>
                <input
                  checked={form.then.alert.channels.includes(channel)}
                  disabled={readOnly || (!form.then.alert.channels.includes(channel) && form.then.alert.channels.length >= 3)}
                  onChange={(event) => onChange({
                    ...form,
                    then: {
                      ...form.then,
                      alert: {
                        ...form.then.alert,
                        channels: event.currentTarget.checked
                          ? [...form.then.alert.channels, channel]
                          : form.then.alert.channels.filter((item) => item !== channel),
                      },
                    },
                  })}
                  type="checkbox"
                />
                <span>{channel}</span>
              </label>
            ))}
          </fieldset>
          <SelectField
            label="Alert severity"
            value={form.then.alert.severity ?? "default"}
            options={["default", "info", "opportunity", "risk"]}
            disabled={readOnly}
            onChange={(severity) => {
              const alert = { ...form.then.alert };
              if (severity === "default") delete (alert as { severity?: string }).severity;
              else alert.severity = severity as NonNullable<typeof alert.severity>;
              onChange({ ...form, then: { ...form.then, alert } });
            }}
          />
          <label className={styles.checkOption}>
            <input checked={paperOrder !== undefined} disabled={readOnly} onChange={(event) => onChange({
              ...form,
              then: {
                ...form.then,
                ...(event.currentTarget.checked
                  ? { paperOrder: { side: "buy", size: { shares: 1 }, stop: { atrMultiple: 2 }, target: { r: 2 } } }
                  : { paperOrder: undefined }),
              },
            })} type="checkbox" />
            <span>Include paper action in spec (Phase 6)</span>
          </label>
          {paperOrder && <PaperOrderEditor value={paperOrder} onChange={(value) => onChange({ ...form, then: { ...form.then, paperOrder: value } })} disabled={readOnly} />}
        </div>
        <BlockErrors block="Then" errors={errors} />
      </section>

      <section className={styles.block} aria-labelledby="limits-heading">
        <div className={styles.blockHeading}><h3 id="limits-heading">Limits</h3><span>Optional guardrails</span></div>
        <label className={styles.checkOption}>
          <input checked={hasLimits} disabled={readOnly} onChange={(event) => onChange({ ...form, limits: event.currentTarget.checked ? {} : undefined })} type="checkbox" />
          <span>Set strategy limits</span>
        </label>
        {hasLimits && (
          <div className={styles.fields}>
            {(["maxTradesPerDay", "maxOpenPositions", "maxPositionUsd", "pauseAfterDailyLossUsd", "cooldownMinutes"] as const).map((field) => (
              <NumberField
                key={field}
                label={field}
                value={limits[field]}
                onChange={(value) => {
                  const next = { ...limits };
                  if (Number.isNaN(value)) delete next[field];
                  else next[field] = value;
                  onChange({ ...form, limits: next as StrategySpecForm["limits"] });
                }}
                disabled={readOnly}
                min={field === "cooldownMinutes" ? 0 : 1}
                max={field === "maxTradesPerDay" ? 12 : field === "maxOpenPositions" ? 10 : field === "cooldownMinutes" ? 1440 : 1_000_000}
                step={field === "maxPositionUsd" || field === "pauseAfterDailyLossUsd" ? "any" : "1"}
              />
            ))}
            <label className={styles.field}><span>Flat by (ET)</span><input disabled={readOnly} inputMode="numeric" onChange={(event) => {
              const next = { ...limits };
              if (event.currentTarget.value === "") delete next.flatBy;
              else next.flatBy = event.currentTarget.value;
              onChange({ ...form, limits: next as StrategySpecForm["limits"] });
            }} placeholder="15:50" value={String(limits.flatBy ?? "")} /></label>
          </div>
        )}
        <BlockErrors block="Limits" errors={errors} />
      </section>
      <p className={styles.schemaNote}>Saved against <code>StrategySpecV1Schema</code>. Nothing sends an order.</p>
      {readOnly && <p className={styles.help}>Selected history is immutable. Choose current version to edit a new version.</p>}
    </div>
  );
}

export function validateSpecForm(form: StrategySpecForm) {
  const result = StrategySpecV1Schema.safeParse(formToSpec(form));
  return { result, errors: result.success ? {} : groupSpecErrors(result.error) };
}
