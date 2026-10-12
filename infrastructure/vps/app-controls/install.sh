#!/usr/bin/env bash
# Portable Linux BOOTSTRAP for the Trading Hub app-control helper (01g, Task
# 5, fix round 1). Runs on the target host itself (root), once per deploy,
# ALWAYS before deploy.sh. Deliberately installs/activates NOTHING
# versioned: the control helper's own code/catalog, the standalone MiroFish
# preparer scripts, and the systemd unit are deploy.sh's own job now
# (deploy.sh's existing atomic CONFIG_FILES transaction plus its own
# stage_unit/restore_or_remove_unit) -- precisely so deploy.sh's backup
# step, which runs AFTER this script, always captures the genuinely prior
# on-disk version, never content this same run just wrote (task-5-review
# fix round 1, Critical #1: install.sh running first and mutating those
# paths broke "old deploy rollback must restore the matching helper/
# runtime version").
#
# This script covers only what genuinely has no "prior version" to roll
# back to -- the dedicated OS identity, the state/run/socket directories,
# and (idempotently) the persisted preference file itself:
#   - validate Linux/systemd/Python/rootful Docker;
#   - create/validate the fixed, non-login, no-docker-group
#     ai-trading-gateway UID/GID 22001 identity;
#   - validate/create the state/run/socket directories (reject a symlink
#     or wrong owner, never silently widen one already present);
#   - initialize/adopt $STATE_DIR/control.json, using the STAGED
#     control/state.py + catalog.json directly from --src-dir (never
#     installing them to $APP_DIR -- deploy.sh's own transaction owns that
#     install, moments later, under the same lifecycle lock).
# Idempotent: a re-run never resets an existing, valid preference file,
# never widens an already-correct identity/directory, never touches
# anything versioned.
#
# Usage: install.sh --src-dir DIR [--app-dir DIR] [--state-dir DIR]
#                    [--run-dir DIR] [--project NAME]
#
# --src-dir DIR (required): a staged source tree holding at least
#   DIR/ai-trading/control/{catalog.json,state.py} -- the same relative
#   layout as this repository (the workflow stages this tree over SSH,
#   never scp's individual files to ad hoc paths).
# --app-dir/--state-dir/--run-dir: override the fixed production locations
#   below -- test-only (a real bootstrap never needs this; the defaults are
#   the whole point of "fixed UID/GID, fixed paths").
# --project NAME: Compose project name used only to detect an existing
#   stack's actually-running services for first-activation adoption
#   (default "ai-trading", matching deploy.sh's own default).
#
# Exit nonzero on ANY unmet precondition -- occupied UID/GID, rootless/
# userns Docker, a symlinked state/run/socket directory, or an incomplete
# source tree -- before creating/mutating anything.
set -Eeuo pipefail

GATEWAY_UID=22001
GATEWAY_GID=22001
GATEWAY_USER=ai-trading-gateway

APP_DIR="${APP_DIR:-/opt/family-app/ai-trading}"
STATE_DIR="${AI_TRADING_STATE_DIR:-/var/lib/family-app/ai-trading}"
RUN_DIR="${AI_TRADING_RUN_DIR:-/run/family-app}"
PROJECT="ai-trading"
SRC_DIR=""

die() {
  echo "install: $*" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --src-dir) SRC_DIR="$2"; shift 2 ;;
    --app-dir) APP_DIR="$2"; shift 2 ;;
    --state-dir) STATE_DIR="$2"; shift 2 ;;
    --run-dir) RUN_DIR="$2"; shift 2 ;;
    --project) PROJECT="$2"; shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[[ -n "$SRC_DIR" ]] || die "--src-dir is required"
[[ -d "$SRC_DIR" ]] || die "--src-dir $SRC_DIR does not exist"

CONTROL_SRC="$SRC_DIR/ai-trading/control"
SOCKET_DIR="$RUN_DIR/ai-trading-control"

# --- 1. Linux/systemd/Python/rootful-Docker preconditions ------------------
# Every one of these fails closed before touching a single file, user, or
# group -- an installer error must never leave a half-created identity
# behind. systemd itself is still a hard precondition (deploy.sh's own
# unit install/activation moments later needs it), even though this script
# no longer touches any unit file directly.

[[ "$(uname -s)" == Linux ]] || die "this installer only supports Linux (got $(uname -s)); no rootless/macOS install path exists"
command -v systemctl >/dev/null 2>&1 || die "systemd (systemctl) is required"
command -v python3 >/dev/null 2>&1 || die "python3 is required"
command -v docker >/dev/null 2>&1 || die "docker is required"

