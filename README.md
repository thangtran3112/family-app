# Family App — Monorepo

This repository hosts shared infrastructure and multiple family applications that share one VPS + one GCP project.

## Layout
```
family-app/
  infrastructure/                 # Shared stack (see infrastructure/README.md)
    docker-compose.common.yml     # postgres (pgvector), neo4j, temporal, gateway
    nginx/nginx.conf
    postgres/init-multiple-dbs.sh # creates one DB per app
  expense-tax-management/         # Expense/Tax PWA + FastAPI service
    opencode.json                 # opencode session stays here (retained)
    .opencode/                    # per-app agent rules/sessions — retained
    frontend/                     # Next.js 16 PWA
    expense-service/              # FastAPI (app/, alembic/, tests/)
    common/python/expense-contracts/
    docker-compose.yml            # app overlay (includes ../infrastructure/docker-compose.common.yml)
    plans/ docs/
  <future-family-app>/            # sibling app, same pattern
```

## Why this structure
- **Shared GCP project + shared VPS Postgres cluster** but **DB per app** (`expense_tax_db`, `<app>_db`) via `POSTGRES_MULTIPLE_DATABASES`.
- **One GCS project, bucket/prefix per app** (`family-shared-expense-tax`, ...).
- `expense-tax-management/opencode.json` and `.opencode/` remain in the subproject so existing sessions continue.

## Quick start (expense-tax-management)
```bash
# from family-app/
docker compose -f infrastructure/docker-compose.common.yml -f expense-tax-management/docker-compose.yml up -d
# or from the app dir:
cd expense-tax-management
docker compose -f ../infrastructure/docker-compose.common.yml -f docker-compose.yml up -d

# app dev
cd expense-tax-management
uv run python -m pytest
pnpm --filter web build
```

## Adding a new family app
1. `mkdir <new-app> && cp -r expense-tax-management/docker-compose.yml <new-app>/` as template
2. Add DB name to `infrastructure/docker-compose.common.yml` env `POSTGRES_MULTIPLE_DATABASES=expense_tax_db,<new-app>_db`
3. Set `DATABASE_URL=postgresql+asyncpg://postgres:postgrespassword@postgres:5432/<new-app>_db` in new app's compose
4. Create GCS bucket `family-shared-<new-app>`
5. Reuse `common/python` patterns if Python.

## Git
Repo was renamed from `expense-tax-management` to `family-app`; history preserved via `git mv`. Remote is `thangtran3112/family-app`.
