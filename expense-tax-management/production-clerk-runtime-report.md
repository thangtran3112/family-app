# Production Clerk Runtime Wiring Report

## Implemented

- Production secret bundle now preserves supplied Clerk runtime values instead of overwriting them with inert identity values.
- Protected production sync input requires `AUTH_PROVIDER=clerk`, approved issuer/JWKS URLs, tenant/platform audiences, target machine IDs, and source machine IDs.
- Production sync serializes Clerk values with shell-safe `%q` output through mode-0600 temporary input; no secrets are passed as command arguments.
- Production Compose explicitly requires `AUTH_PROVIDER` for App API and Foundry Service.
- Capture, Office, and Foundry frontend Dockerfiles require `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` as a build argument and expose it only in build stages.
- Production deploy build job uses the `production` environment and passes only `vars.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` as frontend build input.
- Local Compose supplies an inert public test key by default so local builds retain test behavior.
- Static/unit tests cover production Clerk propagation, protected sync requirements, runtime contract, Docker build contracts, and CI public-key boundaries.

## Approved Runtime Values

- Issuer/frontend API: `https://clerk.tobytran.dev`
- JWKS: `https://clerk.tobytran.dev/.well-known/jwks.json`
- Tenant audience: `expense-app`
- Platform audience: `expense-foundry-platform`
- App target: `mch_3JAI0juruFRPSkrE1rpcDKx1k1i`
- Foundry target: `mch_3JAIAMNUiVXteVOki8QENYHvJjp`
- App source: `mch_3JAIPnx8itUTJsizuEGewr6NGBX`
- Foundry source: `mch_3JAIi2BwnqBf8bNzbjTtjJa6nGw`

No production Clerk secret keys or production publishable-key values are stored in this repository.

## Verification

- Focused bundle/deployment tests: PASS, 46 tests.
- Full JavaScript workspace tests: PASS, including frontend and backend suites.
- JavaScript lint: PASS.
- JavaScript typecheck: PASS.
- Python lint/format checks: PASS.
- Python tests: PASS, 54 tests.
- Full frontend builds: PASS with inert public test key.
- Capture/Office/Foundry Docker builds: PASS with explicit public build argument.
- Deployment workflow static policy: PASS.
- Shell syntax checks: PASS.
- `git diff --check`: PASS.

## Known Concern

`check-phase-1b-infrastructure.mjs` still reports two pre-existing Cloudflare WIF assertion mismatches unrelated to Clerk runtime wiring. No infrastructure or external deployment mutation was performed.
