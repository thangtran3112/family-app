# 02m: Family Desk desktop MVP implementation spec (interface contract for the services and frontend streams)

Status: written 2026-10-24. Docs only: it changes no code and activates nothing. Implements [02l](02l-desk-desktop-first-mvp.md) §e on top of
the merged contracts ([02k](02k-desk-strategy-config-contracts.md)) and the provider registry ([02j](02j-common-data-providers-design.md)).
The public Desk stays dark, IBKR stays disabled, and orders stay off throughout; every item below is built behind those states.

Two implementation streams work in parallel from this file:

- **Services stream (S):** `ai-trading/packages/family-desk/backend` and, where §b4 says so, `ai-trading/common`.
- **Frontend stream (F):** `ai-trading/packages/family-desk/frontend`.

**This file is the interface.** Stream S owns the Pydantic response models; the generated `lib/api/openapi.json` and `openapi.d.ts` are
the frozen contract stream F codes against (§d2 step 2). Where the two disagree, the OpenAPI file wins and this file is corrected in
the same pull request.

Inputs read: 02l §d1/§e, 02j, the backend and frontend as of `dev` (21 routes under `/api/desk`), and the Run 0 snapshot
(`temp/desk-desktop-mvp/snapshot-2026-10-23.json`, gitignored; its structure is mapped in §a4).

## a. API surface

### a1. Conventions

- **Base path:** `/api/desk`. Static-export frontend, so no route ever puts an id in the page path; the API does (`/screener/filters/{id}`).
- **Auth: the existing gate, nothing new.** Caddy `forward_auth` verifies the Clerk session and sets the verified-identity header;
  `api/auth.py` `get_current_user` reads only that header (401 when missing) and lazily creates the `users` row. Every new router is
  declared `APIRouter(..., dependencies=[Depends(get_current_user)])`. SSE keeps `get_current_user_for_stream`. A new test walks
  `app.routes` and asserts every `/api/desk` route answers 401 without the header (§d3), so no route can ship unguarded.
- **Ownership:** every row is scoped to `user.id`; a non-owner gets the same `404` as a missing id (the `_owned_*` pattern in
  `api/watchlists.py` and `api/strategies.py`). Seed filters and seed alert strategies are per-user copies, so there is no shared row.
- **Time:** every timestamp is ISO-8601 UTC with `Z`. The frontend formats it in `America/New_York`. (The mocks' `time_et` strings
  such as `"2026-10-23 15:45"` are display text; `lib/desk/format.ts` produces them.)
- **Symbols:** upper-case tickers; futures roots keep the leading `/` (`/ES`), as in `api/bars.py`.
- **The stamp.** Every response that carries market data embeds `stamp`, and the UI never computes freshness itself (02l §e1):

  ```json
  { "as_of": "2026-10-23T20:00:00Z", "source": "alpaca", "quality": "delayed-15m", "freshness": "closed" }
  ```

  - `quality` is the existing 02j `Quality` (`realtime | delayed-15m | eod | fallback | unavailable`). `fallback` drives "Using backup quotes".
  - `freshness` is `live | delayed | closed | paused | unavailable`, computed once by `core/freshness.py` (§b3) from the data and the
    calendar. It maps one to one onto 02l §c3. "Updating" and "Reconnecting" are client states (a request in flight, an SSE
    connection down), not API values.
  - Market session comes separately: `session: "pre" | "regular" | "after" | "closed"`.
  - **No fabricated values in production.** ES and NQ tiles return `freshness: "unavailable"` until the IBKR slot is live (§b4);
    the mocks' SIMULATED labels are design-only.
- **Metric names are the snapshot's.** Anywhere a per-symbol metric row appears (screener columns, watchlist table, dashboard heat),
  the keys are exactly `last, prev_close, change_pct, volume, avg_volume_20d, rvol_10d, atr_pct_14, rsi_14, gap_pct_open, high_252d,
  dist_to_252d_high_pct, vwap_close, vs_vwap_pct, rvol_intraday_10d_at_close`. Values are numbers or `null`, never `NaN`.
- **Errors:** the FastAPI default `{"detail": ...}` for 401/404. Spec validation failures (filters, alert strategies) use `422` with
  `{"detail": {"problems": [{"path": "then.alert.channels", "message": "the first alert channel must be inbox"}]}}`; `path` is a dotted
  JSON path from `contracts/json_pointer.py`, shown in small muted text under the plain message (D6, D10). A `POST .../validate` or
  `/preview` returns the same `problems` array with `200` so the form can show it live.
- **Lists** are plain arrays unless a response needs more than rows; no pagination except `GET /signals` (existing `limit/offset`) and
  `GET /alerts/log` (same parameters).
- **Cache:** all reads are `Cache-Control: no-store`; the frontend refetches (§c4), so no ETag work in the MVP.

### a2. Endpoint inventory (47 MVP endpoints + 6 legacy)

`E` = exists today, unchanged. `X` = exists, extended additively (new optional fields or params; no field removed or retyped except
where noted). `N` = new. All paths are under `/api/desk`.

| # | Method and path | | Screen | Purpose |
|---|---|---|---|---|
| 1 | GET `/me` | E | all | identity (email) for the avatar |
| 2 | GET `/status` | X | D1, D11 | market session, quote and scan sources, alert-runtime state, unread count, slots |
| 3 | GET `/symbols/search?q=` | N | D1 | `⌘K` search over the stored universe and watchlists |
| 4 | GET `/dashboard?watchlist_id=` | N | D2 | one aggregate read for the dashboard |
| 5 | GET `/bars/{symbol}` | X | D3, D5, D10 | chart bars; adds `ext` per bar |
| 6 | GET `/technicals/{symbol}` | X | D3, D4 | gauges, tables, pivots, levels, strategy votes, "what changed" |
| 7 | GET `/quotes/{symbol}` (SSE) | X | D3, D7 | last price; adds `freshness`, `source`, `session` to each event |
| 8 | GET `/charts/{symbol}/markers` | N | D3 | pattern markers and fired-alert markers for the visible range |
| 9 | GET `/signals` | X | D2, D3 | signal feed; adds strategy name and kind |
| 10 | GET `/screener/filters` | N | D1, D5 | seed defaults plus hers, with last-run match counts |
| 11 | POST `/screener/filters` | N | D5, D6 | create (`copy_of` a seed, or a full spec) |
| 12 | GET `/screener/filters/{id}` | N | D6 | spec, version, read-only flag, default spec |
| 13 | PUT `/screener/filters/{id}` | N | D6 | save draft (new version) |
| 14 | DELETE `/screener/filters/{id}` | N | D5, D6 | archive her filter |
| 15 | GET `/screener/filters/{id}/results` | N | D5 | matches in the snapshot's `screeners[id]` shape |
| 16 | POST `/screener/preview` | N | D6 | validate a spec and return live match count plus top five |
| 17 | GET `/screener/universe` | N | D5 | the "Scanned N US stocks and ETFs" line and floor |
| 18 | GET `/watchlists` | E | D1, D7 | list |
| 19 | POST `/watchlists` | E | D7 | create |
| 20 | PATCH `/watchlists/{id}` | N | D7 | rename |
| 21 | DELETE `/watchlists/{id}` | N | D7 | delete |
| 22 | GET `/watchlists/{id}/items` | E | D7 | symbols plus backfill state |
| 23 | POST `/watchlists/{id}/items` | E | D7 | add a symbol |
| 24 | DELETE `/watchlists/{id}/items/{symbol}` | E | D7 | remove a symbol |
| 25 | PUT `/watchlists/{id}/order` | N | D7 | manage mode: reorder symbols |
| 26 | GET `/watchlists/{id}/table` | N | D1, D2, D7 | dense rows: metrics, bias label, strategy tags |
| 27 | GET `/library?category=&q=` | N | D8 | preset catalog |
| 28 | GET `/library/{id}` | N | D8 | one preset: template spec, defaults, real example |
| 29 | POST `/library/{id}/attach` | N | D8 | write an alert-only strategy on a watchlist |
| 30 | GET `/alert-strategies` | N | D3, D7, D9 | list with status, last fired, spec |
| 31 | POST `/alert-strategies` | N | D10 | create |
| 32 | POST `/alert-strategies/validate` | N | D10 | live validation and plain summary inputs |
| 33 | GET `/alert-strategies/{id}` | N | D9 | detail (spec, versions) |
| 34 | PUT `/alert-strategies/{id}` | N | D9, D10 | edit (new version) |
| 35 | DELETE `/alert-strategies/{id}` | N | D9 | archive |
| 36 | POST `/alert-strategies/{id}/pause` | N | D9 | pause |
| 37 | POST `/alert-strategies/{id}/resume` | N | D9, D10 | resume or `Turn on` (draft to alert-only) |
| 38 | GET `/alert-strategies/{id}/fires` | N | D9 | recent fires with chart-thumbnail bars |
| 39 | GET `/alerts` | X | D1, D2 | inbox; adds `symbol`, `strategy_id`, `strategy_name`; filters |
| 40 | POST `/alerts/{id}/read` | E | D1 | mark read |
| 41 | POST `/alerts/read-all` | N | D1 | mark all read |
| 42 | GET `/alerts/log` | N | D9 | delivered, held for quiet hours, no channel, failed |
| 43 | GET `/settings` | E | D11 | settings object |
| 44 | PUT `/settings` | X | D11 | validates the new keys (§a3.9) |
| 45 | GET `/settings/channels` | N | D10, D11 | per-channel connection state (never a secret) |
| 46 | PUT `/settings/channels/telegram` | N | D11 | link her Telegram chat |
| 47 | POST `/settings/channels/{channel}/test` | N | D11 | send a test message through the channel |
| 48–52 | GET/POST `/strategies`, GET/POST `/strategies/{id}/versions`, PUT `/strategies/{id}/stage` | E | none | legacy generic strategy API; unchanged, kept for the existing `/strategies` and builder routes |
| 53 | GET `/futures/specs` | E | none | legacy; unchanged |

