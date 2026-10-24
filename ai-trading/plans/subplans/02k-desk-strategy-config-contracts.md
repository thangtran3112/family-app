# 02k: Desk strategy-config contracts (persona split, technical-trading lane)

Status: implementation spec for `packages/family-desk/contracts` (Zod) and `packages/family-desk/backend`
(Pydantic). Desk lane only. Source design: the approved Paper persona-split plan, sections c1 (screener
defaults), c2 (preset library), and e (strategy-config schema outline). This document describes what is built;
where the code deviates from the plan it says so (section 10).

## 1. Architecture

The Desk engine already consumes one config language, `strategy-spec-v1` (`StrategySpecV1`): a `watch`
(universe, session, `runOn`), a `when` condition tree over a closed set of operands (`SeriesOperand`,
`LevelOperand`, constants), and a `then` (alert, optional paper order). The persona split adds no second
language. It adds one new spec (the screener) and extends v1 additively, so the Paper boards show exactly the
configs the engine can read.

| Strategy kind | Contract | Where it lives |
|---|---|---|
| 1 Filter strategy (screener) | `FilterStrategySpecV1` | `contracts/src/filter-strategy-spec-v1.ts`; shipped defaults in `contracts/templates/filters/` |
| 2 Pattern preset | `StrategySpecV1` template using the new `pattern` condition, plus a catalog entry | `contracts/templates/patterns/` (20 candlestick presets), `contracts/catalog.json` |
| 3 Custom strategy | plain `StrategySpecV1` (same shape) | no new schema; `origin` (`template:<id>` / `custom` / `ai_draft`) and `lane` are DB-record fields, not spec fields |
| 4 Alert strategy | `StrategySpecV1` at stage `alert_only`: `then` carries the alert and no `paperOrder` | `contracts/src/alert-strategy.ts` (`AlertStrategySpecV1`) |
| Draft exchange | `StrategyDraft`: an AI proposal for a filter or an alert, the user's edits, the final config | `contracts/src/strategy-draft.ts` |
| Preset index | `PresetCatalogV1` | `contracts/src/preset-catalog-v1.ts`; data in `contracts/catalog.json` |

Nothing here places an order. The Desk stays dark and trading stays off.

## 2. Conventions (match `strategy-spec-v1`)

- Zod is the source of truth. camelCase keys, `z.strictObject` everywhere, `schemaVersion: 1` on every document.
- No booleans and no nulls anywhere (the Pydantic `SpecModel` base rejects both). A flag is an enum. Every field is an
  enum, a bounded number, or a bounded or patterned string.
- Specs carry no `kind` field. The caller knows which spec it holds (a DB table, a catalog entry's `kind`, a draft's
  `target`).
- Changes to v1 are additive: every existing spec, template, and fixture stays valid.

## 3. Additive changes to `strategy-spec-v1`

| Change | Shape |
|---|---|
| `LevelOperand` gains two levels | `{ level: "session_high" }`, `{ level: "session_low" }` (no extra keys): the high or low of the current session so far; powers the high-of-day break |
| `Condition` gains `PatternCondition` | `{ op: "pattern", pattern: PatternId, trend?: "any" \| "after_downtrend" \| "after_uptrend", trendBars?: int 3..50, withinBars?: int 1..5 }` |
| `PatternId` (`PATTERN_IDS`) | `hammer`, `inverted_hammer`, `hanging_man`, `shooting_star`, `doji`, `dragonfly_doji`, `gravestone_doji`, `bullish_engulfing`, `bearish_engulfing`, `bullish_harami`, `bearish_harami`, `piercing_line`, `dark_cloud_cover`, `morning_star`, `evening_star`, `tweezer_bottom`, `tweezer_top`, `three_white_soldiers`, `three_black_crows`, `inside_bar` |
| `watch.universe` gains a third form | `{ filter: string 1..80 }`: the matches of a saved filter strategy, by name |
| `then.alert` gains three optional fields | `frequency: "once" \| "once_per_bar" \| "every_time"` (absent = current engine behavior); `expiresOn: "YYYY-MM-DD"` (America/New_York); `message: string 1..140` with only the `{symbol}`, `{close}`, `{time}` placeholders |
| `RunOnSchema` exported | the `watch.runOn` enum, reused by the filter spec (the JSON Schema is unchanged by this) |

