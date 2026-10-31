# ai-trading Common: Data Providers Design

Status: approved by the owner (2026-10-11), design and written spec. It changes the Phase 2a plan ([phase-2a-data-without-ibkr.md](02c-desk-v1-tasks/phase-2a-data-without-ibkr.md)) before that plan runs.

## 1. Goal

Every external data source lives in `ai-trading/common`, behind a provider pattern. Replacing one vendor with another, for example Eulerpool with provider X, means:
- adding an adapter for X;
- adding one registry line;
- changing config;

with **no edits to the code that uses the data**. This covers every data kind, not only consensus EPS. Callers (the Desk now, the other ai-trading apps later) see only vendor-neutral types.

## 2. Layout

```
ai-trading/common/src/ai_trading_common/
  errors.py  quality.py  http.py  bars.py  fallback.py  testing.py   core, as in the Phase 2a plan
  types.py       vendor-neutral result types and their as-of selectors
  sources.py     one runtime-checkable Protocol per data kind
  registry.py    provider registry, default chains, DataSources.from_env()
  providers/
    alpaca.py  sec_edgar.py  fred.py  finnhub.py  alphavantage.py  eulerpool.py
```

Each `providers/<name>.py` holds three things:
1. **The raw client:** HTTP calls, error mapping, and the vendor's own record shapes.
2. **One adapter class, `<Name>Source`,** which implements every data kind that vendor serves by mapping vendor records into `types.py` objects. Vendor quirks stay here. Eulerpool's join of calendar rows to surprise rows lives in its adapter. Finnhub's targets adapter returns the real rating counts with empty target prices.
3. **`PROVIDER`,** its registry entry (§5).

**Import rules:**
- `types.py` and `sources.py` import no vendor module.
- `registry.py` is the only module that imports `providers`.
- `consensus.py` from the current plan disappears: its result types move to `types.py`, its adapters move into the vendor modules, and its chains move into the registry.

## 3. Data kinds

| Kind (`DATA_PROVIDERS_<KIND>`) | Protocol and method | Result | Default chain |
|---|---|---|---|
| `bars` | `BarsSource.bars(symbol, timeframe, start, end, *, now)` | `Bars` (split- and dividend-adjusted; closed bars only) | `alpaca` (IBKR is added first in Phase 2b) |
| `fundamentals` | `FundamentalsSource.facts(symbol, *, as_of, concepts=None)` | `list[Fact]` | `sec_edgar` |
| `earnings_announcements` | `EarningsAnnouncementsSource.announcements(symbol, *, since)` | `list[EarningsAnnouncement]` | `sec_edgar` |
| `macro` | `MacroSource.observations(series_id, start, end, *, as_of)`, `MacroSource.release_dates(series_id, *, as_of=None)` | `list[Observation]`, `list[date]` | `fred` |
| `news` | `NewsSource.news(symbol, start, end)` | `list[NewsItem]` | `finnhub` |
| `earnings_calendar` | `EarningsCalendarSource.earnings_calendar(symbol, start, end)` | `list[EarningsEvent]` | `finnhub` |
| `consensus` | `ConsensusSource.consensus(symbol, *, now)` | `list[ConsensusSnapshot]` | `eulerpool`, `alphavantage` |
| `earnings` | `EarningsSource.earnings_results(symbol, *, now)` | `list[EarningsResult]` | `eulerpool`, `finnhub`, `alphavantage` |
| `targets` | `TargetsSource.analyst_targets(symbol, *, now)` | `AnalystTargets` | `eulerpool`, `finnhub` |

## 4. Vendor-neutral types (`types.py`)

Every result record carries `provider: str` and `quality: Quality`, so any chain can label it. The exception is `Bars`, which stays in `bars.py` with its existing `source` field holding the provider name.

