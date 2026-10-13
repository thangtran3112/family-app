#!/usr/bin/env bash
# Deploys one image tag of the ai-trading stack. Runs on the VPS as root.
#   IMAGE_TAG                commit SHA built by .github/workflows/ai-trading-deploy.yml
#                             (required)
#   DOCKER_CONFIG             registry credentials prepared by the workflow (optional)
#   ENV_STAGING_DIR           directory CI staged with exactly one freshly rendered file,
#                             cloudflared.env (required -- every deploy renders the other
#                             four SECRET_FILES entries VPS-side, straight from Firestore
#                             family-config (ai-trading/plans/handoffs/2026-10-05-family-config.md);
#                             there is no mode that skips rendering and reuses whatever
#                             already sits in $SECRETS_DIR). CI never sees
#                             tradingagents/ai-hedge-fund/vibe-trading/gateway values.
#   FAMILY_CONFIG_CREDENTIALS path to the family-config-reader service account key used for
#                             that render (default /etc/family-app/config-reader.json).
#   APP_CONFIG_STAGING_DIR    directory the workflow staged with exactly the four known
#                             declarative config files this script now owns end-to-end
#                             (docker-compose.yml, docker-compose.mirofish.yml, Caddyfile,
#                             health-check.sh) -- required. The workflow no longer
#                             pre-installs any of these as the VPS's active config; this
#                             script validates them (present, not a symlink), backs up
#                             every prior version first (recording which did not exist,
#                             same discipline as the five SECRET_FILES), and only then
#                             atomically installs all four. A failure anywhere after
#                             staging begins restores every one of these four files to its
#                             prior state (or removes it, on a genuinely first deploy)
#                             before any previous-tag rollback redeploy -- so an old
#                             release is never started against a new Compose/Caddy/health
#                             file it doesn't understand.
#   DEPLOY_SH_SKIP_CHOWN      test-only: skip the root:root chown on installed/restored
#                             secret files, so stage_secrets/rollback can be dry-run as a
#                             non-root user. Never set this in production.
#   DEPLOY_SH_FAIL_AFTER      test-only: name of a SECRET_FILES entry (e.g. auth.env);
#                             stage_secrets aborts right after installing that file, to
#                             dry-run rollback without needing a real install failure. Never
#                             set this in production.
#   DEPLOY_SH_CONFIG_FAIL_AFTER test-only: name of a CONFIG_FILES entry (e.g. Caddyfile);
#                             stage_configs aborts right after installing that file, to
#                             dry-run config rollback without needing a real install
#                             failure. Never set this in production.
#   MIROFISH_ACTIVATE        operator opt-in: set to 1 to render the optional
#                             ai-trading/mirofish Firestore profile and enable its Compose
#                             profile for this deploy; `keep` (push deploys) does the same
#                             only if a mirofish container is running right now. Unset/any
#                             other value leaves MiroFish disabled; the other three apps are unaffected
#                             either way. A missing profile, missing required key, or render
#                             failure never fails this deploy -- it only leaves MiroFish
#                             disabled and logs why.
#   AI_TRADING_RUNTIME_ENV_DIR directory MIROFISH_ACTIVATE=1 renders mirofish.env into
#                             (default /run/family-app/ai-trading); an ephemeral runtime
#                             location outside this repository, never $SECRETS_DIR.
#   DEPLOY_SH_MIROFISH_CHMOD_SCRATCH_AFTER_INSTALL test-only: a chmod mode (e.g. 0500)
#                             applied to activate_mirofish's render scratch directory
#                             right after a successful install, to dry-run its post-install
#                             cleanup failing for real. Never set this in production.
#   DEPLOY_SH_COMPOSE_PROJECT test-only: overrides compose()'s hardcoded
#                             `--project-name ai-trading`, so a test can point the real
#                             compose()/ensure_mirofish_stopped() code at a disposable,
#                             uniquely-named scratch Compose project instead of the real
#                             one. mirofish_container_ids()'s own real-Docker evidence
#                             query (its `docker ps --filter label=com.docker.compose.
#                             project=...`) uses this same name, so the override scopes
#                             both. Never set this in production.
#   AI_TRADING_MIN_FREE_GB    free GiB required (after old images are pruned) before this
#                             release is pulled; a whole number 0-999999, default 30. One
#                             release unpacks to ~17 GB and needs ~5 GB more of compressed
#                             layers while pulling.
#   AI_TRADING_DOCKER_DATA_DIR directory whose filesystem that free space is read from
#                             (default /var/lib/docker; on this single-disk VPS Docker's
#                             data and containerd's image store share it).
set -Eeuo pipefail

