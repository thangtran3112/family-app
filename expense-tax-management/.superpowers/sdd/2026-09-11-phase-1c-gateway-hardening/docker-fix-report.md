# Phase 1C Docker Fix Report

## Status

Implemented minimal Docker build-context and runtime staging for
`@expense-tax/gateway-policy` in app-api and foundry-service.

## Changes

- Copied gateway-policy `package.json`, `tsconfig.json`, and `src` before
  dependency installation.
- Built gateway-policy before each service build.
- Copied gateway-policy `package.json` and `dist` into each runtime image so
  pnpm workspace symlinks resolve at runtime.

## Verification

- Pre-fix Docker builds reproduced `TS2307` for both services.
- App-api Docker build: passed (`phase1c-app-api-after`).
- Foundry-service Docker build: passed (`phase1c-foundry-after`).
- App-api runtime gateway-policy import: passed.
- Foundry-service runtime gateway-policy import: passed.
- App-api typecheck, build, and lint: passed.
- Foundry-service typecheck, build, and lint: passed.
- Root `pnpm lint`: passed.
- `git diff --check`: passed.
- Clean-install reproduction: removing gateway-policy `dist` caused
  `contracts:generate` to fail during app OpenAPI generation with
  `ERR_MODULE_NOT_FOUND`.
- Added gateway-policy build as first `contracts:generate` step.
- Focused Phase 1C order test: 9 passed.
- `pnpm contracts:generate`: passed, including gateway build first.
- `pnpm contracts:check`: passed.
- App-api typecheck, build, and lint: passed.
- Foundry-service typecheck, build, and lint: passed.
- `git diff --check`: passed.

## Concerns

- Docker image builds require an available Docker daemon and registry access for
  the pinned Node base image.
