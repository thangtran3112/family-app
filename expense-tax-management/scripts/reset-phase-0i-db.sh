#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_SCRIPT="$SCRIPT_DIR/compose.sh"

if [[ "${PHASE_0I_RESET_CONFIRM:-}" != "expense-tax-local" ]]; then
  echo "Refusing Phase 0I database reset: set PHASE_0I_RESET_CONFIRM=expense-tax-local" >&2
  exit 1
fi

compose_config=$("$COMPOSE_SCRIPT" config --format json)

app_env=$(node -e '
  const fs = require("node:fs");
  const config = JSON.parse(fs.readFileSync(0, "utf8"));
  process.stdout.write(config.services?.postgres?.environment?.APP_ENV ?? "");
' <<<"$compose_config")
case "${app_env,,}" in
  development|local|test) ;;
  *)
    echo "Refusing Phase 0I database reset outside local development" >&2
    exit 1
    ;;
esac

if ! node -e '
  const fs = require("node:fs");
  const config = JSON.parse(fs.readFileSync(0, "utf8"));
  const databaseUrl = config.services?.["app-api"]?.environment?.APP_DATABASE_URL;
  if (!databaseUrl || !["postgres", "localhost", "127.0.0.1"].includes(new URL(databaseUrl).hostname)) {
    process.exit(1);
  }
' <<<"$compose_config"; then
  echo "Refusing Phase 0I database reset: database host is not local Compose" >&2
  exit 1
fi

container_id=$("$COMPOSE_SCRIPT" ps -q postgres)
if [[ -z "$container_id" ]]; then
  echo "Refusing Phase 0I database reset: expected local Postgres container is not running" >&2
  exit 1
fi

container_name=$(docker inspect --format '{{.Name}}' "$container_id" 2>/dev/null || true)
compose_project=$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' "$container_id" 2>/dev/null || true)
compose_service=$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.service" }}' "$container_id" 2>/dev/null || true)
if [[ "$container_name" != "/expense-tax-postgres" || "$compose_project" != "infrastructure" || "$compose_service" != "postgres" ]]; then
  echo "Refusing Phase 0I database reset: container is not the expected local Compose Postgres" >&2
  exit 1
fi

"$COMPOSE_SCRIPT" stop \
  app-api app-api-migrate foundry-service foundry-service-migrate \
  >/dev/null

compose_environment_value() {
  local key="$1"
  node -e '
    const fs = require("node:fs");
    const config = JSON.parse(fs.readFileSync(0, "utf8"));
    const key = process.argv[1];
    const value = config.services?.postgres?.environment?.[key];
    if (!value) process.exit(1);
    process.stdout.write(value);
  ' "$key" <<<"$compose_config"
}

app_migrator_password=$(compose_environment_value APP_MIGRATOR_DB_PASSWORD)
app_runtime_password=$(compose_environment_value APP_RUNTIME_DB_PASSWORD)
foundry_migrator_password=$(compose_environment_value FOUNDRY_MIGRATOR_DB_PASSWORD)
foundry_runtime_password=$(compose_environment_value FOUNDRY_RUNTIME_DB_PASSWORD)

docker exec -i "$container_id" psql \
  --username postgres \
  --dbname expense_tax_db \
  -v ON_ERROR_STOP=1 \
  -X \
  >/dev/null <<'SQL'
DROP SCHEMA IF EXISTS app CASCADE;
DROP SCHEMA IF EXISTS app_migrations CASCADE;
DROP SCHEMA IF EXISTS foundry CASCADE;
DROP SCHEMA IF EXISTS foundry_migrations CASCADE;
REVOKE ALL PRIVILEGES ON DATABASE expense_tax_db
  FROM expense_app_migrator, expense_app_runtime,
       expense_foundry_migrator, expense_foundry_runtime;
DROP ROLE IF EXISTS expense_app_migrator;
DROP ROLE IF EXISTS expense_app_runtime;
DROP ROLE IF EXISTS expense_foundry_migrator;
DROP ROLE IF EXISTS expense_foundry_runtime;
SQL

docker exec -i \
  -e "APP_ENV=$app_env" \
  -e "APP_MIGRATOR_DB_PASSWORD=$app_migrator_password" \
  -e "APP_RUNTIME_DB_PASSWORD=$app_runtime_password" \
  -e "FOUNDRY_MIGRATOR_DB_PASSWORD=$foundry_migrator_password" \
  -e "FOUNDRY_RUNTIME_DB_PASSWORD=$foundry_runtime_password" \
  "$container_id" \
  /docker-entrypoint-initdb.d/zz-20-expense-tax-roles.sh \
  >/dev/null

echo "Phase 0I database schemas and roles reset in local Postgres"