# Moved above every other definition (originally just above IMAGE_TAG
# validation) so the packaging-fix library-source guard below -- which runs
# before anything else in this script, including that validation -- can use
# it too, with the same fail-closed, no-mutation-yet semantics every other
# die() call site already relies on.
die() {
  echo "deploy: $*" >&2
  exit 1
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

APP_DIR="${APP_DIR:-/opt/family-app/ai-trading}"
SECRETS_DIR="${AI_TRADING_SECRETS_DIR:-/etc/family-app/ai-trading}"
REGISTRY="${AI_TRADING_REGISTRY:-ghcr.io/thangtran3112/family-app}"
ENV_STAGING_DIR="${ENV_STAGING_DIR:-}"
APP_CONFIG_STAGING_DIR="${APP_CONFIG_STAGING_DIR:-}"
RUNTIME_ENV_DIR="${AI_TRADING_RUNTIME_ENV_DIR:-/run/family-app/ai-trading}"
export APP_DIR SECRETS_DIR RUNTIME_ENV_DIR
# Task 5 (app-controls): the shared lifecycle lock/state file a cooperating
# control helper (control/server.py, installed by infrastructure/vps/
# app-controls/install.sh) and every PUT/reconcile operation also use --
# never a deploy-only copy. AI_TRADING_CONTROL_OWNER_UID is test-only (a
# non-root test process cannot create a uid-0-owned lock/state file; never
# set in production, where root deploys and the fixed default applies).
STATE_DIR="${AI_TRADING_STATE_DIR:-/var/lib/family-app/ai-trading}"
LOCK_PATH="$STATE_DIR/.control.lock"
CONTROL_STATE_PATH="$STATE_DIR/control.json"
LOCK_WAIT_SECONDS="${AI_TRADING_LOCK_WAIT_SECONDS:-60}"
CONTROL_OWNER_UID="${AI_TRADING_CONTROL_OWNER_UID:-0}"
CONTROL_SCRATCH_DIR=""
CONTROL_SNAPSHOT_PATH=""
# Task 5 (app-controls, fix round 1): the control helper's own systemd
# unit. deploy.sh -- never install.sh, which only bootstraps the host
# identity/directories/state before deploy.sh ever runs -- owns this
# file's install/backup/restore/activation, under the SAME lifecycle lock
# and the SAME rollback transaction as the six CONFIG_FILES control/*
# entries, so "old deploy rollback must restore the matching helper/
# runtime version ... roll back its activation" (task-5-brief) actually
# holds: stage_unit()'s backup always runs before this run's own
# install.sh bootstrap (which never touches this path) has had any chance
# to overwrite it.
UNIT_NAME=ai-trading-control.service
UNIT_DIR="${AI_TRADING_UNIT_DIR:-/etc/systemd/system}"
UNIT_INSTALLED_PATH="$UNIT_DIR/$UNIT_NAME"
UNIT_STAGED_NAME="ai-trading-control.service"
# Empty, never 0, until stage_unit() actually probes $UNIT_INSTALLED_PATH and
# sets this explicitly -- a trusted KNOWN prior-absence signal, never a
# default/unknown one. A deploy that fails before stage_unit ever runs (e.g.
# a stage_configs failure) leaves this empty; rollback()'s own health-check
# skip below must treat that as "unit state unknown, verify normally," never
# as "no prior unit," since a genuinely untouched, still-active prior helper
# may exist on disk in that case.
UNIT_PRIOR_EXISTED=""
UNIT_WAS_ACTIVE=0
UNIT_WAS_ENABLED=0
UNIT_STAGED=0
UNIT_BACKUP_PATH=""
# Shared MiroFish render/validate/install library (Task 2, app-controls):
# defines install_secret_file, mirofish_env_valid, file_mode_octal,
# cleanup_mirofish_scratch, restore_or_remove_mirofish, activate_mirofish
# and their tracking globals (MIROFISH_REQUIRED_KEYS, MIROFISH_RUNTIME_ENV_FILE,
# MIROFISH_PRIOR_EXISTED, MIROFISH_INSTALLED_THIS_RUN) -- also sourced
# standalone by production/prepare-mirofish.sh so a later operator-triggered
# MiroFish activation (control/runtime.py's Runtime.prepare_mirofish(), used
# when an operator turns MiroFish on without a full redeploy) shares this
# exact checked contract instead of a second copy.
#
# Packaging-fix (deploy-retry-failure-sanitized.log, 2026-10-12): the
# workflow installs deploy.sh FLAT at $APP_DIR/deploy.sh (never nested), so
# $SCRIPT_DIR is $APP_DIR itself -- but mirofish-runtime.sh is one of the
# CONFIG_FILES entries, staged AND installed NESTED at deploy/production/
# (see CONFIG_FILES below), never colocated with deploy.sh on ANY host,
# fresh or already-deployed. `source "$SCRIPT_DIR/mirofish-runtime.sh"`
# therefore always resolved to a path that could not exist in production.
# Prefer THIS run's own trusted staged incoming copy -- about to be
# validated/backed-up/atomically installed by stage_configs() below -- over
# an already-installed $APP_DIR copy, which may be stale and is not
# necessarily what this run's own code expects. Fall back to the
# repo-colocated path only when there is no staging directory at all
# (existing offline/function-level test usage: deploy.sh sourced directly
# from its own checkout, where mirofish-runtime.sh already sits beside it).
MIROFISH_LIB_NAME="deploy/production/mirofish-runtime.sh"
if [[ -n "$APP_CONFIG_STAGING_DIR" ]]; then
  MIROFISH_LIB_SRC="$APP_CONFIG_STAGING_DIR/$MIROFISH_LIB_NAME"
  # Fix round 1 (review): this `source` executes the staged file -- as
  # root, in production -- before validate_staged_config_file() (below)
  # ever runs its own existence/symlink/regular-file checks on this same
  # CONFIG_FILES entry, later, inside stage_configs(). Without an
  # equivalent guard here first, a symlinked staged path would already
  # have run by the time that later rejection fired. die() is defined
  # above and safe to call this early: nothing has mutated anything yet.
  [[ -e "$MIROFISH_LIB_SRC" ]] || die "missing staged $MIROFISH_LIB_SRC; the workflow must stage it first"
  [[ -L "$MIROFISH_LIB_SRC" || ! -f "$MIROFISH_LIB_SRC" ]] \
    && die "staged $MIROFISH_LIB_SRC must be a regular file, not a symlink or other path"
  # shellcheck source=/dev/null
  source "$MIROFISH_LIB_SRC"
else
  # shellcheck source=SCRIPTDIR/mirofish-runtime.sh
  source "$SCRIPT_DIR/mirofish-runtime.sh"
fi
MIN_FREE_GB="${AI_TRADING_MIN_FREE_GB:-30}"
DOCKER_DATA_DIR="${AI_TRADING_DOCKER_DATA_DIR:-/var/lib/docker}"
STATE_FILE="$APP_DIR/last-good-tag"
IMAGES_ENV="$APP_DIR/images.env"
SECRET_FILES=(tradingagents.env ai-hedge-fund.env vibe-trading.env vibe-gateway.env auth.env market-data.env desk.env cloudflared.env)
# Tracks, per secret file, whether it existed before this run's staging so
# rollback can tell "restore the backup" from "delete what we just created".
declare -A PRIOR_EXISTED=()
# The four declarative config files this script now owns end-to-end (A10a),
# plus (Task 5, app-controls) the control helper's own code/catalog and the
# standalone MiroFish preparer library it depends on at its deployed
# location (control/runtime.py's PREPARE_MIROFISH_SCRIPT resolves relative
# to its OWN installed path, two directories up then deploy/production/ --
# see control/runtime.py's module docstring) -- all ten are staged,
# validated, backed up and atomically installed as ONE transaction, and an
# old-tag rollback restores every one of them together, never just the
# original four. The workflow only stages them into APP_CONFIG_STAGING_DIR
# (mirroring $APP_DIR's own nested layout) and no longer installs any of
# them as the VPS's active config itself.
CONFIG_FILES=(
  docker-compose.yml docker-compose.mirofish.yml Caddyfile health-check.sh
  control/catalog.json control/state.py control/runtime.py control/server.py
  deploy/production/mirofish-runtime.sh deploy/production/prepare-mirofish.sh
)
# Same prior/new-state bookkeeping as PRIOR_EXISTED above, but for CONFIG_FILES.
declare -A CONFIG_PRIOR_EXISTED=()
# Armed by stage_configs once backups exist and the first atomic install has
# started, so rollback() knows whether restore_or_remove_configs has
# anything to undo (mirrors MIROFISH_INSTALLED_THIS_RUN's role for mirofish.env).
CONFIG_STAGED=0
# This run's own root-only scratch directory holding a pre-install copy of
# every CONFIG_FILES entry that already existed in $APP_DIR -- a run-owned
# `mktemp -d`, never a persistent/shared backup location. Removed on every
# exit by cleanup_scratch_dirs, the same EXIT trap RENDER_SRC_DIR already uses.
CONFIG_BACKUP_DIR=""
# Root-only scratch directory this run's render_profiles() writes
# tradingagents.env/ai-hedge-fund.env/vibe-trading.env/auth.env into, straight from
# Firestore. Empty until render_profiles runs; cleanup_scratch_dirs removes it on every exit.
RENDER_SRC_DIR=""
# A full commit SHA: the only shape a deployed image tag (and last-good-tag) ever has.
SHA_RE='^[0-9a-fA-F]{40}([0-9a-fA-F]{24})?$'

[[ "${IMAGE_TAG:-}" =~ $SHA_RE ]] || die "IMAGE_TAG must be a full commit SHA"

# validate_staged_file FILE: blank lines, # comments, or KEY=value with a
# non-empty value; never a NUL or CR byte anywhere in the file.
validate_staged_file() {
  local file="$1" line
  [[ -f "$file" ]] || die "missing staged $file"
  if ! cmp -s <(LC_ALL=C tr -d '\000' <"$file") "$file"; then
    die "$file contains a NUL byte"
  fi
  if LC_ALL=C grep -q $'\r' "$file"; then
    die "$file contains a CR byte"
  fi
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == '#'* ]] && continue
    [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*=.+$ ]] || die "$file: invalid line: $line"
  done <"$file"
}

compose() {
  local mirofish_compose=() env_file_args=()
  [[ -f "$APP_DIR/docker-compose.mirofish.yml" ]] && mirofish_compose=(-f "$APP_DIR/docker-compose.mirofish.yml")
  # On a genuinely first-ever deploy, $IMAGES_ENV (deploy_tag's own output)
  # doesn't exist yet -- `docker compose --env-file <missing>` hard-fails
  # immediately ("couldn't find env file"), before even parsing the compose
  # file. ensure_mirofish_stopped() below needs a working `compose` call
  # *before* deploy_tag ever runs, so fall back to passing the same three
  # variables images.env would hold directly as environment -- ps/rm only
  # match existing containers by project+service label, never by resolving
  # the image reference, so any valid-looking tag works equally well here
  # (verified empirically; see task-9-report.md).
  if [[ -f "$IMAGES_ENV" ]]; then
    env_file_args=(--env-file "$IMAGES_ENV")
  fi
  # The gateway bind-mounts this single file; the workflow's `install` swaps in
  # a new inode, which a running container never sees. Its sha256 is a gateway
  # label, so Compose recreates the gateway exactly when the Caddyfile changes.
  local caddyfile_sha=unset
  [[ -f "$APP_DIR/Caddyfile" ]] && caddyfile_sha="$(sha256sum "$APP_DIR/Caddyfile")" && caddyfile_sha="${caddyfile_sha%% *}"
  AI_TRADING_CADDYFILE_SHA256="$caddyfile_sha" \
  AI_TRADING_REGISTRY="$REGISTRY" \
  AI_TRADING_IMAGE_TAG="$IMAGE_TAG" \
  AI_TRADING_SECRETS_DIR="$SECRETS_DIR" \
    docker compose --project-name "${DEPLOY_SH_COMPOSE_PROJECT:-ai-trading}" "${env_file_args[@]}" -f "$APP_DIR/docker-compose.yml" "${mirofish_compose[@]}" "$@"
}

# cleanup_scratch_dirs: removes this run's root-only scratch directories on
# every exit -- success, a render/validation failure, or a later mid-stage
# install failure -- so no partial or final secret/config value ever lingers
# anywhere outside $SECRETS_DIR/$APP_DIR itself. Covers both RENDER_SRC_DIR
# (render_profiles' Firestore-render scratch) and CONFIG_BACKUP_DIR
# (stage_configs' run-owned config backup scratch); either may still be empty
# ("") depending on how far this run got, which the guards below handle.
# Armed by render_profiles -- the first of the two to ever exist -- once
# RENDER_SRC_DIR is created; a bash EXIT trap always fires exactly once, no
# matter how the script terminates, so this never depends on which later step
# fails or whether stage_configs ever ran at all.
cleanup_scratch_dirs() {
  [[ -n "$RENDER_SRC_DIR" ]] && rm -rf "$RENDER_SRC_DIR"
  [[ -n "$CONFIG_BACKUP_DIR" ]] && rm -rf "$CONFIG_BACKUP_DIR"
  # Task 5 (app-controls): this run's own root-only coordinator/state-CLI
  # copy (see acquire_lifecycle_lock/prepare_control_scratch below) --
  # removed on every exit, same as the other two scratch directories above.
  [[ -n "$CONTROL_SCRATCH_DIR" ]] && rm -rf "$CONTROL_SCRATCH_DIR"
  # This run's own backup of the prior systemd unit content (stage_unit
  # below), a single file under $STATE_DIR rather than a whole scratch
  # directory -- removed on every exit, once restore_or_remove_unit (if it
  # ran at all) no longer needs it.
  [[ -n "$UNIT_BACKUP_PATH" ]] && rm -f "$UNIT_BACKUP_PATH"
  # Release the lifecycle lock (FD 9) LAST, after every other scratch
  # cleanup above -- held from before any preference/config mutation
  # (acquire_lifecycle_lock) through commit or rollback, on every exit path.
  # Closing an fd that was never opened (a precondition failure before
  # acquire_lifecycle_lock ever ran) is a silent no-op in bash.
  exec 9>&- 2>/dev/null || true
}