Count: **47** endpoints serve the desktop MVP (**32** new, **7** extended, **8** unchanged), plus **6** legacy untouched, **53** under
`/api/desk` in total. `/healthz` is outside the prefix and unchanged. There is no endpoint that places or previews an order (§e).

### a3. Shapes by screen

Types are TypeScript-style for brevity; stream S writes them as Pydantic models (`FiniteFloat | None` for numbers), stream F as zod
schemas that `satisfies` the generated `openapi.d.ts` types (the existing `lib/api/schemas.ts` pattern).

#### a3.1 Platform (D1)

`GET /status`. The existing fields `gateway`, `data_sources`, `streaming_slots`, `backups`, `reconciliation` stay; the two literal types
widen. New fields:

```json
{
  "market": { "session": "closed", "next_open": "2026-10-26T13:30:00Z", "last_close": "2026-10-23T20:00:00Z" },
  "quotes": { "source": "alpaca", "quality": "delayed-15m", "freshness": "closed", "as_of": "2026-10-23T20:00:00Z" },
  "scans":  { "source": "alpaca", "quality": "delayed-15m", "freshness": "delayed", "as_of": "2026-10-23T20:00:00Z", "next_run_at": "2026-10-26T12:30:00Z" },
  "alerts": { "state": "running", "unread": 2 },
  "gateway": "not_configured",
  "data_sources": "alpaca",
  "streaming_slots": { "used": 0, "max": 70 }
}
```

`alerts.state` is `running | paused_no_quotes | paused_by_user | not_started` ("Alerts paused until quotes return" = `paused_no_quotes`).
`gateway` widens to `not_configured | connected | reconnecting | down`; `data_sources` to `unknown | alpaca | ibkr | mixed`. The top bar,
status bar, and D11 rows all read this one response; the frontend polls it every 30 s from one shell-level provider.

`GET /symbols/search?q=NV&limit=8` returns `[{ "symbol": "NVDA", "name": "NVIDIA Corp", "asset_type": "stock|etf", "in_watchlist": true }]`:
prefix match on symbol, then substring on name, over `universe_symbols` (§b2) plus her watchlist symbols.

#### a3.2 Dashboard (D2)

`GET /dashboard?watchlist_id=` (default: her first `intraday` watchlist):

```json
{
  "stamp": { "as_of": "…", "source": "alpaca", "quality": "delayed-15m", "freshness": "closed" },
  "market": { "session": "closed", "next_open": "2026-10-26T13:30:00Z" },
  "market_strip": [
    { "symbol": "SPY", "last": 678.12, "change_pct": 0.31, "stamp": { "…": "…" } },
    { "symbol": "/ES", "last": null, "change_pct": null, "stamp": { "freshness": "unavailable", "…": "…" } }
  ],
  "signals": [
    { "id": 41, "symbol": "NVDA", "strategy_id": 7, "strategy_name": "ORB 15m", "kind": "orb|vwap_reclaim|pattern|rvol|other",
      "bar_time": "2026-10-23T13:45:00Z", "summary": "Opening range break up", "evidence": { "close": 212.4 } }
  ],
  "screener_matches": [
    { "filter_id": 3, "name": "Abnormal volume", "run_on": "bar_close_15m", "scanned": 131, "matches_total": 9,
      "top": ["BOLT", "…", "…"], "stamp": { "…": "…" } }
  ],
  "watchlist": { "id": 1, "name": "Day movers", "rows": [ { "symbol": "NVDA", "last": 210.9975, "change_pct": -1.1, "rvol_10d": 0.98,
      "vs_vwap_pct": -0.2, "bias_label": "Sell" } ] },
  "events": [ { "symbol": "MSFT", "kind": "earnings", "date": "2026-10-28", "timing": "after_close" } ],
  "alerts_state": "running"
}
```

`market_strip` is SPY, QQQ, IWM, then `/ES`, `/NQ` (the unavailable tiles). `signals` is today's session, newest first, max 20 (an empty
array drives "No signals yet today · your strategies are watching"). `screener_matches` is one entry per active filter, from each
filter's last run. `events` are earnings dates for symbols on her watchlists from the 02j `earnings_calendar` kind (earnings dates
only). The aggregate is composed in `api/dashboard.py` from the services in §b1; it adds no new storage.

#### a3.3 Chart workspace and technicals (D3, D4)

`GET /bars/{symbol}?interval=&days=&session=` keeps `BarsOut` (`{symbol, interval, quality, as_of, bars:[{t,o,h,l,c,v}]}`) and adds `"ext": true`
on pre/after-hours bars (extended-hours shading) and `stamp`. The snapshot's `{columns, rows}` form is a mock convenience; the port maps
`time_et` to `t` and rows to objects in a loader, not in components.

`GET /technicals/{symbol}?timeframe=&days=` keeps `TechnicalsOut` and adds what the snapshot's per-timeframe cell holds beyond
`technicals`:

```json
{
  "…": "all existing TechnicalsOut fields (gauges.summary/oscillators/moving_averages, moving_averages, oscillators, pivots, rsi, macd, volatility, card_back)",
  "timeframe": "15m", "bars_used": 858, "first_bar": "2026-09-09T13:30:00Z", "last_bar": "2026-10-23T19:45:00Z", "bias_ready": true,
  "indicators": { "sma_5": 211.5748, "ema_200": 217.5803, "rsi_14": 36.0418, "macd_histogram": 0.0179, "atr_14": 0.7152, "atr_pct": 0.3389, "atr_label": "low" },
  "bias_history": {
    "history": [ { "bar": "2026-10-23T13:30:00Z", "summary": "Sell", "score": -0.176, "oscillators": "Buy", "moving_averages": "Strong Sell" } ],
    "last_change_in_window": { "from": "Strong Sell", "to": "Sell", "at_bar": "2026-10-23T19:45:00Z" }
  },
  "levels": { "prior_close": 214.1, "session_high": 213.8, "session_low": 210.7 },
  "gauges": { "…": "…", "strategies": { "label": "Buy", "score": 0.33, "counts": { "buy": 2, "neutral": 0, "sell": 1 },
      "votes": [ { "strategy_id": 7, "name": "Hammer 15m near S1", "bias": "bullish", "vote": "buy" } ],
      "watching": [ { "strategy_id": 9, "name": "ORB 15m" } ] } },
  "stamp": { "…": "…" }
}
```

- `timeframe` accepts `5m 15m 30m 1h 4h 1d 1w` (the existing `Timeframe` literal, plus `1m` for the chart only). `bias_history.history` is the last
  20 closed bars of the requested timeframe (the "What changed" line reads `last_change_in_window`).
- `indicators` is the last-value map the snapshot calls `indicators`. Chart series (EMA, RSI, MACD) are **computed in the browser** from
  `/bars` with `lib/indicators-with-gaps.ts`, as `RsiMacdChart` already does; the one gap is VWAP, which F adds as a session-anchored
  `calcVWAP` (resets each New York trading day, with a gap-aware variant like its siblings) in `lib/indicators.ts`. No server series endpoint, to keep one source of bars.
- `levels` adds prior close and session high/low to the pivots already returned (the key-levels block and chart dotted lines).
  `session_high` and `session_low` come from `core/levels.py` (02l §e2 item 5).
- `gauges.strategies` is the fourth gauge (02l §e4): each of her attached, non-paused alert-only strategies whose condition is true
  on the last closed bar votes its catalog `bias`; score and label reuse `core/bias.py` thresholds; the rest go to `watching`.
  A strategy votes on timeframe T when its `runOn` cadence equals T: `bar_close_5m`, `bar_close_15m`, and `bar_close_1h` vote on `5m`, `15m`, `1h`;
  `bar_close_1m` votes on `5m`; `daily_close` votes on `1d`; `weekly` votes on `1w`; `premarket_0830` strategies are always listed as watching. Decision made here; stream S may refine it with the owner.
  When she has no attached strategies, `strategies` is `null` and the gauge shows "Attach a strategy to see its vote".

