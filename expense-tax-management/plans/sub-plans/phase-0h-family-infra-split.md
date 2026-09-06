# Family-App Infrastructure Split — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Promote `expense-tax-management/infrastructure` to `family-app/infrastructure`, split Compose into `docker-compose.common.yml` + per-app overlay, move git root to `family-app/`, and document separation via READMEs while retaining `expense-tax-management/opencode.json` and sessions.

**Architecture:** New git root `family-app/` with `infrastructure/docker-compose.common.yml` for shared Postgres/Neo4j/Temporal/Gateway; `expense-tax-management/docker-compose.yml` becomes thin app overlay that includes the common file. DB per app via init script, GCS bucket per app, `opencode.json` stays in subproject.

**Tech Stack:** git mv, Docker Compose `include:`/multi-file merge, pnpm workspaces, uv, Postgres 17+pgvector, Traefik/Nginx, GCS.

**Spec:** `plans/sub-plans/phase-0h-family-infra-split-design.md`

## Global Constraints
- Work on current branch, no new branch.
- Preserve parallel agent’s uncommitted changes and `.opencode/` sessions.
- `opencode.json` must remain at `expense-tax-management/opencode.json`.
- Do not move SQLAlchemy models; infra move only.

---
### Task 1 — Create monorepo READMEs (no filesystem move yet)

**Files:**
- Create: `family-app/README.md` (will be `README.md` after git root move; for now create as `README.family-app.md` at current root and later promote)
- Create: `family-app/infrastructure/README.md` stub (create as `infrastructure/README.md` and later promote)

**Step 1: Write failing check**
- Run: `test -f README.family-app.md && test -f infrastructure/README.md` — expect FAIL.

**Step 2: Create READMEs**
- `family-app/README.md` must describe: monorepo layout, `infrastructure/` is shared, `expense-tax-management/` retains `opencode.json`, how to add a new family app (copy `expense-tax-management/docker-compose.yml` as template, create new DB via `infrastructure/postgres/init-multiple-dbs.sh`, set `DATABASE_URL`).
- `infrastructure/README.md` must describe: `docker-compose.common.yml` vs per-app `docker-compose.yml`, `include:` usage, DB per app, GCS bucket per app, how to run `docker compose -f infrastructure/docker-compose.common.yml -f expense-tax-management/docker-compose.yml up`.

**Step 3: Verify**
- Run: `test -f README.family-app.md && grep -q "family-app" README.family-app.md`

**Step 4: Commit (deferred to Task 4)**

### Task 2 — Split Compose into common + app overlay

**Files:**
- Modify: `infrastructure/docker-compose.yml` → split into `infrastructure/docker-compose.common.yml` (shared services) + `expense-tax-management/docker-compose.yml` (app services) with `include:` or documented multi-file invocation.

**Step 1: Write failing check**
- Run: `test -f infrastructure/docker-compose.common.yml && test -f expense-tax-management/docker-compose.yml` — expect FAIL.

**Step 2: Create `docker-compose.common.yml`**
- Move `postgres`, `neo4j`, `temporal`, `temporal-ui`, `nginx` (gateway) and volumes `postgres_data`, `neo4j_data` there. Keep `expense_service_storage` with app overlay or common as appropriate.
- Add init script mount for multiple DBs: `./postgres/init-multiple-dbs.sh:/docker-entrypoint-initdb.d/init-multiple-dbs.sh:ro` and document `POSTGRES_MULTIPLE_DATABASES=expense_tax_db,other_app_db`.

**Step 3: Create app overlay**
- `expense-tax-management/docker-compose.yml` contains only `expense-service` + `frontend/web` (if containerized), with `include: - ../infrastructure/docker-compose.common.yml` or documented `docker compose -f` merge. Env `DATABASE_URL` points to `expense_tax_db`.

**Step 4: Verify**
- Run: `docker compose -f infrastructure/docker-compose.common.yml -f expense-tax-management/docker-compose.yml config >/dev/null` — expect success.

### Task 3 — Move git root to `family-app/` and preserve opencode

**Files:**
- Move: `.git/` from `expense-tax-management/` to `family-app/` (parent)
- Move: `infrastructure/` to `family-app/infrastructure/`
- Keep: `expense-tax-management/opencode.json` and `expense-tax-management/.opencode/`

**Step 1: Failing check**
- Run: `test -d ../family-app/.git && test -f expense-tax-management/opencode.json` — expect FAIL.

**Step 2: Execute move (history-preserving)**
- From `~/personal`: `mkdir -p family-app && mv expense-tax-management family-app/` then `mv family-app/expense-tax-management/.git family-app/.git` and `mv family-app/expense-tax-management/infrastructure family-app/infrastructure` (or `git mv` variant if staying in place). Update `family-app/.git` worktree to new root.
- Verify `opencode.json` still at `family-app/expense-tax-management/opencode.json` and `.opencode/` intact: `ls family-app/expense-tax-management/opencode.json family-app/expense-tax-management/.opencode/`.

**Step 3: Update AGENTS.md, opencode.json, package.json, plans/ links**
- `opencode.json` `projectRoot` remains `expense-tax-management` subpath; add family-level note if needed.
- Update `package.json` docker scripts to `docker compose -f ../infrastructure/docker-compose.common.yml -f docker-compose.yml up`.
- Update `AGENTS.md` directory table to show `family-app/` root.

**Step 4: Verify sessions**
- Run: `ls family-app/expense-tax-management/.opencode/ && cat family-app/expense-tax-management/opencode.json | grep projectRoot`

### Task 4 — Update tracking and validate full migration

**Files:**
- Modify: `plans/PLAN.md` add Phase 0H «Family-App Shared Infrastructure»
- Modify: `plans/sub-plans/*.md` links if needed

**Step 1: Validate**
- Run: `docker compose -f family-app/infrastructure/docker-compose.common.yml -f family-app/expense-tax-management/docker-compose.yml config`
- Run: `cd family-app/expense-tax-management && uv run ruff check . && uv run python -m pytest -q`
- Run: `pnpm --filter web build` from `family-app/expense-tax-management/frontend`

**Step 2: Mark PLAN.md Phase 0H complete only after validation.**
