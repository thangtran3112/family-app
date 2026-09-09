# Phase 0M: Office Web

Delivered `frontend/office-web` from approved Office gate: Next 16/React
19, ≥1024px dense shell, small-screen Capture handoff, dashboard, exact
ledger filters, business/role boundaries, project cost analysis, tax
preparation (never filing), immutable exports, forwarding/quarantine,
plan/settings boundaries. Typed App API functions cover ledger, tax report,
and export creation. External IdP session remains deployment-gated; no
token is compiled into assets. Standalone Docker/compose on 7302.

Verification: typecheck, eslint, fixture/filter unit tests, production
build, Docker health, 1024/1440 browser smoke, zero console errors.
