# 02k: Desk strategy-config contracts (persona split, technical-trading lane)

Status: implementation spec for `packages/family-desk/contracts` (Zod) and
`packages/family-desk/backend` (Pydantic mirror). Desk lane only.

## 1. What this adds

Five JSON config families. Every strategy result the Desk persists (or an AI assistant proposes) is
one of these documents, validated by the Zod schema in the browser/API layer and by the Pydantic
mirror in the backend. They sit next to `strategy-spec-v1` (the alert-and-paper-order spec) and do
not replace it. Nothing here places an order: `risk` fields are sizing hints, and no schema has an
order, broker, or activation field. The Desk stays dark and trading stays off.

| Family | `kind` | Zod file (`contracts/src/`) | Pydantic file (`backend/src/ai_trading/contracts/`) |
|---|---|---|---|
| Filter strategy (+ shipped preset catalog entry) | `filter`, `filter_preset` | `filter-strategy.ts` | `filter_strategy.py` |
| Pattern preset | `pattern` | `pattern-preset-strategy.ts` | `pattern_preset_strategy.py` |
| Custom strategy | `custom` | `custom-strategy.ts` | `custom_strategy.py` |
| Alert strategy | `alert` | `alert-strategy.ts` | `alert_strategy.py` |
| Strategy draft (AI proposal exchange) | `draft` | `strategy-draft.ts` | `strategy_draft.py` |

Shared: `strategy-common.ts` / `common.py` (primitives), `json-pointer.ts` / `json_pointer.py`
(RFC 6901 pointers, replace/add/remove edits, `jsonEqual`), `strategy-config.ts` / `strategy_config.py`
(one discriminated union over `kind`).

## 2. Conventions (match `strategy-spec-v1`)

- camelCase keys, `z.strictObject` (Pydantic `extra="forbid"` via `ConfigModel`), `schemaVersion: 1` and a
  `kind` literal on every top-level document.
- No booleans and no nulls anywhere (the Pydantic `SpecModel` base rejects both). A flag is an enum.
- No `.meta({ id })` in the new Zod files (ids are global; only v1 emits JSON Schema).
- Python models are hand-written; every Zod `superRefine` rule has a same-named `model_validator` rule.
- Fixtures: `contracts/fixtures/<family>/valid|invalid/*.json`. Shipped presets: `contracts/presets/...`.
  The same files feed the Zod tests (`contracts/test/`) and the Pydantic tests (`backend/tests/`).
- Do not put `1.0`-style integral floats in an integer field in fixtures (JS cannot tell `1.0` from `1`).

## 3. Filter strategy (`filter-strategy.ts`)

Metric (`FilterMetricSchema`, discriminated union on `metric`; `lookback`/`window` are bars of the timeframe):

| `metric` | extra fields | meaning |
|---|---|---|
| `close`, `volume`, `dollar_volume`, `gap_pct` | none | last close; bar volume; close x volume; open vs prior close, % |
| `avg_volume`, `volume_ratio`, `atr`, `atr_pct`, `stdev_pct`, `pct_from_high`, `pct_from_low`, `sma`, `ema`, `rsi` | `lookback` int 2..500 | `volume_ratio` = volume / avg_volume(lookback); `atr_pct` = ATR / close x 100; `stdev_pct` = stdev of bar returns, %; `pct_from_high` = % below the highest high in `lookback` bars (0 = at the high); `pct_from_low` = % above the lowest low |
| `change_pct` | `lookback` int 1..500 | % change over `lookback` bars |
| `volatility_percentile` | `measure` `atr`\|`stdev`, `lookback` int 2..500, `window` int 20..1000 | percent rank (0..100) of the current `measure` within the trailing `window` bars |

`FILTER_METRIC_DOMAIN`: metric -> `[min, max]` allowed threshold range (`null` = unbounded): `volatility_percentile`
`[0,100]`, `rsi` `[0,100]`, `pct_from_high` `[0,100]`, `gap_pct` and `change_pct` `[-100, null]`, every other metric `[0, null]`.

