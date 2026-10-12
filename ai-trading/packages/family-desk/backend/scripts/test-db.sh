#!/usr/bin/env bash
# Starts a throwaway postgres:17 container, runs the backend test suite against it
# (DESK_TEST_DATABASE_URL + DESK_REQUIRE_DB=1, so the DB tests fail loud if the server never comes
# up), and removes the container on exit however the run ends.
set -euo pipefail
cd "$(dirname "$0")/.."

CONTAINER="desk-test-postgres-$$"
PORT="${DESK_TEST_DB_PORT:-55432}"

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker run -d --rm --name "$CONTAINER" \
  -e POSTGRES_USER=desk -e POSTGRES_PASSWORD=desk -e POSTGRES_DB=postgres \
  -p "127.0.0.1:${PORT}:5432" \
  postgres:17 >/dev/null

export DESK_TEST_DATABASE_URL="postgresql+psycopg://desk:desk@127.0.0.1:${PORT}/postgres"
export DESK_REQUIRE_DB=1

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

uv run pytest -q -rs "$@"
