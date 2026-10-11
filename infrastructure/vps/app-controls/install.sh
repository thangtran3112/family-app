#!/usr/bin/env bash
# Portable Linux installer for the Trading Hub app-control helper (01g, Task
# 5). Runs on the target host itself (root), from a staged, versioned source
# tree -- never hand-edited on the VPS. Idempotent: a re-run never resets an
# existing preference file, never widens an already-correct identity/
# directory, and only (re)installs/(re)starts the helper after every check
# below passes.
#
# Usage: install.sh --src-dir DIR [--app-dir DIR] [--state-dir DIR]
#                    [--run-dir DIR] [--unit-dir DIR] [--project NAME]
#
# --src-dir DIR (required): a staged source tree holding exactly
#   DIR/ai-trading/control/{catalog.json,state.py,runtime.py,server.py},
#   DIR/ai-trading/deploy/production/{mirofish-runtime.sh,prepare-mirofish.sh},
#   and DIR/infrastructure/vps/app-controls/ai-trading-control.service --
#   the same relative layout as this repository (ai-trading/AGENTS.md "no
#   hand-edited console settings"; the workflow stages this tree over SSH,
#   never scp's individual files to ad hoc paths).
# --app-dir/--state-dir/--run-dir/--unit-dir: override the fixed production
#   locations below -- test-only (a real install never needs this; the
#   defaults are the whole point of "fixed UID/GID, fixed paths").
# --project NAME: Compose project name used only to detect an existing
#   stack's actually-running services for first-activation adoption
#   (default "ai-trading", matching deploy.sh's own default).
#
# Exit nonzero on ANY unmet precondition -- occupied UID/GID, rootless/
# userns Docker, a symlinked state/run/socket directory, or an incomplete
# source tree -- before installing or (re)starting anything.
set -Eeuo pipefail

GATEWAY_UID=22001
GATEWAY_GID=22001
GATEWAY_USER=ai-trading-gateway
UNIT_NAME=ai-trading-control.service

APP_DIR="${APP_DIR:-/opt/family-app/ai-trading}"
STATE_DIR="${AI_TRADING_STATE_DIR:-/var/lib/family-app/ai-trading}"
RUN_DIR="${AI_TRADING_RUN_DIR:-/run/family-app}"
UNIT_DIR="${SYSTEMD_UNIT_DIR:-/etc/systemd/system}"
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
    --unit-dir) UNIT_DIR="$2"; shift 2 ;;
    --project) PROJECT="$2"; shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[[ -n "$SRC_DIR" ]] || die "--src-dir is required"
[[ -d "$SRC_DIR" ]] || die "--src-dir $SRC_DIR does not exist"

CONTROL_SRC="$SRC_DIR/ai-trading/control"
PREPARE_SRC="$SRC_DIR/ai-trading/deploy/production"
UNIT_SRC="$SRC_DIR/infrastructure/vps/app-controls/$UNIT_NAME"
SOCKET_DIR="$RUN_DIR/ai-trading-control"

# --- 1. Linux/systemd/Python/rootful-Docker preconditions ------------------
# Every one of these fails closed before touching a single file, user, or
# group -- an installer error must never leave a half-created identity or a
# partially staged helper behind.

[[ "$(uname -s)" == Linux ]] || die "this installer only supports Linux (got $(uname -s)); no rootless/macOS install path exists"
command -v systemctl >/dev/null 2>&1 || die "systemd (systemctl) is required"
command -v systemd-analyze >/dev/null 2>&1 || die "systemd-analyze is required to verify the unit before activation"
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
# RuntimeDirectory=family-app/ai-trading-control (the unit below) creates
# $SOCKET_DIR itself before every start and keeps it stable across restarts
# via RuntimeDirectoryPreserve=yes -- this installer never deletes/recreates
# that directory on its own, only validates it when already present.
validate_dir "$RUN_DIR" 0 0 755
if [[ -e "$SOCKET_DIR" || -L "$SOCKET_DIR" ]]; then
  validate_dir "$SOCKET_DIR" 0 "$GATEWAY_GID" 710
fi

# --- 4. Source artifacts present and complete ------------------------------
REQUIRED_FILES=(
  "$CONTROL_SRC/catalog.json"
  "$CONTROL_SRC/state.py"
  "$CONTROL_SRC/runtime.py"
  "$CONTROL_SRC/server.py"
  "$PREPARE_SRC/mirofish-runtime.sh"
  "$PREPARE_SRC/prepare-mirofish.sh"
  "$UNIT_SRC"
)
for f in "${REQUIRED_FILES[@]}"; do
  [[ -f "$f" && ! -L "$f" ]] || die "missing or non-regular required source file: $f"
