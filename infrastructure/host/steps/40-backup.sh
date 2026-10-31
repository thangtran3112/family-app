#!/usr/bin/env bash
# Idempotent VPS backup bootstrap step: state/ciphertext directories,
# root-only secret files, and the family-app-backup systemd timer/service
# units. Runs ON the target host as root/sudo. Safe to re-run.
#
# Ruling: reuses the shared cluster's EXISTING Postgres superuser
# (POSTGRES_SUPERUSER_PASSWORD, held in Firestore shared/vps-postgres) rather than
# minting a narrower "backup" role.
# pg_dumpall --globals-only and a pg_dump of every non-template database
# both need superuser-equivalent read access across every app's schema;
# a correctly-scoped read-everywhere role is possible but is a follow-up,
# not required for this plan's scope. Cost if wrong: the backup identity
# can read (but, per Task 1, never upload-replace or read back from GCS)
# every app's data -- the same blast radius `psql` already has today from
# this same host as root.
#
# Required env vars:
#   BACKUP_DIR             - e.g. /opt/family-app/backup
#   BACKUP_GCS_URI         - e.g. gs://expense-tax-tobytran-2026-backups
#   BACKUP_HOST_ID         - stable identifier embedded in object names; REQUIRED, with no
#                              default, so two hosts can never write under the same name
#   AGE_RECIPIENT          - public age1... recipient (Task 1 operator keeps the private half)
#   RECEIPT_VOLUME         - name of the app's receipt Docker volume (e.g.
#                              expense-tax-production_expense_tax_production_storage)
#                              -- a named volume, not a host path: Docker can
#                              mount it into the backup container by name
#                              regardless of which Compose project created it
#   BACKUP_IMAGE           - pullable registry ref, ghcr.io/<owner>/<repo>/family-app-backup@sha256:<digest>
#                              (digest, not a mutable tag), published by
#                              .github/workflows/family-app-backup-image.yml. A bare local
#                              image ID is refused below: the units pull it when missing.
#   UNIT_FILES_DIR         - dir (already scp'd by bootstrap.sh) holding the
#                              three *.service/*.timer template files
#
# Neither secret is an env var here. bootstrap.sh streams the writer key into
# /etc/family-app/backup-writer-key.json and the Postgres superuser password (read from
# Firestore shared/vps-postgres on the operator machine) into
# /etc/family-app/backup-pgpassword, both mode 0400, via
# `sudo install -m 0400 /dev/stdin ...` BEFORE invoking this script, so a secret never
# appears in any process's command-line arguments, local or remote. This script only
# verifies those files landed correctly. (The live host has no ${SHARED_PG_DIR}/.env to
# read the password from.)
set -euo pipefail

: "${BACKUP_DIR:?BACKUP_DIR is required}"
: "${BACKUP_GCS_URI:?BACKUP_GCS_URI is required}"
: "${BACKUP_HOST_ID:?BACKUP_HOST_ID is required}"
: "${AGE_RECIPIENT:?AGE_RECIPIENT is required}"
: "${RECEIPT_VOLUME:?RECEIPT_VOLUME is required}"
: "${BACKUP_IMAGE:?BACKUP_IMAGE is required}"
: "${UNIT_FILES_DIR:?UNIT_FILES_DIR is required}"

# The units must be able to re-pull their image after a Docker prune. A bare local image ID
# (sha256:93747d0e...) cannot be pulled: one prune removed it and no backup ran 2026-10-27..31.
# Accept only a registry reference: host/path with a digest or a tag. (No registry port:
# the host part may not contain ":".) The allowed characters also keep the value safe for the
# sed substitution and the systemd unit text below.
image_name='[A-Za-z0-9.-]+(/[A-Za-z0-9._-]+)+'
image_tag=':[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}'
image_digest='@sha256:[0-9a-f]{64}'
image_hint="Publish the image with .github/workflows/family-app-backup-image.yml (workflow 'Family App Backup Image') and pass the digest it prints: ghcr.io/<owner>/<repo>/family-app-backup@sha256:<digest>"
if [[ "$BACKUP_IMAGE" =~ ^(sha256:)?[0-9a-f]{12,64}$ ]]; then
  echo "[backup] ERROR: BACKUP_IMAGE='${BACKUP_IMAGE}' is a bare local image ID; Docker cannot re-pull it after a prune. ${image_hint}" >&2
  exit 1
