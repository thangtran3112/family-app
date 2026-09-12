# SDD ledger — plan: docs/superpowers/plans/2026-09-11-phase-1c-gateway-hardening.md

## Preflight Scan

| Tasks | Shared interface/file | Finding | Ruling |
|---|---|---|---|
| 1 -> 2 | `@expense-tax/gateway-policy`, root workspace scripts | Task 2 consumes exact limiter/classifier exports from Task 1. No conflict. | Task 1 freezes pure policy API before service hooks. |
| 1 -> 3 | `@expense-tax/gateway-policy`, root workspace scripts | Task 3 consumes same exports. No conflict. | Both services use same limits and key semantics. |
| 1 -> 4 | root `package.json` | Task 4 adds static checker script while Task 1 adds package scripts. Different keys; no conflict. | Merge script changes carefully, preserve existing commands. |
| 2 -> 5 | App API plugin and tests | Task 5 runs full App API suite and production route probes. No interface conflict. | Keep auth behavior unchanged. |
| 3 -> 5 | Foundry plugin and tests | Task 5 runs full Foundry suite and route probes. No interface conflict. | Keep platform/service authorization unchanged. |
| 4 -> 5 | Terraform, frontend configs, static checker | Task 5 validates and may deploy reviewed free-tier changes. No conflict. | No paid resources or Cloudflare apply without explicit approval. |

| Task | Self-consistency | Ruling |
|---|---|---|
| 1 | Pure package API, tests, workspace scripts align. | Proceed. |
| 2 | Plugin registration, Fastify bounds, headers, and tests align. | Proceed. |
| 3 | Foundry integration mirrors App API without changing auth. | Proceed. |
| 4 | Next headers, route static checks, Terraform/docs align with free-tier boundary. | Proceed. |
| 5 | Full verification and deployment gate align with no paid service activation. | Proceed. |

## Decisions

- Ruling: Use bounded in-process rate limits keyed by authorization digest when present, otherwise socket address; this is defense in depth, not globally distributed protection. Cost if wrong: multiple instances or shared proxies can reduce rate-limit precision; future GCP may add an explicitly approved shared/paid control.
- Ruling: Set Fastify default body limit to 1 MiB while preserving existing route-specific upload and inbound-email limits. Cost if wrong: an unannotated future JSON route above 1 MiB fails until it declares an explicit route limit.
- Ruling: Add HSTS/security headers at application origins rather than paid Cloudflare header transforms. Cost if wrong: headers are duplicated across services/frontends but remain portable across VPS/GCP.
- Task 1: complete (commit `d7f8ba3`, review clean)
- Task 2: minor (deferred): parser-override tests exercise auth rejection before proving bodies above 1 MiB reach upload/inbound-email parsers.
- Task 2: complete (commit `de68003`, review clean; 1 deferred minor)
- Task 3: complete (commit `d00ccf1`, review clean)
- Task 4: fix round 1/5 (1 Important addressed; final 404 ordering parser strengthened; commit `4b926ef`)
- Task 4: fix round 2/5 (1 Important addressed; final no-comma Terraform object parsed; commit `74a8808`)
- Task 4: minor (deferred): broader ingress ordering beyond Foundry service-before-web remains outside focused static checker scope.
- Task 4: complete (commits `ff20979..74a8808`, review clean; 1 deferred minor)
- Task 5: fix round 1/5 (2 Important evidence gaps addressed; commit `68e0c14`)
- Task 5: fix round 2/5 (approval sequencing corrected; commit `3210480`)
- Task 5: complete (commits `accbb45..3210480`, review clean; deployment/public gates intentionally deferred)
- Final review: Important — authorization-header hashing is attacker-controlled and permits unlimited limiter buckets; checker scans only `main.tf`; route checker lacks executable method/unknown-path coverage. Minor — frontend `no-store` applies to immutable assets.
- Ruling: Replace authorization-based limiter keys with trusted transport identity only, prioritizing security over Task 1's original digest proposal; cost if wrong: users behind one proxy share a coarse process-local bucket until trusted proxy identity is explicitly configured.
- Final fix wave: original limiter, Terraform scan, route coverage, and asset cache findings addressed in `72af839`; scoped re-review confirmed three addressed.
- Final review parked: static checker does not table-test every frontend/health/webhook method rejection. Ruling: Fastify runtime tests prove unknown paths and unsupported methods fail closed for both services, while the static method table is a declarative contract; defer broader matrix tests as non-blocking coverage work. Cost if wrong: static policy drift in untested public route classes could evade checker detection.
- Final verification: fresh `pnpm test` passed 448 tests with 1 pre-existing skipped Foundry database test; lint, typecheck, build, static checker, Terraform fmt/init/validate passed.
- Phase 1C implementation: complete (commits `d7f8ba3..72af839`, final review clean with 1 parked non-blocking coverage finding; Terraform plan/apply and public probes deferred pending inputs/approval).
- CI regression: clean-install contract drift failed because gateway-policy dist was not built before OpenAPI generation; fixed in `0158844` by building workspace dependency before App API/Foundry generation.
- CI fix review: minor (deferred): ordering test uses source positions rather than runtime command execution; behavior verified by clean `check-generated` run.
- CI regression: Docker service builds lacked gateway-policy workspace files; fixed in `aae0497` by copying/building package and runtime dist in both service Dockerfiles.
- CI review: root `contracts:generate` still lacked gateway-policy build; fixed in `2f55670`, review clean.
- CI regression: Phase 0I typecheck ran before gateway-policy build; fixed in `dff5f9e` by ordering root and CI typechecks after gateway build.
- CI fix review: minor (deferred): ordering test uses package-name positions rather than command parsing; local checks pass.

## Task 5 Verification Evidence (2026-09-11)

- Root verification from `expense-tax-management`: `pnpm test` passed with 445 tests passed and 1 pre-existing skipped Foundry database test. `pnpm lint`, `pnpm typecheck`, and `pnpm build` passed.
- Static checks passed: `pnpm exec vitest run scripts/check-phase-1c-gateway.test.mjs` (6 passed) and `pnpm check:phase-1c-gateway`.
- Terraform checks passed with backend disabled: `terraform fmt -check -recursive .`, `terraform init -backend=false`, and `terraform validate`.
- Terraform plan inspection was limited to source/static inspection because required `cloudflare_account_id` was unavailable. No credentials were printed, invented, or used for an external plan request. Configuration contains only expected Tunnel/Tunnel config/DNS resources, loopback origins, and no paid Cloudflare product resources.
- `git diff --check` passed.
- Public HTTPS and direct VPS port verification deferred by explicit user instruction; no external production probes, apply, deployment, Cloudflare/GCP mutation, or push performed.
- GCP-specific Load Balancer/Cloud Armor mapping remains deferred documentation/design work and requires separate cost/deployment approval.

## Task 5 Review Fix Evidence (2026-09-11)

- Step 2 explicitly incomplete: required Terraform inputs/credentials were absent, so `terraform plan` stopped before planning. No plan executed; static inspection cannot prove plan contents.
- Step 5 explicitly incomplete: no push or deployment-approval request was executed or granted because no reviewed plan was available.
- No apply, public probes, Cloudflare/GCP mutation, or external action was executed.
- Next action, in order: provide required Terraform plan inputs/credentials; run and inspect the free-tier plan; request explicit deployment approval; apply only after approval. Public production probes require separate approval.

## Task 5 Review Fix Evidence: Round 2 (2026-09-11)

- Corrected sequencing: inputs/credentials first, then plan execution, plan inspection, explicit approval request, and apply only after approval.
- Public production probes remain a separate approval gate.
- No external action was executed while correcting evidence.
