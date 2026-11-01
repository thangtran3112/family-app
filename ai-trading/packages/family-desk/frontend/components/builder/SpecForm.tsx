"use client";

import {
  StrategySpecV1Schema,
  type Operand,
  type StrategySpecV1,
} from "@ai-trading/contracts";
import {
  formToSpec,
  groupSpecErrors,
  switchToWatchlist,
  type SpecBlock,
  type SpecBlockErrors,
  type StrategySpecForm,
} from "@/lib/spec/form";
import { plainProblem } from "@/lib/desk/problems";
import { STRATEGY_OPERAND_CATALOG, choiceOf, operandDef, operandFor } from "@/lib/desk/operands";
import { describeSpec } from "@/lib/spec/describe";
import { RUN_ONS, optionLabel, paramLabel, subLabel } from "@/lib/spec/labels";
import { symbolsFromDraft, symbolsToDraft } from "@/lib/spec/symbols";
import type { WatchlistsResponseSchema } from "@/lib/api/schemas";
import { ConditionTree } from "@/components/conditions/ConditionTree";
import styles from "./builder.module.css";

type Props = {
  form: StrategySpecForm;
  watchlists: ReturnType<typeof WatchlistsResponseSchema.parse>;
  onChange: (form: StrategySpecForm) => void;
  errors: SpecBlockErrors;
  readOnly?: boolean;
};
type RecordValue = Record<string, unknown>;
type LevelOperand = Extract<Operand, { level: string }>;
type PaperOrder = NonNullable<StrategySpecV1["then"]["paperOrder"]>;

/** The price levels a stop or target can rest on: the strategy catalog's level rows, bounded by the contract. */
const LEVEL_IDS = STRATEGY_OPERAND_CATALOG.filter((def) => def.group === "Levels").map((def) => def.id);

function object(value: unknown): RecordValue {
  return value as RecordValue;
}