fi
if ! [[ "$BACKUP_IMAGE" =~ ^${image_name}(${image_tag})?${image_digest}$ || "$BACKUP_IMAGE" =~ ^${image_name}${image_tag}$ ]]; then
  echo "[backup] ERROR: BACKUP_IMAGE='${BACKUP_IMAGE}' is not a registry reference (need <registry>/<path>@sha256:<64 hex> or <registry>/<path>:<tag>); ${image_hint}" >&2
  exit 1
fi
if [[ "$BACKUP_IMAGE" != *@sha256:* ]]; then
  echo "[backup] WARNING: BACKUP_IMAGE is a tag, which can move; pin the @sha256 digest the image workflow prints." >&2
fi

[[ -s /etc/family-app/backup-writer-key.json ]] || {
  echo "[backup] ERROR: /etc/family-app/backup-writer-key.json missing -- bootstrap.sh must install it (via SSH stdin) before running this step" >&2
  exit 1
}

[[ -s /etc/family-app/backup-pgpassword ]] || {
  echo "[backup] ERROR: /etc/family-app/backup-pgpassword missing -- bootstrap.sh must install it (via SSH stdin, from Firestore shared/vps-postgres) before running this step" >&2
  exit 1
}

echo "[backup] ensuring state/ciphertext directories"
mkdir -p "${BACKUP_DIR}/state" "${BACKUP_DIR}/ciphertext"
chmod 0700 "${BACKUP_DIR}/state" "${BACKUP_DIR}/ciphertext"
chown root:root "${BACKUP_DIR}/state" "${BACKUP_DIR}/ciphertext"

mkdir -p /etc/family-app
chmod 0700 /etc/family-app

echo "[backup] asserting root-only credential files"
umask 077
# backup-pgpassword and backup-writer-key.json were already installed by bootstrap.sh over
# SSH stdin (see header comment); re-assert ownership/permissions idempotently.
chown root:root /etc/family-app/backup-pgpassword /etc/family-app/backup-writer-key.json
chmod 0400 /etc/family-app/backup-pgpassword /etc/family-app/backup-writer-key.json

cat > /etc/family-app/backup.env <<ENV
BACKUP_GCS_URI=${BACKUP_GCS_URI}
BACKUP_HOST_ID=${BACKUP_HOST_ID}
AGE_RECIPIENT=${AGE_RECIPIENT}
RECEIPT_STORAGE_DIR=/receipts
BACKUP_STATE_DIR=/state
BACKUP_CIPHERTEXT_DIR=/ciphertext
GOOGLE_APPLICATION_CREDENTIALS=/run/secrets/writer-key.json
PGHOST=postgres
PGPORT=5432
PGUSER=postgres
PGPASSWORD_FILE=/run/secrets/pgpassword
ENV
chmod 0600 /etc/family-app/backup.env

echo "[backup] installing systemd units"
sed -e "s#__BACKUP_IMAGE__#${BACKUP_IMAGE}#g" -e "s#__RECEIPT_VOLUME__#${RECEIPT_VOLUME}#g" \
  "${UNIT_FILES_DIR}/family-app-backup.service" > /etc/systemd/system/family-app-backup.service
sed -e "s#__BACKUP_IMAGE__#${BACKUP_IMAGE}#g" -e "s#__RECEIPT_VOLUME__#${RECEIPT_VOLUME}#g" \
  "${UNIT_FILES_DIR}/family-app-backup-retry.service" > /etc/systemd/system/family-app-backup-retry.service
cp "${UNIT_FILES_DIR}/family-app-backup.timer" /etc/systemd/system/family-app-backup.timer
chmod 0644 /etc/systemd/system/family-app-backup.service /etc/systemd/system/family-app-backup-retry.service /etc/systemd/system/family-app-backup.timer

systemctl daemon-reload
systemctl enable --now family-app-backup.timer

echo "[backup] done: timer active, next run: $(systemctl list-timers family-app-backup.timer --no-legend 2>/dev/null | awk '{print $1, $2, $3}')"
