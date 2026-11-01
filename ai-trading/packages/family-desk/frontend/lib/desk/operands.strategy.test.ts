import assert from "node:assert/strict";
import test from "node:test";
import { LevelOperandSchema, OperandSchema, SeriesOperandSchema } from "@ai-trading/contracts";
import { OPERAND_CATALOG, STRATEGY_OPERAND_CATALOG, choiceOf, defaultParams, defaultPicks, operandDef, operandFor, type OperandChoice } from "./operands.ts";

// The ids the contract allows, read off its schemas so a new series or level fails this file until a row is added.
const idsOf = (field: { options: readonly string[] } | { value: string }): string[] => ("options" in field ? [...field.options] : [field.value]);
const SERIES_IDS = SeriesOperandSchema.options.flatMap((member) => idsOf(member.shape.series));
const LEVEL_IDS = LevelOperandSchema.options.flatMap((member) => idsOf(member.shape.level));

const defaultChoice = (def: (typeof STRATEGY_OPERAND_CATALOG)[number]): OperandChoice => ({
  id: def.id,
  params: defaultParams(def),
  ...(def.picks ? { picks: defaultPicks(def) } : {}),
});

test("every contract series id and level id has exactly one STRATEGY_OPERAND_CATALOG row", () => {
  assert.equal(SERIES_IDS.length, 27);
  assert.equal(LEVEL_IDS.length, 16);
  const ids = STRATEGY_OPERAND_CATALOG.map((def) => def.id);
  assert.deepEqual([...ids].sort(), [...SERIES_IDS, ...LEVEL_IDS].sort());
  assert.equal(new Set(ids).size, ids.length, "no duplicate row");
  for (const def of STRATEGY_OPERAND_CATALOG) {
    assert.equal(def.group === "Levels", LEVEL_IDS.includes(def.id), `${def.id} is in the group that matches its kind`);
  }
});

test("the default operand of every row parses with OperandSchema", () => {
  for (const def of STRATEGY_OPERAND_CATALOG) {
    const operand = operandFor({ id: def.id, params: {} }, STRATEGY_OPERAND_CATALOG);
    assert.equal(OperandSchema.safeParse(operand).success, true, `${def.id} ${JSON.stringify(operand)}`);
  }
});

test("choiceOf(operandFor(choice)) round-trips for every row, including picks", () => {
  for (const def of STRATEGY_OPERAND_CATALOG) {
    const choice = defaultChoice(def);
    assert.deepEqual(choiceOf(operandFor(choice, STRATEGY_OPERAND_CATALOG), STRATEGY_OPERAND_CATALOG), choice, def.id);
    for (const pick of def.picks ?? []) {
      for (const option of pick.options) {
        const picked = { ...choice, picks: { ...defaultPicks(def), [pick.key]: option } };
        const operand = operandFor(picked, STRATEGY_OPERAND_CATALOG);
        assert.equal(OperandSchema.safeParse(operand).success, true, `${def.id}.${pick.key}=${option}`);
        assert.deepEqual(choiceOf(operand, STRATEGY_OPERAND_CATALOG), picked, `${def.id}.${pick.key}=${option}`);
      }
      assert.ok(pick.options.includes(pick.defaultValue), `${def.id}.${pick.key} default is one of its options`);
    }
  }
});

test("a number parameter at min and max parses; at min-1 and max+1 it does not (bounds equal the contract's)", () => {
  let checked = 0;
  for (const def of STRATEGY_OPERAND_CATALOG) {
    for (const param of def.params) {
      const parses = (value: number) => OperandSchema.safeParse(operandFor({ id: def.id, params: { [param.key]: value }, picks: defaultPicks(def) }, STRATEGY_OPERAND_CATALOG)).success;
      assert.equal(parses(param.min), true, `${def.id}.${param.key} at ${param.min}`);
      assert.equal(parses(param.max), true, `${def.id}.${param.key} at ${param.max}`);
      assert.equal(parses(param.min - 1), false, `${def.id}.${param.key} below ${param.min}`);
      assert.equal(parses(param.max + 1), false, `${def.id}.${param.key} above ${param.max}`);
      assert.equal(parses(param.defaultValue), true, `${def.id}.${param.key} default`);
      checked += 1;
    }
  }
  assert.ok(checked >= 30, `checked ${checked} parameters`);
});

