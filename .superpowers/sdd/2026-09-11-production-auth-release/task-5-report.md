# Task 5 Report

Status: incomplete — implementation verified; live production smoke pending

Implemented `expense-tax-management/scripts/production-auth-smoke.mjs` and its
focused Vitest suite.

- Checks public App API, Foundry, Capture, and Office readiness endpoints.
- Checks App API no-token `401`.
- Checks thang tenant access, thang Foundry platform/operator access, tramily
  Foundry `403`, and Family tenant/org mismatch `403`.
- Checks separate App API and Foundry M2M target audiences.
- Checks webhook delivery `202` and replay `202` with `replayed: true`.
- Uses bounded fetch timeout and response size limits.
- Reads claim metadata only from service-reported `claimsVerified` metadata; it
  does not decode bearer JWTs locally.
- Keeps bearer tokens and webhook signature inputs in memory; authorization is
  redacted and output contains status/claim metadata only.
- CLI refuses execution unless both `--execute` and the explicit confirmation
  environment value are present.

Verification:

- `pnpm exec vitest run scripts/production-auth-smoke.test.mjs`: 5 passed
- `pnpm test`: 384 passed, 1 skipped
- `pnpm lint`: passed
- `pnpm exec eslint scripts/production-auth-smoke.mjs scripts/production-auth-smoke.test.mjs`: passed
- `git diff --check`: passed

Production mutation: none. Live production smoke command was not executed.

Concerns:

- Runtime endpoint paths and response claim metadata must match deployed App API,
  Foundry, Capture, and Office routes. Supply those values through the script's
  documented environment inputs before any approved private run.
- Webhook replay requires valid, short-lived Svix headers supplied out of band;
  no signing secret is accepted or stored by this script.

## Review Fixes

- Require HTTPS for every configured endpoint and Clerk issuer.
- Require present, exact `claimsVerified.issuer` on every authenticated check.
- Read response bodies through a bounded stream instead of `response.text()`.
- Added issuer, HTTP rejection, timeout, response-size, confirmation-guard, and
  logger-redaction tests.
- Webhook replay sends identical signed body/headers twice and asserts first
  response is not marked replayed while second response is marked replayed.

Live production smoke remains pending. No live evidence is claimed and no live
production mutation or request was executed.

## Review-Fix Verification

- `pnpm exec vitest run scripts/production-auth-smoke.test.mjs`: 10 passed
- `pnpm test`: 384 passed, 1 skipped
- `pnpm lint`: passed
- `pnpm exec eslint scripts/production-auth-smoke.mjs scripts/production-auth-smoke.test.mjs`: passed
- `git diff --check`: passed

## Load-Bearing Plan Correction

- Added read-only App API auth-check routes for mapped tenant identity and the
  configured App worker subject with `jobs:write`.
- Added read-only Foundry auth-check routes for `catalog_manager` and the
  configured Foundry worker subject with `routes:read`.
- Route responses expose only `claimsVerified` issuer/audience/subject/tokenType
  plus mapped tenant/user or role metadata.
- Smoke paths now use `/capture`, `/dashboard`, and registered auth-check routes;
  tramily tenant token against Foundry expects `401` before role lookup.
- Added behavioral route tests for no-token rejection, mapping, role, subject,
  and scope guards.

Correction verification:

- App auth-check tests: 2 passed
- Foundry auth-check tests: 2 passed
- Full App API tests: 224 passed
- Full Foundry tests: 110 passed, 1 skipped
- Full typecheck and lint: passed

Live production smoke remains pending. No production request, mutation, or live
evidence was performed.
