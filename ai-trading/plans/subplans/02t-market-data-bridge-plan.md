# 02t: Market-Data Bridge (Go, gRPC): One Provider-Agnostic Data Service

Status: **planned 2026-10-31 (docs only; nothing built, bought, or activated).** Written by Claude Code (planner) on `feature/market-data-bridge-plan`, stacked on `feature/market-data-providers` (row 5Q). Hermes reviews the decisions in §11 before any stage starts. STATUS row 5R.

Related: [02b](02b-desk-market-data-options.md) §4d (the owner decisions this plan implements), [02j](02j-common-data-providers-design.md) (the Python provider registry the Desk keeps using), [02e](02e-ibkr-data-user-setup.md) (the IBKR data user), [01m](01m-market-data-adapter.md) (the service this replaces in part), [02q](02q-laptop-migration.md) (parked laptop migration, referenced, not planned here), [STATUS.md](../STATUS.md).

## 0. Owner decisions (2026-10-31, binding; recorded, not re-derived)

1. **Provider mix:** IBKR (IB Gateway), Alpaca, Longbridge, and marketdata.app, the last **only** as a fallback for real-time options if Longbridge's real-time options prove poor.
2. **No Tradier.** The owner will never open a Tradier brokerage account. The Python `tradier` adapter (row 5Q) stays in the tree, **dormant**: in no default chain, never ported to the bridge, never given a key.
3. **The IBKR gateway is back in.** The 2026-10-29 rejection (02b §4b, "needs a human 2FA re-login") is superseded: the owner accepts a **daily on/off ritual**. IB Gateway runs on the owner's **spare Ubuntu laptop**, which is also the app's future host (02q, parked). Whenever the gateway is off, the design degrades honestly: a fallback ladder and a truthful UI state.
4. **marketdata.app:** the $30/month non-professional plan, options fallback only. Its stock quotes are 15 minutes delayed on every plan (owner-verified on the pricing page), so it is **never** a stocks source.
5. **Alpaca:** the free Basic plan (delayed SIP) is the live baseline. The $99 Algo Trader Plus tier is bought **only** when the wife reaches a professional level **and** the app is comprehensive (Telegram alerting plus AI stock Q&A).
6. **Longbridge:** the cheap candidate for real-time stocks, plus an OPRA add-on of about HK$22/month. No account exists, and US-resident OpenAPI eligibility is unverified. Its quote API is a socket protocol with no REST path, which a Go bridge can speak natively through the vendor's Go SDK. Its option-chain call returns strikes and symbols only.
7. **Order:** stocks first, covered-call options later. Futures are out of scope. The IBKR API stays read-only: quotes only, never orders.

## 1. Goals and non-goals

**Goals**
- `ai-trading/market-data` becomes an independent **bridge API** that hides the data provider: a Go service speaking gRPC (and the Connect protocol on the same port, §3.1).
- It serves three data classes: equity quotes, equity bars (closed bars only), and option-chain snapshots. Every answer says which provider served it, at what quality, and why it fell back.
- A provider toggle on `trading.tobytran.dev` (Settings) picks the preferred provider per data class. The bridge validates the choice, falls back when the chosen provider is unavailable, and the UI shows what is actually serving.
- The Desk keeps its adapter pattern: callers still see only `DataSources` (02j §7). The bridge enters as one more registry provider, `bridge`.
- ai-hedge-fund keeps working, unchanged, through the 01m Financial Datasets-shaped routes (§4.3).

**Non-goals**
- Futures (deferred since 02b §4b). Orders of any kind, paper included, through any provider. Account data, positions, or balances (holdings stay on the IBKR Flex import).
- Fundamentals, news, consensus, macro, calendars: these stay as direct Python providers in `ai-trading/common` (02j), because they are not market data and have no provider-swap pressure.
- Trades (the Practice replay tape) and universe (assets, most-actives, movers): Alpaca-only kinds, kept direct in Python for now (§11 Q10).
- A push quote stream to the Desk. `GetQuotes` is a snapshot; the bridge holds IBKR streaming lines internally. Add a `StreamQuotes` RPC only when an alert path needs sub-second push.
- Prometheus or a metrics stack: no such stack exists. Counters ride the status RPC and the logs (§8.2).
- The full move of the app to the laptop (02q).

## 2. Provider matrix

### 2.1 Roles

| Provider | Role | Cost (today; gated upgrade) | Auth model | Equities | Options | Bars | State 2026-10-31 |
|---|---|---|---|---|---|---|---|
| **IBKR** (IB Gateway, data user) | Real-time equities primary **while the gateway is on** | $14.50/month non-pro bundles, subscribed 2026-10-10 (02e). Whether they are still active after the 2026-10-29 revision is unconfirmed (§11 Q7). | A human signs the gateway in each trading day and approves on the phone; the API socket carries no credential. Read-Only API on, Trusted IPs `127.0.0.1` only. | Real-time L1, snapshots every 250 ms, pre- and post-market | OPRA L1 included in the $4.50 add-on per IBKR's docs; model greeks per tick. Not in a ladder until Hermes rules (§11 Q5). | Historical bars exist (pacing limits); not a ladder rung | Python `providers/ibkr.py` built, switch off (`DESK_IBKR_GATEWAY_ENABLED`); no probe result recorded in 02d |
| **Alpaca** Basic | Today's baseline; last rung of every equities ladder; the history backbone | $0. The $99 Algo Trader Plus tier only behind decision 5. | API key and secret (Firestore `shared/alpaca`) | SIP 15 minutes delayed (Basic's real-time IEX feed covers about 2–3% of volume, so it is never labeled real-time, 02b §2) | Indicative feed, stamped `delayed-15m` (`alpaca_options`) | Daily since 2016, hourly, 1-minute; closed bars only | Live in Python (`alpaca`, `alpaca_options`) and in 01m |
| **Longbridge** | Candidate real-time equities rung; options primary once covered calls start | About $0 for US L1; about HK$22/month OPRA add-on | Developer token from a Longbridge account (the Go SDK README recommends OAuth 2.0; the legacy app key, secret, and token also exist) | Real-time L1, pre/post/overnight. The source (NBBO or Nasdaq Basic) is unverified. The Quote response has `last_done` but no bid or ask (those come from the Depth call). | Chain call returns strikes and symbols only; per-contract quotes need the OPRA add-on; greek and bid/ask fields unverified | Candlesticks | No account, no adapter. Go SDK: `github.com/longbridge/openapi-go` (older path `longbridgeapp/openapi-go`) |
| **marketdata.app** | Options fallback only | $30/month non-pro plan, bought only if Longbridge options prove poor | `Authorization: Bearer <token>` | **Never** (15-minute delay on every plan) | Chains with bid, ask, IV, greeks, OI, DTE; a credit per option symbol, so every request is narrowed by DTE and strike. Tier caveat: §11 Q3. | Not used | Python adapter built, dormant, no key |
| **Tradier** | **Dormant**: owner declined 2026-10-31 | n/a | n/a | n/a | n/a | n/a | Python adapter stays, in no chain, not ported |