`GET /charts/{symbol}/markers?timeframe=15m&from=&to=`:

```json
{
  "patterns": [ { "pattern": "bearish_engulfing", "template": "bearish-engulfing", "bar_start": "2026-10-23T15:30:00Z",
                  "bar_close": "2026-10-23T15:45:00Z", "ohlc": [763.0, 763.47, 761.94, 762.2] } ],
  "fires": [ { "signal_id": 41, "strategy_name": "ORB 15m", "bar_time": "2026-10-23T13:45:00Z" } ]
}
```

`patterns` keys match the snapshot's `patterns.occurrences` (`bar_start_et` and `bar_close_et` become UTC); computed on stored closed bars by
`core/patterns.py` for the symbol and range, only for patterns in her attached strategies plus none by default (the Indicators menu can ask
`&all_patterns=true`). `fires` come from `signals` joined to her strategies.

`GET /signals` adds `strategy_id`, `strategy_name`, `kind` and the `since` filter already exists; the bottom `Signals` tab and the dashboard feed use it.

`GET /quotes/{symbol}` (SSE) event data gains `"freshness"`, `"source"`, `"session"` beside the existing `symbol, close, quality, as_of`. One symbol per
connection stays; the frontend `lib/stream.ts` already multiplexes subscribers per symbol.

#### a3.4 Screener and filters (D5, D6)

`GET /screener/filters`:

```json
[ { "id": 3, "name": "Abnormal volume", "origin": "seed", "seed_key": "abnormal-volume", "read_only": true,
    "run_on": "bar_close_15m", "session": "regular",
    "last_run": { "evaluation_point": "2026-10-23T19:45:00Z", "matches_total": 9, "scanned": 131, "stamp": { "…": "…" } } } ]
```

Order: the ten seeds (read-only, lock glyph) in catalog order, then hers by name. `POST /screener/filters` body is either
`{ "copy_of": 3 }` (copy a seed or her own into an editable filter named "<name> (copy)") or `{ "spec": FilterStrategySpecV1 }`.
`GET /screener/filters/{id}` returns `{ id, name, origin, read_only, version, spec, default_spec | null, stamp }`; `default_spec` is the
seed template a copy came from (D6 "Reset to default"). `PUT` body `{ "spec": FilterStrategySpecV1, "change_note": null }` makes a new version (422
with `problems` when the spec is invalid or the filter is read-only, `409` for a seed). `DELETE` archives her filter; seeds return 409.

`GET /screener/filters/{id}/results?session=` is the snapshot's `screeners[id]` plus `stamp`, `table_columns`, and typed rows:

```json
{
  "filter_id": 3, "name": "Abnormal volume", "run_on": "bar_close_15m", "session": "regular",
  "rank": { "by": { "series": "rvol", "lookbackDays": 10 }, "order": "desc" },
  "liquidity": { "minPrice": 5, "minAvgVolume": 500000 },
  "evaluation_point": "2026-10-23T19:45:00Z", "scanned": 131, "no_data_on_eval_day": 0, "matches_total": 9, "matches_returned": 9,
  "stamp": { "as_of": "…", "source": "alpaca", "quality": "delayed-15m", "freshness": "closed" },
  "table_columns": [ { "key": "last", "label": "Last", "format": "price" }, { "key": "change_pct", "label": "Change %", "format": "pct_signed" },
                     { "key": "volume", "label": "Volume", "format": "compact" }, { "key": "rvol_10d", "label": "RVOL", "format": "ratio" } ],
  "matches": [ { "symbol": "BOLT", "matched_since": "2026-10-23T18:00:00Z", "rank_value": 472.72, "operands": { "rvol(10)": 472.72 },
                 "columns": { "last": 6.27, "prev_close": 4.19, "change_pct": 49.642, "volume": 12883312.0, "rvol_10d": 461.779,
                              "atr_pct_14": 9.2672, "rsi_14": 79.7286, "gap_pct_open": 66.587, "vs_vwap_pct": -9.939 } } ]
}
```

