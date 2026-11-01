#!/usr/bin/env bash
# Idempotent shared Temporal server step: stages infrastructure/temporal/ to
# /opt/family-app/temporal/, renders /etc/family-app/temporal.env, starts the server and UI,
# and creates the expense-tax namespace. Runs ON the target host as root/sudo. Safe to re-run.
# It replaces the hand-staging runbook that used to live in infrastructure/README.md.
#
# Required env vars:
#   TEMPORAL_STAGE_DIR   - directory (already copied by bootstrap.sh) holding docker-compose.yml,
#                          dynamicconfig.yaml and bootstrap-namespaces.sh
# Input:
#   stdin                - the expense_temporal role password (Firestore shared/temporal
#                          TEMPORAL_DB_PASSWORD), one line. bootstrap.sh streams it, so it never
#                          appears in argv. When stdin is empty or a terminal, an existing
#                          ${TEMPORAL_ENV_FILE} is kept; if there is none the step fails.
# Optional env vars:
#   TEMPORAL_DIR=/opt/family-app/temporal
#   TEMPORAL_ENV_FILE=/etc/family-app/temporal.env   (root:root, mode 0600, one variable only)
#   TEMPORAL_PROJECT=family-temporal                 (Compose project name)
#
# Postgres must already be up (steps/30-postgres.sh) with the temporal and temporal_visibility
# databases and the expense_temporal role in place: this step creates none of them. It refuses to
# start while the legacy per-app Temporal (Compose project expense-tax-production) is running,
# because two servers must never share one set of databases.
set -euo pipefail

: "${TEMPORAL_STAGE_DIR:?TEMPORAL_STAGE_DIR is required}"
TEMPORAL_DIR="${TEMPORAL_DIR:-/opt/family-app/temporal}"
TEMPORAL_ENV_FILE="${TEMPORAL_ENV_FILE:-/etc/family-app/temporal.env}"
TEMPORAL_PROJECT="${TEMPORAL_PROJECT:-family-temporal}"

for f in docker-compose.yml dynamicconfig.yaml bootstrap-namespaces.sh; do
  [[ -f "$TEMPORAL_STAGE_DIR/$f" && ! -L "$TEMPORAL_STAGE_DIR/$f" ]] || {
    echo "[temporal] ERROR: $TEMPORAL_STAGE_DIR/$f is missing or a symlink" >&2
    exit 1
  }
done

legacy="$(docker ps -q \
  --filter label=com.docker.compose.project=expense-tax-production \
  --filter label=com.docker.compose.service=temporal)"
if [[ -n "$legacy" ]]; then
  echo "[temporal] ERROR: the legacy expense-tax-production Temporal is still running; stop it first (never run two servers on the same databases)" >&2
  exit 1
fi

echo "[temporal] staging files to $TEMPORAL_DIR"
install -d -m 0755 "$TEMPORAL_DIR"
install -m 0644 "$TEMPORAL_STAGE_DIR/docker-compose.yml" "$TEMPORAL_DIR/docker-compose.yml"
install -m 0644 "$TEMPORAL_STAGE_DIR/dynamicconfig.yaml" "$TEMPORAL_DIR/dynamicconfig.yaml"
install -m 0755 "$TEMPORAL_STAGE_DIR/bootstrap-namespaces.sh" "$TEMPORAL_DIR/bootstrap-namespaces.sh"

password=""
if [[ ! -t 0 ]]; then
  IFS= read -r password || true
fi
if [[ -n "$password" ]]; then
  [[ "$password" =~ ^[A-Za-z0-9._~+/=-]+$ ]] || {
    echo "[temporal] ERROR: TEMPORAL_DB_PASSWORD has characters outside [A-Za-z0-9._~+/=-]; the env file cannot hold it safely" >&2
    exit 1
  }
  # mkdir -p, not install -d: never change the mode of an existing /etc/family-app.
  mkdir -p "$(dirname "$TEMPORAL_ENV_FILE")"
  (umask 077 && printf 'TEMPORAL_DB_PASSWORD=%s\n' "$password" >"$TEMPORAL_ENV_FILE.new")
  chmod 0600 "$TEMPORAL_ENV_FILE.new"
  mv -f "$TEMPORAL_ENV_FILE.new" "$TEMPORAL_ENV_FILE"
  echo "[temporal] wrote $TEMPORAL_ENV_FILE"
elif [[ ! -s "$TEMPORAL_ENV_FILE" ]]; then
  echo "[temporal] ERROR: no password on stdin and $TEMPORAL_ENV_FILE does not exist" >&2
  exit 1
fi
# Runs as root (sudo), so the file is root-owned; assert the mode on a kept file too.
chmod 0600 "$TEMPORAL_ENV_FILE"
grep -q '^TEMPORAL_DB_PASSWORD=.' "$TEMPORAL_ENV_FILE" || {
  echo "[temporal] ERROR: $TEMPORAL_ENV_FILE does not set TEMPORAL_DB_PASSWORD" >&2
  exit 1
}

docker network inspect family_shared >/dev/null 2>&1 || {
  echo "[temporal] creating network family_shared"
  docker network create family_shared >/dev/null
}

echo "[temporal] bringing up the shared server and UI"
docker compose --project-name "$TEMPORAL_PROJECT" --env-file "$TEMPORAL_ENV_FILE" \
  -f "$TEMPORAL_DIR/docker-compose.yml" up -d --wait

echo "[temporal] ensuring the expense-tax namespace"
bash "$TEMPORAL_DIR/bootstrap-namespaces.sh"
docker exec family-temporal temporal operator namespace describe --address temporal:7233 --namespace default >/dev/null
echo "[temporal] done: server healthy, namespaces expense-tax and default present"
