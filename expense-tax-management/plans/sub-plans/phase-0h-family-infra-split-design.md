# Phase 0H — Family-App Monorepo & Shared Infrastructure — Design

> **Status:** Draft — Option 2 approved (shared + per-app Compose), `opencode.json` stays under `expense-tax-management/`

## Goal
Promote shared infrastructure out of `expense-tax-management` into a family monorepo root `family-app/`, keep `expense-tax-management/` as a sub-project with its own `opencode.json`/`.opencode` sessions, and split Docker Compose into a common stack plus per-app overlays so future family apps share one GCP project + one VPS Postgres cluster (different DBs/buckets) without coupling app code.

## Target Layout (after migration)
```
family-app/                          <- NEW git root (renamed repo, was expense-tax-management)
  .git/                              <- moved from expense-tax-management/.git
  README.md                          <- NEW: monorepo overview, layout, how to add a new family app
  infrastructure/
    README.md                        <- NEW: common vs per-app responsibilities
    docker-compose.common.yml        <- postgres (pgvector), neo4j/falkordb, temporal, traefik/nginx gateway
    nginx/nginx.conf                 <- shared gateway config (expense-service upstream etc.)
    .env.example
    scripts/                         <- bootstrap.sh etc. (VPS-portable)
  expense-tax-management/            <- current repo becomes subfolder
    opencode.json                    <- RETAINED at this path (projectRoot = this subfolder)
    .opencode/                       <- RETAINED (sessions + rules preserved)
    frontend/
    expense-service/
    common/python/expense-contracts/
    plans/  docs/  .github/
    docker-compose.yml               <- app overlay (expense-service + frontend) — includes ../infrastructure/docker-compose.common.yml
    README.md                        <- app-specific
  <future-family-app>/
    docker-compose.yml               <- its own overlay, reuses ../infrastructure/docker-compose.common.yml
```

## Decisions
- **Git root moves to `family-app/`** via `git mv` + history-preserving restructure. Remote `origin` renamed from `expense-tax-management` to `family-app` (GitHub repo rename). All history retained.
- **`opencode.json` retention:** Stays at `expense-tax-management/opencode.json` with `projectRoot` still pointing there. `family-app/` may get an optional lightweight `opencode.json` later, but sessions live per-app so current sessions are untouched.
- **Compose split:** `infrastructure/docker-compose.common.yml` owns shared stateful services (postgres, neo4j, temporal, gateway). Each app’s `docker-compose.yml` uses `include:` or `docker compose -f ../infrastructure/docker-compose.common.yml -f docker-compose.yml` to merge.
- **DB isolation:** Single Postgres container, one DB per app (`expense_tax_db`, `<app>_db`) created by init script `infrastructure/postgres/init-multiple-dbs.sh`. `DATABASE_URL` per app points to its DB.
- **GCS isolation:** One GCP project, bucket/prefix per app (`family-shared-expense-tax`, `family-shared-<app>`), documented in `infrastructure/README.md`.
- **No infra duplication:** No copy of `infrastructure/` remains under `expense-tax-management/` after promotion (symlink not used; include is explicit).

## Migration Constraints
- No feature branch; work on `main` (or current branch) with parallel agent’s uncommitted changes preserved.
- Preserve `.opencode/` sessions and `opencode.json` byte-for-byte except path fields that must be updated from `infrastructure/...` to `../infrastructure/...` where the app overlay references the parent.
- No SQLAlchemy model moves; only infra/compose/docs/AGENTS/plans paths change.

## Validation
- `docker compose -f infrastructure/docker-compose.common.yml -f expense-tax-management/docker-compose.yml config` renders with both stacks.
- `cd expense-tax-management && uv run ruff check . && uv run python -m pytest` passes.
- `cd expense-tax-management/frontend/web && pnpm lint && pnpm build` passes (via `family-app` root `pnpm --filter` still works if workspace is at `family-app/`).
- `family-app/README.md` and `family-app/infrastructure/README.md` exist and describe separation.
- `git log --follow` shows history for moved files.
- `opencode.json` and `.opencode/` still present at `expense-tax-management/` after move.