`columns` carries every metric in the shared set; `table_columns` (built server-side by `screener/columns.py`) lists the ones this
filter shows, in order: the fixed block `last, change_pct, volume, rvol_10d, atr_pct_14, gap_pct_open, rsi_14, vs_vwap_pct`, then
`matched_since`, with the filter's `when` operands and `rank.by` series added or promoted (02l D5: "columns follow the filter's `when`
operands and `rank.by`"). The frontend never maps operands to columns. `evaluation_point` and `matched_since` replace the snapshot's
`"2026-10-23 15:45"` strings (the mocks' `evaluation_point`/`matched_since` are ET text).

`POST /screener/preview` body `{ "spec": FilterStrategySpecV1 }` returns `{ "problems": [], "matches_total": 9, "scanned": 131, "top": [ {symbol, rank_value} ×5 ] }`. It
evaluates the unsaved spec over the stored universe and metrics (never a provider call), capped at 2 s; over budget it returns `problems: []`, `matches_total: null`
and the form shows "Preview unavailable · Save to run". The editor calls it debounced (500 ms).

`GET /screener/universe` returns the snapshot's `screener.universe` minus the failure map:

```json
{ "scan_basis": "seed lists + market strip + Alpaca screener most-actives and movers", "candidates": 245, "scanned": 131,
  "dropped_non_plain_tickers": 4, "no_daily_data": 5, "liquidity_floor": { "minPrice": 5, "minAvgVolume": 500000, "avgVolumeDays": 20 },
  "stamp": { "…": "…" } }
```

The D5 line "Scanned 131 US stocks and ETFs · as of last close Fri 2026-10-23" is `scanned` plus `stamp.as_of`. The universe is **not** the full US equity
list (02l §c1 and the snapshot's `universe_basis`); the line says "US stocks and ETFs" only because that is what 02l D5 specifies and
because `/screener/universe.scan_basis` states the basis in a `Details` disclosure.

#### a3.5 Watchlists (D7)

Existing create, items, and delete shapes are unchanged (`WatchlistOut {id, name, horizon}`, `WatchlistItemReadOut {symbol, asset_type, backfill}`).
New: `PATCH /watchlists/{id}` body `{ "name": "Day movers" }` (same 1–80 char NFKC normalisation as create; 409 if she already has that name, because
`watch.universe.watchlist` references lists by name); `PUT /watchlists/{id}/order` body `{ "symbols": ["NVDA", "AMD"] }` (must be a permutation of the current items, else 422);
`DELETE /watchlists/{id}` (204; blocked with 409 and a plain message while an attached alert strategy references the list by name).

`GET /watchlists/{id}/table`:

```json
{ "watchlist": { "id": 1, "name": "Day movers", "horizon": "intraday" },
  "stamp": { "…": "…" },
  "rows": [ { "symbol": "NVDA", "name": "NVIDIA Corp", "asset_type": "stock",
              "last": 210.9975, "change_pct": -1.1, "rvol_10d": 0.98, "vs_vwap_pct": -0.2, "bias_label": "Sell", "freshness": "closed",
              "tags": [ { "kind": "pattern", "label": "Hammer 15m", "at": "2026-10-23T14:15:00Z" }, { "kind": "armed", "label": "ORB armed" } ] } ] }
```

Row order is the stored `position`. `bias_label` is the 15m summary label (the default technical view) or `"warming up"`. `tags` come from today's
`signals` (kind `pattern`, with the time) and from attached strategies that have not fired yet (kind `armed`). The right rail "Strategies on Day movers" is
`GET /alert-strategies?watchlist_id=1`.

#### a3.6 Strategy library (D8)

`GET /library?category=&q=&kind=strategy` returns catalog entries exactly as `PresetCatalogV1` (`id, file, kind, lane, category, bias, label, summary`) plus
`attachable: boolean` and `attach_blocked_reason: string | null`. The default is `kind=strategy` and `lane=technical` (the 37 non-filter technical entries; the
ten filters live in the screener). Entries in category `futures` return `attachable: false` with the reason "Futures alerts start when IBKR quotes connect" until the IBKR slot is live.
`GET /library/{id}` adds `spec` (the template JSON, a `StrategySpecV1`), `defaults` (its limits, severity, channels), and `example`, a real occurrence found on stored bars
of her watchlist symbols in the last 10 sessions: `{ "symbol": "SPY", "timeframe": "15m", "bar_time": "…", "ohlc": [..] }`, or `null` (the mock then
shows a drawn example labelled SIMULATED; production just hides the block).

`POST /library/{id}/attach` body `{ "watchlist_id": 1, "channels": ["inbox"], "severity": "opportunity" }` copies the template, sets `watch.universe = { "watchlist": "<name>" }`, writes a
`strategies` row (`lane` technical, `origin` library) with its first version, and sets stage `alert_only` when `alerts_runtime_enabled` is on, else `draft`. It is
idempotent per (preset, watchlist): a repeat returns `200` with the existing strategy; a new one `201`. Response is `AlertStrategyOut` (§a3.7). Filter-kind entries return 422
("Copy this preset to My filters instead"). The strategy never carries `paperOrder`: attach uses `AlertStrategySpecV1` validation.

#### a3.7 Alert strategies, inbox and log (D9, D10)

`AlertStrategyOut`:

```json
{ "id": 12, "name": "ORB 15m", "origin": "seed|library|user", "stage": "draft|alert_only", "status": "active|paused|expired|draft",
  "paused_reason": null, "version": 2,
  "source": { "kind": "symbol|watchlist|filter", "id": 1, "label": "Day movers" },
  "category": "pattern|indicator|level|screener",
  "run_on": "bar_close_15m", "frequency": "once|once_per_bar|every_time", "cooldown_minutes": 30, "expires_on": null,
  "channels": ["inbox", "telegram"], "severity": "opportunity",
  "last_fired_at": "2026-10-23T14:15:00Z", "fires_7d": 3,
  "spec": { "…": "AlertStrategySpecV1" } }
```

`status` is derived: `draft` (stage draft), `expired` (`expires_on` passed), `paused` (`paused_reason` set, including pause-all), else `active`. `category` is derived by `alerts/describe.py`
from the spec's `when` (a `pattern` condition is `pattern`; a level operand is `level`; a `watch.universe.filter` source is `screener`; else `indicator`). The plain-English trigger summary is **not** returned: the frontend
`describeSpec` builds it (02l §e4), extended to accept filter specs.

- `GET /alert-strategies?status=&category=&symbol=&watchlist_id=&sort=` where `sort` is `name|last_fired|status`. Excludes archived.
- `POST /alert-strategies` body `{ "spec": AlertStrategySpecV1, "save_as": "draft" | "on" }`; `"on"` is rejected with 409 "Alerts start when live quotes are connected" until
  `alerts_runtime_enabled`. Validates with the existing Pydantic `AlertStrategySpecV1` plus the engine gate (02k §10: unsupported operands cannot be saved); `422` with `problems`.
- `POST /alert-strategies/validate` body `{ "spec": AlertStrategySpecV1 }` returns `{ "problems": [...], "resolved_symbols": ["NVDA", "AMD"], "run_on": "bar_close_15m" }`. D10's summary pane and mini chart use `resolved_symbols[0]`
  and the `/bars` and `/technicals` reads; the plain summary itself is frontend.
- `PUT /alert-strategies/{id}` body `{ "spec": …, "change_note": null }` creates the next version (the existing `strategy_versions` flow).
- `DELETE` archives (`strategies.archived_at`); the strategy and its signal history remain (the `RESTRICT` constraints stay).
- `POST .../pause` body `{ "reason": "user" }` sets `paused_reason`; `POST .../resume` clears it, and also moves `draft` to `alert_only` (the `Turn on` control) when the runtime flag is on.
- `GET /alert-strategies/{id}/fires?limit=10` returns
  `[ { "signal_id": 41, "symbol": "NVDA", "bar_time": "…", "evidence": { }, "deliveries": [ { "channel": "inbox", "status": "delivered" } ],
  "thumb": { "interval": "15m", "bars": [ {t,o,h,l,c,v} ×40 ] } } ]`; the thumbnail is a small `lightweight-charts` area in the browser, not a server image.

`GET /alerts` keeps `AlertOut` and adds `symbol`, `strategy_id`, `strategy_name`; params `unread`, `symbol`, `strategy_id`, `limit`, `offset`. `POST /alerts/read-all` returns `{ "marked": 3 }`.

`GET /alerts/log?limit=&offset=&status=&symbol=`:

```json
[ { "delivery_id": 90, "alert_id": 55, "created_at": "…", "symbol": "NVDA", "strategy_id": 12, "strategy_name": "ORB 15m",
    "channel": "telegram", "status": "delivered|held_quiet_hours|no_channel|failed", "detail": "Held until 7:00 AM ET" } ]
```

Mapping from `deliveries.status`: `sent` → `delivered`; `skipped_quiet_hours` → `held_quiet_hours`; `skipped_preferences` and a `pending` row whose channel is not wired → `no_channel`; `failed` → `failed`.
`detail` is plain wording; redaction (`notify/redact.py`) applies before anything leaves the API.

#### a3.8 Settings (D11)

`GET /settings/channels`: `[ { "channel": "inbox", "connected": true, "locked": true }, { "channel": "telegram", "connected": false, "configured": true },
{ "channel": "slack", "connected": false, "configured": false } ]`. `configured` means the owner stored the channel's key in Firestore `family-config` (read once at startup, never
returned); `connected` means for her: Telegram has a chat id linked, Slack is on in her channel list and the shared hook exists. `PUT /settings/channels/telegram` body
`{ "chat_id": "…" }` (stored in `users.telegram_chat_id`; 422 on non-numeric). `POST /settings/channels/{channel}/test` sends "Test from Family Desk" through the stub or the real channel and returns
`{ "status": "sent" | "not_connected" | "failed" }`; the 3-attempt retry rules of `notify/dispatch.py` apply and nothing secret is echoed.

#### a3.9 Settings keys

`settings` (jsonb on `users`) gains validated keys; unknown keys are still accepted as today. `default_view`: `"technical" | "fundamental"` (default `technical`); `pause_all`: boolean (the
runtime skips her strategies while true; `/status.alerts.state` becomes `paused_by_user`); existing `quiet_hours {start,end}` and `channels` are unchanged. The market-data rows in D11 read `/status`;
broker rows are static disabled UI with the orders-off reason (no API).

### a4. Snapshot to API map (the frontend is a port of the mock content)

| Snapshot (`snapshot-2026-10-23.json`) | API field | Note |
|---|---|---|
| `as_of`, `generated_at_utc`, `source` | every `stamp` | ISO UTC; display string built in `lib/desk/format.ts` |
| `market_strip`, `day_movers`, `swing` (symbol lists) | `dashboard.market_strip`, `watchlists/{id}/table`, the seeded watchlists | lists become real rows; Day movers and Swing are seeded watchlists (§b6) |
| `symbols[s].timeframes[tf].technicals` | `GET /technicals/{s}?timeframe=tf` (existing `TechnicalsOut`) | identical shape; the snapshot ran the same `core` code |
| `…[tf].indicators` | `technicals.indicators` | last-value map |
| `…[tf].bias_history` | `technicals.bias_history` | bar strings become UTC |
| `…[tf].bars_used, first_bar, last_bar, quality, bias_ready` | `technicals.bars_used, first_bar, last_bar, stamp.quality, bias_ready` | |
| `symbols[s].bars[tf] {columns, rows}` | `GET /bars/{s}?interval=tf` | rows become `BarOut` objects; `5m_extended_friday` = `session=extended` |
| `screener.universe` | `GET /screener/universe` | |
| `screener.metrics[s]` | `matches[].columns` and `watchlist table rows` (same keys) | stored in `symbol_metrics` |
| `screener.screeners[id]` | `GET /screener/filters/{id}/results` | `matches[].columns` as snapshot; adds `table_columns`, `stamp` |
| `alert_replay[id]` | `GET /alert-strategies`, `…/{id}/fires` | mock-only caption "Replay of Fri 2026-10-23" disappears in production |
| `patterns.occurrences[]` | `GET /charts/{s}/markers` `patterns[]` | `bar_start_et` → `bar_start` (UTC) |
| `patterns.geometry` | `core/patterns.py` constants | geometry is recorded in the snapshot as the script's own thresholds (02l §c1); S fixes the geometry in code with golden tests (§d3) |

To keep the port mechanical, stream S commits a trimmed fixture, `backend/tests/fixtures/desk-mvp/` (three symbols: SPY, NVDA, MSFT; 1d, 15m, 5m; the
screener rows for those symbols; no provider payload beyond the tiny set the repo already ships under `tests/fixtures/alpaca/`). The same
files back S's contract tests and F's loader tests (`frontend/lib/fixtures/desk-mvp/`, copied by a script, not hand-edited).

## b. Backend service module map

All new code lives under `backend/src/ai_trading/`. Existing modules named here are reused, not rewritten.

### b1. Module map

| Module | New or extended | Responsibility | Depends on | Tests |
|---|---|---|---|---|
| `core/freshness.py` | new | pure `freshness(quality, session, last_ok_at, now, interval)`: `live` (IBKR quote under 5 s old), `delayed` (delayed SIP), `closed` (session closed), `paused` (no update past `max(120 s, 2 × bar interval)`), `unavailable` (feed down) | `core/calendar.py` | table-driven unit test over every row of 02l §c3 |
| `core/patterns.py` | new | fixed-geometry candlestick detectors for the 20 pattern ids, with `trend` rule and `withinBars` (02l §e2 item 4) | `contracts/strategy_spec_v1.py` | golden tests on recorded bars (snapshot occurrences as oracle) |
| `core/levels.py` | new (small) | `session_high`, `session_low`, `prior_close` (02l §e2 item 5) | `core/calendar.py` | unit |
| `data/universe.py` | new | builds the screener universe: seed lists (Day movers, Swing, market strip) + registry `universe` kind (most-actives by volume and trades, top movers); symbol filter; writes `universe_symbols` | 02j registry | fake `UniverseSource`; drops warrants and non-plain tickers |
| `data/metrics.py` | new | computes the shared metric row per symbol from stored bars; writes `symbol_metrics` | `core/indicators.py`, `data/bars.py` | metrics golden vs snapshot rows (AAPL) |
| `data/refresher.py` | new (wraps `jobs/refresh_15m.py`) | the market-data refresher: for watchlist symbols fetch 1m bars through `DataSources.bars` (Alpaca, delayed 15 min), `upsert_bars`, then recompute metrics; records `feed_health` after each pass | 02j registry, `data/bars.py`, `data/slots.py` | existing `test_refresh_15m` plus feed-health cases |
| `screener/evaluator.py` | new | evaluate a `FilterStrategySpecV1` over the stored universe at the last closed bar; reuses `core/evaluate.py` operand and level code (same `ConditionSchema`); computes `matched_since` as the start of the unbroken true run | `core/evaluate.py`, `data/metrics.py` | golden: the snapshot's ten screeners over the trimmed fixture; liquidity floor; extended session |
| `screener/columns.py` | new | `table_columns` from `when` operands and `rank.by` (§a3.4) | contracts | unit |
| `screener/runner.py` | new | runs each active filter on its `runOn`: writes `filter_runs` and `filter_matches` idempotently (unique per version and evaluation point) | evaluator, scheduler | catch-up safe: re-run writes nothing new |
| `screener/service.py` | new | filter CRUD: seed copy, versions, archive, preview (2 s budget) | models | CRUD, ownership, seed read-only |
| `library/catalog.py` | new | loads `catalog.json` and templates, validates with the existing Pydantic contracts, computes `attachable`; finds the real `example` | `contracts/` | catalog test already locks the files; add attach tests |
| `library/attach.py` | new | writes the alert-only strategy for a preset and watchlist (idempotent) | `library/catalog.py`, `alerts/service.py` | idempotency, futures blocked |
| `alerts/service.py` | new | alert-strategy CRUD on top of `strategies` and `strategy_versions`: create, edit, pause, resume, archive, derived `status` and `category` | models, `engine/outbox.py` | CRUD, ownership, gate |
| `alerts/universe.py` | new | resolves a strategy's source to symbols: symbol, watchlist by name, or a filter's last matches (02k "filter universe resolution") | `screener/*` | unit |
| `alerts/runtime.py` | new (extends `engine/tick.py`) | the evaluation loop's rules (§b5): staleness guard, frequency, cooldown, expiry, message, pause-all, source resolution | `engine/tick.py`, `engine/outbox.py`, `core/freshness.py` | §d3 |
| `strategies/votes.py` | new | the "Her strategies" gauge | `alerts/service.py`, `core/evaluate.py`, `core/bias.py` | unit |
| `notify/*` | extended | log fields for the D9 log; `no_channel` handling; real `Telegram`/`Slack` wired from config, else `NotConfigured` stub that reports `no_channel` (stubs ship first, real channels once keys exist) | existing | existing `tests/notify`, plus log mapping |
| `api/dashboard.py`, `api/screener.py`, `api/library.py`, `api/alert_strategies.py`, `api/charts.py` (markers), `api/symbols.py` | new | thin routers; models and handlers per §a3 | services above | §d3 |
| `api/status.py`, `api/watchlists.py`, `api/technicals.py`, `api/bars.py`, `api/quotes.py`, `api/signals.py`, `api/alerts.py`, `api/settings.py` | extended | additive fields, params, and routes of §a2 | | existing tests plus new cases |
| `jobs/premarket.py`, `jobs/daily_close.py`, `jobs/weekly.py`, `jobs/refresh_15m.py` | extended | run `universe`, `metrics`, then `screener.runner` for filters with the matching `runOn`; 15-minute job also runs `bar_close_5m|15m|1h` filters | `jobs/scheduler.py` | existing `tests/jobs` plus runner hooks |
| `cli/seed_technical.py` (`python -m ai_trading.cli.seed_technical`) | new | idempotent seed for one user (§b6); not a migration | models | idempotency |

### b2. Database migrations (extend the existing schema)

One new Alembic revision, `0003_technical_mvp`, on top of `0001` and `0002`. It is additive; no table is rewritten; `downgrade()` reverses it.

| Change | Detail |
|---|---|
| `strategies` | add `lane text not null default 'technical'` (`technical|fundamental`), `origin text not null default 'user'` (`user|seed|library|ai`), `archived_at timestamptz null` |
| `watchlists` | unique `(user_id, name)` (the migration first renames existing duplicates with a numeric suffix) |
| `watchlist_items` | add `position integer not null default 0`; backfill by symbol order |
| `filter_strategies` | `id`, `owner_user_id` FK `users` (cascade), `name`, `origin` (`seed|user`), `seed_key` null, `current_version_id` (no FK, like `strategies`), `archived_at`, `created_at`; unique `(owner_user_id, name)` where not archived |
| `filter_strategy_versions` | `id`, `filter_strategy_id` FK (restrict), `version`, `schema_version`, `spec jsonb`, `change_note`, `created_by`, `created_at`; unique `(filter_strategy_id, version)` |
| `filter_runs` | `id`, `filter_strategy_version_id` FK, `run_on`, `session`, `evaluation_point timestamptz`, `scanned`, `no_data`, `matches_total`, `source`, `quality`, `created_at`; unique `(filter_strategy_version_id, run_on, session, evaluation_point)` |
| `filter_matches` | `run_id` FK (cascade), `symbol`, `rank int`, `rank_value float`, `matched_since timestamptz`, `operands jsonb`, `columns jsonb`; PK `(run_id, symbol)`; index `(run_id, rank)` |
| `universe_symbols` | `symbol` PK, `name`, `asset_type` (`stock|etf`), `exchange`, `active bool`, `passed_floor bool`, `floor_reason jsonb null`, `updated_at` |
| `symbol_metrics` | `symbol` PK, `as_of timestamptz`, `source`, `quality`, `metrics jsonb` (the shared metric keys, §a1); index `as_of` |
| `feed_health` | `feed text` PK (`bars_delayed|quotes_live|scan`), `state` (`ok|degraded|down`), `last_ok_at`, `detail text null`, `updated_at`; the scheduler writes it, the API reads it (they are separate compose services, so state cannot live in memory) |
| `alerts` | add `symbol text null` and `strategy_id int null` FK `strategies`, index both (the inbox, "Alerts on this stock", and the log filter without a three-hop join) |

Not added, on purpose: no per-(strategy, symbol) cooldown table (cooldown, `once`, and `once_per_bar` derive from `signals`, whose unique key already encodes the bar),
no `deliveries` column (the status mapping in §a3.7 is enough), no stored market-session row (computed from `core/calendar.py`), no replay flag on `signals`.

Also required, in the same pull request: grants for the new tables to the runtime role in `docker/postgres/zz-20-desk-roles.sh` and `tests/test_db_roles.py`; updates to
`tests/test_db_migrations.py` and `tests/test_db_phase3_tables.py`; `scripts/generate-contracts.sh` unchanged. ORM models in `db/models.py` mirror the migration.

### b3. Cadences, freshness, and the refresher

- **Delayed now.** Alpaca Basic's SIP bars are 15 minutes delayed. Everything the refresher and scans store is labelled `quality: "delayed-15m"`; `core/freshness.py` turns that plus the calendar into `delayed`
  (in session) or `closed`. Scan feed decision 1 of 02l §e1 (SIP bars, "Scan delayed 15 min") is the default; the IEX real-time feed is not used for scans.
- **Honest cadence.** With delayed SIP data the finest real update is every 15 minutes. A `bar_close_5m` filter runs on each refresh against the latest closed 5-minute bar and carries `freshness: "delayed"`. A
  `bar_close_1m` alert strategy on delayed data evaluates at the same cadence; it is promoted to true 1-minute evaluation only when the IBKR slot supplies live bars (§b4).
- **Jobs (scheduler service, existing `JobClock` and `JobResult` pattern):** `premarket_0830` (universe refresh, premarket filters, then `tick`), `refresh_15m` (watchlist bars, metrics, intraday filters, `tick`), `daily_close` (daily bars for
  the universe survivors, metrics, daily filters), `weekly`. Each job is idempotent and catch-up-safe, as `tests/jobs` requires. `feed_health` is written by `refresher` after every pass; `watchdog` marks `down` when `last_ok_at` is older than 2 passes.
- **Provider load.** The universe pass batches multi-symbol daily bars through the throttled client in `ai_trading_common.http`; the plan target is the snapshot's budget (131 symbols over one pass) well inside Alpaca Basic limits. Chart reads for a symbol outside the
  watchlists call the registry on demand through `get_market_bars` (existing behaviour) behind a 60-second in-process cache.

### b4. Provider registry additions (02j addendum, `ai-trading/common`)

The only common-code changes. Each is one adapter method plus one registry line, with no caller edits (02j §1).

1. **`universe` kind** (`UniverseSource`: `assets()`, `most_actives(by: "volume" | "trades", top)`, `movers(top)`), default chain `alpaca`. The snapshot proved the registry had no universe call (02l §c1); Alpaca's assets, most-actives, and
   movers endpoints back it. Result types carry `provider` and `quality` like every 02j type. Needed for the screener universe and `/symbols/search`.
2. **`quotes` kind** (`QuoteSource.latest(symbols, *, now)` returning `Quote(symbol, price, as_of, provider, quality)`), default chain `alpaca` (latest delayed bar), later `ibkr,alpaca`.
3. **IBKR slot, after the Monday 2026-10-26 09:30 ET probe (02e).** If the probe passes: add `providers/ibkr.py` (`ib_async`), register it, and set `DATA_PROVIDERS_BARS=ibkr,alpaca` and `DATA_PROVIDERS_QUOTES=ibkr,alpaca` in the Desk's Firestore profile (02j §8 steps,
   no code change in the Desk). The slot allocator (`data/slots.py`, 70-line cap in `/status`) takes demands `intraday_strategy` (watchlist symbols), `open_chart` (symbols with an open SSE connection, written to a small `slot_demands` table by the API
   process at that time, with a 30-second expiry), and `covered_call_scan` is unused in the MVP. If the probe fails or is late: nothing in this spec changes; quotes stay `delayed`/`closed` and the product ships delayed. **Until then:** `/status.gateway` is `not_configured`, ES and NQ are `unavailable`, and the live-evaluation
   promotion in §b3 does not happen. Gateway sign-in stays a human step on the owner's phone.

