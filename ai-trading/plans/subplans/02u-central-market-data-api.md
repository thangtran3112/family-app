# 02u: Central Market-Data API: The Bridge as the One Door for Query and Sync

Status: **planner draft 2026-11-01 (docs only; nothing built, bought, or activated).** Written by Claude Code (planner) on `feature/market-data-landmark-plan`, off `origin/dev` at `be9f08da` (the 2026-11-01 `packages/` layout). Hermes rules on §7 before any stage starts. No STATUS row yet: Hermes assigns one.

Related: [02t](02t-market-data-bridge-plan.md) (the bridge rollout this plan extends: B0–B7, §11 rulings), [ADR-0003](../../decisions/adr/ADR-0003-bridge-architecture.md) (bridge architecture), [ADR-0004](../../decisions/adr/ADR-0004-adapter-pattern.md) (adapter pattern), [ADR-0010](../../decisions/adr/ADR-0010-data-honesty.md) (honest data states), [ADR-0011](../../decisions/adr/ADR-0011-packages-layout.md) (packages layout), [ADR-0001](../../decisions/adr/ADR-0001-provider-mix.md) / [ADR-0002](../../decisions/adr/ADR-0002-alpaca-deferral.md) (provider mix, Alpaca $99 deferral), [02j](02j-common-data-providers-design.md) §7 (registry rules), [02o](02o-desk-replay-practice-plan.md) (practice replay), [STATUS.md](../STATUS.md) rows 5T/5U.

## 0. Owner ask and binding constraints

**Ask (2026-11-01, near-verbatim):** centralize the market-data API (gRPC/streaming served by the market-data backend package) so Practice and Backtest can reuse it, so several apps share one backend even when the provider changes, and so the backend is the centerpiece that features query and sync data through. Proper API tests must exist or have a phase, at least for historical data.

**Constraints carried, not decided here:**

1. Free Alpaca Basic is the only live provider. Nothing paid: the Alpaca $99 tier (ADR-0002), the Longbridge OPRA add-on, and marketdata.app's $30 plan stay owner-gated (02t §0, rulings 3 and 5).
2. IBKR runs only through the laptop edge and the daily ritual (02t §5); the B1 probe is owner work. Longbridge needs an account and confirmed eligibility (02t B4). None of this plan depends on either.
3. 02t's twelve rulings stand, except ruling 10, which §2.3 re-opens at the owner's request and flags for Hermes.
4. Packages never import each other (ai-trading AGENTS.md); the Desk reaches the bridge only through `ai_trading_common.registry.DataSources` (ADR-0004).
5. The bridge has no public route: Longbridge and marketdata.app terms forbid redistribution (02t §9 risk 6), and the bridge tokens never reach a browser.

## 1. Consumer inventory

What each consumer reads, where it reads it today, and which vendor call stands behind it. "Postgres" means the Desk database: `bars_1d`, `bars_1h`, `bars_1m` (90-day retention, `prune_1m`), `symbol_metrics`, `feed_health`, the universe tables, and `replay_blobs` (the write-once practice cache, 02o §h.2).