### 2.2 Degradation ladders

A ladder is ordered. A rung is tried only when its provider is configured, registered for the class, and not marked down by the health cache (§3.5). The router never upgrades a quality label; the label is always the serving provider's own.

| Data class | Ladder after its rollout stage | Notes |
|---|---|---|
| Equity quotes | `ibkr` → `longbridge` → `alpaca` | IBKR is realtime only during the ritual. Longbridge joins at B4. Alpaca is always last and always delayed. |
| Equity bars | `alpaca` | One rung. IBKR history is an on-demand backfill (02b §5), never a rung. |
| Option chains | `longbridge` → `marketdata_app` → `alpaca` | From B6 only. marketdata.app only once bought. Alpaca's indicative chain is the honest floor. |

Typical day, after B4: before the ritual, quotes come from Longbridge (realtime, if it exists) or Alpaca (delayed). After the owner signs the gateway in, IBKR serves at the next request. When the laptop sleeps or the gateway logs off, the next request falls back without a retry storm, and the Settings card and status bar say why.

### 2.3 Activation gates (who is on by default, per stage, §7)

| Stage | IBKR | Alpaca | Longbridge | marketdata.app | Tradier |
|---|---|---|---|---|---|
| Today | Switch off; Python path unused | Serves everything | n/a | Dormant | Dormant |
| B0 bridge dark | Not built | Bridge's only rung | n/a | n/a | Never |
| B1 IBKR edge | Bridge rung while the ritual is on; no consumer yet | Last rung | n/a | n/a | Never |
| B2 shadow | Shadowed only | Serves the Desk (direct Python) | n/a | n/a | Never |
| B3 quotes flip | Desk primary during the ritual | Last rung | n/a | n/a | Never |
| B4 Longbridge stocks | Primary during the ritual | Last rung | Middle rung, **only after** the owner opens the account and support confirms eligibility | n/a | Never |
| B6 options | Stocks as above | Last options rung | Options primary, after the OPRA add-on is bought | Middle options rung, **only after** the owner buys the plan | Never |

## 3. Bridge service design

### 3.1 Shape, layout, transport

- **One Go binary, two roles.** `bridge` (on the VPS, every provider except IBKR, plus a remote rung that dials the IBKR edge) and `edge` (on the laptop, IBKR only, §5). Once 02q moves the app to the laptop, the edge folds into the main bridge with a config change.
- **Transport: connect-go** (`connectrpc.com/connect`). One handler serves gRPC, gRPC-Web, and the Connect protocol (unary JSON over HTTP/1.1 POST) on one port, with h2c inside the Docker network. Go clients use real gRPC. The Python seam and 01m can use unary JSON with the client they already have, with no new dependency and no Python codegen (§11 Q2).
- **Layout** (sketch; nothing is created in this run):

  ```
  ai-trading/market-data/
    server.py metrics.py sec.py alpaca.py ...   01m FD-compat facade (Python, stdlib), kept (§4.3)
    bridge/
      go.mod                        module .../ai-trading/market-data/bridge
      proto/marketdata/v1/marketdata.proto
      gen/                          buf-generated Go, committed; CI checks for drift
      cmd/bridge/main.go            flags: --role=bridge|edge
      internal/router/  internal/config/  internal/server/
      internal/providers/alpaca/ longbridge/ marketdataapp/ remote/
      testdata/contract/            canonical JSON goldens shared with the Python tests
      Dockerfile                    static binary on distroless; healthcheck is `bridge healthcheck`
  ```

- **Auth:** a bearer token checked in an interceptor with a constant-time compare, like 01m's `X-API-Key`. `MARKET_DATA_BRIDGE_TOKEN` grants reads. `MARKET_DATA_BRIDGE_ADMIN_TOKEN` is also required for `SetRouting`. `IBKR_EDGE_TOKEN` guards the edge. Tokens and query strings are never logged.
- **Health:** a plain `GET /healthz` reports the process only, never provider health, so a gateway that is off never restarts the container.

### 3.2 Proto sketch (lives here until B0 creates the real file)

