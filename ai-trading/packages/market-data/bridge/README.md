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
| `testdata/contract` | Canonical Connect JSON exchanges; the Python adapter tests replay them |

```sh
go test -race ./...                      # offline: httptest fakes and goldens
go test ./internal/server -update        # rewrite the goldens after an intended change
buf lint && buf generate                 # plugins are pinned by go.mod `tool` lines
```

Calling it (Connect JSON, what the Python seam sends):

```sh
curl -s -X POST -H 'Content-Type: application/json' -H "Authorization: Bearer $MARKET_DATA_BRIDGE_TOKEN" \
  -d '{"symbols":["AAPL"]}' http://market-data-bridge:8080/familyapp.marketdata.v1.MarketData/GetQuotes
```

`SetRouting` also needs `X-Admin-Token: $MARKET_DATA_BRIDGE_ADMIN_TOKEN`. int64 fields are JSON strings and enums
are their proto names (`DELAYED_15M`, `HEALTH_STATE_OK`). With no token configured the bridge boots but rejects every
call. `GET /healthz` reports the process only, never a provider.
