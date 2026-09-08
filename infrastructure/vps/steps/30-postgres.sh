#!/usr/bin/env bash
# Idempotent shared PostgreSQL cluster for family-app VPS deployments.
# Runs ON the target host as root/sudo. Safe to re-run, including to
# onboard a NEW app's database/roles into an ALREADY-running cluster.
#
# Design: one shared Postgres container (matches
# infrastructure/README.md's "why not per-app postgres" -- single cluster
# saves VPS RAM; DB-per-app gives isolation without extra containers).
# Each app owns its own role/schema init script (e.g.
# expense-tax-management/docker/postgres/zz-20-expense-tax-roles.sh).
#
# bootstrap.sh copies each app's role script into
#   ${SHARED_PG_DIR}/initdb/<db_name>__<original-filename>.sh
# The "<db_name>__" prefix is how this script knows which database each
# script targets (a role script itself has no way to declare that -- it
# just reads $POSTGRES_DB, so we set that env var per-invocation instead
# of relying on the container-wide default).
#
# Required env vars:
#   SHARED_PG_DIR          - e.g. /opt/family-app/postgres
#   POSTGRES_IMAGE         - e.g. pgvector/pgvector:pg17
#   REQUIRED_PASSWORD_VARS - space-separated env var NAMES this app's role
#                            script(s) need (values generated if missing),
#                            e.g. "APP_MIGRATOR_DB_PASSWORD APP_RUNTIME_DB_PASSWORD"
#
# NOTE ON docker-entrypoint-initdb.d: files under ${SHARED_PG_DIR}/initdb/
# are also mounted there, so on a truly fresh data volume Postgres runs
# them automatically once (harmless -- see below, we re-apply explicitly
# regardless). This script does NOT depend on that auto-run: it always
# explicitly (re-)applies every initdb/*.sh directly against the live
# server after startup, so onboarding app N+1 onto an already-running
# cluster works the same way as a fresh bootstrap. Running a script twice
# is safe because these scripts are themselves idempotent (CREATE
# ROLE/SCHEMA IF NOT EXISTS, etc. -- see zz-20-expense-tax-roles.sh).
set -euo pipefail

: "${SHARED_PG_DIR:?SHARED_PG_DIR is required}"
: "${POSTGRES_IMAGE:?POSTGRES_IMAGE is required}"
: "${REQUIRED_PASSWORD_VARS:?REQUIRED_PASSWORD_VARS is required}"

mkdir -p "${SHARED_PG_DIR}/initdb"
cd "$SHARED_PG_DIR"

gen() { openssl rand -base64 33 | tr -d '=+/\n'; }

touch .env
chmod 600 .env
# shellcheck disable=SC1091
set -a; source ./.env; set +a

append_if_missing() {
  local var_name="$1"
  if [[ -z "${!var_name:-}" ]]; then
    echo "${var_name}=$(gen)" >> .env
    echo "[postgres] generated ${var_name}"
  fi
}

append_if_missing POSTGRES_SUPERUSER_PASSWORD
for v in $REQUIRED_PASSWORD_VARS; do
  append_if_missing "$v"
done

# Re-source now that any newly-generated values are appended.
set -a; source ./.env; set +a

# Deliberately NOT using `env_file: .env` here -- that would bake every
# app's role passwords into the postgres container's permanent
# environment (visible via `docker inspect`/`/proc/1/environ`) even
# though only the superuser password is actually needed by the postgres
# process itself. App/foundry role passwords are only ever passed
# transiently via `docker compose exec -e VAR=value` below, scoped to
# the single command that needs them. Compose auto-loads `.env` from
# this same directory for its OWN `${...}` substitution below (that's
# separate from `env_file:` and does not inject anything into the
# container beyond what's explicitly listed under `environment:`).
cat > docker-compose.yml <<YAML
services:
  postgres:
    image: ${POSTGRES_IMAGE}
    container_name: family-app-postgres
    restart: unless-stopped
    ports:
      - "127.0.0.1:5432:5432"
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: \${POSTGRES_SUPERUSER_PASSWORD:?POSTGRES_SUPERUSER_PASSWORD is required}
      POSTGRES_DB: postgres
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./initdb:/docker-entrypoint-initdb.d:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 5s
      retries: 10

volumes:
  postgres_data:
YAML

echo "[postgres] bringing up shared cluster"
docker compose up -d

echo "[postgres] waiting for healthy"
for i in $(seq 1 30); do
  status=$(docker inspect --format='{{.State.Health.Status}}' family-app-postgres 2>/dev/null || echo starting)
  [[ "$status" == "healthy" ]] && break
  sleep 2
done
final_status=$(docker inspect --format='{{.State.Health.Status}}' family-app-postgres 2>/dev/null || echo unknown)
if [[ "$final_status" != "healthy" ]]; then
  echo "[postgres] ERROR: container did not become healthy (status=$final_status)" >&2
  docker compose logs --tail=50 postgres >&2
  exit 1
fi
echo "[postgres] healthy"

shopt -s nullglob
scripts=("${SHARED_PG_DIR}"/initdb/*__*.sh)
shopt -u nullglob

if [[ ${#scripts[@]} -eq 0 ]]; then
  echo "[postgres] no <db_name>__*.sh scripts found in initdb/, nothing to apply"
  exit 0
fi

# Derive the distinct set of target databases from filenames.
declare -A seen_dbs=()
for script_path in "${scripts[@]}"; do
  script_name="$(basename "$script_path")"
  db_name="${script_name%%__*}"
  seen_dbs["$db_name"]=1
done

echo "[postgres] ensuring databases exist: ${!seen_dbs[*]}"
for db in "${!seen_dbs[@]}"; do
  exists="$(docker compose exec -T postgres psql -U postgres -tAc "SELECT 1 FROM pg_database WHERE datname='${db}'")"
  if [[ "$exists" == "1" ]]; then
    echo "[postgres]   ${db}: already exists"
  else
    echo "[postgres]   ${db}: creating"
    docker compose exec -T postgres psql -U postgres -c "CREATE DATABASE \"${db}\";"
  fi
done

echo "[postgres] (re-)applying app role/schema scripts"
for script_path in "${scripts[@]}"; do
  script_name="$(basename "$script_path")"
  db_name="${script_name%%__*}"
  echo "[postgres]   applying ${script_name} against database '${db_name}'"

  exec_env_args=(-e "POSTGRES_USER=postgres" -e "POSTGRES_DB=${db_name}")
  for v in $REQUIRED_PASSWORD_VARS; do
    if [[ -n "${!v:-}" ]]; then
      exec_env_args+=(-e "${v}=${!v}")
    fi
  done

  docker compose exec -T "${exec_env_args[@]}" postgres bash < "$script_path"
done

echo "[postgres] done"