done

# --- 5. Validate content before installing or activating anything ---------
# Byte-compile every staged .py (parse/compile only -- py_compile never
# executes module-level code) so a syntax error is caught before install.
# PYTHONPYCACHEPREFIX redirects the .pyc output away from $CONTROL_SRC
# (which may be a read-only staged/checked-out tree) into a disposable
# scratch directory removed immediately after.
PYCACHE_SCRATCH="$(mktemp -d)"
trap 'rm -rf "$PYCACHE_SCRATCH"' EXIT
for py in "$CONTROL_SRC/state.py" "$CONTROL_SRC/runtime.py" "$CONTROL_SRC/server.py"; do
  PYTHONPYCACHEPREFIX="$PYCACHE_SCRATCH" python3 -m py_compile "$py" || die "staged $py has invalid Python syntax"
done
# control/catalog.json's schema is validated by importing the staged
# control/state.py itself (its own module-level _load_catalog() call already
# runs validate_catalog() against the catalog.json beside it) -- reusing
# that existing check rather than re-deriving the schema here a second time.
PYTHONPYCACHEPREFIX="$PYCACHE_SCRATCH" python3 -c '
import sys
sys.path.insert(0, sys.argv[1])
import state
' "$CONTROL_SRC" || die "staged control/catalog.json failed schema validation"
bash -n "$PREPARE_SRC/mirofish-runtime.sh" || die "staged mirofish-runtime.sh has invalid bash syntax"
bash -n "$PREPARE_SRC/prepare-mirofish.sh" || die "staged prepare-mirofish.sh has invalid bash syntax"
systemd-analyze verify "$UNIT_SRC" || die "staged $UNIT_NAME failed systemd-analyze verify"

# --- 6. Atomically install root-owned helper/catalog/preparer/unit --------
install -d -m 0755 "$APP_DIR/control" "$APP_DIR/deploy/production"

install_file() {
  local src="$1" dest="$2" mode="$3" tmp
  tmp="$(mktemp "$(dirname "$dest")/.$(basename "$dest").XXXXXX")" || die "mktemp failed for $dest"
  install -o 0 -g 0 -m "$mode" "$src" "$tmp" || die "failed to stage $dest"
  mv -f "$tmp" "$dest" || die "failed to install $dest"
}
install_file "$CONTROL_SRC/catalog.json" "$APP_DIR/control/catalog.json" 0644
install_file "$CONTROL_SRC/state.py" "$APP_DIR/control/state.py" 0644
install_file "$CONTROL_SRC/runtime.py" "$APP_DIR/control/runtime.py" 0644
install_file "$CONTROL_SRC/server.py" "$APP_DIR/control/server.py" 0644
install_file "$PREPARE_SRC/mirofish-runtime.sh" "$APP_DIR/deploy/production/mirofish-runtime.sh" 0644
install_file "$PREPARE_SRC/prepare-mirofish.sh" "$APP_DIR/deploy/production/prepare-mirofish.sh" 0755
install_file "$UNIT_SRC" "$UNIT_DIR/$UNIT_NAME" 0644

# --- 7. Initialize state: never reset an existing, valid preference file --
# `control/state.py init` is itself idempotent (a no-op if $STATE_DIR/
# control.json already exists and validates) -- the distinction that matters
# here is what this installer passes it on a genuinely first run:
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
      --format '{{index .Labels "com.docker.compose.service"}}' \
      | python3 -c 'import json,sys; print(json.dumps([l.strip() for l in sys.stdin if l.strip()]))'
  )" || die "failed to query currently running services for adoption"
fi
python3 "$APP_DIR/control/state.py" init \
  --running-services-json "$running_services_json" \
  --state "$STATE_DIR/control.json" --lock "$STATE_DIR/.control.lock" --owner-uid 0 \
  || die "failed to initialize control state"

# --- 8. daemon-reload, enable and (re)start only after every check passed --
systemctl daemon-reload || die "systemctl daemon-reload failed"
systemctl enable "$UNIT_NAME" || die "failed to enable $UNIT_NAME"
systemctl restart "$UNIT_NAME" || die "failed to start/restart $UNIT_NAME"

echo "install: $UNIT_NAME installed and active"