# Rootful Docker only (design doc section 1/5): reject a rootless daemon or a
# userns-remap mapping instead of weakening the helper's SO_PEERCRED check to
# accommodate either. `docker info` is queried once and grepped for both
# markers -- never two separate daemon round-trips that could observe a
# changing daemon differently.
docker_info="$(docker info --format '{{json .SecurityOptions}}' 2>&1)" \
  || die "cannot query the Docker daemon (docker info failed): $docker_info"
case "$docker_info" in
  *name=rootless*) die "rootless Docker is not supported; this helper requires a rootful daemon" ;;
esac
case "$docker_info" in
  *name=userns*) die "Docker userns-remap is not supported; this helper requires a fixed, unmapped UID 22001" ;;
esac

# --- 2. Dedicated non-login gateway identity, no Docker group --------------
# Occupied UID/GID under a DIFFERENT name, or an existing ai-trading-gateway
# under a DIFFERENT UID/GID, is rejected rather than silently reused/renamed
# -- "occupied UID/path/symlink rejection" (task-5-brief). A fresh identity
# is created only when neither the name nor the UID/GID already exist.

existing_user_of_uid="$(getent passwd "$GATEWAY_UID" | cut -d: -f1 || true)"
if [[ -n "$existing_user_of_uid" && "$existing_user_of_uid" != "$GATEWAY_USER" ]]; then
  die "UID $GATEWAY_UID is already in use by '$existing_user_of_uid', not '$GATEWAY_USER'"
fi
existing_group_of_gid="$(getent group "$GATEWAY_GID" | cut -d: -f1 || true)"
if [[ -n "$existing_group_of_gid" && "$existing_group_of_gid" != "$GATEWAY_USER" ]]; then
  die "GID $GATEWAY_GID is already in use by group '$existing_group_of_gid', not '$GATEWAY_USER'"
fi

if getent group "$GATEWAY_USER" >/dev/null 2>&1; then
  found_gid="$(getent group "$GATEWAY_USER" | cut -d: -f3)"
  [[ "$found_gid" == "$GATEWAY_GID" ]] || die "group '$GATEWAY_USER' exists with unexpected GID $found_gid (expected $GATEWAY_GID)"
else
  groupadd --gid "$GATEWAY_GID" "$GATEWAY_USER" || die "failed to create group $GATEWAY_USER"
fi

if id -u "$GATEWAY_USER" >/dev/null 2>&1; then
  found_uid="$(id -u "$GATEWAY_USER")"
  found_gid_of_user="$(id -g "$GATEWAY_USER")"
  [[ "$found_uid" == "$GATEWAY_UID" && "$found_gid_of_user" == "$GATEWAY_GID" ]] \
    || die "user '$GATEWAY_USER' exists with unexpected UID/GID $found_uid:$found_gid_of_user (expected $GATEWAY_UID:$GATEWAY_GID)"
else
  useradd --uid "$GATEWAY_UID" --gid "$GATEWAY_GID" --no-create-home \
    --shell /usr/sbin/nologin --system "$GATEWAY_USER" \
    || die "failed to create user $GATEWAY_USER"
fi

# Never a member of the docker group, new or pre-existing (task-5-brief:
# "fixed UID/GID 22001 nonlogin no docker group").
if id -nG "$GATEWAY_USER" 2>/dev/null | tr ' ' '\n' | grep -qx docker; then
  die "'$GATEWAY_USER' must not be a member of the docker group"
fi

# --- 3. State/run/socket directories: reject a symlink or wrong owner ------
# `validate_dir PATH OWNER_UID OWNER_GID MODE` creates PATH at MODE if
# genuinely absent; an EXISTING path must already be a real, non-symlink
# directory with exactly this owner/group/mode, or installation refuses to
# proceed -- never silently chmod/chown over something already there with
# the wrong shape (state.py's own `_validate_parent`/`_stat_directory`
# apply the identical no-follow/owner/mode discipline to the files inside).
validate_dir() {
  local path="$1" owner_uid="$2" owner_gid="$3" mode="$4"
  if [[ -L "$path" ]]; then
    die "$path must not be a symlink"
  fi
  if [[ ! -e "$path" ]]; then
    install -d -o "$owner_uid" -g "$owner_gid" -m "$mode" "$path" || die "failed to create $path"
    return 0
  fi
  [[ -d "$path" ]] || die "$path exists but is not a directory"
  local found_uid found_gid found_mode
  found_uid="$(stat -c '%u' "$path" 2>/dev/null || stat -f '%u' "$path")"
  found_gid="$(stat -c '%g' "$path" 2>/dev/null || stat -f '%g' "$path")"
  found_mode="$(stat -c '%a' "$path" 2>/dev/null || stat -f '%Lp' "$path")"
  [[ "$found_uid" == "$owner_uid" && "$found_gid" == "$owner_gid" ]] \
    || die "$path has unexpected owner $found_uid:$found_gid (expected $owner_uid:$owner_gid)"
  [[ "$found_mode" == "$mode" ]] || die "$path has unexpected mode $found_mode (expected $mode)"
}