### b5. Alert runtime rules (extends `engine/tick.py`, `engine/outbox.py`, `notify/dispatch.py`)

The existing app loops (`api/app.py`) keep calling `tick` and `dispatch`; this spec adds rules inside them, so there is no new process.

1. **Never alert on stale data.** Before evaluating a symbol, require `feed_health` `bars_delayed` (or `quotes_live`) `ok` and the symbol's last closed bar not older than `max(120 s, 2 × interval)` plus the 15-minute provider delay when the quality is `delayed-15m`.
   Otherwise skip the symbol, and if every live symbol is stale, set `/status.alerts.state = paused_no_quotes`. Resume automatically when data returns; no catch-up burst for missed bars older than one bar.
2. **Sources:** a symbol, a watchlist by name (current items), or a filter's last-run matches (`alerts/universe.py`); a filter source evaluates only when its last run is fresh.
3. **Frequency:** `once` (no earlier signal for this strategy and symbol, across versions), `once_per_bar` (the existing unique key), `every_time` (still limited by cooldown). `limits.cooldownMinutes` compares against the latest signal `bar_time` per (strategy, symbol), across versions.
   `expiresOn` (New York date) stops evaluation the day after.
4. **Message:** render `{symbol} {close} {time}` (time in ET, `h:mm AM/PM`) into `alerts.body`; severity from the spec; `alerts.symbol` and `strategy_id` set.
5. **Delivery:** Inbox first, always (an `inbox` delivery row is written for every alert); other channels follow the user's `channels` setting; quiet hours hold the delivery (`skipped_quiet_hours`) and the log shows it; a channel with no wired implementation writes `no_channel`. Fingerprint dedupe and 3 retries stay as shipped.
6. **Pause:** `strategies.paused_reason` or `settings.pause_all` stops evaluation; `stage = draft` never evaluates; `alerts_runtime_enabled` (an env flag read once at startup, off by default) gates moving strategies to `alert_only`. With it off, `Turn on` answers 409 and the UI disables it
   ("Alerts start when live quotes are connected"). Flipping it on is a Hermes release step, not a code change.
