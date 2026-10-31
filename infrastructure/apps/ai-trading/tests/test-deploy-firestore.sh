#!/usr/bin/env bash
# ShellCheck 0.10 cannot see test shims exported to child shells or called
# through sourced deploy functions; those bodies are reachable at runtime.
# shellcheck disable=SC2317,SC2329
# Offline test for production/deploy.sh's Firestore-render + atomic-staging
# contract (A9a1): render_profiles() + stage_secrets() + rollback, with a
# fake family_config.py standing in for the merged shared CLI
# (common/config/family_config.py) so failures are deterministic.
# No real Firestore, Secret Manager, gcloud, or VPS credential is used
# anywhere in this file. Everything runs under one mktemp -d root outside the
# repository (matches ai-trading/AGENTS.md's "never put env files under
# ai-trading/" rule) and that root is removed on exit.
#
# Cases 10-14 (A9b) additionally cover activate_mirofish() -- the opt-in
# MiroFish Firestore-profile activation path: default-disabled, enabled with
# a fake CLI, and a missing-profile activation failure that must never fail
# the other three apps' deploy -- plus `docker compose config --quiet`
# against the real production/mirofish compose files with the profile off
# and on, using a fake mirofish.env outside the repository.
#
# Cases 15-22 (A9b fix rounds 1-2, review P1/P2) additionally cover: an
# inherited COMPOSE_PROFILES=mirofish plus a stale file with MIROFISH_ACTIVATE
# unset; a genuine install failure (RUNTIME_ENV_DIR under a non-directory
# parent); mirofish.env's own prior/new state in deploy rollback
# (remove-if-new, restore-if-prior); a previously-activated-then-disabled
# redeploy; and health-check.sh's mirofish_enabled() selecting purely on
# COMPOSE_PROFILES=mirofish (never a stale file or container state), with
# Cases 16-17 proving service_ok() -- not mirofish_enabled() -- is what
# correctly fails an exited container and passes a healthy one.
#
# Cases 23-24 (fix round 2, review P2) force a genuine (not faked) restore
# failure and remove failure in restore_or_remove_mirofish() via a real
# chmod 0500 on the runtime dir, asserting the error is reported and the
# five SECRET_FILES still roll back regardless.
#
# Cases 25-27 (fix round 3, review P2) additionally cover: a direct
# stop_remove_mirofish_container() check (its own best-effort "compose rm
# -s -f mirofish", both outcomes); a genuine post-install scratch-cleanup
# failure in activate_mirofish() escalating into a full, self-healing
# activation failure instead of exporting COMPOSE_PROFILES over a leftover
# secret-bearing scratch copy; and a process-level, fake-Docker scenario
# combining a real post-Compose health-check failure with rollback's own
# mirofish.env removal also failing, asserting the best-effort
# stop_remove_mirofish_container call actually ran.
#
# Cases 28-31 (whole-branch review reopen) additionally cover the new
# ensure_mirofish_stopped() forward-path gate: a normal disabled redeploy
# after an earlier activation actually stops a stale container (fake
# compose); a failed new activation (missing Firestore profile) still
# stops a stale container (fake compose); a genuine stop-command failure
# FAILS THE WHOLE DEPLOY, process-level, before stage_secrets/deploy_tag
# ever run (fake Docker); and a REAL Docker Compose fixture (dummy busybox
# services, unique disposable project, no real ai-trading images/secrets)
# proving the fix against actual Docker, not just fakes -- see
# task-9-report.md for the real-Compose reproduction this round started
# from (an already-running profile-gated container survives
# `up -d --remove-orphans` alone).
#
# Cases 33-38 (2026-10-10 disk-full deploy failure) cover image retention and
# the free-disk guard: old ai-trading tags are pruned before the pull while
# this release, the last-good tag, and everything outside the registry's
# ai-trading-* repos survive (and nothing is pruned when the last-good tag is
# not a single commit SHA); too little free disk, an unreadable Docker data
# directory, or a malformed threshold fails the deploy before any secret,
# container, or tag is touched; the 30 GiB default is checked at its boundary.
#
# Usage: infrastructure/apps/ai-trading/tests/test-deploy-firestore.sh
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
DEPLOY_SH="$SCRIPT_DIR/../deploy.sh"
HEALTH_SH="$SCRIPT_DIR/../health-check.sh"
MIROFISH_LIB_SH="$SCRIPT_DIR/../mirofish-runtime.sh"
COMPOSE_FILE="$SCRIPT_DIR/../docker-compose.yml"
MIROFISH_COMPOSE_FILE="$SCRIPT_DIR/../docker-compose.mirofish.yml"
# Task 5 (app-controls): the real control/catalog.json + control/state.py
# (never a fake) stand in for the staged control/* CONFIG_FILES entries --
# stage_configs()'s own new validate_staged_control_content() imports
# state.py to check catalog.json's schema, so a fixture copy must be the
# genuine, importable module, not a hand-rolled stand-in.
CONTROL_DIR_REAL="$REPO_ROOT/ai-trading/control"
[[ -f "$DEPLOY_SH" ]] || { echo "test-deploy-firestore: missing $DEPLOY_SH" >&2; exit 1; }
[[ -f "$HEALTH_SH" ]] || { echo "test-deploy-firestore: missing $HEALTH_SH" >&2; exit 1; }
[[ -f "$MIROFISH_LIB_SH" ]] || { echo "test-deploy-firestore: missing $MIROFISH_LIB_SH" >&2; exit 1; }
# Every state.py CLI invocation this run makes (deploy.sh's own
# acquire_lifecycle_lock/snapshot_preferences/map_mirofish_dispatch_to_state/
# apply_selected_services) creates/opens a lock and state file owned by the
# REAL process uid -- never actual root in this offline test environment.
export AI_TRADING_CONTROL_OWNER_UID
AI_TRADING_CONTROL_OWNER_UID="$(id -u)"

TEST_ROOT="$(mktemp -d)"
# cleanup is called explicitly at the very end (below) for the two normal
# exit paths, and also registered on EXIT so it still runs for every abnormal
# one (an early `die`/`exit` inside a scenario's subshell, a failed
# assertion, etc.) -- both call sites share the same idempotent body, so
# running it twice on a normal exit is harmless.
cleanup() { rm -rf "$TEST_ROOT"; }
trap cleanup EXIT

FAIL_COUNT=0
CASE_COUNT=0

# deploy.sh's disk guard is exercised only by Cases 34-37; every other
# scenario must not depend on this machine's free disk (or on the Docker data
# directory existing at all).
export AI_TRADING_MIN_FREE_GB=0
export AI_TRADING_DOCKER_DATA_DIR="$TEST_ROOT"

fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  echo "    FAIL: $*" >&2
}

# source_lib: deploy.sh's own function definitions (same marker-based
# technique as source_health_lib below), with deploy.sh's main-flow block
# (everything after the "--- main flow below this line" marker) excluded --
# so sourcing the result only loads functions, without also running a real
# deploy. IMAGE_TAG must already be a valid-looking commit SHA before this
# is sourced: deploy.sh's one top-level validation line above that marker
# runs immediately on source.
#
# Packaging-fix: deploy.sh's own library-source guard now prefers
# $APP_CONFIG_STAGING_DIR/deploy/production/mirofish-runtime.sh (sourced
# literally, unfiltered) whenever that directory is set -- every scenario
# below already sets it to a per-scenario config-staging dir via
# new_scratch()/stage_default_configs(), which now stages mirofish-
# runtime.sh's REAL content (never a syntax-only stand-in), so this no
# longer needs to special-case or filter out deploy.sh's own source line.
# A handful of scenarios never set APP_CONFIG_STAGING_DIR at all (they only
# exercise functions unrelated to MiroFish) -- for those, deploy.sh's own
# fallback branch sources "$SCRIPT_DIR/mirofish-runtime.sh" relative to
# wherever $LIB_FILE itself is sourced from, so a real copy is placed right
# beside it below.
source_lib() {
  awk '/^# --- main flow below this line;/{exit} {print}' "$DEPLOY_SH"
}
LIB_FILE="$TEST_ROOT/deploy-lib.sh"
source_lib >"$LIB_FILE"
cp "$MIROFISH_LIB_SH" "$TEST_ROOT/mirofish-runtime.sh"

# source_health_lib: health-check.sh's own function definitions (same
# marker-based technique as source_lib above), so a case can call
# mirofish_enabled() directly -- with its own COMPOSE_PROFILES and a stubbed
# compose() -- without running health-check.sh's real polling loop or
# touching a real Docker daemon.
source_health_lib() {
  awk '/^# --- main flow below this line;/{exit} {print}' "$HEALTH_SH"
}
HEALTH_LIB_FILE="$TEST_ROOT/health-lib.sh"
source_health_lib >"$HEALTH_LIB_FILE"

# fake_family_config: writes a stand-in family_config.py into DEST that
# implements only what render_profiles() depends on -- `render
# <app>/<profile>... --out-dir DIR`, resolving every requested target before
# writing any file (so FAKE_FC_MISSING_PROFILE can simulate a real "profile
# not found" ConfigError failing closed, before install), then writing
# DIR/<profile>.env (0600) atomically (temp file + rename, like the real
# cmd_render) with deterministic fake content. It also asserts
# FAMILY_CONFIG_CREDENTIALS was passed, matching the real CLI's VPS auth
# path. Never touches gcloud, Firestore, or Secret Manager.
fake_family_config() {
  local dest="$1"
  cat >"$dest" <<'FAKE_EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
[[ "${1:-}" == render ]] || { echo "fake family_config.py: only render is implemented" >&2; exit 2; }
shift
targets=()
out_dir=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out-dir) out_dir="$2"; shift 2 ;;
    *) targets+=("$1"); shift ;;
  esac
done
[[ -n "$out_dir" ]] || { echo "fake family_config.py: render needs --out-dir" >&2; exit 2; }
[[ -n "${FAMILY_CONFIG_CREDENTIALS:-}" ]] || { echo "fake family_config.py: FAMILY_CONFIG_CREDENTIALS not set" >&2; exit 2; }
for target in "${targets[@]}"; do
  if [[ "$target" == "${FAKE_FC_MISSING_PROFILE:-}" ]]; then
    echo "family-config: profile not found: $target" >&2
    exit 1
  fi
done
umask 077
for target in "${targets[@]}"; do
  profile="${target##*/}"
  tmp="$(mktemp "$out_dir/.$profile.env.XXXXXX")"
  if [[ "$profile" == mirofish ]]; then
    # Fake stand-in for the real ai-trading/mirofish profile's two required
    # names (A9b's activate_mirofish() contract) -- fake values only, never
    # real Zep/LLM credentials.
    printf 'ZEP_API_KEY=fake-zep-not-real\nLLM_API_KEY=fake-llm-not-real\n' >"$tmp"
  elif [[ "$profile" == vibe-trading && "${FAKE_FC_VIBE_NO_API_KEY:-}" != 1 ]]; then
    printf 'ANTHROPIC_API_KEY=fake-provider-not-real\nAPI_AUTH_KEY=fake-vibe-key-not-real\nFAKE_VALUE=fake-not-real-vibe-trading\n' >"$tmp"
  elif [[ "$profile" == consensus ]]; then
    [[ "${FAKE_FC_FINNHUB_KEY:-}" == 1 ]] || exit 2
    printf 'FINNHUB_API_KEY=fake-test-value\n' >"$tmp"
  else
    printf 'FAKE_VALUE=fake-not-real-%s\n' "$profile" >"$tmp"
  fi
  mv -f "$tmp" "$out_dir/$profile.env"
done
FAKE_EOF
  chmod 0700 "$dest"
}

# stage_default_configs DIR [HEALTH_BODY]: writes minimal, inert fixtures for
# the four files stage_configs() now owns (A10a), so every scenario has a
# working APP_CONFIG_STAGING_DIR by default without needing the real
# production Compose/Caddy content -- Task 6a owns only the rollback
# controller, never those files' real content (Task 6's job). HEALTH_BODY
# overrides health-check.sh's content only, preserving each case's own
# injected health logic (same technique Case 9 already used directly on
# $APP_DIR/health-check.sh before health-check.sh became a rollback-managed
# config file); the default is a plain `exit 0`.
stage_default_configs() {
  local dir="$1"
  printf 'name: ai-trading-fixture\nservices:\n  web:\n    image: busybox:1\n' >"$dir/docker-compose.yml"
  printf 'name: ai-trading-fixture\nservices:\n  mirofish:\n    image: busybox:1\n    profiles: ["mirofish"]\n' >"$dir/docker-compose.mirofish.yml"
  printf '# fixture Caddyfile, not the real production content\n' >"$dir/Caddyfile"
  if [[ $# -ge 2 ]]; then
    printf '%s\n' "$2" >"$dir/health-check.sh"
  else
    printf '#!/usr/bin/env bash\nexit 0\n' >"$dir/health-check.sh"
  fi
  chmod 0755 "$dir/health-check.sh"
  # Task 5 (app-controls): the six new CONFIG_FILES entries. catalog.json
  # and state.py are the REAL repo files (see CONTROL_DIR_REAL above);
  # runtime.py/server.py and the standalone prepare-mirofish.sh are
  # trivial, syntactically valid stand-ins -- nothing in this
  # transaction-level fixture actually imports or runs them, they only need
  # to pass py_compile/bash -n. mirofish-runtime.sh must be the REAL repo
  # file (packaging-fix): deploy.sh's own library-source guard now sources
  # this exact staged path at the top of every scenario below (via
  # $APP_CONFIG_STAGING_DIR), so a stand-in here would define none of the
  # functions the rest of this script depends on.
  mkdir -p "$dir/control" "$dir/deploy/production"
  cp "$CONTROL_DIR_REAL/catalog.json" "$dir/control/catalog.json"
  cp "$CONTROL_DIR_REAL/state.py" "$dir/control/state.py"
  printf '"""fixture stand-in, never executed by this transaction-level test."""\n' >"$dir/control/runtime.py"
  printf '"""fixture stand-in, never executed by this transaction-level test."""\n' >"$dir/control/server.py"
  cp "$MIROFISH_LIB_SH" "$dir/deploy/production/mirofish-runtime.sh"
  printf '#!/usr/bin/env bash\n# fixture stand-in, never executed by this transaction-level test.\nexit 0\n' >"$dir/deploy/production/prepare-mirofish.sh"
  chmod 0755 "$dir/deploy/production/prepare-mirofish.sh"
  # Task 5 (app-controls, fix round 1): deploy.sh's own stage_unit() now
  # owns this file -- minimal but genuinely valid (passes a REAL
  # `systemd-analyze verify` where available, e.g. GitHub's ubuntu-latest
  # runner; no Requires=/ExecStart path this fixture doesn't also satisfy).
  cat >"$dir/ai-trading-control.service" <<'EOF'
[Unit]
Description=fixture unit, not real production content
[Service]
Type=simple
ExecStart=/bin/true
[Install]
WantedBy=multi-user.target
EOF
}

# install_fake_systemctl BASE: a systemctl() shim logging every call to
# $BASE/systemctl.log, reporting "not active"/"not enabled" (so
# stage_unit's own prior-state capture always sees a genuinely first
# activation by default) and success otherwise -- exported so a child
# `bash "$DEPLOY_SH"` process inherits it. Real systemctl is NEVER invoked
# by these tests (root/systemd changes stay offline-fake only).
# shellcheck disable=SC2329
install_fake_systemctl() {
  local base="$1"
  # shellcheck disable=SC2317
  systemctl() {
    echo "fake systemctl $*" >>"$FAKE_SYSTEMCTL_LOG_BASE/systemctl.log"
    case "${1:-}" in
      is-active | is-enabled) return 1 ;;
      *) return 0 ;;
    esac
  }
  export -f systemctl
  FAKE_SYSTEMCTL_LOG_BASE="$base"
  export FAKE_SYSTEMCTL_LOG_BASE
}

# seed_control_state DIR: a valid, already-"adopted" control.json + lock
# file at DIR, standing in for install.sh's own first-run initialization --
# deploy.sh itself never (re-)initializes this file, so every scenario that
# reaches the real main flow (process-level `bash "$DEPLOY_SH"` cases) needs
# one already present before it runs, exactly as install.sh guarantees in
# production.
seed_control_state() {
  local dir="$1"
  install -d -m 0700 "$dir"
  cat >"$dir/control.json" <<'EOF'
{"schemaVersion":1,"revision":0,"desired":{"tradingagents":true,"ai-hedge-fund":true,"vibe-trading":true,"mirofish":false},"results":{"tradingagents":null,"ai-hedge-fund":null,"vibe-trading":null,"mirofish":null},"lastChange":null,"operation":null}
EOF
  chmod 0600 "$dir/control.json"
}

# new_scratch NAME: a fresh, isolated APP_DIR/SECRETS_DIR/ENV_STAGING_DIR/
# APP_CONFIG_STAGING_DIR/control-state quintuple under $TEST_ROOT for one
# scenario, with a fake family_config.py already installed alongside
# deploy.sh's expected path ($APP_DIR/family_config.py), a default-valid
# config staging dir, and an already-seeded control-state directory (only
# the process-level `bash "$DEPLOY_SH"` cases below actually point
# AI_TRADING_STATE_DIR at it -- harmless for every other scenario).
new_scratch() {
  local name="$1" base="$TEST_ROOT/$1"
  mkdir -p "$base/app" "$base/secrets" "$base/ci-staging" "$base/config-staging" "$base/unit-dir"
  fake_family_config "$base/app/family_config.py"
  stage_default_configs "$base/config-staging"
  seed_control_state "$base/control-state"
  printf '%s\n' "$base"
}

# run_scenario NAME [IMAGE_TAG]: sources the lib (re-validating IMAGE_TAG)
# and calls render_profiles + stage_secrets + stage_configs (A10a) in one
# subshell, isolated per scenario so each gets its own EXIT trap /
# RENDER_SRC_DIR / PRIOR_EXISTED / CONFIG_PRIOR_EXISTED state. IMAGE_TAG
# defaults to the all-zero fixture tag every existing case already expects;
# a case probing rollback's own image-tag precedence passes a distinct one.
# Prints the resolved exit status on stdout as the final line.
run_scenario() {
  local base="$1" tag="${2:-0000000000000000000000000000000000000000}"
  (
    APP_DIR="$base/app"
    AI_TRADING_SECRETS_DIR="$base/secrets"
    ENV_STAGING_DIR="$base/ci-staging"
    APP_CONFIG_STAGING_DIR="$base/config-staging"
    FAMILY_CONFIG_CREDENTIALS="$base/fake-reader-key.json"
    DEPLOY_SH_SKIP_CHOWN=1
    IMAGE_TAG="$tag"
    export APP_DIR AI_TRADING_SECRETS_DIR ENV_STAGING_DIR APP_CONFIG_STAGING_DIR FAMILY_CONFIG_CREDENTIALS DEPLOY_SH_SKIP_CHOWN IMAGE_TAG
    # shellcheck source=/dev/null
    source "$LIB_FILE"
    # Fix round 1: stage_configs() now runs `docker compose ... config
    # --quiet` against the staged Compose files (review's required Compose
    # preflight). Most scenarios here are not testing Compose *parsing*
    # itself (a dedicated real-docker case below is), so default to a no-op
    # "compose always succeeds" fake -- never require live Docker for every
    # scenario. Only define it if the caller hasn't already provided its own
    # `docker` (e.g. Case 48's tag-logging fake, wrapped around this call).
    if ! declare -f docker >/dev/null 2>&1; then
      # shellcheck disable=SC2329
      docker() {
        [[ "${1:-}" == compose ]] && return 0
        command docker "$@"
      }
    fi
    render_profiles
    stage_secrets
    stage_configs
  )
  echo "$?"
}

# run_scenario_mirofish NAME: like run_scenario, but also calls
# activate_mirofish() in the same order main flow uses --
# render_profiles, activate_mirofish, stage_secrets (A9b's opt-in MiroFish
# activation path) -- and additionally sets AI_TRADING_RUNTIME_ENV_DIR to an
# isolated scratch dir under $base, and writes the resolved COMPOSE_PROFILES
# (or the literal string "unset") to $base/compose-profiles.out so a case
# can assert it without parsing deploy.sh's own stdout/stderr. Inherits
# MIROFISH_ACTIVATE/FAKE_FC_MISSING_PROFILE from the caller's exported
# environment, same as run_scenario already does for its own test-only
# knobs. The `|| true` mirrors main flow exactly: a failed/absent MiroFish
# activation must never fail the rest of this scenario.
#
# TEST_CHMOD_RUNTIME_DIR_AFTER_ACTIVATE (test-only, this file's own knob,
# never read by deploy.sh itself): if set, chmod's AI_TRADING_RUNTIME_ENV_DIR
# to that mode right after activate_mirofish returns, before stage_secrets
# runs -- used to inject a *real* later restore/remove failure (review P2)
# into restore_or_remove_mirofish() without a fake knob inside deploy.sh
# itself. Deliberately injected here, inside this already-proven function
# wrapper, rather than in a second hand-rolled top-level `( ... )`: a bare
# top-level subshell whose own first statement is `cmd || true` was found,
# empirically, to stop propagating a later command's failure to a `trap ...
# ERR` armed further down in that same subshell (not true when the same
# body runs as a function's body called normally, as this one is) -- a bash
# quirk, not a deploy.sh bug; routing every scenario through this one
# function avoids it entirely.
run_scenario_mirofish() {
  local base="$1"
  (
    APP_DIR="$base/app"
    AI_TRADING_SECRETS_DIR="$base/secrets"
    ENV_STAGING_DIR="$base/ci-staging"
    APP_CONFIG_STAGING_DIR="$base/config-staging"
    AI_TRADING_RUNTIME_ENV_DIR="$base/runtime"
    FAMILY_CONFIG_CREDENTIALS="$base/fake-reader-key.json"
    DEPLOY_SH_SKIP_CHOWN=1
    IMAGE_TAG=0000000000000000000000000000000000000000
    export APP_DIR AI_TRADING_SECRETS_DIR ENV_STAGING_DIR APP_CONFIG_STAGING_DIR AI_TRADING_RUNTIME_ENV_DIR FAMILY_CONFIG_CREDENTIALS DEPLOY_SH_SKIP_CHOWN IMAGE_TAG
    # shellcheck source=/dev/null
    source "$LIB_FILE"
    # Same reasoning and guard as run_scenario's own default fake above --
    # only define it if the caller hasn't already (e.g. run_keep_scenario's
    # own `docker` fake for MIROFISH_ACTIVATE=keep's `compose ps` check,
    # which this must never clobber).
    if ! declare -f docker >/dev/null 2>&1; then
      # shellcheck disable=SC2329
      docker() {
        [[ "${1:-}" == compose ]] && return 0
        command docker "$@"
      }
    fi
    render_profiles
    activate_mirofish || true
    if [[ -n "${TEST_CHMOD_RUNTIME_DIR_AFTER_ACTIVATE:-}" ]]; then
      chmod "$TEST_CHMOD_RUNTIME_DIR_AFTER_ACTIVATE" "$AI_TRADING_RUNTIME_ENV_DIR"
    fi
    stage_secrets
    stage_configs
    printf '%s\n' "${COMPOSE_PROFILES:-unset}" >"$base/compose-profiles.out"
  )
  echo "$?"
}

echo "=== Case 1 (GREEN): first-time deploy, cloudflared.env staged by CI, four profiles rendered VPS-side ==="
CASE_COUNT=$((CASE_COUNT + 1))
s1="$(new_scratch case1)"
printf 'TUNNEL_TOKEN=fake-tunnel-token\n' >"$s1/ci-staging/cloudflared.env"
status="$(run_scenario "$s1")"
if [[ "$status" != 0 ]]; then
  fail "case1: expected exit 0, got $status"
