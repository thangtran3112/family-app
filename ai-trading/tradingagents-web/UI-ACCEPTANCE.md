# TradingAgents research UI acceptance

Task 5 UI checks are native and isolated from production APIs. The shell reads its trusted prefix from `data-app-prefix`; it only calls the locked `/api/research` endpoints and never supplies mocked research data.

## Implemented UI checks

- List and detail routes preserve the validated root or `/u/tradingagents` prefix; history navigation uses `pushState` and browser Back/Forward uses the same route handler.
- Dashboard supports page-local ticker/status filters, 25-record pagination, private-by-default run labels, imported-origin/partial labels, and explicit Unknown values for absent imported metadata.
- New research uses labeled native ticker/date/asset/depth controls and analyst checkboxes. Crypto disables the fundamentals analyst. A POST happens once after explicit submit; rerun only prefills a new form.
- Detail displays status/stage, real input and allowlisted model/round settings, report sections, and downloads only when `artifacts_ready` is true. Preview iframe is sandboxed without script permissions and cache-keyed by the public `updated_at` value (the locked DTO has no separate snapshot-version field).
- Only `can_share` owners get enable/revoke controls. Recipient UI is read-only. Copy confirmation follows successful clipboard resolution; failure exposes a selectable URL. UI warns downloaded copies cannot be revoked.
- Old fetches are aborted on navigation. Visible running list/detail views refresh every three seconds; hidden pages pause polling and refresh when visible again.
- Keyboard focus, form error summary, live status messages, and compact mobile cards are included.

## Pending integration acceptance

Task 4 must wire package-local `ta_web/static/` shell/assets, replace prefix markers, and connect locked API DTOs before browser verification. With that backend in place, exercise delayed stale responses across two details, recipient read-only state, clipboard rejection fallback, crypto fundamentals disablement, real attachment bytes, and desktop/mobile layout. Real auth, sharing authorization, backend-generated preview safety, and actual downloaded-file contents are not verified by this UI-only task.