7. **Orders:** nothing in this runtime imports order code; `paperOrder` is rejected by the alert contract and by a route-level test (§d3).

### b6. Seed data (`cli/seed_technical.py`, idempotent per user)

- Watchlists **Day movers** (`intraday`: NVDA, AMD, TSLA, PLTR, META, AAPL, AVGO, COIN) and **Swing** (`swing`: MSFT, AMZN, GOOGL, CRWD, SHOP, UBER).
- The ten filters in `contracts/templates/filters/*.json` as `filter_strategies` with `origin: seed` (read-only), plus a first `filter_strategy_versions` row each.
- Her starting alert strategies (02l §e3), alert-only on Day movers, created as `draft` and left off until the runtime flag is on: ORB 15m, VWAP reclaim, Hammer 15m near S1, Abnormal volume, High-of-day break (templates in `contracts/templates/`).
- The contracts and templates must be reachable at runtime. The backend image copies only `common/` and `packages/family-desk/backend` today (`backend/Dockerfile`), so the Dockerfile and the CI image build also copy
  `packages/family-desk/contracts/catalog.json` and `…/templates/`. This is a hard integration requirement (§d2 step 1).

## c. Frontend route and component map

### c1. Routes, shell, and breakpoints

- **Routes (static export, query parameters for ids).** Keep every existing route. Add `app/screener/page.tsx` (D5), `app/screener/filters/page.tsx` (`?id=`, D6), `app/strategies/library/page.tsx` (D8), `app/alerts/page.tsx` (D9), `app/alerts/new/page.tsx` (D10; prefill with `?source=symbol:NVDA` or `?from=filter:3`), `app/today/page.tsx`
  (D2 alias: `/` stays the canonical Today route and nav target; `/today` renders the same screen). `/technicals?symbol=NVDA` hosts D3 and D4 with `#chart` and `#summary` (default `#chart`); `/watchlists` (D7), `/settings` and `/more` (D11) are extended in place.
- **Desktop shell above 1100 px, existing mobile shell below.** `components/shell/Shell.tsx` renders the new `DesktopShell` when `window.innerWidth >= 1100` and today's mobile tab shell otherwise, so the 15 accepted routes keep working on phones and nothing mobile is
  built. Two bands inside the desktop shell: **1440** (`>= 1440 px`, full: 280 / 1fr / 320, 48 px top bar, 24 px status bar) and **1180** (`1100–1439 px`, 02l §b3: 240 px left rail, right rail collapsed to a 40 px strip with a 320 px overlay drawer,
  freed width to the chart, columns dropped by priority). Implemented with CSS grid and two media queries in `globals.css`, plus a `useShellBand()` hook returning `"1440" | "1180"` for components that drop columns.
- **Primary nav (Technical lane):** Today, Screener, Watchlists, Alerts, Strategies; Settings and More under the avatar menu. `lib/lanes.ts` maps every route to a lane; `/holdings`, `/covered-calls`, `/stocks` (fundamental) and `/paper`, `/backtests`, `/ask` (not in the MVP)
  show the wrong-lane interstitial "This screen belongs to the Fundamental view · Switch view" in the Technical lane, with a link through. No order control renders anywhere: `OrdersOffNotice` stands where one would be.

### c2. Board to component map

All new components are under `frontend/components/`. "Data" lists the loaders in `lib/desk/` (§c4); "States" are the 02l §d1 states, each a visible, tested branch.