else
  # GNU stat -f prints filesystem data before failing; try -c first, then BSD -f.
  for name in tradingagents.env ai-hedge-fund.env vibe-trading.env vibe-gateway.env vibe-consensus.env auth.env market-data.env market-data-bridge.env cloudflared.env; do
    f="$s1/secrets/$name"
    [[ -f "$f" ]] || { fail "case1: missing $f"; continue; }
    [[ "$(stat -c '%a' "$f" 2>/dev/null || stat -f '%Lp' "$f" 2>/dev/null)" == 600 ]] || fail "case1: $f not mode 600"
  done
  grep -q 'fake-not-real-gateway' "$s1/secrets/auth.env" 2>/dev/null || fail "case1: auth.env missing renamed gateway content"
  [[ -f "$s1/secrets/gateway.env" ]] && fail "case1: gateway.env should have been renamed to auth.env, not left behind"
  grep -q 'fake-tunnel-token' "$s1/secrets/cloudflared.env" 2>/dev/null || fail "case1: cloudflared.env content mismatch"
  grep -q 'fake-not-real-market-data-bridge' "$s1/secrets/market-data-bridge.env" 2>/dev/null || fail "case1: market-data-bridge.env missing its rendered profile"
  # The gateway (Caddy) gets only Vibe's API key, never Vibe's provider keys.
  [[ "$(cat "$s1/secrets/vibe-gateway.env" 2>/dev/null)" == 'VIBE_API_AUTH_KEY=fake-vibe-key-not-real' ]] || fail "case1: vibe-gateway.env must hold exactly VIBE_API_AUTH_KEY"
  ! grep -q '^FINNHUB_API_KEY=' "$s1/secrets/vibe-consensus.env" || fail "case1: optional Finnhub key should be absent"
  shopt -s nullglob
  leftover=("$s1/secrets"/.render-*)
  shopt -u nullglob
  [[ ${#leftover[@]} -eq 0 ]] || fail "case1: root-only render scratch not cleaned: ${leftover[*]}"
fi
echo "    exit=$status"

echo "=== Case 1b (GREEN): optional consensus profile is isolated from market-data and Vibe ==="
CASE_COUNT=$((CASE_COUNT + 1))
s_consensus="$(new_scratch case_consensus)"
printf 'TUNNEL_TOKEN=fake-tunnel-token\n' >"$s_consensus/ci-staging/cloudflared.env"
status="$(FAKE_FC_FINNHUB_KEY=1 run_scenario "$s_consensus")"
[[ "$status" == 0 ]] || fail "consensus render expected success, got $status"
grep -qx 'FINNHUB_API_KEY=fake-test-value' "$s_consensus/secrets/vibe-consensus.env" || fail "consensus key not isolated"
! grep -Eq 'ALPACA|OPENAI|ANTHROPIC|VIBE_API_AUTH_KEY' "$s_consensus/secrets/vibe-consensus.env" || fail "consensus file contains another secret"
! grep -q '^FINNHUB_API_KEY=' "$s_consensus/secrets/market-data.env" || fail "Finnhub key leaked into market-data"
! grep -q '^FINNHUB_API_KEY=' "$s_consensus/secrets/vibe-trading.env" || fail "Finnhub key leaked into Vibe"
[[ "$(stat -c '%a' "$s_consensus/secrets/vibe-consensus.env" 2>/dev/null || stat -f '%Lp' "$s_consensus/secrets/vibe-consensus.env" 2>/dev/null)" == 600 ]] || fail "consensus env mode is not 0600"

echo "=== Case 1c (RED->rollback): prior consensus secret restored or first-time file removed ==="
CASE_COUNT=$((CASE_COUNT + 1))
s_consensus_rollback="$(new_scratch case_consensus_rollback)"
printf 'TUNNEL_TOKEN=fake-tunnel-token\n' >"$s_consensus_rollback/ci-staging/cloudflared.env"
printf 'OLD_VALUE=prior-consensus\n' >"$s_consensus_rollback/secrets/vibe-consensus.env"
chmod 0600 "$s_consensus_rollback/secrets/vibe-consensus.env"
export DEPLOY_SH_FAIL_AFTER=vibe-consensus.env
status="$(FAKE_FC_FINNHUB_KEY=1 run_scenario "$s_consensus_rollback")"
unset DEPLOY_SH_FAIL_AFTER
[[ "$status" != 0 ]] || fail "consensus rollback injection unexpectedly passed"
grep -qx 'OLD_VALUE=prior-consensus' "$s_consensus_rollback/secrets/vibe-consensus.env" || fail "prior consensus secret not restored"
s_consensus_first="$(new_scratch case_consensus_first)"
printf 'TUNNEL_TOKEN=fake-tunnel-token\n' >"$s_consensus_first/ci-staging/cloudflared.env"
export DEPLOY_SH_FAIL_AFTER=vibe-consensus.env
status="$(FAKE_FC_FINNHUB_KEY=1 run_scenario "$s_consensus_first")"
unset DEPLOY_SH_FAIL_AFTER
[[ "$status" != 0 && ! -e "$s_consensus_first/secrets/vibe-consensus.env" ]] || fail "new consensus secret survived rollback"

echo "=== Case 1d (GREEN): missing optional market-data-bridge profile never fails the deploy ==="
CASE_COUNT=$((CASE_COUNT + 1))
s_bridge="$(new_scratch case_bridge_missing)"
printf 'TUNNEL_TOKEN=fake-tunnel-token\n' >"$s_bridge/ci-staging/cloudflared.env"
status="$(FAKE_FC_MISSING_PROFILE=ai-trading/market-data-bridge run_scenario "$s_bridge" 2>"$s_bridge/stderr.out")"
[[ "$status" == 0 ]] || fail "case1d: missing bridge profile must not fail the deploy, got $status"
[[ -f "$s_bridge/secrets/market-data-bridge.env" ]] || fail "case1d: placeholder market-data-bridge.env not installed"
! grep -Eq 'TOKEN|FAKE_VALUE|ALPACA' "$s_bridge/secrets/market-data-bridge.env" || fail "case1d: placeholder must hold no key or value"
grep -q 'market-data-bridge profile not available' "$s_bridge/stderr.out" || fail "case1d: the missing profile must be logged"
for name in tradingagents.env ai-hedge-fund.env vibe-trading.env auth.env market-data.env cloudflared.env; do
  [[ -f "$s_bridge/secrets/$name" ]] || fail "case1d: other app secret $name must still be installed"
done
[[ "$(stat -c '%a' "$s_bridge/secrets/market-data-bridge.env" 2>/dev/null || stat -f '%Lp' "$s_bridge/secrets/market-data-bridge.env" 2>/dev/null)" == 600 ]] || fail "case1d: bridge env mode is not 0600"
# The bridge's names never reach another app's env file.
! grep -rEq 'MARKET_DATA_BRIDGE' "$s_bridge/secrets" || fail "case1d: bridge token names leaked into another env file"

echo "=== Case 2 (GREEN): redeploy over existing secrets -- new content wins, old content backed up to .previous/ ==="
CASE_COUNT=$((CASE_COUNT + 1))
s2="$(new_scratch case2)"
printf 'TUNNEL_TOKEN=fake-tunnel-token-v2\n' >"$s2/ci-staging/cloudflared.env"
for name in tradingagents.env ai-hedge-fund.env vibe-trading.env vibe-gateway.env auth.env cloudflared.env; do
  printf 'OLD_VALUE=old-%s\n' "$name" >"$s2/secrets/$name"
  chmod 0600 "$s2/secrets/$name"
done
status="$(run_scenario "$s2")"
if [[ "$status" != 0 ]]; then
  fail "case2: expected exit 0, got $status"
else
  grep -q 'fake-not-real-tradingagents' "$s2/secrets/tradingagents.env" 2>/dev/null || fail "case2: tradingagents.env not refreshed"
  grep -q 'fake-tunnel-token-v2' "$s2/secrets/cloudflared.env" 2>/dev/null || fail "case2: cloudflared.env not refreshed"
  grep -q 'old-tradingagents.env' "$s2/secrets/.previous/tradingagents.env" 2>/dev/null || fail "case2: .previous backup missing old content"
fi
echo "    exit=$status"

echo "=== Case 3 (RED): missing Firestore profile fails before any install, no partial files, scratch still cleaned ==="
CASE_COUNT=$((CASE_COUNT + 1))
s3="$(new_scratch case3)"
printf 'TUNNEL_TOKEN=fake-tunnel-token\n' >"$s3/ci-staging/cloudflared.env"
export FAKE_FC_MISSING_PROFILE="ai-trading/ai-hedge-fund"
status="$(run_scenario "$s3")"
unset FAKE_FC_MISSING_PROFILE
if [[ "$status" == 0 ]]; then
  fail "case3: expected non-zero exit for a missing profile, got 0"
fi
shopt -s nullglob
installed=("$s3/secrets"/*.env)
leftover=("$s3/secrets"/.render-*)
shopt -u nullglob
[[ ${#installed[@]} -eq 0 ]] || fail "case3: files installed despite missing-profile failure: ${installed[*]}"
[[ ${#leftover[@]} -eq 0 ]] || fail "case3: root-only render scratch not cleaned after render failure: ${leftover[*]}"
echo "    exit=$status"

echo "=== Case 4 (RED): bad CI-staged cloudflared.env (CR byte) fails validation before any install ==="
CASE_COUNT=$((CASE_COUNT + 1))
s4="$(new_scratch case4)"
printf 'TUNNEL_TOKEN=bad\r\n' >"$s4/ci-staging/cloudflared.env"
status="$(run_scenario "$s4")"
if [[ "$status" == 0 ]]; then
  fail "case4: expected non-zero exit for a CR byte in staged cloudflared.env, got 0"
fi
shopt -s nullglob
installed=("$s4/secrets"/*.env)
leftover=("$s4/secrets"/.render-*)
shopt -u nullglob
[[ ${#installed[@]} -eq 0 ]] || fail "case4: files installed despite a validation failure: ${installed[*]}"
[[ ${#leftover[@]} -eq 0 ]] || fail "case4: root-only render scratch not cleaned after a validation failure: ${leftover[*]}"
echo "    exit=$status"

echo "=== Case 5 (RED->rollback): mid-stage install failure on a pre-existing deploy restores every prior file ==="
CASE_COUNT=$((CASE_COUNT + 1))
s5="$(new_scratch case5)"
printf 'TUNNEL_TOKEN=fake-tunnel-token\n' >"$s5/ci-staging/cloudflared.env"
for name in tradingagents.env ai-hedge-fund.env vibe-trading.env vibe-gateway.env auth.env cloudflared.env; do
  printf 'OLD_VALUE=old-%s\n' "$name" >"$s5/secrets/$name"
  chmod 0600 "$s5/secrets/$name"
done
export DEPLOY_SH_FAIL_AFTER="vibe-trading.env"
status="$(run_scenario "$s5")"
unset DEPLOY_SH_FAIL_AFTER
if [[ "$status" == 0 ]]; then
  fail "case5: expected non-zero exit for a forced mid-stage failure, got 0"
fi
for name in tradingagents.env ai-hedge-fund.env vibe-trading.env vibe-gateway.env auth.env cloudflared.env; do
  grep -q "old-$name" "$s5/secrets/$name" 2>/dev/null || fail "case5: $name not restored to its prior content after rollback"
done
shopt -s nullglob
leftover=("$s5/secrets"/.render-*)
shopt -u nullglob
[[ ${#leftover[@]} -eq 0 ]] || fail "case5: root-only render scratch not cleaned after rollback: ${leftover[*]}"
echo "    exit=$status"

echo "=== Case 6 (RED->rollback): mid-stage failure on a first-time deploy deletes what was just created, leaves nothing partial ==="
CASE_COUNT=$((CASE_COUNT + 1))
s6="$(new_scratch case6)"
printf 'TUNNEL_TOKEN=fake-tunnel-token\n' >"$s6/ci-staging/cloudflared.env"
export DEPLOY_SH_FAIL_AFTER="auth.env"
status="$(run_scenario "$s6")"
unset DEPLOY_SH_FAIL_AFTER
if [[ "$status" == 0 ]]; then
  fail "case6: expected non-zero exit for a forced mid-stage failure, got 0"
fi
shopt -s nullglob
leftover_secrets=("$s6/secrets"/*.env)
leftover_render=("$s6/secrets"/.render-*)
shopt -u nullglob
[[ ${#leftover_secrets[@]} -eq 0 ]] || fail "case6: first-time secret files left behind after rollback: ${leftover_secrets[*]}"
[[ ${#leftover_render[@]} -eq 0 ]] || fail "case6: root-only render scratch not cleaned after rollback: ${leftover_render[*]}"
echo "    exit=$status"

echo "=== Case 7 (GREEN): 'docker compose config' resolves the real production/mirofish compose files against case1's staged auth.env, no real keys ==="
CASE_COUNT=$((CASE_COUNT + 1))
if ! docker compose version >/dev/null 2>&1; then
  echo "    SKIP: docker compose not available in this environment"
else
  compose_out="$TEST_ROOT/case7-config.json"
  if AI_TRADING_IMAGE_TAG=0000000000000000000000000000000000000000 \
     AI_TRADING_SECRETS_DIR="$s1/secrets" \
      docker compose --project-name ai-trading -f "$COMPOSE_FILE" -f "$MIROFISH_COMPOSE_FILE" config --format json \
        >"$compose_out" 2>"$TEST_ROOT/case7-config.err"; then
    grep -q '0000000000000000000000000000000000000000' "$compose_out" || fail "case7: compose config output missing the fake image tag"
    python3 - "$compose_out" <<'PY' || fail 'case7: cloudflared must reach upstream networks through Caddy only'
import json, sys
services = json.load(open(sys.argv[1]))['services']
upstream_networks = {'ta', 'ahf', 'vibe', 'mirofish'}
assert upstream_networks <= set(services['gateway']['networks'])
assert not upstream_networks & set(services['cloudflared']['networks'])
PY
  else
    fail "case7: docker compose config failed: $(cat "$TEST_ROOT/case7-config.err")"
  fi
fi

echo "=== Case 8 (RED, process-level): the real deploy.sh, unsourced, fails closed before Docker/secrets when CI never set ENV_STAGING_DIR ==="
CASE_COUNT=$((CASE_COUNT + 1))
s8="$(new_scratch case8)"
status8=0
# Under `set -e`, a bare `( ... )` whose exit status we only read afterward
# would abort the whole test script on this case's *expected* non-zero exit
# -- the `||` below is what keeps that failure "checked" instead.
(
  APP_DIR="$s8/app"
  AI_TRADING_SECRETS_DIR="$s8/secrets"
  FAMILY_CONFIG_CREDENTIALS="$s8/fake-reader-key.json"
  DEPLOY_SH_SKIP_CHOWN=1
  IMAGE_TAG=0000000000000000000000000000000000000000
  unset ENV_STAGING_DIR
  export APP_DIR AI_TRADING_SECRETS_DIR FAMILY_CONFIG_CREDENTIALS DEPLOY_SH_SKIP_CHOWN IMAGE_TAG
  bash "$DEPLOY_SH" >"$s8/stdout.log" 2>"$s8/stderr.log"
) || status8=$?
if [[ "$status8" == 0 ]]; then
  fail "case8: expected non-zero exit when ENV_STAGING_DIR is unset, got 0"
fi
grep -q 'ENV_STAGING_DIR is required' "$s8/stderr.log" 2>/dev/null || fail "case8: missing the required-ENV_STAGING_DIR message: $(cat "$s8/stderr.log" 2>/dev/null)"
shopt -s nullglob
leftover=("$s8/secrets"/*)
shopt -u nullglob
[[ ${#leftover[@]} -eq 0 ]] || fail "case8: a file was created in \$SECRETS_DIR despite failing closed: ${leftover[*]}"
[[ -f "$s8/app/last-good-tag" ]] && fail "case8: last-good-tag written despite failing closed"
echo "    exit=$status8"

echo "=== Case 9 (GREEN, process-level): the real deploy.sh, unsourced, runs end-to-end with a fake Docker and fake root ownership ==="
CASE_COUNT=$((CASE_COUNT + 1))
s9="$(new_scratch case9)"
printf 'TUNNEL_TOKEN=fake-tunnel-token\n' >"$s9/ci-staging/cloudflared.env"
# Health-check.sh is now one of the four CONFIG_FILES stage_configs()
# installs from APP_CONFIG_STAGING_DIR (A10a) -- stage it there, not
# directly into $APP_DIR, so this case's injected health logic survives.
cat >"$s9/config-staging/health-check.sh" <<'HEALTH_EOF'
#!/usr/bin/env bash
exit 0
HEALTH_EOF
chmod +x "$s9/config-staging/health-check.sh"
status9=0
(
  APP_DIR="$s9/app"
  AI_TRADING_SECRETS_DIR="$s9/secrets"
  ENV_STAGING_DIR="$s9/ci-staging"
  APP_CONFIG_STAGING_DIR="$s9/config-staging"
  AI_TRADING_STATE_DIR="$s9/control-state"
  AI_TRADING_UNIT_DIR="$s9/unit-dir"
  FAMILY_CONFIG_CREDENTIALS="$s9/fake-reader-key.json"
  DEPLOY_SH_SKIP_CHOWN=1
  IMAGE_TAG=1111111111111111111111111111111111111111
  export APP_DIR AI_TRADING_SECRETS_DIR ENV_STAGING_DIR APP_CONFIG_STAGING_DIR AI_TRADING_STATE_DIR AI_TRADING_UNIT_DIR FAMILY_CONFIG_CREDENTIALS DEPLOY_SH_SKIP_CHOWN IMAGE_TAG

  # Fake docker: deploy.sh only ever shells out to `docker compose ...`; no
  # real Docker daemon is contacted anywhere in this case. An exported bash
  # function shim is inherited by the `bash "$DEPLOY_SH"` child process
  # below and takes priority over any real `docker` on PATH. shellcheck
  # cannot see that indirect call (it only analyzes this file, not the child
  # process deploy.sh starts), so it looks unused here -- it is not.
  # shellcheck disable=SC2329
  docker() {
    if [[ "${1:-}" == compose ]]; then
      echo "fake docker $*" >>"$APP_DIR/docker.log"
      return 0
    fi
    # mirofish_container_ids' real-evidence query: no owned container in
    # this scenario (MIROFISH_ACTIVATE is unset).
    if [[ "${1:-}" == ps ]]; then
      return 0
    fi
    # prune_old_images must never reach a real daemon (or its images).
    if [[ "${1:-}" == images || "${1:-}" == rmi ]]; then
      return 0
    fi
    command docker "$@"
  }
  export -f docker
  install_fake_systemctl "$s9"

  # Fake stat: deploy.sh's post-stage check asks for owner:mode as a GNU
  # `stat -c '%u:%a'` string, which does not exist on this BSD/macOS test
  # machine, and whose *owner* half no non-root test process could ever
  # satisfy anyway -- DEPLOY_SH_SKIP_CHOWN (already test-only, documented at
  # the top of deploy.sh) only skips the chown step, it does not make this
  # process root. This shim reports a fake uid 0 but computes the file's
  # *real* mode through the platform's real stat, so an actual wrong-mode
  # bug is still caught here -- only "owned by root" is faked. Same
  # indirect-call blind spot as the docker shim above.
  # shellcheck disable=SC2329
  stat() {
    if [[ "${1:-}" == -c && "${2:-}" == '%u:%a' ]]; then
      local mode
      mode="$(command stat -c '%a' "$3" 2>/dev/null || command stat -f '%Lp' "$3" 2>/dev/null)"
      printf '0:%s\n' "$mode"
    else
      command stat "$@"
    fi
  }
  export -f stat

  bash "$DEPLOY_SH" >"$s9/stdout.log" 2>"$s9/stderr.log"
) || status9=$?
if [[ "$status9" != 0 ]]; then
  fail "case9: expected exit 0, got $status9: $(cat "$s9/stderr.log" 2>/dev/null)"
else
  [[ -f "$s9/app/last-good-tag" ]] || fail "case9: last-good-tag not written"
  [[ "$(cat "$s9/app/last-good-tag" 2>/dev/null)" == "1111111111111111111111111111111111111111" ]] \
    || fail "case9: last-good-tag has the wrong content"
  # compose()'s own args (--project-name, --env-file, -f ...) sit between
  # "compose" and its subcommand, so match each call's trailing subcommand
  # word instead of a "compose pull"/"compose up" substring that never
  # appears contiguously in the logged command line.
  grep -q 'pull$' "$s9/app/docker.log" 2>/dev/null || fail "case9: fake docker never saw a 'compose ... pull' call"
  grep -q 'up -d' "$s9/app/docker.log" 2>/dev/null || fail "case9: fake docker never saw a 'compose ... up' call"
  for name in tradingagents.env ai-hedge-fund.env vibe-trading.env vibe-gateway.env auth.env cloudflared.env; do
    f="$s9/secrets/$name"
    [[ -f "$f" ]] || { fail "case9: missing $f"; continue; }
    real_mode="$(stat -c '%a' "$f" 2>/dev/null || stat -f '%Lp' "$f" 2>/dev/null)"
    [[ "$real_mode" == "600" ]] || fail "case9: $f's real mode is $real_mode, not 600"
  done
  grep -q 'fake-not-real-gateway' "$s9/secrets/auth.env" 2>/dev/null || fail "case9: auth.env missing renamed gateway content"
fi
echo "    exit=$status9"

echo "=== Case 10 (GREEN): MiroFish opt-in path, A9b -- default disabled (MIROFISH_ACTIVATE unset), other apps unaffected ==="
CASE_COUNT=$((CASE_COUNT + 1))
s10="$(new_scratch case10)"
printf 'TUNNEL_TOKEN=fake-tunnel-token\n' >"$s10/ci-staging/cloudflared.env"
status="$(run_scenario_mirofish "$s10")"
if [[ "$status" != 0 ]]; then
  fail "case10: expected exit 0, got $status"
else
  [[ "$(cat "$s10/compose-profiles.out" 2>/dev/null)" == unset ]] || fail "case10: COMPOSE_PROFILES should stay unset when MIROFISH_ACTIVATE is unset"
  [[ -e "$s10/runtime/mirofish.env" ]] && fail "case10: mirofish.env should not be created when MIROFISH_ACTIVATE is unset"
  for name in tradingagents.env ai-hedge-fund.env vibe-trading.env vibe-gateway.env auth.env cloudflared.env; do
    [[ -f "$s10/secrets/$name" ]] || fail "case10: missing $name -- default-disabled MiroFish path broke an unrelated app"
  done
fi
echo "    exit=$status"

echo "=== Case 11 (GREEN): MiroFish opt-in path, A9b -- MIROFISH_ACTIVATE=1 with a fake CLI renders mirofish.env and enables the Compose profile ==="
CASE_COUNT=$((CASE_COUNT + 1))
s11="$(new_scratch case11)"
printf 'TUNNEL_TOKEN=fake-tunnel-token\n' >"$s11/ci-staging/cloudflared.env"
export MIROFISH_ACTIVATE=1
status="$(run_scenario_mirofish "$s11")"
unset MIROFISH_ACTIVATE
if [[ "$status" != 0 ]]; then
  fail "case11: expected exit 0, got $status"
else
  [[ "$(cat "$s11/compose-profiles.out" 2>/dev/null)" == mirofish ]] || fail "case11: COMPOSE_PROFILES should be mirofish when activation succeeds"
  f="$s11/runtime/mirofish.env"
  [[ -f "$f" ]] || fail "case11: missing $f"
  [[ "$(stat -c '%a' "$f" 2>/dev/null || stat -f '%Lp' "$f" 2>/dev/null)" == "600" ]] || fail "case11: $f not mode 600"
  grep -q '^ZEP_API_KEY=' "$f" 2>/dev/null || fail "case11: mirofish.env missing ZEP_API_KEY"
  grep -q '^LLM_API_KEY=' "$f" 2>/dev/null || fail "case11: mirofish.env missing LLM_API_KEY"
  shopt -s nullglob
  leftover=("$s11/runtime"/.mirofish-render-*)
  shopt -u nullglob
  [[ ${#leftover[@]} -eq 0 ]] || fail "case11: root-only mirofish render scratch not cleaned: ${leftover[*]}"
  for name in tradingagents.env ai-hedge-fund.env vibe-trading.env vibe-gateway.env auth.env cloudflared.env; do
    [[ -f "$s11/secrets/$name" ]] || fail "case11: missing $name"
  done
fi
echo "    exit=$status"

echo "=== Case 12 (GREEN overall, RED for MiroFish only): A9b -- missing ai-trading/mirofish profile leaves MiroFish disabled but never fails the other three apps' deploy ==="
CASE_COUNT=$((CASE_COUNT + 1))
s12="$(new_scratch case12)"
printf 'TUNNEL_TOKEN=fake-tunnel-token\n' >"$s12/ci-staging/cloudflared.env"
export MIROFISH_ACTIVATE=1
export FAKE_FC_MISSING_PROFILE="ai-trading/mirofish"
status="$(run_scenario_mirofish "$s12")"
unset MIROFISH_ACTIVATE FAKE_FC_MISSING_PROFILE
if [[ "$status" != 0 ]]; then
  fail "case12: expected overall exit 0 (a MiroFish activation failure must not fail the deploy), got $status"
else
  [[ "$(cat "$s12/compose-profiles.out" 2>/dev/null)" == unset ]] || fail "case12: COMPOSE_PROFILES should stay unset when the ai-trading/mirofish profile is missing"
  [[ -e "$s12/runtime/mirofish.env" ]] && fail "case12: mirofish.env should not exist after a missing-profile activation failure"
  shopt -s nullglob
  leftover=("$s12/runtime"/.mirofish-render-*)
  shopt -u nullglob
  [[ ${#leftover[@]} -eq 0 ]] || fail "case12: root-only mirofish render scratch not cleaned after a render failure: ${leftover[*]}"
  for name in tradingagents.env ai-hedge-fund.env vibe-trading.env vibe-gateway.env auth.env cloudflared.env; do
    [[ -f "$s12/secrets/$name" ]] || fail "case12: missing $name -- a MiroFish activation failure broke an unrelated app's deploy"
  done
fi
echo "    exit=$status"

echo "=== Case 13 (GREEN): 'docker compose ... config --quiet' with MiroFish's profile OFF (no mirofish.env, no COMPOSE_PROFILES) -- brief Task 9 Step 3 ==="
CASE_COUNT=$((CASE_COUNT + 1))
if ! docker compose version >/dev/null 2>&1; then
  echo "    SKIP: docker compose not available in this environment"
else
  if AI_TRADING_IMAGE_TAG=0000000000000000000000000000000000000000 \
     AI_TRADING_SECRETS_DIR="$s1/secrets" \
     AI_TRADING_RUNTIME_ENV_DIR="$TEST_ROOT/case13-runtime-absent" \
     docker compose --project-name ai-trading -f "$COMPOSE_FILE" -f "$MIROFISH_COMPOSE_FILE" config --quiet \
       >"$TEST_ROOT/case13.out" 2>"$TEST_ROOT/case13.err"; then
    :
  else
    fail "case13: docker compose config --quiet (profile off) failed: $(cat "$TEST_ROOT/case13.err")"
  fi
fi
echo "    (profile off checked)"

echo "=== Case 14 (GREEN): 'docker compose ... config --quiet' with MiroFish's profile ON and a fake mirofish.env outside the repo -- brief Task 9 Step 3 ==="
CASE_COUNT=$((CASE_COUNT + 1))
if ! docker compose version >/dev/null 2>&1; then
  echo "    SKIP: docker compose not available in this environment"
else
  runtime14="$TEST_ROOT/case14-runtime"
  mkdir -p "$runtime14"
  printf 'ZEP_API_KEY=fake-zep-not-real\nLLM_API_KEY=fake-llm-not-real\n' >"$runtime14/mirofish.env"
  chmod 0600 "$runtime14/mirofish.env"
  if COMPOSE_PROFILES=mirofish \
     AI_TRADING_IMAGE_TAG=0000000000000000000000000000000000000000 \
     AI_TRADING_SECRETS_DIR="$s1/secrets" \
     AI_TRADING_RUNTIME_ENV_DIR="$runtime14" \
     docker compose --project-name ai-trading -f "$COMPOSE_FILE" -f "$MIROFISH_COMPOSE_FILE" config --quiet \
       >"$TEST_ROOT/case14.out" 2>"$TEST_ROOT/case14.err"; then
    :
  else
    fail "case14: docker compose config --quiet (profile on) failed: $(cat "$TEST_ROOT/case14.err")"
  fi
fi
echo "    (profile on checked)"

echo "=== Case 15 (GREEN): health-check mirofish_enabled() -- disabled purely on COMPOSE_PROFILES being unset; no compose/docker call happens at all (review P1 round 2: container state is service_ok's job, not mirofish_enabled's) ==="
CASE_COUNT=$((CASE_COUNT + 1))
result15="$(
  unset COMPOSE_PROFILES
  # shellcheck source=/dev/null
  source "$HEALTH_LIB_FILE"
  mirofish_enabled && echo ENABLED || echo DISABLED
)"
[[ "$result15" == DISABLED ]] || fail "case15: expected DISABLED, got $result15"
echo "    result=$result15"

echo "=== Case 16 (GREEN, review P1 round 2 regression test): COMPOSE_PROFILES=mirofish with an EXITED mirofish container -- mirofish_enabled() still includes it, and service_ok() correctly FAILS instead of the old code silently excluding it ==="
CASE_COUNT=$((CASE_COUNT + 1))
result16="$(
  # Scoped to this command-substitution subshell only, by design.
  # shellcheck disable=SC2030,SC2031
  export COMPOSE_PROFILES=mirofish
  # shellcheck source=/dev/null
  source "$HEALTH_LIB_FILE"
  # Stub compose()/docker(): service_ok() calls them indirectly; shellcheck
  # only analyzes this file, not the sourced lib, so they look unused here.
  # shellcheck disable=SC2329
  compose() { echo fake-mirofish-container-id; }
  # shellcheck disable=SC2329
  docker() {
    if [[ "${1:-}" == inspect ]]; then
      echo exited
    else
      command docker "$@"
    fi
  }
  if mirofish_enabled; then
    service_ok mirofish && echo ENABLED-HEALTHY || echo ENABLED-FAILING
  else
    echo DISABLED
  fi
)"
[[ "$result16" == ENABLED-FAILING ]] || fail "case16: expected ENABLED-FAILING (profile set but container exited must fail service_ok, not be silently excluded), got $result16"
echo "    result=$result16"

echo "=== Case 17 (GREEN): COMPOSE_PROFILES=mirofish with a RUNNING, healthy mirofish container -- mirofish_enabled() includes it and service_ok() correctly passes ==="
CASE_COUNT=$((CASE_COUNT + 1))
result17="$(
  # Scoped to this command-substitution subshell only, by design.
  # shellcheck disable=SC2030,SC2031
  export COMPOSE_PROFILES=mirofish
  # shellcheck source=/dev/null
  source "$HEALTH_LIB_FILE"
  # shellcheck disable=SC2329
  compose() { echo fake-mirofish-container-id; }
  # shellcheck disable=SC2329
  docker() {
    if [[ "${1:-}" == inspect ]]; then
      case "${3:-}" in
        *State.Health*) echo healthy ;;
        *) echo running ;;
      esac
    else
      command docker "$@"
    fi
  }
  if mirofish_enabled; then
    service_ok mirofish && echo ENABLED-HEALTHY || echo ENABLED-FAILING
  else
    echo DISABLED
  fi
)"
[[ "$result17" == ENABLED-HEALTHY ]] || fail "case17: expected ENABLED-HEALTHY, got $result17"
echo "    result=$result17"

echo "=== Case 18 (GREEN): MIROFISH_ACTIVATE unset with an inherited COMPOSE_PROFILES=mirofish and a stale mirofish.env -- no bypass (review P1), stale file untouched, other apps deploy fine ==="
CASE_COUNT=$((CASE_COUNT + 1))
s18="$(new_scratch case18)"
printf 'TUNNEL_TOKEN=fake-tunnel-token\n' >"$s18/ci-staging/cloudflared.env"
mkdir -p "$s18/runtime"
printf 'STALE_VALUE=from-a-prior-run\n' >"$s18/runtime/mirofish.env"
chmod 0600 "$s18/runtime/mirofish.env"
# Deliberately inherited by run_scenario_mirofish's real `(...)` subshell below
# (simulating a leftover/CI export) -- unset again right after, like the other
# test-only knobs in this file.
# shellcheck disable=SC2031
export COMPOSE_PROFILES=mirofish
status="$(run_scenario_mirofish "$s18")"
unset COMPOSE_PROFILES
if [[ "$status" != 0 ]]; then
  fail "case18: expected exit 0, got $status"
else
  [[ "$(cat "$s18/compose-profiles.out" 2>/dev/null)" == unset ]] || fail "case18: an inherited COMPOSE_PROFILES=mirofish must not survive when MIROFISH_ACTIVATE is unset"
  grep -q 'STALE_VALUE=from-a-prior-run' "$s18/runtime/mirofish.env" 2>/dev/null || fail "case18: stale mirofish.env must stay untouched when MIROFISH_ACTIVATE is unset"
  for name in tradingagents.env ai-hedge-fund.env vibe-trading.env vibe-gateway.env auth.env cloudflared.env; do
    [[ -f "$s18/secrets/$name" ]] || fail "case18: missing $name"
  done
fi
echo "    exit=$status"

echo "=== Case 19 (GREEN overall): a genuine MiroFish install failure (runtime path already exists as a plain file) leaves MiroFish disabled without failing the other three apps' deploy (review P1: explicit checks, not errexit-under-||) ==="
CASE_COUNT=$((CASE_COUNT + 1))
s19="$(new_scratch case19)"
printf 'TUNNEL_TOKEN=fake-tunnel-token\n' >"$s19/ci-staging/cloudflared.env"
touch "$s19/runtime"
export MIROFISH_ACTIVATE=1
status="$(run_scenario_mirofish "$s19")"
unset MIROFISH_ACTIVATE
if [[ "$status" != 0 ]]; then
  fail "case19: expected exit 0 (an install failure must not fail the deploy), got $status"
else
  [[ "$(cat "$s19/compose-profiles.out" 2>/dev/null)" == unset ]] || fail "case19: COMPOSE_PROFILES should stay unset after an install failure"
  [[ -f "$s19/runtime" ]] || fail "case19: the pre-existing plain file at the runtime path should be left untouched, not replaced"
  for name in tradingagents.env ai-hedge-fund.env vibe-trading.env vibe-gateway.env auth.env cloudflared.env; do
    [[ -f "$s19/secrets/$name" ]] || fail "case19: missing $name -- an install failure broke an unrelated app's deploy"
  done
fi
echo "    exit=$status"

echo "=== Case 20 (RED->rollback): first-time MiroFish activation + a later stage_secrets failure REMOVES the just-installed mirofish.env (review P2: runtime env now in rollback) ==="
CASE_COUNT=$((CASE_COUNT + 1))
s20="$(new_scratch case20)"
printf 'TUNNEL_TOKEN=fake-tunnel-token\n' >"$s20/ci-staging/cloudflared.env"
for name in tradingagents.env ai-hedge-fund.env vibe-trading.env vibe-gateway.env auth.env cloudflared.env; do
  printf 'OLD_VALUE=old-%s\n' "$name" >"$s20/secrets/$name"
  chmod 0600 "$s20/secrets/$name"
done
export MIROFISH_ACTIVATE=1
export DEPLOY_SH_FAIL_AFTER="vibe-trading.env"
status="$(run_scenario_mirofish "$s20")"
unset MIROFISH_ACTIVATE DEPLOY_SH_FAIL_AFTER
if [[ "$status" == 0 ]]; then
  fail "case20: expected non-zero exit for a forced mid-stage failure, got 0"
fi
[[ -e "$s20/runtime/mirofish.env" ]] && fail "case20: mirofish.env had no prior version -- rollback should have removed it, not left it behind"
for name in tradingagents.env ai-hedge-fund.env vibe-trading.env vibe-gateway.env auth.env cloudflared.env; do
  grep -q "old-$name" "$s20/secrets/$name" 2>/dev/null || fail "case20: $name not restored to its prior content after rollback"
done
echo "    exit=$status"

echo "=== Case 21 (RED->rollback): MiroFish already active with PRIOR content; this run re-activates with NEW content, then a later stage_secrets failure RESTORES the prior mirofish.env, not the new render (review P2) ==="
CASE_COUNT=$((CASE_COUNT + 1))
s21="$(new_scratch case21)"
printf 'TUNNEL_TOKEN=fake-tunnel-token\n' >"$s21/ci-staging/cloudflared.env"
for name in tradingagents.env ai-hedge-fund.env vibe-trading.env vibe-gateway.env auth.env cloudflared.env; do
  printf 'OLD_VALUE=old-%s\n' "$name" >"$s21/secrets/$name"
  chmod 0600 "$s21/secrets/$name"
done
mkdir -p "$s21/runtime"
printf 'ZEP_API_KEY=prior-zep\nLLM_API_KEY=prior-llm\n' >"$s21/runtime/mirofish.env"
chmod 0600 "$s21/runtime/mirofish.env"
export MIROFISH_ACTIVATE=1
export DEPLOY_SH_FAIL_AFTER="vibe-trading.env"
status="$(run_scenario_mirofish "$s21")"
unset MIROFISH_ACTIVATE DEPLOY_SH_FAIL_AFTER
if [[ "$status" == 0 ]]; then
  fail "case21: expected non-zero exit for a forced mid-stage failure, got 0"
fi
grep -q 'ZEP_API_KEY=prior-zep' "$s21/runtime/mirofish.env" 2>/dev/null || fail "case21: mirofish.env not restored to its PRIOR content after rollback"
grep -q 'LLM_API_KEY=prior-llm' "$s21/runtime/mirofish.env" 2>/dev/null || fail "case21: mirofish.env not restored to its PRIOR content after rollback"
grep -q 'fake-zep-not-real' "$s21/runtime/mirofish.env" 2>/dev/null && fail "case21: mirofish.env still holds this run's NEW (fake) render after rollback"
[[ "$(stat -c '%a' "$s21/runtime/mirofish.env" 2>/dev/null || stat -f '%Lp' "$s21/runtime/mirofish.env" 2>/dev/null)" == "600" ]] || fail "case21: restored mirofish.env is not mode 600"
for name in tradingagents.env ai-hedge-fund.env vibe-trading.env vibe-gateway.env auth.env cloudflared.env; do
  grep -q "old-$name" "$s21/secrets/$name" 2>/dev/null || fail "case21: $name not restored to its prior content after rollback"
done
echo "    exit=$status"

echo "=== Case 22 (GREEN x2): MiroFish activated once, then a normal disabled redeploy over the same runtime dir still passes, stale file untouched (the exact 'later normal disabled deploy with stale file must still pass' requirement) ==="
CASE_COUNT=$((CASE_COUNT + 1))
s22="$(new_scratch case22)"
printf 'TUNNEL_TOKEN=fake-tunnel-token\n' >"$s22/ci-staging/cloudflared.env"
export MIROFISH_ACTIVATE=1
status22a="$(run_scenario_mirofish "$s22")"
unset MIROFISH_ACTIVATE
if [[ "$status22a" != 0 ]]; then
  fail "case22: first (enabled) deploy expected exit 0, got $status22a"
elif [[ "$(cat "$s22/compose-profiles.out" 2>/dev/null)" != mirofish ]]; then
  fail "case22: first (enabled) deploy should have set COMPOSE_PROFILES=mirofish"
fi
first_content="$(cat "$s22/runtime/mirofish.env" 2>/dev/null || true)"
printf 'TUNNEL_TOKEN=fake-tunnel-token-v2\n' >"$s22/ci-staging/cloudflared.env"
status22b="$(run_scenario_mirofish "$s22")"
if [[ "$status22b" != 0 ]]; then
  fail "case22: second (disabled) redeploy expected exit 0, got $status22b"
else
  [[ "$(cat "$s22/compose-profiles.out" 2>/dev/null)" == unset ]] || fail "case22: second (disabled) redeploy must not carry over COMPOSE_PROFILES=mirofish"
  [[ "$(cat "$s22/runtime/mirofish.env" 2>/dev/null)" == "$first_content" ]] || fail "case22: a disabled redeploy must not touch the stale mirofish.env from the earlier activation"
  for name in tradingagents.env ai-hedge-fund.env vibe-trading.env vibe-gateway.env auth.env cloudflared.env; do
    [[ -f "$s22/secrets/$name" ]] || fail "case22: missing $name on the disabled redeploy"
  done
fi
echo "    exit1=$status22a exit2=$status22b"

echo "=== Case 23 (RED->rollback, review P2 injected failure): restore_or_remove_mirofish's RESTORE path fails for real (runtime dir made read-only) -- rollback reports the error and leaves MiroFish disabled instead of silently claiming success ==="
CASE_COUNT=$((CASE_COUNT + 1))
s23="$(new_scratch case23)"
printf 'TUNNEL_TOKEN=fake-tunnel-token\n' >"$s23/ci-staging/cloudflared.env"
for name in tradingagents.env ai-hedge-fund.env vibe-trading.env vibe-gateway.env auth.env cloudflared.env; do
  printf 'OLD_VALUE=old-%s\n' "$name" >"$s23/secrets/$name"
  chmod 0600 "$s23/secrets/$name"
done
mkdir -p "$s23/runtime"
printf 'ZEP_API_KEY=prior-zep\nLLM_API_KEY=prior-llm\n' >"$s23/runtime/mirofish.env"
chmod 0600 "$s23/runtime/mirofish.env"
stderr23="$s23/stderr.log"
export MIROFISH_ACTIVATE=1
export DEPLOY_SH_FAIL_AFTER="vibe-trading.env"
# Make the restore path's own install_secret_file fail for real: no write
# permission on the directory it needs to mktemp a new temp file into.
# Reading the existing .previous/mirofish.env backup still works (r-x).
export TEST_CHMOD_RUNTIME_DIR_AFTER_ACTIVATE=0500
status="$(run_scenario_mirofish "$s23" 2>"$stderr23")"
unset MIROFISH_ACTIVATE DEPLOY_SH_FAIL_AFTER TEST_CHMOD_RUNTIME_DIR_AFTER_ACTIVATE
chmod 0700 "$s23/runtime" 2>/dev/null || true
if [[ "$status" == 0 ]]; then
  fail "case23: expected non-zero exit for a forced mid-stage failure, got 0"
fi
grep -q 'failed to restore .*mirofish.env' "$stderr23" 2>/dev/null || fail "case23: rollback must report the restore failure, not stay silent: $(cat "$stderr23" 2>/dev/null)"
grep -qE 'prior-(zep|llm)' "$stderr23" 2>/dev/null && fail "case23: rollback error output must never contain a key's value"
grep -q 'fake-zep-not-real' "$s23/runtime/mirofish.env" 2>/dev/null || fail "case23: a genuinely failed restore must leave the file exactly as activate_mirofish wrote it, not partially modified"
for name in tradingagents.env ai-hedge-fund.env vibe-trading.env vibe-gateway.env auth.env cloudflared.env; do
  grep -q "old-$name" "$s23/secrets/$name" 2>/dev/null || fail "case23: $name not restored to its prior content after rollback"
done
echo "    exit=$status"

echo "=== Case 24 (RED->rollback, review P2 injected failure): restore_or_remove_mirofish's REMOVE path fails for real (runtime dir made read-only) -- rollback reports the error and leaves MiroFish disabled instead of silently claiming success ==="
CASE_COUNT=$((CASE_COUNT + 1))
s24="$(new_scratch case24)"
printf 'TUNNEL_TOKEN=fake-tunnel-token\n' >"$s24/ci-staging/cloudflared.env"
for name in tradingagents.env ai-hedge-fund.env vibe-trading.env vibe-gateway.env auth.env cloudflared.env; do
  printf 'OLD_VALUE=old-%s\n' "$name" >"$s24/secrets/$name"
  chmod 0600 "$s24/secrets/$name"
done
stderr24="$s24/stderr.log"
export MIROFISH_ACTIVATE=1
export DEPLOY_SH_FAIL_AFTER="vibe-trading.env"
# Make the remove path's own `rm -f` fail for real: no write permission on
# the directory it needs to unlink mirofish.env from.
export TEST_CHMOD_RUNTIME_DIR_AFTER_ACTIVATE=0500
status="$(run_scenario_mirofish "$s24" 2>"$stderr24")"
unset MIROFISH_ACTIVATE DEPLOY_SH_FAIL_AFTER TEST_CHMOD_RUNTIME_DIR_AFTER_ACTIVATE
chmod 0700 "$s24/runtime" 2>/dev/null || true
if [[ "$status" == 0 ]]; then
  fail "case24: expected non-zero exit for a forced mid-stage failure, got 0"
fi
grep -q 'failed to remove .*mirofish.env' "$stderr24" 2>/dev/null || fail "case24: rollback must report the remove failure, not stay silent: $(cat "$stderr24" 2>/dev/null)"
[[ -f "$s24/runtime/mirofish.env" ]] || fail "case24: the file should still exist -- rm genuinely failed, it must not have vanished some other way"
for name in tradingagents.env ai-hedge-fund.env vibe-trading.env vibe-gateway.env auth.env cloudflared.env; do
  grep -q "old-$name" "$s24/secrets/$name" 2>/dev/null || fail "case24: $name not restored to its prior content after rollback"
done
echo "    exit=$status"

echo "=== Case 25 (GREEN x3, review P2 round 3 + whole-branch review reopen round 2): stop_remove_mirofish_container() -- no owned container is a silent no-op with compose() never even called; an owned container with an active config delegates to best-effort 'compose rm -s -f mirofish', both outcomes checked and reported, never raises ==="
CASE_COUNT=$((CASE_COUNT + 1))

# 25a: real Docker evidence (faked here) says nothing is owned -- success,
# and compose() (which would need a $APP_DIR/docker-compose.yml this case
# never creates) must never even be called.
err25a="$TEST_ROOT/case25a.err"
compose_called25a="$TEST_ROOT/case25a.compose-called"
result25a="$(
  IMAGE_TAG=0000000000000000000000000000000000000000
  APP_DIR="$TEST_ROOT/case25a-app"
  export IMAGE_TAG APP_DIR
  # shellcheck source=/dev/null
  source "$LIB_FILE"
  # shellcheck disable=SC2329
  docker() {
    case "$*" in
      "ps -aq --filter"*) return 0 ;;
      *) command docker "$@" ;;
    esac
  }
  # shellcheck disable=SC2329
  compose() { touch "$compose_called25a"; return 0; }
  (stop_remove_mirofish_container && echo OK || echo FAILED) 2>"$err25a"
)"
[[ "$result25a" == OK ]] || fail "case25a: expected OK when no owned container exists, got $result25a"
[[ -s "$err25a" ]] && fail "case25a: no error should be logged when nothing is owned: $(cat "$err25a")"
[[ -f "$compose_called25a" ]] && fail "case25a: compose() must never be called when no owned container exists"
echo "    result=$result25a"

# 25b/25c: an owned container exists AND the active config is present --
# delegates to compose, both outcomes.
mkdir -p "$TEST_ROOT/case25bc-app"
printf 'name: fixture\nservices: {}\n' >"$TEST_ROOT/case25bc-app/docker-compose.yml"
err25b="$TEST_ROOT/case25b.err"
result25b="$(
  IMAGE_TAG=0000000000000000000000000000000000000000
  APP_DIR="$TEST_ROOT/case25bc-app"
  export IMAGE_TAG APP_DIR
  # shellcheck source=/dev/null
  source "$LIB_FILE"
  # shellcheck disable=SC2329
  docker() {
    case "$*" in
      "ps -aq --filter"*) echo fake-mirofish-container-id ;;
      *) command docker "$@" ;;
    esac
  }
  # shellcheck disable=SC2329
  compose() { return 0; }
  (stop_remove_mirofish_container && echo OK || echo FAILED) 2>"$err25b"
)"
[[ "$result25b" == OK ]] || fail "case25b: expected OK when compose succeeds, got $result25b"
[[ -s "$err25b" ]] && fail "case25b: no error should be logged when compose succeeds: $(cat "$err25b")"
echo "    result=$result25b"

err25c="$TEST_ROOT/case25c.err"
result25c="$(
  IMAGE_TAG=0000000000000000000000000000000000000000
  APP_DIR="$TEST_ROOT/case25bc-app"
  export IMAGE_TAG APP_DIR
  # shellcheck source=/dev/null
  source "$LIB_FILE"
  # shellcheck disable=SC2329
  docker() {
    case "$*" in
      "ps -aq --filter"*) echo fake-mirofish-container-id ;;
      *) command docker "$@" ;;
    esac
  }
  # shellcheck disable=SC2329
  compose() { return 1; }
  (stop_remove_mirofish_container && echo OK || echo FAILED) 2>"$err25c"
)"
[[ "$result25c" == FAILED ]] || fail "case25c: expected FAILED when compose fails, got $result25c"
grep -q 'best-effort stop/remove' "$err25c" 2>/dev/null || fail "case25c: expected a best-effort stop/remove failure message: $(cat "$err25c" 2>/dev/null)"
echo "    result=$result25c"

echo "=== Case 25d (RED, whole-branch review reopen round 2): an owned container exists but the active \$APP_DIR/docker-compose.yml is missing -- refuses to guess, fails with a clear diagnosis instead of a generic Compose error ==="
CASE_COUNT=$((CASE_COUNT + 1))
err25d="$TEST_ROOT/case25d.err"
compose_called25d="$TEST_ROOT/case25d.compose-called"
result25d="$(
  IMAGE_TAG=0000000000000000000000000000000000000000
  APP_DIR="$TEST_ROOT/case25d-app"
  export IMAGE_TAG APP_DIR
  # shellcheck source=/dev/null
  source "$LIB_FILE"
  # shellcheck disable=SC2329
  docker() {
    case "$*" in
      "ps -aq --filter"*) echo fake-mirofish-container-id ;;
      *) command docker "$@" ;;
    esac
  }
  # shellcheck disable=SC2329
  compose() { touch "$compose_called25d"; return 1; }
  (stop_remove_mirofish_container && echo OK || echo FAILED) 2>"$err25d"
)"
[[ "$result25d" == FAILED ]] || fail "case25d: expected FAILED when an owned container exists but the active config is missing, got $result25d"
grep -q 'no active .*docker-compose.yml to manage it with' "$err25d" 2>/dev/null || fail "case25d: expected the owned-missing-config diagnosis: $(cat "$err25d" 2>/dev/null)"
[[ -f "$compose_called25d" ]] && fail "case25d: must not fall through to calling compose() when the active config is missing"
echo "    result=$result25d"

echo "=== Case 26 (GREEN overall, review P2 round 3): a genuine post-install scratch-cleanup failure escalates into a full activation failure and self-heals -- never exports COMPOSE_PROFILES over a leftover secret-bearing scratch copy ==="
CASE_COUNT=$((CASE_COUNT + 1))
s26="$(new_scratch case26)"
printf 'TUNNEL_TOKEN=fake-tunnel-token\n' >"$s26/ci-staging/cloudflared.env"
export MIROFISH_ACTIVATE=1
export DEPLOY_SH_MIROFISH_CHMOD_SCRATCH_AFTER_INSTALL=0500
status="$(run_scenario_mirofish "$s26" 2>"$s26/stderr.log")"
unset MIROFISH_ACTIVATE DEPLOY_SH_MIROFISH_CHMOD_SCRATCH_AFTER_INSTALL
# A leftover read-only scratch dir from the forced failure would otherwise
# block this script's own final cleanup() -- fix it up regardless of outcome.
chmod -R 0700 "$s26/runtime" 2>/dev/null || true
if [[ "$status" != 0 ]]; then
  fail "case26: expected exit 0 (a MiroFish activation failure must not fail the deploy), got $status"
else
  [[ "$(cat "$s26/compose-profiles.out" 2>/dev/null)" == unset ]] || fail "case26: COMPOSE_PROFILES should stay unset after a post-install cleanup failure"
  [[ -e "$s26/runtime/mirofish.env" ]] && fail "case26: self-heal should have removed the newly-installed mirofish.env (no prior version existed)"
  grep -q 'post-install cleanup failed' "$s26/stderr.log" 2>/dev/null || fail "case26: expected the post-install cleanup failure to be logged: $(cat "$s26/stderr.log" 2>/dev/null)"
  grep -q 'failed to remove render scratch' "$s26/stderr.log" 2>/dev/null || fail "case26: expected cleanup_mirofish_scratch's own path-only error to be logged"
  grep -qE 'ZEP_API_KEY=|LLM_API_KEY=|fake-zep-not-real|fake-llm-not-real' "$s26/stderr.log" 2>/dev/null && fail "case26: cleanup/self-heal error output must never contain a key or its value"
  shopt -s nullglob
  leftover_scratch=("$s26/runtime"/.mirofish-render-*)
  shopt -u nullglob
  [[ ${#leftover_scratch[@]} -gt 0 ]] || fail "case26: expected the render scratch directory to still be present on disk (sanity check that cleanup genuinely failed, not skipped)"
  for name in tradingagents.env ai-hedge-fund.env vibe-trading.env vibe-gateway.env auth.env cloudflared.env; do
    [[ -f "$s26/secrets/$name" ]] || fail "case26: missing $name -- a MiroFish cleanup failure broke an unrelated app's deploy"
  done
fi
echo "    exit=$status"

echo "=== Case 27 (RED->rollback, review P2 round 3, process-level, fake Docker): post-deploy health-check failure after a successful MiroFish activation, PLUS rollback's own mirofish.env removal failing -- best-effort stop_remove_mirofish_container is attempted and logged, and the other three apps still roll back correctly ==="
CASE_COUNT=$((CASE_COUNT + 1))
s27="$(new_scratch case27)"
printf 'TUNNEL_TOKEN=fake-tunnel-token\n' >"$s27/ci-staging/cloudflared.env"
for name in tradingagents.env ai-hedge-fund.env vibe-trading.env vibe-gateway.env auth.env cloudflared.env; do
  printf 'OLD_VALUE=old-%s\n' "$name" >"$s27/secrets/$name"
  chmod 0600 "$s27/secrets/$name"
done
# A fake health-check.sh standing in for the real one (same technique Case 9
# already uses, now staged into config-staging per A10a): simulates a
# post-Compose health failure, and -- as this case's own controlled
# precondition -- makes the runtime dir read-only so the rollback that
# follows hits a REAL (not faked) mirofish.env removal failure, exercising
# "rollback cannot restore/delete mirofish.env after a post-Compose/health
# failure" end to end.
cat >"$s27/config-staging/health-check.sh" <<'HEALTH_EOF'
#!/usr/bin/env bash
chmod 0500 "${AI_TRADING_RUNTIME_ENV_DIR:-/run/family-app/ai-trading}"
exit 1
HEALTH_EOF
chmod +x "$s27/config-staging/health-check.sh"
status27=0
(
  APP_DIR="$s27/app"
  AI_TRADING_SECRETS_DIR="$s27/secrets"
  ENV_STAGING_DIR="$s27/ci-staging"
  APP_CONFIG_STAGING_DIR="$s27/config-staging"
  AI_TRADING_RUNTIME_ENV_DIR="$s27/runtime"
  AI_TRADING_STATE_DIR="$s27/control-state"
  AI_TRADING_UNIT_DIR="$s27/unit-dir"
  FAMILY_CONFIG_CREDENTIALS="$s27/fake-reader-key.json"
  DEPLOY_SH_SKIP_CHOWN=1
  IMAGE_TAG=3333333333333333333333333333333333333333
  MIROFISH_ACTIVATE=1
  export APP_DIR AI_TRADING_SECRETS_DIR ENV_STAGING_DIR APP_CONFIG_STAGING_DIR AI_TRADING_RUNTIME_ENV_DIR AI_TRADING_STATE_DIR AI_TRADING_UNIT_DIR FAMILY_CONFIG_CREDENTIALS DEPLOY_SH_SKIP_CHOWN IMAGE_TAG MIROFISH_ACTIVATE

  # Fake docker: deploy.sh/health-check.sh only ever shell out to `docker
  # compose ...` plus mirofish_container_ids' real-evidence `docker ps
  # -aq --filter`; the Vibe preflight's different service label reports no
  # Vibe container. No real Docker daemon is contacted anywhere in this
  # case. Logs every compose subcommand (pull/up/rm) so this case can
  # assert the best-effort stop_remove_mirofish_container call actually
  # ran; the ps query always reports an owned container so that call
  # actually reaches 'compose rm -s -f mirofish' (the active
  # docker-compose.yml this scratch run installs via stage_configs()
  # before the health-check failure is what makes that the right branch).
  # shellcheck disable=SC2329
  docker() {
    echo "fake docker $*" >>"$APP_DIR/docker.log"
    case "${1:-}" in
      compose) return 0 ;;
      ps)
        [[ "$*" == *'label=com.docker.compose.service=mirofish'* ]] && echo fake-mirofish-container-id
        return 0
        ;;
      # prune_old_images must never reach a real daemon (or its images).
      images | rmi) return 0 ;;
      *) command docker "$@" ;;
    esac
  }
  export -f docker
  install_fake_systemctl "$s27"

  # Fake stat: same BSD/macOS-vs-GNU shim Case 9 already documents and uses.
  # shellcheck disable=SC2329
  stat() {
    if [[ "${1:-}" == -c && "${2:-}" == '%u:%a' ]]; then
      local mode
      mode="$(command stat -c '%a' "$3" 2>/dev/null || command stat -f '%Lp' "$3" 2>/dev/null)"
      printf '0:%s\n' "$mode"
    else
      command stat "$@"
    fi
  }
  export -f stat

  bash "$DEPLOY_SH" >"$s27/stdout.log" 2>"$s27/stderr.log"
) || status27=$?
chmod -R 0700 "$s27/runtime" 2>/dev/null || true
if [[ "$status27" == 0 ]]; then
  fail "case27: expected non-zero exit (a real post-Compose health-check failure), got 0"
fi
grep -q 'ai-trading/mirofish profile rendered' "$s27/stderr.log" 2>/dev/null || fail "case27: MiroFish should have activated successfully before the health-check failure: $(cat "$s27/stderr.log" 2>/dev/null)"
grep -q 'rollback: failed to remove' "$s27/stderr.log" 2>/dev/null || fail "case27: expected rollback's own mirofish.env removal to fail and be reported"
grep -q 'rm -s -f mirofish' "$s27/app/docker.log" 2>/dev/null || fail "case27: expected the best-effort stop_remove_mirofish_container call ('compose rm -s -f mirofish') to have actually run: $(cat "$s27/app/docker.log" 2>/dev/null)"
grep -qE 'ZEP_API_KEY=|LLM_API_KEY=|fake-zep-not-real|fake-llm-not-real' "$s27/stderr.log" 2>/dev/null && fail "case27: rollback error output must never contain a key or its value"
for name in tradingagents.env ai-hedge-fund.env vibe-trading.env vibe-gateway.env auth.env cloudflared.env; do
  grep -q "old-$name" "$s27/secrets/$name" 2>/dev/null || fail "case27: $name not restored to its prior content after rollback -- a MiroFish-specific rollback failure must not break the other three apps"
done
echo "    exit=$status27"

echo "=== Case 28 (GREEN, whole-branch review reopen): ensure_mirofish_stopped() -- a normal disabled redeploy after an earlier activation explicitly stops the stale container, not just unsets the profile ==="
CASE_COUNT=$((CASE_COUNT + 1))
s28="$(new_scratch case28)"
# This case simulates STEADY STATE (an earlier deploy already installed the
# active config); the genuine-first-bootstrap case (no active config at
# all) is Case 52 below.
printf 'name: fixture\nservices: {}\n' >"$s28/app/docker-compose.yml"
marker28="$TEST_ROOT/case28-container-marker"
touch "$marker28"
err28="$TEST_ROOT/case28.err"
result28="$(
  (
    IMAGE_TAG=0000000000000000000000000000000000000000
    APP_DIR="$s28/app"
    export IMAGE_TAG APP_DIR
    # shellcheck source=/dev/null
    source "$LIB_FILE"
    # Fake docker(): mirofish_container_ids' real-evidence `ps -aq --filter`
    # query reports the marker's presence; fake compose(): simulates a real
    # Docker Compose project where the mirofish service's container still
    # exists until explicitly stopped/removed. shellcheck only analyzes
    # this file, not the sourced lib that calls them, so they look unused
    # here.
    # shellcheck disable=SC2329
    docker() {
      case "$*" in
        "ps -aq --filter"*)
          [[ -f "$marker28" ]] && echo fake-mirofish-container-id
          return 0
          ;;
        *) command docker "$@" ;;
      esac
    }
    # shellcheck disable=SC2329
    compose() {
      case "$*" in
        *"rm -s -f mirofish"*)
          echo "fake compose $*" >>"$APP_DIR/docker.log"
          rm -f "$marker28"
          return 0
          ;;
        *) return 0 ;;
      esac
    }
    activate_mirofish || true
    ensure_mirofish_stopped
    echo DEPLOY_PROCEEDED
  ) 2>"$err28"
)"
status28=$?
[[ "$status28" == 0 ]] || fail "case28: expected exit 0, got $status28: $(cat "$err28" 2>/dev/null)"
echo "$result28" | grep -q DEPLOY_PROCEEDED || fail "case28: expected ensure_mirofish_stopped to succeed and let the deploy proceed"
[[ -f "$marker28" ]] && fail "case28: the stale container marker should have been removed by the stop/remove call"
grep -q 'rm -s -f mirofish' "$s28/app/docker.log" 2>/dev/null || fail "case28: expected the stop/remove call to actually run: $(cat "$s28/app/docker.log" 2>/dev/null)"
echo "    exit=$status28"

echo "=== Case 29 (GREEN, whole-branch review reopen): ensure_mirofish_stopped() -- a FAILED new activation (missing Firestore profile) still explicitly stops a stale container left by an earlier successful activation ==="
CASE_COUNT=$((CASE_COUNT + 1))
s29="$(new_scratch case29)"
printf 'name: fixture\nservices: {}\n' >"$s29/app/docker-compose.yml"
marker29="$TEST_ROOT/case29-container-marker"
touch "$marker29"
err29="$TEST_ROOT/case29.err"
result29="$(
  (
    IMAGE_TAG=0000000000000000000000000000000000000000
    APP_DIR="$s29/app"
    AI_TRADING_RUNTIME_ENV_DIR="$s29/runtime"
    FAMILY_CONFIG_CREDENTIALS="$s29/fake-reader-key.json"
    MIROFISH_ACTIVATE=1
    FAKE_FC_MISSING_PROFILE="ai-trading/mirofish"
    export IMAGE_TAG APP_DIR AI_TRADING_RUNTIME_ENV_DIR FAMILY_CONFIG_CREDENTIALS MIROFISH_ACTIVATE FAKE_FC_MISSING_PROFILE
    # shellcheck source=/dev/null
    source "$LIB_FILE"
    # shellcheck disable=SC2329
    docker() {
      case "$*" in
        "ps -aq --filter"*)
          [[ -f "$marker29" ]] && echo fake-mirofish-container-id
          return 0
          ;;
        *) command docker "$@" ;;
      esac
    }
    # shellcheck disable=SC2329
    compose() {
      case "$*" in
        *"rm -s -f mirofish"*)
          echo "fake compose $*" >>"$APP_DIR/docker.log"
          rm -f "$marker29"
          return 0
          ;;
        *) return 0 ;;
      esac
    }
    activate_mirofish || true
    ensure_mirofish_stopped
    echo DEPLOY_PROCEEDED
  ) 2>"$err29"
)"
status29=$?
[[ "$status29" == 0 ]] || fail "case29: expected exit 0, got $status29: $(cat "$err29" 2>/dev/null)"
echo "$result29" | grep -q DEPLOY_PROCEEDED || fail "case29: expected ensure_mirofish_stopped to succeed and let the deploy proceed"
[[ -f "$marker29" ]] && fail "case29: the stale container marker should have been removed by the stop/remove call"
grep -q 'rm -s -f mirofish' "$s29/app/docker.log" 2>/dev/null || fail "case29: expected the stop/remove call to actually run: $(cat "$s29/app/docker.log" 2>/dev/null)"
grep -q 'render of ai-trading/mirofish failed' "$err29" 2>/dev/null || fail "case29: expected the failed activation itself to also be logged: $(cat "$err29" 2>/dev/null)"
echo "    exit=$status29"

echo "=== Case 30 (RED, process-level, whole-branch review reopen): a genuine stop-command failure FAILS THE DEPLOY before stage_secrets/deploy_tag ever run -- the previously-deployed tag's apps are left completely untouched ==="
CASE_COUNT=$((CASE_COUNT + 1))
s30="$(new_scratch case30)"
printf 'TUNNEL_TOKEN=fake-tunnel-token\n' >"$s30/ci-staging/cloudflared.env"
for name in tradingagents.env ai-hedge-fund.env vibe-trading.env vibe-gateway.env auth.env cloudflared.env; do
  printf 'OLD_VALUE=old-%s\n' "$name" >"$s30/secrets/$name"
  chmod 0600 "$s30/secrets/$name"
done
# This case simulates STEADY STATE (an earlier deploy's active config is
# already installed, and an earlier activation left a container running);
# the genuine-first-bootstrap/owned-missing-config cases are Cases 52/53
# below.
printf 'name: fixture\nservices: {}\n' >"$s30/app/docker-compose.yml"
status30=0
(
  APP_DIR="$s30/app"
  AI_TRADING_SECRETS_DIR="$s30/secrets"
  ENV_STAGING_DIR="$s30/ci-staging"
  APP_CONFIG_STAGING_DIR="$s30/config-staging"
  AI_TRADING_RUNTIME_ENV_DIR="$s30/runtime"
  AI_TRADING_STATE_DIR="$s30/control-state"
  AI_TRADING_UNIT_DIR="$s30/unit-dir"
  FAMILY_CONFIG_CREDENTIALS="$s30/fake-reader-key.json"
  DEPLOY_SH_SKIP_CHOWN=1
  IMAGE_TAG=4444444444444444444444444444444444444444
  export APP_DIR AI_TRADING_SECRETS_DIR ENV_STAGING_DIR APP_CONFIG_STAGING_DIR AI_TRADING_RUNTIME_ENV_DIR AI_TRADING_STATE_DIR AI_TRADING_UNIT_DIR FAMILY_CONFIG_CREDENTIALS DEPLOY_SH_SKIP_CHOWN IMAGE_TAG

  # Fake docker: every call is logged; mirofish_container_ids' real-evidence
  # `ps -aq --filter` query reports an owned MiroFish container only; the
  # separate Vibe service-label query must report no Vibe container. The
  # 'rm -s -f mirofish' (the stop/remove call ensure_mirofish_stopped makes
  # through compose(), since this scratch app dir has an active
  # docker-compose.yml) always fails, simulating a genuine Docker/daemon
  # problem. MIROFISH_ACTIVATE stays unset (the normal disabled path) --
  # this case's own controlled precondition stands in for "an earlier
  # activation left a container running that this stop attempt cannot
  # clear."
  # shellcheck disable=SC2329
  docker() {
    echo "fake docker $*" >>"$APP_DIR/docker.log"
    case "${1:-}" in
      compose)
        case "$*" in
          *"rm -s -f mirofish"*) return 1 ;;
          *) return 0 ;;
        esac
        ;;
      ps)
        [[ "$*" == *'label=com.docker.compose.service=mirofish'* ]] && echo fake-mirofish-container-id
        return 0
        ;;
      # prune_old_images must never reach a real daemon (or its images).
      images | rmi) return 0 ;;
      *) command docker "$@" ;;
    esac
  }
  export -f docker
  install_fake_systemctl "$s30"

  bash "$DEPLOY_SH" >"$s30/stdout.log" 2>"$s30/stderr.log"
) || status30=$?
if [[ "$status30" == 0 ]]; then
  fail "case30: expected non-zero exit (a genuine stop-command failure must fail the deploy), got 0"
fi
grep -q 'failed to stop/remove an existing mirofish container; aborting this deploy' "$s30/stderr.log" 2>/dev/null || fail "case30: expected the specific abort message: $(cat "$s30/stderr.log" 2>/dev/null)"
grep -q 'rm -s -f mirofish' "$s30/app/docker.log" 2>/dev/null || fail "case30: expected the stop attempt to have actually run before failing: $(cat "$s30/app/docker.log" 2>/dev/null)"
grep -qE ' pull$| up -d' "$s30/app/docker.log" 2>/dev/null && fail "case30: deploy_tag must never run -- found a pull/up call: $(cat "$s30/app/docker.log")"
for name in tradingagents.env ai-hedge-fund.env vibe-trading.env vibe-gateway.env auth.env cloudflared.env; do
  grep -q "old-$name" "$s30/secrets/$name" 2>/dev/null || fail "case30: $name must stay completely untouched -- stage_secrets must never have run"
done
[[ -f "$s30/app/last-good-tag" ]] && fail "case30: last-good-tag must never be written -- this deploy must abort before completing"
echo "    exit=$status30"

echo "=== Case 31 (GREEN, REAL Docker Compose fixture, whole-branch review reopen): ensure_mirofish_stopped() against a real disposable Compose project -- dummy busybox services, unique project name under a temp scratch dir, no real ai-trading images/secrets, no paid provider ==="
CASE_COUNT=$((CASE_COUNT + 1))
if ! docker compose version >/dev/null 2>&1; then
  echo "    SKIP: docker compose not available in this environment"
else
  s31="$TEST_ROOT/case31"
  mkdir -p "$s31/app"
  proj31="mirofish-task9-fixture-$$"
  cat >"$s31/app/docker-compose.yml" <<EOF
name: $proj31
services:
  web:
    image: busybox:1
    command: ["sleep", "infinity"]
EOF
  cat >"$s31/app/docker-compose.mirofish.yml" <<EOF
name: $proj31
services:
  mirofish:
    image: busybox:1
    command: ["sleep", "infinity"]
    profiles: ["mirofish"]
EOF
  ok31=1
  # Step 1: bring the project up WITH the mirofish profile active --
  # simulates "an earlier MIROFISH_ACTIVATE=1 deploy already ran."
  if ! COMPOSE_PROFILES=mirofish docker compose --project-name "$proj31" -f "$s31/app/docker-compose.yml" -f "$s31/app/docker-compose.mirofish.yml" up -d --wait --wait-timeout 30 >"$s31/up.log" 2>&1; then
    fail "case31: real 'docker compose up' (profile on) failed: $(cat "$s31/up.log" 2>/dev/null)"
    ok31=0
  fi
  if [[ "$ok31" == 1 ]] && ! docker ps -a --filter "label=com.docker.compose.project=$proj31" --filter "name=${proj31}-mirofish-1" --format '{{.Names}}' | grep -q mirofish; then
    fail "case31: real mirofish container did not actually start -- test setup itself is broken"
    ok31=0
  fi
  if [[ "$ok31" == 1 ]]; then
    # Step 2: this case's actual subject -- the REAL sourced library, with
    # NO --env-file images.env written yet (a genuinely first-ever deploy
    # against this scratch APP_DIR) and MIROFISH_ACTIVATE unset (normal
    # disabled path), calling the real ensure_mirofish_stopped() against
    # this real, already-running container. No fakes anywhere in this step.
    result31="$(
      (
        IMAGE_TAG=0000000000000000000000000000000000000000
        APP_DIR="$s31/app"
        DEPLOY_SH_COMPOSE_PROJECT="$proj31"
        export IMAGE_TAG APP_DIR DEPLOY_SH_COMPOSE_PROJECT
        # shellcheck source=/dev/null
        source "$LIB_FILE"
        activate_mirofish || true
        ensure_mirofish_stopped
        echo DEPLOY_PROCEEDED
      ) 2>"$s31/stderr.log"
    )"
    status31=$?
    if [[ "$status31" != 0 ]]; then
      fail "case31: expected exit 0 against a real, stoppable container, got $status31: $(cat "$s31/stderr.log" 2>/dev/null)"
    fi
    echo "$result31" | grep -q DEPLOY_PROCEEDED || fail "case31: expected ensure_mirofish_stopped to succeed and let the deploy proceed"
    if docker ps -a --filter "label=com.docker.compose.project=$proj31" --format '{{.Names}}' | grep -q "${proj31}-mirofish-1"; then
      fail "case31: the real mirofish container is still present after ensure_mirofish_stopped -- it should have been stopped and removed"
    fi
    if ! docker ps --filter "label=com.docker.compose.project=$proj31" --format '{{.Names}}' | grep -q "${proj31}-web-1"; then
      fail "case31: the real 'web' (core app stand-in) container should have been left running, untouched"
    fi
    echo "    exit=$status31"
  fi
  # Teardown: always attempt, regardless of pass/fail above, so no real
  # Docker resource from this test ever lingers. COMPOSE_PROFILES=mirofish
  # here too -- `down` selects services the same profile-scoped way `up`
  # does, so without it a still-running mirofish container (e.g. if the
  # assertion above already failed, meaning the fix under test didn't
  # actually stop it) would survive this teardown exactly like the bug
  # this whole round fixes. Force-remove unconditionally as a last resort.
  COMPOSE_PROFILES=mirofish docker compose --project-name "$proj31" -f "$s31/app/docker-compose.yml" -f "$s31/app/docker-compose.mirofish.yml" down -v --remove-orphans >/dev/null 2>&1 || true
  docker rm -f "${proj31}-web-1" "${proj31}-mirofish-1" >/dev/null 2>&1 || true
  docker network rm "${proj31}_default" >/dev/null 2>&1 || true
fi

echo "=== Case 32 (RED): vibe-trading profile without API_AUTH_KEY fails before any install (gateway could not authenticate to Vibe) ==="
CASE_COUNT=$((CASE_COUNT + 1))
s32="$(new_scratch case32)"
printf 'TUNNEL_TOKEN=fake-tunnel-token\n' >"$s32/ci-staging/cloudflared.env"
export FAKE_FC_VIBE_NO_API_KEY=1
status="$(run_scenario "$s32" 2>/dev/null)"
unset FAKE_FC_VIBE_NO_API_KEY
[[ "$status" != 0 ]] || fail "case32: expected non-zero exit when API_AUTH_KEY is missing, got 0"
shopt -s nullglob
installed=("$s32/secrets"/*.env)
leftover=("$s32/secrets"/.render-*)
shopt -u nullglob
[[ ${#installed[@]} -eq 0 ]] || fail "case32: files installed despite a missing API_AUTH_KEY: ${installed[*]}"
[[ ${#leftover[@]} -eq 0 ]] || fail "case32: render scratch not cleaned: ${leftover[*]}"
echo "    exit=$status"

# stat shim shared by Cases 33-35's process-level runs: same BSD/macOS-vs-GNU
# `stat -c '%u:%a'` shim Case 9 documents (fake uid 0, real mode).
# shellcheck disable=SC2329
fake_stat() {
  if [[ "${1:-}" == -c && "${2:-}" == '%u:%a' ]]; then
    local mode
    mode="$(command stat -c '%a' "$3" 2>/dev/null || command stat -f '%Lp' "$3" 2>/dev/null)"
    printf '0:%s\n' "$mode"
  else
    command stat "$@"
  fi
}

echo "=== Case 33 (GREEN, process-level, fake Docker): old ai-trading image tags are pruned BEFORE the pull -- only this release, the last-good tag, non-SHA tags, and anything outside the registry's ai-trading-* repos survive; an image a container still uses (rmi refuses) never fails the deploy ==="
CASE_COUNT=$((CASE_COUNT + 1))
s33="$(new_scratch case33)"
printf 'TUNNEL_TOKEN=fake-tunnel-token\n' >"$s33/ci-staging/cloudflared.env"
printf '#!/usr/bin/env bash\nexit 0\n' >"$s33/app/health-check.sh"
chmod +x "$s33/app/health-check.sh"
new33=5555555555555555555555555555555555555555
good33=6666666666666666666666666666666666666666
old33=7777777777777777777777777777777777777777
busy33=8888888888888888888888888888888888888888
reg33=registry.invalid/family-app
printf '%s\n' "$good33" >"$s33/app/last-good-tag"
cat >"$s33/app/fake-images.txt" <<EOF
$reg33/ai-trading-web:$new33
$reg33/ai-trading-web:$good33
$reg33/ai-trading-web:$old33
$reg33/ai-trading-mirofish-backend:$old33
$reg33/ai-trading-vibe-trading:$busy33
$reg33/ai-trading-web:latest
$reg33/ai-trading-web:<none>
$reg33/expense-api:$old33
registry.invalid/other/ai-trading-web:$old33
caddy:2
EOF
status33=0
(
  APP_DIR="$s33/app"
  AI_TRADING_SECRETS_DIR="$s33/secrets"
  ENV_STAGING_DIR="$s33/ci-staging"
  APP_CONFIG_STAGING_DIR="$s33/config-staging"
  AI_TRADING_STATE_DIR="$s33/control-state"
  AI_TRADING_UNIT_DIR="$s33/unit-dir"
  FAMILY_CONFIG_CREDENTIALS="$s33/fake-reader-key.json"
  DEPLOY_SH_SKIP_CHOWN=1
  IMAGE_TAG=$new33
  AI_TRADING_REGISTRY=$reg33
  FAKE_RMI_FAIL_TAG=$busy33
  export APP_DIR AI_TRADING_SECRETS_DIR ENV_STAGING_DIR APP_CONFIG_STAGING_DIR AI_TRADING_STATE_DIR AI_TRADING_UNIT_DIR FAMILY_CONFIG_CREDENTIALS DEPLOY_SH_SKIP_CHOWN IMAGE_TAG AI_TRADING_REGISTRY FAKE_RMI_FAIL_TAG

  # shellcheck disable=SC2329
  docker() {
    echo "fake docker $*" >>"$APP_DIR/docker.log"
    case "${1:-}" in
      compose) return 0 ;;
      # mirofish_container_ids' real-evidence query: no owned container in
      # this pruning-focused scenario (MIROFISH_ACTIVATE is unset).
      ps) return 0 ;;
      images)
        cat "$APP_DIR/fake-images.txt"
        return 0
        ;;
      rmi)
        # An image a container still uses: the real daemon refuses to remove it.
        [[ "${2:-}" == *":$FAKE_RMI_FAIL_TAG" ]] && return 1
        return 0
        ;;
    esac
    command docker "$@"
  }
  export -f docker fake_stat
  # shellcheck disable=SC2329
  stat() { fake_stat "$@"; }
  export -f stat
  install_fake_systemctl "$s33"

  bash "$DEPLOY_SH" >"$s33/stdout.log" 2>"$s33/stderr.log"
) || status33=$?
if [[ "$status33" != 0 ]]; then
  fail "case33: expected exit 0 (a refused rmi must not fail the deploy), got $status33: $(cat "$s33/stderr.log" 2>/dev/null)"
else
  log33="$s33/app/docker.log"
  for gone in "$reg33/ai-trading-web:$old33" "$reg33/ai-trading-mirofish-backend:$old33" "$reg33/ai-trading-vibe-trading:$busy33"; do
    grep -qxF "fake docker rmi $gone" "$log33" || fail "case33: expected a plain 'docker rmi $gone'"
  done
  [[ "$(grep -c '^fake docker rmi ' "$log33")" == 3 ]] || fail "case33: expected exactly the three stale ai-trading tags to be removed, got: $(grep '^fake docker rmi ' "$log33")"
  first_rmi33="$(grep -n '^fake docker rmi ' "$log33" | head -1 | cut -d: -f1 || true)"
  pull33="$(grep -n 'pull$' "$log33" | head -1 | cut -d: -f1 || true)"
  [[ -n "$first_rmi33" && -n "$pull33" && "$first_rmi33" -lt "$pull33" ]] || fail "case33: stale images must be removed before 'compose pull' (first rmi at line '$first_rmi33', pull at line '$pull33')"
  [[ "$(cat "$s33/app/last-good-tag" 2>/dev/null)" == "$new33" ]] || fail "case33: last-good-tag should now be the new release"
fi
echo "    exit=$status33"

echo "=== Case 34 (RED, process-level, fake Docker): too little free disk fails the deploy BEFORE any secret, container, or tag is touched ==="
CASE_COUNT=$((CASE_COUNT + 1))
s34="$(new_scratch case34)"
printf 'TUNNEL_TOKEN=fake-tunnel-token\n' >"$s34/ci-staging/cloudflared.env"
for name in tradingagents.env ai-hedge-fund.env vibe-trading.env vibe-gateway.env auth.env cloudflared.env; do
  printf 'OLD_VALUE=old-%s\n' "$name" >"$s34/secrets/$name"
  chmod 0600 "$s34/secrets/$name"
done
printf '%s\n' 6666666666666666666666666666666666666666 >"$s34/app/last-good-tag"
status34=0
(
  APP_DIR="$s34/app"
  AI_TRADING_SECRETS_DIR="$s34/secrets"
  ENV_STAGING_DIR="$s34/ci-staging"
  APP_CONFIG_STAGING_DIR="$s34/config-staging"
  AI_TRADING_STATE_DIR="$s34/control-state"
  AI_TRADING_UNIT_DIR="$s34/unit-dir"
  FAMILY_CONFIG_CREDENTIALS="$s34/fake-reader-key.json"
  DEPLOY_SH_SKIP_CHOWN=1
  IMAGE_TAG=9999999999999999999999999999999999999999
  AI_TRADING_MIN_FREE_GB=999999
  AI_TRADING_DOCKER_DATA_DIR="$s34/app"
  export APP_DIR AI_TRADING_SECRETS_DIR ENV_STAGING_DIR APP_CONFIG_STAGING_DIR AI_TRADING_STATE_DIR AI_TRADING_UNIT_DIR FAMILY_CONFIG_CREDENTIALS DEPLOY_SH_SKIP_CHOWN IMAGE_TAG AI_TRADING_MIN_FREE_GB AI_TRADING_DOCKER_DATA_DIR

  # shellcheck disable=SC2329
  docker() {
    echo "fake docker $*" >>"$APP_DIR/docker.log"
    case "${1:-}" in
      compose | images | rmi) return 0 ;;
    esac
    command docker "$@"
  }
  export -f docker
  install_fake_systemctl "$s34"

  bash "$DEPLOY_SH" >"$s34/stdout.log" 2>"$s34/stderr.log"
) || status34=$?
if [[ "$status34" == 0 ]]; then
  fail "case34: expected non-zero exit when the disk is too small, got 0"
fi
grep -q 'GiB free' "$s34/stderr.log" 2>/dev/null || fail "case34: expected a clear free-space message: $(cat "$s34/stderr.log" 2>/dev/null)"
grep -qE ' pull$| up -d' "$s34/app/docker.log" 2>/dev/null && fail "case34: deploy_tag must never run -- found a pull/up call: $(cat "$s34/app/docker.log")"
for name in tradingagents.env ai-hedge-fund.env vibe-trading.env vibe-gateway.env auth.env cloudflared.env; do
  grep -q "old-$name" "$s34/secrets/$name" 2>/dev/null || fail "case34: $name must stay completely untouched -- stage_secrets must never have run"
done
[[ -d "$s34/secrets/.previous" ]] && fail "case34: stage_secrets must never have run (.previous backup directory exists)"
shopt -s nullglob
leftover34=("$s34/secrets"/.render-*)
shopt -u nullglob
[[ ${#leftover34[@]} -eq 0 ]] || fail "case34: nothing should have been rendered before the disk check: ${leftover34[*]}"
[[ "$(cat "$s34/app/last-good-tag" 2>/dev/null)" == 6666666666666666666666666666666666666666 ]] || fail "case34: last-good-tag must be left alone"
echo "    exit=$status34"

echo "=== Case 35 (RED, process-level, fake Docker): an unreadable Docker data directory fails closed with a clear message, never a silent pass ==="
CASE_COUNT=$((CASE_COUNT + 1))
s35="$(new_scratch case35)"
printf 'TUNNEL_TOKEN=fake-tunnel-token\n' >"$s35/ci-staging/cloudflared.env"
status35=0
(
  APP_DIR="$s35/app"
  AI_TRADING_SECRETS_DIR="$s35/secrets"
  ENV_STAGING_DIR="$s35/ci-staging"
  APP_CONFIG_STAGING_DIR="$s35/config-staging"
  AI_TRADING_STATE_DIR="$s35/control-state"
  AI_TRADING_UNIT_DIR="$s35/unit-dir"
  FAMILY_CONFIG_CREDENTIALS="$s35/fake-reader-key.json"
  DEPLOY_SH_SKIP_CHOWN=1
  IMAGE_TAG=9999999999999999999999999999999999999999
  AI_TRADING_DOCKER_DATA_DIR="$s35/does-not-exist"
  export APP_DIR AI_TRADING_SECRETS_DIR ENV_STAGING_DIR APP_CONFIG_STAGING_DIR AI_TRADING_STATE_DIR AI_TRADING_UNIT_DIR FAMILY_CONFIG_CREDENTIALS DEPLOY_SH_SKIP_CHOWN IMAGE_TAG AI_TRADING_DOCKER_DATA_DIR

  # shellcheck disable=SC2329
  docker() {
    echo "fake docker $*" >>"$APP_DIR/docker.log"
    case "${1:-}" in
      compose | images | rmi) return 0 ;;
    esac
    command docker "$@"
  }
  export -f docker
  install_fake_systemctl "$s35"

  bash "$DEPLOY_SH" >"$s35/stdout.log" 2>"$s35/stderr.log"
) || status35=$?
if [[ "$status35" == 0 ]]; then
  fail "case35: expected non-zero exit when free disk space cannot be read, got 0"
fi
grep -q 'cannot read free disk space' "$s35/stderr.log" 2>/dev/null || fail "case35: expected the specific 'cannot read free disk space' message: $(cat "$s35/stderr.log" 2>/dev/null)"
grep -qE ' pull$| up -d' "$s35/app/docker.log" 2>/dev/null && fail "case35: deploy_tag must never run -- found a pull/up call"
[[ -f "$s35/app/last-good-tag" ]] && fail "case35: last-good-tag must never be written"
echo "    exit=$status35"

# fake_df_gib GIB: prints the POSIX two-line `df -Pk` table with GIB available,
# so a case can drive require_free_space() without a real disk.
# shellcheck disable=SC2329
fake_df_gib() {
  printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/fake 999999999 1 %s 1%% /\n' "$(($1 * 1024 * 1024))"
}

echo "=== Case 36 (GREEN x2, unit-level, fake df): with AI_TRADING_MIN_FREE_GB unset the guard uses its 30 GiB default -- 29 GiB free blocks, 30 GiB free passes ==="
CASE_COUNT=$((CASE_COUNT + 1))
for avail36 in 29 30; do
  out36="$(
    (
      IMAGE_TAG=0000000000000000000000000000000000000000
      export IMAGE_TAG
      unset AI_TRADING_MIN_FREE_GB
      # shellcheck source=/dev/null
      source "$LIB_FILE"
      # shellcheck disable=SC2329
      df() { fake_df_gib "$avail36"; }
      require_free_space
      echo ENOUGH
    ) 2>&1 || true
  )"
  if [[ "$avail36" == 29 ]]; then
    [[ "$out36" == *"only 29 GiB free"* && "$out36" != *ENOUGH* ]] || fail "case36: 29 GiB free must block at the 30 GiB default, got: $out36"
  else
    [[ "$out36" == ENOUGH ]] || fail "case36: 30 GiB free must pass at the 30 GiB default, got: $out36"
  fi
done
echo "    ok"

echo "=== Case 37 (RED x4 + GREEN, unit-level, fake df): a malformed AI_TRADING_MIN_FREE_GB fails closed instead of bash arithmetic reading it as 'enough'; a leading zero is decimal, never octal ==="
CASE_COUNT=$((CASE_COUNT + 1))
for bad37 in -1 abc 1e3 99999999999999999999; do
  out37="$(
    (
      IMAGE_TAG=0000000000000000000000000000000000000000
      AI_TRADING_MIN_FREE_GB="$bad37"
      export IMAGE_TAG AI_TRADING_MIN_FREE_GB
      # shellcheck source=/dev/null
      source "$LIB_FILE"
      # shellcheck disable=SC2329
      df() { fake_df_gib 1000; }
      require_free_space
      echo ENOUGH
    ) 2>&1 || true
  )"
  [[ "$out37" == *"must be a whole number"* && "$out37" != *ENOUGH* ]] || fail "case37: AI_TRADING_MIN_FREE_GB='$bad37' must be rejected, got: $out37"
done
# 030 is thirty GiB; octal would read it as 24 and let 29 GiB through.
out37="$(
  (
    IMAGE_TAG=0000000000000000000000000000000000000000
    AI_TRADING_MIN_FREE_GB=030
    export IMAGE_TAG AI_TRADING_MIN_FREE_GB
    # shellcheck source=/dev/null
    source "$LIB_FILE"
    # shellcheck disable=SC2329
    df() { fake_df_gib 29; }
    require_free_space
    echo ENOUGH
  ) 2>&1 || true
)"
[[ "$out37" == *"only 29 GiB free"* && "$out37" != *ENOUGH* ]] || fail "case37: AI_TRADING_MIN_FREE_GB=030 must mean 30 GiB (decimal), got: $out37"
echo "    ok"

echo "=== Case 38 (GREEN x3, unit-level, fake Docker): a last-good-tag that is not exactly one commit SHA means the rollback target is unknown -- prune_old_images removes nothing and says so ==="
CASE_COUNT=$((CASE_COUNT + 1))
for variant38 in multi-line empty junk; do
  s38="$(new_scratch "case38-$variant38")"
  case "$variant38" in
    multi-line) printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nnot-a-tag\n' >"$s38/app/last-good-tag" ;;
    empty) : >"$s38/app/last-good-tag" ;;
    junk) printf 'latest\n' >"$s38/app/last-good-tag" ;;
  esac
  (
    IMAGE_TAG=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
    APP_DIR="$s38/app"
    AI_TRADING_REGISTRY=registry.invalid/family-app
    export IMAGE_TAG APP_DIR AI_TRADING_REGISTRY
    # shellcheck source=/dev/null
    source "$LIB_FILE"
    # shellcheck disable=SC2329
    docker() {
      echo "fake docker $*" >>"$APP_DIR/docker.log"
      if [[ "${1:-}" == images ]]; then
        printf '%s\n' \
          registry.invalid/family-app/ai-trading-web:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
          registry.invalid/family-app/ai-trading-web:cccccccccccccccccccccccccccccccccccccccc
      fi
      return 0
    }
    prune_old_images
  ) 2>"$s38/stderr.log"
  if grep -q '^fake docker rmi ' "$s38/app/docker.log" 2>/dev/null; then
    fail "case38 ($variant38): no image may be removed while the rollback target is unknown: $(grep '^fake docker rmi ' "$s38/app/docker.log")"
  fi
  grep -q 'skipping image pruning' "$s38/stderr.log" 2>/dev/null || fail "case38 ($variant38): expected the skip to be logged: $(cat "$s38/stderr.log" 2>/dev/null)"
done
echo "    ok"

# MIROFISH_ACTIVATE=keep (push deploys): stay enabled only while a mirofish
# container is running and the profile still renders valid. FAKE_RUNNING_ID
# is what the fake `docker compose ... ps` prints (empty: nothing running).
run_keep_scenario() {
  local base="$1"
  # shellcheck disable=SC2329
  docker() {
    echo "fake docker $*" >>"$base/docker.log"
    [[ " $* " == *" ps "* ]] && printf '%s' "${FAKE_RUNNING_ID:-}"
    return 0
  }
  MIROFISH_ACTIVATE=keep run_scenario_mirofish "$base"
}

echo "=== Case 39 (GREEN): MIROFISH_ACTIVATE=keep with a running mirofish container keeps MiroFish enabled ==="
CASE_COUNT=$((CASE_COUNT + 1))
s39="$(new_scratch case39)"
printf 'TUNNEL_TOKEN=fake-tunnel-token\n' >"$s39/ci-staging/cloudflared.env"
status="$(FAKE_RUNNING_ID=abc123 run_keep_scenario "$s39")"
[[ "$status" == 0 ]] || fail "case39: expected exit 0, got $status"
[[ "$(cat "$s39/compose-profiles.out" 2>/dev/null)" == mirofish ]] || fail "case39: keep + running must leave COMPOSE_PROFILES=mirofish"
grep -q '^ZEP_API_KEY=' "$s39/runtime/mirofish.env" 2>/dev/null || fail "case39: keep + running must render mirofish.env"
grep -q 'ps -q --status running mirofish$' "$s39/docker.log" 2>/dev/null || fail "case39: expected a running-container check: $(cat "$s39/docker.log" 2>/dev/null)"
echo "    exit=$status"

echo "=== Case 40 (GREEN): MIROFISH_ACTIVATE=keep with no running mirofish container leaves MiroFish disabled ==="
CASE_COUNT=$((CASE_COUNT + 1))
s40="$(new_scratch case40)"
printf 'TUNNEL_TOKEN=fake-tunnel-token\n' >"$s40/ci-staging/cloudflared.env"
status="$(FAKE_RUNNING_ID='' run_keep_scenario "$s40")"
[[ "$status" == 0 ]] || fail "case40: expected exit 0, got $status"
[[ "$(cat "$s40/compose-profiles.out" 2>/dev/null)" == unset ]] || fail "case40: keep + not running must leave COMPOSE_PROFILES unset"
[[ -e "$s40/runtime/mirofish.env" ]] && fail "case40: keep + not running must not render mirofish.env"
echo "    exit=$status"

echo "=== Case 41 (GREEN overall): MIROFISH_ACTIVATE=keep with a running container but a missing profile leaves MiroFish disabled ==="
CASE_COUNT=$((CASE_COUNT + 1))
s41="$(new_scratch case41)"
printf 'TUNNEL_TOKEN=fake-tunnel-token\n' >"$s41/ci-staging/cloudflared.env"
status="$(FAKE_RUNNING_ID=abc123 FAKE_FC_MISSING_PROFILE=ai-trading/mirofish run_keep_scenario "$s41")"
[[ "$status" == 0 ]] || fail "case41: expected exit 0, got $status"
[[ "$(cat "$s41/compose-profiles.out" 2>/dev/null)" == unset ]] || fail "case41: keep with a missing profile must leave COMPOSE_PROFILES unset"
echo "    exit=$status"

echo "=== Case 42 (GREEN): compose() passes the Caddyfile's sha256, so a changed Caddyfile recreates the gateway (the single-file bind mount keeps the old inode otherwise) ==="
CASE_COUNT=$((CASE_COUNT + 1))
s42="$(new_scratch case42)"
printf 'http://example.test:8080 {\n\trespond 200\n}\n' >"$s42/app/Caddyfile"
got42="$(
  APP_DIR="$s42/app"
  IMAGE_TAG=0000000000000000000000000000000000000000
  export APP_DIR IMAGE_TAG
  # shellcheck source=/dev/null
  source "$LIB_FILE"
  # shellcheck disable=SC2329
  docker() { printf '%s\n' "${AI_TRADING_CADDYFILE_SHA256:-missing}"; }
  compose ps -q
)"
want42="$(sha256sum "$s42/app/Caddyfile")"
want42="${want42%% *}"
[[ "$got42" == "$want42" ]] || fail "case42: compose() should export AI_TRADING_CADDYFILE_SHA256=$want42, got $got42"
# shellcheck disable=SC2016 # literal compose interpolation, not a shell expansion
grep -q 'caddyfile-sha256: \${AI_TRADING_CADDYFILE_SHA256' "$(dirname "$DEPLOY_SH")/docker-compose.yml" \
  || fail "case42: the gateway service must carry the Caddyfile sha256 as a label"
echo "    got=$got42"

# Cases 43-48 (A10a): transactional config-file rollback. The four
# declarative config files (docker-compose.yml, docker-compose.mirofish.yml,
# Caddyfile, health-check.sh) are now staged by the workflow into
# APP_CONFIG_STAGING_DIR and owned end-to-end by stage_configs()/
# restore_or_remove_configs() -- the same validate-first, back-up-before-any-
# mutation, atomic-install, roll-back-on-any-later-failure discipline the
# five SECRET_FILES already have. Case 48 additionally regresses a real bug
# this task fixed: compose()'s inline AI_TRADING_IMAGE_TAG env var overrides
# images.env, so a rollback's own `deploy_tag "$previous"` must reassign the
# global IMAGE_TAG or it silently redeploys the just-failed NEW tag instead.

echo "=== Case 43 (RED->rollback): first-time config install + a forced mid-install failure REMOVES every just-installed config file, leaves nothing partial, and the same-run secrets rollback still happens too ==="
CASE_COUNT=$((CASE_COUNT + 1))
s43="$(new_scratch case43)"
printf 'TUNNEL_TOKEN=fake-tunnel-token\n' >"$s43/ci-staging/cloudflared.env"
export DEPLOY_SH_CONFIG_FAIL_AFTER="Caddyfile"
status="$(run_scenario "$s43")"
unset DEPLOY_SH_CONFIG_FAIL_AFTER
if [[ "$status" == 0 ]]; then
  fail "case43: expected non-zero exit for a forced mid-install config failure, got 0"
fi
for name in docker-compose.yml docker-compose.mirofish.yml Caddyfile health-check.sh; do
  [[ -e "$s43/app/$name" ]] && fail "case43: $name had no prior version -- rollback should have removed it, not left it behind"
done
shopt -s nullglob
leftover43=("$s43/app"/.config-backup-*)
shopt -u nullglob
[[ ${#leftover43[@]} -eq 0 ]] || fail "case43: run-owned config backup scratch not cleaned: ${leftover43[*]}"
shopt -s nullglob
leftover_secrets43=("$s43/secrets"/*.env)
shopt -u nullglob
[[ ${#leftover_secrets43[@]} -eq 0 ]] || fail "case43: first-time secret files left behind after a later config-stage failure: ${leftover_secrets43[*]}"
echo "    exit=$status"

echo "=== Case 44 (RED->rollback): a staged release adding a new service (synthetic 'ta-research' marker standing in for Task 6's real research service) over an OLD release that lacks it -- a mid-install failure restores all four active files byte-for-byte, so a previous-tag redeploy would never see the new/nonexistent service ==="
CASE_COUNT=$((CASE_COUNT + 1))
s44="$(new_scratch case44)"
printf 'TUNNEL_TOKEN=fake-tunnel-token\n' >"$s44/ci-staging/cloudflared.env"
# OLD active release: no research service at all.
printf 'name: ai-trading\nservices:\n  web:\n    image: busybox:1\n' >"$s44/app/docker-compose.yml"
printf 'name: ai-trading\nservices:\n  mirofish:\n    image: busybox:1\n    profiles: ["mirofish"]\n' >"$s44/app/docker-compose.mirofish.yml"
printf '# OLD Caddyfile, no research route\n' >"$s44/app/Caddyfile"
printf '#!/usr/bin/env bash\nSERVICES=(web)\nexit 0\n' >"$s44/app/health-check.sh"
chmod 0755 "$s44/app/health-check.sh"
# NEW staged release: adds a synthetic ta-research marker (Task 6a owns only
# the rollback mechanics, never the real Compose/Caddy content Task 6 adds).
printf 'name: ai-trading\nservices:\n  web:\n    image: busybox:1\n  ta-research:\n    image: ghcr.io/example/ai-trading-ta-research:new\n' >"$s44/config-staging/docker-compose.yml"
printf '# NEW Caddyfile with a ta-research route\n' >"$s44/config-staging/Caddyfile"
printf '#!/usr/bin/env bash\nSERVICES=(web ta-research)\nexit 0\n' >"$s44/config-staging/health-check.sh"
chmod 0755 "$s44/config-staging/health-check.sh"
# Fail after the 3rd of 4 files (Caddyfile) so health-check.sh's own install
# never even starts -- a genuine partial install, not merely a post-install
# abort after all four already landed.
export DEPLOY_SH_CONFIG_FAIL_AFTER="Caddyfile"
status="$(run_scenario "$s44")"
unset DEPLOY_SH_CONFIG_FAIL_AFTER
if [[ "$status" == 0 ]]; then
  fail "case44: expected non-zero exit for a forced mid-install config failure, got 0"
fi
grep -q 'ta-research' "$s44/app/docker-compose.yml" 2>/dev/null && fail "case44: the restored docker-compose.yml must never mention the new service -- restore did not fully undo the partial install"
grep -q 'ta-research' "$s44/app/Caddyfile" 2>/dev/null && fail "case44: the restored Caddyfile must never mention the new service"
grep -q 'ta-research' "$s44/app/health-check.sh" 2>/dev/null && fail "case44: the restored health-check.sh must never mention the new service"
grep -q 'no research route' "$s44/app/Caddyfile" 2>/dev/null || fail "case44: Caddyfile not restored to its exact OLD content"
grep -q 'SERVICES=(web)' "$s44/app/health-check.sh" 2>/dev/null || fail "case44: health-check.sh not restored to its exact OLD content"
shopt -s nullglob
leftover44=("$s44/app"/.config-backup-*)
shopt -u nullglob
[[ ${#leftover44[@]} -eq 0 ]] || fail "case44: run-owned config backup scratch not cleaned: ${leftover44[*]}"
echo "    exit=$status"

echo "=== Case 45 (unit-level, injected real failures): restore_or_remove_configs's RESTORE and REMOVE paths both fail for real (APP_DIR made read-only) -- each is reported, never silently claimed as a successful recovery ==="
CASE_COUNT=$((CASE_COUNT + 1))
s45="$(new_scratch case45)"
# docker-compose.yml and Caddyfile pre-exist (exercises the RESTORE path);
# docker-compose.mirofish.yml and health-check.sh do not (exercises REMOVE).
printf 'OLD_VALUE=old-docker-compose.yml\n' >"$s45/app/docker-compose.yml"
printf 'OLD_VALUE=old-Caddyfile\n' >"$s45/app/Caddyfile"
err45="$s45/stderr.log"
result45="$(
  (
    APP_DIR="$s45/app"
    APP_CONFIG_STAGING_DIR="$s45/config-staging"
    IMAGE_TAG=0000000000000000000000000000000000000000
    export APP_DIR APP_CONFIG_STAGING_DIR IMAGE_TAG
    # shellcheck source=/dev/null
    source "$LIB_FILE"
    # stage_configs()'s new Compose-parse validation doesn't need real
    # Docker for this case (it's testing restore/remove failure, not
    # Compose parsing -- Case 49 below is the dedicated real-docker probe).
    # shellcheck disable=SC2329
    docker() {
      [[ "${1:-}" == compose ]] && return 0
      command docker "$@"
    }
    stage_configs
    chmod 0500 "$APP_DIR"
    restore_or_remove_configs && echo OK || echo FAILED
  ) 2>"$err45"
)"
chmod 0700 "$s45/app" 2>/dev/null || true
[[ "$result45" == FAILED ]] || fail "case45: expected FAILED when APP_DIR is read-only during restore/remove, got $result45"
grep -q 'failed to restore' "$err45" 2>/dev/null || fail "case45: expected the restore failure to be reported: $(cat "$err45" 2>/dev/null)"
grep -q 'failed to remove' "$err45" 2>/dev/null || fail "case45: expected the remove failure to be reported: $(cat "$err45" 2>/dev/null)"
# A genuinely failed restore's own atomic install never reached its final
# `mv -f`, so the file must still hold whatever stage_configs installed
# moments earlier (the staged/new fixture content) -- never vanish, never a
# half-written file, and never silently reappear as the old content either.
grep -q 'ai-trading-fixture' "$s45/app/docker-compose.yml" 2>/dev/null || fail "case45: a genuinely failed restore must leave the file exactly as stage_configs last installed it, not vanish or revert"
echo "    result=$result45"

echo "=== Case 46 (RED, process-level): a missing or incomplete APP_CONFIG_STAGING_DIR fails before touching ANY active config, secret, or tag file ==="
CASE_COUNT=$((CASE_COUNT + 1))
for variant46 in unset incomplete; do
  s46="$(new_scratch "case46-$variant46")"
  printf 'TUNNEL_TOKEN=fake-tunnel-token\n' >"$s46/ci-staging/cloudflared.env"
  if [[ "$variant46" == incomplete ]]; then
    rm -f "$s46/config-staging/Caddyfile"
  fi
  status46=0
  (
    APP_DIR="$s46/app"
    AI_TRADING_SECRETS_DIR="$s46/secrets"
    ENV_STAGING_DIR="$s46/ci-staging"
    FAMILY_CONFIG_CREDENTIALS="$s46/fake-reader-key.json"
    DEPLOY_SH_SKIP_CHOWN=1
    IMAGE_TAG=0000000000000000000000000000000000000000
    if [[ "$variant46" == unset ]]; then
      unset APP_CONFIG_STAGING_DIR
    else
      APP_CONFIG_STAGING_DIR="$s46/config-staging"
      export APP_CONFIG_STAGING_DIR
    fi
    export APP_DIR AI_TRADING_SECRETS_DIR ENV_STAGING_DIR FAMILY_CONFIG_CREDENTIALS DEPLOY_SH_SKIP_CHOWN IMAGE_TAG
    bash "$DEPLOY_SH" >"$s46/stdout.log" 2>"$s46/stderr.log"
  ) || status46=$?
  if [[ "$status46" == 0 ]]; then
    fail "case46 ($variant46): expected non-zero exit, got 0"
  fi
  grep -qE 'APP_CONFIG_STAGING_DIR|missing .*Caddyfile' "$s46/stderr.log" 2>/dev/null || fail "case46 ($variant46): expected a config-staging error message: $(cat "$s46/stderr.log" 2>/dev/null)"
  shopt -s nullglob
  leftover_secrets46=("$s46/secrets"/*)
  shopt -u nullglob
  [[ ${#leftover_secrets46[@]} -eq 0 ]] || fail "case46 ($variant46): a secret file was created despite failing closed before secrets/configs: ${leftover_secrets46[*]}"
  [[ -f "$s46/app/docker-compose.yml" ]] && fail "case46 ($variant46): a config file was installed despite failing closed"
  [[ -f "$s46/app/last-good-tag" ]] && fail "case46 ($variant46): last-good-tag written despite failing closed"
  echo "    exit=$status46 ($variant46)"
done

echo "=== Case 47 (RED, process-level): a preflight (free-disk) failure leaves ALL FOUR active config files completely untouched -- stage_configs must never have run ==="
CASE_COUNT=$((CASE_COUNT + 1))
s47="$(new_scratch case47)"
printf 'TUNNEL_TOKEN=fake-tunnel-token\n' >"$s47/ci-staging/cloudflared.env"
printf '%s\n' 6666666666666666666666666666666666666666 >"$s47/app/last-good-tag"
for name in docker-compose.yml docker-compose.mirofish.yml Caddyfile health-check.sh; do
  printf 'OLD_ACTIVE_CONFIG=%s\n' "$name" >"$s47/app/$name"
done
chmod 0755 "$s47/app/health-check.sh"
status47=0
(
  APP_DIR="$s47/app"
  AI_TRADING_SECRETS_DIR="$s47/secrets"
  ENV_STAGING_DIR="$s47/ci-staging"
  APP_CONFIG_STAGING_DIR="$s47/config-staging"
  AI_TRADING_STATE_DIR="$s47/control-state"
  AI_TRADING_UNIT_DIR="$s47/unit-dir"
  FAMILY_CONFIG_CREDENTIALS="$s47/fake-reader-key.json"
  DEPLOY_SH_SKIP_CHOWN=1
  IMAGE_TAG=9999999999999999999999999999999999999999
  AI_TRADING_MIN_FREE_GB=999999
  AI_TRADING_DOCKER_DATA_DIR="$s47/app"
  export APP_DIR AI_TRADING_SECRETS_DIR ENV_STAGING_DIR APP_CONFIG_STAGING_DIR AI_TRADING_STATE_DIR AI_TRADING_UNIT_DIR FAMILY_CONFIG_CREDENTIALS DEPLOY_SH_SKIP_CHOWN IMAGE_TAG AI_TRADING_MIN_FREE_GB AI_TRADING_DOCKER_DATA_DIR
  # shellcheck disable=SC2329
  docker() {
    echo "fake docker $*" >>"$APP_DIR/docker.log"
    case "${1:-}" in
      compose | images | rmi) return 0 ;;
    esac
    command docker "$@"
  }
  export -f docker
  install_fake_systemctl "$s47"
  bash "$DEPLOY_SH" >"$s47/stdout.log" 2>"$s47/stderr.log"
) || status47=$?
if [[ "$status47" == 0 ]]; then
  fail "case47: expected non-zero exit when the disk is too small, got 0"
fi
for name in docker-compose.yml docker-compose.mirofish.yml Caddyfile health-check.sh; do
  grep -q "OLD_ACTIVE_CONFIG=$name" "$s47/app/$name" 2>/dev/null || fail "case47: $name must stay completely untouched -- stage_configs must never have run"
done
shopt -s nullglob
leftover47=("$s47/app"/.config-backup-*)
shopt -u nullglob
[[ ${#leftover47[@]} -eq 0 ]] || fail "case47: no config backup scratch should have been created before the preflight check: ${leftover47[*]}"
echo "    exit=$status47"

echo "=== Case 48 (regression): rollback's previous-tag redeploy must use the PREVIOUS tag's image, never the stale new tag -- compose()'s inline AI_TRADING_IMAGE_TAG env var takes precedence over images.env, so deploy_tag() must reassign the global IMAGE_TAG before calling compose() or a rollback silently redeploys the just-failed NEW tag's images ==="
CASE_COUNT=$((CASE_COUNT + 1))
s48="$(new_scratch case48)"
printf 'TUNNEL_TOKEN=fake-tunnel-token\n' >"$s48/ci-staging/cloudflared.env"
good48=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
new48=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
printf '%s\n' "$good48" >"$s48/app/last-good-tag"
# An established release (the realistic case a rollback actually redeploys):
# active config already exists for all four files, so restore -- not
# first-time removal -- is what rollback does here, leaving a working
# health-check.sh in place for the previous-tag redeploy below to call.
for name in docker-compose.yml docker-compose.mirofish.yml Caddyfile; do
  printf 'OLD_VALUE=old-%s\n' "$name" >"$s48/app/$name"
done
printf '#!/usr/bin/env bash\nexit 0\n' >"$s48/app/health-check.sh"
chmod 0755 "$s48/app/health-check.sh"
export DEPLOY_SH_CONFIG_FAIL_AFTER="Caddyfile"
status="$(
  (
    # shellcheck disable=SC2329
    docker() {
      if [[ "${1:-}" == compose ]]; then
        echo "fake docker tag=${AI_TRADING_IMAGE_TAG:-unset} $*" >>"$s48/app/docker.log"
        return 0
      fi
      command docker "$@"
    }
    run_scenario "$s48" "$new48"
  )
)"
unset DEPLOY_SH_CONFIG_FAIL_AFTER
if [[ "$status" == 0 ]]; then
  fail "case48: expected non-zero exit for a forced config-stage failure, got 0"
fi
last_tag48="$(grep '^fake docker tag=' "$s48/app/docker.log" 2>/dev/null | tail -1)"
echo "$last_tag48" | grep -q "tag=$good48 " || fail "case48: rollback's previous-tag redeploy must use AI_TRADING_IMAGE_TAG=$good48 (effective Compose precedence), got: $last_tag48"
echo "$last_tag48" | grep -q "tag=$new48" && fail "case48: rollback must never carry the stale new tag ($new48) into compose, got: $last_tag48"
echo "    exit=$status last=$last_tag48"

# Cases 49-51 (A10a fix round 1, review): the required staged-Compose
# preflight, and the active-config symlink/non-regular-path rejection both
# findings called for. All three also double as the "failures must safely
# roll back any already-staged secrets, never bypass the trap via an
# unchecked exit" regression: each seeds real secrets content via the
# existing render/stage path, then asserts those secrets actually roll back
# when the NEW validation fails -- which only holds if validate_staged_
# config_file/validate_active_config_path/validate_staged_compose report
# via `return 1`, never `die()`'s raw `exit 1` (empirically confirmed to
# bypass an already-armed ERR trap entirely).

echo "=== Case 49 (RED, REAL docker compose, A10a fix round 1): a genuinely malformed staged Compose file is rejected by the real 'docker compose config' parser BEFORE any active-config mutation -- the one real-Docker probe proving stage_configs() actually parses, not a fake 'always succeeds' stand-in -- and secrets staged earlier in this same run still roll back ==="
CASE_COUNT=$((CASE_COUNT + 1))
if ! docker compose version >/dev/null 2>&1; then
  echo "    SKIP: docker compose not available in this environment"
else
  s49="$(new_scratch case49)"
  printf 'TUNNEL_TOKEN=fake-tunnel-token\n' >"$s49/ci-staging/cloudflared.env"
  for name in docker-compose.yml docker-compose.mirofish.yml Caddyfile health-check.sh; do
    printf 'OLD_ACTIVE_CONFIG=%s\n' "$name" >"$s49/app/$name"
  done
  chmod 0755 "$s49/app/health-check.sh"
  # Deliberately invalid YAML (not merely semantically wrong) so the real
  # parser, not a schema-aware linter, is what rejects it.
  printf 'name: ai-trading-fixture\nservices:\n  web:\n  : not valid yaml :::\n' >"$s49/config-staging/docker-compose.yml"
  status="$(
    (
      APP_DIR="$s49/app"
      AI_TRADING_SECRETS_DIR="$s49/secrets"
      ENV_STAGING_DIR="$s49/ci-staging"
      APP_CONFIG_STAGING_DIR="$s49/config-staging"
      FAMILY_CONFIG_CREDENTIALS="$s49/fake-reader-key.json"
      DEPLOY_SH_SKIP_CHOWN=1
      IMAGE_TAG=0000000000000000000000000000000000000000
      export APP_DIR AI_TRADING_SECRETS_DIR ENV_STAGING_DIR APP_CONFIG_STAGING_DIR FAMILY_CONFIG_CREDENTIALS DEPLOY_SH_SKIP_CHOWN IMAGE_TAG
      # shellcheck source=/dev/null
      source "$LIB_FILE"
      # Deliberately NO fake `docker` here -- this is the one case that must
      # exercise the real parser.
      render_profiles
      stage_secrets
      stage_configs
    )
    echo "$?"
  )"
  if [[ "$status" == 0 ]]; then
    fail "case49: expected non-zero exit for a malformed staged Compose file, got 0"
  fi
  for name in docker-compose.yml docker-compose.mirofish.yml Caddyfile health-check.sh; do
    grep -q "OLD_ACTIVE_CONFIG=$name" "$s49/app/$name" 2>/dev/null || fail "case49: $name must stay completely untouched -- Compose validation must reject before any backup/install"
  done
  shopt -s nullglob
  leftover49=("$s49/app"/.config-backup-*)
  shopt -u nullglob
  [[ ${#leftover49[@]} -eq 0 ]] || fail "case49: no config backup scratch should exist -- validation runs before CONFIG_STAGED/backups: ${leftover49[*]}"
  shopt -s nullglob
  leftover_secrets49=("$s49/secrets"/*.env)
  shopt -u nullglob
  [[ ${#leftover_secrets49[@]} -eq 0 ]] || fail "case49: secrets staged earlier in this same run must roll back too (a validation failure must not bypass the already-armed rollback trap via an unchecked exit): ${leftover_secrets49[*]}"
  echo "    exit=$status"
fi

echo "=== Case 50 (RED, A10a fix round 1): an existing ACTIVE config path that is a symlink is rejected before any backup/CONFIG_STAGED -- genuine absence is the only CONFIG_PRIOR_EXISTED=0 case, a symlink is never silently treated as absent or backed up -- and secrets staged earlier in this same run still roll back ==="
CASE_COUNT=$((CASE_COUNT + 1))
s50="$(new_scratch case50)"
printf 'TUNNEL_TOKEN=fake-tunnel-token\n' >"$s50/ci-staging/cloudflared.env"
printf 'REAL_OLD_TARGET=1\n' >"$s50/real-old-caddyfile-target"
ln -s "$s50/real-old-caddyfile-target" "$s50/app/Caddyfile"
status="$(run_scenario "$s50")"
if [[ "$status" == 0 ]]; then
  fail "case50: expected non-zero exit when an active config path is a symlink, got 0"
fi
[[ -L "$s50/app/Caddyfile" ]] || fail "case50: the active Caddyfile symlink must be left exactly as it was -- rejection happens before any mutation"
shopt -s nullglob
leftover50=("$s50/app"/.config-backup-*)
shopt -u nullglob
[[ ${#leftover50[@]} -eq 0 ]] || fail "case50: no config backup scratch should exist -- the symlink check runs before CONFIG_STAGED/backups: ${leftover50[*]}"
shopt -s nullglob
leftover_secrets50=("$s50/secrets"/*.env)
shopt -u nullglob
[[ ${#leftover_secrets50[@]} -eq 0 ]] || fail "case50: secrets staged earlier in this same run must roll back too: ${leftover_secrets50[*]}"
echo "    exit=$status"

echo "=== Case 51 (RED, A10a fix round 1): an existing ACTIVE config path that is a directory (not a regular file) is rejected before any backup/CONFIG_STAGED -- and secrets staged earlier in this same run still roll back ==="
CASE_COUNT=$((CASE_COUNT + 1))
s51="$(new_scratch case51)"
printf 'TUNNEL_TOKEN=fake-tunnel-token\n' >"$s51/ci-staging/cloudflared.env"
mkdir -p "$s51/app/health-check.sh"
status="$(run_scenario "$s51")"
if [[ "$status" == 0 ]]; then
  fail "case51: expected non-zero exit when an active config path is a directory, got 0"
fi
[[ -d "$s51/app/health-check.sh" ]] || fail "case51: the active directory must be left exactly as it was -- rejection happens before any mutation"
shopt -s nullglob
leftover51=("$s51/app"/.config-backup-*)
shopt -u nullglob
[[ ${#leftover51[@]} -eq 0 ]] || fail "case51: no config backup scratch should exist: ${leftover51[*]}"
shopt -s nullglob
leftover_secrets51=("$s51/secrets"/*.env)
shopt -u nullglob
[[ ${#leftover_secrets51[@]} -eq 0 ]] || fail "case51: secrets staged earlier in this same run must roll back too: ${leftover_secrets51[*]}"
echo "    exit=$status"

# Cases 52-53 (final fix wave, whole-branch review reopen round 2): the
# first-bootstrap Important defect final-review.md found, reproduced and
# fixed against REAL Docker Compose -- no faked `docker`/`compose` anywhere
# below, matching Case 31's own real-fixture technique, but this time with
# genuinely NO docker-compose.yml ever written into $APP_DIR (Case 31 was
# the one case final-review.md flagged as pre-seeding it, masking the exact
# failure mode).

echo "=== Case 52 (GREEN, REAL docker, whole-branch review reopen round 2): genuine first bootstrap -- \$APP_DIR has no docker-compose.yml at all and no real container exists for this disposable project -- real ensure_mirofish_stopped() succeeds without ever needing Compose's -f, fixing the real empty-\$APP_DIR bootstrap failure final-review.md found ==="
CASE_COUNT=$((CASE_COUNT + 1))
if ! docker compose version >/dev/null 2>&1; then
  echo "    SKIP: docker compose not available in this environment"
else
  s52="$TEST_ROOT/case52"
  mkdir -p "$s52/app"
  proj52="mirofish-bootstrap-fixture-$$"
  # Deliberately no docker-compose.yml/docker-compose.mirofish.yml anywhere
  # under $s52/app, and no container for this unique disposable project
  # name exists either -- the exact genuine-first-bootstrap condition
  # final-review.md's Important finding describes (stage_configs() has not
  # installed anything yet).
  result52="$(
    (
      IMAGE_TAG=0000000000000000000000000000000000000000
      APP_DIR="$s52/app"
      DEPLOY_SH_COMPOSE_PROJECT="$proj52"
      export IMAGE_TAG APP_DIR DEPLOY_SH_COMPOSE_PROJECT
      # shellcheck source=/dev/null
      source "$LIB_FILE"
      # Deliberately no fake docker/compose here -- the real binaries are
      # exactly what used to fail on this path.
      ensure_mirofish_stopped
      echo DEPLOY_PROCEEDED
    ) 2>"$s52/stderr.log"
  )"
  status52=$?
  if [[ "$status52" != 0 ]]; then
    fail "case52: expected exit 0 on a genuine first bootstrap with no active config and no owned container, got $status52: $(cat "$s52/stderr.log" 2>/dev/null)"
  fi
  echo "$result52" | grep -q DEPLOY_PROCEEDED || fail "case52: expected ensure_mirofish_stopped to succeed and let the deploy proceed"
  grep -qi 'no such file' "$s52/stderr.log" 2>/dev/null && fail "case52: must never surface a generic Compose 'no such file' error on a genuine first bootstrap: $(cat "$s52/stderr.log")"
  echo "    exit=$status52"
fi

echo "=== Case 53 (RED, REAL docker, whole-branch review reopen round 2): a real mirofish container exists for this project but \$APP_DIR/docker-compose.yml is genuinely missing -- real ensure_mirofish_stopped() refuses to guess and fails the deploy with a clear diagnosis instead of a generic Compose error (owned-missing-config denial) ==="
CASE_COUNT=$((CASE_COUNT + 1))
if ! docker compose version >/dev/null 2>&1; then
  echo "    SKIP: docker compose not available in this environment"
else
  s53="$TEST_ROOT/case53"
  mkdir -p "$s53/bringup" "$s53/app"
  proj53="mirofish-denial-fixture-$$"
  cat >"$s53/bringup/docker-compose.mirofish.yml" <<EOF
name: $proj53
services:
  mirofish:
    image: busybox:1
    command: ["sleep", "infinity"]
    profiles: ["mirofish"]
EOF
  ok53=1
  # Bring up a real, owned mirofish container under its own bring-up
  # directory -- $s53/app (the directory ensure_mirofish_stopped will be
  # pointed at below) never gets a docker-compose.yml at all, so the
  # container is genuinely "owned" (real compose project/service labels)
  # while its active base config is genuinely missing.
  if ! COMPOSE_PROFILES=mirofish docker compose --project-name "$proj53" -f "$s53/bringup/docker-compose.mirofish.yml" up -d --wait --wait-timeout 30 >"$s53/up.log" 2>&1; then
    fail "case53: real 'docker compose up' failed: $(cat "$s53/up.log" 2>/dev/null)"
    ok53=0
  fi
  if [[ "$ok53" == 1 ]]; then
    # Bare subshell + `|| status=$?` (not a `result="$(...)"` assignment --
    # under this script's own top-level `set -e`, a *failing* command
    # substitution inside a plain assignment aborts the whole test script,
    # same bash quirk Case 8/9/27/30 already route around this same way;
    # this case, unlike Case 52, expects a genuine non-zero exit).
    status53=0
    (
      IMAGE_TAG=0000000000000000000000000000000000000000
      APP_DIR="$s53/app"
      DEPLOY_SH_COMPOSE_PROJECT="$proj53"
      export IMAGE_TAG APP_DIR DEPLOY_SH_COMPOSE_PROJECT
      # shellcheck source=/dev/null
      source "$LIB_FILE"
      ensure_mirofish_stopped
      echo DEPLOY_PROCEEDED
    ) >"$s53/stdout.log" 2>"$s53/stderr.log" || status53=$?
    [[ "$status53" != 0 ]] || fail "case53: expected non-zero exit when an owned container exists but the active config is missing, got 0: $(cat "$s53/stdout.log" 2>/dev/null)"
    grep -q DEPLOY_PROCEEDED "$s53/stdout.log" 2>/dev/null && fail "case53: deploy must not proceed when an owned container exists with no active config to manage it"
    grep -q 'no active .*docker-compose.yml to manage it with' "$s53/stderr.log" 2>/dev/null || fail "case53: expected the owned-missing-config diagnosis: $(cat "$s53/stderr.log" 2>/dev/null)"
    if ! docker ps -a --filter "label=com.docker.compose.project=$proj53" --format '{{.Names}}' | grep -q mirofish; then
      fail "case53: the real mirofish container must still exist -- this function must refuse to guess, not silently remove it via an unverified path"
    fi
    echo "    exit=$status53"
  fi
  # Teardown: always attempt, regardless of pass/fail above, so no real
  # Docker resource from this test ever lingers (same belt-and-suspenders
  # as Case 31's own teardown -- `down` alone occasionally leaves the
  # auto-created network behind).
  docker compose --project-name "$proj53" -f "$s53/bringup/docker-compose.mirofish.yml" down -v --remove-orphans >/dev/null 2>&1 || true
  docker rm -f "${proj53}-mirofish-1" >/dev/null 2>&1 || true
  docker network rm "${proj53}_default" >/dev/null 2>&1 || true
fi

echo "=== Case 54 (SP5, RED): a legacy gateway barrier is reversible without changing the installed Caddyfile or any app container ==="
CASE_COUNT=$((CASE_COUNT + 1))
s54="$(new_scratch case54)"
printf 'old Caddyfile fixture\n' >"$s54/app/Caddyfile"
printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n' >"$s54/app/last-good-tag"
cat >"$s54/app/docker-compose.yml" <<EOF
services:
  gateway:
    image: caddy:2-alpine
    volumes:
      - "$s54/app/Caddyfile:/etc/caddy/Caddyfile:ro"
EOF
mkdir -p "$s54/run"
(
  APP_DIR="$s54/app"
  AI_TRADING_SECRETS_DIR="$s54/secrets"
  APP_CONFIG_STAGING_DIR="$s54/config-staging"
  AI_TRADING_STATE_DIR="$s54/control-state"
  IMAGE_TAG=0000000000000000000000000000000000000000
  export APP_DIR AI_TRADING_SECRETS_DIR APP_CONFIG_STAGING_DIR AI_TRADING_STATE_DIR IMAGE_TAG
  # shellcheck source=/dev/null
  source "$LIB_FILE"
  VIBE_ADMISSION_MARKER="$s54/run/vibe-admission-paused"
  compose() {
    if [[ "$*" == *'ps -q gateway'* ]]; then printf 'old-gateway-id\n'; return; fi
    printf '%s | tag=%s\n' "$*" "$IMAGE_TAG" >>"$s54/compose.log"
  }
  systemd-run() { printf '%s\n' "$*" >>"$s54/timer.log"; }
  systemctl() { printf '%s\n' "$*" >>"$s54/timer.log"; }
  docker() {
    if [[ "$1" == inspect ]]; then printf '%s\n' "$APP_CONFIG_STAGING_DIR/Caddyfile"; return; fi
    printf '%s\n' "$*" >>"$s54/docker.log"
  }

  enter_legacy_barrier old-vibe-container || exit 1
  [[ -f "$VIBE_ADMISSION_MARKER" ]] || exit 1
  [[ "$(cat "$APP_DIR/Caddyfile")" == 'old Caddyfile fixture' ]] || exit 1
  grep -qF "$APP_CONFIG_STAGING_DIR/Caddyfile:/etc/caddy/Caddyfile:ro" "$BOOTSTRAP_OVERRIDE" || exit 1
  env docker compose -f "$APP_DIR/docker-compose.yml" -f "$BOOTSTRAP_OVERRIDE" config --format json >"$s54/merged.json" || exit 1
  python3 - "$s54/merged.json" "$APP_CONFIG_STAGING_DIR/Caddyfile" <<'PY' || exit 1
import json, os, sys
volumes = json.load(open(sys.argv[1]))["services"]["gateway"]["volumes"]
mounted = [os.path.realpath(volume["source"]) for volume in volumes if volume["target"] == "/etc/caddy/Caddyfile"]
assert mounted == [os.path.realpath(sys.argv[2])], mounted
PY
  (( $(wc -l <"$s54/compose.log") == 1 )) || exit 1
  grep -q 'gateway | tag=' "$s54/compose.log" || exit 1
  grep -q 'tag=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' "$s54/compose.log" || exit 1
  leave_legacy_barrier || exit 1
  [[ ! -e "$VIBE_ADMISSION_MARKER" ]] || exit 1
  [[ "$(cat "$APP_DIR/Caddyfile")" == 'old Caddyfile fixture' ]] || exit 1
  (( $(wc -l <"$s54/compose.log") == 2 )) || exit 1
  [[ -f "$s54/timer.log" ]] || exit 1
) || fail "case54: legacy marker/override must activate and roll back gateway only"

echo "=== Case 55 (SP5, RED): old Vibe file preflight counts chat and private runs; corrupt state fails closed ==="
CASE_COUNT=$((CASE_COUNT + 1))
s55="$(new_scratch case55)"
# Old Vibe gets these paths from VIBE_TRADING_HOME (or its user home), not
# from the unrelated /app/agent/sessions and /app/agent/.swarm/runs mounts.
mkdir -p "$s55/runtime/sessions/s/attempts/a" "$s55/runtime/swarm/runs/.committee/r"
printf '{"status":"running"}\n' >"$s55/runtime/sessions/s/attempts/a/attempt.json"
printf '{"status":"pending"}\n' >"$s55/runtime/swarm/runs/.committee/r/run.json"
(
  APP_DIR="$s55/app"
  AI_TRADING_SECRETS_DIR="$s55/secrets"
  APP_CONFIG_STAGING_DIR="$s55/config-staging"
  IMAGE_TAG=0000000000000000000000000000000000000000
  export APP_DIR AI_TRADING_SECRETS_DIR APP_CONFIG_STAGING_DIR IMAGE_TAG
  # shellcheck source=/dev/null
  source "$LIB_FILE"
  docker() {
    [[ "$1" == exec ]] || return 1
    local previous='' script=''
    shift
    while (($#)); do
      if [[ "$previous" == -c ]]; then script="$1"; break; fi
      previous="$1"
      shift
    done
    [[ -n "$script" ]] || return 1
    VIBE_TRADING_HOME="$s55/runtime" python3 -c "$script"
  }
  counts55="$(legacy_active_counts old-vibe-container)" || exit 1
  [[ "$counts55" == '1 1' ]] || exit 1
  printf '{\n' >"$s55/runtime/swarm/runs/.committee/r/run.json"
  if legacy_active_counts old-vibe-container >/dev/null 2>&1; then
    exit 1
  fi
) || fail "case55: malformed old-image state must not be interpreted as idle"

echo "=== Case 56 (SP5, RED): legacy activity past 60 minutes aborts without touching the installed release ==="
CASE_COUNT=$((CASE_COUNT + 1))
s56="$(new_scratch case56)"
printf 'old Caddyfile fixture\n' >"$s56/app/Caddyfile"
printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n' >"$s56/app/last-good-tag"
cp "$s56/config-staging/docker-compose.yml" "$s56/app/docker-compose.yml"
mkdir -p "$s56/run"
(
  APP_DIR="$s56/app"
  AI_TRADING_SECRETS_DIR="$s56/secrets"
  APP_CONFIG_STAGING_DIR="$s56/config-staging"
  AI_TRADING_STATE_DIR="$s56/control-state"
  IMAGE_TAG=0000000000000000000000000000000000000000
  export APP_DIR AI_TRADING_SECRETS_DIR APP_CONFIG_STAGING_DIR AI_TRADING_STATE_DIR IMAGE_TAG
  # shellcheck source=/dev/null
  source "$LIB_FILE"
  VIBE_ADMISSION_MARKER="$s56/run/vibe-admission-paused"
  fake_now=100
  vibe_monotonic_seconds() { echo "$fake_now"; }
  sleep() { fake_now=$((fake_now + 900)); }
  legacy_active_counts() { echo '1 0'; }
  compose() {
    if [[ "$*" == *'ps -q gateway'* ]]; then printf 'old-gateway-id\n'; return; fi
    printf '%s | tag=%s\n' "$*" "$IMAGE_TAG" >>"$s56/compose.log"
  }
  systemd-run() { return 0; }
  systemctl() { return 0; }
  docker() { if [[ "$1" == inspect ]]; then printf '%s\n' "$APP_CONFIG_STAGING_DIR/Caddyfile"; fi; }
  enter_legacy_barrier old-vibe-container || exit 1
  if wait_for_legacy_idle old-vibe-container; then
    exit 1
  fi
  leave_legacy_barrier || exit 1
  [[ ! -e "$VIBE_ADMISSION_MARKER" ]] || exit 1
  [[ "$(cat "$APP_DIR/Caddyfile")" == 'old Caddyfile fixture' ]] || exit 1
  (( $(wc -l <"$s56/compose.log") == 2 )) || exit 1
) || fail "case56: timed-out legacy gate must restore the prior gateway without replacing Vibe"

echo "=== Case 57 (SP5, RED): an old cleanup cannot delete a later attempt's admission marker ==="
CASE_COUNT=$((CASE_COUNT + 1))
s57="$(new_scratch case57)"
printf 'old Caddyfile fixture\n' >"$s57/app/Caddyfile"
printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n' >"$s57/app/last-good-tag"
cp "$s57/config-staging/docker-compose.yml" "$s57/app/docker-compose.yml"
mkdir -p "$s57/run"
(
  APP_DIR="$s57/app"
  AI_TRADING_SECRETS_DIR="$s57/secrets"
  APP_CONFIG_STAGING_DIR="$s57/config-staging"
  AI_TRADING_STATE_DIR="$s57/control-state"
  IMAGE_TAG=0000000000000000000000000000000000000000
  export APP_DIR AI_TRADING_SECRETS_DIR APP_CONFIG_STAGING_DIR AI_TRADING_STATE_DIR IMAGE_TAG
  # shellcheck source=/dev/null
  source "$LIB_FILE"
  VIBE_ADMISSION_MARKER="$s57/run/vibe-admission-paused"
  compose() { if [[ "$*" == *'ps -q gateway'* ]]; then echo old-gateway-id; fi; }
  timer_args=()
  systemd-run() { timer_args=("$@"); }
  systemctl() { return 0; }
  docker() { if [[ "$1" == inspect ]]; then printf '%s\n' "$APP_CONFIG_STAGING_DIR/Caddyfile"; fi; }
  enter_legacy_barrier old-vibe-container || exit 1
  printf 'later-attempt\n' >"$VIBE_ADMISSION_MARKER"
  [[ "${timer_args[4]}" == -c ]] || exit 1
  python3 -c "${timer_args[5]}" "${timer_args[6]}" "${timer_args[7]}" || exit 1
  [[ "$(cat "$VIBE_ADMISSION_MARKER")" == 'later-attempt' ]] || exit 1
  if leave_legacy_barrier; then exit 1; fi
  [[ "$(cat "$VIBE_ADMISSION_MARKER")" == 'later-attempt' ]] || exit 1
) || fail "case57: cleanup must refuse to remove someone else's newer marker"

echo "=== Case 58 (SP5, RED): expiry timer failure aborts before a marker or gateway restart ==="
CASE_COUNT=$((CASE_COUNT + 1))
s58="$(new_scratch case58)"
printf 'old Caddyfile fixture\n' >"$s58/app/Caddyfile"
printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n' >"$s58/app/last-good-tag"
cp "$s58/config-staging/docker-compose.yml" "$s58/app/docker-compose.yml"
mkdir -p "$s58/run"
(
  APP_DIR="$s58/app"
  AI_TRADING_SECRETS_DIR="$s58/secrets"
  APP_CONFIG_STAGING_DIR="$s58/config-staging"
  AI_TRADING_STATE_DIR="$s58/control-state"
  IMAGE_TAG=0000000000000000000000000000000000000000
  export APP_DIR AI_TRADING_SECRETS_DIR APP_CONFIG_STAGING_DIR AI_TRADING_STATE_DIR IMAGE_TAG
  # shellcheck source=/dev/null
  source "$LIB_FILE"
  VIBE_ADMISSION_MARKER="$s58/run/vibe-admission-paused"
  systemd-run() { return 1; }
  compose() { printf '%s\n' "$*" >>"$s58/compose.log"; }
  if enter_legacy_barrier old-vibe-container; then exit 1; fi
  [[ ! -e "$VIBE_ADMISSION_MARKER" ]] || exit 1
  [[ ! -e "$s58/compose.log" ]] || exit 1
  [[ "$(cat "$APP_DIR/Caddyfile")" == 'old Caddyfile fixture' ]] || exit 1
) || fail "case58: unarmed expiry must never leave an admission marker or change the gateway"

echo "=== Case 59 (SP5): unexpected pre-switch exit restores gateway, marker and lifecycle lock ==="
CASE_COUNT=$((CASE_COUNT + 1))
s59="$(new_scratch case59)"
printf 'old Caddyfile fixture\n' >"$s59/app/Caddyfile"
printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n' >"$s59/app/last-good-tag"
cp "$s59/config-staging/docker-compose.yml" "$s59/app/docker-compose.yml"
mkdir -p "$s59/run"
if (
  APP_DIR="$s59/app"
  AI_TRADING_SECRETS_DIR="$s59/secrets"
  APP_CONFIG_STAGING_DIR="$s59/config-staging"
  AI_TRADING_STATE_DIR="$s59/control-state"
  IMAGE_TAG=0000000000000000000000000000000000000000
  export APP_DIR AI_TRADING_SECRETS_DIR APP_CONFIG_STAGING_DIR AI_TRADING_STATE_DIR IMAGE_TAG
  # shellcheck source=/dev/null
  source "$LIB_FILE"
  VIBE_ADMISSION_MARKER="$s59/run/vibe-admission-paused"
  compose() {
    if [[ "$*" == *'ps -q gateway'* ]]; then echo old-gateway-id; return; fi
    printf '%s\n' "$*" >>"$s59/compose.log"
  }
  systemd-run() { return 0; }
  systemctl() { return 0; }
  docker() { if [[ "$1" == inspect ]]; then printf '%s\n' "$APP_CONFIG_STAGING_DIR/Caddyfile"; fi; }
  acquire_lifecycle_lock || exit 1
  enter_legacy_barrier old-vibe-container || exit 1
  exit 17
); then
  fail "case59: deliberately aborted child exited successfully"
else
  status59=$?
  [[ "$status59" == 17 ]] || fail "case59: expected explicit exit 17, got $status59"
fi
[[ ! -e "$s59/run/vibe-admission-paused" ]] || fail "case59: EXIT cleanup left marker"
(( $(wc -l <"$s59/compose.log") == 2 )) || fail "case59: EXIT cleanup did not restore gateway"
[[ "$(cat "$s59/app/Caddyfile")" == 'old Caddyfile fixture' ]] || fail "case59: EXIT cleanup changed installed Caddyfile"
python3 - "$s59/control-state/.control.lock" <<'PY' || fail "case59: lifecycle lock remained held"
import fcntl, sys
with open(sys.argv[1], "r+") as handle:
    fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
PY

echo "=== Case 60 (SP5, RED): routine drain waits for chat and detached committee, renewing its lease ==="
CASE_COUNT=$((CASE_COUNT + 1))
s60="$(new_scratch case60)"
printf '0\n' >"$s60/checks"
printf '0\n' >"$s60/renews"
(
  APP_DIR="$s60/app"
  AI_TRADING_SECRETS_DIR="$s60/secrets"
  APP_CONFIG_STAGING_DIR="$s60/config-staging"
  IMAGE_TAG=0000000000000000000000000000000000000000
  export APP_DIR AI_TRADING_SECRETS_DIR APP_CONFIG_STAGING_DIR IMAGE_TAG
  # shellcheck source=/dev/null
  source "$LIB_FILE"
  fake_now=100
  vibe_monotonic_seconds() { echo "$fake_now"; }
  sleep() { fake_now=$((fake_now + 10)); }
  vibe_drain_request() {
    case "$2" in
      status)
        local checks
        checks="$(cat "$s60/checks")"
        echo "$((checks + 1))" >"$s60/checks"
        case "$checks" in
          0) printf '{"active_chat":1,"active_private_committees":0}\n' ;;
          1) printf '{"active_chat":0,"active_private_committees":1}\n' ;;
          *) printf '{"active_chat":0,"active_private_committees":0}\n' ;;
        esac
        ;;
      renew)
        local renews
        renews="$(cat "$s60/renews")"
        echo "$((renews + 1))" >"$s60/renews"
        printf '{"status":"renewed"}\n'
        ;;
      *) return 1 ;;
    esac
  }
  wait_for_vibe_idle old-vibe-container fake-lease || exit 1
  [[ "$(cat "$s60/checks")" == 3 ]] || exit 1
  [[ "$(cat "$s60/renews")" == 3 ]] || exit 1
) || fail "case60: a detached committee cannot be mistaken for idle and the lease must renew"

echo "=== Case 61 (SP5, RED): private research at 60 minutes times out before active state changes ==="
CASE_COUNT=$((CASE_COUNT + 1))
s61="$(new_scratch case61)"
printf 'old Caddyfile fixture\n' >"$s61/app/Caddyfile"
printf 'OLD_VALUE=old-vibe\n' >"$s61/secrets/vibe-trading.env"
chmod 0600 "$s61/secrets/vibe-trading.env"
snapshot61="$(shasum -a 256 "$s61/app/Caddyfile" "$s61/secrets/vibe-trading.env" "$s61/control-state/control.json")"
(
  APP_DIR="$s61/app"
  AI_TRADING_SECRETS_DIR="$s61/secrets"
  APP_CONFIG_STAGING_DIR="$s61/config-staging"
  IMAGE_TAG=0000000000000000000000000000000000000000
  export APP_DIR AI_TRADING_SECRETS_DIR APP_CONFIG_STAGING_DIR IMAGE_TAG
  # shellcheck source=/dev/null
  source "$LIB_FILE"
  fake_now=100
  vibe_monotonic_seconds() { echo "$fake_now"; }
  sleep() { fake_now=$((fake_now + 900)); }
  vibe_drain_request() {
    case "$2" in
      status) printf '{"active_chat":0,"active_private_committees":1}\n' ;;
      renew) printf '{"status":"renewed"}\n' ;;
      *) return 1 ;;
    esac
  }
  declare -F wait_for_vibe_idle >/dev/null || exit 1
  if wait_for_vibe_idle old-vibe-container fake-lease; then exit 1; fi
) || fail "case61: active private committee must time out at the bounded deadline"
[[ "$(shasum -a 256 "$s61/app/Caddyfile" "$s61/secrets/vibe-trading.env" "$s61/control-state/control.json")" == "$snapshot61" ]] || fail "case61: timeout changed installed state"
[[ ! -d "$s61/secrets/.previous" ]] || fail "case61: timeout staged live secret files"

echo "=== Case 62 (SP5, RED): a slow final status response cannot turn an expired 60-minute wait into success ==="
CASE_COUNT=$((CASE_COUNT + 1))
s62="$(new_scratch case62)"
printf '100\n' >"$s62/clock"
(
  APP_DIR="$s62/app"
  AI_TRADING_SECRETS_DIR="$s62/secrets"
  APP_CONFIG_STAGING_DIR="$s62/config-staging"
  IMAGE_TAG=0000000000000000000000000000000000000000
  export APP_DIR AI_TRADING_SECRETS_DIR APP_CONFIG_STAGING_DIR IMAGE_TAG
  # shellcheck source=/dev/null
  source "$LIB_FILE"
  vibe_monotonic_seconds() { cat "$s62/clock"; }
  vibe_drain_request() {
    case "$2" in
      status)
        printf '3701\n' >"$s62/clock"
        printf '{"active_chat":0,"active_private_committees":0}\n'
        ;;
      renew) printf '{"status":"renewed"}\n' ;;
      *) return 1 ;;
    esac
  }
  declare -F wait_for_vibe_idle >/dev/null || exit 1
  if wait_for_vibe_idle old-vibe-container fake-lease; then exit 1; fi
) || fail "case62: status after the deadline must not authorize a container replacement"

echo "=== Case 63 (SP5, RED): container-local drain client keeps the lease and API key out of Docker arguments ==="
CASE_COUNT=$((CASE_COUNT + 1))
s63="$(new_scratch case63)"
(
  APP_DIR="$s63/app"
  AI_TRADING_SECRETS_DIR="$s63/secrets"
  APP_CONFIG_STAGING_DIR="$s63/config-staging"
  IMAGE_TAG=0000000000000000000000000000000000000000
  export APP_DIR AI_TRADING_SECRETS_DIR APP_CONFIG_STAGING_DIR IMAGE_TAG
  # shellcheck source=/dev/null
  source "$LIB_FILE"
  docker() {
    printf '%s\n' "$*" >>"$s63/docker-args.log"
    [[ "$1" == exec && "$2" == -i && "$3" == old-vibe-container ]] || return 1
    local action="${*: -1}" stdin_lease
    stdin_lease="$(cat)"
    printf '%s:%s\n' "$action" "$stdin_lease" >>"$s63/stdin.log"
    case "$action" in
      probe) printf '{"http_status":409}\n' ;;
      start) printf '{"lease":"fake-private-lease-abcdef1234567890","active_chat":0,"active_private_committees":0}\n' ;;
      status) printf '{"active_chat":0,"active_private_committees":0}\n' ;;
      renew) printf '{"status":"renewed"}\n' ;;
      release) printf '{"status":"released"}\n' ;;
      *) return 1 ;;
    esac
  }
  declare -F vibe_drain_request >/dev/null || exit 1
  probe63="$(vibe_drain_request old-vibe-container probe)" || { echo 'case63: probe request failed' >&2; exit 1; }
  [[ "$(python3 -c 'import json,sys; print(json.load(sys.stdin)["http_status"])' <<<"$probe63")" == 409 ]] || { echo 'case63: probe status mismatch' >&2; exit 1; }
  start63="$(vibe_drain_request old-vibe-container start)" || { echo 'case63: start request failed' >&2; exit 1; }
  [[ "$(python3 -c 'import json,sys; print(json.load(sys.stdin)["lease"])' <<<"$start63")" == fake-private-lease-abcdef1234567890 ]] || { echo 'case63: lease response mismatch' >&2; exit 1; }
  vibe_drain_request old-vibe-container status fake-private-lease-abcdef1234567890 >/dev/null || { echo 'case63: status request failed' >&2; exit 1; }
  vibe_drain_request old-vibe-container renew fake-private-lease-abcdef1234567890 >/dev/null || { echo 'case63: renew request failed' >&2; exit 1; }
  vibe_drain_request old-vibe-container release fake-private-lease-abcdef1234567890 >/dev/null || { echo 'case63: release request failed' >&2; exit 1; }
  grep -q '^status:fake-private-lease-abcdef1234567890$' "$s63/stdin.log" || { echo 'case63: lease was not received on stdin' >&2; exit 1; }
  if grep -qF 'fake-private-lease-abcdef1234567890' "$s63/docker-args.log"; then
    echo 'case63: lease entered Docker arguments' >&2
    exit 1
  fi
  if grep -qF 'fake-api-key' "$s63/docker-args.log"; then
    echo 'case63: API key entered Docker arguments' >&2
    exit 1
  fi
  true
) || fail "case63: drain client must use the existing key inside Vibe and pass the lease by stdin only"

echo "=== Case 64 (SP5, RED): saved off choices skip drain, running new Vibe probes and guards the same container ==="
CASE_COUNT=$((CASE_COUNT + 1))
s64="$(new_scratch case64)"
mkdir -p "$s64/run"
(
  APP_DIR="$s64/app"
  AI_TRADING_SECRETS_DIR="$s64/secrets"
  APP_CONFIG_STAGING_DIR="$s64/config-staging"
  IMAGE_TAG=0000000000000000000000000000000000000000
  export APP_DIR AI_TRADING_SECRETS_DIR APP_CONFIG_STAGING_DIR IMAGE_TAG
  # shellcheck source=/dev/null
  source "$LIB_FILE"
  VIBE_ADMISSION_MARKER="$s64/run/vibe-admission-paused"
  systemd-run() { return 0; }
  systemctl() { return 0; }
  FAKE_DESIRED=false
  FAKE_VIBE_ID=old-vibe-container
  read_desired_vibe() { echo "$FAKE_DESIRED"; }
  vibe_container_ids() { [[ -z "$FAKE_VIBE_ID" ]] || echo "$FAKE_VIBE_ID"; }
  vibe_drain_request() {
    printf '%s\n' "$2" >>"$s64/actions.log"
    case "$2" in
      probe) printf '{"http_status":409}\n' ;;
      start) printf '{"lease":"fake-private-lease-abcdef1234567890"}\n' ;;
      status) if [[ "${FAKE_STATUS_INVALID:-}" == 1 ]]; then printf 'not-json\n'; else printf '{"active_chat":0,"active_private_committees":0}\n'; fi ;;
      renew) printf '{"status":"renewed"}\n' ;;
      *) return 1 ;;
    esac
  }
  declare -F begin_vibe_release_gate >/dev/null || exit 1
  begin_vibe_release_gate || exit 1
  [[ "$VIBE_GATE_MODE" == none && ! -e "$s64/actions.log" ]] || exit 1
  FAKE_DESIRED=true
  FAKE_VIBE_ID=''
  begin_vibe_release_gate || exit 1
  [[ "$VIBE_GATE_MODE" == none && ! -e "$s64/actions.log" ]] || exit 1
  FAKE_VIBE_ID=old-vibe-container
  begin_vibe_release_gate || exit 1
  [[ "$VIBE_GATE_MODE" == runtime && "$VIBE_GATE_CONTAINER_ID" == old-vibe-container ]] || exit 1
  [[ "$VIBE_DRAIN_LEASE" == fake-private-lease-abcdef1234567890 ]] || exit 1
  verify_vibe_gate_before_switch || exit 1
  FAKE_VIBE_ID=replaced-vibe-container
  if verify_vibe_gate_before_switch; then exit 1; fi
  FAKE_VIBE_ID=old-vibe-container
  FAKE_STATUS_INVALID=1
  if verify_vibe_gate_before_switch; then exit 1; fi
  FAKE_STATUS_INVALID=0
  # Read by verify_vibe_gate_before_switch() in the sourced library.
  # shellcheck disable=SC2034
  BOOTSTRAP_STARTED=100
  vibe_monotonic_seconds() { echo 4100; }
  if verify_vibe_gate_before_switch; then exit 1; fi
  clear_vibe_admission_marker || exit 1
  [[ ! -e "$VIBE_ADMISSION_MARKER" ]] || exit 1
) || fail "case64: only selected running Vibe drains, and a stale container/status never authorizes switch"

echo "=== Case 65 (SP5, RED): only an authenticated 404 selects legacy; auth, transport and malformed probe fail closed ==="
CASE_COUNT=$((CASE_COUNT + 1))
s65="$(new_scratch case65)"
(
  APP_DIR="$s65/app"
  AI_TRADING_SECRETS_DIR="$s65/secrets"
  APP_CONFIG_STAGING_DIR="$s65/config-staging"
  IMAGE_TAG=0000000000000000000000000000000000000000
  export APP_DIR AI_TRADING_SECRETS_DIR APP_CONFIG_STAGING_DIR IMAGE_TAG
  # shellcheck source=/dev/null
  source "$LIB_FILE"
  read_desired_vibe() { echo true; }
  vibe_container_ids() { echo old-vibe-container; }
  enter_legacy_barrier() { echo called >>"$s65/legacy.log"; return 0; }
  wait_for_legacy_idle() { return 0; }
  vibe_drain_request() { [[ "${FAKE_PROBE_ERROR:-}" != 1 ]] || return 1; printf '%s\n' "$FAKE_PROBE_REPLY"; }
  declare -F begin_vibe_release_gate >/dev/null || exit 1
  for FAKE_PROBE_REPLY in '{"http_status":401}' '{"http_status":403}' '{"http_status":503}' '{"invalid":true}' ; do
    if begin_vibe_release_gate; then exit 1; fi
    [[ ! -e "$s65/legacy.log" ]] || exit 1
  done
  FAKE_PROBE_ERROR=1
  if begin_vibe_release_gate; then exit 1; fi
  [[ ! -e "$s65/legacy.log" ]] || exit 1
  FAKE_PROBE_ERROR=0
  FAKE_PROBE_REPLY='{"http_status":404}'
  begin_vibe_release_gate || exit 1
  [[ "$VIBE_GATE_MODE" == legacy ]] || exit 1
  [[ "$(cat "$s65/legacy.log")" == called ]] || exit 1
) || fail "case65: 401/403/503/malformed/transport failures must never be treated as a legacy image"

echo "=== Case 65b (SP5 regression): the legacy SPA fallback is probe-only; neighboring responses fail closed ==="
CASE_COUNT=$((CASE_COUNT + 1))
s65b="$(new_scratch case65b)"
(
  APP_DIR="$s65b/app"
  AI_TRADING_SECRETS_DIR="$s65b/secrets"
  APP_CONFIG_STAGING_DIR="$s65b/config-staging"
  IMAGE_TAG=0000000000000000000000000000000000000000
  export APP_DIR AI_TRADING_SECRETS_DIR APP_CONFIG_STAGING_DIR IMAGE_TAG
  # shellcheck source=/dev/null
  source "$LIB_FILE"
  read_desired_vibe() { echo true; }
  vibe_container_ids() { echo old-vibe-container; }
  enter_legacy_barrier() { echo called >>"$s65b/legacy.log"; return 0; }
  wait_for_legacy_idle() { return 0; }
  docker() {
    [[ "$1" == exec && "$2" == -i && "$3" == old-vibe-container && "$4" == python && "$5" == -c ]] || return 1
    local embedded="$6" action="$7"
    API_AUTH_KEY=fake-api-key python3 -c '
import email.message
import io
import os
import sys
import urllib.error
import urllib.request

embedded, action = sys.argv[1:]

class Response:
    status = 200

    def __init__(self):
        self.headers = email.message.Message()
        self.headers["Content-Type"] = os.environ.get("FAKE_CONTENT_TYPE", "application/json")

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def getcode(self):
        return self.status

    def read(self):
        return os.environ.get("FAKE_BODY", "").encode()

class Opener:
    def open(self, request, timeout):
        failure = os.environ.get("FAKE_FAILURE", "")
        if failure == "transport":
            raise OSError("synthetic transport failure")
        if failure.startswith("http-"):
            code = int(failure.removeprefix("http-"))
            raise urllib.error.HTTPError(
                request.full_url, code, "synthetic HTTP failure",
                email.message.Message(), io.BytesIO(b""),
            )
        return Response()

urllib.request.build_opener = lambda *_args: Opener()
sys.argv = ["vibe-drain-client", action]
exec(compile(embedded, "<vibe-drain-client>", "exec"), {"__name__": "__main__"})
' "$embedded" "$action"
  }
  expect_probe_denied() {
    rm -f "$s65b/legacy.log"
    VIBE_GATE_MODE=none
    if begin_vibe_release_gate; then return 1; fi
    [[ ! -e "$s65b/legacy.log" ]]
  }

  export FAKE_FAILURE='' FAKE_CONTENT_TYPE='text/html; charset=utf-8'
  export FAKE_BODY='<!doctype html><html><body>legacy SPA</body></html>'
  begin_vibe_release_gate || exit 1
  [[ "$VIBE_GATE_MODE" == legacy && "$(cat "$s65b/legacy.log")" == called ]] || exit 1

  for code in 404 409; do
    export FAKE_FAILURE="http-$code"
    reply="$(vibe_drain_request old-vibe-container probe)" || exit 1
    [[ "$(python3 -c 'import json,sys; print(json.load(sys.stdin)["http_status"])' <<<"$reply")" == "$code" ]] || exit 1
  done

  export FAKE_FAILURE=''
  export FAKE_CONTENT_TYPE=application/json FAKE_BODY='{"legacy":true}'
  expect_probe_denied || exit 1
  export FAKE_CONTENT_TYPE=text/plain FAKE_BODY='legacy SPA'
  expect_probe_denied || exit 1
  export FAKE_CONTENT_TYPE=text/html FAKE_BODY=''
  expect_probe_denied || exit 1
  export FAKE_CONTENT_TYPE=application/json FAKE_BODY='{'
  expect_probe_denied || exit 1
  for FAKE_FAILURE in http-401 http-403 http-500 transport; do
    export FAKE_FAILURE
    expect_probe_denied || exit 1
  done

  export FAKE_FAILURE='' FAKE_CONTENT_TYPE=text/html
  export FAKE_BODY='<!doctype html><html><body>legacy SPA</body></html>'
  for action in start status renew release; do
    if vibe_drain_request old-vibe-container "$action" fake-lease >/dev/null; then exit 1; fi
  done
) || fail "case65b: only a nonempty invalid-JSON 200 HTML probe may map to the bounded legacy 404 envelope"

echo "=== Case 66 (SP5, RED): process-level drain failure aborts before preferences, secrets or containers change ==="
CASE_COUNT=$((CASE_COUNT + 1))
s66="$(new_scratch case66)"
mkdir -p "$s66/run"
printf 'TUNNEL_TOKEN=fake-tunnel-token\n' >"$s66/ci-staging/cloudflared.env"
printf 'old Caddyfile fixture\n' >"$s66/app/Caddyfile"
cp "$s66/config-staging/docker-compose.yml" "$s66/app/docker-compose.yml"
printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n' >"$s66/app/last-good-tag"
printf 'OLD_VALUE=old-vibe\n' >"$s66/secrets/vibe-trading.env"
chmod 0600 "$s66/secrets/vibe-trading.env"
snapshot66="$(shasum -a 256 "$s66/control-state/control.json" "$s66/secrets/vibe-trading.env" "$s66/app/Caddyfile" "$s66/app/last-good-tag")"
status66=0
(
  APP_DIR="$s66/app"
  AI_TRADING_SECRETS_DIR="$s66/secrets"
  ENV_STAGING_DIR="$s66/ci-staging"
  APP_CONFIG_STAGING_DIR="$s66/config-staging"
  AI_TRADING_STATE_DIR="$s66/control-state"
  AI_TRADING_UNIT_DIR="$s66/unit-dir"
  AI_TRADING_RUNTIME_ENV_DIR="$s66/runtime"
  AI_TRADING_DOCKER_DATA_DIR="$s66/app"
  AI_TRADING_MIN_FREE_GB=0
  FAMILY_CONFIG_CREDENTIALS="$s66/fake-reader-key.json"
  DEPLOY_SH_SKIP_CHOWN=1
  AI_TRADING_VIBE_ADMISSION_MARKER="$s66/run/vibe-admission-paused"
  IMAGE_TAG=0000000000000000000000000000000000000000
  MIROFISH_ACTIVATE=1
  export APP_DIR AI_TRADING_SECRETS_DIR ENV_STAGING_DIR APP_CONFIG_STAGING_DIR AI_TRADING_STATE_DIR AI_TRADING_UNIT_DIR AI_TRADING_RUNTIME_ENV_DIR AI_TRADING_DOCKER_DATA_DIR AI_TRADING_MIN_FREE_GB FAMILY_CONFIG_CREDENTIALS DEPLOY_SH_SKIP_CHOWN AI_TRADING_VIBE_ADMISSION_MARKER IMAGE_TAG MIROFISH_ACTIVATE
  # shellcheck disable=SC2329
  docker() {
    printf 'fake docker %s\n' "$*" >>"$APP_DIR/docker.log"
    case "${1:-}" in
      ps)
        [[ "$*" == *'label=com.docker.compose.service=vibe-trading'* ]] && echo old-vibe-container
        return 0
        ;;
      images | rmi | compose) return 0 ;;
      exec)
        printf '%s\n' "${*: -1}" >>"$APP_DIR/drain-actions.log"
        [[ "${*: -1}" == probe ]] && { printf '{"http_status":409}\n'; return 0; }
        [[ "${*: -1}" == start ]] && { printf '{"lease":"fake-private-lease-abcdef1234567890"}\n'; return 0; }
        [[ "${*: -1}" == status ]] && { printf 'not-json\n'; return 0; }
        [[ "${*: -1}" == release ]] && { printf '{"status":"released"}\n'; return 0; }
        return 1
        ;;
    esac
    return 1
  }
  export -f docker
  # Any mistaken legacy classification fails before its marker; never run
  # real systemd or write to /run from this process-level offline case.
  systemd-run() { return 1; }
  export -f systemd-run
  install_fake_systemctl "$s66"
  bash "$DEPLOY_SH" >"$s66/stdout.log" 2>"$s66/stderr.log"
) || status66=$?
[[ "$status66" != 0 ]] || fail "case66: expected the malformed status to abort deployment"
[[ "$(shasum -a 256 "$s66/control-state/control.json" "$s66/secrets/vibe-trading.env" "$s66/app/Caddyfile" "$s66/app/last-good-tag")" == "$snapshot66" ]] || fail "case66: drain failure changed installed state"
grep -qx release "$s66/app/drain-actions.log" || fail "case66: the old Vibe lease was not released on abort"
grep -qE 'fake docker compose .* up -d' "$s66/app/docker.log" && fail "case66: drain failure replaced an app container"
[[ ! -d "$s66/secrets/.previous" ]] || fail "case66: drain failure staged active secrets"

echo "=== Case 67 (SP5, RED): forward Compose refuses lease loss before up; rollback tag skips this old-process gate ==="
CASE_COUNT=$((CASE_COUNT + 1))
s67="$(new_scratch case67)"
(
  APP_DIR="$s67/app"
  AI_TRADING_SECRETS_DIR="$s67/secrets"
  APP_CONFIG_STAGING_DIR="$s67/config-staging"
  AI_TRADING_STATE_DIR="$s67/control-state"
  IMAGE_TAG=0000000000000000000000000000000000000000
  export APP_DIR AI_TRADING_SECRETS_DIR APP_CONFIG_STAGING_DIR AI_TRADING_STATE_DIR IMAGE_TAG
  # shellcheck source=/dev/null
  source "$LIB_FILE"
  VIBE_GATE_MODE=runtime
  VIBE_GATE_CONTAINER_ID=old-vibe-container
  VIBE_DRAIN_LEASE=fake-private-lease-abcdef1234567890
  compose() { printf '%s\n' "$*" >>"$s67/compose.log"; }
  verify_vibe_gate_before_switch() { echo verify >>"$s67/checks.log"; return 1; }
  apply_selected_services() {
    if [[ "$IMAGE_TAG" == "$TARGET_IMAGE_TAG" ]]; then
      [[ "$FORWARD_SWITCH_STARTED" == 0 ]] || return 1
      FORWARD_SWITCH_STARTED=1
    fi
    echo app-up >>"$s67/checks.log"
  }
  stop_disabled_groups() { return 0; }
  if deploy_tag "$IMAGE_TAG"; then exit 1; fi
  [[ "$(cat "$s67/checks.log")" == verify ]] || exit 1
  [[ "$(cat "$s67/compose.log")" == *pull* ]] || exit 1
  deploy_tag aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa || exit 1
  [[ "$(grep -c '^verify$' "$s67/checks.log")" == 1 ]] || exit 1
  [[ "$(grep -c '^app-up$' "$s67/checks.log")" == 1 ]] || exit 1
  verify_vibe_gate_before_switch() { echo verify >>"$s67/checks.log"; return 0; }
  deploy_tag "$TARGET_IMAGE_TAG" || exit 1
  [[ "$FORWARD_SWITCH_STARTED" == 1 ]] || exit 1
  [[ "$(grep -c '^app-up$' "$s67/checks.log")" == 2 ]] || exit 1
) || fail "case67: forward deploy must gate before up; rollback must not require the dead forward lease"

echo "=== Case 68 (SP5, RED): lease loss after staging restores old files without restarting Vibe ==="
CASE_COUNT=$((CASE_COUNT + 1))
s68="$(new_scratch case68)"
mkdir -p "$s68/run"
printf 'TUNNEL_TOKEN=fake-tunnel-token\n' >"$s68/ci-staging/cloudflared.env"
printf 'old Caddyfile fixture\n' >"$s68/app/Caddyfile"
cp "$s68/config-staging/docker-compose.yml" "$s68/app/docker-compose.yml"
printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n' >"$s68/app/last-good-tag"
printf 'AI_TRADING_REGISTRY=ghcr.io/thangtran3112/family-app\nAI_TRADING_IMAGE_TAG=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nAI_TRADING_SECRETS_DIR=%s\n' "$s68/secrets" >"$s68/app/images.env"
for name in tradingagents.env ai-hedge-fund.env vibe-trading.env vibe-gateway.env vibe-consensus.env auth.env market-data.env desk.env cloudflared.env; do
  printf 'OLD_VALUE=old-%s\n' "$name" >"$s68/secrets/$name"
  chmod 0600 "$s68/secrets/$name"
done
snapshot68="$(shasum -a 256 "$s68/secrets/vibe-trading.env" "$s68/secrets/auth.env" "$s68/app/Caddyfile" "$s68/app/images.env" "$s68/app/last-good-tag")"
desired68="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["desired"])' "$s68/control-state/control.json")"
printf '0\n' >"$s68/app/status-checks"
status68=0
(
  APP_DIR="$s68/app"
  AI_TRADING_SECRETS_DIR="$s68/secrets"
  ENV_STAGING_DIR="$s68/ci-staging"
  APP_CONFIG_STAGING_DIR="$s68/config-staging"
  AI_TRADING_STATE_DIR="$s68/control-state"
  AI_TRADING_UNIT_DIR="$s68/unit-dir"
  AI_TRADING_RUNTIME_ENV_DIR="$s68/runtime"
  AI_TRADING_DOCKER_DATA_DIR="$s68/app"
  AI_TRADING_MIN_FREE_GB=0
  FAMILY_CONFIG_CREDENTIALS="$s68/fake-reader-key.json"
  DEPLOY_SH_SKIP_CHOWN=1
  AI_TRADING_VIBE_ADMISSION_MARKER="$s68/run/vibe-admission-paused"
  IMAGE_TAG=0000000000000000000000000000000000000000
  export APP_DIR AI_TRADING_SECRETS_DIR ENV_STAGING_DIR APP_CONFIG_STAGING_DIR AI_TRADING_STATE_DIR AI_TRADING_UNIT_DIR AI_TRADING_RUNTIME_ENV_DIR AI_TRADING_DOCKER_DATA_DIR AI_TRADING_MIN_FREE_GB FAMILY_CONFIG_CREDENTIALS DEPLOY_SH_SKIP_CHOWN AI_TRADING_VIBE_ADMISSION_MARKER IMAGE_TAG
  # shellcheck disable=SC2329
  docker() {
    printf 'fake docker %s\n' "$*" >>"$APP_DIR/docker.log"
    case "${1:-}" in
      ps)
        [[ "$*" == *'label=com.docker.compose.service=vibe-trading'* ]] && echo old-vibe-container
        return 0
        ;;
      images | rmi | compose) return 0 ;;
      exec)
        local action="${*: -1}"
        printf '%s\n' "$action" >>"$APP_DIR/drain-actions.log"
        case "$action" in
          probe) printf '{"http_status":409}\n' ;;
          start) printf '{"lease":"fake-private-lease-abcdef1234567890"}\n' ;;
          status)
            local n
            n="$(cat "$APP_DIR/status-checks")"
            printf '%s\n' "$((n + 1))" >"$APP_DIR/status-checks"
            if [[ "$n" == 0 ]]; then printf '{"active_chat":0,"active_private_committees":0}\n'; else printf 'not-json\n'; fi
            ;;
          renew) printf '{"status":"renewed"}\n' ;;
          release) printf '{"status":"released"}\n' ;;
          *) return 1 ;;
        esac
        return 0
        ;;
    esac
    return 1
  }
  export -f docker
  # shellcheck disable=SC2329
  stat() { fake_stat "$@"; }
  export -f stat fake_stat
  systemd-run() { return 0; }
  export -f systemd-run
  install_fake_systemctl "$s68"
  bash "$DEPLOY_SH" >"$s68/stdout.log" 2>"$s68/stderr.log"
) || status68=$?
[[ "$status68" != 0 ]] || fail "case68: expected the second status to abort before Compose up"
actions68="$(tr '\n' ',' <"$s68/app/drain-actions.log" 2>/dev/null || true)"
ps_calls68="$(grep -c '^fake docker ps ' "$s68/app/docker.log" 2>/dev/null || true)"
[[ "$(cat "$s68/app/status-checks")" == 2 ]] || fail "case68: expected one idle status and one pre-switch recheck; got $(cat "$s68/app/status-checks") (exit $status68, ps=$ps_calls68, actions=$actions68): $(grep '^deploy:' "$s68/stderr.log" | tail -n 3)"
[[ "$(shasum -a 256 "$s68/secrets/vibe-trading.env" "$s68/secrets/auth.env" "$s68/app/Caddyfile" "$s68/app/images.env" "$s68/app/last-good-tag")" == "$snapshot68" ]] || fail "case68: pre-switch rollback did not restore old active files"
[[ "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["desired"])' "$s68/control-state/control.json")" == "$desired68" ]] || fail "case68: old app choices changed"
grep -q 'fake docker compose .* up -d' "$s68/app/docker.log" && fail "case68: pre-switch rollback restarted Vibe despite no container switch"
grep -qx release "$s68/app/drain-actions.log" || fail "case68: pre-switch abort did not release the old Vibe lease"
[[ ! -e "$s68/run/vibe-admission-paused" ]] || fail "case68: pre-switch abort left admission paused"

echo "=== Case 69 (SP5, RED): pre-switch rollback restores only a prior running MiroFish, never restarts Vibe ==="
CASE_COUNT=$((CASE_COUNT + 1))
s69="$(new_scratch case69)"
printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n' >"$s69/app/last-good-tag"
printf 'AI_TRADING_REGISTRY=ghcr.io/thangtran3112/family-app\nAI_TRADING_IMAGE_TAG=0000000000000000000000000000000000000000\nAI_TRADING_SECRETS_DIR=%s\n' "$s69/secrets" >"$s69/app/images.env"
printf 'old Caddyfile fixture\n' >"$s69/app/Caddyfile"
cp "$s69/config-staging/docker-compose.yml" "$s69/app/docker-compose.yml"
cp "$s69/config-staging/docker-compose.mirofish.yml" "$s69/app/docker-compose.mirofish.yml"
python3 - "$s69/control-state/control.json" <<'PY'
import json, sys
path = sys.argv[1]
with open(path, encoding="utf-8") as handle:
    state = json.load(handle)
state["desired"]["mirofish"] = True
with open(path, "w", encoding="utf-8") as handle:
    json.dump(state, handle)
PY
chmod 0600 "$s69/control-state/control.json"
status69=0
(
  APP_DIR="$s69/app"
  AI_TRADING_SECRETS_DIR="$s69/secrets"
  APP_CONFIG_STAGING_DIR="$s69/config-staging"
  AI_TRADING_STATE_DIR="$s69/control-state"
  IMAGE_TAG=0000000000000000000000000000000000000000
  export APP_DIR AI_TRADING_SECRETS_DIR APP_CONFIG_STAGING_DIR AI_TRADING_STATE_DIR IMAGE_TAG
  # shellcheck source=/dev/null
  source "$LIB_FILE"
  # shellcheck disable=SC2030
  VIBE_GATE_MODE=runtime
  VIBE_GATE_CONTAINER_ID=old-vibe-container
  VIBE_DRAIN_LEASE=fake-private-lease-abcdef1234567890
  # Read by rollback() in the sourced deploy library.
  # shellcheck disable=SC2034
  FORWARD_SWITCH_STARTED=0
  # shellcheck disable=SC2034
  MIROFISH_WAS_RUNNING=1
  ENV_STAGING_DIR=''
  # Read by restore_preferences_on_rollback() in the sourced library.
  # shellcheck disable=SC2034
  CONTROL_SNAPSHOT_PATH=''
  compose() {
    printf '%s\n' "$*" >>"$s69/compose.log"
    [[ "$*" == *'up -d'*mirofish* ]] && touch "$s69/mirofish-running"
    return 0
  }
  apply_selected_services() { echo 'up vibe-trading' >>"$s69/compose.log"; }
  stop_disabled_groups() { return 0; }
  mirofish_running_ids() { [[ -f "$s69/mirofish-running" ]] && echo existing-id; return 0; }
  rollback 1
) || status69=$?
[[ "$status69" == 1 ]] || fail "case69: rollback should preserve the original failure status"
[[ -f "$s69/mirofish-running" ]] || fail "case69: previous MiroFish group was not restored"
grep -q 'up vibe-trading' "$s69/compose.log" && fail "case69: pre-switch rollback restarted Vibe"
[[ "$(grep -c 'up -d.*mirofish' "$s69/compose.log")" == 1 ]] || fail "case69: only MiroFish may be recreated"
grep -q 'AI_TRADING_IMAGE_TAG=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' "$s69/app/images.env" || fail "case69: images.env did not return to the old tag"

echo "=== Case 70 (SP5, RED): routine drain holds the Caddy marker through switch without restarting gateway ==="
CASE_COUNT=$((CASE_COUNT + 1))
s70="$(new_scratch case70)"
printf 'old Caddyfile fixture\n' >"$s70/app/Caddyfile"
mkdir -p "$s70/run"
(
  APP_DIR="$s70/app"
  AI_TRADING_SECRETS_DIR="$s70/secrets"
  APP_CONFIG_STAGING_DIR="$s70/config-staging"
  AI_TRADING_STATE_DIR="$s70/control-state"
  IMAGE_TAG=0000000000000000000000000000000000000000
  export APP_DIR AI_TRADING_SECRETS_DIR APP_CONFIG_STAGING_DIR AI_TRADING_STATE_DIR IMAGE_TAG
  # shellcheck source=/dev/null
  source "$LIB_FILE"
  VIBE_ADMISSION_MARKER="$s70/run/vibe-admission-paused"
  read_desired_vibe() { echo true; }
  vibe_container_ids() { echo old-vibe-container; }
  vibe_drain_request() {
    case "$2" in
      probe) printf '{"http_status":409}\n' ;;
      start) printf '{"lease":"fake-private-lease-abcdef1234567890"}\n' ;;
      status) printf '{"active_chat":0,"active_private_committees":0}\n' ;;
      renew) printf '{"status":"renewed"}\n' ;;
      release) printf '{"status":"released"}\n' ;;
      *) return 1 ;;
    esac
  }
  compose() { echo unexpected-gateway-restart >>"$s70/compose.log"; return 1; }
  systemd-run() { printf '%s\n' "$*" >>"$s70/timer.log"; }
  systemctl() { return 0; }
  begin_vibe_release_gate || exit 1
  # shellcheck disable=SC2031
  [[ "$VIBE_GATE_MODE" == runtime && "$LEGACY_GATE_ACTIVE" == 0 ]] || exit 1
  [[ -f "$VIBE_ADMISSION_MARKER" ]] || exit 1
  legacy_marker_owned || exit 1
  verify_vibe_gate_before_switch || exit 1
  clear_vibe_admission_marker || exit 1
  [[ ! -e "$VIBE_ADMISSION_MARKER" && ! -e "$s70/compose.log" ]] || exit 1
) || fail "case70: routine cutover must block only new chats at Caddy until release commit"

# Process-level coverage of the handoff after the old lease is idle. Caddy's
# real marker behavior is proved by smoke-test.sh; these fakes pin its lifetime
# through Compose health, commit and rollback without touching the host /run.
run_runtime_marker_scenario() {
  local base="$1" fail_health="$2"
  printf 'TUNNEL_TOKEN=fake-tunnel-token\n' >"$base/ci-staging/cloudflared.env"
  printf 'old Caddyfile fixture\n' >"$base/app/Caddyfile"
  cp "$base/config-staging/docker-compose.yml" "$base/app/docker-compose.yml"
  printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n' >"$base/app/last-good-tag"
  printf 'old-vibe-container\n' >"$base/app/running-container-id"
  mkdir -p "$base/run"
  if [[ "$fail_health" == 1 ]]; then
    printf '#!/usr/bin/env bash\nexit 1\n' >"$base/config-staging/health-check.sh"
    chmod 0755 "$base/config-staging/health-check.sh"
  fi
  (
    APP_DIR="$base/app"
    AI_TRADING_SECRETS_DIR="$base/secrets"
    ENV_STAGING_DIR="$base/ci-staging"
    APP_CONFIG_STAGING_DIR="$base/config-staging"
    AI_TRADING_STATE_DIR="$base/control-state"
    AI_TRADING_UNIT_DIR="$base/unit-dir"
    AI_TRADING_RUNTIME_ENV_DIR="$base/runtime"
    AI_TRADING_DOCKER_DATA_DIR="$base/app"
    AI_TRADING_MIN_FREE_GB=0
    FAMILY_CONFIG_CREDENTIALS="$base/fake-reader-key.json"
    DEPLOY_SH_SKIP_CHOWN=1
    AI_TRADING_VIBE_ADMISSION_MARKER="$base/run/vibe-admission-paused"
    FAKE_STEAL_MARKER="$fail_health"
    IMAGE_TAG=0000000000000000000000000000000000000000
    MIROFISH_ACTIVATE=keep
    export APP_DIR AI_TRADING_SECRETS_DIR ENV_STAGING_DIR APP_CONFIG_STAGING_DIR AI_TRADING_STATE_DIR AI_TRADING_UNIT_DIR AI_TRADING_RUNTIME_ENV_DIR AI_TRADING_DOCKER_DATA_DIR AI_TRADING_MIN_FREE_GB FAMILY_CONFIG_CREDENTIALS DEPLOY_SH_SKIP_CHOWN AI_TRADING_VIBE_ADMISSION_MARKER FAKE_STEAL_MARKER IMAGE_TAG MIROFISH_ACTIVATE
    # shellcheck disable=SC2329
    docker() {
      printf 'fake docker %s\n' "$*" >>"$APP_DIR/docker.log"
      case "${1:-}" in
        ps)
          [[ "$*" == *'label=com.docker.compose.service=vibe-trading'* ]] && cat "$APP_DIR/running-container-id"
          return 0
          ;;
        images | rmi) return 0 ;;
        exec)
          case "${*: -1}" in
            probe) printf '{"http_status":409}\n' ;;
            start) printf '{"lease":"fake-private-lease-abcdef1234567890"}\n' ;;
            status) printf '{"active_chat":0,"active_private_committees":0}\n' ;;
            renew) printf '{"status":"renewed"}\n' ;;
            release) printf '{"status":"released"}\n' ;;
            *) return 1 ;;
          esac
          return 0
          ;;
        compose)
          if [[ "$*" == *' up -d '* ]]; then
            if [[ -f "$AI_TRADING_VIBE_ADMISSION_MARKER" ]]; then
              echo held >>"$APP_DIR/marker-observed.log"
            else
              echo missing >>"$APP_DIR/marker-observed.log"
            fi
            local count=0
            [[ -f "$APP_DIR/up-count" ]] && count="$(cat "$APP_DIR/up-count")"
            printf '%s\n' "$((count + 1))" >"$APP_DIR/up-count"
            if [[ "$count" == 0 ]]; then
              printf 'new-vibe-container\n' >"$APP_DIR/running-container-id"
              [[ "$FAKE_STEAL_MARKER" == 2 ]] && printf 'later-attempt\n' >"$AI_TRADING_VIBE_ADMISSION_MARKER"
            else
              printf 'old-vibe-container\n' >"$APP_DIR/running-container-id"
            fi
          fi
          return 0
          ;;
      esac
      return 1
    }
    export -f docker fake_stat
    # shellcheck disable=SC2329
    stat() { fake_stat "$@"; }
    export -f stat
    systemd-run() { return 0; }
    export -f systemd-run
    install_fake_systemctl "$base"
    bash "$DEPLOY_SH" >"$base/stdout.log" 2>"$base/stderr.log"
  )
}

echo "=== Case 71 (SP5): healthy forward release holds admission through Compose and commits before reopening ==="
CASE_COUNT=$((CASE_COUNT + 1))
s71="$(new_scratch case71)"
status71=0
run_runtime_marker_scenario "$s71" 0 || status71=$?
[[ "$status71" == 0 ]] || fail "case71: healthy fake release failed: $(grep '^deploy:' "$s71/stderr.log" | tail -n 2)"
[[ "$(cat "$s71/app/marker-observed.log" 2>/dev/null)" == held ]] || fail "case71: new Vibe was exposed before admission barrier"
[[ ! -e "$s71/run/vibe-admission-paused" ]] || fail "case71: successful release left new chats paused"
[[ "$(cat "$s71/app/last-good-tag")" == 0000000000000000000000000000000000000000 ]] || fail "case71: release tag did not commit"

echo "=== Case 72 (SP5): failed health check keeps admission paused through old-tag rollback ==="
CASE_COUNT=$((CASE_COUNT + 1))
s72="$(new_scratch case72)"
status72=0
run_runtime_marker_scenario "$s72" 1 || status72=$?
[[ "$status72" != 0 ]] || fail "case72: expected health failure to trigger rollback"
[[ "$(cat "$s72/app/marker-observed.log" 2>/dev/null)" == $'held\nheld' ]] || fail "case72: marker disappeared before rollback finished"
[[ ! -e "$s72/run/vibe-admission-paused" ]] || fail "case72: rollback left old chat admission paused"
[[ "$(cat "$s72/app/last-good-tag")" == aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ]] || fail "case72: rollback changed last-good-tag"

echo "=== Case 73 (SP5, RED): lost marker after release commit reports applied-but-gated, never a false success or rollback ==="
CASE_COUNT=$((CASE_COUNT + 1))
s73="$(new_scratch case73)"
status73=0
run_runtime_marker_scenario "$s73" 2 || status73=$?
[[ "$status73" != 0 ]] || fail "case73: marker loss after commit must not report deploy success"
[[ "$(cat "$s73/app/last-good-tag")" == 0000000000000000000000000000000000000000 ]] || fail "case73: committed release must remain applied"
[[ "$(cat "$s73/run/vibe-admission-paused" 2>/dev/null)" == later-attempt ]] || fail "case73: cleanup removed another attempt's marker"
[[ "$(cat "$s73/app/up-count")" == 1 ]] || fail "case73: post-commit marker cleanup must not restart Vibe"
grep -q 'release applied but Vibe admission marker could not be cleared' "$s73/stderr.log" || fail "case73: operator did not get an applied-but-gated diagnosis"

echo
cleanup
if [[ "$FAIL_COUNT" -eq 0 ]]; then
  echo "RESULT: GREEN -- $CASE_COUNT cases, 0 failures"
  exit 0
else
  echo "RESULT: RED -- $CASE_COUNT cases, $FAIL_COUNT failure(s)"
  exit 1
fi