# --- Task 5 (app-controls): lifecycle lock, persisted-preference
# snapshot/restore, and explicit service selection. Every helper of
# control/state.py's own CLI below shares the SAME lifecycle lock
# (FD 9)/state file the control helper (control/server.py) and install.sh
# use -- never a deploy-only duplicate. install.sh has already initialized
# $CONTROL_STATE_PATH (adopting any already-running app, including MiroFish,
# on a genuinely first install) by the time deploy.sh ever runs: deploy.sh
# itself never (re-)initializes or adopts -- a missing/corrupt state file
# fails this deploy closed, before any secret/config mutation, rather than
# silently re-deriving fresh defaults over an operator's real choices.

# flock_fd FD TIMEOUT_SECONDS: acquires a blocking (bounded-wait) exclusive
# flock on an already-open FD -- the same BSD flock(2) semantics
# state.py's own validate_inherited_lock already relies on, via a short
# Python retry loop instead of shelling out to util-linux's `flock` binary
# (not present on macOS, where this suite is also run directly -- see
# AGENTS.md's own "Linux-only control tests" container guidance; `flock` as
# a *command* is Linux-only, the underlying system call this reimplements
# is standard, portable POSIX flock(2)). The lock is associated with the
# OPEN FILE DESCRIPTION behind FD, not this short-lived python3 process, so
# it remains held by the calling shell's own FD after python3 exits --
# exactly like util-linux's own `flock -w N FD` (no command) form.
flock_fd() {
  local fd="$1" timeout="$2"
  python3 -c '
import fcntl
import sys
import time

fd = int(sys.argv[1])
deadline = time.monotonic() + float(sys.argv[2])
while True:
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        sys.exit(0)
    except BlockingIOError:
        if time.monotonic() >= deadline:
            sys.exit(1)
        time.sleep(0.1)
' "$fd" "$timeout"
}

# acquire_lifecycle_lock: opens/creates $LOCK_PATH at FD 9 and holds an
# exclusive flock with a bounded wait (never indefinite -- a stuck PUT/
# reconcile must not hang a deploy forever). Held from here through every
# later preference/config mutation, health-check, and commit-or-rollback;
# released only by cleanup_scratch_dirs' own EXIT trap, which this arms.
acquire_lifecycle_lock() {
  install -d -m 0700 "$STATE_DIR" || die "cannot create or validate the lifecycle state directory $STATE_DIR"
  local old_umask
  old_umask="$(umask)"
  umask 077
  exec 9>"$LOCK_PATH" || { umask "$old_umask"; die "cannot open lifecycle lock $LOCK_PATH"; }
  umask "$old_umask"
  flock_fd 9 "$LOCK_WAIT_SECONDS" || die "could not acquire the lifecycle lock within ${LOCK_WAIT_SECONDS}s; another operation is in progress"
  # Single combined EXIT trap for every scratch directory AND the lock
  # itself -- `trap ... EXIT` replaces, it does not chain, so this must be
  # the one place anything arms it; render_profiles' own later, identical
  # `trap cleanup_scratch_dirs EXIT` is then just a harmless idempotent re-arm.
  trap cleanup_scratch_dirs EXIT
}

# prepare_control_scratch: copies this run's OWN staged control/state.py,
# control/catalog.json and health-check.sh into a fresh root-only scratch
# directory -- read from $APP_CONFIG_STAGING_DIR (what THIS deploy brings),
# never from $APP_DIR/control (whatever is currently installed, which
# restore_or_remove_configs may remove or revert to an older version partway
# through this same run). Every later control/state.py invocation and the
# health-check call inside deploy_tag() below use ONLY this scratch copy,
# so a rollback to a pre-controls artifact set (first activation: the
# control/* CONFIG_FILES entries had no prior version, so restore deletes
# them) never deletes the very driver still needed to restore preferences or
# select services for the previous tag's own redeploy.
prepare_control_scratch() {
  CONTROL_SCRATCH_DIR="$(mktemp -d "$APP_DIR/.control-scratch-XXXXXX")"
  install -d -m 0755 "$CONTROL_SCRATCH_DIR/control"
  cp -p "$APP_CONFIG_STAGING_DIR/control/state.py" "$CONTROL_SCRATCH_DIR/control/state.py"
  cp -p "$APP_CONFIG_STAGING_DIR/control/catalog.json" "$CONTROL_SCRATCH_DIR/control/catalog.json"
  cp -p "$APP_CONFIG_STAGING_DIR/health-check.sh" "$CONTROL_SCRATCH_DIR/health-check.sh"
  chmod 0755 "$CONTROL_SCRATCH_DIR/health-check.sh"
}

# control_state_py ARGS...: this run's own scratch copy, never $APP_DIR's.
control_state_py() {
  python3 "$CONTROL_SCRATCH_DIR/control/state.py" "$@" --owner-uid "$CONTROL_OWNER_UID"
}

# snapshot_preferences: saves the CURRENT persisted choices (desired flags,
# revision, results) to a fresh root-only scratch file before anything in
# this deploy mutates secrets, config, or Compose state -- restored on
# rollback by restore_preferences_on_rollback below. A missing or corrupt
# $CONTROL_STATE_PATH fails this (and therefore the whole deploy) closed,
# before any further mutation -- install.sh's own job is to have already
# created/adopted it; deploy.sh never silently re-initializes it here.
snapshot_preferences() {
  CONTROL_SNAPSHOT_PATH="$(mktemp "$STATE_DIR/.snapshot-XXXXXX")"
  control_state_py snapshot --state "$CONTROL_STATE_PATH" --lock "$LOCK_PATH" \
    --lock-fd 9 --output "$CONTROL_SNAPSHOT_PATH" \
    || die "failed to snapshot the current app-control preferences"
}

# restore_preferences_on_rollback: used by rollback() to undo whatever this
# run's own map_mirofish_dispatch_to_state (and any reconcile racing it)
# changed -- restore_preferences always assigns a NEW, strictly greater
# revision (state.py's own contract), so a rolled-back deploy never leaves a
# stale/ambiguous revision behind. A no-op if snapshot_preferences never ran
# (nothing to restore to yet).
restore_preferences_on_rollback() {
  [[ -n "$CONTROL_SNAPSHOT_PATH" && -f "$CONTROL_SNAPSHOT_PATH" ]] || return 0
  control_state_py restore --state "$CONTROL_STATE_PATH" --lock "$LOCK_PATH" \
    --lock-fd 9 --snapshot "$CONTROL_SNAPSHOT_PATH" \
    || echo "deploy: control: failed to restore prior app-control preferences; the persisted choices may not match the redeployed release" >&2
}

# read_desired_mirofish: the single current `desired.mirofish` boolean,
# straight from the persisted state -- never re-derived from a "container
# currently running" heuristic (task-5-brief: "not current-running
# heuristic after adoption"). Drives whether activate_mirofish (below) is
# asked to render MiroFish's credentials for this deploy at all.
read_desired_mirofish() {
  python3 -c '
import sys
sys.path.insert(0, sys.argv[1])
from state import read_state
state = read_state(sys.argv[2], owner_uid=int(sys.argv[3]))
print("true" if state["desired"]["mirofish"] else "false")
' "$CONTROL_SCRATCH_DIR/control" "$CONTROL_STATE_PATH" "$CONTROL_OWNER_UID"
}

# map_mirofish_dispatch_to_state: folds the existing MIROFISH_ACTIVATE
# operator input (1/0/keep/unset) into the SAME persisted desired state,
# under the lock, before this deploy ever reads it back -- "1"/"0" apply
# immediately; "keep" (and any other/unset value -- every plain push
# deploy) is state.py's own existing no-op, preserving whatever preference
# is already persisted (including one adopted at install time), rather than
# deriving it fresh from which container happens to be running right now.
map_mirofish_dispatch_to_state() {
  local mode
  case "${MIROFISH_ACTIVATE:-}" in
    1) mode=1 ;;
    0) mode=0 ;;
    *) mode=keep ;;
  esac
  control_state_py set-mirofish --state "$CONTROL_STATE_PATH" --lock "$LOCK_PATH" \
    --lock-fd 9 --mode "$mode" \
    || die "failed to update the persisted MiroFish preference"
}

# mirofish_ready_flag: the same COMPOSE_PROFILES=mirofish signal
# health-check.sh's own mirofish_enabled() already uses -- set only by a
# CONFIRMED, installed activate_mirofish() success for this run.
mirofish_ready_flag() {
  [[ "${COMPOSE_PROFILES:-}" == mirofish ]] && printf 'true\n' || printf 'false\n'
}

# all_catalog_services: every service name mapped to ANY app group in this
# run's own scratch catalog.json -- read as plain data (never re-deriving
# or duplicating state.py's own validation/selection logic), used only to
# compute which groups are NOT selected (stop_disabled_groups below).
all_catalog_services() {
  python3 -c '
import json
import sys
with open(sys.argv[1]) as handle:
    data = json.load(handle)
print("\n".join(service for services in data["apps"].values() for service in services))
' "$CONTROL_SCRATCH_DIR/control/catalog.json"
}