| Board | Route | Components (new unless marked existing) | Data | States and 1180 behaviour |
|---|---|---|---|---|
| **D1** Shell and states | none (layout) | `shell/desktop/DesktopShell`, `TopBar`, `LaneSwitch`, `PrimaryNav`, `SymbolSearch` (`⌘K`), `MarketStatusPill`, `FreshnessBadge`, `AlertsBell`, `LeftRail` (`WatchlistsPanel`, `FiltersPanel`), `RightRail` and `RightRailDrawer`, `StatusBar`, `WrongLaneInterstitial`, `OrdersOffNotice` | `/status`, `/watchlists`, `/screener/filters`, `/symbols/search`, `/alerts` (unread) | all of §c3: `FreshnessBadge` takes `stamp`+`session`+connection state and renders the 02l §c3 copy from one table in `lib/desk/freshness.ts`; the 1180 band collapses the right rail to the strip and search to an icon |
| **D2** Dashboard | `/`, `/today` | `dashboard/DashboardScreen`, `MarketStrip`, `SignalsPanel`, `ScreenerMatchCards`, `WatchlistHeat` (`DenseTable`), `EventsPanel`, `EmptyDay` | `/dashboard` (refetch 60 s; manual refresh) | closed, pre-market, live, reconnecting, empty day; 1180 drops `vs_vwap_pct` then `rvol_10d` |
| **D3** Chart workspace | `/technicals?symbol=…#chart` | `workspace/ChartWorkspace`, `SymbolHeader`, `ChartToolbar` (timeframe `1m 5m 15m 1h 4h 1D 1W`, `Regular|Extended`, `Indicators` menu, `+ Alert` linking `/alerts/new?source=symbol:…`), `WorkspaceChart` (wraps existing `charts/MarketChart`), `ChartLegend`, `BottomPanel` (`Technicals · Signals · Levels`), `RightRailSummary`, `AlertsOnStock`, `StrategyMatches`, `KeyLevels` | `/bars`, `/technicals`, `/quotes` (SSE), `/charts/…/markers`, `/signals?symbol=`, `/alert-strategies?symbol=` | loading skeleton, load error ("Couldn't load this chart · Try again"), reconnecting (dimmed last price), extended shading; 1180: right rail is the drawer with `Summary · Alerts · Levels` tabs |
| **D4** Technical summary | `/technicals?symbol=…#summary` | existing `technicals/TechnicalsScreen`, `Gauges`, `IndicatorTables`; new `TimeframeTabs`, `StrategyVotesGauge`, `PivotsTable` (Classic, Fibonacci, Camarilla), `WhatChangedLine`, `SummaryFootnote` | `/technicals?timeframe=` (one fetch per tab) | "Not enough history for 1W yet" (`bias_ready: false`), updating, market closed; right rail keeps a mini `MarketChart` |
| **D5** Screener | `/screener` | `screener/ScreenerScreen`, `FilterHeader` (rule summary, `Regular|Extended`, `Edit`, `Save as my filter`, `Alert on this filter`), `ResultsTable` (`DenseTable`, columns from `table_columns`), `PreviewPane` (`MarketChart`, no panes), `UniverseLine`; left rail `FiltersPanel` | `/screener/filters`, `…/results`, `/screener/universe`, `/bars` for the preview | "Scanning US stocks…", 0 matches ("No matches right now · next scan …"), delayed; table scrolls horizontally with a sticky symbol column; 1180 drops `matched_since`, `atr_pct_14`, `volume` |
| **D6** Filter editor | `/screener/filters?id=` | `screener/editor/FilterEditor`, `UniverseFields`, `LiquidityFields`, `SessionRunOnFields`, `ConditionRows` (ALL/ANY), `RankFields`, `LiveMatches` (count plus top five), `JsonPanel` (`FilterStrategySpecV1`), `UnsavedBar` | `/screener/filters/{id}`, `PUT`, `/screener/preview` | read-only default with `Copy to edit`, validation error (plain message + muted field path from `problems`), unsaved-changes bar |
| **D7** Watchlists | `/watchlists` | existing `watchlists/AddSymbol`, `SlotMeter`; new `WatchlistDesktop`, `ListSwitcher` (left rail), `WatchlistTableDesktop` (`DenseTable`), `StrategiesOnList` (right rail, `Add preset` → D8), `ManageMode` (rename, reorder, add, remove) | `/watchlists`, `…/table`, `/alert-strategies?watchlist_id=` | empty ("Add symbols to start watching"), updating, reconnecting; 1180 drops `rvol_10d`, `bias_label` (mobile `FlipCard` stays mobile-only) |
| **D8** Strategy library | `/strategies/library` | `library/LibraryScreen`, `CategoryList`, `PresetList`, `PresetPreview` (plain English via `describeSpec`, the WHEN block, defaults, real example), `AttachButton` ("Attach to Day movers · alert only"), footnote "Pattern rules are fixed in v1" | `/library`, `/library/{id}`, `POST …/attach` | loading, empty search, catalog unavailable ("Strategy library unavailable · Try again"), futures presets disabled with the reason |
| **D9** Alerts | `/alerts` | `alerts/AlertsScreen`, `AlertFilters`, `AlertTable` (List), `AlertLog` (Log), `AlertDetailPane` (JSON, recent fires with `FireThumb`, `Pause`/`Resume`) | `/alert-strategies`, `…/fires`, `/alerts/log`, `/status` | empty ("No alert strategies yet · New alert strategy"), alerts paused banner ("Alerts paused until quotes return"); 1180 hides the detail pane behind a row-click drawer |
| **D10** Alert setup | `/alerts/new` | `alerts/setup/AlertSetupForm` (one scrolling column: `SourceStep`, `ConditionStep`, `TriggerStep`, `DeliverStep`), `SummaryPane` (plain English), `MiniChart`, `JsonPanel` (`AlertStrategySpecV1`) | `/alert-strategies/validate`, `POST`, `/settings/channels`, `/bars` | "1 problem to fix" banner, no channel connected, saved; `Turn on` disabled with "Alerts start when live quotes are connected" until the runtime flag is on; condition operators map the TradingView set to the contract plus "pattern detected" |
| **D11** Settings and More | `/settings`, `/more` | existing `settings/Channels`, `SourcesStatus`; new `DefaultView`, `QuietHours`, `PauseAll`, `MarketDataStatus`, `BrokerRowsDisabled` | `/settings`, `/settings/channels`, `/status` | channel not connected, saving, saved; market-data wording "Quotes: Alpaca · Delayed 15 min" from `/status` |
| **D12** 1180 boards | `/` and `/technicals` at 1180 | no new components; the §c1 media queries, `useShellBand`, `DenseTable` priorities, `RightRailDrawer` | as D2, D3 | collapsed right rail with one drawer open on D3; dropped columns on D2 |

### c3. Shared components

