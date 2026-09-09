# Phase 0F: Capture PWA Implementation

Approved source: `plans/mockups/rebaseline/capture/`, Phase 0C + 0P.

Delivered `frontend/capture-web` (Next 16 App Router, React 19):

- Routes: `/capture`, `/queue`, `/inbox`, `/settings`, customer
  `/login`, `/signup`, `/forgot-password`.
- 375/768 responsive shell; 44px targets, visible focus, reduced motion,
  safe-area bottom nav, no Office/Foundry controls.
- Environment-camera/file input with 25MB/type validation.
- IndexedDB Blob queue (`idb`), retry/remove/progress/failure states,
  offline indicator; demo mode never invents a bearer token.
- Typed App API client performs create signed session → direct PUT →
  confirm → OCR job using generated OpenAPI paths/idempotency headers.
- PWA manifest + service worker cache/network fallback + install icon.
- Forwarding inbox/token/sender state and Office handoff UI.
- Portable standalone Dockerfile + local compose service; deployment is
  deferred to 1B/GCP gate.

Identity limitation: no IdP credentials/config exist. Auth forms and
session boundary are present; demo mode is default. Real callback/token
provisioning is deployment-gated and no token is compiled into browser
assets.

Verification: typecheck, eslint, IndexedDB tests (`fake-indexeddb`),
production Next build (all routes static), Docker build/health, browser
smoke at 375 and 768 with console check.