# apply_selected_services: explicit, catalog-driven service selection --
# task-5-brief's own snippet, verbatim in spirit: never a blanket
# `compose up` that could silently revive an intentionally disabled group.
# The command substitution is checked directly (never `mapfile <
# <(command)`, which would hide a failing Python exit status).
apply_selected_services() {
  local mirofish_ready selected_text
  mirofish_ready="$(mirofish_ready_flag)"
  selected_text="$(control_state_py services --state "$CONTROL_STATE_PATH" --lock "$LOCK_PATH" --mirofish-ready "$mirofish_ready")" \
    || die "control: failed to compute the selected service list"
  [[ -n "$selected_text" ]] || die "control: selected service list is empty"
  local selected=()
  mapfile -t selected <<<"$selected_text"
  compose up -d --no-deps --wait --wait-timeout 300 "${selected[@]}"
}

# stop_disabled_groups: every catalog service NOT in the currently selected
# list is stopped explicitly, with the existing fixed 60s graceful timeout
# -- never removed, never its volumes/images touched, and never left for a
# dependency-driven `up` to silently revive. A no-op when nothing is disabled.
stop_disabled_groups() {
  local mirofish_ready selected_text all_text disabled=()
  mirofish_ready="$(mirofish_ready_flag)"
  selected_text="$(control_state_py services --state "$CONTROL_STATE_PATH" --lock "$LOCK_PATH" --mirofish-ready "$mirofish_ready")" \
    || die "control: failed to compute the selected service list"
  all_text="$(all_catalog_services)" || die "control: failed to read the service catalog"
  local selected_set=$'\n'"$selected_text"$'\n'
  local svc
  while IFS= read -r svc; do
    [[ -n "$svc" ]] || continue
    [[ "$selected_set" == *$'\n'"$svc"$'\n'* ]] || disabled+=("$svc")
  done <<<"$all_text"
  ((${#disabled[@]})) || return 0
  compose stop --timeout 60 "${disabled[@]}"
}

# render_profiles: VPS-side render of the four ai-trading Firestore profiles
# (tradingagents, ai-hedge-fund, vibe-trading, gateway) into a fresh root-only
# scratch directory on every deploy
# (ai-trading/plans/handoffs/2026-10-05-family-config.md). CI no longer stages
# these -- only cloudflared.env still arrives via ENV_STAGING_DIR; everything
# else is read from Firestore here, by the VPS itself, with the shared,
# database-wide family-config-reader key -- a completely different mechanism
# from the CI-staged file. The profile is named "gateway" in Firestore for
# interface continuity, but the file family_config.py writes (always named
# after the profile) is renamed here to auth.env to match the compose service
# that actually reads it -- "gateway" itself is Caddy and needs no secrets at
# all. family_config.py resolves every target before writing any file, so a
# missing profile fails this call before a single byte is written -- the
# install loop below never starts.
render_profiles() {
  local family_config="$APP_DIR/family_config.py"
  [[ -x "$family_config" ]] || die "missing $family_config; copy it alongside deploy.sh first"
  install -d -m 0700 "$SECRETS_DIR"
  RENDER_SRC_DIR="$(mktemp -d "$SECRETS_DIR/.render-XXXXXX")"
  trap cleanup_scratch_dirs EXIT
  FAMILY_CONFIG_CREDENTIALS="${FAMILY_CONFIG_CREDENTIALS:-/etc/family-app/config-reader.json}" \
    "$family_config" render ai-trading/tradingagents ai-trading/ai-hedge-fund ai-trading/vibe-trading ai-trading/gateway ai-trading/market-data ai-trading/desk \
      --out-dir "$RENDER_SRC_DIR"
  mv -f "$RENDER_SRC_DIR/gateway.env" "$RENDER_SRC_DIR/auth.env"
  # Caddy injects Vibe's API key after the Clerk check, so browsers never hold
  # it; the gateway gets only this one value, never Vibe's provider keys.
  local vibe_key
  vibe_key="$(sed -n 's/^API_AUTH_KEY=//p' "$RENDER_SRC_DIR/vibe-trading.env")"
  [[ -n "$vibe_key" ]] || die "ai-trading/vibe-trading has no API_AUTH_KEY; the gateway could not authenticate to Vibe-Trading"
  (umask 077 && printf 'VIBE_API_AUTH_KEY=%s\n' "$vibe_key" >"$RENDER_SRC_DIR/vibe-gateway.env")
}

# secret_source_dir NAME: the directory holding one SECRET_FILES entry before
# stage_secrets validates/installs it. cloudflared.env is the only entry CI
# still stages into ENV_STAGING_DIR; the other four come from this run's own
# render_profiles output in RENDER_SRC_DIR.
secret_source_dir() {
  if [[ "$1" == cloudflared.env ]]; then
    printf '%s\n' "$ENV_STAGING_DIR"
  else
    printf '%s\n' "$RENDER_SRC_DIR"
  fi
}

# mirofish_container_ids: real Docker evidence of every container this
# run's compose project owns as its "mirofish" service -- found directly
# via `docker ps`'s own compose labels, so this never depends on
# $APP_DIR/docker-compose.yml existing at all (whole-branch review reopen,
# round 2: that file is not installed yet on a genuine first bootstrap,
# before stage_configs() has ever run) and never lets Compose fall back to
# discovering an unrelated project from $PWD -- there is no `-f` here to
# omit. `-a` includes a stopped/exited container, not just a running one,
# so a left-behind exited container still counts as "owned." A real
# `docker ps` failure (e.g. the daemon is unreachable) is never swallowed
# as "no containers": its non-zero exit status is passed straight through
# to the caller instead of being read as proof nothing is running.
mirofish_container_ids() {
  docker ps -aq \
    --filter "label=com.docker.compose.project=${DEPLOY_SH_COMPOSE_PROJECT:-ai-trading}" \
    --filter "label=com.docker.compose.service=mirofish"
}

# stop_remove_mirofish_container: best-effort stop+remove of any mirofish
# container this project owns (review P2, round 3; whole-branch review
# reopen round 2 added the real-evidence check above). Three outcomes:
#   - no owned container exists (per mirofish_container_ids' real evidence,
#     not a guess from file existence): nothing to do, success -- this is
#     the genuine first-bootstrap case, with or without an active
#     $APP_DIR/docker-compose.yml.
#   - an owned container exists AND $APP_DIR/docker-compose.yml is active:
#     delegate to `compose rm -s -f mirofish` exactly as before -- it stops
#     the container first (if still running) then force-removes it, no
#     confirmation prompt.
#   - an owned container exists but $APP_DIR/docker-compose.yml is
#     missing: an inconsistent state this script cannot safely resolve
#     through Compose (it has nothing to pass as `-f`) -- fail loudly with
#     a clear diagnosis instead of a generic Compose "no such file" error,
#     and never silently assume there is nothing to stop.
# A failed mirofish_container_ids query itself (e.g. daemon unreachable) is
# reported and fails this function too, same "never swallow a real Docker
# error as success" discipline. The config-present branch stays best-effort
# from the caller's point of view: never lets a `compose rm` failure change
# this function's own reported outcome beyond returning 1, only logs that
# manual intervention may be needed (service name only, nothing else to
# log).
stop_remove_mirofish_container() {
  local ids
  if ! ids="$(mirofish_container_ids)"; then
    echo "deploy: mirofish: failed to query Docker for an existing mirofish container; it may still be running -- check manually" >&2
    return 1
  fi
  [[ -n "$ids" ]] || return 0
  if [[ ! -f "$APP_DIR/docker-compose.yml" ]]; then
    echo "deploy: mirofish: found an existing mirofish container for this project but no active $APP_DIR/docker-compose.yml to manage it with -- refusing to guess; check manually" >&2
    return 1
  fi
  if ! compose rm -s -f mirofish >/dev/null 2>&1; then
    echo "deploy: mirofish: best-effort stop/remove of the mirofish container failed; it may still be running -- check manually" >&2
    return 1
  fi
}

# ensure_mirofish_stopped: whole-branch review reopen. Whenever this deploy
# does NOT end with MiroFish active -- COMPOSE_PROFILES isn't "mirofish",
# whether because MIROFISH_ACTIVATE was never set (the normal disabled
# path) or because activate_mirofish just failed -- a container left
# running from an *earlier* successful activation is not stopped by this
# alone. Reproduced empirically against real Docker Compose (not assumed;
# see task-9-report.md): `docker compose up -d --remove-orphans` with the
# same sibling compose file loaded but the profile inactive does NOT stop
# or remove an already-running profile-gated container -- it is not
# "orphaned" (still defined in the merged project, just out of scope for
# this invocation), so it keeps running, un-monitored, with no
# corresponding mirofish.env. "MiroFish disabled" in the log would
# otherwise be false.
#
# This explicitly stops+removes any such container (reusing
# stop_remove_mirofish_container, the same best-effort primitive rollback
# already uses) and then independently VERIFIES its absence via
# mirofish_container_ids' real Docker evidence -- never trusting a zero
# exit status alone, and never via `compose ps -q mirofish`, which (like
# every other compose() call) requires `-f $APP_DIR/docker-compose.yml` to
# resolve a project at all.
#
# Round 2 (whole-branch review reopen): that unconditional `-f` was itself
# the bug -- `compose()`'s base file is installed by stage_configs(), which
# this function runs strictly *before*, on every deploy. On a genuinely
# empty $APP_DIR (a fresh VPS, or any host rebuild) real `docker compose`
# failed on the missing `-f` file before stop_remove_mirofish_container
# could even try, aborting the whole deploy with a generic "no such file"
# error instead of the clear diagnosis below. Both
# stop_remove_mirofish_container and this function's own verification now
# go through mirofish_container_ids() instead -- real `docker ps` evidence,
# scoped by compose project/service label, which needs no `-f` and so works
# identically whether or not $APP_DIR/docker-compose.yml currently exists.
# Either check failing is NOT best-effort here: it FAILS THIS DEPLOY
# outright (die(), before stage_secrets or deploy_tag ever runs), so the
# previously-deployed tag -- the other three apps, gateway, auth,
# cloudflared -- is left completely untouched rather than risk a
# newly-deployed "disabled" stack silently running next to an unverified,
# un-monitored MiroFish instance. A no-op when this run's own activation
# succeeded (COMPOSE_PROFILES is already "mirofish" -- deploy_tag's own
# `compose up` manages it normally).
ensure_mirofish_stopped() {
  [[ "${COMPOSE_PROFILES:-}" == mirofish ]] && return 0
  stop_remove_mirofish_container || die "mirofish: failed to stop/remove an existing mirofish container; aborting this deploy -- the previously-deployed tag stays running"
  # whole-branch review reopen, round 2: verify via mirofish_container_ids'
  # real Docker evidence, not `compose ps -q mirofish` -- that call requires
  # `-f $APP_DIR/docker-compose.yml` to resolve a project at all, a file
  # that does not exist yet on a genuine first bootstrap (this verification
  # must hold on that path too, where stop_remove_mirofish_container above
  # already found nothing to stop and never called compose() at all).
  local remaining
  remaining="$(mirofish_container_ids)" || die "mirofish: failed to verify no mirofish container remains; aborting this deploy -- the previously-deployed tag stays running"
  [[ -z "$remaining" ]] || die "mirofish: a mirofish container is still present after stop/remove; aborting this deploy -- the previously-deployed tag stays running"
}

# prune_old_images: image retention. Every release unpacks to ~17 GB (MiroFish's
# backend alone is ~12 GB and shares no layers between tags), so unpruned tags
# filled the VPS disk on 2026-10-10: the pull died with ENOSPC and the rollback
# could not even restore the env files. Keeps only this release, the rollback
# target (last-good-tag), and whatever a container still uses -- `docker rmi`
# without -f refuses an image any container, running or stopped, still
# references, which is the safety net. Only commit-SHA-tagged images in this
# registry's ai-trading-* repos are ever considered; other apps' images,
# third-party images, and non-SHA tags are never touched. If last-good-tag
# exists but is not exactly one commit SHA, the rollback target is unknown, so
# nothing is pruned. Best-effort: a failure here surfaces through
# require_free_space, not by aborting on one stale tag.
prune_old_images() {
  local last_good="" ref tag
  if [[ -f "$STATE_FILE" ]]; then
    last_good="$(cat "$STATE_FILE")"
    if [[ ! "$last_good" =~ $SHA_RE ]]; then
      echo "deploy: $STATE_FILE is not a single commit SHA; skipping image pruning so the rollback target is never removed" >&2
      return 0
    fi
  fi
  while IFS= read -r ref; do
    case "$ref" in
      "$REGISTRY"/ai-trading-*:*) ;;
      *) continue ;;
    esac
    tag="${ref##*:}"
    [[ "$tag" =~ $SHA_RE ]] || continue
    [[ "$tag" == "$IMAGE_TAG" || "$tag" == "$last_good" ]] && continue
    docker rmi "$ref" >/dev/null 2>&1 || true
  done < <(docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null || true)
}

# require_free_space: stop before any secret, container, or tag changes unless
# this release's pull is likely to fit. Fails closed: a malformed threshold or
# free space that cannot be read is an error, never a pass (bash arithmetic
# would read an empty, negative, or overflowed threshold as "enough"). 10# keeps
# a leading zero decimal instead of octal.
require_free_space() {
  local free_kb
  [[ "$MIN_FREE_GB" =~ ^[0-9]{1,6}$ ]] || die "AI_TRADING_MIN_FREE_GB must be a whole number of GiB (0-999999), got: $MIN_FREE_GB"
  free_kb="$(df -Pk "$DOCKER_DATA_DIR" 2>/dev/null | awk 'NR==2 {print $4}' || true)"
  [[ "$free_kb" =~ ^[0-9]+$ ]] || die "cannot read free disk space for $DOCKER_DATA_DIR"
  ((free_kb >= 10#$MIN_FREE_GB * 1024 * 1024)) || die "only $((free_kb / 1024 / 1024)) GiB free on $DOCKER_DATA_DIR after pruning old ai-trading images; need $MIN_FREE_GB GiB to pull this release -- free space and re-run (the running release is untouched)"
}

deploy_tag() {
  local tag="$1" tmp
  # Self-sufficient regardless of caller context: the normal main flow
  # always calls prepare_control_scratch before deploy_tag ever runs, but
  # rollback()'s own `deploy_tag "$previous"` redeploy is also directly
  # reachable from a function-level test harness that only ever called
  # stage_secrets/stage_configs (and never acquire_lifecycle_lock/
  # prepare_control_scratch) -- lazily prepare it here too, exactly once.
  [[ -n "$CONTROL_SCRATCH_DIR" ]] || prepare_control_scratch
  # A10a fix: compose() exports AI_TRADING_IMAGE_TAG="$IMAGE_TAG" (the global)
  # as an inline env var on every `docker compose` invocation, which always
  # takes precedence over the same name in --env-file $IMAGES_ENV below --
  # even though $IMAGES_ENV is written with the correct "$tag" a few lines
  # down. Without this reassignment, rollback()'s own `deploy_tag "$previous"`
  # would still pull/run the just-failed NEW tag's images (the global
  # $IMAGE_TAG never changed), not the previous good one. Reassigning the
  # global here, before any compose() call in this function, makes every
  # deploy_tag call -- the normal one and a rollback's -- actually deploy the
  # tag it was asked to deploy.
  IMAGE_TAG="$tag"
  tmp="$(mktemp "$APP_DIR/images.env.XXXXXX")"
  printf 'AI_TRADING_REGISTRY=%s\nAI_TRADING_IMAGE_TAG=%s\nAI_TRADING_SECRETS_DIR=%s\n' "$REGISTRY" "$tag" "$SECRETS_DIR" >"$tmp"
  chmod 0644 "$tmp"
  mv -f "$tmp" "$IMAGES_ENV"
  compose pull
  # Task 5 (app-controls): explicit, catalog-driven selection -- never a
  # blanket `up` (which would silently revive an intentionally disabled
  # group) and never `--remove-orphans` (this phase defines no removed
  # service; a stopped/profiled app container must remain exactly as the
  # operator left it). Disabled groups are stopped explicitly afterward,
  # with their own fixed graceful timeout, never left for `up` to revive.
  apply_selected_services
  stop_disabled_groups
  # The scratch copy of health-check.sh (this run's own, from
  # $APP_CONFIG_STAGING_DIR) -- never "$APP_DIR/health-check.sh" directly,
  # which a same-run rollback may already have restored to an OLDER,
  # pre-controls version that assumes every standard service is on. This
  # call (including a rollback's own `deploy_tag "$previous"`) always
  # verifies the SAME effective selection this run just applied.
  #
  # task-5-review fix round 1, Important #2: the scratch health-check.sh
  # must also be told to READ from this run's own scratch control/ module
  # and the real persisted state path -- without these two explicit
  # overrides it silently falls back to its own defaults
  # ($APP_DIR/control, the hardcoded production state path), which is not
  # necessarily this run's scratch copy or $CONTROL_STATE_PATH (e.g. when
  # $STATE_DIR is ever customized, or during a same-run rollback where
  # $APP_DIR/control may already be reverted/removed).
  AI_TRADING_CONTROL_DIR="$CONTROL_SCRATCH_DIR/control" \
  AI_TRADING_STATE_PATH="$CONTROL_STATE_PATH" \
    "$CONTROL_SCRATCH_DIR/health-check.sh"
}

# restore_or_remove_secrets: used by rollback to undo a partially- or fully-
# applied stage_secrets. A file that existed before this run is restored from
# its backup; a file that did not (first deploy) is deleted, never left
# behind as a leftover new secret.
restore_or_remove_secrets() {
  local name
  for name in "${SECRET_FILES[@]}"; do
    if [[ "${PRIOR_EXISTED[$name]:-0}" == 1 ]]; then
      [[ -f "$SECRETS_DIR/.previous/$name" ]] && install_secret_file "$SECRETS_DIR/.previous/$name" "$SECRETS_DIR/$name"
    else
      rm -f "$SECRETS_DIR/$name"
    fi
  done
}

# config_mode NAME: the mode CONFIG_FILES entry NAME is always installed and
# restored with -- 0755 for the two executable scripts (health-check.sh and
# the standalone prepare-mirofish.sh, invoked directly as its own
# subprocess by control/runtime.py's Runtime.prepare_mirofish()), 0644 for
# every declarative/library/code file, exactly task-6-brief's atomic-install
# core, extended (Task 5) to the control/* and deploy/production/* entries.
config_mode() {
  case "$1" in
    health-check.sh | deploy/production/prepare-mirofish.sh) printf '0755\n' ;;
    *) printf '0644\n' ;;
  esac
}

# install_config_file NAME SRC: installs SRC as $APP_DIR/NAME atomically (a
# same-directory temp file with NAME's correct mode, then `mv -f` over the
# destination -- a reader never sees a partially-written file, same
# atomicity install_secret_file already gives the five SECRET_FILES). NAME
# may be nested (e.g. "control/state.py"); the destination directory is
# created first (0755, same as $APP_DIR itself) so the atomic temp file
# lands in the SAME directory as its final destination. Returns 1 on any
# failure (mkdir/mktemp/install/mv) instead of letting a partial temp file
# or a failed rename go unnoticed.
install_config_file() {
  local name="$1" src="$2" mode tmp destdir reldir
  mode="$(config_mode "$name")"
  reldir="$(dirname "$name")"
  if [[ "$reldir" == "." ]]; then
    # A flat (non-nested) name: $APP_DIR itself is the destination
    # directory, assumed to already exist -- never `install -d` it here (a
    # read-only $APP_DIR must stay read-only for this call to correctly
    # fail; `install -d` on an EXISTING directory still chmod's it, which
    # would silently repair an injected read-only test precondition, or
    # widen a production directory's mode, before the real write is even
    # attempted).
    destdir="$APP_DIR"
  else
    destdir="$APP_DIR/$reldir"
    install -d -m 0755 "$destdir" || return 1
  fi
  tmp="$(mktemp "$destdir/.$(basename "$name").XXXXXX")" || return 1
  install -m "$mode" "$src" "$tmp" || return 1
  mv -f "$tmp" "$APP_DIR/$name"
}

# restore_or_remove_configs: used by rollback to undo a partially- or fully-
# applied stage_configs, the same prior/new-state discipline
# restore_or_remove_secrets already applies to the five SECRET_FILES. A
# no-op unless this run actually got far enough to arm CONFIG_STAGED. A file
# that existed before this run is restored (atomically, same mode) from this
# run's own CONFIG_BACKUP_DIR; a file that did not (first deploy, or this
# specific file newly added) is deleted, never left behind as a leftover new
# config. Every restore/delete step is explicitly checked: a missing backup,
# a failed atomic install, or a failed rm is reported and this returns 1 --
# never silently claimed as a successful recovery -- but every remaining
# CONFIG_FILES entry is still attempted regardless of an earlier one's
# failure, same as restore_or_remove_mirofish's own discipline.
restore_or_remove_configs() {
  [[ "$CONFIG_STAGED" == 1 ]] || return 0
  CONFIG_STAGED=0
  local name ok=0
  for name in "${CONFIG_FILES[@]}"; do
    if [[ "${CONFIG_PRIOR_EXISTED[$name]:-0}" == 1 ]]; then
      if [[ ! -f "$CONFIG_BACKUP_DIR/$name" ]]; then
        echo "deploy: config: rollback: missing backup for $APP_DIR/$name; cannot restore" >&2
        ok=1
        continue
      fi
      if ! install_config_file "$name" "$CONFIG_BACKUP_DIR/$name"; then
        echo "deploy: config: rollback: failed to restore $APP_DIR/$name from backup" >&2
        ok=1
      fi
    else
      if ! rm -f "$APP_DIR/$name"; then
        echo "deploy: config: rollback: failed to remove $APP_DIR/$name" >&2
        ok=1
      fi
    fi
  done
  return "$ok"
}

# validate_staged_unit: existence/symlink/regular-file checks, same
# discipline as validate_staged_config_file, plus a real `systemd-analyze
# verify` against the STAGED file when the binary is available (never
# faked out in production; an offline test without systemd on PATH simply
# skips this one check, same as every other optional-tool guard in this
# file). Never installs/activates anything.
validate_staged_unit() {
  local file="$APP_CONFIG_STAGING_DIR/$UNIT_STAGED_NAME"
  if [[ ! -e "$file" ]]; then
    echo "deploy: missing staged $file" >&2
    return 1
  fi
  if [[ -L "$file" || ! -f "$file" ]]; then
    echo "deploy: staged $file must be a regular file, not a symlink or other path" >&2
    return 1
  fi
  if command -v systemd-analyze >/dev/null 2>&1; then
    systemd-analyze verify "$file" || {
      echo "deploy: staged $UNIT_STAGED_NAME failed systemd-analyze verify" >&2
      return 1
    }
  fi
}

# stage_unit: the systemd-unit analogue of stage_configs above, for the ONE
# file deploy.sh manages outside $APP_DIR ($UNIT_INSTALLED_PATH, normally
# /etc/systemd/system/ai-trading-control.service). Captures whether a prior
# unit existed, and -- only when it did -- its own prior content plus
# whether the service was active/enabled, BEFORE installing this run's
# staged unit and (re)starting it. Called from main flow right after
# stage_configs() has already installed this run's control/* code, so the
# unit that starts always matches the code already on disk; undone by
# restore_or_remove_unit on any later failure (task-5-review fix round 1,
# Critical #1).
stage_unit() {
  validate_staged_unit
  UNIT_WAS_ACTIVE=0
  UNIT_WAS_ENABLED=0
  if [[ -f "$UNIT_INSTALLED_PATH" && ! -L "$UNIT_INSTALLED_PATH" ]]; then
    UNIT_PRIOR_EXISTED=1
    UNIT_BACKUP_PATH="$(mktemp "$STATE_DIR/.unit-backup-XXXXXX")" || return 1
    cp -p "$UNIT_INSTALLED_PATH" "$UNIT_BACKUP_PATH" || return 1
    systemctl is-active --quiet "$UNIT_NAME" 2>/dev/null && UNIT_WAS_ACTIVE=1
    systemctl is-enabled --quiet "$UNIT_NAME" 2>/dev/null && UNIT_WAS_ENABLED=1
  else
    UNIT_PRIOR_EXISTED=0
  fi
  UNIT_STAGED=1
  local tmp
  tmp="$(mktemp "$UNIT_DIR/.$UNIT_NAME.XXXXXX")" || return 1
  install -m 0644 "$APP_CONFIG_STAGING_DIR/$UNIT_STAGED_NAME" "$tmp" || return 1
  mv -f "$tmp" "$UNIT_INSTALLED_PATH" || return 1
  systemctl daemon-reload || return 1
  systemctl enable "$UNIT_NAME" || return 1
  # Reconciliation (control/server.py's reconcile(), run on the helper's own
  # thread on every start) shares the SAME lifecycle lock this script
  # already holds (FD 9) -- it blocks behind this deploy's own lock until
  # commit-or-rollback releases it, so restarting here, mid-transaction,
  # never lets an unverified reconcile touch Docker before this deploy
  # finishes (task-5-review fix round 1: "No unverified boot reconcile
  # outside transaction changing choices").
  systemctl restart "$UNIT_NAME" || return 1
}

# restore_or_remove_unit: used by rollback to undo a partially- or
# fully-applied stage_unit, the same prior/new-state discipline
# restore_or_remove_configs already applies to the six control/*
# CONFIG_FILES entries. A no-op unless this run actually got far enough to
# arm UNIT_STAGED. A prior unit is restored byte-for-byte and left active
# only if it was active before (task-5-brief: "old deploy rollback must
# restore the matching helper/runtime version"); a genuinely first
# activation (no prior unit at all) is stopped, disabled, and its just-
# installed file removed -- never left running on a rolled-back deploy
# (task-5-review fix round 1, Critical #1: "roll back its activation").
restore_or_remove_unit() {
  [[ "$UNIT_STAGED" == 1 ]] || return 0
  UNIT_STAGED=0
  if [[ "$UNIT_PRIOR_EXISTED" == 1 ]]; then
    if [[ ! -f "$UNIT_BACKUP_PATH" ]]; then
      echo "deploy: unit: rollback: missing backup for $UNIT_INSTALLED_PATH; cannot restore" >&2
      return 1
    fi
    local tmp
    tmp="$(mktemp "$UNIT_DIR/.$UNIT_NAME.XXXXXX")" 2>/dev/null || {
      echo "deploy: unit: rollback: failed to restore $UNIT_INSTALLED_PATH from backup" >&2
      return 1
    }
    if ! install -m 0644 "$UNIT_BACKUP_PATH" "$tmp" || ! mv -f "$tmp" "$UNIT_INSTALLED_PATH"; then
      echo "deploy: unit: rollback: failed to restore $UNIT_INSTALLED_PATH from backup" >&2
      return 1
    fi
    systemctl daemon-reload 2>/dev/null
    if [[ "$UNIT_WAS_ACTIVE" == 1 ]]; then
      systemctl restart "$UNIT_NAME" || {
        echo "deploy: unit: rollback: restored $UNIT_INSTALLED_PATH but failed to restart it" >&2
        return 1
      }
    else
      systemctl stop "$UNIT_NAME" 2>/dev/null || true
    fi
    if [[ "$UNIT_WAS_ENABLED" != 1 ]]; then
      systemctl disable "$UNIT_NAME" 2>/dev/null || true
    fi
  else
    systemctl stop "$UNIT_NAME" 2>/dev/null || true
    systemctl disable "$UNIT_NAME" 2>/dev/null || true
    if ! rm -f "$UNIT_INSTALLED_PATH"; then
      echo "deploy: unit: rollback: failed to remove $UNIT_INSTALLED_PATH" >&2
      return 1
    fi
    systemctl daemon-reload 2>/dev/null || true
  fi
}

rollback() {
  local status="$1" previous=""
  trap - ERR
  if [[ -n "$ENV_STAGING_DIR" ]]; then
    restore_or_remove_secrets
  fi
  # whole-branch review reopen, round 2: MiroFish rollback runs BEFORE
  # config rollback, not after. stop_remove_mirofish_container() needs
  # $APP_DIR/docker-compose.yml to still be the one this same run's
  # deploy_tag/compose up just used, to correctly `compose rm -s -f
  # mirofish` any container that file started -- restore_or_remove_configs
  # below may delete that exact file an instant later (a genuine first
  # deploy has no prior version to restore), which would otherwise leave
  # stop_remove_mirofish_container looking at a config that already
  # vanished, through no fault of an external actor, and refusing to guess.
  restore_or_remove_mirofish || echo "deploy: mirofish: rollback error above; MiroFish left disabled, the rest of rollback continues" >&2
  restore_or_remove_configs || echo "deploy: config: rollback error above; one or more of docker-compose.yml/docker-compose.mirofish.yml/Caddyfile/health-check.sh may be left in an inconsistent state, the rest of rollback continues" >&2
  # Unit restore runs AFTER config restore, same ordering reasoning as
  # mirofish-before-config above: the service should only (re)start once
  # the control/* code underneath it has already been returned to its own
  # matching prior version, never the other way around.
  restore_or_remove_unit || echo "deploy: unit: rollback error above; the control helper's unit/activation state may not match the rolled-back release, the rest of rollback continues" >&2
  # Restore the pre-mutation persisted app-control preferences (Task 5) --
  # a NEW, strictly greater revision, never a lowered one -- alongside the
  # tag/secrets/config restore above, using this run's own scratch
  # control/state.py (unaffected by whatever restore_or_remove_configs just
  # did to $APP_DIR/control/state.py).
  restore_preferences_on_rollback
  if [[ -f "$STATE_FILE" ]]; then
    previous="$(cat "$STATE_FILE")"
  fi
  if [[ -n "$previous" && "$previous" != "$IMAGE_TAG" ]]; then
    echo "deploy: failed with status $status; rolling back to $previous" >&2
    # final whole-branch review, Important #1: a genuine first activation
    # (no prior unit existed -- restore_or_remove_unit above just stopped
    # and disabled the helper it installed moments ago, by design) has no
    # matching prior helper version to verify. The scratch health-check.sh
    # this redeploy runs unconditionally requires an ACTIVE control helper
    # otherwise, so without this it loops for the full
    # HEALTH_CHECK_ATTEMPTS x HEALTH_CHECK_DELAY_SECONDS budget and then
    # misreports this correct redeploy as "rollback ... failed too" even
    # though the three real apps are already restored and running.
    #
    # final re-review fix: this must key off a TRUSTED KNOWN absence, never
    # a default/unknown one. UNIT_PRIOR_EXISTED starts EMPTY (not "0") and
    # is only ever set to the literal string "0" by stage_unit() itself,
    # right after it has actually probed $UNIT_INSTALLED_PATH and before any
    # mutation -- so `== 0` here is only ever true when this run's own
    # stage_unit() ran and genuinely found nothing. A deploy that fails
    # BEFORE stage_unit ever runs (e.g. a stage_configs failure) leaves it
    # empty; restore_or_remove_unit() is then a no-op (UNIT_STAGED never got
    # set either), so whatever helper already existed on disk -- active or
    # not -- was never touched by this run and must still be verified
    # normally, exactly like any other rollback. Only a genuinely KNOWN
    # first activation (UNIT_PRIOR_EXISTED == 1 restored/restarted a
    # matching prior version; UNIT_PRIOR_EXISTED == 0 means stage_unit
    # itself just stopped/disabled the only unit that ever existed) decides
    # this either way -- an empty/unknown value always falls through to the
    # normal, verifying path.
    if [[ "$UNIT_PRIOR_EXISTED" == 0 ]]; then
      export HEALTH_CHECK_SKIP_CONTROL=1
    fi
    # The previous tag may predate services this run's catalog protects (the Desk's
    # api and scheduler; found 2026-10-12). Its own compose then decides what the
    # health check requires. Set only here: forward deploys keep the strict check.
    export HEALTH_CHECK_ROLLBACK=1
    deploy_tag "$previous" || echo "deploy: rollback to $previous failed too" >&2
  else
    echo "deploy: failed with status $status; no earlier tag to roll back to" >&2
  fi
  exit "$status"
}

# stage_secrets: validates every staged file first (no side effects on
# failure). Only then does it record which target files already exist, back
# those up to .previous/, and arm the rollback trap -- all before installing
# anything -- so a failure partway through the four atomic installs below is
# always caught and always rolled back to exactly the prior state. `rollback`
# and everything it calls are defined above, before this function is ever
# invoked, so the trap it arms always resolves.
stage_secrets() {
  local name
  for name in "${SECRET_FILES[@]}"; do
    validate_staged_file "$(secret_source_dir "$name")/$name"
  done

  install -d -m 0700 "$SECRETS_DIR" "$SECRETS_DIR/.previous"

  for name in "${SECRET_FILES[@]}"; do
    if [[ -f "$SECRETS_DIR/$name" ]]; then
      PRIOR_EXISTED[$name]=1
      cp -p "$SECRETS_DIR/$name" "$SECRETS_DIR/.previous/$name"
    else
      PRIOR_EXISTED[$name]=0
    fi
  done
  trap 'rollback "$?"' ERR

  for name in "${SECRET_FILES[@]}"; do
    install_secret_file "$(secret_source_dir "$name")/$name" "$SECRETS_DIR/$name"
    # `return 1` here would not reliably trigger the ERR trap just armed
    # above (a function's own `return` does not fire a trap set during that
    # same call, only one already armed before the call) -- a real failing
    # command does, so use one.
    [[ "$name" != "${DEPLOY_SH_FAIL_AFTER:-}" ]] || false
  done
}

# validate_staged_config_file FILE: the four CONFIG_FILES entries are not
# KEY=value secrets, so this checks only what rollback correctness actually
# needs before any backup/install touches $APP_DIR -- the staged file must
# exist, must be a plain regular file (never a symlink: an operator or a
# compromised staging step could otherwise point this script at an arbitrary
# path outside its own staging directory), and must be readable.
#
# Fix round 1 (review): this is always called from inside stage_configs(),
# which always runs AFTER stage_secrets() has already installed the five
# SECRET_FILES and armed `trap 'rollback "$?"' ERR` -- calling die() (a bare
# `exit 1`) here would terminate the script WITHOUT ever running that trap,
# silently leaving the already-staged secrets un-rolled-back. An ERR trap
# only fires for a *command* that fails, never for an explicit `exit`
# (verified empirically), so this reports the error and returns 1 instead;
# every call site below is a bare statement (no `||`/`if`), which -- under
# `set -Ee` -- does correctly fire an already-armed ERR trap.
validate_staged_config_file() {
  local file="$1"
  if [[ ! -e "$file" ]]; then
    echo "deploy: missing staged config $file" >&2
    return 1
  fi
  if [[ -L "$file" ]]; then
    echo "deploy: staged config $file must not be a symlink" >&2
    return 1
  fi
  if [[ ! -f "$file" ]]; then
    echo "deploy: staged config $file is not a regular file" >&2
    return 1
  fi
  if [[ ! -r "$file" ]]; then
    echo "deploy: staged config $file is not readable" >&2
    return 1
  fi
}

# validate_staged_control_content NAME FILE (Task 5, app-controls): the
# control helper's own code/catalog/library entries get type-specific
# validation beyond validate_staged_config_file's existence/type checks
# above -- every staged .py is byte-compiled (py_compile parses/compiles
# only, it never executes module-level code) so a syntax error is caught
# here, before any install; control/catalog.json's schema is validated by
# importing the staged control/state.py standing beside it (its own
# existing module-level _load_catalog() -> validate_catalog() call already
# does this -- reused here rather than re-deriving the schema a second
# time); and the two standalone MiroFish-preparer scripts get a `bash -n`
# syntax check. Same die()-avoids-bypassing-the-rollback-trap discipline as
# its neighbors: reports and returns 1, never exits.
validate_staged_control_content() {
  local name="$1" file="$2"
  case "$name" in
    *.py)
      python3 -m py_compile "$file" || {
        echo "deploy: control: staged $file has invalid Python syntax" >&2
        return 1
      }
      ;;
  esac
  case "$name" in
    control/catalog.json)
      python3 -c '
