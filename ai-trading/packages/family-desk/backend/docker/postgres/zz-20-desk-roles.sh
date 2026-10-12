#!/usr/bin/env bash
# Idempotent Desk role/schema init script for the shared VPS Postgres cluster
# (infrastructure/vps/steps/30-postgres.sh, owner decision 2026-10-12, D-e --
# no desk-postgres container). Same shape as
# expense-tax-management/docker/postgres/zz-20-expense-tax-roles.sh (migrator/
# runtime split, CREATE ROLE/SCHEMA IF NOT EXISTS), scaled down to the Desk's
# one app instead of expense-tax's app+foundry pair.
#
# Safe to re-run: every CREATE is guarded, every GRANT/REVOKE is idempotent by
# nature. 30-postgres.sh invokes this with POSTGRES_DB already set to
# ai_trading_desk_db and DESK_MIGRATOR_DB_PASSWORD/DESK_RUNTIME_DB_PASSWORD
# passed transiently via `docker compose exec -e ...` -- never baked into the
# postgres container's permanent environment.
set -euo pipefail

required_variables=(
  DESK_MIGRATOR_DB_PASSWORD
  DESK_RUNTIME_DB_PASSWORD
)

for variable_name in "${required_variables[@]}"; do
  if [[ -z "${!variable_name:-}" ]]; then
    echo "Missing required PostgreSQL role variable: $variable_name" >&2
    exit 1
  fi
done

psql \
  -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  -v database_name="$POSTGRES_DB" \
  -v desk_migrator_password="$DESK_MIGRATOR_DB_PASSWORD" \
  -v desk_runtime_password="$DESK_RUNTIME_DB_PASSWORD" <<'EOSQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'desk_migrator') THEN
    CREATE ROLE desk_migrator NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'desk_runtime') THEN
    CREATE ROLE desk_runtime NOLOGIN;
  END IF;
END
$$;

ALTER ROLE desk_migrator
  WITH LOGIN PASSWORD :'desk_migrator_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE desk_runtime
  WITH LOGIN PASSWORD :'desk_runtime_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;

CREATE SCHEMA IF NOT EXISTS desk AUTHORIZATION desk_migrator;
CREATE SCHEMA IF NOT EXISTS desk_migrations AUTHORIZATION desk_migrator;

ALTER SCHEMA desk OWNER TO desk_migrator;
ALTER SCHEMA desk_migrations OWNER TO desk_migrator;

GRANT CONNECT ON DATABASE :"database_name" TO desk_migrator, desk_runtime;
REVOKE CREATE, TEMPORARY ON DATABASE :"database_name" FROM desk_migrator, desk_runtime;

REVOKE ALL ON SCHEMA desk, desk_migrations FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM desk_migrator, desk_runtime;

-- desk_runtime (api/scheduler) never touches the migrations bookkeeping schema.
REVOKE ALL ON SCHEMA desk_migrations FROM desk_runtime;

GRANT USAGE ON SCHEMA desk TO desk_runtime;

REVOKE ALL ON ALL TABLES IN SCHEMA desk FROM desk_runtime;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA desk FROM desk_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA desk
  TO desk_runtime;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA desk
  TO desk_runtime;

-- No CREATE/DROP for desk_runtime on its own tables' schema -- Alembic
-- (desk_migrator) owns schema changes, never the api/scheduler connection.
REVOKE CREATE ON SCHEMA desk FROM desk_runtime;

ALTER DEFAULT PRIVILEGES FOR ROLE desk_migrator IN SCHEMA desk
  REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE desk_migrator IN SCHEMA desk
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO desk_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE desk_migrator IN SCHEMA desk
  REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE desk_migrator IN SCHEMA desk
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO desk_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE desk_migrator IN SCHEMA desk_migrations
  REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE desk_migrator IN SCHEMA desk_migrations
  REVOKE ALL ON SEQUENCES FROM PUBLIC;

ALTER ROLE desk_runtime IN DATABASE :"database_name"
  SET search_path TO desk, pg_catalog;
ALTER ROLE desk_migrator IN DATABASE :"database_name"
  SET search_path TO desk, desk_migrations, pg_catalog;
EOSQL