Notes:

- `expiresOn` is checked for month 01..12 and day 01..31, not for the calendar (`2026-02-30` passes). The engine treats an
  unparseable date as expired when it enforces the field.
- `message` is restricted to BMP characters (no C0 or C1 control characters, no DEL, no surrogates, no `{` or `}` except the
  three placeholders). That keeps Zod's UTF-16 length and Python's code-point length equal, so the 140 limit means the same in both.
- Candle geometry (what a "hammer" is) is not in the schema. It lives in backend code (`core/patterns.py`, to be written) and is
  not user-tunable in v1.

## 4. FilterStrategySpecV1

```
{ schemaVersion: 1, name: string 1..80,
  watch: { universe: { market: "us_equities" } | { watchlist: string 1..80 } | { symbols: Ticker[] 1..70 },
           session: "regular" | "extended",
           runOn: <same enum as StrategySpecV1.watch.runOn> },
  assetTypes?: ("stock" | "etf")[] 1..2,
  liquidity?: { minPrice?: number >0 <=100000, minAvgVolume?: int 1..10_000_000_000, avgVolumeDays?: int 5..60 },
  when: Condition,                                   // the shared ConditionSchema and operands
  rank?: { by: SeriesOperand, order: "desc" | "asc" },
  maxResults: int 1..100 }
```

A filter has no `then`: it places no alert and no order. A `StrategySpecV1` can watch its matches through
`watch.universe.filter`. `when` uses the real operand names (`rvol`, `atr_pct`, `gap_pct`, `rsi`, `vwap`, `n_day_high`,
`close`, `prior_day_close`, and so on), not flat metric names, so the engine evaluates a screener with the code it already has.
`rank.by` is a `SeriesOperand` (a level or a constant has nothing to sort by).

### Screener defaults (plan section c1)

Ten files in `contracts/templates/filters/`. All are read-only; users copy them to edit. Every default shares the liquidity floor
`minPrice 5`, `minAvgVolume 500000`, universe `us_equities`, and `maxResults 50` (the plan names no result cap; 50 is the Desk's
screener page size). `RVOL10` is `rvol` with `lookbackDays 10`.

| File | `when` | `session` / `runOn` | Rank by |
|---|---|---|---|
| `abnormal-volume` | `rvol(10) gte 2.5` | regular / `bar_close_15m` | `rvol(10)` desc |
| `high-volatility` | `atr_pct(14, 50) gte 4` | regular / `daily_close` | `atr_pct` desc |
| `gap-up` | `gap_pct gte 3` AND `rvol(10) gte 1.5` | extended / `premarket_0830` | `gap_pct` desc |
| `gap-down` | `gap_pct lte -3` | extended / `premarket_0830` | `gap_pct` asc |
| `new-20-day-high` | `close crosses_above n_day_high(20)` | regular / `daily_close` | `rvol(10)` desc |
| `52-week-breakout` | `close crosses_above n_day_high(252)` | regular / `daily_close` | `rvol(10)` desc |
| `oversold-rsi` | `rsi(14) lt 30` | regular / `daily_close` | `rsi(14)` asc |
| `overbought-rsi` | `rsi(14) gt 70` | regular / `daily_close` | `rsi(14)` desc |
| `above-vwap-on-volume` | `close gt vwap` AND `rvol(10) gte 2` | regular / `bar_close_5m` | `rvol(10)` desc |
| `top-movers` | `gap_pct gte 4` (intraday `gap_pct` is the last price against the prior close) | regular / `bar_close_15m` | `gap_pct` desc |

The Bollinger "volatility squeeze" default is left out: the contract has no Bollinger operand yet. Add it when that operand exists.
The gap defaults use the extended session because the 08:30 premarket scan reads extended-hours bars, as the existing
`gap-and-go` template does. `contracts/test/filter-strategy-spec-v1.test.ts` pins every value above, and a backend test proves
each default is runnable today: as a `StrategySpecV1` it passes `core.evaluate.check()`.

## 5. Pattern presets and other templates (plan section c2)

Presets are `StrategySpecV1` files under `contracts/templates/`, indexed by `catalog.json`.

- `templates/*.json` (flat): the eleven pre-existing templates. They stay put: `backend/tests/test_templates.py` asserts the flat
  folder holds exactly its golden-tested set.
