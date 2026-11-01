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
| [ADR-0016](adr/ADR-0016-practice-broker-ticket.md) | Practice trades through a broker-style ticket (Market/Limit/Stop/Stop-limit; Bracket named, not simulated): a stop is optional, cash is the only size rule, limit/stop fills come from the replayed tape |

Changelog: one line per shipped phase in [changelog/CHANGELOG.md](changelog/CHANGELOG.md); session handoffs moved in from `plans/handoffs/` stay there as the session-level log.
