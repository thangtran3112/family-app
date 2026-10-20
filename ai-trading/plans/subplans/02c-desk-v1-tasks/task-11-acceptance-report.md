# Desk Task 11 acceptance evidence

**Run:** 2026-10-19, isolated worker from `origin/dev`. Test-only batch; production Desk routes and networks remain dark.

## Implemented

- Ported reviewed Part A commits `7c7497a`, `8e967d7`, and `f911ec8` in order, preserving newer CI jobs.
- Added pinned Playwright Chromium coverage against a real disposable PostgreSQL database, real uvicorn API, static export, and HTTP test proxy.
- Added isolated real Compose/Caddy target-state acceptance for anonymous rejection, forged-identity rejection, verified test-session access, PostgreSQL readiness, and unchanged Hub/MiroFish route shapes.
- Kept the existing production-source dark acceptance separate; it proves 404 darkness, not active Desk acceptance.

## Passing evidence

| Check | Result |
|---|---:|
| Contracts typecheck/tests | 47 tests passed |
| Frontend typecheck/lint/unit | 134 tests passed |
| Frontend OpenAPI drift/build/export | passed; 1 export test |
| Backend DSN safety | 17 tests passed, including ambient libpq routing overrides |
| Backend ruff/format | passed |
| Backend full suite on disposable PostgreSQL | 880 tests passed; 1 upstream deprecation warning |
| Proxy native HTTP tests | 4 tests passed |
| Chromium Playwright | 16 isolated tests passed |
| Real HTTP/API/engine runner | 1 test passed |
| Current Desk-dark real Caddy | 25 checks passed; image-build case remains an explicit manual check |
| Isolated target-state real Compose/Caddy | 9 checks passed against the real auth and Desk API images with migrations and PostgreSQL readiness |
| Cloudflare/GCP Terraform validate + mocked tests | 3 + 2 tests passed |
| Worker tests | 20 + 17 tests passed |
| Hub/MiroFish uploader tests | 22 + 33 checks passed |
| Uniquely tagged Desk image | built and inspected successfully |

## Full all-image smoke limitation

`docker buildx bake -f ai-trading/deploy/docker-bake.hcl --load` stopped before building because this isolated Desk worker does not have the MiroFish submodule's `locales/` checkout. Initializing or changing an upstream submodule is outside this lane. A subsequent `smoke-test.sh all` invocation exercised pre-existing local images but failed at the missing `frontend-artifacts/mirofish/index.html`; it is not recorded as a pass. Safe in-scope alternatives passed: a uniquely tagged Desk-only image build, current Desk-dark Caddy acceptance, target-state Desk Caddy acceptance, worker tests, uploader tests, and Terraform mocked tests.

The later Hub reconciliation confirmed that MiroFish's upstream URL and gitlink are already correct and that clean PR #150 CI passed recursive checkout, full bake, static export, and all smoke. That is supporting prerequisite evidence, not proof for this branch: the final Task 11 PR still needs its own clean Images and smoke job.

## Delivery boundary

No cloud write, production mutation, broker activation, IBKR use, order activation, push, or pull-request action occurred. This test-only batch needs no no-op runtime deploy; activation remains a separately reviewed cutover.
