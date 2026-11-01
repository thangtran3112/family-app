#!/usr/bin/env bash
# Reusable, idempotent host bootstrap for family-app (the OVH VPS, the
# laptop, or any DR host): SSH hardening, firewall, power policy, Tailscale,
# Docker, a shared Postgres cluster with one app's database/roles applied,
# shared Temporal and backups. Runs from your OPERATOR machine (not on the
# host) and pushes each step over SSH/SCP -- mirrors exactly how this was
# first done by hand against the OVH box on 2026-09-08.
#
# See README.md for the manual "bridge" step this script cannot automate
# (the very first connection to a brand-new VPS).
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: bootstrap.sh --host HOST --ssh-user USER --ssh-key PATH --app APP_CONF
                     [--ssh-port PORT] [--target-ssh-port PORT]
                     [--shared-pg-dir PATH] [--only STEPS] [--fetch-secrets-to PATH]
                     [--backup-dir PATH] [--backup-gcs-uri URI] [--backup-host-id ID]
                     [--age-recipient AGE1KEY] [--receipt-volume VOLUME_NAME]
                     [--backup-writer-key-file PATH] [--backup-image IMAGE]
                     [--allow-http 0|1] [--ssh-interface IFACE]
                     [--docker-data-root PATH] [--docker-data-min-gb N]
                     [--require-image-digest] [--data-from-copy]
                     [--tailscale-authkey-file PATH]

