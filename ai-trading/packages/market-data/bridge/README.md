# market-data bridge (02t)

Go service that hides the market-data provider behind one API: gRPC, gRPC-Web, and
the Connect protocol (unary JSON over HTTP) on one port. Plan:
`ai-trading/plans/subplans/02t-market-data-bridge-plan.md`. This is stage B0: Alpaca
Basic only (quotes, bars; never labeled realtime), no consumer yet.

| Path | What |
|---|---|
| `proto/marketdata/v1/marketdata.proto` | The API. `gen/` is `buf generate` output, committed; CI fails on drift |
| `cmd/bridge` | `bridge [--role=bridge]`, `bridge healthcheck` |
| `internal/config` | Env parsing and ladder validation (names only; values come from Firestore) |
| `internal/router` | Provider interfaces, fallback ladder, health cache, in-memory routing |
| `internal/providers/alpaca` | Alpaca Market Data adapter (read-only) |
| `internal/providers/cache` | Redis hot tier: a decorator over any provider (see below) |
| `internal/server` | connect-go handler, bearer auth, request logs, conformance suite |
| `internal/xnys` | Embedded XNYS calendar (2016-2030, early closes) and the bar-close rule (`closed`, `close`) |
| `tools/` | Data generators: the calendar and the Go/Python parity golden. Never run in CI |
| `testdata/contract` | Canonical Connect JSON exchanges; the Python adapter tests replay them |
| `testdata/calendar` | The Desk calendar's session instants, for the calendar drift test |
| `testdata/vendor/alpaca` | Frozen real Alpaca responses and the Python-normalized bars, for the parity test |

```sh
go test -race ./...                      # offline: httptest fakes and goldens
go test ./internal/server -update        # rewrite the goldens after an intended change
buf lint && buf generate                 # plugins are pinned by go.mod `tool` lines
```

Historical correctness (stage C0, 02u) rests on three rules this package owns:

- a `DAY_1` request start is padded back to midnight ET of the caller's start day, and the answer
  is re-sliced to the caller's New York trading dates (5U: a one-session window used to come back
  empty and a wider one silently lost its first session);
