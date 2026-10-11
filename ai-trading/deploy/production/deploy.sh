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

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

APP_DIR="${APP_DIR:-/opt/family-app/ai-trading}"
SECRETS_DIR="${AI_TRADING_SECRETS_DIR:-/etc/family-app/ai-trading}"
REGISTRY="${AI_TRADING_REGISTRY:-ghcr.io/thangtran3112/family-app}"
ENV_STAGING_DIR="${ENV_STAGING_DIR:-}"
APP_CONFIG_STAGING_DIR="${APP_CONFIG_STAGING_DIR:-}"
RUNTIME_ENV_DIR="${AI_TRADING_RUNTIME_ENV_DIR:-/run/family-app/ai-trading}"
# Shared MiroFish render/validate/install library (Task 2, app-controls):
# defines install_secret_file, mirofish_env_valid, file_mode_octal,
# cleanup_mirofish_scratch, restore_or_remove_mirofish, activate_mirofish
# and their tracking globals (MIROFISH_REQUIRED_KEYS, MIROFISH_RUNTIME_ENV_FILE,
# MIROFISH_PRIOR_EXISTED, MIROFISH_INSTALLED_THIS_RUN) -- also sourced
# standalone by production/prepare-mirofish.sh so a later operator-triggered
# MiroFish activation (control/runtime.py's Runtime.prepare_mirofish(), used
# when an operator turns MiroFish on without a full redeploy) shares this
# exact checked contract instead of a second copy.
# shellcheck source=mirofish-runtime.sh
source "$SCRIPT_DIR/mirofish-runtime.sh"
MIN_FREE_GB="${AI_TRADING_MIN_FREE_GB:-30}"
DOCKER_DATA_DIR="${AI_TRADING_DOCKER_DATA_DIR:-/var/lib/docker}"
STATE_FILE="$APP_DIR/last-good-tag"
IMAGES_ENV="$APP_DIR/images.env"
SECRET_FILES=(tradingagents.env ai-hedge-fund.env vibe-trading.env vibe-gateway.env auth.env market-data.env cloudflared.env)
# Tracks, per secret file, whether it existed before this run's staging so
# rollback can tell "restore the backup" from "delete what we just created".
declare -A PRIOR_EXISTED=()
# The four declarative config files this script now owns end-to-end (A10a):
# the workflow only stages them into APP_CONFIG_STAGING_DIR and no longer
# installs any of them as the VPS's active config itself.
CONFIG_FILES=(docker-compose.yml docker-compose.mirofish.yml Caddyfile health-check.sh)
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

die() {
  echo "deploy: $*" >&2
  exit 1
}

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
    "$family_config" render ai-trading/tradingagents ai-trading/ai-hedge-fund ai-trading/vibe-trading ai-trading/gateway ai-trading/market-data \
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
  compose up -d --remove-orphans --wait --wait-timeout 300
  "$APP_DIR/health-check.sh"
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
# restored with -- 0755 for the one executable script, 0644 for the three
# declarative files, exactly task-6-brief's atomic-install core.
config_mode() {
  if [[ "$1" == health-check.sh ]]; then
    printf '0755\n'
  else
    printf '0644\n'
  fi
}

# install_config_file NAME SRC: installs SRC as $APP_DIR/NAME atomically (a
# same-directory temp file with NAME's correct mode, then `mv -f` over the
# destination -- a reader never sees a partially-written file, same
# atomicity install_secret_file already gives the five SECRET_FILES).
# Returns 1 on any failure (mktemp/install/mv) instead of letting a partial
# temp file or a failed rename go unnoticed.
install_config_file() {
  local name="$1" src="$2" mode tmp
  mode="$(config_mode "$name")"
  tmp="$(mktemp "$APP_DIR/.config-${name}.XXXXXX")" || return 1
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
  if [[ -f "$STATE_FILE" ]]; then
    previous="$(cat "$STATE_FILE")"
  fi
  if [[ -n "$previous" && "$previous" != "$IMAGE_TAG" ]]; then
    echo "deploy: failed with status $status; rolling back to $previous" >&2
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
  done
  validate_staged_compose

  for name in "${CONFIG_FILES[@]}"; do
    validate_active_config_path "$name"
  done

  CONFIG_BACKUP_DIR="$(mktemp -d "$APP_DIR/.config-backup-XXXXXX")"
  for name in "${CONFIG_FILES[@]}"; do
    if [[ -f "$APP_DIR/$name" ]]; then
      CONFIG_PRIOR_EXISTED[$name]=1
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
# Make room, then prove the pull fits, before Firestore, any container, or any
# secret file is touched (a failed pull on a full disk also breaks rollback).
prune_old_images
require_free_space
render_profiles
# Opt-in only; a failed/absent MiroFish activation must not fail this
# deploy of the other three apps, and must run before stage_secrets touches
# any existing secret file or deploy_tag starts a single container.
activate_mirofish || true
# Whole-branch review reopen: whenever the line above didn't just activate
# MiroFish, prove it's actually stopped -- not just "unset" -- before
# anything else in this deploy proceeds. A stop/verify failure aborts here,
# before stage_secrets or deploy_tag touch anything.
ensure_mirofish_stopped
stage_secrets
stage_configs

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
