# Desk Task 11 independent whole-branch review

**Review date:** 2026-10-19

**Range:** `origin/dev..c2a6deff4a014f14d4282e229e3c188354e2a740`, followed by the fixes recorded below

**Reviewer:** independent fresh-context code reviewer; implementer applied and verified fixes

**Final verdict:** **PASS — no unresolved Critical or Important findings**

## Sources reviewed

- Phase 4 Task 11 plan and `task-11-acceptance-report.md`.
- Entire branch diff, not only the final implementation commit.
- Live read-only Paper source: `TobyTest`, file `01M4K3AXAKQC8Z6JTW03YR5HEG`, page `Family Desk · R2 mockups` (`p-1-0`), token hash `728c3803`. The read confirmed 28 artboards, including the 390×844 mobile screens and the relevant Today, Strategies, Watchlists, Settings, Technicals, and Futures desktop screens. No Paper node was changed.
- Production Desk-dark Caddy/Compose source and the isolated target-state fixture.

## Independent findings and resolution

### Critical

None.

### Important 1 — fixture principals violated the public-repository non-email policy

**Finding:** Task 11 added invented but email-shaped identities in the backend E2E clock, proxy tests, browser auth test, and target-state Caddy fixture. They were not real personal data, but they still violated the stricter repository rule.

**Resolution:** Replaced every Task 11 identity with explicit non-sensitive principals (`desk-e2e-principal` and `forged-principal`) across signed sessions, forwarded headers, seed ownership, proxy assertions, and Caddy expectations. Database URLs retain only disposable credentials and local/container hosts; they are not identity fixtures.

**Verification:** the Hermes dispatcher leak helper was run over all added lines in the complete `origin/dev..HEAD` diff after commit, not only over the review fix.

### Important 2 — stale futures response test could finish before the stale response arrived

**Finding:** the original Playwright check delayed an MNQ request by a fixed interval, selected MCL, asserted MCL once, and navigated away. It did not prove that the MNQ request had started or that its response arrived after MCL.

**Resolution:** Replaced the timer with an explicit request gate. The test now waits until the real MNQ request starts, renders distinct real MCL data, releases and fulfills the MNQ response, waits for its completion, and then reasserts that MCL identity and values remain unchanged.

**Verification:** Chromium Playwright suite passed 16/16 against disposable PostgreSQL, the real uvicorn Desk API, and the test HTTP proxy.

### Minor — fixture no-network assertion ended before a hydration boundary

**Finding:** fixture tests asserted zero Desk API requests as soon as server-rendered fixture content appeared; a delayed hydration effect could have escaped the assertion.

**Resolution:** Request tracking now remains active through `document.readyState`, network idle, and two animation frames before the zero-request assertion.

## Review focus results

- **DSN confinement:** loopback-only psycopg DSNs, unique `desk_e2e_<12 hex>` databases, query rejection, ambient libpq routing rejection, forced database drop, and per-test reset reviewed. Safety suite: 17/17.
- **Engine and SSE:** seed code creates no alert; real `engine.tick` creates one signal/alert and replay creates none; auth and quote-poll sessions close while the stream stays open, then browser navigation drives active streams to zero.
- **Proxy identity boundary:** reserved test cookie is the only path that installs the test principal; browser-supplied identity, auth, OIDC, and forwarded-certificate headers are stripped. Native proxy suite: 4/4.
- **Playwright realism:** real PostgreSQL, migrations, uvicorn routes, static export, proxy, deterministic clock, per-test database reset, real engine subprocess, explicit delayed-response completion, mobile route/overflow checks, and stream cleanup. Chromium: 16/16.
- **Target-state Caddy:** real auth image, real Desk API image, migration container, and real PostgreSQL sit behind isolated Caddy. Anonymous and forged requests fail; a signed synthetic principal reaches DB-backed Desk routes. Exact Desk matching does not capture sibling paths. Target acceptance: 9/9.
- **Production darkness:** production Caddy still returns fixed 404 for `/api/desk` and descendants before generic API routing; Desk API remains off the gateway network; Hub Desk card stays absent. Dark acceptance: 25/25.
- **Fixtures/mobile:** every fixture route retains its phase banner and zero Desk API traffic through hydration; 390×844 navigation reaches required destinations without horizontal overflow.
- **Scope:** no infrastructure, Hub application, upstream source, gitlink, Bake, or production routing change exists in this branch.

## Fresh verification after review fixes

- Contracts: 47 tests.
- Frontend: typecheck and lint clean; 134 unit tests; static build and export test passed.
- Backend: Ruff and format clean; 880 tests on disposable PostgreSQL, with one dependency deprecation warning.
- Part A proxy/HTTP: 4 native proxy tests and 1 real HTTP/API/engine test.
- Browser: 16 Chromium tests.
- Caddy: 25 current-dark checks and 9 real target-state checks.

## Remaining limitation

This worker did not claim a clean full all-image bake/smoke result for the final review commit. The MiroFish source and pin are already correct at the acknowledged upstream revision; earlier missing worker initialization/static artifact was a prerequisite, not a Desk code defect. PR #150's clean recursive-checkout CI is supporting evidence only. The final Task 11 acceptance PR must independently pass its own clean **Images and smoke tests** job before merge.
