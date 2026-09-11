# Task 5 Report

Status: complete

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
