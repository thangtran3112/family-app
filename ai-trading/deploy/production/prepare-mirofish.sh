#!/usr/bin/env bash
# Standalone, root-only MiroFish activation (Task 2, app-controls). Renders,
# validates and installs MiroFish's Firestore-sourced credentials and starts
# its Compose service via the exact same checked contract deploy.sh's own
# MIROFISH_ACTIVATE=1 path uses (production/mirofish-runtime.sh), without
# running the rest of deploy.sh's pipeline (secrets/config staging,
# deploy_tag). Invoked by control/runtime.py's Runtime.prepare_mirofish()
# with a fixed argv when an operator turns MiroFish on from the Settings
# switch without a full redeploy.
#
# Every path/project/service is fixed by this script or its caller's own
# constructor-time configuration -- never a caller-supplied command, path,
# image, or container identifier. Returns 0 only on a validated, confirmed
# installation; nonzero on any failure. Never prints or logs a secret key or
# its value (mirofish-runtime.sh's own existing discipline).
#
# Usage:
#   prepare-mirofish.sh --app-dir DIR --secrets-dir DIR --runtime-dir DIR
#                        [--project NAME] [--owner-uid UID] [--lock-fd FD]
#
# --app-dir/--secrets-dir/--runtime-dir/--project/--owner-uid: the same
#   fixed values control/runtime.py's Runtime was constructed with -- never
#   read from an HTTP request.
# --lock-fd FD: a lifecycle-lock file descriptor the CALLER already holds
#   (LOCK_EX), inherited via the Python side's `subprocess.run(...,
#   pass_fds=(FD,))`. This script never acquires a second, independent lock
#   when one is already held -- it only validates the inherited descriptor
#   (state.py's validate_inherited_lock: same device/inode as the fixed
#   lock path, still exclusively locked, owned by --owner-uid) and keeps
#   using it for the duration of this activation.
# Without --lock-fd (a direct root-operator invocation, not through the
#   control helper), this script opens and locks the fixed lifecycle lock
#   path itself, with a bounded wait -- never an unbounded block.
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=mirofish-runtime.sh
source "$SCRIPT_DIR/mirofish-runtime.sh"

#   PREPARE_MIROFISH_LOCK_PATH test-only: overrides the fixed lifecycle lock
#                              path below, so offline tests can exercise
#                              real flock/validate_inherited_lock semantics
#                              without writing into /var/lib/family-app.
#                              Never set this in production.
#   PREPARE_MIROFISH_LOCK_WAIT_SECONDS test-only: overrides the bounded wait
#                              below (production default 30s), so an offline
#                              test can exercise a real busy-lock timeout in
#                              well under a second. Never set this in
#                              production.
#   PREPARE_MIROFISH_DOCKER_PATH test-only: overrides the fixed, minimal PATH
#                              every sanitized Docker/Compose invocation below
#                              uses, so an offline test's fake `docker` (never
#                              a real Docker socket) can be found without
#                              installing it into a real system directory.
#                              Production default is the standard Debian/
#                              Ubuntu package locations this rootful-Linux-
#                              only target installs into. Never set this in
#                              production.
LOCK_PATH="${PREPARE_MIROFISH_LOCK_PATH:-/var/lib/family-app/ai-trading/.control.lock}"
LOCK_WAIT_SECONDS="${PREPARE_MIROFISH_LOCK_WAIT_SECONDS:-30}"
DOCKER_PATH="${PREPARE_MIROFISH_DOCKER_PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}"
# Fixed, local-rootful Docker target -- the design's own "Rootful Docker/
# Linux/systemd only" contract. Explicit DOCKER_HOST/DOCKER_CONTEXT so a
# root operator's own ambient environment, or a persisted `docker context
# use` pointing elsewhere, can never silently redirect this script at a
# remote daemon; never overridable (unlike the three knobs above, this is
# not a path that needs to move for a test fixture -- every test here uses a
# fake `docker` shim and never opens a real socket at all).
DOCKER_SOCK="unix:///var/run/docker.sock"

die() {
  echo "prepare-mirofish: $*" >&2
  exit 1
}