```proto
syntax = "proto3";
package familyapp.marketdata.v1;

import "google/protobuf/timestamp.proto";

service MarketData {
  rpc GetQuotes(GetQuotesRequest) returns (GetQuotesResponse);
  rpc GetBars(GetBarsRequest) returns (GetBarsResponse);
  rpc GetOptionChain(GetOptionChainRequest) returns (GetOptionChainResponse);
  rpc ListProviders(ListProvidersRequest) returns (ListProvidersResponse);
  rpc GetStatus(GetStatusRequest) returns (BridgeStatus);
  rpc WatchStatus(WatchStatusRequest) returns (stream BridgeStatus);  // on change, and a heartbeat every 5 s
  rpc SetRouting(SetRoutingRequest) returns (Routing);                // admin token only
}

enum DataClass { DATA_CLASS_UNSPECIFIED = 0; EQUITY_QUOTES = 1; EQUITY_BARS = 2; OPTION_CHAIN = 3; }
// A data property, never a routing outcome: "fallback" and "unavailable" are not qualities here (see Served).
enum Quality { QUALITY_UNSPECIFIED = 0; REALTIME = 1; DELAYED_15M = 2; EOD = 3; }
enum ErrorKind { ERROR_KIND_UNSPECIFIED = 0; NOT_CONFIGURED = 1; UNAVAILABLE = 2; SOFT_BANNED = 3; NO_DATA = 4; NOT_ENTITLED = 5; }

message Attempt { string provider = 1; ErrorKind error = 2; string message = 3; }  // message: never a secret

// On every data response: who answered, and why it was not the preferred provider.
message Served {
  string provider = 1;                // "ibkr" | "longbridge" | "alpaca" | "marketdata_app"
  Quality quality = 2;
  bool fallback = 3;                  // true when provider != the class's preferred provider
  string fallback_reason = 4;         // e.g. "ibkr: gateway_down"
  repeated Attempt attempts = 5;
}

message GetQuotesRequest {
  repeated string symbols = 1;        // 1..100, validated like 01m's TICKER pattern
  string pin_provider = 2;            // optional: that provider only, no fallback (shadow, diagnostics)
}
message Quote {
  string symbol = 1;
  double last = 2;
  optional double bid = 3;
  optional double ask = 4;
  google.protobuf.Timestamp as_of = 5;
  Quality quality = 6;
  string provider = 7;
}
message GetQuotesResponse { repeated Quote quotes = 1; repeated string missing = 2; Served served = 3; }

enum Timeframe { TIMEFRAME_UNSPECIFIED = 0; MINUTE_1 = 1; HOUR_1 = 2; DAY_1 = 3; }
enum Adjustment { ADJUSTMENT_UNSPECIFIED = 0; ALL = 1; SPLIT = 2; RAW = 3; }  // 01m needs SPLIT and RAW
message GetBarsRequest {
  string symbol = 1;
  Timeframe timeframe = 2;
  google.protobuf.Timestamp start = 3;
  google.protobuf.Timestamp end = 4;
  Adjustment adjustment = 5;          // unspecified = ALL, as in the Python BarsSource
  string pin_provider = 6;
}
message Bar { google.protobuf.Timestamp start = 1; double open = 2; double high = 3; double low = 4; double close = 5; int64 volume = 6; }
message GetBarsResponse { string symbol = 1; repeated Bar bars = 2; Served served = 3; }  // closed bars only

enum Right { RIGHT_UNSPECIFIED = 0; CALL = 1; PUT = 2; }
message GetOptionChainRequest {
  string underlying = 1;
  Right right = 2;
  google.protobuf.Timestamp now = 3;  // pins the DTE window, as the Python OptionChainSource does
  int32 min_dte = 4;
  int32 max_dte = 5;                  // required, > 0: no whole-chain request by accident
  optional double min_strike = 6;
  optional double max_strike = 7;
  string pin_provider = 8;
}
message OptionContract {
  string symbol = 1;                  // OCC
  string underlying = 2;
  Right right = 3;
  string expiry = 4;                  // YYYY-MM-DD
  double strike = 5;
  int32 dte = 6;
  double bid = 7;
  double ask = 8;
  optional double delta = 9;
  optional double iv = 10;
  optional int64 open_interest = 11;  // as of the previous close
  google.protobuf.Timestamp as_of = 12;
  optional google.protobuf.Timestamp greeks_as_of = 13;  // set when greeks are older than the quote
  Quality quality = 14;
  string provider = 15;
}
message GetOptionChainResponse { repeated OptionContract contracts = 1; Served served = 2; }

enum HealthState { HEALTH_STATE_UNSPECIFIED = 0; OK = 1; DEGRADED = 2; DOWN = 3; OFF = 4; NOT_CONFIGURED = 5; }
message ProviderHealth {
  string provider = 1;
  repeated DataClass classes = 2;     // what it is registered for on this bridge
  bool configured = 3;                // credentials present; never the values
  HealthState state = 4;
  string reason = 5;                  // §5.4 vocabulary, e.g. "edge_unreachable", "competing_session"
  google.protobuf.Timestamp last_ok = 6;
  google.protobuf.Timestamp newest_tick = 7;
  Quality quality = 8;                // what it serves right now
  int32 lines_used = 9;               // IBKR only
  int32 lines_max = 10;
  Counters counters = 11;             // rolling 15 minutes (§8.2)
}
message Counters { int64 requests = 1; int64 errors = 2; int64 fallbacks = 3; int32 p50_ms = 4; int32 p95_ms = 5; }
message ListProvidersRequest {}
message ListProvidersResponse { repeated ProviderHealth providers = 1; }

enum RoutingSource { ROUTING_SOURCE_UNSPECIFIED = 0; ENV_DEFAULT = 1; DESK = 2; }
message ClassRouting {
  DataClass data_class = 1;
  string preferred = 2;               // "" = the ladder's first rung
  repeated string ladder = 3;         // the env ladder: the allowlist, in order
  string serving = 4;                 // who would answer this class right now
}
message Routing { repeated ClassRouting classes = 1; int64 version = 2; RoutingSource source = 3; }
message ClassPreference { DataClass data_class = 1; string provider = 2; }  // "" clears the preference
message SetRoutingRequest { repeated ClassPreference preferences = 1; int64 version = 2; }  // the Desk's version
message GetStatusRequest {}
message WatchStatusRequest {}
message BridgeStatus { google.protobuf.Timestamp at = 1; string role = 2; repeated ProviderHealth providers = 3; Routing routing = 4; string build = 5; }
```

The edge implements the same service, answering `GetQuotes`, `GetStatus`, and `WatchStatus` only. It returns `UNIMPLEMENTED` for the rest.

### 3.3 Go provider interface

```go
type Provider interface {
    Name() string
    Classes() []DataClass
    Configured() bool        // credentials present; cheap, no network
    Health() Health          // the cached state the status RPC reports; no network
}
type QuoteProvider interface { Provider; Quotes(ctx context.Context, symbols []string) ([]Quote, error) }
type BarsProvider  interface { Provider; Bars(ctx context.Context, r BarsRequest) ([]Bar, Quality, error) }
type ChainProvider interface { Provider; OptionChain(ctx context.Context, r ChainRequest) ([]OptionContract, error) }

// Errors mirror ai_trading_common.errors, so both languages fall through on the same conditions.
var ErrNotConfigured, ErrUnavailable, ErrSoftBanned, ErrNoData, ErrNotEntitled error
```

- The router copies 02j §6's `first_success` rules exactly: `NotConfigured`, `Unavailable`, `SoftBanned`, `NotEntitled`, and `NoData` fall through. When every rung fails, an outage is reported ahead of `NoData`.
- Adapters: `alpaca` (net/http or the official `alpaca-trade-api-go` marketdata client, whichever is smaller at B0), `longbridge` (the vendor Go SDK `QuoteContext`, holding one long-lived socket), `marketdataapp` (net/http, ported from the Python adapter with its DTE and strike narrowing), and `remote` (a gRPC client of the edge, used for `ibkr`). There is no Go `tradier`.

### 3.4 Config model (names only; values live in Firestore `family-config`)