- `templates/patterns/`: the 20 candlestick presets (9 bullish reversal, 9 bearish reversal, doji, inside bar). Defaults: `runOn
  bar_close_15m`, `withinBars 1`; a reversal sets `trend after_downtrend` (bullish) or `after_uptrend` (bearish) with `trendBars 5`;
  an alert-only `then` (`inbox`, `frequency once_per_bar`, a `message` with placeholders), no paper order. Optional extras (RVOL >= 1.5
  confirmation, a near-level check with `within_pct 0.5`) are for the user to add in the builder.
- `templates/setups/`: the six new non-candlestick templates: `hod-break` (close crosses above `session_high`), `red-to-green`
  (close crosses above `prior_day_close`), `ema-9-21-cross`, `golden-death-cross` (SMA 50/200), `macd-signal-cross` (12/26/9), and
  `abnormal-volume-up-day`. The cross presets fire both ways (`any` of `crosses_above` and `crosses_below`).
- `templates/filters/`: the ten screener defaults (section 4).

`PresetCatalogV1` (`contracts/catalog.json`; an `id` is a slug, `^[a-z0-9][a-z0-9_-]{0,63}$`, so `52-week-breakout` is valid):

```
{ schemaVersion: 1,
  entries: { id: slug, file: string (path under templates/), kind: "strategy" | "filter", lane: "technical" | "fundamental",
             category: "candlestick" | "breakout" | "trend" | "volume" | "futures" | "income" | "long_term",
             bias: "bullish" | "bearish" | "neutral", label: string 1..80, summary: string 1..160 }[] 1..200 }
```

The catalog ships 47 technical-lane entries (10 filters, 20 candlestick, 5 breakout, 9 trend, 2 volume, 1 futures). The schema checks each
entry's shape; the tests check what a schema cannot: ids and files are unique, every `file` exists, every template file is cataloged
exactly once, `kind` matches the schema the file parses with, and the 20 pattern files cover the 20 `PatternId`s once each.

## 6. Custom strategy

A plain `StrategySpecV1`; there is no separate schema. The builder (plan c3) writes it, with the Pattern tab in the operand picker
producing `pattern` conditions. A preset's "Customize" copies the template into a draft, and the DB record carries
`origin: "template:<id>"`. Fixtures under `fixtures/strategy-spec-v1/valid/v2-custom-*.json` show the shape.

## 7. Alert strategy (`AlertStrategySpecV1`)

