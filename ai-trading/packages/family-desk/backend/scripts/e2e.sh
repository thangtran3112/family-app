#!/usr/bin/env bash
# Starts a throwaway postgres:17 container and runs the Desk browser E2E suite against it
# (tests/e2e/run.py: proxy tests, Playwright at 1440 and 1180, the real-HTTP and alert-path checks),
# removing the container on exit. Needs the static export: `pnpm build` in ../frontend first.
# Arguments go to run.py, e.g.  scripts/e2e.sh --browser -- --project=desktop-1180 e2e/desk/shell.spec.ts
set -euo pipefail
cd "$(dirname "$0")/.."

CONTAINER="desk-e2e-postgres-$$"
PORT="${DESK_E2E_DB_PORT:-55438}"

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker run -d --rm --name "$CONTAINER" \
  -e POSTGRES_USER=desk -e POSTGRES_PASSWORD=desk -e POSTGRES_DB=postgres \
  -p "127.0.0.1:${PORT}:5432" \
  postgres:17 >/dev/null

ready=0
for _ in $(seq 1 60); do
  if docker exec "$CONTAINER" pg_isready -U desk >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.5
done
if [ "$ready" -ne 1 ]; then
  echo "postgres:17 never became ready" >&2
  exit 1
fi

export DESK_E2E_ADMIN_DATABASE_URL="postgresql+psycopg://desk:desk@127.0.0.1:${PORT}/postgres"
uv run python tests/e2e/run.py "$@"