APP_DIR="" SECRETS_DIR="" RUNTIME_ENV_DIR="" PROJECT="ai-trading" OWNER_UID=0 LOCK_FD=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --app-dir) APP_DIR="$2"; shift 2 ;;
    --secrets-dir) SECRETS_DIR="$2"; shift 2 ;;
    --runtime-dir) RUNTIME_ENV_DIR="$2"; shift 2 ;;
    --project) PROJECT="$2"; shift 2 ;;
    --owner-uid) OWNER_UID="$2"; shift 2 ;;
    --lock-fd) LOCK_FD="$2"; shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[[ -n "$APP_DIR" && -n "$SECRETS_DIR" && -n "$RUNTIME_ENV_DIR" ]] \
  || die "--app-dir, --secrets-dir and --runtime-dir are required"
[[ "$OWNER_UID" =~ ^[0-9]+$ ]] || die "--owner-uid must be a nonnegative integer"
[[ -z "$LOCK_FD" || "$LOCK_FD" =~ ^[0-9]+$ ]] || die "--lock-fd must be a nonnegative integer"

IMAGES_ENV="$APP_DIR/images.env"
# Exactly 40 hex characters -- a full commit SHA, never deploy.sh's own more
# tolerant SHA_RE (which also accepts a 64-char digest for its own,
# unrelated purposes). control/runtime.py's Runtime._deployed_env() already
# requires exactly 40; this standalone script must reject anything that
# validator would, not accept a longer value it never would.
SHA_RE='^[0-9a-fA-F]{40}$'

