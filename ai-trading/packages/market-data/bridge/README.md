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