| Firestore target | Holds | Read by |
|---|---|---|
| `ai-trading/market-data-bridge` (new, rendered into `market-data-bridge.env` by `deploy.sh`) | `MARKET_DATA_BRIDGE_TOKEN`, `MARKET_DATA_BRIDGE_ADMIN_TOKEN`; links to `shared/alpaca` (`ALPACA_API_KEY_ID`, `ALPACA_API_SECRET_KEY`); later links to `shared/longbridge` and `shared/marketdata-app` (`MARKETDATA_APP_TOKEN`, `MARKETDATA_APP_QUALITY`); `IBKR_EDGE_URL`, `IBKR_EDGE_TOKEN`, `IBKR_GATEWAY_HOURS`; `BRIDGE_LADDER_EQUITY_QUOTES`, `BRIDGE_LADDER_EQUITY_BARS`, `BRIDGE_LADDER_OPTION_CHAIN`; `TS_AUTHKEY` for the sidecar (§5.1) | The VPS bridge |
| `ai-trading/ibkr-edge` (new, rendered on the laptop) | `IBKR_EDGE_TOKEN` (linked), `IBKR_EDGE_LISTEN`, `IBKR_GATEWAY_HOST` (`127.0.0.1`), `IBKR_GATEWAY_PORT` (`4002`), `IBKR_GATEWAY_CLIENT_ID`, `IBKR_GATEWAY_MAX_LINES` (`70`) | The laptop edge. It never holds the IBKR username or password, because a human signs the gateway in. |
| `ai-trading/desk` (existing) | `MARKET_DATA_BRIDGE_URL`, `MARKET_DATA_BRIDGE_TOKEN` and `MARKET_DATA_BRIDGE_ADMIN_TOKEN` (linked), `DATA_PROVIDERS_QUOTES` (and later `_BARS`, `_OPTION_CHAIN`) | Desk API and scheduler |
| `ai-trading/market-data` (existing, 01m) | Adds `MARKET_DATA_BRIDGE_URL` and `MARKET_DATA_BRIDGE_TOKEN` (linked) at B5 | 01m |

- **Startup validation (fail fast, naming the variable),** as `DataSources.from_env` does: an empty ladder; an unknown provider (so `tradier` is unknown by construction); a provider not serving the class; and `marketdata_app` in any equities ladder (decision 4, enforced in code, not only in docs).
- **A missing key is not a startup error:** the provider reports `NOT_CONFIGURED`, the ladder skips it, and the toggle shows it disabled.
- Ladders change only through Firestore plus a redeploy. Only the **preference** is hot (§3.5).

### 3.5 Routing and hot toggle

- **Source of truth: the Desk.** A family-scoped routing row in Desk Postgres (one small migration; the current settings JSON is per user, and routing is one value for the whole family) holds, per class, the preferred provider or none, plus `version`, `updated_by`, and `updated_at`.
- **Flow:** the owner picks a provider in Settings, and the frontend calls `PUT /api/desk/settings/market-data`. The route is owner-only (`DESK_OWNER_EMAILS`, the 02s precedent; §11 Q6). The Desk then validates against `ListProviders`, stores the new version, and calls `SetRouting`. It returns the bridge's resulting `Routing`, which includes who is serving now.
- **The bridge caches the routing.** It holds the routing in memory, stamped `source=DESK, version=n`. After a restart it serves the env default (`source=ENV_DEFAULT`) until the Desk scheduler reconciles: every 60 s it compares `GetStatus.routing.version` with its own and re-sends `SetRouting` if they differ (idempotent). The UI shows "Routing syncing" during that gap. This keeps the container `read_only` and stateless.
- **Meaning of a preference:** the preferred provider moves to the head of that class's env ladder, and the rest keeps its order. The env ladder is the allowlist, so the toggle can never bypass an owner rule (marketdata.app cannot be chosen for stocks, and Tradier is never offered).
- **Validation:** the route answers `422` with a reason in words for an unknown provider, a provider not registered for the class, one not in the ladder, or one not configured (no key). It answers `200` with a warning for a provider that is configured but down: the choice is stored, the bridge falls through, and the provider is used again automatically when it recovers, with no re-toggle.
- **Health cache, no retry storms:** after a failure the router marks the rung down and skips it, and a background probe re-checks it every 30 s (every 60 s for IBKR, matching `RETRY_AFTER_S`). Requests in flight finish on the old routing. A switch away from IBKR releases its streaming lines after the existing idle timeout.
- **Pinning:** `pin_provider` asks one provider with no fallback. Only the shadow job (B2) and diagnostics use it, never product screens.

## 4. The seam to the Desk and the migration path

### 4.1 `providers/bridge.py` in `ai-trading/common`

- `PROVIDER = Provider(name="bridge", kinds=("quotes", "bars", "option_chain"), build=..., enabled=...)`. One registry line, as 02j §5 requires.
- **Graceful when absent:** `enabled(env)` is true only while `MARKET_DATA_BRIDGE_URL` is set. Without it, the registry leaves `bridge` out of every chain, so Alpaca stays primary and keeps its honest label (the `Provider.enabled` mechanism the IBKR switch uses). With the URL set but no token, calls raise `NotConfigured`.
- **Always first, never last:** chains are written `bridge,alpaca`. A `NotConfigured` at the end of a chain would mask an earlier `Unavailable` (02j §8 note), so a registry test pins that `bridge` never ends a chain.
- **Transport:** Connect unary JSON (`POST {url}/familyapp.marketdata.v1.MarketData/GetQuotes`) through `ThrottledClient`, which gains a small `post_json` beside `get_json`. Connect error codes map onto the taxonomy: `unauthenticated` to `NotConfigured`; `unavailable`, `deadline_exceeded`, or a connection error to `Unavailable`; `resource_exhausted` to `SoftBanned`; `not_found` to `NoData`.
- **Records stay truthful:** `Quote.provider` and `Bars.source` carry the **serving vendor** (for example `ibkr`), never `bridge`, and `quality` is that vendor's own. The bridge is the Python chain's primary, so Python never relabels its answers. If the bridge itself is down, `alpaca` answers and Python's chain labels the result `fallback`, which is true.
- **Status and admin surface:** the adapter implements `GatewayStatusSource`, mapping the bridge's `ibkr` health onto the four `GatewayState` values, with one additive `reason` field on `GatewayStatus`. A new `RoutingSource` Protocol in `sources.py` (`providers()`, `routing()`, `set_routing()`) is found by `DataSources` the same way `gateway_status()` finds its source. The Desk therefore still imports only `types`, `sources`, and `registry`, and the import-boundary test stays as it is.
- **No `DataSources` reload:** `from_env` still runs once (02j §10). The hot part, the preference, lives in the bridge.

### 4.2 Retiring the direct Python providers