# validate_deployed_image_metadata: the same fixed-format, root-owned,
# plain-file checks control/runtime.py's own Runtime._deployed_env()
# applies, re-derived here so this standalone script never trusts
# caller-controlled image/tag values either. Reads only AI_TRADING_REGISTRY
# and AI_TRADING_IMAGE_TAG -- the exact two names deploy_tag() writes.
validate_deployed_image_metadata() {
  [[ -f "$IMAGES_ENV" && ! -L "$IMAGES_ENV" ]] || die "missing or non-regular $IMAGES_ENV; deploy the stack before preparing MiroFish"
  local owner
  owner="$(stat -c '%u' "$IMAGES_ENV" 2>/dev/null || stat -f '%u' "$IMAGES_ENV" 2>/dev/null)"
  [[ "$owner" == "$OWNER_UID" ]] || die "$IMAGES_ENV is not owned by uid $OWNER_UID"
  local mode group other
  mode="$(file_mode_octal "$IMAGES_ENV")"
  [[ "$mode" =~ ^[0-7]{3,4}$ ]] || die "cannot read a valid mode for $IMAGES_ENV"
  group="${mode: -2:1}"
  other="${mode: -1}"
  (( (10#$group & 2) == 0 && (10#$other & 2) == 0 )) || die "$IMAGES_ENV must not be group/other writable"
  AI_TRADING_REGISTRY="$(sed -n 's/^AI_TRADING_REGISTRY=//p' "$IMAGES_ENV" | head -1)"
  AI_TRADING_IMAGE_TAG="$(sed -n 's/^AI_TRADING_IMAGE_TAG=//p' "$IMAGES_ENV" | head -1)"
  [[ -n "$AI_TRADING_REGISTRY" ]] || die "$IMAGES_ENV has no AI_TRADING_REGISTRY"
  [[ "$AI_TRADING_IMAGE_TAG" =~ $SHA_RE ]] || die "$IMAGES_ENV has no valid full commit-SHA AI_TRADING_IMAGE_TAG"
}
validate_deployed_image_metadata

# compose(): fixed project/images-env/compose-file wrapper, scoped to this
# invocation's own validated app_dir/secrets_dir/registry/tag -- never a
# caller-supplied project, path, or image override. Unlike deploy.sh's own
# compose() (which only ever runs inside a controlled CI/VPS pipeline), this
# script is explicitly documented as directly invocable by a root operator,
# so it never merely prepends its own variables onto the inherited
# environment -- a direct invocation could otherwise honor a hostile or
# merely stale ambient DOCKER_HOST (or COMPOSE_PROFILES/COMPOSE_FILE
# overriding which services/files Compose resolves, a proxy affecting
# registry/image resolution, etc.). `env -i` clears ALL of that first; only
# the fixed PATH/Docker target and this invocation's own validated
# registry/tag/secrets-dir/runtime-dir/Caddyfile-hash are passed through --
# never the caller's ambient environment, never a credential the separate
# render path (activate_mirofish/family_config.py) already owns.
compose() {
  local caddyfile_sha=unset
  [[ -f "$APP_DIR/Caddyfile" ]] && caddyfile_sha="$(sha256sum "$APP_DIR/Caddyfile")" && caddyfile_sha="${caddyfile_sha%% *}"
  env -i \
    PATH="$DOCKER_PATH" \
    DOCKER_CONTEXT=default \
    DOCKER_HOST="$DOCKER_SOCK" \
    AI_TRADING_CADDYFILE_SHA256="$caddyfile_sha" \
    AI_TRADING_REGISTRY="$AI_TRADING_REGISTRY" \
    AI_TRADING_IMAGE_TAG="$AI_TRADING_IMAGE_TAG" \
    AI_TRADING_SECRETS_DIR="$SECRETS_DIR" \
    AI_TRADING_RUNTIME_ENV_DIR="$RUNTIME_ENV_DIR" \
    docker compose --project-name "$PROJECT" --env-file "$IMAGES_ENV" \
      -f "$APP_DIR/docker-compose.yml" -f "$APP_DIR/docker-compose.mirofish.yml" "$@"
}

# stop_remove_mirofish_container: this script's OWN recovery callback,
# resolved by restore_or_remove_mirofish/activate_mirofish at call time
# (bash looks up a function name when it is called, not when the calling
# function was defined) -- deliberately NOT deploy.sh's own same-named
# "stop+force-remove" version. The controls runtime never removes a
# container: only a bounded, mapped `compose stop` on the mirofish service,
# matching control/runtime.py's own apply()/stop contract. File backup and
# self-heal logic stays entirely inside the shared library, unchanged.
stop_remove_mirofish_container() {
  compose stop --timeout 60 mirofish
}

AI_TRADING_RUNTIME_ENV_DIR="$RUNTIME_ENV_DIR"
export AI_TRADING_RUNTIME_ENV_DIR

run_activation() {
  MIROFISH_ACTIVATE=1 activate_mirofish
}

CONTROL_DIR="$(cd "$SCRIPT_DIR/../../control" && pwd)"

# validate_inherited_lock_fd FD: shells out to state.py's own
# validate_inherited_lock (never duplicated here) to confirm FD is the same
# open file description that is exclusively locking the fixed lifecycle
# lock path, owned by OWNER_UID -- then keeps using it unchanged. Exits
# nonzero without ever printing anything beyond state.py's own safe message.
validate_inherited_lock_fd() {
  python3 -c '
import sys
from pathlib import Path
sys.path.insert(0, sys.argv[4])
from state import validate_inherited_lock
try:
    validate_inherited_lock(int(sys.argv[1]), Path(sys.argv[2]), owner_uid=int(sys.argv[3]))
except Exception as exc:
    print(f"validate_inherited_lock_fd: {exc}", file=sys.stderr)
    sys.exit(1)
' "$1" "$LOCK_PATH" "$OWNER_UID" "$CONTROL_DIR"
}

if [[ -n "$LOCK_FD" ]]; then
  # A helper worker already holds this lock (inherited via pass_fds) --
  # validate and reuse it; never acquire a second, independent one.
  validate_inherited_lock_fd "$LOCK_FD" || die "inherited lifecycle lock is invalid"
  run_activation
else
  # Direct root-operator invocation: acquire the fixed lifecycle lock
  # ourselves, with a bounded wait -- never block the helper indefinitely.
  # A failure to create/validate the lock directory must fail closed here,
  # before any attempt to open or acquire the lock -- never swallowed with
  # `|| true` into a later, harder-to-diagnose redirect error.
  install -d -m 0700 "$(dirname "$LOCK_PATH")" || die "cannot create or validate the lifecycle lock directory $(dirname "$LOCK_PATH")"
  exec {ACQUIRED_LOCK_FD}>"$LOCK_PATH" || die "cannot open lifecycle lock $LOCK_PATH"
  flock -w "$LOCK_WAIT_SECONDS" "$ACQUIRED_LOCK_FD" || die "could not acquire the lifecycle lock within ${LOCK_WAIT_SECONDS}s; another operation is in progress"
  run_activation
fi