import sys
sys.path.insert(0, sys.argv[1])
import state
' "$(dirname "$file")" || {
        echo "deploy: control: staged control/catalog.json failed schema validation" >&2
        return 1
      }
      ;;
    deploy/production/mirofish-runtime.sh | deploy/production/prepare-mirofish.sh)
      bash -n "$file" || {
        echo "deploy: control: staged $file has invalid bash syntax" >&2
        return 1
      }
      ;;
  esac
}

# validate_active_config_path NAME: before this run's stage_configs() ever
# records NAME's prior existence or backs it up, refuse an active
# $APP_DIR/NAME that is a symlink (valid-target or dangling) or any other
# non-regular existing path (directory, FIFO, device). `[[ -f ]]` alone
# follows symlinks and treats every other existing-but-wrong-type path as
# indistinguishable from genuine absence -- conflating those would let
# rollback replace a symlink's target silently, or record CONFIG_PRIOR_EXISTED=0
# for a path that is not actually absent, so a later `rm -f` could remove a
# non-regular path rollback could never have correctly restored anyway.
# Genuine absence (nothing at all at this path) remains the only
# CONFIG_PRIOR_EXISTED=0 case -- an untouched first-ever bootstrap is
# unaffected. Same die()-avoids-bypassing-the-rollback-trap reasoning as
# validate_staged_config_file above: reports and returns 1, never exits.
validate_active_config_path() {
  local name="$1" path="$APP_DIR/$1"
  if [[ -L "$path" ]]; then
    echo "deploy: active config $path is a symlink; refusing to proceed" >&2
    return 1
  fi
  if [[ -e "$path" && ! -f "$path" ]]; then
    echo "deploy: active config $path exists but is not a regular file; refusing to proceed" >&2
    return 1
  fi
}

