#!/usr/bin/env bash
# ExecStartPre of both backup units: make sure $BACKUP_IMAGE exists locally before `docker run`.
#   1. present locally           -> exit 0 (silent, no network)
#   2. docker pull               -> exit 0 on success (covers a public or digest-pinned registry ref)
#   3. docker build -t IMAGE SRC -> exit 0 on success (the normal self-heal after a prune)
#   4. otherwise                 -> exit 1 with one line naming what is missing; the unit fails and
#                                   family-app-backup-retry.service / OnFailure take over.
# Needs no registry credentials: the GHCR package is private and the host holds no login.
# Env: BACKUP_IMAGE (required), BACKUP_SRC_DIR (default /opt/family-app/backup/src).
set -euo pipefail

: "${BACKUP_IMAGE:?BACKUP_IMAGE is required}"
src_dir=${BACKUP_SRC_DIR:-/opt/family-app/backup/src}

# Output of pull/build is discarded on success paths; on failure only our one line is printed.
docker image inspect "$BACKUP_IMAGE" >/dev/null 2>&1 && exit 0
docker pull "$BACKUP_IMAGE" >/dev/null 2>&1 && exit 0
if [[ -f "$src_dir/Dockerfile" ]]; then
  docker build -t "$BACKUP_IMAGE" "$src_dir" >/dev/null && exit 0
fi
echo "[backup] ERROR: image '${BACKUP_IMAGE}' is not on this host, could not be pulled from its registry (the package is private and the host has no login), and could not be built from '${src_dir}' (missing Dockerfile or build failed); re-run bootstrap.sh --only backup to stage the build context" >&2
exit 1
