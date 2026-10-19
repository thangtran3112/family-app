# Trading Hub 01n: research dashboard delivered

## Delivered state

- Live dashboard: https://tradingagents.tobytran.dev/research
- Hub: https://trading-hub.tobytran.dev/ → TradingAgents → Research dashboard.
- Dev PR [#108](https://github.com/thangtran3112/family-app/pull/108) merged as `2b5c6e6bb823df8f5ce60834b0d458b3396d2189`.
- Scoped Main release [#109](https://github.com/thangtran3112/family-app/pull/109) merged as `2dd31c4835de1205c52bac6e7b4157a74b4f89c6`. No unrelated Desk or expense runtime paths were released.
- Release CI [38118793865](https://github.com/thangtran3112/family-app/actions/runs/38118793865), backend deploy [38119638236](https://github.com/thangtran3112/family-app/actions/runs/38119638236), and Hub-static-only upload [38120840475](https://github.com/thangtran3112/family-app/actions/runs/38120840475) succeeded.
- Secret-safe VPS inspection confirmed the release tag, healthy owned services, no research subnet conflict, and MiroFish still enabled. No activation/stop dispatch was used.

## Verification

- Fresh checks in the main checkout: **123 backend tests**, **5 native UI tests**, **67 Hub tests**, Ruff clean, and **54 deployment/rollback cases with zero failures**. The Hub's existing Node module-type warning remains unchanged.
- Final release CI also exercised the research image, full real-Caddy smoke tests, frontend build/static uploader, Compose, and script lint checks.
- Two actual sponsored-provider AAPL research requests completed with different IDs, full market/final reports, ready exports, no error, and no partial flag. Reopening the first research URL retained its results. Both records are private after the sharing check.
- Actual signed-in Chrome Beta checks covered the Hub CTA opening the dedicated dashboard, root history/detail, `/u/tradingagents/research` history/detail, report preview, and all three download links. Anonymous API requests with a forged identity header returned **401** on both host/prefix deployments.
- Browser-saved downloads were rechecked: Markdown **23,107 bytes**, HTML **53,457 bytes**, ZIP **37,123 bytes**. The ZIP has **11 allowlisted report entries**, with embedded Markdown/HTML matching the standalone downloads. HTML contains CSP and no scripts or images.
- Owner sharing enable/revoke passed through the live UI. Authenticated recipient privacy/read-only/revoke enforcement passed synthetic fixtures behind the actual Caddy gate; no second real live family session was available. Do not label that recipient check as live multi-user verification.
- Full-history filters, pagination reset, URL restoration, mobile/root/prefix behavior, held stale responses, loading focus, and owner-transition cleanup passed the recorded isolated browser checks.

Private IDs/URLs, report bodies, identities, and credentials are intentionally absent. Detailed execution receipts were preserved in the phase's ignored `.superpowers/sdd/01n-tradingagents-research-implementation/` workspace; protected browser downloads remain outside the repository.

## Compatibility and operational limits

- Upstream `packages/trading-agents` source and pin remain unmodified. Compatibility inventory and checks live in **`ai-trading/tradingagents-web/DIVERGENCE.md`**, also copied into the research image; do not add a local-only divergence file inside the upstream submodule.
- One active research subprocess; other starts receive **409 Busy**. A restart marks unfinished work Interrupted, never automatically reruns paid/provider work. Run again creates a new ID.
- Real historical import remains intentionally unperformed: the operator must supply an explicit owner key and a read-only legacy source. No ownership is inferred from paths or timestamps.
- Deferred minors: favicon 404 noise; broader automated DOM/CTA regression coverage. The date-boundary and ticker-help-ID review suggestions were addressed, not deferred.
- Main checkout user-modified TradingAgents submodule and untracked `opencode.jsonc` were preserved. Do not reset, deinitialize, or include them in this phase's commits.
- These receipt/tracker-only changes should ride the next meaningful phase PR, not consume another standalone CI/release cycle.

## Rulings carried from execution

1. Parallel workers used separate worktrees and exclusive files because the owner requested parallel execution; dependency/review gates remained. **Cost if wrong:** interface integration rework.
2. Research uses separate `ta-research-data`; legacy `ta-data` stays unchanged and operator import mounts it read-only. The arbitrary-save-path terminal must not write private/shared research. **Cost if wrong:** one extra volume and explicit import/backup handling.
3. Unmodified upstream Windows-mock tests on macOS used a test-runner-only `errno.EDEADLOCK=errno.EDEADLK` alias, with no source patches/skips. **Cost if wrong:** platform simulation differs; Linux image/gateway checks remain necessary.
4. Existing owner-scoped Store filters were wired through API/UI, and the raw 64-character ticker guard added before normalization, to satisfy the approved spec. **Cost if wrong:** exact canonical-symbol filtering differs from page-local substring search; labels/validation and browser checks must stay aligned.
5. The publication scanner suppressed only source-verified exact nonsecret fixture/loopback spans, never global rules or real credentials. **Cost if wrong:** an exact span could be misclassified; source-context verification limits the risk.
6. API-provided today follows the same server-local date validator, without relaxing the future-date rule or adding timezone configuration. **Cost if wrong:** changing server timezone changes the default analysis day.
7. One sanitizer at the domain/public-view boundary filters report state/settings, reused by reports, rather than trusting every future producer. **Cost if wrong:** legitimate new upstream fields wait for compatibility review.
8. Shared safe settings retain actual upstream `deep_think*`, `quick_think*`, and `max_*` metadata names rather than guessed aliases. **Cost if wrong:** future schema changes require allowlist maintenance.
9. The backend uses a separate research Docker network with the gateway as its sole production peer; legacy terminal peers cannot forge trusted research identity headers. **Cost if wrong:** bridge/local-router and network-smoke maintenance.