| Python provider | Fate |
|---|---|
| `ibkr` | From B1 on, never enabled on the VPS: the edge owns the data user's one gateway session (02e "one session per login"). Leaves `REGISTRY` at B7. The module either becomes the edge's core (if Hermes picks the Python edge, §11 Q1) or is deleted. |
| `alpaca` (quotes, bars) | Stays behind the bridge as the safety rung (`bridge,alpaca`). It leaves the quotes and bars chains after 20 clean trading days on the bridge, and stays for `trades` and `universe`. |
| `alpaca_options` | Replaced by the bridge at B6, kept as the safety rung, then leaves the chain like `alpaca`. |
| `marketdata_app` | Dormant until B6; deleted after the Go adapter passes the shared goldens (§11 Q9). |
| `tradier` | **Dormant for good** (decision 2). Stays in the tree, in no chain, not ported. |
| `sec_edgar`, `fred`, `finnhub`, `alphavantage`, `eulerpool` | Out of the bridge's scope; unchanged. |

### 4.3 01m compatibility (ai-hedge-fund)

- **Only one route overlaps:** `/prices/` (Alpaca daily bars), plus the price lookup inside `/financial-metrics/`. SEC companyfacts and the point-in-time TTM math are not market data; rewriting them in Go buys nothing, so they stay in Python.
- **At B5,** `PRICE_PROVIDER=bridge` selects a new `bridge_prices.py` (stdlib `urllib`, a Connect JSON `GetBars` call with `DAY_1` and `SPLIT` or `RAW`), keeping 01m stdlib-only. `alpaca.py` and its test are deleted after one clean week. `FD_BASE_URL`, the routes, the response shapes, and ai-hedge-fund itself do not change. `test_server.py` gains a bridge-prices fake.
- The 01m container keeps its name. It joins the `marketdata` network (§7.1) to reach the bridge.

## 5. IBKR Gateway on the spare Ubuntu laptop

### 5.1 Topology

```
laptop (owner's spare Ubuntu; future app host, 02q)          VPS (current app host)
  IB Gateway (stable, Linux) 127.0.0.1:4002                    market-data-bridge (role=bridge)
     ^ API socket, localhost only                                ^ gRPC over the tailnet, IBKR_EDGE_TOKEN
  ibkr-edge (role=edge, systemd) listens on the tailnet only ----+  through an app-scoped Tailscale sidecar
```

- The gateway's Trusted IPs stay `127.0.0.1` (02e), and the API socket never leaves the laptop. Only the edge's gRPC port is exposed, and only on the tailnet.
- **Link:** an app-scoped `tailscale/tailscale` sidecar container in the ai-trading compose. The bridge shares its network namespace. It uses an ephemeral tagged auth key (`TS_AUTHKEY`) and userspace networking. The shared VPS host stays untouched (one shared VPS, own containers only). A Tailscale ACL allows only `tag:ai-trading-bridge` to reach `tag:ibkr-edge` on the edge port. The ACL is managed as code under `infrastructure/` (§11 Q4). Hostnames and IPs never enter the repo; the edge URL is a Firestore value.

### 5.2 Daily ritual and re-auth cadence

1. **Trading morning, before `IBKR_GATEWAY_HOURS` opens** (default `Mon-Fri 08:00-17:00 America/New_York` on exchange trading days; an owner-tunable knob, widened if the wife wants pre-market):
   1. The owner opens IB Gateway on the laptop and signs in as the data user (the paper-mode login on socket 4002, which receives the shared live data per 02e Step 3; 4001 if the B1 probe says the live login is needed).
   2. The owner approves the sign-in on IBKR Mobile.
2. The edge sees the socket answer and connects with the read-only flag. The bridge marks `ibkr` OK within one heartbeat, and the next quote request is served realtime.
3. **Evening:** the owner closes the gateway. IB Gateway's own auto-logoff time (set to about 23:45) is the safety net for a forgotten gateway. Re-auth is therefore daily by design. IBC or unattended restarts are not planned: the owner chose the ritual.
4. **Laptop setup, once:** no suspend on AC power and the lid switch ignored during gateway hours; unattended-upgrades reboots only on Saturdays; the edge runs as a systemd unit with `Restart=always`; the env comes from `family_config.py run ai-trading/ibkr-edge -- ...`.
5. Do not sign in as the data user anywhere else during gateway hours: each sign-in cuts the gateway (02e "After Setup"). The edge reports this as `competing_session` (§5.4). The daily sign-in also keeps the subscriptions alive under IBKR's 60-day inactivity rule.

### 5.3 Guards