- **Chart workspace on lightweight-charts 5.2.0** (already pinned). Extend `charts/MarketChart.tsx` rather than forking it: it already supports `overlays`, `panes`, `levels`. Add, as optional props: `markers` (pattern labels below the bar, fired-alert bells above, via the library's `createSeriesMarkers`),
  `sessionShading` (extended-hours background from `bars[].ext`), `onCrosshair` (feeds `ChartLegend`, which renders `NVDA · 15m · O … H … L … C …` and one line per overlay), `lastPricePill` in the up/down colour, and amber alert `levels`. Defaults per 02l §b5: VWAP amber, EMA 9 text, EMA 21 muted dashed; RSI(14) and
  MACD(12,26,9) panes at 120 px with 30/70 bands; volume in the bottom 20% at 40% opacity. Time axis in ET. Mock only what the library renders (02l §b5).
- **Gauges.** Extend `technicals/Gauges.tsx` `BiasGauge` to the half-dial odometer at the large desktop size with the count line ("Buy 9 · Neutral 3 · Sell 2"), and reuse it for the fourth gauge; `role="img"` with an `aria-label` that states label and counts, never colour alone.
- **`ui/DenseTable.tsx`** (new): 28 px rows (24 px compact), tabular numbers, signed colour-plus-sign changes, amber left edge on the selected row, sortable headers, hover row actions reachable by keyboard, `columns[].priority` for 1180 dropping (the per-board orders in §c2), `stickyFirst` and `scrollX` for the screener only.
- **Copy table** `lib/desk/freshness.ts`: the single mapping from `stamp`, `session`, and client connection state to the 02l §c3 wording and the banned-term rule (a unit test greps the copy table for the banned list).
- **Spec describer:** extend `lib/spec/describe.ts` (`describeSpec(spec: StrategySpecV1)`) to also describe `FilterStrategySpecV1`; D5 header, D6, D8, D9, and D10 use it.
- **Tokens:** the existing R2+ black/amber set and Inter; no new colour (02l §b6). Controls at least 24 × 24 px, a 2 px amber focus ring, shortcut hints in tooltips.

### c4. Data layer

- `lib/api/schemas.ts` grows one zod schema per response in §a3, each `satisfies` the generated type, and `pnpm gen:api` regenerates `openapi.json`/`openapi.d.ts` from the backend (CI already diffs it). Loaders live in `lib/desk/<area>.ts`, one function per endpoint, using `createDeskApiClient`
  (it already rejects non-`/api/desk/` paths and redirects an unauthenticated user to the Hub login).
- A thin `useDeskQuery` hook (`lib/desk/useDeskQuery.ts`, state plus an interval refetch that keeps old values on screen, "Updating quotes…") replaces ad hoc effects. No new data library: the app has none and the surface is small. Refetch intervals: `/status` 30 s, `/dashboard`
  60 s, screener results and table reads 60 s, bars and technicals when the symbol or timeframe changes plus every 60 s while the market is open, SSE `/quotes` for the open symbol and the visible watchlist rows.
- Fixture loaders (`lib/fixtures/desk-mvp/`, §a4) feed unit tests only; the screens always call the API (the dev proxy `e2e/proxy.mjs` serves the seeded backend in E2E).

## d. Integration order and test plan

### d1. Ownership (to avoid colliding)

- **S owns:** everything under `backend/`, `common/` (§b4 only), `backend/Dockerfile`, `deploy/` changes the Dockerfile needs, and the first generated `lib/api/openapi.*` (regenerated by `pnpm gen:api`, committed by S in the stub step only; afterwards by whoever changes a model).
- **F owns:** everything under `frontend/` except `lib/api/openapi.*`.
- Shared and additive: this file and `STATUS.md` (small edits only). Neither stream edits the other's tree; a needed change in the other's area goes through this file.

### d2. Order

1. **S: foundations.** `0003_technical_mvp` plus models, role grants, and migration tests; `core/freshness.py`; Dockerfile copy of `contracts/`; seed CLI. Gate: backend test suite green with Postgres (`scripts/test-db.sh`).
2. **S: contract-first stubs (the unblock).** Pydantic response models and routers for every `N` and `X` endpoint of §a2 returning data from the trimmed fixture (`tests/fixtures/desk-mvp/`) behind a `DESK_MVP_STUB=1` setting that is off in every deployed
   environment; run `pnpm gen:api`, commit `openapi.*`. **F starts here** and never waits for real services.
3. **S (real services), in this order, each its own commits:** `core/levels.py` and `core/patterns.py`; `data/universe.py` and `data/metrics.py` and the registry `universe`/`quotes` kinds; `screener/*`; `watchlists` additions; `library/*`; `alerts/service.py`, `alerts/universe.py`,
   `strategies/votes.py`; `alerts/runtime.py` and notify changes; `data/refresher.py` and job hooks; `api/dashboard.py`; status and settings extensions. Real handlers replace stub branches; the stub setting is removed at the end.
4. **F, in parallel from step 2:** shell and `DenseTable`/`freshness` copy (D1, D12); chart workspace and technical summary (D3, D4, the template for everything); dashboard (D2); screener and editor (D5, D6); watchlists (D7); library, alerts, and alert setup (D8, D9, D10); settings (D11).
   Owner-approved mock order is the order: D1–D4 first.
5. **Integration:** F points at real services (stubs off); `e2e` suite (§d5); IBKR slot after the probe (§b4 item 3); the live-data acceptance of 02l §e5.

Each step is a stack of commits on the lane branch, pull requests only when a phase finishes (repository rule: conserve CI minutes): proposal is one pull request after step 2 plus F's D1–D4 (the first reviewable slice), one after the rest of S, one after the rest of F.

### d3. Backend tests (`pytest`, real Postgres via `scripts/test-db.sh`, same layout as `tests/`)

- **Contract:** each `N`/`X` response model validates the trimmed fixture; `openapi.json` is regenerated in CI (existing `git diff --exit-code -- lib/api` step) so a model change without a regenerated file fails.
- **Auth:** a parametrized test over `app.routes` asserts 401 without the identity header for every `/api/desk` route; ownership tests (user B gets 404) per resource family (watchlists, filters, alert strategies, alerts, library attach).
- **Core goldens:** `core/patterns.py` against the snapshot's recorded occurrences (fixture bars, expected pattern, bar, and trend rule); `core/levels.py`; `core/freshness.py` table.
- **Screener:** the snapshot's ten screeners over the trimmed fixture produce the recorded `matches`, `scanned`, and `matched_since` (the snapshot is the oracle); liquidity floor; `Extended` session; `table_columns` derivation; runner idempotency and catch-up; preview budget path.
- **Alerts and runtime:** frequency (`once`, `once_per_bar`, `every_time` with cooldown across versions); expiry; message rendering; stale data produces no signal and sets `paused_no_quotes`; recovery resumes with no burst; pause and `pause_all`; the delivery mapping in §a3.7; quiet hours holds; `no_channel`; inbox always first; seed strategies stay `draft` while the flag is off and `resume` returns 409.
- **Library:** every `kind: "strategy"` catalog entry attaches idempotently; futures entries blocked; filter entries rejected; attached specs pass `AlertStrategySpecV1` and never contain `paperOrder`.
- **Registry:** `universe` and `quotes` conformance, swap and fallback tests in `common` (02j §9 pattern); the Desk import-boundary test (`test_import_boundary.py`) still passes (the Desk never imports `ai_trading_common.providers`).
- **No orders:** a test lists every `/api/desk` route and asserts none contains `order`, `position`, or `broker`.
- Existing suites (`test_db_migrations`, `test_db_roles`, `tests/api`, `tests/jobs`, `tests/notify`, `tests/engine`, `tests/e2e`) stay green; new modules add ones beside them.

### d4. Frontend gates (the CI `desk-web` job, run by F before every push)

In `ai-trading/packages/family-desk/frontend`: `pnpm typecheck`, `pnpm lint`, `pnpm test` (node `--test` over `lib/**/*.test.ts`), `pnpm gen:api` then `git diff --exit-code -- lib/api`, `pnpm build`, `pnpm test:export`, and `../../../deploy/ci/check-static-export.sh out desk`.
The frontend has no component-test runner, so anything with logic goes into a `lib/` module with a node test: `lib/desk/freshness` (every §c3 state, banned-term check), `lib/desk/format` (ET formatting, signed percent, compact numbers), the loaders and zod schemas (parse the fixtures; reject a malformed payload), `lib/desk/columns` (priority drop per board per band), `lib/lanes`, the extended `describe.ts` (filter
specs), and `calcVWAP`. Every new route is covered by `export-layout.test.mjs` (static export contains the page).

### d5. E2E (after both streams reach step 5)

- **Backend side:** the existing `tests/e2e` harness (`seeded_source`, `clock`, `tick`, `safety`) gains a Technical seed (§b6 plus snapshot-derived bars) and runs the whole alert path against a frozen clock: seed strategy, delayed bar arrives, signal, inbox alert, log row, a quiet-hours hold, a stale-data pause, and the safety check that no order
  object is ever built.
- **Browser side (Playwright, existing `e2e/proxy.mjs` and `helpers.ts`):** add projects at 1440 × 900 and 1180 × 820; one spec per board family: shell and states, dashboard, chart workspace and summary (timeframe switch, gauges present, drawer at 1180), screener (select a row loads the preview; save as my filter), watchlists (add, reorder, remove), library attach, alert setup to saved (draft only), alerts list and log, settings
  (quiet hours, pause all). Every spec asserts the wording banned list is absent and that no order control exists.
- **Cloud and release:** not in this spec. Hermes orchestrates the deploy under its standing authorization; the Desk stays dark until the owner turns it on.
- **Acceptance before she trades from it (02l §e5, unchanged):** five symbols at a live session match IBKR TWS within a stated tolerance; one alert per seed strategy reaches her Telegram; a forced disconnect shows "Reconnecting…" and no alert fires on stale data.

## e. Explicit non-goals

- **Orders.** No endpoint, UI control, runtime path, or contract field that places, previews, or simulates an order, paper or live. `paperOrder` stays rejected in alert strategies; paper-trading screens and the broker rows stay out of the MVP (broker rows render disabled). IBKR is never given order permission.
- **Backtests.** No backtest endpoint, job, or screen; `core/backtest.py` is not exposed. Backtest boards stay illustrative.
- **Mobile and tablet.** No new mobile layout; the existing mobile shell and routes keep working below 1100 px and are not extended. No iPad breakpoint.
- **Fundamental lane screens**, the AI setup assistant (`draft_filter`, `StrategyDraft`), the custom strategy builder as a separate screen, and futures trading (sizer, position detail). ES and NQ are read-only tiles that read `unavailable` until the IBKR slot is live.
- **Real-time SIP scans or a full-market universe.** The MVP scans on delayed SIP bars over the seed-plus-movers universe and says so; a paid real-time plan or IBKR scanners are the upgrade path (02l §e1).
- **Provider field merging, plugin discovery, config hot-reload** (02j §10), websockets (SSE only), server-side chart images, drawing tools, sharing or multi-tenant features beyond the two existing users, and any push channel beyond inbox, Telegram, and Slack.
- **No activation.** Nothing here turns on the public Desk, IBKR, `alerts_runtime_enabled`, or the stub flag in a deployed environment.

## f. Decisions this spec makes (confirm or overrule; each is cheap to change before S or F reach it)

1. `/` stays the Today route; `/today` is an alias page.
2. The desktop shell takes over at 1100 px; below that the existing mobile shell is untouched.
3. Strategy votes use the cadence-match rule of §a3.3.
4. The library lists technical `kind: strategy` entries only; filters appear through the screener.
5. Chart series are computed in the browser from `/bars`; only the per-symbol last-value `indicators` and gauges come from the server. `calcVWAP` is added to the frontend indicators.
6. No per-user cooldown table: cooldown and `once` derive from `signals`.
7. The `universe` and `quotes` registry kinds are the only `ai-trading/common` changes.
8. A new `alerts_runtime_enabled` flag (off) gates `alert_only`, and seeds ship as `draft`.