Required:
  --host              VPS hostname or IP
  --ssh-user          SSH username (e.g. ubuntu)
  --ssh-key           Path to private key
  --app               Path to an apps/*.conf file (see apps/expense-tax-management.conf)

Optional:
  --ssh-port          Port to CONNECT with right now. Default: 22.
                       Use whatever port is CURRENTLY live -- 22 for a
                       brand-new box's first-ever connection (see
                       README.md "manual bridge"), or the already-hardened
                       port (e.g. 2222) to safely re-run/dry-check.
  --target-ssh-port   Port SSH should end up on after hardening. Default: 2222.
  --shared-pg-dir     Remote dir for the shared Postgres stack.
                       Default: /opt/family-app/postgres
  --only              Comma-separated subset of:
                       firewall,power,ssh,tailscale,docker,postgres,temporal,backup
                       Default: firewall,ssh,docker,postgres (in that order --
                       firewall opens the target SSH port BEFORE sshd starts
                       requiring it exclusively). power, tailscale, temporal
                       and backup are NEVER in the default set: power and
                       tailscale are for an always-on laptop host, temporal
                       needs the Postgres step first, and backup needs secrets
                       (see below) and Task 1's bucket/identities. Whatever is
                       listed always runs in the order firewall, power, ssh,
                       tailscale, docker, postgres, temporal, backup.
  --fetch-secrets-to  After the postgres step, copy the remote shared
                       postgres .env to this local path (chmod 600).
                       Optional -- omit to leave secrets on the VPS only.

Firewall step (defaults keep the original VPS behavior):
  --allow-http         1 (default) opens 80/443; 0 for a tunnel-only host.
  --ssh-interface      Allow SSH only on this interface (e.g. tailscale0). The
                       interface must already exist.

Docker step:
  --docker-data-root   Fail unless Docker's data-root is this directory.
  --docker-data-min-gb Fail unless the filesystem holding it has this many GB.

Postgres step:
  --require-image-digest  Fail unless the app conf's POSTGRES_IMAGE is pinned by digest.
  --data-from-copy        The data volume was copied from another host: bring the
                           cluster up on it and skip every role and database script.

Tailscale step:
  --tailscale-authkey-file  LOCAL file holding the auth key to join with. Without
                       it the key is read from Firestore shared/tailscale
                       (TAILSCALE_ENROLL_OAUTH_CLIENT_SECRET) when that exists; a
                       host that is already on the tailnet needs neither.

Temporal step: reads the expense_temporal role password from Firestore
shared/temporal (TEMPORAL_DB_PASSWORD) on this machine and streams it over SSH
stdin. Backup step: reads the Postgres superuser password from shared/vps-postgres
(POSTGRES_SUPERUSER_PASSWORD) the same way.

Backup step only (all required together when --only includes backup):
  --backup-dir              Remote dir for backup state/ciphertext.
                              Default: /opt/family-app/backup
  --backup-gcs-uri           gs://bucket from Task 1's Terraform output
  --backup-host-id            Stable identifier embedded in backup object names
                               (required, no default: two hosts must never share one)
  --age-recipient              Public age1... recipient (Task 1 operator keeps the private half)
  --receipt-volume       Name of the app's receipt Docker volume (e.g.
                               expense-tax-production_expense_tax_production_storage)
                               -- a named volume, mounted by name regardless
                               of which Compose project created it, not a
                               host path
  --backup-writer-key-file    LOCAL path to the Task 1 writer service account
                               key JSON (see infrastructure/gcp/backup/README.md
                               for how it's created -- never committed, never
                               written to this script's own disk beyond what
                               the operator already has)
  --backup-image              Local versioned tag family-app-backup:<version> (built on the host
                               from <backup-dir>/src), or a registry digest ref

Examples:
  # Brand-new VPS from any provider, first-ever connection on port 22:
  ./bootstrap.sh --host 1.2.3.4 --ssh-user ubuntu --ssh-key ~/.ssh/id_ed25519 \
    --app apps/expense-tax-management.conf --ssh-port 22 --target-ssh-port 2222 \
    --fetch-secrets-to ~/secrets/postgres-vps.env

  # Already-hardened box: safe idempotent re-run / dry-check, or add a step:
  ./bootstrap.sh --host 1.2.3.4 --ssh-user ubuntu --ssh-key ~/.ssh/id_ed25519 \
    --app apps/expense-tax-management.conf --ssh-port 2222 --target-ssh-port 2222

  # Onboard a second app onto the same already-running shared cluster:
  ./bootstrap.sh --host 1.2.3.4 --ssh-user ubuntu --ssh-key ~/.ssh/id_ed25519 \
    --app apps/some-other-app.conf --ssh-port 2222 --target-ssh-port 2222 --only postgres
EOF
}

HOST=""
SSH_USER=""
SSH_KEY=""
APP_CONF=""
SSH_PORT="22"
TARGET_SSH_PORT="2222"
SHARED_PG_DIR="/opt/family-app/postgres"
ONLY="firewall,ssh,docker,postgres"
FETCH_SECRETS_TO=""
BACKUP_DIR="/opt/family-app/backup"
BACKUP_GCS_URI=""
BACKUP_HOST_ID=""
AGE_RECIPIENT=""
RECEIPT_VOLUME=""
BACKUP_WRITER_KEY_FILE=""
BACKUP_IMAGE=""
ALLOW_HTTP="1"
SSH_INTERFACE=""
DOCKER_DATA_ROOT=""
DOCKER_DATA_MIN_GB=""
REQUIRE_IMAGE_DIGEST="0"
DATA_FROM_COPY="0"
TAILSCALE_AUTHKEY_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) HOST="$2"; shift 2 ;;
    --ssh-user) SSH_USER="$2"; shift 2 ;;
    --ssh-key) SSH_KEY="$2"; shift 2 ;;
    --app) APP_CONF="$2"; shift 2 ;;
    --ssh-port) SSH_PORT="$2"; shift 2 ;;
    --target-ssh-port) TARGET_SSH_PORT="$2"; shift 2 ;;
    --shared-pg-dir) SHARED_PG_DIR="$2"; shift 2 ;;
    --only) ONLY="$2"; shift 2 ;;
    --fetch-secrets-to) FETCH_SECRETS_TO="$2"; shift 2 ;;
    --backup-dir) BACKUP_DIR="$2"; shift 2 ;;
    --backup-gcs-uri) BACKUP_GCS_URI="$2"; shift 2 ;;
    --backup-host-id) BACKUP_HOST_ID="$2"; shift 2 ;;
    --age-recipient) AGE_RECIPIENT="$2"; shift 2 ;;
    --receipt-volume) RECEIPT_VOLUME="$2"; shift 2 ;;
    --backup-writer-key-file) BACKUP_WRITER_KEY_FILE="$2"; shift 2 ;;
    --backup-image) BACKUP_IMAGE="$2"; shift 2 ;;
    --allow-http) ALLOW_HTTP="$2"; shift 2 ;;
    --ssh-interface) SSH_INTERFACE="$2"; shift 2 ;;
    --docker-data-root) DOCKER_DATA_ROOT="$2"; shift 2 ;;
    --docker-data-min-gb) DOCKER_DATA_MIN_GB="$2"; shift 2 ;;
    --require-image-digest) REQUIRE_IMAGE_DIGEST="1"; shift ;;
    --data-from-copy) DATA_FROM_COPY="1"; shift ;;
    --tailscale-authkey-file) TAILSCALE_AUTHKEY_FILE="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage; exit 1 ;;
  esac
done

for required in HOST SSH_USER SSH_KEY APP_CONF; do
  if [[ -z "${!required}" ]]; then
    echo "Missing required --${required,,}" >&2
    usage
    exit 1
  fi
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# The Firestore CLI the operator-side secret reads go through (overridable for tests).
FAMILY_CONFIG_CLI="${FAMILY_CONFIG_CLI:-$REPO_ROOT/common/config/family_config.py}"

# Fail on malformed option values here, on the operator machine, before any step touches the host.
[[ "$ALLOW_HTTP" == 0 || "$ALLOW_HTTP" == 1 ]] || { echo "--allow-http must be 0 or 1" >&2; exit 1; }
[[ -z "$SSH_INTERFACE" || "$SSH_INTERFACE" =~ ^[A-Za-z0-9_.-]{1,15}$ ]] || { echo "--ssh-interface is not a valid interface name" >&2; exit 1; }
[[ -z "$DOCKER_DATA_MIN_GB" || "$DOCKER_DATA_MIN_GB" =~ ^[0-9]+$ ]] || { echo "--docker-data-min-gb must be a whole number" >&2; exit 1; }
[[ -z "$DOCKER_DATA_ROOT" || "$DOCKER_DATA_ROOT" =~ ^/[A-Za-z0-9_./-]*$ ]] || { echo "--docker-data-root must be an absolute path" >&2; exit 1; }

if [[ ! -f "$APP_CONF" ]]; then
  echo "App config not found: $APP_CONF" >&2
  exit 1
fi
# shellcheck disable=SC1090
source "$APP_CONF"
: "${APP_NAME:?$APP_CONF must set APP_NAME}"
: "${POSTGRES_DB_NAME:?$APP_CONF must set POSTGRES_DB_NAME}"
: "${POSTGRES_IMAGE:?$APP_CONF must set POSTGRES_IMAGE}"
: "${ROLE_INIT_SCRIPT_REPO_RELATIVE_PATH:?$APP_CONF must set ROLE_INIT_SCRIPT_REPO_RELATIVE_PATH}"
: "${REQUIRED_PASSWORD_VARS:?$APP_CONF must set REQUIRED_PASSWORD_VARS}"

ROLE_SCRIPT_LOCAL_PATH="$REPO_ROOT/$ROLE_INIT_SCRIPT_REPO_RELATIVE_PATH"
if [[ ! -f "$ROLE_SCRIPT_LOCAL_PATH" ]]; then
  echo "Role init script not found: $ROLE_SCRIPT_LOCAL_PATH" >&2
  exit 1
fi

# Current connect port -- updated in-place once the ssh step succeeds.
CURRENT_PORT="$SSH_PORT"

ssh_run() {
  ssh -p "$CURRENT_PORT" -i "$SSH_KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
    -o ConnectTimeout=10 "${SSH_USER}@${HOST}" "$@"
}

scp_to() {
  local local_path="$1" remote_path="$2"
  scp -P "$CURRENT_PORT" -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new "$local_path" "${SSH_USER}@${HOST}:${remote_path}"
}

should_run() {
  [[ ",${ONLY}," == *",${1},"* ]]
}

echo "== family-app VPS bootstrap: ${APP_NAME} @ ${SSH_USER}@${HOST} =="
echo "   connect port: ${CURRENT_PORT}  target ssh port: ${TARGET_SSH_PORT}  steps: ${ONLY}"

if should_run firewall; then
  echo "-- [firewall] --"
  scp_to "$SCRIPT_DIR/steps/00-firewall.sh" /tmp/00-firewall.sh
  ssh_run "sudo TARGET_SSH_PORT=${TARGET_SSH_PORT} ALLOW_HTTP=${ALLOW_HTTP} SSH_INTERFACE=${SSH_INTERFACE} bash /tmp/00-firewall.sh"
fi

if should_run power; then
  echo "-- [power] --"
  scp_to "$SCRIPT_DIR/steps/05-power.sh" /tmp/05-power.sh
  ssh_run "sudo bash /tmp/05-power.sh"
fi

if should_run ssh; then
  echo "-- [ssh hardening] --"
  scp_to "$SCRIPT_DIR/steps/10-harden-ssh.sh" /tmp/10-harden-ssh.sh
  ssh_run "sudo TARGET_SSH_PORT=${TARGET_SSH_PORT} bash /tmp/10-harden-ssh.sh"
  if [[ "$CURRENT_PORT" != "$TARGET_SSH_PORT" ]]; then
    echo "   verifying a FRESH connection on the new port ${TARGET_SSH_PORT}..."
    CURRENT_PORT="$TARGET_SSH_PORT"
    ssh_run "echo connected on \$(sudo sshd -T | awk '/^port /{print \$2; exit}')"
  fi
fi

if should_run tailscale; then
  echo "-- [tailscale] --"
  scp_to "$SCRIPT_DIR/steps/15-tailscale.sh" /tmp/15-tailscale.sh
  # The auth key is streamed over SSH stdin (never argv). No key is fine for a host that is
  # already on the tailnet; the step itself fails when it needs one and has none.
  # TODO(tailscale org): the key name below is the OAuth "enroll" client secret the owner keeps in
  # shared/tailscale; switch to the Terraform-issued tagged auth key if that replaces it.
  if [[ -n "$TAILSCALE_AUTHKEY_FILE" ]]; then
    ssh_run "sudo bash /tmp/15-tailscale.sh" < "$TAILSCALE_AUTHKEY_FILE"
  elif "$FAMILY_CONFIG_CLI" keys shared/tailscale 2>/dev/null | grep -qx 'TAILSCALE_ENROLL_OAUTH_CLIENT_SECRET'; then
    printf '%s\n' "$("$FAMILY_CONFIG_CLI" get shared/tailscale TAILSCALE_ENROLL_OAUTH_CLIENT_SECRET)" \
      | ssh_run "sudo bash /tmp/15-tailscale.sh"
  else
    ssh_run "sudo bash /tmp/15-tailscale.sh" < /dev/null
  fi
fi

if should_run docker; then
  echo "-- [docker] --"
  scp_to "$SCRIPT_DIR/steps/20-docker.sh" /tmp/20-docker.sh
  docker_env=""
  [[ -z "$DOCKER_DATA_ROOT" ]] || docker_env+=" DOCKER_DATA_ROOT=${DOCKER_DATA_ROOT}"
  [[ -z "$DOCKER_DATA_MIN_GB" ]] || docker_env+=" DOCKER_DATA_MIN_GB=${DOCKER_DATA_MIN_GB}"
  ssh_run "sudo${docker_env} bash /tmp/20-docker.sh"
fi

if should_run postgres; then
  echo "-- [postgres] --"
  role_script_name="$(basename "$ROLE_SCRIPT_LOCAL_PATH")"
  remote_role_script_name="${POSTGRES_DB_NAME}__${role_script_name}"
  ssh_run "sudo mkdir -p ${SHARED_PG_DIR}/initdb"
  scp_to "$ROLE_SCRIPT_LOCAL_PATH" "/tmp/${remote_role_script_name}"
  ssh_run "sudo mv /tmp/${remote_role_script_name} ${SHARED_PG_DIR}/initdb/${remote_role_script_name} && sudo chmod 644 ${SHARED_PG_DIR}/initdb/${remote_role_script_name}"
  scp_to "$SCRIPT_DIR/steps/30-postgres.sh" /tmp/30-postgres.sh
  pg_args=""
  [[ "$DATA_FROM_COPY" != 1 ]] || pg_args=" --data-from-copy"
  ssh_run "sudo SHARED_PG_DIR=${SHARED_PG_DIR} POSTGRES_IMAGE=${POSTGRES_IMAGE} REQUIRE_IMAGE_DIGEST=${REQUIRE_IMAGE_DIGEST} REQUIRED_PASSWORD_VARS='${REQUIRED_PASSWORD_VARS}' bash /tmp/30-postgres.sh${pg_args}"

  if [[ -n "$FETCH_SECRETS_TO" ]]; then
    echo "   fetching ${SHARED_PG_DIR}/.env -> ${FETCH_SECRETS_TO}"
    ssh_run "sudo cat ${SHARED_PG_DIR}/.env" > "$FETCH_SECRETS_TO"
    chmod 600 "$FETCH_SECRETS_TO"
  fi
fi

if should_run temporal; then
  echo "-- [temporal] --"
  stage="/tmp/family-temporal-stage"
  ssh_run "install -d -m 0700 ${stage}"
  for f in docker-compose.yml dynamicconfig.yaml bootstrap-namespaces.sh; do
    scp_to "$REPO_ROOT/infrastructure/temporal/$f" "${stage}/$f"
  done
  scp_to "$SCRIPT_DIR/steps/35-temporal.sh" /tmp/35-temporal.sh
  # The expense_temporal role password comes from Firestore shared/temporal and is streamed over
  # SSH stdin, so it never appears in any argv.
  printf '%s\n' "$("$FAMILY_CONFIG_CLI" get shared/temporal TEMPORAL_DB_PASSWORD)" \
    | ssh_run "sudo TEMPORAL_STAGE_DIR=${stage} bash /tmp/35-temporal.sh"
  ssh_run "rm -rf ${stage}"
fi

if should_run backup; then
  echo "-- [backup] --"
  for required in BACKUP_GCS_URI BACKUP_HOST_ID AGE_RECIPIENT RECEIPT_VOLUME BACKUP_WRITER_KEY_FILE BACKUP_IMAGE; do
    if [[ -z "${!required}" ]]; then
      echo "Missing required --${required,,} for --only backup" | tr '_' '-' >&2
      exit 1
    fi
  done
  if [[ ! -f "$BACKUP_WRITER_KEY_FILE" ]]; then
    echo "Backup writer key file not found: $BACKUP_WRITER_KEY_FILE" >&2
    exit 1
  fi
  BACKUP_DIR_REPO="$REPO_ROOT/infrastructure/backup"
  # Units, the image build context and the self-heal helper go into one private stage dir;
  # 40-backup.sh installs them (the host rebuilds the image itself: the GHCR package is private).
  stage="/tmp/family-backup-stage"
  ssh_run "install -d -m 0700 ${stage}"
  for f in family-app-backup.service family-app-backup.timer family-app-backup-retry.service \
    Dockerfile lib.sh backup.sh restore.sh recovery-drill.sh ensure-backup-image.sh; do
    scp_to "$BACKUP_DIR_REPO/$f" "${stage}/$f"
  done
  scp_to "$BACKUP_DIR_REPO/check-backup-freshness.sh" /tmp/check-backup-freshness.sh
  scp_to "$SCRIPT_DIR/steps/40-backup.sh" /tmp/40-backup.sh
  # The writer key NEVER appears in a command line (local or remote,
  # scp's argv or ssh's argv) -- it is streamed over the SSH stdin
  # channel straight into its final root-only mode-0400 file in one
  # `install` call. A shell command's arguments are visible to any other
  # local user via `ps`; a pipe's bytes are not.
  ssh_run "sudo mkdir -p /etc/family-app && sudo install -m 0400 /dev/stdin /etc/family-app/backup-writer-key.json" \
    < "$BACKUP_WRITER_KEY_FILE"
  # Same discipline for the Postgres superuser password (Firestore shared/vps-postgres): stdin
  # into a root-only 0400 file, no trailing newline (the backup container reads it verbatim).
  printf '%s' "$("$FAMILY_CONFIG_CLI" get shared/vps-postgres POSTGRES_SUPERUSER_PASSWORD)" \
    | ssh_run "sudo install -m 0400 /dev/stdin /etc/family-app/backup-pgpassword"
  ssh_run "sudo BACKUP_DIR=${BACKUP_DIR} BACKUP_GCS_URI=${BACKUP_GCS_URI} \
    BACKUP_HOST_ID=${BACKUP_HOST_ID} AGE_RECIPIENT=${AGE_RECIPIENT} RECEIPT_VOLUME=${RECEIPT_VOLUME} \
    BACKUP_IMAGE=${BACKUP_IMAGE} UNIT_FILES_DIR=${stage} \
    bash /tmp/40-backup.sh"
  ssh_run "rm -rf ${stage}"
fi

echo "== done =="
