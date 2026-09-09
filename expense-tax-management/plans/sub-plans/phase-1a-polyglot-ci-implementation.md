# Phase 1A: Polyglot CI (No Deployment)

Replaces stale FastAPI/deploy assumptions in `phase-1a-cicd-pipeline.md`.

Workflow: `.github/workflows/expense-tax-ci.yml`, push/PR on main/master +
manual dispatch, app/infrastructure path filter, contents-read only,
branch-safe concurrency.

- Quality: frozen pnpm/uv, contract runtime build before generated drift,
  all TypeScript lint/typecheck/tests/builds, plus Python lint/format/tests.
- Integration: full zero-skip `verify:phase-0n` with Docker-local Postgres
  started with a health wait on host 5433, Temporal, real cross-process
  Python loops, migrations,
  Docker images/readiness. Foundational 0I verification builds the contract
  runtime before dependent typechecks. Compose diagnostics upload only on
  failure.
- Explicit terminal `no-deploy` job. A local checker parses YAML and rejects
  auth/deploy/SSH/secret/registry-push primitives.

No deployment, GitHub secrets, GCP auth, DNS, VPS SSH, image push, or
production mutation. Those remain hard-gated at 1B/1C.
