# Changelog

One line per shipped phase. Session-level detail lives in the matching handoff (`../plans/handoffs/`); design detail in the ADR it proved.

- **5R (2026-10-31):** Tradier + marketdata.app adapters behind the registry, in no default chain. PR #206 → `dev`, release #207 → `main`, deploy 41166875184. [ADR-0004](../adr/ADR-0004-adapter-pattern.md)
- **5S/B0 (2026-10-31):** 02t plan, Hermes 12-ruling review, Go gRPC/Connect bridge deployed dark. Same PR/release/deploy as 5R. [ADR-0003](../adr/ADR-0003-bridge-architecture.md)
- **5T (2026-10-31):** data-refresh fix (chunked upserts, honest empty passes, job logging). PR #208 → `dev`, release #209 → `main`, deploy 41184467041. [ADR-0010](../adr/ADR-0010-data-honesty.md)
- **5U (2026-10-31):** Alpaca 1-day midnight-ET window fix in the adapter. PR #210 → `dev`, release #211 → `main`, deploy 41190745321; live strip `as_of` = 2026-10-30 for SPY/QQQ/IWM. [ADR-0010](../adr/ADR-0010-data-honesty.md)
- **CI deployment-only (2026-10-31):** `ai-trading-ci.yml` removed; ai-trading suites are local gates. `expense-tax-ci.yml` stays (blocked). Branch `feature/ci-deploy-only`, PR pending. [ADR-0013](../adr/ADR-0013-ci-deployment-only.md)
- **Fundamental lane (2026-10-29):** Today/Holdings/Covered-calls/Stocks/Settings live with migration `0012`. PR #202 → `dev`, #203 → `main`, deploy 40967404817.
- **Threads/market-data phases (2026-10-25..27):** per-row/multi-thread practice hub, resume flow, thread management, DB `0011`. PRs #178/#179, #185/#186/#188, #196–#201.
