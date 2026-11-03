#!/usr/bin/env bash
# Idempotent role/schema init for the market-data bridge's H1 archive in the shared VPS Postgres
# cluster (infrastructure/host/steps/30-postgres.sh). Same shape as
# ai-trading/packages/family-desk/backend/docker/postgres/zz-20-desk-roles.sh, scaled down: the
# archive has one writer (the bridge), so one role owns the schema. The bridge applies its own
# idempotent schema.sql at boot (`bridge migrate` does the same on demand), so there is no
# separate migrator role.
#
# Safe to re-run. 30-postgres.sh invokes this with POSTGRES_DB already set to
# ai_trading_market_archive_db and MARKET_ARCHIVE_DB_PASSWORD passed transiently via
# `docker compose exec -e ...`, never baked into the postgres container's permanent environment.
set -euo pipefail

if [[ -z "${MARKET_ARCHIVE_DB_PASSWORD:-}" ]]; then
  echo "Missing required PostgreSQL role variable: MARKET_ARCHIVE_DB_PASSWORD" >&2
  exit 1
fi

psql \
  -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  -v database_name="$POSTGRES_DB" \
  -v archive_password="$MARKET_ARCHIVE_DB_PASSWORD" <<'EOSQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'market_archive') THEN
    CREATE ROLE market_archive NOLOGIN;
  END IF;
END
$$;

ALTER ROLE market_archive
  WITH LOGIN PASSWORD :'archive_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;

-- Only this role (and the superuser the backup uses) reaches this database. The role gets CONNECT
-- and nothing else at database level: schema.sql creates the schema only when it is missing, so no
-- database-level CREATE is needed. (Database-level grants do not survive restore.sh either:
-- pg_restore into a re-created database does not replay them.)
REVOKE ALL ON DATABASE :"database_name" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"database_name" TO market_archive;

CREATE SCHEMA IF NOT EXISTS market_archive AUTHORIZATION market_archive;
ALTER SCHEMA market_archive OWNER TO market_archive;
REVOKE ALL ON SCHEMA market_archive FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM market_archive;
EOSQL