# validate_staged_compose: parses the two staged Compose files together --
# the same merged base+mirofish inputs, project-name override, and
# REGISTRY/IMAGE_TAG/SECRETS_DIR/Caddyfile-sha256 environment the real
# compose() helper already applies to the *active* files -- via
# `docker compose ... config --quiet` against the *staged* files, so a
# malformed staged release is rejected before any backup or active-config
# mutation, not merely recovered later by a failed pull/up + rollback.
# `--quiet` suppresses Compose's own resolved (secret-interpolated) output;
# only its parse/merge error, if any, reaches stderr. Never reads or prints
# a real secret value itself (SECRETS_DIR is passed only so env_file paths
# resolve the same way deploy_tag()'s own compose() calls already do). Same
# die()-avoids-bypassing-the-rollback-trap reasoning as the two functions
# above: reports and returns 1, never exits.
validate_staged_compose() {
  local caddyfile_sha=unset
  [[ -f "$APP_CONFIG_STAGING_DIR/Caddyfile" ]] && caddyfile_sha="$(sha256sum "$APP_CONFIG_STAGING_DIR/Caddyfile")" && caddyfile_sha="${caddyfile_sha%% *}"
  if ! AI_TRADING_CADDYFILE_SHA256="$caddyfile_sha" \
      AI_TRADING_REGISTRY="$REGISTRY" \
      AI_TRADING_IMAGE_TAG="$IMAGE_TAG" \
      AI_TRADING_SECRETS_DIR="$SECRETS_DIR" \
      docker compose --project-name "${DEPLOY_SH_COMPOSE_PROJECT:-ai-trading}" \
        -f "$APP_CONFIG_STAGING_DIR/docker-compose.yml" \
        -f "$APP_CONFIG_STAGING_DIR/docker-compose.mirofish.yml" \
        config --quiet; then
    echo "deploy: staged Compose configuration is invalid -- docker compose config rejected the staged docker-compose.yml/docker-compose.mirofish.yml" >&2
    return 1
  fi
}