- **`Fact`:** concept, unit, value, period start and end, span, fiscal year and period, form, filed, and `reference` (SEC's accession number).
- **`EarningsAnnouncement`:** symbol, `announced_on`, and `reference`. For SEC, this is the 8-K Item 2.02 filing date.
- **`Observation`:** series ID, date, value, realtime start and end.
- **`NewsItem`:** symbol, headline, `publisher` (renamed from `source`, so it isn't confused with the provider), URL, and `published_at` in UTC.
- **`EarningsEvent`:** symbol, report date, `timing` (`before_open`, `after_close`, or `unknown`; Finnhub's `bmo`/`amc` codes map onto these), fiscal year and quarter, and EPS and revenue estimates and actuals.
- **`ConsensusSnapshot`, `EarningsResult`, `AnalystTargets`:** as in the current plan's Task 2a.6, including `EarningsResult.period_end: date | None`.

The as-of selectors are `facts_as_of`, `announcements_as_of`, and `news_as_of`: pure functions on these types.

## 5. Registry and config (`registry.py`)

- **`Provider(name, kinds, build)`:** `build(env: Mapping[str, str], http: ThrottledClient)` returns the vendor's adapter. `REGISTRY` maps names to the `PROVIDER` entries of the six vendor modules. **Adding a provider is one new line here.**
- **`DEFAULT_CHAINS`:** the right-hand column of §3.
- **`DataSources`:** a frozen object with one attribute per kind (`bars`, `fundamentals`, ..., `targets`), each typed as that kind's Protocol. It is built once at startup by `DataSources.from_env(env=os.environ, *, http=None, registry=REGISTRY, defaults=DEFAULT_CHAINS)`.
- **Config:** `DATA_PROVIDERS_<KIND>`, a comma-separated provider list such as `DATA_PROVIDERS_CONSENSUS=eulerpool,alphavantage`. If it's unset, the default chain applies.
  - It lives where every env value lives: the app's Firestore profile, for example `ai-trading/desk`.
  - It's read once, at startup.
- **Fail fast at startup:** `from_env` raises `ValueError`, naming the env var, when a list is empty, a name is unknown, or a provider doesn't serve that kind.
- **A missing API key is not a startup error.** That provider raises `NotConfigured` when called, and the chain moves on.
- **One adapter per vendor:** each provider is built at most once and shared by every kind it serves.

## 6. Chains

Each `DataSources` attribute is a chain object that implements its kind's Protocol, so a caller can't tell a chain from a single provider.

- **Order:** a chain tries its providers in order, with the existing `fallback.first_success` rules. `NotConfigured`, `Unavailable`, `SoftBanned`, and `NoData` fall through to the next provider. If every provider fails, an outage is reported ahead of `NoData`.
- **Labeling:** a result from any provider other than the first is relabeled `quality="fallback"`: each record in a list, a single record, or `Bars`. Plain values, such as release dates, are returned unchanged.
- **Out of scope:** merging fields across providers. A partial provider, such as Finnhub's targets, is simply a less complete fallback.

## 7. Callers

- The Desk builds `DataSources.from_env()` once (in Phase 3's runtime; in Phase 2a, in tests) and passes the needed source to its code. For example, `ai_trading.data.backfill` takes a `BarsSource`, not an Alpaca client.
- **Boundary:** Desk code imports only `ai_trading_common.types`, `sources`, `registry`, `bars`, `errors`, and `quality` (and `testing` in tests), never `ai_trading_common.providers`. A Desk test enforces this.

## 8. Replacing a provider (the checklist)

To move consensus, earnings, and targets from Eulerpool to provider X:

1. Add `providers/x.py`: its client, `XSource` implementing those kinds, and `PROVIDER`. Add fixtures recorded with `scripts/record.py x`, and tests.
2. Add X's `PROVIDER` to `REGISTRY` (one line).
3. Store the key and point the chains at X, from the repository root:

   ```bash
   export CLOUDSDK_ACTIVE_CONFIG_NAME=personal
   read -rs K && printf '%s' "$K" | python3 common/config/family_config.py set shared/x X_API_KEY; unset K
   python3 common/config/family_config.py link ai-trading/desk X_API_KEY shared/x
   printf '%s' 'x,alphavantage' | python3 common/config/family_config.py set ai-trading/desk DATA_PROVIDERS_CONSENSUS
   printf '%s' 'x,finnhub,alphavantage' | python3 common/config/family_config.py set ai-trading/desk DATA_PROVIDERS_EARNINGS
   printf '%s' 'x,finnhub' | python3 common/config/family_config.py set ai-trading/desk DATA_PROVIDERS_TARGETS
   ```

4. Redeploy, since the config is read at startup.

To make X the default for every app instead, change `DEFAULT_CHAINS` in the same pull request rather than Firestore.

Providers registered for config selection only (02b §4c, 2026-10-30), in no default chain, because an unconfigured provider raises `NotConfigured` and, at the end of a chain, that replaces an earlier provider's `Unavailable`:

- `tradier`: `quotes` and `option_chain`; reads `TRADIER_ACCESS_TOKEN` and optional `TRADIER_ENVIRONMENT`; greeks refresh hourly.
- `marketdata_app`: `quotes` and `option_chain`; reads `MARKETDATA_APP_TOKEN` and optional `MARKETDATA_APP_QUALITY`; the delay depends on the plan.
- Longbridge has no entry: its quote API is a socket protocol with no REST schema (02b §4c).

## 9. Tests

- **Registry:**
  - the default chains;
  - an env override reorders a chain;
  - each startup failure in §5;
  - surrounding whitespace in a list is tolerated;
  - each provider is built once across its kinds.
- **Conformance:** every registered provider's adapter is an instance of each declared kind's Protocol.
- **Swap:**
  - a fake provider passed through `registry=` and selected by env serves the data, with no change to the caller;
  - when the fake raises `Unavailable`, the next provider's result comes back labeled `fallback`.
- **Adapters:** each vendor's client tests stay, and adapter tests map the recorded fixtures into `types.py` objects.
- **Desk:** the import-boundary test; backfill and the end-to-end test run through a `DataSources` built from env, with a fake HTTP layer.

## 10. Not in scope

- merging fields across providers;
- discovering plugins from config or entry points;
- reloading config without a restart;
- async clients.

## 11. Effect on the Phase 2a plan

The prototype in `temp/p2a-proto/final/` is restructured to this layout (common: 177 tests; Desk backend: 557 with Postgres), then the plan is re-rendered from it, self-checked byte for byte, and reviewed again. Task split:
- **2a.1:** the core plus `types.py`, `sources.py`, and `registry.py`, with an empty `REGISTRY` and `DEFAULT_CHAINS`. The chains, the config validation, and the swap tests all run on fake providers. `Provider` itself is defined in the leaf module `_provider.py` and re-exported as `registry.Provider`, so the provider modules never import `registry.py` (no import cycle).
- **2a.2:** Alpaca.
- **2a.3:** SEC EDGAR and FRED.
- **2a.4:** Finnhub and Alpha Vantage.
- **2a.5:** Eulerpool, including the calendar/surprise join.
- **2a.6:** the conformance test over the real registry, the real-adapter fallback test, `ai-trading/common/README.md`, and the pilot write-up.

Each provider task adds its own lines to `REGISTRY` and `DEFAULT_CHAINS`. Both are sorted one entry per line, so parallel lanes union cleanly. 2a.7 (the Desk database) is unchanged. In 2a.8, backfill takes a `BarsSource`, and the import-boundary test is added. The fixtures (`ae6ec0f`, `c602b52`) are unchanged.