test("OPERAND_CATALOG is unchanged: 24 ids, same order, same labels and parameters (it guards the rank and alerts lists)", () => {
  assert.deepEqual(
    OPERAND_CATALOG.map((def) => def.id),
    [
      "close", "open", "high", "low", "volume", "vwap", "gap_pct", "rvol", "rsi", "sma", "ema", "atr", "atr_pct",
      "prior_day_high", "prior_day_low", "prior_day_close", "premarket_high", "premarket_low", "session_high", "session_low",
      "opening_range_high", "opening_range_low", "n_day_high", "n_day_low",
    ],
  );
  assert.equal(OPERAND_CATALOG.filter((def) => def.group !== "Levels").length, 13);
  assert.equal(OPERAND_CATALOG.filter((def) => def.group === "Levels").length, 11);
  assert.equal(OPERAND_CATALOG.some((def) => def.picks), false, "no kit row has a choice parameter");
  const shape = Object.fromEntries(OPERAND_CATALOG.map((def) => [def.id, [def.label, def.group, def.params.map((p) => `${p.key}|${p.label}|${p.min}|${p.max}|${p.defaultValue}`)]]));
  assert.deepEqual(shape.rvol, ["Relative volume (days)", "Indicators", ["lookbackDays|Days|1|60|10"]]);
  assert.deepEqual(shape.sma, ["SMA", "Indicators", ["length|Length|2|500|20"]]);
  assert.deepEqual(shape.atr_pct, ["ATR % vs its median", "Indicators", ["length|ATR length|2|500|14", "medianLength|Median length|2|500|50"]]);
  assert.deepEqual(shape.opening_range_low, ["Opening range low (minutes)", "Levels", ["minutes|Minutes|1|120|15"]]);
  assert.deepEqual(shape.n_day_high, ["N-day high", "Levels", ["days|Days|2|260|20"]]);
  assert.deepEqual(shape.close, ["Close", "Price", []]);
  // The strategy catalog keeps those rows as they are and adds the other 19.
  assert.deepEqual(STRATEGY_OPERAND_CATALOG.slice(0, 24).map((def) => def.id), OPERAND_CATALOG.map((def) => def.id));
  assert.equal(STRATEGY_OPERAND_CATALOG.length, 43);
});

test("the catalog's lookups default to OPERAND_CATALOG and take a catalog as an option", () => {
  assert.equal(operandDef("macd"), undefined);
  assert.equal(operandDef("macd", STRATEGY_OPERAND_CATALOG)?.id, "macd");
  assert.throws(() => operandFor({ id: "macd", params: {} }));
  assert.deepEqual(operandFor({ id: "macd", params: {} }, STRATEGY_OPERAND_CATALOG), { series: "macd", line: "histogram", fast: 12, slow: 26, signal: 9 });
  assert.deepEqual(operandFor({ id: "sma", params: {} }, STRATEGY_OPERAND_CATALOG), { series: "sma", length: 20 }, "the kit's default wins over the builder's 14");
  assert.deepEqual(operandFor({ id: "pivot", params: {}, picks: { point: "R2" } }, STRATEGY_OPERAND_CATALOG), { level: "pivot", method: "classic", period: "session", point: "R2" });
});

test("choiceOf returns null for an operand outside the given defs", () => {
  const macd = { series: "macd", line: "signal", fast: 12, slow: 26, signal: 9 } as const;
  assert.equal(choiceOf(macd), null);
  assert.equal(choiceOf(macd, OPERAND_CATALOG), null);
  assert.deepEqual(choiceOf(macd, STRATEGY_OPERAND_CATALOG), { id: "macd", params: { fast: 12, slow: 26, signal: 9 }, picks: { line: "signal" } });
  assert.equal(choiceOf({ level: "pivot", method: "classic", period: "week", point: "S1" }), null);
  assert.equal(choiceOf({ series: "sma", length: 9 }, [])?.id, undefined);
  assert.deepEqual(choiceOf({ value: 3 }, []), { id: "value", value: 3 }, "a plain number needs no row");
});