# stage_configs: the config-file analogue of stage_secrets above, called
# right after it in main flow (by the time this runs, stage_secrets has
# already armed `trap 'rollback "$?"' ERR`, so any failure in here already
# rolls back both). Validates every staged file first (existence/type/
# readability, then the merged staged Compose configuration itself -- review
# round 1: a malformed staged release must be rejected here, not discovered
# later via a failed pull/up + rollback), then validates every CURRENTLY
# ACTIVE config path is either genuinely absent or a plain regular file
# (review round 1: a symlink or other non-regular active path must never be
# silently conflated with absence) -- all with no side effects on failure.
# Only once every one of those checks passes does it record which of the
# four CONFIG_FILES already exist in $APP_DIR and back those up into this
# run's own CONFIG_BACKUP_DIR scratch directory, arm CONFIG_STAGED, and
# atomically install all four -- exactly task-6-brief's atomic-install core,
# factored through install_config_file. A later, unrelated failure (secrets,
# MiroFish, deploy_tag/health-check) still rolls these four back via
# restore_or_remove_configs, same as the five SECRET_FILES.
stage_configs() {
  local name
  for name in "${CONFIG_FILES[@]}"; do
    validate_staged_config_file "$APP_CONFIG_STAGING_DIR/$name"
    validate_staged_control_content "$name" "$APP_CONFIG_STAGING_DIR/$name"
  done
  validate_staged_compose

  for name in "${CONFIG_FILES[@]}"; do
    validate_active_config_path "$name"
  done

  CONFIG_BACKUP_DIR="$(mktemp -d "$APP_DIR/.config-backup-XXXXXX")"
  for name in "${CONFIG_FILES[@]}"; do
    if [[ -f "$APP_DIR/$name" ]]; then
      CONFIG_PRIOR_EXISTED[$name]=1
      install -d -m 0755 "$CONFIG_BACKUP_DIR/$(dirname "$name")"
      cp -p "$APP_DIR/$name" "$CONFIG_BACKUP_DIR/$name"
    else
      CONFIG_PRIOR_EXISTED[$name]=0
    fi
  done
  CONFIG_STAGED=1

  for name in "${CONFIG_FILES[@]}"; do
    install_config_file "$name" "$APP_CONFIG_STAGING_DIR/$name"
    # Same `false`-not-`return` reasoning as stage_secrets' own loop above.
    [[ "$name" != "${DEPLOY_SH_CONFIG_FAIL_AFTER:-}" ]] || false
  done
}

