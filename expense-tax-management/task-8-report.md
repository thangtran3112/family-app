# Task 8 Evidence

## Requirements

- Worker configuration retains separate app and Foundry machine secrets,
  destination audiences, and source subjects.
- Production bundle now requires `CLERK_APP_MACHINE_SECRET_KEY` and
  `CLERK_FOUNDRY_MACHINE_SECRET_KEY`.
- Bundle carries four nonsecret Clerk machine IDs:
  - app target: `mch_3J9fsniGga4hUqUf65ZQqzeGX2b`
  - app source: `mch_3J9Xg9Hu84Rn2oeqj7EMrv0ax19`
  - Foundry target: `mch_3J9g3CNoKL9q6KfbRy5zq1Rh2zT`
  - Foundry source: `mch_3J9gHBtDcxOE3fWE39Ay9uF7hFv`
- Local and production Compose, `.env.example`, production Secret Manager
  sync input, and deployment allowlist use separate machine secret names.
- No real secret values were added. Secret Manager upload was not run.

## TDD Evidence

- RED: bundle test run before implementation failed with missing obsolete
  `CLERK_MACHINE_SECRET_KEY`; new missing-key cases also failed because bundle
  did not require the two destination-specific names.
- GREEN: bundle tests pass after replacing obsolete key with two destination-
  specific keys and adding four machine IDs.

## Verification

- `uv run pytest` in `services/ai-worker`: 45 passed.
- `pnpm exec vitest run scripts/lib/production-secret-bundle.test.mjs`: 18 passed.
- Focused Compose/deployment/bundle Vitest run: 37 passed.
- `pnpm ci:lint`: passed.
- `pnpm ci:typecheck`: passed.
- Targeted Python Ruff check/format check for Task 8 files: passed.
- `git diff --check`: passed.
- Frontend/packages source scan found no Clerk machine secret values or machine
  secret names. Build and log directories contained no matches. Test fixtures
  contain only non-production placeholders.

## Concern

- Full `pnpm ci:python:lint` remains blocked by pre-existing formatting in
  `services/ai-worker/tests/test_auth_client.py`; that unrelated file was not
  changed.
- No external calls or Secret Manager writes performed. Controller must handle
  secret upload and version retirement after review.