- In IB Gateway: **Read-Only API** on; **Trusted IPs** `127.0.0.1` only; "Allow connections from localhost only" on; socket 4002; no master client ID.
- In the edge: the read-only connect flag; no order, position, or account call anywhere. The existing `test_ibkr.py` pin that no order call exists moves with the code, and the Go side gets the same grep-style test. The streaming-line cap is 70 (the existing slot allocator's number).
- At the bridge: the edge answers only with `IBKR_EDGE_TOKEN`; the VPS bridge never sees IBKR credentials.

### 5.4 Heartbeat, liveness, and the reason vocabulary

| Check | Interval | Result |
|---|---|---|
| Edge to gateway: `reqCurrentTime` plus `isConnected()` | 15 s | Socket refused: `gateway_down`. Connected: go on. |
| IB status codes on the session | On event | 1100: `farm_down` (connectivity lost). 2103/2105: `farm_down` (data farm). 10197: `competing_session`. 354: `not_subscribed`. 1101/1102/2104/2106 clear these. |
| Sentinel line: SPY stays subscribed during gateway hours | Every tick | Newest tick older than 30 s in regular hours: `stale`. Market-data type 3 or 4: `delayed` (served, labeled `delayed-15m`). |
| Bridge to edge: `WatchStatus` heartbeat | 5 s | 3 missed: `edge_unreachable` (the laptop is off, asleep, or off the tailnet). |
| Gateway hours | Clock | Outside the hours, with the gateway down: `off` (expected), not an incident. |

The UI turns these into words (§6). One Telegram system alert (in-app inbox until the owner creates the bot) fires when `ibkr` is not OK by 09:25 ET on a trading day inside gateway hours. It reuses the existing `re-login-reminder` system-alert category (02c Phase 3) and fires at most once a day.

### 5.5 The honest "gateway off" state

- The status bar's quotes stamp carries the serving vendor and quality, for example "Quotes · Alpaca · 15-min delayed". Its tooltip gives the reason: "IBKR gateway is off (outside its hours)" or "IBKR gateway isn't reachable — the laptop may be asleep".
- Nothing delayed is ever labeled realtime. Strategy alerts evaluated on delayed data keep today's delayed stamp (02m).
- `/status` keeps its `gateway` field (four states) and gains `gateway_reason`. `data_sources` reports the serving vendor per class instead of today's `"mixed"` guess.

## 6. UI: the provider toggle on `trading.tobytran.dev`

- **Where:** Settings (desktop, 1440 and 1180), a **Market data** card that replaces today's `MarketDataStatus` and `SourcesStatus` lines.
- **Rows:**
  - "Stock quotes". From B3.
  - "Option chains". Before B6 the row reads "Alpaca (delayed) · provider choice arrives with covered-call options".
  - "Bars". Read-only, Alpaca.
- **Each row** is a radio group: IBKR, Longbridge, Alpaca, marketdata.app.
  - Every option shows a state in words, never by color alone: "Live · realtime", "Gateway off (outside 08:00–17:00 ET)", "Gateway not reachable", "Signed in elsewhere — IBKR stopped the data", "No account yet", "No key yet".
  - marketdata.app is disabled on the stocks row with "Options only: its stock quotes are 15 minutes delayed on every plan".
  - A disabled option carries `aria-disabled` and its reason as text.
- **Below each row:** "Serving now: Alpaca · 15-min delayed · because the IBKR gateway is off", plus "Routing syncing…" while the bridge holds the env default.
- **Shadow mode (B2):** the card carries a "Preview" badge and reads "The Desk still shows Alpaca. This is what the bridge would serve."
- **Who can change it:** the owner can. The wife sees the same card read-only, with "Only the owner changes data providers" (§11 Q6). Mobile shows read-only status rows; the Desk is desktop-first.
- **Errors:** a `422` reason shows inline under the row. A configured-but-down choice saves with the warning "Saved. IBKR is off right now, so Alpaca serves until it's back."
- **Paper mock sync is required before any frontend code** (standing rule): stage M below. Duplicate the current Settings desktop board into "R3 · Desk · Settings · Market data · desktop" (1440) plus a states board covering live, gateway off (expected), not reachable, competing session, syncing, shadow preview, read-only view, and 1180. The owner approves before B2's frontend starts.

## 7. Rollout stages

Every stage ends with its gates green plus the **dual-agent post-phase walkthrough** (STATUS 2026-10-30, standing): Hermes and Claude Code both walk the Desk end to end, log defects in `DEFECTS.md`, and fix the UI/UX inside the stage. Backend-only stages (B0, B1, B5) still walk the status bar, Settings, and every stamped screen for regressions. Stages ride phase pull requests per the CI-conservation rule.

| Stage | What | Exit gate |
|---|---|---|
| **B0** Bridge dark | Real `.proto`, Go module, Alpaca adapter (quotes, bars), router, config validation, status, auth; bake target, compose entry, smoke. No consumer. | Go tests and conformance green; `smoke-test.sh` reaches `/healthz` and `ListProviders`; deployed dark |
| **B1** IBKR edge | **Step 1: the Gateway probe that 02d never recorded** (Task 0.5 Steps 1–2, on the laptop; confirm the $14.50 bundles are active). Then the edge (language per §11 Q1), the remote rung, the Tailscale sidecar and ACL, and the ritual runbook in 02e. | Five symbols match the wife's TWS during the ritual; laptop asleep gives `edge_unreachable` within 15 s; a sign-in elsewhere gives `competing_session` |
| **M** Paper mocks | §6 boards synced and approved | Owner approval |
| **B2** Shadow | `providers/bridge.py` registered, in no chain. A Desk scheduler job (`bridge_shadow`) runs every 5 minutes in regular hours on the watchlist: direct chain against bridge (`pin_provider`), logging JSON lines (price gap in bps, quality, latency). Toggle ships in shadow mode, storing and syncing routing. | 5 trading days: bridge-vs-direct Alpaca price gap 0 bps on the same feed; no mislabeled quality; p95 under 300 ms (IBKR snapshots excluded); walkthrough done |
| **B3** Quotes flip | `DATA_PROVIDERS_QUOTES=bridge,alpaca` in `ai-trading/desk`; toggle live; `/status` from the bridge. Rollback is one Firestore value plus a redeploy. | Live-data acceptance (02l e5): five symbols match TWS during the ritual; gateway off shows the honest state; walkthrough done |
| **B4** Longbridge stocks | **Gated on the owner:** account opened, US-resident eligibility and L1 source confirmed (support email, comparison doc §6). Go adapter through the SDK (bid and ask from Depth); ladder `ibkr,longbridge,alpaca`. | Goldens and live check; toggle offers Longbridge; walkthrough done |
| **B5** Bars plus 01m | `DATA_PROVIDERS_BARS=bridge,alpaca`; 01m `PRICE_PROVIDER=bridge`; 01m's `alpaca.py` deleted after one clean week | ai-hedge-fund smoke unchanged; 01m tests green |
| **B6** Options (covered calls) | **Owner phase order: later.** OPRA add-on bought; Longbridge per-contract option quotes; marketdata.app adapter (only once the owner buys the plan); `DATA_PROVIDERS_OPTION_CHAIN=bridge,alpaca_options`; toggle's options row live | Covered-call scan matches a manual chain read for 3 underlyings; walkthrough done |
| **B7** Retire | Remove `ibkr` from `REGISTRY`; drop the safety rungs after 20 clean days; delete the Python `marketdata_app` (§11 Q9); `tradier` stays dormant | Registry tests updated; walkthrough done |

### 7.1 Deploy shape (B0)

- `ai-trading/deploy/docker-bake.hcl`: target `market-data-bridge` (context `ai-trading/market-data/bridge`, tag `ai-trading-market-data-bridge`), added to the default group. `docker-bake.ci.hcl` gets its GHA cache scope.
- `ai-trading/deploy/production/docker-compose.yml`:
  - Service `market-data-bridge`: `env_file` `market-data-bridge.env`, `read_only: true`, `no-new-privileges`, `mem_limit: 128m`, healthcheck `["CMD", "/bridge", "healthcheck"]`.
  - Service `bridge-tailscale` (from B1). The bridge uses `network_mode: service:bridge-tailscale`, and the sidecar joins a new internal network `marketdata`, shared with `api`, `scheduler`, and (B5) `market-data`. No host port is published.
- `deploy.sh` renders the new profile like the others. Run `test-deploy-firestore.sh` and `smoke-test.sh all` after the change (ai-trading AGENTS.md).
- **Go toolchain in CI:** `go test ./...`, `go vet`, `buf lint`, `buf breaking` against `origin/dev`, and a check that `buf generate` leaves no diff. Dependabot gets a `gomod` entry. All of this rides existing phase pull requests.

## 8. Tests, observability, and the stage gate

### 8.1 Tests (all offline in CI)

- **Go adapters:** `httptest` servers replay recorded vendor JSON (Alpaca, marketdata.app). Longbridge sits behind a small interface over the SDK's `QuoteContext`, with a fake, because its socket protocol has no recordable REST.
- **Router:** ladder order; preference to head; down rungs skipped; the fall-through taxonomy; outage reported ahead of `NoData`; pin with no fallback; quality never upgraded; `marketdata_app` in an equities ladder is a startup error.
- **Status:** a fake clock drives every §5.4 transition (missed heartbeat to `edge_unreachable`, 10197 to `competing_session`, the stale sentinel, expected `off` outside hours).
- **gRPC conformance:** one suite runs every RPC through an in-process connect server over gRPC (grpc-go), gRPC-Web, and Connect JSON, and asserts identical results. This proves the Python JSON path equals the gRPC wire. `buf breaking` guards compatibility.
- **Cross-language contract goldens:** `testdata/contract/*.json` holds canonical responses. The Go server tests produce them, and the Python `bridge` adapter tests and 01m's `bridge_prices` tests replay the same files.
- **Python:** the adapter with the fake HTTP layer (`testing.py`); registry tests (`enabled` false without a URL, so Alpaca stays primary and unrelabeled; `bridge` never last; the `RoutingSource` lookup); the Desk import-boundary test unchanged; the routing route's validation (`422` cases, owner-only).
- **Edge:** the existing `GatewayConnection` fakes plus the read-only pin.
- **Desk web:** Playwright on the stub platform for every §6 state at 1440 and 1180; unit tests for the state-to-words mapping.

### 8.2 Observability

- One JSON log line per bridge request: class, preferred, served by, quality, fallback reason, attempts, latency. Never tokens or query strings.
- `ProviderHealth.counters` (rolling 15 minutes) feed the Settings card and a `bridge status` CLI subcommand. Shadow results are the JSON log lines, summarized at the B2 gate with one `docker logs | jq` command recorded in the runbook.
- Alerts: the 09:25 ET gateway alert (§5.4), and "bridge unreachable from the Desk for 5 minutes", sent to the in-app inbox (Telegram once the bot exists). Meanwhile Python's chain is already serving Alpaca labeled `fallback`.

## 9. Risks

1. **No official Go IB client.** IBKR ships Java, Python, C++, and C# clients; Go has community ports only. Mitigation: the edge boundary is the proto, so the edge can be Python on `ib_async` (already probed and built) while the bridge stays Go (§11 Q1).
2. **Longbridge may never qualify:** US-resident eligibility, the L1 source, ToS for a family app, and option fields are all unverified. The ladder works without it; B4 and B6 are owner-gated.
3. **marketdata.app tier:** the comparison doc says $30 Starter gives 15-minute-delayed options, and real-time options need the $75 Trader plan plus an OPRA entitlement of unknown cost. That conflicts with "real-time options fallback at $30" (§11 Q3).
4. **One session per login:** any sign-in as the data user elsewhere stops the data (10197). Detected and named, but a person can still cause it.
5. **The laptop is a consumer machine:** sleep, Wi-Fi, updates. Every failure lands on a lower rung with a named reason; nothing blocks.
6. **Licensing:** the shared non-pro IBKR subscription is a known gray area the owner accepted (2026-10-10). Longbridge and marketdata.app terms forbid redistribution, so the bridge has no public route; it serves family apps only.
7. **Two paths during migration** (direct Python and bridge): time-boxed by the B2 and B3 gates and the 20-day safety-rung rule.
8. **A new language and toolchain** (Go, buf, Tailscale) in a small repo: more CI steps and Dependabot traffic. Kept to one module and one binary.
9. **Label drift:** a fallback that mislabels quality would mislead a trader. Guarded by the router test that quality only ever comes from the serving provider.
10. **The 02j "fallback" label is coarse:** Python's chain says `fallback` rather than "delayed via Alpaca" when the bridge itself is down. Acceptable: the stamp's provider field still says Alpaca.

## 10. Doc cleanup proposal (inventory of `ai-trading/plans/**`)

**Applied in this run** (a separate commit, `docs(ai-trading): mark superseded market-data text`; additive dated notes or status corrections only, every claim backed by STATUS or the 2026-10-31 decisions):

| File / section | Change | Reason |
|---|---|---|
| `STATUS.md` row S0 | Dated "superseded in part" note | Gateway rejection reversed; Alpaca gate changed (02b §4d) |
| `STATUS.md` row 5Q | Dated "Tradier dormant" note | Owner declined Tradier 2026-10-31 |
| `STATUS.md` row 5+/P0 | Dated note: no probe result recorded; B1 re-runs it | "Next: probe Mon 2026-10-26" is stale |
| `02b` §6 bench, marketdata.app row | Replace "Trader $30 … real-time stock quotes" with the verified facts | Wrong: stock quotes are delayed on every plan; Trader is $75 |
| `02e` top | Dated note: the gateway runs on the Ubuntu laptop with a daily ritual (02t §5); Step 5's Mac install and "signed in all week" are superseded | Host and cadence changed |
| `02d` status line, `phase-0-spike.md` header | Dated note: the Gateway probe moves to 02t B1 | Stale 2026-10-26 schedule |
| `01k` status | "Superseded by 01m (implemented 2026-10-10)" | Says "nothing is implemented", but 01m is live |
| `01m-market-data-adapter.md` status | "Implemented and live 2026-10-10; successor 02t" | Says "draft for owner review" |

**Proposed for Hermes (judgment calls, not applied):**

| File / section | Proposal | Reason |
|---|---|---|
| `02b` §4, §4b, §4c, §4d | Fold into one "Current decision" section plus a dated history list | Four stacked revisions; a reader must diff them |
| `02b` §5 hybrid-store table | Rewrite the live-source column (option chains: Longbridge, marketdata.app, Alpaca; futures deferred) | Rows still say "IBKR snapshots" for chains |
| `02b` §7 unverified items | Close the items 02d answered; move the rest to 02d | Duplicated spike list |
| `02b` §4c "store the key in `ai-trading/market-data`" | Point bridge-served providers at `ai-trading/market-data-bridge` (02t §3.4) | Profile changes with the bridge |
| `02j` §8 "registered for config selection" | After B7, replace with the bridge seam | Describes the direct-provider era |
| `02n` banner (lines 12–15) and §e | Add a 2026-10-31 note: "IBKR slot" returns for quotes through the bridge; chains stay Alpaca until B6 | The 2026-10-29 banner said IBKR is Flex only |
| `02m` §b4 item 3 | Mark superseded by 02t (the bridge owns IBKR; never `DATA_PROVIDERS_QUOTES=ibkr,alpaca`) | The direct `ibkr` provider stays off |
| `02l` lines 124 and 289 | Replace the "Mon 2026-10-26 probe" wording with 02t B1 | Stale schedule |
| `02a` §6 (`ib-gateway` + IBC with paper orders) and the STATUS constraint "IBKR paper orders placed by strategies" | Hermes rules whether "never orders" (decision 7) retires Desk v1's IBKR paper orders (§11 Q11) | Possible conflict |
| `STATUS.md` Open Questions, "Pending IBKR sequence" | Re-plan: cron `caae82600785` targeted 2026-10-26; the UAR grant and Flex migration are still open; the probe moves to B1 | Stale schedule, live items |
| `STATUS.md` 2026-10-10 decision row (IBKR data username) | Add "reinstated for live quotes via 02t, 2026-10-31" | Twice reversed |
| `01l-hub-hostname-move.md`, `02s`, `02n`, `02o` status lines | Correct to delivered or built, per STATUS rows | Stale "draft" or "planned" status; other lanes, so not touched here |
| `02d` (whole) | Close the spike after B1 with the gateway layout (one laptop gateway, read-only, no orders) | In progress since 2026-10-10 |
| `plans/handoffs/*.md` | Keep | Labeled historical and referenced by AGENTS.md and STATUS; not dead |
| `ai-trading/temp/market-data-comparison-20261030.md` | Not touched (gitignored scratch); its "IBKR rejected" baseline line is stale | Scratch, untracked |
| Python docstrings (`registry.py`, `providers/tradier.py`) naming Tradier as selectable | Add "dormant, owner declined" at the next code-touching stage (B2) | Code; docs-only run |

## 11. Open questions for Hermes rulings

1. **IBKR edge language.** The recommendation is a Python edge reusing `providers/ibkr.py` and `ib_async` (probe-pinned, already tested) behind the bridge proto, with grpcio on the laptop only. The alternative is Go on a community IB client, since IBKR has no official Go API. The bridge itself stays Go either way.
2. **Python seam transport.** The recommendation is Connect unary JSON over the existing `requests` client: no new dependency, no Python codegen, and 01m stays stdlib, with the same proto and server proven equal by the conformance suite. The alternative is grpcio stubs, the strict gRPC wire the brief named.
3. **marketdata.app tier.** The $30 plan gives 15-minute-delayed options per the comparison doc; real-time options need the $75 Trader plan plus an OPRA entitlement. Is a delayed options fallback acceptable at $30, or must the fallback be real-time?
4. **The VPS-to-laptop link.** The recommendation is an app-scoped Tailscale sidecar container plus an ACL in Terraform under `infrastructure/`. The alternative is host-level Tailscale on the shared VPS (touches the expense stack's host).
5. **Is IBKR an options rung** when the gateway is on (OPRA L1 is in the $4.50 bundle), or stocks-only per the owner's mix?
6. **Who flips the toggle:** owner-only (recommended; the setting is family-wide and has cost effects) or both users.
7. **Are the $14.50 IBKR bundles still active** after the 2026-10-29 revision? B1 step 1 runs the never-recorded Gateway probe.
8. **Layout:** the Go bridge at `market-data/bridge/` with 01m's Python facade left at `market-data/` (recommended), or move the facade to `market-data/fd-compat/` at B7.
9. **Python `marketdata_app` (and later `alpaca_options`):** delete after Go parity (recommended) or keep dormant like `tradier`.
10. **`trades` and `universe`** (Alpaca-only, used by Practice): stay direct Python (recommended) or move into the bridge for full provider independence.
11. **Does decision 7 ("never orders") retire Desk v1's IBKR paper orders** (02a §6; STATUS constraint)? The Practice lane already replaced paper trading in the desktop MVP.
12. **The family-scoped routing row:** a new small table (recommended), or an owner-only key in the per-user settings JSON.

### Rulings (Hermes, 2026-10-31; do-not-reopen)

1. **IBKR edge = Python** (`providers/ibkr.py` + `ib_async`), speaking the same Connect protocol as every other client — IBKR has no official Go API and the built, probe-pinned client wins; the "grpcio on the laptop" caveat is dropped with ruling 2. The bridge itself stays Go.
2. **Connect unary JSON for the Python seam, APPROVED** — connect-go serves native gRPC, gRPC-Web, and Connect on the one port (§3.1), so the bridge is a real Go gRPC service while Python adds no dependency and no codegen; any future strict-gRPC consumer uses the same service unchanged.
3. **$30 delayed marketdata.app is the options fallback** — the owner named the $30 plan, and 15-minute-delayed chains are acceptable for covered-call scanning. Escalating to the $75 Trader plan plus an OPRA entitlement needs an explicit owner decision at B6, only if Longbridge's real-time options disappoint.
4. **Tailscale sidecar plus Terraform ACL under `infrastructure/`, APPROVED** — infrastructure as code, and the shared VPS host stays untouched.
5. **IBKR is an options rung while the gateway is on** (OPRA L1 rides the ~$4.50 add-on); the options ladder is `ibkr → longbridge → marketdata_app → alpaca` (indicative floor). Stocks-first phasing is unchanged (B6 remains the options stage).
6. **Owner-only toggle** (the `PUT /api/desk/settings/market-data` route is owner-only via `DESK_OWNER_EMAILS`); the wife sees the card read-only.
7. **Not a ruling — a B1 verification:** the Gateway probe (B1 step 1) confirms whether the $14.50 bundles are still active; if they lapsed, re-subscribing is a one-time owner dashboard action.
8. **Go bridge at `market-data/bridge/` with the 01m facade left at `market-data/` root, APPROVED**; revisit only at B7.
9. **Delete `marketdata_app` (and later `alpaca_options`) after the Go adapter passes the shared goldens (B7)**; `tradier` stays dormant for good (decision 2).
10. **`trades` and `universe` stay direct Python** — Alpaca-only kinds the Practice lane depends on; provider independence is not needed there.
11. **Yes — 02a §6's IBKR paper orders are superseded in docs** by the standing no-orders rule and the Practice lane (docs only; no order code exists).
12. **New family-scoped routing table, APPROVED** (one small migration; version, updated_by, updated_at) — not a per-user settings key for a family-wide value.