# --- main flow below this line; test-deploy-firestore.sh sources only the
# function definitions above it and calls them directly. ---
# Every successful deploy renders fresh Firestore profiles (no mode silently
# reuses a stale $SECRETS_DIR), so fail here -- before touching Firestore,
# Docker, or any secret file -- if CI never staged cloudflared.env at all,
# rather than let a manual/misconfigured run quietly skip rendering.
[[ -n "$ENV_STAGING_DIR" ]] || die "ENV_STAGING_DIR is required: CI must stage cloudflared.env first"
[[ -f "$ENV_STAGING_DIR/cloudflared.env" ]] || die "missing $ENV_STAGING_DIR/cloudflared.env; CI must stage it first"
# A10a: the workflow stages the four known config files but no longer
# installs any of them as the active config itself -- fail here, before
# touching Firestore, Docker, any secret, or any active config file, if the
# workflow never staged them (or staged an incomplete set) at all.
[[ -n "$APP_CONFIG_STAGING_DIR" ]] || die "APP_CONFIG_STAGING_DIR is required: the workflow must stage docker-compose.yml, docker-compose.mirofish.yml, Caddyfile, and health-check.sh first"
for name in "${CONFIG_FILES[@]}"; do
  [[ -f "$APP_CONFIG_STAGING_DIR/$name" ]] || die "missing $APP_CONFIG_STAGING_DIR/$name; the workflow must stage it first"
done
[[ -f "$APP_CONFIG_STAGING_DIR/$UNIT_STAGED_NAME" ]] || die "missing $APP_CONFIG_STAGING_DIR/$UNIT_STAGED_NAME; the workflow must stage it first"
# Task 5 (app-controls): acquire the shared lifecycle lock (FD 9) before any
# preference/config mutation -- held through health-check and commit-or-
# rollback, released only on exit (cleanup_scratch_dirs' EXIT trap). This
# run's own root-only coordinator/state-CLI copy is prepared immediately
# after, from THIS run's staged files (never $APP_DIR's current ones), then
# this deploy's pre-mutation preferences are snapshotted (restored on
# rollback with a new, strictly greater revision) and the existing
# MIROFISH_ACTIVATE operator input is folded into that same persisted state
# -- install.sh has already initialized/adopted $CONTROL_STATE_PATH on a
# genuinely first install; a missing or corrupt state file here fails this
# deploy closed, before any further mutation, rather than silently
# re-deriving fresh defaults.
acquire_lifecycle_lock
prepare_control_scratch
snapshot_preferences
map_mirofish_dispatch_to_state
# Make room, then prove the pull fits, before Firestore, any container, or any
# secret file is touched (a failed pull on a full disk also breaks rollback).
prune_old_images
require_free_space
render_profiles
# Opt-in only; a failed/absent MiroFish activation must not fail this
# deploy of the other three apps, and must run before stage_secrets touches
# any existing secret file or deploy_tag starts a single container. Driven
# by the PERSISTED preference (read_desired_mirofish), just folded in above
# -- never re-derived from which container happens to be running right now.
if [[ "$(read_desired_mirofish)" == true ]]; then
  MIROFISH_ACTIVATE=1 activate_mirofish || true
else
  unset MIROFISH_ACTIVATE
  activate_mirofish || true
fi
# Whole-branch review reopen: whenever the line above didn't just activate
# MiroFish, prove it's actually stopped -- not just "unset" -- before
# anything else in this deploy proceeds. A stop/verify failure aborts here,
# before stage_secrets or deploy_tag touch anything.
ensure_mirofish_stopped
stage_secrets
stage_configs
# Only after stage_configs() has installed this run's control/* code --
# the unit that (re)starts here always matches the code already on disk.
# Covered by the same rollback trap stage_secrets already armed above.
stage_unit

for name in "${SECRET_FILES[@]}"; do
  file="$SECRETS_DIR/$name"
  [[ -f "$file" ]] || die "missing $file; render and stage env files first"
  [[ "$(stat -c '%u:%a' "$file")" == "0:600" ]] || die "$file must be owned by root with mode 600"
done

trap 'rollback "$?"' ERR

install -d -m 0755 "$APP_DIR"
deploy_tag "$IMAGE_TAG"
printf '%s\n' "$IMAGE_TAG" >"$STATE_FILE.tmp"
mv -f "$STATE_FILE.tmp" "$STATE_FILE"
echo "deploy: ai-trading is running $IMAGE_TAG"
