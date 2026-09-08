#!/usr/bin/env bash
set -euo pipefail

required_variables=(
  APP_MIGRATOR_DB_PASSWORD
  APP_RUNTIME_DB_PASSWORD
  FOUNDRY_MIGRATOR_DB_PASSWORD
  FOUNDRY_RUNTIME_DB_PASSWORD
)

for variable_name in "${required_variables[@]}"; do
  if [[ -z "${!variable_name:-}" ]]; then
    echo "Missing required PostgreSQL role variable: $variable_name" >&2
    exit 1
  fi
done

if [[ "${APP_ENV:-development}" == "production" ]]; then
  development_defaults=(
    expense-tax-app-migrator-local
    expense-tax-app-runtime-local
    expense-tax-foundry-migrator-local
    expense-tax-foundry-runtime-local
  )
  for password in \
    "$APP_MIGRATOR_DB_PASSWORD" \
    "$APP_RUNTIME_DB_PASSWORD" \
    "$FOUNDRY_MIGRATOR_DB_PASSWORD" \
    "$FOUNDRY_RUNTIME_DB_PASSWORD"; do
    for development_default in "${development_defaults[@]}"; do
      if [[ "$password" == "$development_default" ]]; then
        echo "Development PostgreSQL role password is not allowed with APP_ENV=production" >&2
        exit 1
      fi
    done
  done
fi

psql \
  -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  -v database_name="$POSTGRES_DB" \
  -v app_migrator_password="$APP_MIGRATOR_DB_PASSWORD" \
  -v app_runtime_password="$APP_RUNTIME_DB_PASSWORD" \
  -v foundry_migrator_password="$FOUNDRY_MIGRATOR_DB_PASSWORD" \
  -v foundry_runtime_password="$FOUNDRY_RUNTIME_DB_PASSWORD" <<'EOSQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'expense_app_migrator') THEN
    CREATE ROLE expense_app_migrator NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'expense_app_runtime') THEN
    CREATE ROLE expense_app_runtime NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'expense_foundry_migrator') THEN
    CREATE ROLE expense_foundry_migrator NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'expense_foundry_runtime') THEN
    CREATE ROLE expense_foundry_runtime NOLOGIN;
  END IF;
END
$$;

ALTER ROLE expense_app_migrator
  WITH LOGIN PASSWORD :'app_migrator_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE expense_app_runtime
  WITH LOGIN PASSWORD :'app_runtime_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE expense_foundry_migrator
  WITH LOGIN PASSWORD :'foundry_migrator_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE expense_foundry_runtime
  WITH LOGIN PASSWORD :'foundry_runtime_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;

CREATE SCHEMA IF NOT EXISTS app AUTHORIZATION expense_app_migrator;
CREATE SCHEMA IF NOT EXISTS app_migrations AUTHORIZATION expense_app_migrator;
CREATE SCHEMA IF NOT EXISTS foundry AUTHORIZATION expense_foundry_migrator;
CREATE SCHEMA IF NOT EXISTS foundry_migrations AUTHORIZATION expense_foundry_migrator;

ALTER SCHEMA app OWNER TO expense_app_migrator;
ALTER SCHEMA app_migrations OWNER TO expense_app_migrator;
ALTER SCHEMA foundry OWNER TO expense_foundry_migrator;
ALTER SCHEMA foundry_migrations OWNER TO expense_foundry_migrator;

GRANT CONNECT ON DATABASE :"database_name"
  TO expense_app_migrator, expense_app_runtime,
       expense_foundry_migrator, expense_foundry_runtime;
REVOKE CREATE, TEMPORARY ON DATABASE :"database_name"
  FROM expense_app_migrator, expense_app_runtime,
       expense_foundry_migrator, expense_foundry_runtime;

REVOKE ALL ON SCHEMA app, app_migrations FROM PUBLIC;
REVOKE ALL ON SCHEMA foundry, foundry_migrations FROM PUBLIC;
REVOKE CREATE ON SCHEMA public
  FROM expense_app_migrator, expense_app_runtime,
       expense_foundry_migrator, expense_foundry_runtime;

REVOKE ALL ON SCHEMA app FROM expense_foundry_migrator, expense_foundry_runtime;
REVOKE ALL ON SCHEMA app_migrations
  FROM expense_app_runtime, expense_foundry_migrator, expense_foundry_runtime;
REVOKE ALL ON SCHEMA foundry FROM expense_app_migrator, expense_app_runtime;
REVOKE ALL ON SCHEMA foundry_migrations
  FROM expense_app_migrator, expense_app_runtime, expense_foundry_runtime;

GRANT USAGE ON SCHEMA app TO expense_app_runtime;
GRANT USAGE ON SCHEMA foundry TO expense_foundry_runtime;
REVOKE ALL ON SCHEMA app_migrations FROM expense_app_runtime;
REVOKE ALL ON SCHEMA foundry_migrations FROM expense_foundry_runtime;

REVOKE ALL ON ALL TABLES IN SCHEMA app FROM expense_app_runtime;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA app FROM expense_app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app
  TO expense_app_runtime;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA app
  TO expense_app_runtime;

REVOKE ALL ON ALL TABLES IN SCHEMA foundry FROM expense_foundry_runtime;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA foundry FROM expense_foundry_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA foundry
  TO expense_foundry_runtime;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA foundry
  TO expense_foundry_runtime;

REVOKE CREATE ON SCHEMA app FROM expense_app_runtime;
REVOKE CREATE ON SCHEMA foundry FROM expense_foundry_runtime;

ALTER DEFAULT PRIVILEGES FOR ROLE expense_app_migrator IN SCHEMA app
  REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE expense_app_migrator IN SCHEMA app
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO expense_app_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE expense_app_migrator IN SCHEMA app
  REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE expense_app_migrator IN SCHEMA app
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO expense_app_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE expense_app_migrator IN SCHEMA app_migrations
  REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE expense_app_migrator IN SCHEMA app_migrations
  REVOKE ALL ON SEQUENCES FROM PUBLIC;

ALTER DEFAULT PRIVILEGES FOR ROLE expense_foundry_migrator IN SCHEMA foundry
  REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE expense_foundry_migrator IN SCHEMA foundry
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO expense_foundry_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE expense_foundry_migrator IN SCHEMA foundry
  REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE expense_foundry_migrator IN SCHEMA foundry
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO expense_foundry_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE expense_foundry_migrator IN SCHEMA foundry_migrations
  REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE expense_foundry_migrator IN SCHEMA foundry_migrations
  REVOKE ALL ON SEQUENCES FROM PUBLIC;

ALTER ROLE expense_app_runtime IN DATABASE :"database_name"
  SET search_path TO pg_catalog;
ALTER ROLE expense_foundry_runtime IN DATABASE :"database_name"
  SET search_path TO pg_catalog;
ALTER ROLE expense_app_migrator IN DATABASE :"database_name"
  SET search_path TO app, app_migrations, pg_catalog;
ALTER ROLE expense_foundry_migrator IN DATABASE :"database_name"
  SET search_path TO foundry, foundry_migrations, pg_catalog;
EOSQL