| # | Consumer | Code | Needs | Reads today | Vendor call today | After this plan |
|---|---|---|---|---|---|---|
| 1 | Alerts runtime and engine tick | `alerts/runtime.py`, `engine/tick.py` | 1d and 1m bars as of the tick (`read_bars(as_of=...)`), feed health | Postgres | None at read time (the scheduler fills) | Unchanged: Postgres, filled through the bridge |
| 2 | Screener and scan passes | `data/refresher.py`, `data/universe.py`, `screener/runner.py`; jobs `premarket_0830`, `refresh_15m`, `daily_close` | Universe (assets, most-actives, movers); 1d and 1m bars; metrics. **Writes** `bars_*`, `symbol_metrics`, universe rows, `feed_health` (sole writer) | Postgres (after its own writes) | `DataSources.universe` and `.bars`, Alpaca direct | Bars through the bridge (B5, `BatchGetBars`); universe through the bridge (C1) |
| 3 | Watchlist backfill | `jobs/backfill_watchlist.py`, `data/backfill.py` | Missing sessions, 1d/1h/1m. **Writes** `bars_*` | Postgres (`missing_sessions`) | `DataSources.bars` | Through the bridge (B5) |
| 4 | Dashboard strip and quote SSE | `api/quotes.py`, `refresher.ensure_market_strip` | Latest **closed 1m bar** per symbol, polled every 60 s (not a quote call) | Postgres `bars_1m` | None at request time | Unchanged; `WatchQuotes` only once realtime exists (W1) |
| 5 | Charts | `api/charts.py` | 1d and 1m as of now | Postgres | None | Unchanged |
| 6 | Bars, technicals, watchlist routes | `api/bars.py`, `api/market_data.get_market_bars`, `api/technicals.py`, `api/watchlists.py` | Bounded closed bars for any symbol (1m up to 30 days, 1d up to 10 years) | Provider at request time | `DataSources.bars` | Through the bridge (B5); finished sessions from the archive (H1) |
| 7 | Research valuation | `research/valuation.py` | 1d for the stock and benchmark; one spot quote | Provider | `.bars`, `.quotes` | Through the bridge (B3 quotes, B5 bars) |
| 8 | Fundamental lane | `fundamental/prices.py` (`spot_prices`) | Spot quotes. Its SEC, news, consensus, and macro reads are not market data and stay direct Python (02t §1 non-goals) | Provider | `.quotes` | Quotes through the bridge (B3) |
| 9 | Holdings | `holdings/service._price_map` | Stored close prices, then spot quotes for misses | Postgres, then provider | `.quotes` | Quotes through the bridge (B3) |
| 10 | Covered calls (options phase) | `covered_calls/service.py` | Option chains narrowed by DTE and strike | Provider | `DataSources.option_chain` (`alpaca_options`, indicative) | Through the bridge (B6, owner-gated) |
| 11 | **Practice replay** (day, swing, screen, plan, prep CLI) | `replay/data.py` (`History`), `replay/tape.py` (`Tape`), `replay/screen.py`, `replay/swing*.py`, `replay/plan.py`, `cli/replay_prep.py` | Raw 1m (extended hours, the day plus 10 prior sessions), raw and split 1d (300 sessions), SIP trades for the tape; finished sessions only (+15-minute embargo). **Writes** `replay_blobs` | `replay_blobs` (never `bars_*`) | `.bars` (raw/split) and `.trades` on a cache miss | Bars through the bridge (B5, no Desk change), archive truth (H1), trades through the bridge (P1) |
| 12 | Notable days | `jobs/daily_close._refresh_notable_days`, `replay/days.refresh` | 1m plus raw and adjusted 1d | Provider | `.bars` | Through the bridge (B5) |
| 13 | **Backtest engine** (planned) | `core/backtest.py` exists as a pure function over `SymbolBars` frames; no service and no data loader yet | Long 1d and 1m history, many symbols, as of a fixed instant, deterministic | n/a | n/a | K1, on the archive |
| 14 | 01m facade for ai-hedge-fund | `packages/market-data/server.py`, `alpaca.py` | Daily bars, SPLIT and RAW (`/prices/`, the price inside `/financial-metrics/`) | Provider | Alpaca direct (stdlib) | `bridge_prices.py` at B5 (02t §4.3) |
| 15 | Status and Settings card | `api/status.py` (`gateway_status`) | Provider health, routing | `DataSources` | None (IBKR off) | Bridge at B3 (02t) |
| 16 | B2 shadow job (in flight) | `bridge_shadow` (B2's session owns it) | Quotes, pinned per provider | Bridge and direct | Both | Diagnostic only; retires after B3 |
| — | TradingAgents, Vibe-Trading, MiroFish | upstream | Their own upstream vendors; only ai-hedge-fund calls 01m | — | — | Out of scope; any of them can adopt the API later through Connect JSON |

**What the table shows:**

- Hot paths (#1, #4, #5) already read only Postgres. Every vendor call already goes through one door, `DataSources`, so a chain change (`bridge,alpaca`) moves most consumers with **no Desk code change**.
- Practice (#11) does **not** read `bars_*`: it keeps its own write-once cache in `replay_blobs`, in a Python-only codec (`npz-v1`) that no other app can read.
- The Go and Python Alpaca adapters have already drifted. The 5U fix (`f6e8fdfc`: `1Day` bars are stamped midnight ET, so a session-window request lost its first day) is in Python only. The Go adapter still sends the caller's start unpadded (`internal/providers/alpaca/alpaca.go` `Bars`), so B5 would bring 5U back. Its `closed()` also has no exchange calendar: it assumes a 16:00 close, and its own `ponytail:` note says so. This errs late, never early, so it is safe for look-ahead, but it disagrees with the Desk's `bar_close` on half days.

## 2. The read path: where historical truth lives

### 2.1 Proposed ruling: one seam, two stores, split by mutability

1. **One seam.** Every vendor call for market data (quotes, bars, option chains, trades, universe) goes through the bridge. After B7 no Python provider serves a market-data kind.
2. **History store: the bridge archive (H1).** Bars of **finished sessions** (regular close plus the 15-minute embargo has passed), **RAW adjustment only**, are written once into a bridge-owned archive and are the system of record for history across apps. `GetBars` reads through it: archive hit, else provider fetch, then archive the fetch if the session is finished.
3. **Working set: Desk Postgres stays.** `bars_1d/1h/1m`, `symbol_metrics`, `feed_health`, and the universe tables stay the Desk's operational store. The Desk scheduler fills them through the bridge, and every hot path keeps reading them through `read_bars` (alerts tick, engine, metrics, SSE strip, charts).
4. **Adjusted series are never archived.** A later split rewrites `ALL` and `SPLIT` history, so these are served pass-through and labeled; point-in-time adjustment for backtests is Q4.

### 2.2 Why, against the two alternatives

| Option | Verdict | Reason |
|---|---|---|
| A. The bridge serves every read; the Desk drops `read_bars` | Rejected | Every alert tick would make RPCs per symbol. A bridge outage would blank alerts that can run honestly on stored bars (ADR-0010: degrade, never blank). `symbol_metrics`, `feed_health`, and the screener tables are Desk logic, not vendor data. The change would rewrite about ten `read_bars` callers for nothing a user can see. |
| B. The bridge stays stateless; Desk Postgres is the only truth | Rejected | It fails the owner's "several apps reuse it": packages never read each other's database, so 01m, a backtest service, or a future app cannot share Desk history. `bars_1m`'s 90-day prune cannot back an intraday backtest. `replay_blobs` holds only days someone practiced, in a Python-only codec. Every app re-fetches on one Alpaca key's shared rate budget. |
| **C. Archive in the bridge for immutable history; working set in the Desk** | **Proposed** | RAW bars of a finished session never change, so the archive needs no invalidation and no scheduler (read-through). A provider swap never rewrites history: the archive keeps each session's serving vendor. One cache serves every app and spends one rate budget. The Desk keeps its fast, outage-tolerant local reads. |

**Archive shape (H1, a sketch for Hermes, not a schema):** its own database and role in the existing ai-trading Postgres service (Q3). Daily RAW bars are one row per bar, a few thousand rows per symbol per decade. Minute RAW bars are one compressed blob per (symbol, session, feed), holding a serialized `repeated Bar` from the proto itself, so any language with the proto decodes it (unlike `npz-v1`). A session row records `complete`, `bar_count` (0 is a valid quiet session, distinct from `NoData`), `provider`, and `fetched_at`. The bridge boots and serves quotes with the archive database down: bars then pass through with `complete=false` (§4.1), and `ListProviders` reports the archive state in words.

**Desk `read_bars` remains the Desk's single query API for stored bars.** Desk code reaches market data through exactly two doors: `read_bars` (local) and `DataSources` (bridge). No Desk module calls the bridge except `providers/bridge.py`.

### 2.3 Re-opening 02t ruling 10 ("trades and universe stay direct Python"), flagged for Hermes

The ruling held that provider independence was not needed for these Alpaca-only kinds. The owner's ask now names Practice and provider independence explicitly, and Practice needs `trades` for its tape. **Recommendation: reverse ruling 10 for both kinds, staged:**

- **Universe** moves at **C1** (beside B5): three small RPCs mirroring `UniverseSource` (`assets`, `most_actives`, `movers`) and a new `UNIVERSE` data class. Payloads are small, the premarket pass is the only caller, and the risk is low.
- **Trades** move at **P1**: a paged `GetTrades` (at most 10,000 prints a page, the adapter's existing page size). The Desk keeps its tape chunks cached in `replay_blobs`, a presentation cache. The bridge does not archive trades until a second consumer of prints exists.
- **Why now, not never:** two adapters for one vendor already diverged (5U is live in Go, fixed in Python). Moving both kinds lets B7 delete the Python `alpaca` adapter entirely, so one vendor has one implementation. Leaving them keeps the Python adapter alive only for `trades` and `universe`, and keeps Practice tied to Alpaca.
- **Cost:** Connect JSON for prints is heavy (about 1 MB per 10,000-print page). A tape chunk is fetched once and cached forever, so this is acceptable. If P1 measures it as too slow, Hermes may allow Python protobuf decoding for `GetTrades` only (a narrow exception to ruling 2).
- If Hermes reverses ruling 10, ADR-0003's sentence "`trades`/`universe` stay direct Python" needs a superseding note from the orchestrator. This plan does not edit `decisions/`.

## 3. The sync path: who fetches, when, and how failure reads

### 3.1 Proposed ruling: the Desk owns *when*, the bridge owns *how*

| Duty | Owner | Mechanism |
|---|---|---|
| Schedule (premarket, every 15 minutes, after the close, weekly) | **Desk scheduler** (unchanged jobs) | It knows the watchlists, screener survivors, sessions, catch-up, and `feed_health`; the bridge knows none of these, and it should stay that way |
| Fetch, normalize, closed-bar rule, rate budget, provider health | **Bridge** | The Desk scheduler's `DataSources` calls land on the bridge after B5 |
| Gap-filling in Desk tables | Desk (`missing_sessions`, `backfill`), unchanged | Its fetches go through the bridge |
| Gap-filling in the archive | Bridge, **read-through** | Any `GetBars` for a finished session archives it; no bridge cron |
| Bulk prefetch with no payload back | `EnsureHistory` RPC (H1) | Replay prep CLI, backtest prefetch, and one new `daily_close` step: after the close plus embargo, ensure today's 1m session for the watchlist and survivors, so minutes outlive the 90-day `bars_1m` prune |
| Watch and subscribe | Bridge `WatchQuotes` (W1) for **server-side** consumers only | Browsers keep the Desk SSE route (`/api/desk/quotes`); see §4.3 |

**No bridge-internal scheduler.** A cron inside the bridge would need symbol lists that are Desk state, and the read-through archive plus `EnsureHistory` cover every sync need above. Add one only if a non-Desk app needs history warmed without asking for it.

### 3.2 Failure semantics (ADR-0010 preserved)

- `feed_health` keeps **one writer**, the Desk refresher. The bridge never writes Desk state.
- The Python seam maps Connect codes onto the error taxonomy (02t §4.1), so `PassReport` keeps its exact meaning: `ok`, `degraded` (some symbols failed), `empty` (asked, nothing came back, only `NoData`), `down` (nothing fetched and something failed). A zero-fetch pass is never `ok` (the 5T lesson).
- `BatchGetBars` and `EnsureHistory` report **per-symbol** outcomes (`SymbolError`, `Coverage.missing[].error`), never one error for a whole batch, so "one symbol's failure is recorded and the pass goes on" and "five failures in a row stop the pass" still hold.
- `EnsureHistory` separates three things that must never blur: an archived session with zero bars (a quiet day, complete), a session that failed (`missing`, with its `ErrorKind`), and a session before the 2016-01-04 history floor (`uncovered`, never fabricated, as in `BackfillResult.uncovered`).
- **Bridge down:** until B7, the chain `bridge,alpaca` answers from direct Alpaca, labeled `fallback`. After B7 there is no safety rung: the call raises `Unavailable`, the pass reports `down`, alerts keep evaluating stored bars inside their stale limits, and the status bar says why. Nothing shows a fake fresh value.
- **Archive down (bridge up):** bars pass through with `complete=false`, and determinism-sensitive consumers (P1, K1) say "inputs not archived" instead of claiming a reproducible run.

## 4. API surface

### 4.1 Proto extensions (additive to `familyapp.marketdata.v1`)

```proto
service MarketData {
  // The seven existing RPCs are unchanged.
  rpc BatchGetBars(BatchGetBarsRequest) returns (BatchGetBarsResponse);         // B5
  rpc ListAssets(ListAssetsRequest) returns (ListAssetsResponse);               // C1
  rpc GetMostActives(GetMostActivesRequest) returns (GetMostActivesResponse);   // C1
  rpc GetMovers(GetMoversRequest) returns (GetMoversResponse);                  // C1
  rpc EnsureHistory(EnsureHistoryRequest) returns (EnsureHistoryResponse);      // H1
  rpc GetTrades(GetTradesRequest) returns (GetTradesResponse);                  // P1 (if Q1)
  rpc WatchQuotes(WatchQuotesRequest) returns (stream WatchQuotesResponse);     // W1
}

enum DataClass { /* 0-3 unchanged */ TRADES = 4; UNIVERSE = 5; }

message GetBarsRequest {
  // fields 1-6 unchanged
  google.protobuf.Timestamp as_of = 7;  // C0. Unset = now. Only bars whose close <= as_of (read_bars semantics).
}
message Bar {
  // fields 1-6 unchanged
  string session_date = 7;              // C0. YYYY-MM-DD XNYS trading day; never derived from a UTC or midnight-ET stamp (5U)
  google.protobuf.Timestamp close = 8;  // C0. The bar's close instant from the exchange calendar (half days included)
}
message GetBarsResponse {
  // fields 1-3 unchanged
  bool complete = 4;                    // H1. Every session in range is finished and archived: this answer never changes
  repeated string providers = 5;        // H1. Every vendor behind these bars, oldest first (a provider swap shows here)
}

message BatchGetBarsRequest {           // 1..100 symbols; one vendor multi-symbol request where the vendor allows it
  repeated string symbols = 1; Timeframe timeframe = 2; google.protobuf.Timestamp start = 3;
  google.protobuf.Timestamp end = 4; Adjustment adjustment = 5; google.protobuf.Timestamp as_of = 6;
}
message SymbolError { string symbol = 1; ErrorKind error = 2; string message = 3; }
message BatchGetBarsResponse { repeated GetBarsResponse results = 1; repeated SymbolError errors = 2; }

message EnsureHistoryRequest {          // RAW only; MINUTE_1 or DAY_1; last_session must be finished (else INVALID_ARGUMENT)
  repeated string symbols = 1; Timeframe timeframe = 2; string first_session = 3; string last_session = 4;
}
message SessionGap { string session_date = 1; ErrorKind error = 2; }
message Coverage {
  string symbol = 1; int32 archived = 2; int32 fetched_now = 3;
  repeated SessionGap missing = 4; repeated string uncovered = 5;  // uncovered: before the history floor
}
message EnsureHistoryResponse { repeated Coverage coverage = 1; }

message GetTradesRequest {
  string symbol = 1; google.protobuf.Timestamp start = 2; google.protobuf.Timestamp end = 3;
  string feed = 4;                      // "sip" | "iex" (iex only as the labeled fallback, as today)
  string page_token = 5; int32 page_size = 6;  // page_size <= 10000
}
message Trade { int64 time_ns = 1; double price = 2; int64 size = 3; string conditions = 4; string exchange = 5; }
message GetTradesResponse { repeated Trade trades = 1; string next_page_token = 2; Served served = 3; }

message WatchQuotesRequest { repeated string symbols = 1; }  // 1..50
message WatchQuotesResponse { repeated Quote quotes = 1; Served served = 2; }  // on change; empty heartbeat every 5 s
// C1 universe messages mirror ai_trading_common.types (UniverseAsset, ActiveSymbol, Mover) field for field; fixed at C1.
```

### 4.2 Versioning policy

- **v1 is add-only:** new fields, new RPCs, and new enum values at the end. Never renumber, rename, retype, or reuse a field number; a dead field becomes `reserved`. The existing CI step `buf breaking` against `origin/dev` enforces this mechanically.
- **Unset means the old behavior:** `as_of` unset means now; `adjustment` unset means `ALL`. An old client is never surprised.
- **Unknown enum values are safe:** the Python seam maps an unknown `ErrorKind` to `Unavailable` (falls through) and ignores an unknown `DataClass`. A seam test pins both rules.
- **Semantic changes count as breaking even with the same wire.** A changed closed-bar rule is a breaking change: the contract goldens (§6) are the semantic lock, and any golden diff is reviewed in the stage's pull request.
- **v2 only for an unavoidable break.** It is served beside v1 on the same port, and v1 retires only after every §1 consumer has moved.

### 4.3 Transport, streaming, and the browser story

- One port, unchanged (02t §3.1): gRPC for Go clients, Connect unary JSON for Python and 01m, and gRPC-Web and Connect streaming for free from connect-go.
- **`WatchQuotes` is gRPC server-streaming, with no WebSocket.** connect-go already serves streams over HTTP/2 and gRPC-Web over HTTP/1.1, and a WebSocket layer would add a second protocol for no consumer.
- **No browser-to-bridge path, ever.** Browser Practice does not need one: replay is historical, the Desk API serves it under Clerk auth, and live prices reach the browser through the Desk's existing SSE route. Licensing (02t §9 risk 6) and token safety forbid exposing the bridge. If live realtime arrives (W1), the Desk opens **one** server-side `WatchQuotes` stream and fans it out over SSE.
- **Python consumes streams at W1 only.** Connect streaming over JSON is a framed HTTP/1.1 body, readable with `requests`; no new dependency. This assumption is checked at W1, and grpcio for that one RPC is the fallback (Q8).

### 4.4 Client generation

| Consumer | Client | Kept honest by |
|---|---|---|
| Go (bridge, future Go apps) | `buf generate`, committed `gen/`; CI fails on drift (exists) | Conformance suite over every wire |
| Python (Desk through `providers/bridge.py`; the IBKR edge) | Hand-written Connect JSON, no codegen (ruling 2) | Replays every contract golden; a new RPC with no adapter mapping fails the replay test |
| 01m (stdlib) | `bridge_prices.py`, `urllib` (02t §4.3) | Replays `get_bars_*` goldens |
| TypeScript | **None.** No TS consumer exists, and browsers never call the bridge | Add `protoc-gen-es` to `buf.gen.yaml` only when a Node server consumer appears |

## 5. Consumer migration plan

### 5.1 Stages (new stages bold; 02t stages keep their gates and add what is listed)

| Stage | Depends on | What | Consumers moved (§1 #) | Exit gate |
|---|---|---|---|---|
| **C0** Historical correctness | Nothing: bridge-only, runs **in parallel with B2** | Proto fields `as_of`, `session_date`, `close`. Embedded XNYS calendar (Q6). `closed()` and `close` computed from the calendar, matching `ai_trading.data.bars.bar_close`. The 5U fix ported (a `DAY_1` request start padded to midnight ET of the start day, results re-sliced to trading dates). A recorded vendor window. Goldens and tests from §6 tiers T0–T2. Deployed dark. | None | T0, T1, and T2 green in the bridge job and the `common` suite; Go and Python adapters produce identical normalized bars on every recorded fixture |
| B2 Shadow (02t, in flight) | B0 | Unchanged | 16 | 02t gate |
| B3 Quotes flip (02t) | B2 | Unchanged | 7, 8, 9 (quotes), 15 | 02t gate |
| B5 Bars flip plus 01m (02t, **extended**) | **C0 (hard: without it 5U returns)**; the B2 seam | `DATA_PROVIDERS_BARS=bridge,alpaca`. The seam sends `now` as `as_of` and reads `session_date`. `BatchGetBars`, and the refresher's per-symbol loops use it. 01m `PRICE_PROVIDER=bridge`. | 2, 3, 6, 7, 11 (bars, transparently), 12, 14 | 02t gate plus a **bars shadow**: zero OHLCV differences between bridge and direct for the watchlist and strip, 1d and 1m, over 5 trading days; one `premarket_0830` and one `daily_close` pass report the same state and counts as direct |
| **C1** Universe | The B5 seam | `UNIVERSE` class, three RPCs, `bridge` serves the `universe` kind; chain `bridge,alpaca` | 2 (universe) | Premarket universe symbol sets identical, bridge and direct, for 5 sessions |
| **H1** History archive | C0 | Archive database and role; read-through for RAW 1d and 1m; `EnsureHistory`; `complete` and `providers`; the `daily_close` ensure step; archive sizes in `bridge status`; backup coverage | 6 (finished sessions served from the archive, transparently) | T2 archive tests green; with the archive database stopped, quotes still serve and bars pass through with `complete=false`; one restore drill of the new database; disk growth recorded after 10 sessions |
| **P1** Practice on the central API | H1, B5; the trades part needs Q1 | Import existing `replay_blobs` **bar** blobs into the archive (no re-fetch, Q5). `History` stops writing bar blobs and reads through the bridge (its in-process LRU stays). Prep uses `EnsureHistory`. `GetTrades`, `TRADES` class, `Tape` through the bridge; tape blobs stay a Desk cache. Store a dataset fingerprint per practice session (Q9). | 11, 12 | **Deterministic replay gate** (§5.2) |
| **K1** Backtest on the central API | H1 | A Desk backtest data loader: `EnsureHistory`, then `BatchGetBars(as_of=run.as_of)` into `core/backtest.py`. Each run records its `as_of` and dataset fingerprint. Point-in-time split handling per Q4. The backtest product UI is the owner's phase, not this one. | 13 | **Deterministic backtest gate** (§5.2) |
| B6 Options (02t) | Owner-gated | Unchanged | 10 | 02t gate |
| **W1** `WatchQuotes` | B3, plus IBKR realtime live, plus an alert path that needs sub-minute data | Server-streaming; the Desk holds one stream and fans out over SSE | 4 (only when realtime) | With the gateway switched off mid-stream, the honest degraded state shows within one heartbeat; no browser route to the bridge exists (route-table test) |
| B7 Retire (02t, **extended**) | All of the above | In addition to 02t: the Python `alpaca` adapter leaves `REGISTRY` (if Q1); a migration drops `replay_blobs` bar kinds; 01m `alpaca.py` is deleted | — | A registry test pins that no market-data kind names a non-bridge provider; import-boundary test unchanged; walkthrough |

Every stage ends with its gates green plus the dual-agent post-phase walkthrough (02t §7), and rides phase pull requests under the CI-conservation rule.

### 5.2 Determinism gates (the owner's named consumers)

**P1, deterministic replay.** Before the flip, capture a golden set of 10 practice sessions as (symbol, day, window, as_of): at least one half day, one session across the 2026-11-01 DST change, one quiet pre-market, and one split-affected symbol. For each, fingerprint `DayInputs` (the 1m frame, daily frame, `prior_close`, `avg_shares_per_s`; a SHA-256 of a canonical CSV). The gate:
1. Fingerprints are identical before and after the flip.
2. Fingerprints are identical with a cold archive and a warm archive.
3. Fingerprints are identical after the vendor fake "revises" a bar, because the archive wins.
4. For 3 tape windows, prints are identical print for print.
5. An existing journal from before the flip shows the identical chart.

**K1, deterministic backtest.**
1. The same spec, range, and `as_of`, run twice, and run cold versus warm, give byte-identical trades and stats.
2. With `as_of` set before a day's close, that day's bar is absent, and no indicator value moves (look-ahead test).
3. When a fingerprint mismatches the recorded one, the run says "inputs changed since this run" instead of differing silently.

### 5.3 If B2 lands, and if B2 slips

- **B2 lands:** its `providers/bridge.py` is the seam that B5, C1, P1, and K1 extend. C0 adds only proto fields that are additive; B2's adapter ignores them until B5.
- **B2 slips:** C0 and H1 are bridge-only and do not wait. B5 absorbs the seam build exactly as 02t §4.1 specifies, and its gate adds B2's quotes-shadow criteria.
- **Either way:** C0 edits `marketdata.proto`. Hermes should tell B2's session so that proto edits merge in one order; `buf breaking` catches a bad merge.

## 6. API tests (owner-required)

### 6.1 What exists today

| Tier | What | Where it runs |
|---|---|---|
| Go unit | 37 test functions: `config` (3), `providers/alpaca` (10: delayed labels, never realtime, taxonomy mapping, no secret in errors, not-configured sends nothing, embargo, paging, hygiene, closed-only, open-bar drop, empty window, probe, throttle), `router` (13), `server` (9: auth, validation, request log without secrets, `WatchStatus`), `readonly` (no order, position, or account call) | Bridge job in `ai-trading-ci.yml`: `go test -race -count=1 ./...` |
| Go conformance | One scripted session of 13 steps over 4 wires (gRPC, gRPC-Web, Connect protobuf, Connect JSON), asserted identical | Same job |
| Contract goldens | 12 files in `testdata/contract/`. Bars has **one**: `get_bars_daily`. No minute, hour, as-of, or session-boundary golden. | Written by the Go run (`-update`); the Python replay arrives with B2 |
| Proto gates | `buf lint`, `buf breaking` against `origin/dev`, `buf generate` leaves no diff | Bridge job |
| Python seam | `test_conformance.py` (every registered adapter against its Protocols), `test_registry.py`, `test_chains.py`, `test_fallback.py` | `common` suite (`uv run pytest -q`) |
| Recorded vendor fixtures | `common/tests/fixtures/alpaca/`: real responses recorded by `common/scripts/record.py` (daily ranges for AAPL and SPY, DST-change hourly and minute, half-day hourly and minute, a 7-page minute pagination), replayed by `test_alpaca_fixtures.py` | `common` suite. **Python only:** the Go adapter never sees them |
| Desk | About 4,000 tests, including a real-Postgres 9,000-row chunking test (5T) and the `WindowedSession` fake that reproduces the exact 5U production request | `desk` job |
| 01m | `test_alpaca.py`, `test_server.py`, `test_metrics.py`, `test_sec.py` | market-data job |
| Smoke | `deploy/ci/smoke-test.sh` reaches the bridge's `/healthz` and `ListProviders`, and checks 01m's shape contract (offline, dummy keys) | Local and CI after `bake` |
| B2 shadow gate | `bridge_shadow` JSON lines summarized with one `docker logs \| jq` command (02t §8.2): 0 bps gap, no mislabeled quality, p95 under 300 ms over 5 trading days | Production logs (B2's session owns the exact query) |

**Gaps:** no Go historical-data test against real vendor shapes; no as-of parameter to test; 5U untested (and live) in Go; no Go calendar, so half days are untested; one bars golden; and no test that the Go and Python adapters agree.

### 6.2 Test tiers to add (C0 builds T0–T3; each later stage adds its own rows)

**T0. Contract goldens for every RPC.**
- Every RPC gets at least one success golden and one error golden, written by the Go conformance run and replayed by the Python adapter tests (and by 01m for `get_bars_*`).
- A **meta-test** walks the service descriptor (`marketdatav1` file descriptor) and fails if any method lacks either golden, so a new RPC cannot ship untested.
- New bars goldens at C0: `get_bars_minute`, `get_bars_hourly_half_day`, `get_bars_as_of_mid_session`, and `get_bars_daily_single_session` (the 5U request). Later stages add `batch_get_bars_partial` (one symbol fails), `ensure_history`, the three universe goldens, `get_trades_page`, and the archive goldens (`complete` true and false).
- Gates: the bridge job and the `common` suite.

**T1. Historical conformance on a frozen recorded window.**
- **Recording:** record `testdata/vendor/alpaca/2026-10/` in the bridge with the existing `common/scripts/record.py` and its `{"params", "body"}` format. Record it when C0 starts, because part of the window is after today.
- **Daily:** SPY, AAPL, and QQQ, 2026-10-01 to 2026-11-06. That is 22 October sessions plus the first November week, so it spans the **2026-11-01 DST end**.
- **Minute:** extended hours for SPY and AAPL on 2026-10-30 (EDT) and 2026-11-02 (EST).
- **Split:** RAW and SPLIT daily for one split symbol across its split date (chosen at recording).
- **Go reads the existing Python fixtures** (DST, half day, pagination) by relative path, with no copies, as 02t §8.1 already does for goldens.
- **Known values:** the fixture README lists literal values checked once by hand against an independent view at recording time (for example, SPY's 2026-10-30 daily close against the owner's TWS chart). Tests assert those literals, not just self-consistency.
- **Parity:** one table-driven case list, run by Go (`internal/providers/alpaca/recorded_test.go`) and by Python (`common/tests/test_vendor_parity.py`), asserts identical normalized output: `session_date`, start, close, OHLCV, closed filtering, and hygiene drops. This is the test that would have caught the 5U drift.
- Gates: the bridge job and the `common` suite. Offline.

**T2. As-of, no-look-ahead, and session boundaries.** Table-driven in Go, with a Desk mirror where Desk code is involved.

- **5U, must-cite (STATUS row 5U, `f6e8fdfc`):** a one-session `DAY_1` request sent as `extended_open..extended_close` returns exactly that session's bar. A 5-session window returns 5 bars, and the first day is never lost. This is the exact production request, in Go as it already is in Python.
- **Daily close:** at `as_of` = D 15:59 ET, day D's bar is absent; at 16:00 ET it is present; on a half day it appears at 13:00 ET.
- **Hourly and minute:** the hourly half-day case matches `bar_close` exactly, using the existing `hourly_half_day` fixture. A minute bar is present only at start plus 1 minute.
- **Session date across UTC midnight:** a 19:59 ET extended-hours bar in EST is 00:59Z the next UTC day, and its `session_date` is the ET date. Checked on both sides of 2026-11-01.
- **Holidays:** a range over 2026-11-26 (Thanksgiving) has no bar, and `EnsureHistory` does not count it as missing.
- **Embargo:** the end is capped to now minus 15 minutes; a request entirely inside the embargo sends no vendor call (exists; kept).
- **Archive (H1):**
  - An unfinished session is never archived.
  - A finished session is archived once and is served identically after the vendor fake changes its body.
  - A quiet session (zero bars) is archived as complete and empty, distinct from `NoData` for an unknown symbol.
  - With the archive database down, the answer passes through with `complete=false`.
- **Calendar drift (C0):** a Desk-suite test reads the bridge's embedded calendar file and asserts it equals `core.calendar.session` for every day from 2016 to 2030. This reads a data file and imports nothing, which is the sanctioned golden-replay pattern.
- **Determinism (P1, K1):** the §5.2 gates live here: `tests/replay/test_replay_determinism.py` and the K1 backtest determinism test in the `desk` job.
- Gates: the bridge job and the `desk` job.

**T3. Live smoke against free Alpaca (opt-in, never a PR gate).**
- **Command:** a `bridge smoke` subcommand beside the existing `bridge healthcheck`. It needs no shell in the distroless image, so `docker exec market-data-bridge /bridge smoke` works.
- **Checks:**
  - `GetBars` SPY `DAY_1` for the last 5 finished sessions: exactly 5 bars, with `session_date`s equal to the calendar's.
  - `MINUTE_1` for the last finished session: a non-zero count inside a sane extended-hours bound.
  - `GetQuotes` SPY: quality `DELAYED_15M`, never `REALTIME`.
  - `ListProviders`: `alpaca` is `HEALTH_STATE_OK`.
- **Offline-safe:** with no token the command prints `SKIPPED: no MARKET_DATA_BRIDGE_TOKEN` and exits 0. A gate never counts a skip as a pass (ADR-0010), and an offline CI test pins the skip path.
- **Where:** a post-deploy step in `deploy.sh` on the VPS (credentials are already rendered there; zero Actions minutes), plus every walkthrough. A smoke failure logs at warning level and does not roll back a deploy, because a provider outage is not a bad build (Q10).

**T4. Seam and Desk integration (B5, C1, P1).**
- The adapter forwards `now` as `as_of`, maps every Connect code to the taxonomy, and maps unknown enum values safely.
- `PassReport` states come out unchanged when the refresher runs on the bridge adapter fed from goldens (`ok`, `degraded`, `empty`, `down`).
- `bridge` never ends a chain (02t §4.1).
- Gates: the `common` suite and the `desk` job.

### 6.3 Gate summary

| Tier | Runs in | Blocks |
|---|---|---|
| T0 goldens, meta-test | Bridge job (Go) and `common` suite (Python replay); market-data job for 01m | Every stage's pull request |
| T1 recorded window and parity | Bridge job and `common` suite | C0 and every later bars change |
| T2 as-of, boundaries, archive, calendar drift, determinism | Bridge job and `desk` job | C0, H1, P1, K1 |
| T3 live smoke | VPS post-deploy and walkthrough | Stage acceptance (a human reads it), never a pull request |
| T4 seam and Desk integration | `common` suite and `desk` job | B5, C1, P1 |
| Proto compatibility | Bridge job (`buf breaking`, generate drift) | Every proto change |

## 7. Open questions for Hermes

1. **Re-open 02t ruling 10:** move `universe` (C1) and `trades` (P1) into the bridge? *Recommend yes, both, staged.* The owner's ask names Practice and provider independence; the Go and Python Alpaca adapters already drifted (5U); and B7 can then delete the Python `alpaca` adapter. ADR-0003 then needs the orchestrator's superseding note.
2. **Where history lives:** a bridge archive of finished-session RAW bars, with Desk Postgres as the working set (§2.1)? *Recommend yes.* The alternatives fail either multi-app reuse or the alert hot path (§2.2).
3. **Archive storage:** its own database and role in the existing ai-trading Postgres service, or files and SQLite on a bridge volume? *Recommend Postgres.* Backups and operations already exist for it, and it lets P1 import `replay_blobs` bars with one SQL-side copy job. The stage confirms the backup job covers the new database.
4. **Point-in-time split adjustment for backtests (K1):** *Recommend* archiving RAW only, plus split events derived from the step changes in the RAW-to-SPLIT ratio and stamped with the date first seen. K1 then builds "split-adjusted as known at `as_of`" from RAW times known factors. This needs no new endpoint; free-tier corporate-actions availability is unverified, so do not depend on it.
5. **Existing practice history:** import the `replay_blobs` bar blobs into the archive, or re-fetch? *Recommend import.* Re-fetching could silently change a past journal's chart if the vendor ever revised a bar.
6. **Exchange calendar in Go:** a generated XNYS JSON (2016–2030) embedded in the bridge with the Desk drift test, or a Go calendar library? *Recommend the embedded file.* It has one source of truth, the drift test makes it provable, and an ad-hoc closure is a one-line edit. Regenerate it yearly.
7. **Batching:** a new `BatchGetBars` RPC (B5), or a repeated field on `GetBars`? *Recommend the new RPC.* It keeps `GetBars` simple, reports per-symbol errors cleanly, and uses the vendor's multi-symbol endpoint to spend less of the one shared Alpaca rate budget during premarket.
8. **Streaming:** `WatchQuotes` as gRPC server-streaming for server-side consumers only, built at W1, with no WebSocket and no browser route? *Recommend yes.* Delayed data polled every 60 s gains nothing from push before IBKR realtime is live. If Connect streaming over `requests` proves awkward at W1, allow grpcio for that one RPC.
9. **Determinism fingerprint:** store a dataset hash with each practice session and backtest run (one small column each, P1 and K1), or rely on archive write-once alone? *Recommend storing it.* It turns a silent divergence into an honest "inputs changed" message (ADR-0010).
10. **Live smoke placement:** a post-deploy step in `deploy.sh` that warns but never rolls back, plus walkthroughs, with CI running only the skip path? *Recommend yes.* It costs zero Actions minutes, credentials never enter CI, and a provider outage never fails a build.
11. **Ordering against B2:** C0 starts now in parallel (bridge-only, additive proto), and B5 hard-depends on C0? *Recommend yes,* and ask B2's session to expect additive edits to `marketdata.proto`.
12. **TypeScript client:** none until a Node server consumer exists? *Recommend yes* (YAGNI; browsers never call the bridge).

## 8. Risks

1. **Two adapters for one vendor until B7.** Proven by 5U. Mitigated by C0's parity tests and ended by B7's deletion (Q1).
2. **The bridge becomes stateful at H1.** Mitigated: the archive is optional at boot, quotes never depend on it, and pass-through is labeled `complete=false`.
3. **One Alpaca key, several clients, during migration** (the bridge, the Python safety rung, 01m). A slow bridge plus the fallback can double calls. Keep the bridge's per-call timeout below the Python client's, and watch `SoftBanned` counts in the B5 shadow.
4. **Archive growth on the shared VPS disk** (`deploy.sh` refuses below 30 GiB free). Writes are bounded by what is asked for: practice days, backtest ranges, and the watchlist and survivors ensure step. H1 records growth per session and Hermes sets a cap if it is needed.
5. **Calendar drift** (NYSE ad-hoc closures). Mitigated by the drift test and a yearly regeneration.
6. **Trades payloads over JSON** (§2.3). Mitigated by the page cap and the fact that chunks are fetched once; the fallback is the narrow protobuf exception in §2.3.
7. **A parallel session editing B2** while C0 edits the proto (Q11). `buf breaking` plus an agreed merge order handle it.

## 9. Hermes rulings (2026-11-01, review pass — all 12 accepted; do-not-reopen)

1. **Ruling 10 of 02t §11 is REVERSED, staged:** `universe` moves at C1 and `trades` at P1 into the bridge. Reason: two adapters for one vendor already drifted (5U was fixed in Python only; the Go adapter still sends the unpadded start — `internal/providers/alpaca/alpaca.go` `Bars`). B7 deletes the Python `alpaca` adapter. ADR-0003 carries the superseding note.
2. **Historical truth = the bridge archive** (write-once RAW bars of finished sessions, filled on read at H1); Desk Postgres stays the working set and every hot path keeps `read_bars`.
3. **Archive = own database and role in the existing ai-trading Postgres service.** H1 confirms the backup job covers it and runs a restore drill.
4. **RAW bars + split events derived from the RAW-to-SPLIT ratio**, stamped with first-seen dates; no dependence on corporate-actions endpoints.
5. **Import existing `replay_blobs` bar blobs** into the archive; never re-fetch (a vendor-revised bar must not silently change a past journal).
6. **Embedded generated XNYS calendar JSON (2016–2030)** with the drift test against the Desk calendar; regenerate yearly (sync-checklist item).
7. **New `BatchGetBars` RPC** at B5; `GetBars` stays single-symbol.
8. **`WatchQuotes` = gRPC server-streaming, server-side consumers only, W1.** No WebSocket, no browser route. If Connect streaming over `requests` is awkward at W1, `grpcio` is allowed for that one RPC only.
9. **Dataset fingerprints stored** on practice sessions (P1) and backtest runs (K1); a mismatch is an honest "inputs changed" message, never a silent difference.
10. **Live smoke runs post-deploy on the VPS, warn-only** (never rolls back, never fails CI); CI runs the skip path only.
11. **C0 starts now, in parallel with B2** (bridge-only, additive proto edits; B2 is told the proto will change and merges first). **B5 hard-depends on C0.**
12. **No TypeScript client** until a Node server consumer exists.
