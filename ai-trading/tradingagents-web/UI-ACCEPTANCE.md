# TradingAgents research UI acceptance

Task 5 UI checks are native and isolated from production APIs. The shell reads its trusted prefix from `data-app-prefix`; it only calls the locked `/api/research` endpoints and never supplies mocked research data.

## Implemented UI checks

- List and detail routes preserve the validated root or `/u/tradingagents` prefix; history navigation uses `pushState` and browser Back/Forward uses the same route handler.
- Dashboard supports ticker/analysis-date/status filters applied server-side across the caller's whole history (not just the current page, final-fix wave; spec §5), 25-record pagination, private-by-default run labels, imported-origin/partial labels, and explicit Unknown values for absent imported metadata. Changing a filter resets to page one.
- New research uses labeled native ticker/date/asset/depth controls and analyst checkboxes. Crypto disables the fundamentals analyst. A POST happens once after explicit submit; rerun only prefills a new form.
- Detail displays status/stage, real input and allowlisted model/round settings, report sections, and downloads only when `artifacts_ready` is true. Preview iframe is sandboxed without script permissions and cache-keyed by the public `updated_at` value (the locked DTO has no separate snapshot-version field).
- Only `can_share` owners get enable/revoke controls. Recipient UI is read-only. Copy confirmation follows successful clipboard resolution; failure exposes a selectable URL. UI warns downloaded copies cannot be revoked.
- Old fetches are aborted on navigation. Visible running list/detail views refresh every three seconds; hidden pages pause polling and refresh when visible again.
- Keyboard focus, form error summary, live status messages, and compact mobile cards are included.

## Integration and browser verification status

Task 4's backend wiring (package-local `ta_web/static/` shell/assets, prefix markers, locked API DTOs) landed and is integrated. An isolated-Playwright/local-ASGI browser pass (synthetic identity, real `create_app`/`Store`/publisher, no production auth, no model/provider call — see `browser-qa-report.md` in the SDD ledger, not reproduced in this file) verified, against that integration: delayed-stale-response navigation across two details, recipient read-only state with clipboard-rejection fallback, crypto fundamentals disablement, real MD/HTML/ZIP attachment bytes, and desktop/mobile layout — all PASS. A real-provider research run was also separately verified structurally (`real-research-report.md`), not through this UI.

**Not yet browser-verified:** the server-side ticker/analysis-date/status history filters above (final-fix wave) are covered by backend unit/API tests only (`tests/test_api.py`) — no isolated-Playwright pass has exercised the filter controls themselves yet. **Still pending regardless of UI checks:** real production Caddy/Clerk auth gate, live deploy, and actual downloaded-file contents against a real family session — those require production rollout, not a UI-only verification pass.