`StrategySpecV1.extend({ then: { alert } })`: the same `watch`, `when`, and `limits`, but `then` holds the alert alone, so a
`paperOrder` is an unrecognized key. This keeps 02a's rule that only strategies create alerts; the DB stage `alert_only` is where
such a spec lives. Channels stay the v1 enum `inbox | telegram | slack` (`inbox` is the in-app channel; there is no `in_app`
value). Two rules, ids in `ALERT_RULES`: channels do not repeat, and the first channel is `inbox`, so every alert lands in the Desk
inbox. The Pydantic class subclasses the generated `StrategySpecV1` and adds the same two checks (JSON Schema cannot say "unique,
inbox first"). Every valid alert fixture is also a valid plain `StrategySpecV1`.

## 8. Strategy draft (`strategy-draft.ts`)

```
{ schemaVersion: 1, draftId: slug, createdAt: "YYYY-MM-DDTHH:MM:SSZ",
  request: string 1..2000, rationale: string 1..2000,
  status: "proposed" | "edited" | "final" | "rejected",
  target: "filter" | "alert",
  draftConfig: FilterStrategySpecV1 | AlertStrategySpecV1,
  edits: Edit[] 0..50,                      // replace / add / remove at RFC 6901 pointers into draftConfig
  finalConfig?: FilterStrategySpecV1 | AlertStrategySpecV1 }
```

`target` says which of the two specs the configs are (neither carries a `kind`). Rules, ids in `DRAFT_RULES` (Zod) and the same-named
Python tuple, each enforced in both languages: `proposed` has no edits and no `finalConfig`; `edited` has edits and no `finalConfig`;
`final` has a `finalConfig`; `rejected` has none; `draftConfig` and `finalConfig` are the spec `target` names; `edits` apply cleanly;
for `edited` and `final`, `draftConfig` with the edits applied is a valid spec of its target; and for `final` it equals `finalConfig`
(the round trip: draft + edits = the validated final config).

The plan's API-only `DraftResponse { kind, spec, problems, diff, basedOnVersionId }` is a Pydantic-only API model and not part of this
contract set; it wraps these specs when the `draft_strategy` and `draft_filter` tools are built.

## 9. Generation pipeline and verification

- `contracts/scripts/generate-json-schema.ts` writes one bundle, `generated/strategy-spec-v1.schema.json`. Its root is `StrategySpecV1`;
  `FilterStrategySpecV1` and `PresetCatalogV1` ride along as extra `$defs`, and a def shared by several schemas (`Condition`,
  `SeriesOperand`, ...) must be identical or the generator throws. One bundle means one `datamodel-codegen` run and one generated
  module: `backend/src/ai_trading/contracts/strategy_spec_v1.py` now holds `StrategySpecV1`, `FilterStrategySpecV1`, and
  `PresetCatalogV1`, with the shared operand classes emitted once. `backend/scripts/generate-contracts.sh` is unchanged.
- Hand-written Pydantic is limited to what JSON Schema cannot carry: `alert_strategy.py` (channel rules), `strategy_draft.py`
  (cross-field rules and the edit replay), `json_pointer.py`, and `common.py` (draft primitives).
- Engine gate: `core.evaluate.check()` (called on every version save and every evaluation) now rejects the contract features no
  engine path runs yet: `watch.universe.filter`, the `pattern` condition, the `session_high` and `session_low` levels, and
  `then.alert.frequency`, `expiresOn`, and `message`. A saved spec therefore never reaches a tick that would crash on it or silently
  ignore an expiry. Remove an entry from `_UNSUPPORTED_*` as the engine learns it (`backend/tests/test_unsupported_features.py`).
- Tests: Zod tests accept every `valid` fixture and template and reject every `invalid` one; Pydantic tests do the same over the same
  files; `backend/tests/test_contract_crosscheck.py` dumps every Pydantic-parsed valid file back to JSON and re-parses it with
  `contracts/scripts/parse-configs.ts` (the matching Zod schema), and replays every invalid file through both validators. It needs
  `node` and `pnpm install` in `contracts/`; without them the two Zod-side tests skip.
- Run `pnpm typecheck && pnpm test` in `contracts/` and `uv run ruff check . && uv run ruff format --check . && uv run pytest -q` in
  `backend/`. After changing any Zod schema run `pnpm generate:json-schema` and then `backend/scripts/generate-contracts.sh`; both
  have a "generated file is current" test.

## 10. Deviations from the plan, and known gaps

- One JSON Schema bundle, not a second schema file with a second `--input` (section 9): avoids duplicating about 300 lines of
  generated operand classes and keeps the single ruff exclusion.
- The five new non-candlestick templates live in `templates/setups/`, not `templates/patterns/`: they use no `pattern` condition,
  and the flat folder is locked by `test_templates.py`. "Abnormal volume + up day" had no file yet, so it is one of the six.
- "Futures position risk (02g section 5)" is not shipped: it belongs to 02g and has no template yet.
- `liquidity.minAvgVolume` has an upper bound of 10,000,000,000 (the plan says only "int >= 1"); every field is bounded.
- `assetTypes` may repeat a value (`["stock", "stock"]`): harmless, and JSON Schema uniqueness would need hand-written Pydantic.
- Alert strategy: the plan's "stage alert_only" is a DB column, not a spec field, so the contract expresses it as "no `paperOrder`".
- A `filter` universe, `pattern` conditions, the new levels, and the new alert fields validate but cannot be saved as a strategy
  version until the engine implements them (the gate above); the filter defaults themselves use only operands the engine runs.
- `name`, `request`, and `rationale` limits count UTF-16 units in Zod and code points in Python (astral characters differ by one);
  `message` avoids the problem by being BMP-only.
- Code follow-ups (Desk lane): `core/patterns.py` and the pattern evaluator; `session_high` and `session_low` levels; the alert
  `frequency`, `expiresOn`, and `message` behavior; `filter` universe resolution; the `filter_strategies` and
  `filter_strategy_versions` tables, `strategies.lane` and `strategies.origin`, and the `draft_filter` tool.