Condition (`FilterConditionSchema`, union): the metric's own fields, flat, plus either `op: gt|gte|lt|lte` with
`threshold: number`, or `op: "between"` with `min`, `max` (rule: `min < max`), for example
`{ "metric": "volume_ratio", "lookback": 20, "op": "gte", "threshold": 2 }`. Every threshold/min/max must lie
inside the metric's domain.

Group (`FilterGroupSchema`): `{ all: Node[] }` or `{ any: Node[] }`, 1..20 nodes, `Node` = condition | group
(recursive, same getter style as `strategy-spec-v1`). Exported helper `filterGroupStats(group)` ->
`{ depth, leaves }` (top group has depth 1). Rule on every consumer: depth <= 3 and leaves <= 30.

`FilterStrategySchema`:

```
{ schemaVersion: 1, kind: "filter", name, description?, timeframe, universe?,
  match: FilterGroup,
  rank?: { by: FilterMetric, order: "asc"|"desc", limit: int 1..200 },
  preset?: { id: Slug, params: { [paramKey]: number } } }   // provenance of a customized preset
```

`universe` absent means the caller's active watchlist. `paramKey` = `^[a-z][A-Za-z0-9]{0,31}$`.

`FilterPresetSchema` (shipped catalog entry; files in `contracts/presets/filters/`):

```
{ schemaVersion: 1, kind: "filter_preset", id: Slug, name, description,
  category: "volume"|"volatility"|"gap"|"range"|"proximity",
  params: [{ key: paramKey, label (1..60), unit: "x"|"pct"|"percentile"|"bars"|"usd"|"shares",
             path: JsonPointer, default, min, max, step? }],     // 1..8, keys and paths unique
  strategy: FilterStrategy }
```

Rules: `strategy.preset` exists with `id` equal to the entry id and `params` keys/values equal to the param keys/defaults;
each param has `min < max`, `min <= default <= max`, and its `path` resolves inside `strategy` to a number equal to `default`.
A user customizes a preset by editing the values at those paths and recording them in `strategy.preset.params`.

Shipped presets (`id`): `abnormal-volume` (volume_ratio, lookback 20, >= 2), `volatility-atr-percentile`
(volatility_percentile atr, >= 80), `volatility-stdev-percentile` (same with stdev), `gap-up` (gap_pct >= 3),
`gap-down` (gap_pct <= -3), `price-volume-range` (close between 5 and 50 AND avg_volume >= 1000000),
`near-52w-high` (pct_from_high lookback 252 <= 5, timeframe `1d`).

## 4. Pattern preset (`pattern-preset-strategy.ts`)

`PatternKindSchema`: `hammer`, `inverted_hammer`, `bullish_engulfing`, `bearish_engulfing`, `doji`, `morning_star`,
`evening_star`, `three_white_soldiers`, `three_black_crows`, `breakout`, `bullish_reversal`, `bearish_reversal`.

`PATTERN_RULES` (one table, mirrored in Python) drives the validity rules:

| kind | category | bars | `lookback` | allowed `direction` | exact `tolerance` keys |
|---|---|---|---|---|---|
| hammer, inverted_hammer | candlestick | 1 | absent | bullish | `shadowMinRatio`, `bodyMaxPct` |
| bullish_engulfing | candlestick | 2 | absent | bullish | `engulfMinRatio` |
| bearish_engulfing | candlestick | 2 | absent | bearish | `engulfMinRatio` |
| doji | candlestick | 1 | absent | neutral | `bodyMaxPct` |
| morning_star | candlestick | 3 | absent | bullish | `starBodyMaxPct` |
| evening_star | candlestick | 3 | absent | bearish | `starBodyMaxPct` |
| three_white_soldiers | candlestick | 3 | absent | bullish | `bodyMinPct` |
| three_black_crows | candlestick | 3 | absent | bearish | `bodyMinPct` |
| breakout | technical | n/a | required | bullish (close above prior N-bar high), bearish (below low) | `bufferPct` |
| bullish_reversal | technical | n/a | required | bullish | `retracePct` |
| bearish_reversal | technical | n/a | required | bearish | `retracePct` |