function numberText(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

function numeric(value: string): number {
  return value === "" ? Number.NaN : Number(value);
}

function BlockErrors({ block, errors }: { block: SpecBlock; errors: SpecBlockErrors }) {
  const entries = errors[block];
  if (!entries?.length) return null;
  return (
    <ul className={styles.errors} aria-label={`${block} validation errors`}>
      {entries.map((entry, index) => {
        const { field, text } = plainProblem(entry);
        return <li key={`${entry.path}-${index}`}><strong>{field}</strong>: {text}</li>;
      })}
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
  label, value, options, onChange, disabled, placeholder, labelOf = optionLabel,
}: {
  label: string;
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
  disabled: boolean;
  placeholder?: string;
  /** How an option reads; the default turns engine ids into trader words. Pass `String` for user-typed names. */
  labelOf?: (option: string) => string;
}) {
  return (
    <label className={styles.field}>
      <span>{label}</span>
      <select disabled={disabled} onChange={(event) => onChange(event.currentTarget.value)} value={value}>
        {placeholder && value === "" && <option value="">{placeholder}</option>}
        {options.map((option) => <option key={option} value={option}>{labelOf(option)}</option>)}
      </select>
    </label>
  );
}

/** A stop or target that rests on a price level: the level, then its choice and number parameters from the strategy catalog. */
function LevelActionEditor({
  label, value, onChange, disabled,
}: {
  label: string;
  value: LevelOperand;
  onChange: (value: LevelOperand) => void;
  disabled: boolean;
}) {
  const level = String(object(value).level);
  const def = operandDef(level, STRATEGY_OPERAND_CATALOG);
  const choice = choiceOf(value, STRATEGY_OPERAND_CATALOG);
  const params = choice !== null && !("value" in choice) ? choice.params : {};
  const picks = choice !== null && !("value" in choice) ? choice.picks ?? {} : {};
  const update = (patch: { params?: Record<string, number>; picks?: Record<string, string> }) =>
    onChange(operandFor({ id: level, params: { ...params, ...patch.params }, picks: { ...picks, ...patch.picks } }, STRATEGY_OPERAND_CATALOG) as LevelOperand);
  return (
    <div className={styles.actionFields}>
      <SelectField
        label={`${label} price level`}
        value={level}
        options={LEVEL_IDS}
        onChange={(next) => onChange(operandFor({ id: next, params: {} }, STRATEGY_OPERAND_CATALOG) as LevelOperand)}
        disabled={disabled}
      />
      {def?.picks?.map((item) => (
        <SelectField
          key={item.key}
          label={subLabel(label, item.key)}
          value={picks[item.key] ?? item.defaultValue}
          // The picker offers the level's own words; a stored value outside them still shows as its id.
          options={item.options.includes(picks[item.key] ?? item.defaultValue) ? item.options : [picks[item.key] ?? item.defaultValue, ...item.options]}
          onChange={(picked) => update({ picks: { [item.key]: picked } })}
          disabled={disabled}
        />
      ))}
      {def?.params.map((param) => (
        <NumberField
          key={param.key}
          label={subLabel(label, param.key)}
          value={params[param.key] ?? param.defaultValue}
          onChange={(amount) => update({ params: { [param.key]: amount } })}
          disabled={disabled}
          min={param.min}
          max={param.max}
        />
      ))}
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
      <SelectField label="Size order by" value={sizeKind} options={["riskUsd", "shares", "pctOfBook", "contracts"]} onChange={(kind) => update("size", defaultSize(kind))} disabled={disabled} />
      <NumberField label={paramLabel(sizeKind)} value={size[sizeKind]} onChange={(amount) => update("size", { ...size, [sizeKind]: amount })} disabled={disabled} step={sizeKind === "shares" || sizeKind === "contracts" ? "1" : "any"} min={1} />
      <SelectField label="Stop by" value={"atrMultiple" in stop ? "atrMultiple" : "level"} options={["atrMultiple", "level"]} onChange={(kind) => update("stop", kind === "atrMultiple" ? { atrMultiple: 2 } : operandFor({ id: "prior_day_low", params: {} }, STRATEGY_OPERAND_CATALOG))} disabled={disabled} />
      {"atrMultiple" in stop
        ? <NumberField label="Stop ATR multiple" value={stop.atrMultiple} onChange={(amount) => update("stop", { atrMultiple: amount })} disabled={disabled} step="any" min={0} max={20} />
        : <LevelActionEditor label="Stop" value={order.stop as LevelOperand} onChange={(next) => update("stop", next)} disabled={disabled} />}
      <SelectField label="Target by" value={"r" in target ? "r" : "level"} options={["r", "level"]} onChange={(kind) => update("target", kind === "r" ? { r: 2 } : operandFor({ id: "prior_day_high", params: {} }, STRATEGY_OPERAND_CATALOG))} disabled={disabled} />
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
  // The plain sentence the strategy says, so the form can be checked at a glance; it waits until the form is valid.
  const parsed = StrategySpecV1Schema.safeParse(formToSpec(form));

  return (
    <div className={styles.specForm} aria-label="Strategy specification form">
      {parsed.success && <p className={styles.sentence}>{describeSpec(parsed.data)}</p>}
      <section className={styles.block} aria-labelledby="watch-heading">
        <div className={styles.blockHeading}><h3 id="watch-heading">Watch</h3><span>What to watch, and when to check</span></div>
        <div className={styles.fields}>
          <label className={styles.field}><span>Strategy name</span><input disabled={readOnly} maxLength={80} onChange={(event) => onChange({ ...form, name: event.currentTarget.value })} value={form.name} /></label>
          <SelectField
            label="Watch"
            value={isWatchlist ? "watchlist" : "symbols"}
            options={["watchlist", "symbols"]}
            disabled={readOnly}
            onChange={(kind) => {
              if (kind === "watchlist") onChange(switchToWatchlist(form, watchlists.map(({ name }) => name)));
              else updateWatch({ universe: { symbols: ["SPY"] } });
            }}
          />
          {isWatchlist
            ? <SelectField
                label="Watchlist"
                value={currentWatchlist}
                options={watchlistNames}
                onChange={(watchlist) => updateWatch({ universe: { watchlist } })}
                disabled={readOnly || watchlistNames.length === 0}
                placeholder={watchlists.length ? "Choose a watchlist" : "No watchlists available"}
                labelOf={String}
              />
            : <label className={styles.field}><span>Symbols (comma-separated)</span><input disabled={readOnly} onChange={(event) => updateWatch({ universe: { symbols: symbolsFromDraft(event.currentTarget.value) } })} value={Array.isArray(universe.symbols) ? symbolsToDraft(universe.symbols) : ""} /></label>}
          <SelectField label="Session" value={form.watch.session} options={["regular", "extended"]} disabled={readOnly} onChange={(session) => updateWatch({ session: session as StrategySpecForm["watch"]["session"] })} />
          <SelectField label="Check on" value={form.watch.runOn} options={RUN_ONS} disabled={readOnly} onChange={(runOn) => updateWatch({ runOn: runOn as StrategySpecForm["watch"]["runOn"] })} />
        </div>
        <BlockErrors block="Watch" errors={errors} />
      </section>

      <section className={styles.block} aria-labelledby="when-heading">
        <div className={styles.blockHeading}><h3 id="when-heading">When</h3><span>Closed-bar conditions</span></div>
        <ConditionTree
          value={form.when}
          onChange={(when) => onChange({ ...form, when })}
          problems={errors.When ?? []}
          disabled={readOnly}
          hideLegend
        />
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
                <span>{optionLabel(channel)}</span>
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
            <span>Include paper action in spec (needs broker setup)</span>
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
                label={paramLabel(field)}
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
      <p className={styles.schemaNote}>Nothing here sends an order.</p>
      {readOnly && <p className={styles.help}>Selected history is immutable. Choose current version to edit a new version.</p>}
    </div>
  );
}

export function validateSpecForm(form: StrategySpecForm) {
  const result = StrategySpecV1Schema.safeParse(formToSpec(form));
  return { result, errors: result.success ? {} : groupSpecErrors(result.error) };
}