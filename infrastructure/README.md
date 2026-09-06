# Shared Infrastructure

`infrastructure/` is the **shared** platform for all family apps. It owns stateful services that are not app-specific.

## Contents
- `docker-compose.common.yml` — postgres 17+pgvector, neo4j/falkordb, temporal, temporal-ui, nginx gateway. Volumes `postgres_data`, `neo4j_data`.
- `postgres/init-multiple-dbs.sh` — creates one DB per app from `POSTGRES_MULTIPLE_DATABASES` (comma-separated). Default `expense_tax_db`; add future DBs there.
- `nginx/nginx.conf` — upstreams `expense-service:8000` etc.; gateway routes `/api/` → expense-service, `/` → frontend.
- `.env.example` — GCP project, VPS host.

## Common vs per-app

| Layer | File | Owns |
|---|---|---|
| **Common** | `infrastructure/docker-compose.common.yml` | postgres, neo4j, temporal, gateway, shared volumes, healthchecks |
| **Per-app** | `expense-tax-management/docker-compose.yml` | `expense-service`, `frontend/web`, app volumes (`expense_service_storage`), `DATABASE_URL` with its DB name |

Run merged:
```bash
# from repo root
docker compose -f infrastructure/docker-compose.common.yml -f expense-tax-management/docker-compose.yml config
docker compose -f infrastructure/docker-compose.common.yml -f expense-tax-management/docker-compose.yml up -d

# from app dir
cd expense-tax-management
docker compose -f ../infrastructure/docker-compose.common.yml -f docker-compose.yml up -d
```

Alternative: `include:` in per-app compose:
```yaml
include:
  - ../infrastructure/docker-compose.common.yml
```

## Adding an app
- Add its DB to `POSTGRES_MULTIPLE_DATABASES`.
- Create its `docker-compose.yml` overlay.
- Allocate GCS bucket `family-shared-<app>`.
- No need to duplicate shared services.

## Why not per-app postgres
Single cluster saves VPS RAM and keeps a single `infrastructure/docker-compose.common.yml` as source of truth; DB-per-app via `CREATE DATABASE` gives isolation without extra containers.