- every `Bar` carries `session_date` (the ET trading date, never the UTC date of the stamp) and
  `close_at` (the calendar's close: 16:00 ET, 13:00 ET on an early close);
- `GetBarsRequest.as_of` (unset = now) drops every bar that had not closed by then, so a replay or
  backtest at an earlier instant never sees the future.

Regenerate the data after a calendar change (yearly, 02u §9 ruling 6) or a vendor re-recording:

```sh
uv run --with exchange_calendars,pandas,python-dateutil \
  python tools/gen_xnys_calendar.py --desk-src ../../family-desk/backend/src
uv run --with pandas,exchange_calendars,python-dateutil,requests \
  python tools/gen_parity_golden.py --common-src ../../../common/src --desk-src ../../family-desk/backend/src
go test ./internal/xnys ./internal/providers/alpaca
```

Calling it (Connect JSON, what the Python seam sends):

```sh
curl -s -X POST -H 'Content-Type: application/json' -H "Authorization: Bearer $MARKET_DATA_BRIDGE_TOKEN" \
  -d '{"symbols":["AAPL"]}' http://market-data-bridge:8080/familyapp.marketdata.v1.MarketData/GetQuotes
```

`SetRouting` also needs `X-Admin-Token: $MARKET_DATA_BRIDGE_ADMIN_TOKEN`. int64 fields are JSON strings and enums
are their proto names (`DELAYED_15M`, `HEALTH_STATE_OK`). With no token configured the bridge boots but rejects every
call. `GET /healthz` reports the process only, never a provider.

## H1 archive (`internal/archive`)

Write-once Postgres history of finished RAW `DAY_1`/`MINUTE_1` sessions, read through by `GetBars`
(and filled by `EnsureHistory`). Quotes, the open session, adjusted bars, `HOUR_1` and pinned
providers never touch it. Off unless `ARCHIVE_ENABLED=1`, which then needs `ARCHIVE_DATABASE_URL`
(falling back to `DESK_RUNTIME_DATABASE_URL` for local dev); an unreachable database never stops the
bridge booting and bars pass through from the provider. `bridge migrate` applies `schema.sql`
(idempotent; the boot step runs it too). The production database, role and the profile knob are in
`infrastructure/apps/ai-trading/README.md`, "Market-data H1 archive"; the role script is
`docker/postgres/zz-20-market-archive-roles.sh`. `ARCHIVE_TEST_DATABASE_URL=postgres://…` makes the
archive tests run on that database as well as on the in-memory store.

## Redis hot tier (`internal/providers/cache`)

A small, disposable cache in front of the providers. It is **not** a history store: finished RAW
`DAY_1`/`MINUTE_1` history is owned by the Postgres archive (`internal/archive`, `ARCHIVE_ENABLED`).
Redis holds what the archive does not: quotes, bars of the session in progress, adjusted bars,
`HOUR_1`, and (archive off) finished history for a while. `main.go` wraps every provider in one loop
(`cache.New(store, opts).Wrap(p)`), keeping the inner provider's name, classes, health and probe, so
ladders, pins and `Served.Provider` do not change and a new provider needs no cache code.

Off unless `CACHE_ENABLED=1` (then `CACHE_REDIS_URL=redis://:<password>@host:port/db` is required).
In production both come from the Firestore profile `ai-trading/market-data-cache`, see
`infrastructure/apps/ai-trading/README.md`.

**Keys** (`md:v1:` is the only global invalidation switch; bump it when the value format or a
provider's data variant changes):

| What | Key | Value |
|---|---|---|
| Quote | `md:v1:<provider>:q:<SYMBOL>` | `pb.Quote` |
| Bars | `md:v1:<provider>:b:<SYMBOL>:<1m\|1h\|1d>:<raw\|split\|all>:<startUnix>:<endUnix>` | `pb.GetBarsResponse{Symbol, Bars, Served{Quality}}`, deflated over 512 B, one tag byte (`R`/`Z`) in front, never over 1 MiB |

The bars window is widened to whole ET days (`start` = midnight ET of its date, `end` = the last
second of its end date) before the provider call, and sliced back to the caller's window after, so
callers that differ only in "now" share an entry. `as_of` is not in the key: the cache stores every
closed bar and `server.GetBars` cuts the answer to `as_of` afterwards.

**TTL** (`policy.go`, pure functions of the data and `now`; ±10% jitter on every write):

| Case | TTL |
|---|---|
| Quote, `REALTIME` or unlabelled | not cached |
| Quote, `DELAYED_15M`, session not finished | 30 s |
| Quote, `DELAYED_15M`, session finished | 5 min |
| Quote, `EOD` | 10 min |
| Bars, window not settled (touches the open session or the future) | 60 s |
| Bars, settled, RAW, `HOUR_1`; or RAW `DAY_1`/`MINUTE_1` with the archive off | 30 days, `SET NX` |
| Bars, settled, RAW `DAY_1`/`MINUTE_1` with the archive on | 10 min, `SET NX` (only covers a Postgres outage) |
| Bars, settled, `ALL`/`SPLIT` | until the next 04:00 ET, clamped to 5 min .. 24 h |
| Unknown timeframe or adjustment; pinned requests (`pin_provider`); errors; empty windows | not cached |

"Settled" = the last session on or before the window's end date is finished (`xnys.SessionFinished`:
20:00 ET extended close plus the 15-minute embargo). Only closed bars are ever stored, even if a
provider returns a forming one.

**Failure behaviour:** every Redis call has a short deadline (read 150 ms, write 250 ms); any error
or timeout is a miss and the provider answers. After 5 consecutive failures a circuit breaker skips
Redis for 30 s, then probes with one call. Concurrent identical misses collapse into one provider
call (`singleflight`, which also protects the shared 200 req/min vendor budget). A corrupt or
wrong-format value is a miss and is overwritten. Boot never depends on Redis (it connects lazily),
and `/healthz` stays process-only. Once a minute, when non-zero, the bridge logs one
`cache_stats` JSON line (`bars.hit`, `bars.miss`, `quote.hit`, `store_error`, `breaker_open`, ...):
`docker logs <bridge> | jq 'select(.msg=="cache_stats")'`.

Known side effect: a cache hit counts as a successful provider request, so `last_ok` and p50/p95 in
`ListProviders` include hits. Pinned requests (the B2 shadow gate) bypass the cache by design.
