#!/usr/bin/env bash
set -Eeuo pipefail

# Separate operator-only step. Do not place POSTGRES_SUPERUSER_PASSWORD in the
# normal production env bundle or pass it through deploy.sh.
: "${POSTGRES_SUPERUSER_PASSWORD:?POSTGRES_SUPERUSER_PASSWORD is required}"
: "${TEMPORAL_DB_PASSWORD:?TEMPORAL_DB_PASSWORD is required}"
POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-expense-tax-postgres}"
POSTGRES_SUPERUSER="${POSTGRES_SUPERUSER_USER:-postgres}"

if [[ -z "$POSTGRES_CONTAINER" || -z "$POSTGRES_SUPERUSER" ]]; then
  printf '%s\n' "Temporal database bootstrap configuration is incomplete" >&2
  exit 1
fi

export PGPASSWORD="$POSTGRES_SUPERUSER_PASSWORD"
temporal_password_sql=${TEMPORAL_DB_PASSWORD//\'/\'\'}

# SQL travels on stdin; credentials never appear in docker or psql arguments.
docker exec -i -e PGPASSWORD "$POSTGRES_CONTAINER" psql \
  -U "$POSTGRES_SUPERUSER" \
  -d postgres \
  -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'expense_temporal') THEN
    CREATE ROLE expense_temporal LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '$temporal_password_sql';
  ELSE
    ALTER ROLE expense_temporal LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '$temporal_password_sql';
  END IF;
END
\$\$;
SELECT format('CREATE DATABASE temporal OWNER expense_temporal')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'temporal')
\gexec
SELECT format('CREATE DATABASE temporal_visibility OWNER expense_temporal')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'temporal_visibility')
\gexec
DO \$\$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'expense_temporal'
      AND rolsuper = false
      AND rolcreatedb = false
      AND rolcreaterole = false
      AND rolreplication = false
      AND rolbypassrls = false
  ) THEN
    RAISE EXCEPTION 'expense_temporal role has unsafe attributes';
  END IF;
  IF (SELECT count(*) FROM pg_database WHERE datname IN ('temporal', 'temporal_visibility')) <> 2 THEN
    RAISE EXCEPTION 'Temporal databases are missing';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_database d
    JOIN pg_roles r ON r.rolname = 'expense_temporal'
    WHERE d.datname IN ('temporal', 'temporal_visibility')
      AND d.datdba <> r.oid
  ) THEN
    RAISE EXCEPTION 'Temporal database owner mismatch';
  END IF;
END
\$\$;
SQL
