# Decisions

Durable choices the ai-trading phases made, in ADR style. Each ADR is one file under `adr/`; the deliveries that proved it sit beside it in `changelog/`. The active plans under `../plans/` keep only future work and link here for anything already decided.

Index:

| ADR | Decision |
|---|---|
| [ADR-0001](adr/ADR-0001-provider-mix.md) | Provider mix: IBKR Gateway + Alpaca + Longbridge, marketdata.app options-only, no Tradier |
| [ADR-0002](adr/ADR-0002-alpaca-deferral.md) | Alpaca $99 tier deferred until the app is proven and the wife is pro-level |
| [ADR-0003](adr/ADR-0003-bridge-architecture.md) | Market data is an independent Go gRPC/Connect bridge; Desk calls it through the registry |
| [ADR-0004](adr/ADR-0004-adapter-pattern.md) | Adapter/wrapper pattern: every provider is an adapter behind `DataSources` |
| [ADR-0005](adr/ADR-0005-ibkr-gateway-reentry.md) | IBKR Gateway back in on the spare Ubuntu laptop with a daily on/off ritual |
| [ADR-0006](adr/ADR-0006-owner-only-toggle.md) | Provider toggle is owner-only; the wife's view is read-only |
| [ADR-0007](adr/ADR-0007-firestore-config.md) | Every secret and env value lives in Firestore `family-config`, never in the repo |
| [ADR-0008](adr/ADR-0008-scoped-releases.md) | Scoped releases: one batch, one PR to `dev`, ai-trading-only path to `main` |
| [ADR-0009](adr/ADR-0009-dual-walkthrough-gate.md) | Dual-agent post-phase walkthrough before a phase is done |
| [ADR-0010](adr/ADR-0010-data-honesty.md) | Honest data states: no fabricated value, no fake label, every stamp says its source |
| [ADR-0011](adr/ADR-0011-packages-layout.md) | `consensus/` and `market-data/` live under `packages/` |
| [ADR-0012](adr/ADR-0012-plans-for-future.md) | `plans/` keeps future phases only; completed detail lives here |
| [ADR-0013](adr/ADR-0013-ci-deployment-only.md) | CI is deployment-only: ai-trading and expense-tax tests are local gates; `dev` ruleset check still to drop (owner). Superseded for ai-trading by ADR-0015 |
| [ADR-0014](adr/ADR-0014-global-ui-modes.md) | Three global UI modes (Fundamental/Technical/Backtest) scoped by a declarative route/tab/section seam; Backtest owns Practice |
| [ADR-0015](adr/ADR-0015-reenable-ci-tests.md) | ai-trading CI runs the test gates again on PRs and pushes to `dev` (free public-repo minutes); `main` stays deploy-only |
| [ADR-0016](adr/ADR-0016-practice-broker-ticket.md) | Practice trades through a broker-style ticket (Market/Limit/Stop/Stop-limit; Bracket named, not simulated): a stop is optional, cash is the only size rule, limit/stop fills come from the replayed tape; amended: one average-cost position per name takes any number of fills (scale in, sell part, flip) |
| [ADR-0017](adr/ADR-0017-thread-clock.md) | A day-trade thread has one clock for every ticker: Play, Step, speed, Jump and the time sit in a thread bar above the chart, never under one name; Step measures from the shared day clock; the name's own chart controls stay under its chart |
| [ADR-0018](adr/ADR-0018-server-thread-clock.md) | The day-trade thread's clock runs on the server (lazy settle of `clock + speed x wall time`, survives navigation and logout); Play, Step, speed, Jump and Skip day move to the Summary and leave every chart; the account is priced at the clock; clients poll every 2 s (push rejected: no-lookahead forbids a client-side balance); every Buy and Sell is listed from the server; the Order tab picks no stock |
| [ADR-0019](adr/ADR-0019-away-orders-fill.md) | A resting order the clock reaches while she is away fills at its bar (booked when the name is lifted or the day ends), it is no longer cancelled |
| [ADR-0020](adr/ADR-0020-immersive-broker-presentation.md) | Practice reads as a neutral broker terminal, not a tutorial: no guided chart marks, number-only levels with hover meaning, click-price-to-order, a broker positions list, a list-only day view, progress+repopulate re-scan, a Peek drawer, no keyboard shortcuts, the technical indicators in the replay left rail, and no Back/End-day bar on a day chart |
| [ADR-0021](adr/ADR-0021-replay-detached-tasks-bounded-pool.md) | Practice replay preps and re-scans run on a detached daemon thread (not a request background task) so the request's day-list lock is released at return, and the API pool is bounded with lock and idle-in-transaction timeouts so one stuck holder returns 503 instead of deadlocking the whole origin |
| [ADR-0022](adr/ADR-0022-one-thread-time.md) | Every surface of a day thread pins one time (thread_time on each payload, one derived extended tape end, one quote_at price, one server computation of price+indicators, reads move nothing, no lookahead); dates are visible always (no spoiler), the practice window / stop-on-entry / 11:30 mark are removed, and a day thread is capped at 10 active across users with 49 names per list |
| [ADR-0023](adr/ADR-0023-open-to-open-days-jump-no-end-day.md) | A day-trade day runs open to open: Skip day and the hand-over land on the 9:30 open (never the plan's Start at), the hand-over is the one end of a day and stores its review, End day is removed (409; closing a day thread ends its day), Jump (`POST /threads/{id}/clock {to}`) is bounded by the plan's end, and a list is not served before its list time |

Changelog: one line per shipped phase in [changelog/CHANGELOG.md](changelog/CHANGELOG.md); session handoffs moved in from `plans/handoffs/` stay there as the session-level log.
