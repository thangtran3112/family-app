# ADR-0004: Adapter/wrapper pattern

Status: accepted 2026-10-31 (owner). Sources: [02j](../../plans/subplans/02j-common-data-providers-design.md), [02b §4](../../plans/subplans/02b-desk-market-data-options.md).

Decision: every data provider is an **adapter behind `ai_trading_common.registry.DataSources`** (bars, quotes, universe, targets, ...). Callers use the chains; nothing imports a provider module directly. A missing key means that rung is honestly unavailable, never an exception in the user's face; paid tiers arrive later as keys plus env only.

Consequences: Tradier and marketdata.app adapters ship registered but in no default chain; the Go bridge enters as one more `bridge` provider; the Python `marketdata_app` adapter is removed only after Go parity; every adapter stamps its own vendor + quality so the UI can show them.