Tolerance fields (all `number`): `bodyMaxPct` (0,100], `bodyMinPct` (0,100], `starBodyMaxPct` (0,100], `shadowMinRatio` (0,20],
`engulfMinRatio` [1,5], `bufferPct` [0,10], `retracePct` (0,100].

`PatternSpecSchema`:

```
{ pattern: PatternKind, direction: "bullish"|"bearish"|"neutral", timeframe,
  lookback?: int 2..260,
  priorTrend?: { direction: "up"|"down"|"any", bars: int 1..50 },
  confirmation: { type: "none" } | { type: "next_bar_close", bars: int 1..3 }
              | { type: "volume", minRatio: number 1..20, lookback: int 2..60 },
  tolerance: { ...keys above } }
```

Rules: direction is allowed for the kind; `lookback` present exactly for the lookback kinds; `tolerance` has exactly the
kind's keys; for candlestick kinds with `priorTrend`, a bullish pattern needs `down` or `any` and a bearish pattern needs
`up` or `any`.

`PatternPresetSchema`: `{ schemaVersion: 1, kind: "pattern", id: Slug, name, description?, spec: PatternSpec }`.
Shipped presets in `contracts/presets/patterns/`: `hammer`, `inverted-hammer`, `bullish-engulfing`, `bearish-engulfing`,
`doji`, `morning-star`, `evening-star`, `three-white-soldiers`, `three-black-crows`, `breakout-up`, `breakout-down`,
`bullish-reversal`, `bearish-reversal`.

## 5. Custom strategy (`custom-strategy.ts`)

```
{ schemaVersion: 1, kind: "custom", name, description?, timeframe, universe?,
  direction: "long"|"short"|"either",
  filters?: FilterGroup,
  patterns?: { match: "all"|"any", entries: [{ presetId?: Slug, spec: PatternSpec }] },   // 1..8 entries
  risk?: { stop?: Stop, target?: Target, positionSizeHint?: SizeHint } }                  // non-empty
Stop   = { type: "pct", value: (0,50] } | { type: "atr_multiple", value: (0,20] }
Target = { type: "pct", value: (0,500] } | { type: "r_multiple", value: (0,20] } | { type: "atr_multiple", value: (0,40] }
SizeHint = { type: "risk_pct_of_book", value: (0,5] } | { type: "notional_usd", value: (0,1000000] }
         | { type: "shares", value: int 1..100000 }
```

Validity rule set (`CUSTOM_RULES`, each rule has a fixture in `invalid/`):

1. `filters` or `patterns` present.
2. Filter group depth <= 3 and leaves <= 30.
3. Every pattern `spec.timeframe` is the strategy timeframe or longer (`timeframeAtLeast`).
4. No two pattern entries share `(pattern, timeframe, direction)`.
5. With `patterns.match = "all"`, entries cannot mix bullish and bearish directions.
6. `direction: "long"` rejects bearish entries; `"short"` rejects bullish entries (neutral is always fine).
7. A `r_multiple` target requires a `stop`.
8. `risk`, when present, has at least one of its three keys.

## 6. Alert strategy (`alert-strategy.ts`)

```
{ schemaVersion: 1, kind: "alert", name, description?, severity?, timeframe,
  trigger: { type: "strategy_match", strategyId: Slug }
         | { type: "price_cross", symbol: Ticker, direction: "above"|"below", level: number (0,1000000] }
         | { type: "indicator_threshold", symbol: Ticker, indicator: FilterMetric,   // nested metric object
             op: gt|gte|lt|lte|crosses_above|crosses_below, threshold: number },
  schedule: { sessions: "regular"|"extended"|"always", days: ("mon".."sun")[1..7], window?: { start: HH:MM, end: HH:MM } },
  cooldown: { minutes: int 0..1440, dedupe: "per_symbol"|"per_trigger"|"per_bar" },
  maxPerDay?: int 1..50,
  channels: ("in_app"|"telegram"|"slack")[1..3] }
```