validate_dir "$STATE_DIR" 0 0 700
# $RUN_DIR (/run/family-app) is tmpfs and vanishes every reboot; this check
# only guards against a hijacked path within the SAME boot (e.g. a re-run of
# this installer right after a manual/compromised change). systemd's own
# RuntimeDirectory=family-app/ai-trading-control (the unit deploy.sh installs)
# creates $SOCKET_DIR itself before every start and keeps it stable across
# restarts via RuntimeDirectoryPreserve=yes -- this script never deletes/
# recreates that directory on its own, only validates it when already present.
validate_dir "$RUN_DIR" 0 0 755
if [[ -e "$SOCKET_DIR" || -L "$SOCKET_DIR" ]]; then
  validate_dir "$SOCKET_DIR" 0 "$GATEWAY_GID" 710
fi

# --- 4. Source artifacts present and complete ------------------------------
# Only what this bootstrap actually runs -- catalog.json/state.py, used
# below to initialize/adopt state directly from the staged source, never
# installed to $APP_DIR by this script.
REQUIRED_FILES=(
  "$CONTROL_SRC/catalog.json"
  "$CONTROL_SRC/state.py"
)
for f in "${REQUIRED_FILES[@]}"; do
  [[ -f "$f" && ! -L "$f" ]] || die "missing or non-regular required source file: $f"
done

# --- 5. Validate content before running it ---------------------------------
# Byte-compile the staged state.py (parse/compile only -- py_compile never
# executes module-level code) so a syntax error is caught before it is
# actually run below. PYTHONPYCACHEPREFIX redirects the .pyc output away
# from $CONTROL_SRC (which may be a read-only staged/checked-out tree) into
# a disposable scratch directory removed immediately after.
PYCACHE_SCRATCH="$(mktemp -d)"
trap 'rm -rf "$PYCACHE_SCRATCH"' EXIT
PYTHONPYCACHEPREFIX="$PYCACHE_SCRATCH" python3 -m py_compile "$CONTROL_SRC/state.py" \
  || die "staged $CONTROL_SRC/state.py has invalid Python syntax"
# control/catalog.json's schema is validated by importing the staged
# control/state.py itself (its own module-level _load_catalog() call already
# runs validate_catalog() against the catalog.json beside it) -- reusing
# that existing check rather than re-deriving the schema here a second time.
PYTHONPYCACHEPREFIX="$PYCACHE_SCRATCH" python3 -c '
import sys
sys.path.insert(0, sys.argv[1])
import state
' "$CONTROL_SRC" || die "staged control/catalog.json failed schema validation"

# --- 6. Initialize state: never reset an existing, valid preference file --
# `control/state.py init` is itself idempotent (a no-op if $STATE_DIR/
# control.json already exists and validates) -- run directly from the
# STAGED source (never installed to $APP_DIR by this script; that stays
# deploy.sh's own job moments later, under the same lifecycle lock) -- the
# distinction that matters here is what this bootstrap passes it on a
# genuinely first run:
#   - no $APP_DIR/docker-compose.yml at all yet (a genuinely fresh host,
#     never deployed before): pass null -- the three standard apps default
#     on, MiroFish off (initial_state(None)).
#   - $APP_DIR/docker-compose.yml already exists (an existing stack is being
#     upgraded to these controls): pass the ACTUAL currently running
#     services for this Compose project, adopting any already-running app
#     (including MiroFish) and leaving a currently-stopped one off, rather
#     than silently overriding either with the fresh-host defaults.
running_services_json=null
if [[ -f "$APP_DIR/docker-compose.yml" ]]; then
  running_services_json="$(
    docker ps --filter "label=com.docker.compose.project=$PROJECT" \
      --format '{{.Label "com.docker.compose.service"}}' \
      | python3 -c 'import json,sys; print(json.dumps([l.strip() for l in sys.stdin if l.strip()]))'
  )" || die "failed to query currently running services for adoption"
fi
install -d -m 0700 "$STATE_DIR" || die "cannot create or validate $STATE_DIR"
python3 "$CONTROL_SRC/state.py" init \
  --running-services-json "$running_services_json" \
  --state "$STATE_DIR/control.json" --lock "$STATE_DIR/.control.lock" --owner-uid 0 \
  || die "failed to initialize control state"

echo "install: bootstrap complete (ai-trading-gateway identity, directories, and persisted state are ready)"