`in_app` is the first-class channel (v1 specs call it `inbox`; the API layer maps the two). Rules: `channels` unique and
`channels[0] === "in_app"`; `days` unique and, for `regular`/`extended`, no `sat`/`sun`; `window.start < window.end`
(same-day, New York time); a `regular` window stays inside 09:30-16:00 and an `extended` window inside 04:00-20:00;
`indicator_threshold.threshold` lies in the metric's domain (`FILTER_METRIC_DOMAIN`).

## 7. Strategy draft (`strategy-draft.ts`)

```
{ schemaVersion: 1, kind: "draft", draftId: Slug, createdAt: UtcTimestamp,
  request: string (1..2000),        // the user's natural-language ask
  rationale: string (1..2000),      // the assistant's explanation
  status: "proposed"|"edited"|"final"|"rejected",
  draftConfig: FilterStrategy | AlertStrategy,       // discriminated on kind
  edits: Edit[] (0..50),                              // user edits: replace/add/remove at JSON pointers into draftConfig
  finalConfig?: FilterStrategy | AlertStrategy }
```

Rules: `proposed` has no edits and no `finalConfig`; `edited` has edits and no `finalConfig`; `final` has `finalConfig`;
`rejected` has no `finalConfig`; `edits` apply cleanly to `draftConfig` (`applyEdits`) for `edited` and `final`;
`finalConfig.kind === draftConfig.kind`; for `final`, `jsonEqual(applyEdits(draftConfig, edits), finalConfig)`.
That last rule is the round trip: draft + edits = the validated final config, in both languages.

## 8. Cross-check

- Zod tests accept every `valid` fixture and preset, reject every `invalid` fixture, and the new shared edit cases
  (`fixtures/json-pointer/cases.json`).
- Pydantic tests do the same over the same files, and assert `model_dump(mode="json", by_alias=True, exclude_unset=True)`
  of a parsed valid file equals the file.
- `backend/tests/test_strategy_config_crosscheck.py` dumps every Pydantic-parsed valid file back to JSON and runs
  `contracts/scripts/parse-configs.ts` (Zod `StrategyConfigSchema`) over the dumps: Zod JSON <-> Pydantic parse in both directions.

## 9. Implementation notes (as built)

- Verification: `pnpm typecheck && pnpm test` in `contracts/` and `uv run ruff check . && uv run ruff format --check . && uv run pytest -q`
  in `backend/` are green. A one-off differential fuzz (about 41,000 single-field mutations of every valid fixture: delete, null,
  boolean, wrong type, boundary numbers) gave the same accept/reject verdict from Zod and Pydantic in every case.
- Rule ids live in `CUSTOM_RULES`, `ALERT_RULES`, `DRAFT_RULES` (Zod) and the same-named Python tuples; the tests assert the two
  lists match and that each rule has an `invalid/` fixture prefixed with its id. Filter and pattern rules are unnamed but each has
  an `invalid/` fixture.
- Filter conditions are flat (`{ "metric": "rsi", "lookback": 14, "op": "lt", "threshold": 30 }`); `rank.by` and the alert's
  `indicator` carry the nested metric object.
- `backend/tests/test_strategy_config_crosscheck.py` is the Zod JSON <-> Pydantic check. It needs `node` and `pnpm install` in
  `contracts/`; without them the two Zod-side tests skip and the Pydantic-side tests still run.
- `strategy-spec-v1` is unchanged except that `HhMmSchema` and `TickerSchema` are now exported. The only package change is the
  `./*` subpath export and the `node --test test/*.test.ts` script.

Known gaps, deliberately left for the consumer layers:

- A customized filter's `preset.params` is not checked against the shipped preset's `min`/`max`/`path`: the catalog entry is the
  only place those live, so the API layer that loads a customized strategy must check it against the entry.
- `presetId` in a custom strategy's pattern entry is only a slug; it is not required to match a shipped preset or its `spec`.
- Edits on a `rejected` draft are not replayed. `bars` in `PATTERN_RULES` is informational.
- The engine still needs exact definitions for `breakout.bufferPct`, `*_reversal.retracePct`, and `lookback` on the technical
  patterns; the schema only fixes their shape and range.
- `request`, `rationale`, `name`, and `description` limits count UTF-16 units in Zod and code points in Python (astral characters
  such as emoji differ by one).
