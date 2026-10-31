#!/usr/bin/env bash
# Focused offline tests for Task 5 (app-controls): the Linux bootstrap
# (infrastructure/host/app-controls/install.sh) and the deploy.sh/
# health-check.sh behaviors test-deploy-firestore.sh's own existing suite
# does not already cover -- explicit selected-service Compose calls, the
# lifecycle lock's contention/inherited-FD behavior, preference
# snapshot/restore, and (fix round 1) the control helper's own
# code/catalog/unit transaction: a genuinely prior version must be
# captured and restored on failure, a genuine first activation must be
# rolled back (stopped/disabled), and the real health-check.sh must be
# proven to run through deploy.sh's actual call path, not just its
# functions in isolation. No real Firestore, VPS, host user/group, systemd
# unit, or Docker socket is used anywhere in this file; every fixture
# lives under a unique mktemp root removed on exit.
#
# install.sh's own Linux/systemd/Docker/user preconditions need a real
# Linux userland (id/getent/useradd/groupadd/systemctl) -- run inside a
# disposable, network-isolated python:3.12-slim container with every one
# of those commands faked via a PATH-prepended fixture bin directory
# (common-context's own "Run Linux-only control tests ... not macOS
# Python" guidance, applied here to the installer rather than the
# control/*.py suite). SKIPPED entirely when Docker is unavailable.
#
# Usage: infrastructure/apps/ai-trading/tests/test-app-controls-deploy.sh
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
AI_TRADING_DIR="$REPO_ROOT/ai-trading"
PROD_DIR="$SCRIPT_DIR/.."
DEPLOY_SH="$PROD_DIR/deploy.sh"
HEALTH_SH="$PROD_DIR/health-check.sh"
MIROFISH_LIB_SH="$PROD_DIR/mirofish-runtime.sh"
PREPARE_MIROFISH_SH="$PROD_DIR/prepare-mirofish.sh"
INSTALL_SH="$REPO_ROOT/infrastructure/host/app-controls/install.sh"
UNIT_FILE="$REPO_ROOT/infrastructure/host/app-controls/ai-trading-control.service"
CONTROL_DIR_REAL="$AI_TRADING_DIR/control"

[[ -f "$DEPLOY_SH" ]] || { echo "test-app-controls-deploy: missing $DEPLOY_SH" >&2; exit 1; }
[[ -f "$INSTALL_SH" ]] || { echo "test-app-controls-deploy: missing $INSTALL_SH" >&2; exit 1; }

# A real $HOME-rooted scratch directory, never /tmp or the opencode temp
# dir: on this host, Docker runs in a VM that only reliably bind-mounts
# $HOME (infrastructure/apps/ai-trading/tests/test-app-controls-gateway.sh documents the
# same finding). Removed on every exit.
TEST_ROOT="$HOME/.cache/ai-trading-app-controls-deploy-test-$$"
rm -rf "$TEST_ROOT"
mkdir -p "$TEST_ROOT"
chmod 0700 "$TEST_ROOT"
cleanup() { rm -rf "$TEST_ROOT"; }
trap cleanup EXIT

FAIL_COUNT=0
CASE_COUNT=0
fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  echo "    FAIL: $*" >&2
}

export AI_TRADING_CONTROL_OWNER_UID
AI_TRADING_CONTROL_OWNER_UID="$(id -u)"
export AI_TRADING_MIN_FREE_GB=0
export AI_TRADING_DOCKER_DATA_DIR="$TEST_ROOT"

# ---------------------------------------------------------------------
# Shared deploy.sh fixtures (same shapes test-deploy-firestore.sh uses).
# ---------------------------------------------------------------------

FIXTURE_UNIT_CONTENT='[Unit]
Description=fixture unit, not real production content
[Service]
Type=simple
ExecStart=/bin/true
[Install]
WantedBy=multi-user.target
'

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
umask 077
for target in "${targets[@]}"; do
  profile="${target##*/}"
  tmp="$(mktemp "$out_dir/.$profile.env.XXXXXX")"
  if [[ "$profile" == vibe-trading ]]; then
    printf 'API_AUTH_KEY=fake-vibe-key-not-real\n' >"$tmp"
  else
    printf 'FAKE_VALUE=fake-not-real-%s\n' "$profile" >"$tmp"
  fi
  mv -f "$tmp" "$out_dir/$profile.env"
done
FAKE_EOF
  chmod 0700 "$dest"
}

# stage_default_configs DIR [HEALTH_CONTENT_FILE]: writes minimal, inert
# fixtures for everything stage_configs()/stage_unit() now own. Passing a
# second argument stages that file's content as health-check.sh instead of
# the trivial `exit 0` stub -- used by the cases below that must exercise
# the REAL health-check.sh through deploy.sh's actual call path.
stage_default_configs() {
  local dir="$1"
  printf 'name: ai-trading-fixture\nservices:\n  web:\n    image: busybox:1\n' >"$dir/docker-compose.yml"
  printf 'name: ai-trading-fixture\nservices:\n  mirofish:\n    image: busybox:1\n    profiles: ["mirofish"]\n' >"$dir/docker-compose.mirofish.yml"
  printf '# fixture Caddyfile\n' >"$dir/Caddyfile"
  if [[ $# -ge 2 ]]; then
    cp "$2" "$dir/health-check.sh"
  else
    printf '#!/usr/bin/env bash\nexit 0\n' >"$dir/health-check.sh"
  fi
  chmod 0755 "$dir/health-check.sh"
  # mirofish-runtime.sh must be the REAL repo file (packaging-fix):
  # deploy.sh's own library-source guard now sources this exact staged
  # path (via $APP_CONFIG_STAGING_DIR) at the top of every case below, so a
  # stand-in here would define none of the functions the rest of deploy.sh
  # depends on.
  mkdir -p "$dir/control" "$dir/deploy/production"
  cp "$CONTROL_DIR_REAL/catalog.json" "$dir/control/catalog.json"
  cp "$CONTROL_DIR_REAL/state.py" "$dir/control/state.py"
  printf '"""fixture stand-in, new version."""\n' >"$dir/control/runtime.py"
  printf '"""fixture stand-in, new version."""\n' >"$dir/control/server.py"
  cp "$MIROFISH_LIB_SH" "$dir/deploy/production/mirofish-runtime.sh"
  printf '#!/usr/bin/env bash\n# fixture stand-in, new version.\nexit 0\n' >"$dir/deploy/production/prepare-mirofish.sh"
  chmod 0755 "$dir/deploy/production/prepare-mirofish.sh"
  printf '%s' "$FIXTURE_UNIT_CONTENT" >"$dir/ai-trading-control.service"
}

seed_control_state() {
  local dir="$1" desired="${2:-}"
  install -d -m 0700 "$dir"
  if [[ -n "$desired" ]]; then
    printf '%s' "$desired" >"$dir/control.json"
  else
    cat >"$dir/control.json" <<'EOF'
{"schemaVersion":1,"revision":0,"desired":{"tradingagents":true,"ai-hedge-fund":true,"vibe-trading":true,"mirofish":false},"results":{"tradingagents":null,"ai-hedge-fund":null,"vibe-trading":null,"mirofish":null},"lastChange":null,"operation":null}
EOF
  fi
  chmod 0600 "$dir/control.json"
}

new_scratch() {
  local name="$1" base="$TEST_ROOT/$1"
  mkdir -p "$base/app" "$base/secrets" "$base/ci-staging" "$base/config-staging" "$base/unit-dir"
  fake_family_config "$base/app/family_config.py"
  stage_default_configs "$base/config-staging"
  printf 'TUNNEL_TOKEN=fake-tunnel-token\n' >"$base/ci-staging/cloudflared.env"
  printf '%s\n' "$base"
}

# seed_prior_artifacts BASE MARKER: writes a genuinely-prior,
# distinguishable (never byte-identical to the staged "new" fixtures
# above) version of every control/* CONFIG_FILES entry and the systemd
# unit directly into $BASE/app and $BASE/unit-dir -- simulating exactly
# what a PREVIOUS successful deploy would have already left on disk before
# this run's own install.sh bootstrap (which never touches these paths)
# and deploy.sh both run (task-5-review fix round 1, Critical #1: "seed
# genuinely differing prior artifacts/unit").
seed_prior_artifacts() {
  local base="$1" marker="$2"
  mkdir -p "$base/app/control" "$base/app/deploy/production"
  printf '"""OLD control/catalog.json stand-in, marker=%s."""\n' "$marker" >"$base/app/control/catalog-marker.txt"
  printf '{"schemaVersion":1,"apps":{"tradingagents":["ta-terminal","ta-research"],"ai-hedge-fund":["ahf-terminal"],"vibe-trading":["vibe-trading"],"mirofish":["mirofish"]},"protected":["web","gateway","auth","cloudflared","market-data"],"comment":"OLD-%s"}\n' "$marker" >"$base/app/control/catalog.json"
  printf '"""OLD state.py stand-in, marker=%s. Never executed by this run (CONTROL_SCRATCH_DIR holds the real one); only its BYTES matter here."""\n' "$marker" >"$base/app/control/state.py"
  printf '"""OLD runtime.py stand-in, marker=%s."""\n' "$marker" >"$base/app/control/runtime.py"
  printf '"""OLD server.py stand-in, marker=%s."""\n' "$marker" >"$base/app/control/server.py"
  printf '#!/usr/bin/env bash\n# OLD mirofish-runtime.sh stand-in, marker=%s.\n' "$marker" >"$base/app/deploy/production/mirofish-runtime.sh"
  printf '#!/usr/bin/env bash\n# OLD prepare-mirofish.sh stand-in, marker=%s.\nexit 0\n' "$marker" >"$base/app/deploy/production/prepare-mirofish.sh"
  chmod 0755 "$base/app/deploy/production/prepare-mirofish.sh"
  printf '[Unit]\nDescription=OLD unit stand-in, marker=%s\n[Service]\nType=simple\nExecStart=/bin/true\n[Install]\nWantedBy=multi-user.target\n' "$marker" >"$base/unit-dir/ai-trading-control.service"
}

# fake_docker_log BASE: a fake docker() shim that always succeeds on
# `compose`/`ps`/`images`/`rmi`, logging every call to $BASE/docker.log --
# exported so a child `bash "$DEPLOY_SH"` process inherits it.
# shellcheck disable=SC2329
install_fake_docker() {
  local base="$1"
  # shellcheck disable=SC2317
  docker() {
    echo "fake docker $*" >>"$FAKE_DOCKER_LOG_BASE/docker.log"
    case "${1:-}" in
      compose | ps | images | rmi) return 0 ;;
    esac
    command docker "$@"
  }
  export -f docker
  FAKE_DOCKER_LOG_BASE="$base"
  export FAKE_DOCKER_LOG_BASE
}

# install_fake_systemctl BASE [is-active-exit] [is-enabled-exit]: a
# systemctl() shim logging every call to $BASE/systemctl.log. Real
# systemctl is NEVER invoked by these tests (root/systemd changes stay
# offline-fake only).
# shellcheck disable=SC2329
install_fake_systemctl() {
  local base="$1" active_exit="${2:-1}" enabled_exit="${3:-1}"
  FAKE_SYSTEMCTL_LOG_BASE="$base"
  FAKE_SYSTEMCTL_ACTIVE_EXIT="$active_exit"
  FAKE_SYSTEMCTL_ENABLED_EXIT="$enabled_exit"
  export FAKE_SYSTEMCTL_LOG_BASE FAKE_SYSTEMCTL_ACTIVE_EXIT FAKE_SYSTEMCTL_ENABLED_EXIT
  # shellcheck disable=SC2317
  systemctl() {
    echo "fake systemctl $*" >>"$FAKE_SYSTEMCTL_LOG_BASE/systemctl.log"
    case "${1:-}" in
      is-active) return "$FAKE_SYSTEMCTL_ACTIVE_EXIT" ;;
      is-enabled) return "$FAKE_SYSTEMCTL_ENABLED_EXIT" ;;
      *) return 0 ;;
    esac
  }
  export -f systemctl
}

echo "=== Case 1 (GREEN): explicit selected-service Compose up excludes a disabled group, stop targets exactly that group's services ==="
CASE_COUNT=$((CASE_COUNT + 1))
s1="$(new_scratch case1)"
seed_control_state "$s1/control-state" '{"schemaVersion":1,"revision":0,"desired":{"tradingagents":false,"ai-hedge-fund":true,"vibe-trading":true,"mirofish":false},"results":{"tradingagents":null,"ai-hedge-fund":null,"vibe-trading":null,"mirofish":null},"lastChange":null,"operation":null}'
status1=0
(
  APP_DIR="$s1/app"
  AI_TRADING_SECRETS_DIR="$s1/secrets"
  ENV_STAGING_DIR="$s1/ci-staging"
  APP_CONFIG_STAGING_DIR="$s1/config-staging"
  AI_TRADING_STATE_DIR="$s1/control-state"
  AI_TRADING_UNIT_DIR="$s1/unit-dir"
  FAMILY_CONFIG_CREDENTIALS="$s1/fake-reader-key.json"
  DEPLOY_SH_SKIP_CHOWN=1
  IMAGE_TAG=1111111111111111111111111111111111111111
  export APP_DIR AI_TRADING_SECRETS_DIR ENV_STAGING_DIR APP_CONFIG_STAGING_DIR AI_TRADING_STATE_DIR AI_TRADING_UNIT_DIR FAMILY_CONFIG_CREDENTIALS DEPLOY_SH_SKIP_CHOWN IMAGE_TAG
  install_fake_docker "$s1"
  install_fake_systemctl "$s1"
  # shellcheck disable=SC2329
  # shellcheck disable=SC2317
  stat() {
    if [[ "${1:-}" == -c && "${2:-}" == '%u:%a' ]]; then
      printf '0:%s\n' "$(command stat -c '%a' "$3" 2>/dev/null || command stat -f '%Lp' "$3" 2>/dev/null)"
    else
      command stat "$@"
    fi
  }
  export -f stat
  bash "$DEPLOY_SH" >"$s1/stdout.log" 2>"$s1/stderr.log"
) || status1=$?
if [[ "$status1" != 0 ]]; then
  fail "case1: expected exit 0, got $status1: $(cat "$s1/stderr.log" 2>/dev/null)"
else
  up_line="$(grep -m1 ' up -d' "$s1/docker.log" 2>/dev/null || true)"
  stop_line="$(grep -m1 ' stop --timeout 60' "$s1/docker.log" 2>/dev/null || true)"
  [[ -n "$up_line" ]] || fail "case1: expected a 'compose up' call"
  [[ -n "$stop_line" ]] || fail "case1: expected a 'compose stop' call for the disabled group"
  # Only the trailing SERVICE arguments matter here -- the earlier -f
  # .../docker-compose.mirofish.yml path argument itself always literally
  # contains the word "mirofish" and must not be mistaken for a selected
  # service.
  up_services=" ${up_line#*--wait-timeout 300} "
  stop_services=" ${stop_line#*--timeout 60} "
  echo "$up_services" | grep -qw ta-terminal && fail "case1: disabled ta-terminal must never appear in the 'up' call: $up_line"
  echo "$up_services" | grep -qw ta-research && fail "case1: disabled ta-research must never appear in the 'up' call: $up_line"
  echo "$up_services" | grep -qw ahf-terminal || fail "case1: enabled ahf-terminal must appear in the 'up' call: $up_line"
  echo "$up_services" | grep -qw mirofish && fail "case1: mirofish is desired off and must never appear in the 'up' call: $up_line"
  echo "$stop_services" | grep -qw ta-terminal || fail "case1: disabled ta-terminal must appear in the 'stop' call: $stop_line"
  echo "$stop_services" | grep -qw ta-research || fail "case1: disabled ta-research must appear in the 'stop' call: $stop_line"
  echo "$stop_services" | grep -qw ahf-terminal && fail "case1: enabled ahf-terminal must never appear in the 'stop' call: $stop_line"
  echo "$up_line" | grep -qw -- '--no-deps' || fail "case1: expected --no-deps on the 'up' call (never a blanket up)"
  echo "$up_line" | grep -q -- '--remove-orphans' && fail "case1: must never use --remove-orphans"
  grep -q 'systemctl enable ai-trading-control.service' "$s1/systemctl.log" 2>/dev/null || fail "case1: expected the unit to be enabled"
  grep -q 'systemctl restart ai-trading-control.service' "$s1/systemctl.log" 2>/dev/null || fail "case1: expected the unit to be (re)started"
fi
echo "    exit=$status1"

echo "=== Case 2 (RED->rollback, task-5-review fix round 1 Critical #1): a GENUINELY DIFFERING prior control/*/unit, the unit ACTIVE, and a later deploy_tag failure restores the OLD code/unit byte-for-byte and RESTARTS (never stops/disables) the matching prior version ==="
CASE_COUNT=$((CASE_COUNT + 1))
s2="$(new_scratch case2)"
seed_control_state "$s2/control-state" '{"schemaVersion":1,"revision":5,"desired":{"tradingagents":false,"ai-hedge-fund":true,"vibe-trading":true,"mirofish":false},"results":{"tradingagents":null,"ai-hedge-fund":null,"vibe-trading":null,"mirofish":null},"lastChange":null,"operation":null}'
seed_prior_artifacts "$s2" "case2-prior"
for name in tradingagents.env ai-hedge-fund.env vibe-trading.env vibe-gateway.env auth.env cloudflared.env; do
  printf 'OLD_VALUE=old-%s\n' "$name" >"$s2/secrets/$name"
  chmod 0600 "$s2/secrets/$name"
done
status2=0
(
  APP_DIR="$s2/app"
  AI_TRADING_SECRETS_DIR="$s2/secrets"
  ENV_STAGING_DIR="$s2/ci-staging"
  APP_CONFIG_STAGING_DIR="$s2/config-staging"
  AI_TRADING_STATE_DIR="$s2/control-state"
  AI_TRADING_UNIT_DIR="$s2/unit-dir"
  FAMILY_CONFIG_CREDENTIALS="$s2/fake-reader-key.json"
  DEPLOY_SH_SKIP_CHOWN=1
  IMAGE_TAG=2222222222222222222222222222222222222222
  export APP_DIR AI_TRADING_SECRETS_DIR ENV_STAGING_DIR APP_CONFIG_STAGING_DIR AI_TRADING_STATE_DIR AI_TRADING_UNIT_DIR FAMILY_CONFIG_CREDENTIALS DEPLOY_SH_SKIP_CHOWN IMAGE_TAG
  # The prior unit is reported ACTIVE and ENABLED -- stage_unit() must
  # capture that, and restore_or_remove_unit() must therefore RESTART
  # (never stop/disable) the restored prior unit on rollback.
  install_fake_systemctl "$s2" 0 0
  # The failure happens AFTER stage_configs()/stage_unit() have already
  # installed this run's NEW content (forcing a real "mid/late-transaction
  # failure", not merely a staging-phase one) -- `compose up` itself fails.
  # shellcheck disable=SC2329
  # shellcheck disable=SC2317
  docker() {
    echo "fake docker $*" >>"$APP_DIR/docker.log"
    case "${1:-}" in
      compose)
        case "$*" in
          *" up -d --no-deps"*) return 1 ;;
          *) return 0 ;;
        esac
        ;;
      ps | images | rmi) return 0 ;;
    esac
    command docker "$@"
  }
  export -f docker
  # shellcheck disable=SC2329
  # shellcheck disable=SC2317
  stat() {
    if [[ "${1:-}" == -c && "${2:-}" == '%u:%a' ]]; then
      printf '0:%s\n' "$(command stat -c '%a' "$3" 2>/dev/null || command stat -f '%Lp' "$3" 2>/dev/null)"
    else
      command stat "$@"
    fi
  }
  export -f stat
  bash "$DEPLOY_SH" >"$s2/stdout.log" 2>"$s2/stderr.log"
) || status2=$?
if [[ "$status2" == 0 ]]; then
  fail "case2: expected non-zero exit for a forced deploy_tag failure, got 0: $(cat "$s2/stdout.log" 2>/dev/null)"
fi
restored="$(cat "$s2/control-state/control.json" 2>/dev/null || true)"
echo "$restored" | python3 -c '
import json, sys
data = json.load(sys.stdin)
assert data["desired"] == {"tradingagents": False, "ai-hedge-fund": True, "vibe-trading": True, "mirofish": False}, data["desired"]
assert data["revision"] > 5, data["revision"]
' || fail "case2: restored control.json does not match the saved preferences with an increased revision: $restored"
grep -q 'OLD-case2-prior' "$s2/app/control/catalog.json" 2>/dev/null || fail "case2: control/catalog.json must be restored to its GENUINELY PRIOR content, not left as this run's new content"
grep -q 'OLD state.py stand-in, marker=case2-prior' "$s2/app/control/state.py" 2>/dev/null || fail "case2: control/state.py must be restored to its GENUINELY PRIOR content"
grep -q 'OLD runtime.py stand-in, marker=case2-prior' "$s2/app/control/runtime.py" 2>/dev/null || fail "case2: control/runtime.py must be restored to its GENUINELY PRIOR content"
grep -q 'OLD server.py stand-in, marker=case2-prior' "$s2/app/control/server.py" 2>/dev/null || fail "case2: control/server.py must be restored to its GENUINELY PRIOR content"
grep -q 'OLD unit stand-in, marker=case2-prior' "$s2/unit-dir/ai-trading-control.service" 2>/dev/null || fail "case2: the installed unit must be restored to its GENUINELY PRIOR content"
grep -qx 'fake systemctl restart ai-trading-control.service' "$s2/systemctl.log" 2>/dev/null || fail "case2: an active prior unit must be RESTARTED on rollback, not left stopped: $(cat "$s2/systemctl.log" 2>/dev/null)"
grep -q 'fake systemctl stop ai-trading-control.service' "$s2/systemctl.log" 2>/dev/null && fail "case2: an active prior unit must never be stopped on rollback"
grep -q 'fake systemctl disable ai-trading-control.service' "$s2/systemctl.log" 2>/dev/null && fail "case2: an already-enabled prior unit must never be disabled on rollback"
echo "    exit=$status2 revision=$(echo "$restored" | python3 -c 'import json,sys; print(json.load(sys.stdin)["revision"])' 2>/dev/null)"

echo "=== Case 3 (RED->rollback, task-5-review fix round 1 Critical #1): a GENUINE FIRST ACTIVATION (no prior control/* or unit) rolls back by REMOVING the just-installed code and STOPPING+DISABLING the just-activated unit -- never leaving it running ==="
CASE_COUNT=$((CASE_COUNT + 1))
s3="$(new_scratch case3)"
seed_control_state "$s3/control-state"
for name in tradingagents.env ai-hedge-fund.env vibe-trading.env vibe-gateway.env auth.env cloudflared.env; do
  printf 'OLD_VALUE=old-%s\n' "$name" >"$s3/secrets/$name"
  chmod 0600 "$s3/secrets/$name"
done
status3=0
(
  APP_DIR="$s3/app"
  AI_TRADING_SECRETS_DIR="$s3/secrets"
  ENV_STAGING_DIR="$s3/ci-staging"
  APP_CONFIG_STAGING_DIR="$s3/config-staging"
  AI_TRADING_STATE_DIR="$s3/control-state"
  AI_TRADING_UNIT_DIR="$s3/unit-dir"
  FAMILY_CONFIG_CREDENTIALS="$s3/fake-reader-key.json"
  DEPLOY_SH_SKIP_CHOWN=1
  IMAGE_TAG=3333333333333333333333333333333333333333
  export APP_DIR AI_TRADING_SECRETS_DIR ENV_STAGING_DIR APP_CONFIG_STAGING_DIR AI_TRADING_STATE_DIR AI_TRADING_UNIT_DIR FAMILY_CONFIG_CREDENTIALS DEPLOY_SH_SKIP_CHOWN IMAGE_TAG
  # No prior unit exists in $AI_TRADING_UNIT_DIR, so stage_unit() sees
  # UNIT_PRIOR_EXISTED=0 regardless of what is-active/is-enabled report --
  # the defaults (not active/not enabled) are what a fresh unit would be.
  install_fake_systemctl "$s3"
  # shellcheck disable=SC2329
  # shellcheck disable=SC2317
  docker() {
    echo "fake docker $*" >>"$APP_DIR/docker.log"
    case "${1:-}" in
      compose)
        case "$*" in
          *" up -d --no-deps"*) return 1 ;;
          *) return 0 ;;
        esac
        ;;
      ps | images | rmi) return 0 ;;
    esac
    command docker "$@"
  }
  export -f docker
  # shellcheck disable=SC2329
  # shellcheck disable=SC2317
  stat() {
    if [[ "${1:-}" == -c && "${2:-}" == '%u:%a' ]]; then
      printf '0:%s\n' "$(command stat -c '%a' "$3" 2>/dev/null || command stat -f '%Lp' "$3" 2>/dev/null)"
    else
      command stat "$@"
    fi
  }
  export -f stat
  bash "$DEPLOY_SH" >"$s3/stdout.log" 2>"$s3/stderr.log"
) || status3=$?
if [[ "$status3" == 0 ]]; then
  fail "case3: expected non-zero exit for a forced deploy_tag failure, got 0: $(cat "$s3/stdout.log" 2>/dev/null)"
fi
[[ -e "$s3/app/control/catalog.json" ]] && fail "case3: control/catalog.json had no prior version -- rollback should have removed it, not left this run's new content behind"
[[ -e "$s3/app/control/state.py" ]] && fail "case3: control/state.py had no prior version -- rollback should have removed it"
[[ -e "$s3/unit-dir/ai-trading-control.service" ]] && fail "case3: the unit had no prior version -- rollback should have removed the just-installed file, never leave it behind"
grep -qx 'fake systemctl stop ai-trading-control.service' "$s3/systemctl.log" 2>/dev/null || fail "case3: a genuine first activation must be STOPPED on rollback: $(cat "$s3/systemctl.log" 2>/dev/null)"
grep -qx 'fake systemctl disable ai-trading-control.service' "$s3/systemctl.log" 2>/dev/null || fail "case3: a genuine first activation must be DISABLED on rollback"
# The forward path's own stage_unit() legitimately restarts it once as
# part of this run's (later rolled-back) first activation -- the property
# that matters is the FINAL state: stop (rollback) must be the LAST
# lifecycle action logged, strictly after that one forward-path restart.
last_restart_line="$(grep -n 'fake systemctl restart ai-trading-control.service' "$s3/systemctl.log" 2>/dev/null | tail -1 | cut -d: -f1)"
last_stop_line="$(grep -n 'fake systemctl stop ai-trading-control.service' "$s3/systemctl.log" 2>/dev/null | tail -1 | cut -d: -f1)"
[[ -n "$last_stop_line" && ( -z "$last_restart_line" || "$last_stop_line" -gt "$last_restart_line" ) ]] \
  || fail "case3: the final systemctl action must be 'stop', after any forward-path restart, never the other way around: $(cat "$s3/systemctl.log" 2>/dev/null)"
echo "    exit=$status3"

echo "=== Case 4 (RED, process-level): a missing control-state directory (install.sh's own bootstrap never ran) aborts before any secret/config/unit mutation ==="
CASE_COUNT=$((CASE_COUNT + 1))
s4="$(new_scratch case4)"
for name in tradingagents.env ai-hedge-fund.env vibe-trading.env vibe-gateway.env auth.env cloudflared.env; do
  printf 'OLD_VALUE=old-%s\n' "$name" >"$s4/secrets/$name"
  chmod 0600 "$s4/secrets/$name"
done
status4=0
(
  APP_DIR="$s4/app"
  AI_TRADING_SECRETS_DIR="$s4/secrets"
  ENV_STAGING_DIR="$s4/ci-staging"
  APP_CONFIG_STAGING_DIR="$s4/config-staging"
  AI_TRADING_STATE_DIR="$s4/control-state-never-seeded"
  AI_TRADING_UNIT_DIR="$s4/unit-dir"
  FAMILY_CONFIG_CREDENTIALS="$s4/fake-reader-key.json"
  DEPLOY_SH_SKIP_CHOWN=1
  IMAGE_TAG=4444444444444444444444444444444444444444
  export APP_DIR AI_TRADING_SECRETS_DIR ENV_STAGING_DIR APP_CONFIG_STAGING_DIR AI_TRADING_STATE_DIR AI_TRADING_UNIT_DIR FAMILY_CONFIG_CREDENTIALS DEPLOY_SH_SKIP_CHOWN IMAGE_TAG
  install_fake_docker "$s4"
  install_fake_systemctl "$s4"
  bash "$DEPLOY_SH" >"$s4/stdout.log" 2>"$s4/stderr.log"
) || status4=$?
if [[ "$status4" == 0 ]]; then
  fail "case4: expected non-zero exit when control-state was never initialized, got 0"
fi
grep -q 'failed to snapshot the current app-control preferences' "$s4/stderr.log" 2>/dev/null \
  || fail "case4: expected the snapshot failure to be reported: $(cat "$s4/stderr.log" 2>/dev/null)"
for name in tradingagents.env ai-hedge-fund.env vibe-trading.env vibe-gateway.env auth.env cloudflared.env; do
  grep -q "old-$name" "$s4/secrets/$name" 2>/dev/null || fail "case4: $name must stay completely untouched -- stage_secrets must never have run"
done
[[ -d "$s4/secrets/.previous" ]] && fail "case4: stage_secrets must never have run (.previous backup directory exists)"
[[ -s "$s4/systemctl.log" ]] && fail "case4: systemctl must never have been called -- stage_unit must never have run: $(cat "$s4/systemctl.log" 2>/dev/null)"
echo "    exit=$status4"

echo "=== Case 5 (GREEN): the lifecycle lock is actually held for the duration of a deploy -- a second process attempting it (via state.py's own inherited-lock CLI) is BUSY until the first releases it ==="
CASE_COUNT=$((CASE_COUNT + 1))
s5="$(new_scratch case5)"
seed_control_state "$s5/control-state"
lock_path="$s5/control-state/.control.lock"
install -d -m 0700 "$s5/control-state"
: >"$lock_path"
chmod 0600 "$lock_path"
# Hold the lock from a long-lived background subshell (fd 9), exactly how
# deploy.sh's own acquire_lifecycle_lock does, then confirm a second,
# independent attempt to acquire the SAME path (python's own fcntl.flock,
# non-blocking) reports busy while the first still holds it, and succeeds
# immediately after it is released.
(
  exec 9>"$lock_path"
  python3 -c '
import fcntl, sys
fcntl.flock(9, fcntl.LOCK_EX)
' 9<&9 9>&9
  sleep 2
) &
holder_pid=$!
sleep 0.3
busy_result="$(
  exec 8>"$lock_path"
  python3 -c '
import fcntl, sys
try:
    fcntl.flock(8, fcntl.LOCK_EX | fcntl.LOCK_NB)
    print("ACQUIRED")
except BlockingIOError:
    print("BUSY")
' 8<&8 8>&8
)"
[[ "$busy_result" == BUSY ]] || fail "case5: expected BUSY while the lock is held, got $busy_result"
wait "$holder_pid"
after_result="$(
  exec 8>"$lock_path"
  python3 -c '
import fcntl, sys
try:
    fcntl.flock(8, fcntl.LOCK_EX | fcntl.LOCK_NB)
    print("ACQUIRED")
except BlockingIOError:
    print("BUSY")
' 8<&8 8>&8
)"
[[ "$after_result" == ACQUIRED ]] || fail "case5: expected ACQUIRED once the holder released the lock, got $after_result"
echo "    busy=$busy_result after=$after_result"

echo "=== Case 6 (GREEN): health-check.sh computes the same selected-service list as deploy.sh for an identical control.json -- never a second, independently maintained hardcoded list (isolated function check) ==="
CASE_COUNT=$((CASE_COUNT + 1))
s6="$(new_scratch case6)"
seed_control_state "$s6/control-state" '{"schemaVersion":1,"revision":0,"desired":{"tradingagents":true,"ai-hedge-fund":false,"vibe-trading":true,"mirofish":false},"results":{"tradingagents":null,"ai-hedge-fund":null,"vibe-trading":null,"mirofish":null},"lastChange":null,"operation":null}'
health_lib6="$TEST_ROOT/health-lib6.sh"
awk '/^# --- main flow below this line;/{exit} {print}' "$HEALTH_SH" >"$health_lib6"
got6="$(
  AI_TRADING_CONTROL_DIR="$CONTROL_DIR_REAL" \
  AI_TRADING_STATE_PATH="$s6/control-state/control.json" \
  AI_TRADING_CONTROL_OWNER_UID="$(id -u)" \
  HEALTH_CHECK_SKIP_CONTROL=1 \
  bash -c '
    APP_DIR=/nonexistent
    source "'"$health_lib6"'"
    selected_services_text
  '
)"
want6="$(python3 "$CONTROL_DIR_REAL/state.py" services --mirofish-ready false --state "$s6/control-state/control.json" --owner-uid "$(id -u)")"
[[ "$got6" == "$want6" ]] || fail "case6: health-check.sh's selected list ($got6) does not match control/state.py's own ($want6)"
echo "$got6" | grep -qw ahf-terminal && fail "case6: ai-hedge-fund is off and must not be selected"
echo "$got6" | grep -qx vibe-consensus || fail "case6: Vibe On must select its private consensus bridge"
echo "    got=$(echo "$got6" | tr '\n' ' ')"

echo "=== Case 6b (GREEN): Vibe Off cannot revive its private consensus bridge ==="
CASE_COUNT=$((CASE_COUNT + 1))
s6b="$(new_scratch case6b)"
seed_control_state "$s6b/control-state" '{"schemaVersion":1,"revision":0,"desired":{"tradingagents":true,"ai-hedge-fund":false,"vibe-trading":false,"mirofish":false},"results":{"tradingagents":null,"ai-hedge-fund":null,"vibe-trading":null,"mirofish":null},"lastChange":null,"operation":null}'
got6b="$(python3 "$CONTROL_DIR_REAL/state.py" services --mirofish-ready false --state "$s6b/control-state/control.json" --owner-uid "$(id -u)")"
echo "$got6b" | grep -qx vibe-consensus && fail "case6b: Off Vibe selected consensus"
echo "$got6b" | grep -qx vibe-trading && fail "case6b: Off Vibe selected app"
echo "$got6b" | grep -qx ta-terminal || fail "case6b: unaffected TradingAgents app missing"

echo "=== Case 7 (GREEN, task-5-review fix round 1 Important #2): the REAL health-check.sh, staged like any other CONFIG_FILES entry, is actually invoked through deploy.sh's real deploy_tag() call path (fake Docker/systemctl/runuser/curl) -- never the exit0 stand-in -- and correctly queries ONLY the selected (On) services, respecting a saved Off choice ==="
CASE_COUNT=$((CASE_COUNT + 1))
s7="$(new_scratch case7)"
cp "$HEALTH_SH" "$s7/config-staging/health-check.sh"
chmod 0755 "$s7/config-staging/health-check.sh"
seed_control_state "$s7/control-state" '{"schemaVersion":1,"revision":0,"desired":{"tradingagents":false,"ai-hedge-fund":true,"vibe-trading":true,"mirofish":false},"results":{"tradingagents":null,"ai-hedge-fund":null,"vibe-trading":null,"mirofish":null},"lastChange":null,"operation":null}'
status7=0
(
  APP_DIR="$s7/app"
  AI_TRADING_SECRETS_DIR="$s7/secrets"
  ENV_STAGING_DIR="$s7/ci-staging"
  APP_CONFIG_STAGING_DIR="$s7/config-staging"
  AI_TRADING_STATE_DIR="$s7/control-state"
  AI_TRADING_UNIT_DIR="$s7/unit-dir"
  FAMILY_CONFIG_CREDENTIALS="$s7/fake-reader-key.json"
  DEPLOY_SH_SKIP_CHOWN=1
  IMAGE_TAG=7777777777777777777777777777777777777777
  HEALTH_CHECK_ATTEMPTS=1
  export APP_DIR AI_TRADING_SECRETS_DIR ENV_STAGING_DIR APP_CONFIG_STAGING_DIR AI_TRADING_STATE_DIR AI_TRADING_UNIT_DIR FAMILY_CONFIG_CREDENTIALS DEPLOY_SH_SKIP_CHOWN IMAGE_TAG HEALTH_CHECK_ATTEMPTS
  install_fake_systemctl "$s7" 0 0
  # shellcheck disable=SC2329
  # shellcheck disable=SC2317
  runuser() {
    echo "fake runuser $*" >>"$APP_DIR/runuser.log"
    # Drop "-u <user> --" and run the rest (curl) for real, against the
    # fake below -- never a real socket/identity.
    shift 3
    "$@"
  }
  export -f runuser
  # shellcheck disable=SC2329
  # shellcheck disable=SC2317
  curl() {
    echo "fake curl $*" >>"$APP_DIR/curl.log"
    return 0
  }
  export -f curl
  # shellcheck disable=SC2329
  # shellcheck disable=SC2317
  docker() {
    echo "fake docker $*" >>"$APP_DIR/docker.log"
    case "${1:-}" in
      compose)
        case "$*" in
          *" ps -q "*)
            echo fakecontainerid
            return 0
            ;;
          *" exec -T web "*) return 0 ;;
          *) return 0 ;;
        esac
        ;;
      inspect)
        case "$3" in
          *State.Status*) echo running ;;
          *) echo healthy ;;
        esac
        return 0
        ;;
      ps | images | rmi) return 0 ;;
    esac
    command docker "$@"
  }
  export -f docker
  # shellcheck disable=SC2329
  # shellcheck disable=SC2317
  stat() {
    if [[ "${1:-}" == -c && "${2:-}" == '%u:%a' ]]; then
      printf '0:%s\n' "$(command stat -c '%a' "$3" 2>/dev/null || command stat -f '%Lp' "$3" 2>/dev/null)"
    else
      command stat "$@"
    fi
  }
  export -f stat
  bash "$DEPLOY_SH" >"$s7/stdout.log" 2>"$s7/stderr.log"
) || status7=$?
if [[ "$status7" != 0 ]]; then
  fail "case7: expected exit 0 (real health-check.sh should pass via fakes), got $status7: $(cat "$s7/stdout.log" "$s7/stderr.log" 2>/dev/null)"
else
  ps_calls="$(grep -o ' ps -q [a-z-]*' "$s7/app/docker.log" 2>/dev/null || true)"
  echo "$ps_calls" | grep -qw ta-terminal && fail "case7: health-check.sh queried disabled ta-terminal -- it must only check the selected (On) services: $ps_calls"
  echo "$ps_calls" | grep -qw ta-research && fail "case7: health-check.sh queried disabled ta-research: $ps_calls"
  echo "$ps_calls" | grep -qw ahf-terminal || fail "case7: health-check.sh never queried enabled ahf-terminal: $ps_calls"
  grep -q 'fake systemctl is-active.*ai-trading-control.service' "$s7/systemctl.log" 2>/dev/null || fail "case7: expected control_helper_ready() to check systemctl is-active: $(cat "$s7/systemctl.log" 2>/dev/null)"
  grep -q 'fake runuser' "$s7/app/runuser.log" 2>/dev/null || fail "case7: expected control_helper_ready() to drop privileges via runuser"
  grep -q 'fake curl' "$s7/app/curl.log" 2>/dev/null || fail "case7: expected control_helper_ready() to curl the control socket"
fi
echo "    exit=$status7"

echo "=== Case 8 (GREEN, task-7 brief item 3): a REAL child 'state.py' CLI process, invoked exactly as deploy.sh invokes it (--lock-fd 9, FD 9 inherited, never opened itself), cannot accidentally release deploy.sh's own held lifecycle lock -- the lock survives the child's exit ==="
CASE_COUNT=$((CASE_COUNT + 1))
s8="$(new_scratch case8)"
seed_control_state "$s8/control-state"
lock_path8="$s8/control-state/.control.lock"
: >"$lock_path8"
chmod 0600 "$lock_path8"
status8=0
(
  # Mirrors deploy.sh's own acquire_lifecycle_lock: opens the lock at FD 9
  # in THIS process and holds a non-blocking exclusive flock on it, before
  # ever invoking the real state.py CLI as a child.
  exec 9>"$lock_path8"
  python3 -c '
import fcntl
fcntl.flock(9, fcntl.LOCK_EX | fcntl.LOCK_NB)
' 9<&9 9>&9 || { echo "case8: could not acquire the parent lock" >&2; exit 1; }

  # Real child process (not an in-process call), inheriting FD 9 exactly
  # as deploy.sh's own `python3 ... --lock-fd 9 ...` invocations do.
  python3 "$CONTROL_DIR_REAL/state.py" snapshot \
    --state "$s8/control-state/control.json" --lock "$lock_path8" \
    --owner-uid "$(id -u)" --lock-fd 9 --output "$s8/control-state/snapshot.json" \
    || { echo "case8: child state.py CLI call failed" >&2; exit 1; }

  # The child process has already exited (implicitly closing ITS copy of
  # FD 9); this process's own FD 9 -- the one deploy.sh's shell would still
  # hold across the rest of the transaction -- must still be exclusively
  # locked. A second, independent fd on the same path must see BUSY.
  second_result="$(
    exec 8>"$lock_path8"
    python3 -c '
import fcntl
try:
    fcntl.flock(8, fcntl.LOCK_EX | fcntl.LOCK_NB)
    print("ACQUIRED")
except BlockingIOError:
    print("BUSY")
' 8<&8 8>&8
  )"
  [[ "$second_result" == BUSY ]] || { echo "case8: expected the lock to still be held after the child CLI exited, got $second_result" >&2; exit 1; }

  # Only now release it (closing FD 9, as deploy.sh's own EXIT trap does
  # last) and confirm a fresh attempt can finally acquire it.
  exec 9>&-
  after_result="$(
    exec 8>"$lock_path8"
    python3 -c '
import fcntl
try:
    fcntl.flock(8, fcntl.LOCK_EX | fcntl.LOCK_NB)
    print("ACQUIRED")
except BlockingIOError:
    print("BUSY")
' 8<&8 8>&8
  )"
  [[ "$after_result" == ACQUIRED ]] || { echo "case8: expected ACQUIRED once this process actually released FD 9, got $after_result" >&2; exit 1; }
  echo "    second=$second_result after=$after_result"
) || status8=$?
[[ "$status8" == 0 ]] || fail "case8: $(cat <<<"child CLI/inherited-lock scenario failed, see stderr above")"
echo "    exit=$status8"

echo "=== Case 9 (RED->rollback, final-review Important #1): a GENUINE FIRST ACTIVATION with a valid pre-controls last-good-tag rolls back to that tag -- the redeploy's own REAL health-check.sh must pass WITHOUT the just-stopped/disabled control helper, never loop for HEALTH_CHECK_ATTEMPTS and report 'rollback ... failed too' ==="
CASE_COUNT=$((CASE_COUNT + 1))
s9="$(new_scratch case9)"
cp "$HEALTH_SH" "$s9/config-staging/health-check.sh"
chmod 0755 "$s9/config-staging/health-check.sh"
seed_control_state "$s9/control-state"
printf '%s\n' aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa >"$s9/app/last-good-tag"
for name in tradingagents.env ai-hedge-fund.env vibe-trading.env vibe-gateway.env auth.env cloudflared.env; do
  printf 'OLD_VALUE=old-%s\n' "$name" >"$s9/secrets/$name"
  chmod 0600 "$s9/secrets/$name"
done
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
  IMAGE_TAG=9999999999999999999999999999999999999999
  HEALTH_CHECK_ATTEMPTS=1
  export APP_DIR AI_TRADING_SECRETS_DIR ENV_STAGING_DIR APP_CONFIG_STAGING_DIR AI_TRADING_STATE_DIR AI_TRADING_UNIT_DIR FAMILY_CONFIG_CREDENTIALS DEPLOY_SH_SKIP_CHOWN IMAGE_TAG HEALTH_CHECK_ATTEMPTS
  # No prior unit exists -- UNIT_PRIOR_EXISTED=0, same as Case 3.
  install_fake_systemctl "$s9"
  # shellcheck disable=SC2329
  # shellcheck disable=SC2317
  runuser() {
    echo "fake runuser $*" >>"$APP_DIR/runuser.log"
    shift 3
    "$@"
  }
  export -f runuser
  # shellcheck disable=SC2329
  # shellcheck disable=SC2317
  curl() {
    echo "fake curl $*" >>"$APP_DIR/curl.log"
    return 0
  }
  export -f curl
  # shellcheck disable=SC2329
  # shellcheck disable=SC2317
  docker() {
    echo "fake docker $*" >>"$APP_DIR/docker.log"
    case "${1:-}" in
      compose)
        case "$*" in
          *" up -d --no-deps"*)
            # Fail only THIS run's own (new-tag) activation attempt; a
            # later redeploy of the previous tag (rollback's own
            # `deploy_tag "$previous"`) must succeed, exactly like a real
            # "bad new release, good old one" rollback.
            local n
            n="$(cat "$APP_DIR/up_attempts.count" 2>/dev/null || echo 0)"
            n=$((n + 1))
            echo "$n" >"$APP_DIR/up_attempts.count"
            [[ "$n" -eq 1 ]] && return 1
            return 0
            ;;
          *" ps -q "*)
            echo fakecontainerid
            return 0
            ;;
          *" exec -T web "*) return 0 ;;
          *) return 0 ;;
        esac
        ;;
      inspect)
        case "$3" in
          *State.Status*) echo running ;;
          *) echo healthy ;;
        esac
        return 0
        ;;
      ps | images | rmi) return 0 ;;
    esac
    command docker "$@"
  }
  export -f docker
  # shellcheck disable=SC2329
  # shellcheck disable=SC2317
  stat() {
    if [[ "${1:-}" == -c && "${2:-}" == '%u:%a' ]]; then
      printf '0:%s\n' "$(command stat -c '%a' "$3" 2>/dev/null || command stat -f '%Lp' "$3" 2>/dev/null)"
    else
      command stat "$@"
    fi
  }
  export -f stat
  bash "$DEPLOY_SH" >"$s9/stdout.log" 2>"$s9/stderr.log"
) || status9=$?
if [[ "$status9" == 0 ]]; then
  fail "case9: expected non-zero exit for the forced first deploy_tag failure (the original failure's exit code must still be reported), got 0: $(cat "$s9/stdout.log" 2>/dev/null)"
fi
grep -q 'rollback to .* failed too' "$s9/stderr.log" 2>/dev/null \
  && fail "case9: the redeploy of the previous (pre-controls) tag must succeed, not report 'rollback ... failed too': $(cat "$s9/stderr.log" 2>/dev/null)"
grep -q 'all services healthy; app controls ready; tunnel connected' "$s9/stdout.log" 2>/dev/null \
  || fail "case9: expected the redeploy's own real health-check.sh to report success: $(cat "$s9/stdout.log" "$s9/stderr.log" 2>/dev/null)"
grep -q 'is-active.*ai-trading-control.service' "$s9/systemctl.log" 2>/dev/null \
  && fail "case9: a genuine first activation's rollback has no matching prior helper to verify -- control_helper_ready() must never be invoked for this redeploy's health check: $(cat "$s9/systemctl.log" 2>/dev/null)"
grep -qx 'fake systemctl stop ai-trading-control.service' "$s9/systemctl.log" 2>/dev/null || fail "case9: a genuine first activation must still be STOPPED on rollback"
grep -qx 'fake systemctl disable ai-trading-control.service' "$s9/systemctl.log" 2>/dev/null || fail "case9: a genuine first activation must still be DISABLED on rollback"
[[ "$(cat "$s9/app/up_attempts.count" 2>/dev/null || echo 0)" -ge 2 ]] || fail "case9: expected a second 'compose up' attempt during the previous tag's redeploy"
echo "    exit=$status9"

echo "=== Case 10 (GREEN, final-review Important #1 positive control): a rollback restoring a GENUINELY PRIOR, previously-ACTIVE control helper must still VERIFY it via the real health-check.sh -- the skip added for Case 9 must never apply when a matching prior unit exists ==="
CASE_COUNT=$((CASE_COUNT + 1))
s10="$(new_scratch case10)"
cp "$HEALTH_SH" "$s10/config-staging/health-check.sh"
chmod 0755 "$s10/config-staging/health-check.sh"
seed_control_state "$s10/control-state" '{"schemaVersion":1,"revision":5,"desired":{"tradingagents":false,"ai-hedge-fund":true,"vibe-trading":true,"mirofish":false},"results":{"tradingagents":null,"ai-hedge-fund":null,"vibe-trading":null,"mirofish":null},"lastChange":null,"operation":null}'
seed_prior_artifacts "$s10" "case10-prior"
printf '%s\n' bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb >"$s10/app/last-good-tag"
for name in tradingagents.env ai-hedge-fund.env vibe-trading.env vibe-gateway.env auth.env cloudflared.env; do
  printf 'OLD_VALUE=old-%s\n' "$name" >"$s10/secrets/$name"
  chmod 0600 "$s10/secrets/$name"
done
status10=0
(
  APP_DIR="$s10/app"
  AI_TRADING_SECRETS_DIR="$s10/secrets"
  ENV_STAGING_DIR="$s10/ci-staging"
  APP_CONFIG_STAGING_DIR="$s10/config-staging"
  AI_TRADING_STATE_DIR="$s10/control-state"
  AI_TRADING_UNIT_DIR="$s10/unit-dir"
  FAMILY_CONFIG_CREDENTIALS="$s10/fake-reader-key.json"
  DEPLOY_SH_SKIP_CHOWN=1
  IMAGE_TAG=1010101010101010101010101010101010101010
  HEALTH_CHECK_ATTEMPTS=1
  export APP_DIR AI_TRADING_SECRETS_DIR ENV_STAGING_DIR APP_CONFIG_STAGING_DIR AI_TRADING_STATE_DIR AI_TRADING_UNIT_DIR FAMILY_CONFIG_CREDENTIALS DEPLOY_SH_SKIP_CHOWN IMAGE_TAG HEALTH_CHECK_ATTEMPTS
  # The prior unit is reported ACTIVE and ENABLED -- restore_or_remove_unit()
  # restarts (never stops/disables) it, and this run's redeploy health-check
  # must actually verify it is up, same as any other matching-version rollback.
  install_fake_systemctl "$s10" 0 0
  # shellcheck disable=SC2329
  # shellcheck disable=SC2317
  runuser() {
    echo "fake runuser $*" >>"$APP_DIR/runuser.log"
    shift 3
    "$@"
  }
  export -f runuser
  # shellcheck disable=SC2329
  # shellcheck disable=SC2317
  curl() {
    echo "fake curl $*" >>"$APP_DIR/curl.log"
    return 0
  }
  export -f curl
  # shellcheck disable=SC2329
  # shellcheck disable=SC2317
  docker() {
    echo "fake docker $*" >>"$APP_DIR/docker.log"
    case "${1:-}" in
      compose)
        case "$*" in
          *" up -d --no-deps"*)
            local n
            n="$(cat "$APP_DIR/up_attempts.count" 2>/dev/null || echo 0)"
            n=$((n + 1))
            echo "$n" >"$APP_DIR/up_attempts.count"
            [[ "$n" -eq 1 ]] && return 1
            return 0
            ;;
          *" ps -q "*)
            echo fakecontainerid
            return 0
            ;;
          *" exec -T web "*) return 0 ;;
          *) return 0 ;;
        esac
        ;;
      inspect)
        case "$3" in
          *State.Status*) echo running ;;
          *) echo healthy ;;
        esac
        return 0
        ;;
      ps | images | rmi) return 0 ;;
    esac
    command docker "$@"
  }
  export -f docker
  # shellcheck disable=SC2329
  # shellcheck disable=SC2317
  stat() {
    if [[ "${1:-}" == -c && "${2:-}" == '%u:%a' ]]; then
      printf '0:%s\n' "$(command stat -c '%a' "$3" 2>/dev/null || command stat -f '%Lp' "$3" 2>/dev/null)"
    else
      command stat "$@"
    fi
  }
  export -f stat
  bash "$DEPLOY_SH" >"$s10/stdout.log" 2>"$s10/stderr.log"
) || status10=$?
if [[ "$status10" == 0 ]]; then
  fail "case10: expected non-zero exit for the forced first deploy_tag failure, got 0: $(cat "$s10/stdout.log" 2>/dev/null)"
fi
grep -q 'rollback to .* failed too' "$s10/stderr.log" 2>/dev/null \
  && fail "case10: the redeploy of the previous tag (matching prior, active helper restored) must succeed: $(cat "$s10/stderr.log" 2>/dev/null)"
grep -q 'all services healthy; app controls ready; tunnel connected' "$s10/stdout.log" 2>/dev/null \
  || fail "case10: expected the redeploy's own real health-check.sh to report success: $(cat "$s10/stdout.log" "$s10/stderr.log" 2>/dev/null)"
grep -q 'is-active.*ai-trading-control.service' "$s10/systemctl.log" 2>/dev/null \
  || fail "case10: a rollback restoring a matching, previously-active prior helper must still be VERIFIED by control_helper_ready() -- the Case 9 skip must not generalize to this scenario: $(cat "$s10/systemctl.log" 2>/dev/null)"
grep -q 'fake runuser' "$s10/app/runuser.log" 2>/dev/null || fail "case10: expected control_helper_ready() to actually run during this redeploy's health check"
echo "    exit=$status10"

echo "=== Case 11 (GREEN, final re-review correctness fix): an EARLY failure BEFORE stage_unit ever runs (stage_configs fails first) leaves a genuinely prior, ACTIVE control helper completely UNTOUCHED -- UNIT_PRIOR_EXISTED is never set this run, so the skip added for Case 9 must NOT fire; the redeploy's real health-check.sh must still verify that untouched helper, never assume a default/unknown prior-unit state means 'no prior unit' ==="
CASE_COUNT=$((CASE_COUNT + 1))
s11="$(new_scratch case11)"
cp "$HEALTH_SH" "$s11/config-staging/health-check.sh"
chmod 0755 "$s11/config-staging/health-check.sh"
seed_control_state "$s11/control-state" '{"schemaVersion":1,"revision":2,"desired":{"tradingagents":false,"ai-hedge-fund":true,"vibe-trading":true,"mirofish":false},"results":{"tradingagents":null,"ai-hedge-fund":null,"vibe-trading":null,"mirofish":null},"lastChange":null,"operation":null}'
# A genuinely prior control/* and unit, exactly like Case 2/10 -- but this
# time stage_unit() must NEVER run at all (the forced failure below is
# inside stage_configs, strictly before stage_unit in the main flow), so
# this prior unit stays completely untouched throughout.
seed_prior_artifacts "$s11" "case11-prior"
printf '%s\n' cccccccccccccccccccccccccccccccccccccccc >"$s11/app/last-good-tag"
for name in tradingagents.env ai-hedge-fund.env vibe-trading.env vibe-gateway.env auth.env cloudflared.env; do
  printf 'OLD_VALUE=old-%s\n' "$name" >"$s11/secrets/$name"
  chmod 0600 "$s11/secrets/$name"
done
status11=0
(
  APP_DIR="$s11/app"
  AI_TRADING_SECRETS_DIR="$s11/secrets"
  ENV_STAGING_DIR="$s11/ci-staging"
  APP_CONFIG_STAGING_DIR="$s11/config-staging"
  AI_TRADING_STATE_DIR="$s11/control-state"
  AI_TRADING_UNIT_DIR="$s11/unit-dir"
  FAMILY_CONFIG_CREDENTIALS="$s11/fake-reader-key.json"
  DEPLOY_SH_SKIP_CHOWN=1
  IMAGE_TAG=1111111111111111111111111111111111111112
  HEALTH_CHECK_ATTEMPTS=1
  # Forces stage_configs to fail right after installing Caddyfile --
  # strictly BEFORE health-check.sh/control/* are installed and long before
  # stage_unit ever runs, so UNIT_STAGED/UNIT_PRIOR_EXISTED are never set
  # this run at all (stay at their script-level init, not "0").
  DEPLOY_SH_CONFIG_FAIL_AFTER=Caddyfile
  export APP_DIR AI_TRADING_SECRETS_DIR ENV_STAGING_DIR APP_CONFIG_STAGING_DIR AI_TRADING_STATE_DIR AI_TRADING_UNIT_DIR FAMILY_CONFIG_CREDENTIALS DEPLOY_SH_SKIP_CHOWN IMAGE_TAG HEALTH_CHECK_ATTEMPTS DEPLOY_SH_CONFIG_FAIL_AFTER
  # The untouched prior unit is genuinely ACTIVE and ENABLED.
  install_fake_systemctl "$s11" 0 0
  # shellcheck disable=SC2329
  # shellcheck disable=SC2317
  runuser() {
    echo "fake runuser $*" >>"$APP_DIR/runuser.log"
    shift 3
    "$@"
  }
  export -f runuser
  # shellcheck disable=SC2329
  # shellcheck disable=SC2317
  curl() {
    echo "fake curl $*" >>"$APP_DIR/curl.log"
    return 0
  }
  export -f curl
  # shellcheck disable=SC2329
  # shellcheck disable=SC2317
  docker() {
    echo "fake docker $*" >>"$APP_DIR/docker.log"
    case "${1:-}" in
      compose)
        case "$*" in
          *" ps -q "*)
            echo fakecontainerid
            return 0
            ;;
          *" exec -T web "*) return 0 ;;
          *) return 0 ;;
        esac
        ;;
      inspect)
        case "$3" in
          *State.Status*) echo running ;;
          *) echo healthy ;;
        esac
        return 0
        ;;
      ps | images | rmi) return 0 ;;
    esac
    command docker "$@"
  }
  export -f docker
  # shellcheck disable=SC2329
  # shellcheck disable=SC2317
  stat() {
    if [[ "${1:-}" == -c && "${2:-}" == '%u:%a' ]]; then
      printf '0:%s\n' "$(command stat -c '%a' "$3" 2>/dev/null || command stat -f '%Lp' "$3" 2>/dev/null)"
    else
      command stat "$@"
    fi
  }
  export -f stat
  bash "$DEPLOY_SH" >"$s11/stdout.log" 2>"$s11/stderr.log"
) || status11=$?
if [[ "$status11" == 0 ]]; then
  fail "case11: expected non-zero exit for the forced stage_configs failure, got 0: $(cat "$s11/stdout.log" 2>/dev/null)"
fi
grep -q 'rollback to .* failed too' "$s11/stderr.log" 2>/dev/null \
  && fail "case11: the redeploy of the previous tag (untouched, genuinely-active prior helper) must succeed: $(cat "$s11/stderr.log" 2>/dev/null)"
grep -q 'all services healthy; app controls ready; tunnel connected' "$s11/stdout.log" 2>/dev/null \
  || fail "case11: expected the redeploy's own real health-check.sh to report success: $(cat "$s11/stdout.log" "$s11/stderr.log" 2>/dev/null)"
grep -q 'is-active.*ai-trading-control.service' "$s11/systemctl.log" 2>/dev/null \
  || fail "case11: an untouched (never staged this run) prior helper must still be VERIFIED by control_helper_ready() -- an unknown/default UNIT_PRIOR_EXISTED must never be treated as 'no prior unit': $(cat "$s11/systemctl.log" 2>/dev/null)"
grep -qx 'fake systemctl enable ai-trading-control.service' "$s11/systemctl.log" 2>/dev/null \
  && fail "case11: stage_unit must never have run (the forced failure is inside stage_configs, before it) -- the unit must stay completely untouched this run"
grep -q 'OLD unit stand-in, marker=case11-prior' "$s11/unit-dir/ai-trading-control.service" 2>/dev/null \
  || fail "case11: the prior unit file content must stay byte-for-byte untouched -- it was never staged this run"
echo "    exit=$status11"

echo "=== Case 12 (GREEN, packaging-fix regression, REAL deployed layout): deploy.sh copied FLAT to \$APP_DIR/deploy.sh (the workflow's actual SCP/install target, never deploy.sh's own repo directory) with NO mirofish-runtime.sh colocated beside it -- only staged nested at config-staging/deploy/production/ like every other CONFIG_FILES entry -- must still source it and complete the full transaction ==="
CASE_COUNT=$((CASE_COUNT + 1))
s12="$(new_scratch case12)"
# Copy deploy.sh's own BYTES to a location that does not colocate
# mirofish-runtime.sh -- exactly what the workflow's own
# `install ... /opt/family-app/ai-trading/deploy.sh` produces, and what
# every OTHER case in this file (which instead runs $DEPLOY_SH in place,
# inside its own repo directory where mirofish-runtime.sh genuinely sits
# beside it) never actually exercises.
cp "$DEPLOY_SH" "$s12/app/deploy.sh"
seed_control_state "$s12/control-state"
seed_prior_artifacts "$s12" "case12-prior"
for name in tradingagents.env ai-hedge-fund.env vibe-trading.env vibe-gateway.env auth.env cloudflared.env; do
  printf 'OLD_VALUE=old-%s\n' "$name" >"$s12/secrets/$name"
  chmod 0600 "$s12/secrets/$name"
done
status12=0
(
  APP_DIR="$s12/app"
  AI_TRADING_SECRETS_DIR="$s12/secrets"
  ENV_STAGING_DIR="$s12/ci-staging"
  APP_CONFIG_STAGING_DIR="$s12/config-staging"
  AI_TRADING_STATE_DIR="$s12/control-state"
  AI_TRADING_UNIT_DIR="$s12/unit-dir"
  FAMILY_CONFIG_CREDENTIALS="$s12/fake-reader-key.json"
  DEPLOY_SH_SKIP_CHOWN=1
  IMAGE_TAG=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  export APP_DIR AI_TRADING_SECRETS_DIR ENV_STAGING_DIR APP_CONFIG_STAGING_DIR AI_TRADING_STATE_DIR AI_TRADING_UNIT_DIR FAMILY_CONFIG_CREDENTIALS DEPLOY_SH_SKIP_CHOWN IMAGE_TAG
  install_fake_docker "$s12"
  install_fake_systemctl "$s12"
  # shellcheck disable=SC2329
  # shellcheck disable=SC2317
  stat() {
    if [[ "${1:-}" == -c && "${2:-}" == '%u:%a' ]]; then
      printf '0:%s\n' "$(command stat -c '%a' "$3" 2>/dev/null || command stat -f '%Lp' "$3" 2>/dev/null)"
    else
      command stat "$@"
    fi
  }
  export -f stat
  bash "$s12/app/deploy.sh" >"$s12/stdout.log" 2>"$s12/stderr.log"
) || status12=$?
if [[ "$status12" != 0 ]]; then
  fail "case12: expected exit 0 against the real deployed-layout copy, got $status12: $(cat "$s12/stderr.log" 2>/dev/null)"
fi
grep -q 'No such file or directory' "$s12/stderr.log" 2>/dev/null \
  && fail "case12: deploy.sh must never fail to find its own sourced library on the real deployed layout: $(cat "$s12/stderr.log" 2>/dev/null)"
grep -q 'ai-trading is running' "$s12/stdout.log" 2>/dev/null \
  || fail "case12: expected the deploy to actually complete: $(cat "$s12/stdout.log" "$s12/stderr.log" 2>/dev/null)"
cmp -s "$s12/app/deploy/production/mirofish-runtime.sh" "$MIROFISH_LIB_SH" \
  || fail "case12: the installed deploy/production/mirofish-runtime.sh must be replaced with this run's staged REAL content, byte-for-byte"
echo "    exit=$status12"

echo "=== Case 13 (RED->rollback, packaging-fix regression): same real deployed layout as Case 12, but a later deploy_tag failure must restore the GENUINELY PRIOR deploy/production/mirofish-runtime.sh byte-for-byte, never leave this run's new content installed ==="
CASE_COUNT=$((CASE_COUNT + 1))
s13="$(new_scratch case13)"
cp "$DEPLOY_SH" "$s13/app/deploy.sh"
seed_control_state "$s13/control-state"
seed_prior_artifacts "$s13" "case13-prior"
for name in tradingagents.env ai-hedge-fund.env vibe-trading.env vibe-gateway.env auth.env cloudflared.env; do
  printf 'OLD_VALUE=old-%s\n' "$name" >"$s13/secrets/$name"
  chmod 0600 "$s13/secrets/$name"
done
status13=0
(
  APP_DIR="$s13/app"
  AI_TRADING_SECRETS_DIR="$s13/secrets"
  ENV_STAGING_DIR="$s13/ci-staging"
  APP_CONFIG_STAGING_DIR="$s13/config-staging"
  AI_TRADING_STATE_DIR="$s13/control-state"
  AI_TRADING_UNIT_DIR="$s13/unit-dir"
  FAMILY_CONFIG_CREDENTIALS="$s13/fake-reader-key.json"
  DEPLOY_SH_SKIP_CHOWN=1
  IMAGE_TAG=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
  export APP_DIR AI_TRADING_SECRETS_DIR ENV_STAGING_DIR APP_CONFIG_STAGING_DIR AI_TRADING_STATE_DIR AI_TRADING_UNIT_DIR FAMILY_CONFIG_CREDENTIALS DEPLOY_SH_SKIP_CHOWN IMAGE_TAG
  install_fake_systemctl "$s13"
  # The failure happens AFTER stage_configs() has already installed this
  # run's new deploy/production/mirofish-runtime.sh -- same
  # mid/late-transaction-failure technique Case 2 uses.
  # shellcheck disable=SC2329
  # shellcheck disable=SC2317
  docker() {
    echo "fake docker $*" >>"$APP_DIR/docker.log"
    case "${1:-}" in
      compose)
        case "$*" in
          *" up -d --no-deps"*) return 1 ;;
          *) return 0 ;;
        esac
        ;;
      ps | images | rmi) return 0 ;;
    esac
    command docker "$@"
  }
  export -f docker
  # shellcheck disable=SC2329
  # shellcheck disable=SC2317
  stat() {
    if [[ "${1:-}" == -c && "${2:-}" == '%u:%a' ]]; then
      printf '0:%s\n' "$(command stat -c '%a' "$3" 2>/dev/null || command stat -f '%Lp' "$3" 2>/dev/null)"
    else
      command stat "$@"
    fi
  }
  export -f stat
  bash "$s13/app/deploy.sh" >"$s13/stdout.log" 2>"$s13/stderr.log"
) || status13=$?
if [[ "$status13" == 0 ]]; then
  fail "case13: expected non-zero exit for a forced deploy_tag failure, got 0: $(cat "$s13/stdout.log" 2>/dev/null)"
fi
# Evidence this run actually got past sourcing, staged its NEW content, and
# reached deploy_tag's `compose up` BEFORE the forced failure -- otherwise
# the assertion below (prior content restored) would pass vacuously even
# against the original bug, where the script dies at the source line
# itself and the prior file is merely left untouched, never genuinely
# staged-then-rolled-back.
grep -q ' up -d --no-deps' "$s13/app/docker.log" 2>/dev/null \
  || fail "case13: expected this run to actually reach deploy_tag's compose up (proving sourcing/staging succeeded first): $(cat "$s13/stderr.log" 2>/dev/null)"
grep -q 'OLD mirofish-runtime.sh stand-in, marker=case13-prior' "$s13/app/deploy/production/mirofish-runtime.sh" 2>/dev/null \
  || fail "case13: rollback must restore deploy/production/mirofish-runtime.sh to its GENUINELY PRIOR content, byte-for-byte: $(cat "$s13/app/deploy/production/mirofish-runtime.sh" 2>/dev/null)"
echo "    exit=$status13"

echo "=== Case 14 (RED, packaging-fix fail-closed): real deployed layout, but the workflow staged an INCOMPLETE bundle missing deploy/production/mirofish-runtime.sh -- must die closed, BEFORE acquiring the lifecycle lock or touching any secret/control-state/prior-library byte, never silently fall back to an already-installed (possibly stale) copy ==="
CASE_COUNT=$((CASE_COUNT + 1))
s14="$(new_scratch case14)"
cp "$DEPLOY_SH" "$s14/app/deploy.sh"
seed_control_state "$s14/control-state"
seed_prior_artifacts "$s14" "case14-prior"
rm -f "$s14/config-staging/deploy/production/mirofish-runtime.sh"
for name in tradingagents.env ai-hedge-fund.env vibe-trading.env vibe-gateway.env auth.env cloudflared.env; do
  printf 'OLD_VALUE=old-%s\n' "$name" >"$s14/secrets/$name"
  chmod 0600 "$s14/secrets/$name"
done
status14=0
(
  APP_DIR="$s14/app"
  AI_TRADING_SECRETS_DIR="$s14/secrets"
  ENV_STAGING_DIR="$s14/ci-staging"
  APP_CONFIG_STAGING_DIR="$s14/config-staging"
  AI_TRADING_STATE_DIR="$s14/control-state"
  AI_TRADING_UNIT_DIR="$s14/unit-dir"
  FAMILY_CONFIG_CREDENTIALS="$s14/fake-reader-key.json"
  DEPLOY_SH_SKIP_CHOWN=1
  IMAGE_TAG=cccccccccccccccccccccccccccccccccccccccc
  export APP_DIR AI_TRADING_SECRETS_DIR ENV_STAGING_DIR APP_CONFIG_STAGING_DIR AI_TRADING_STATE_DIR AI_TRADING_UNIT_DIR FAMILY_CONFIG_CREDENTIALS DEPLOY_SH_SKIP_CHOWN IMAGE_TAG
  install_fake_docker "$s14"
  install_fake_systemctl "$s14"
  bash "$s14/app/deploy.sh" >"$s14/stdout.log" 2>"$s14/stderr.log"
) || status14=$?
if [[ "$status14" == 0 ]]; then
  fail "case14: expected non-zero exit for a staging bundle missing mirofish-runtime.sh, got 0: $(cat "$s14/stdout.log" 2>/dev/null)"
fi
grep -q 'missing staged .*mirofish-runtime\.sh' "$s14/stderr.log" 2>/dev/null \
  || fail "case14: expected a clear 'missing staged ... mirofish-runtime.sh' message: $(cat "$s14/stderr.log" 2>/dev/null)"
if [[ -f "$s14/control-state/control.json" ]]; then
  grep -q '"revision":0' "$s14/control-state/control.json" \
    || fail "case14: control.json's revision must never advance -- this must fail before acquiring the lifecycle lock or snapshotting preferences"
else
  fail "case14: control.json must still exist (install.sh already seeded it before this run)"
fi
if [[ -e "$s14/secrets/tradingagents.env" ]]; then
  grep -q 'OLD_VALUE' "$s14/secrets/tradingagents.env" \
    || fail "case14: no secret file may be touched before the missing-library check runs"
else
  fail "case14: the pre-seeded secret file must still exist"
fi
grep -q 'OLD mirofish-runtime.sh stand-in, marker=case14-prior' "$s14/app/deploy/production/mirofish-runtime.sh" 2>/dev/null \
  || fail "case14: the genuinely prior deploy/production/mirofish-runtime.sh must stay byte-for-byte untouched -- this run must never have reached stage_configs at all"
[[ -z "$(cat "$s14/systemctl.log" 2>/dev/null)" ]] \
  || fail "case14: the control helper unit must never be touched before this check runs: $(cat "$s14/systemctl.log" 2>/dev/null)"
echo "    exit=$status14"

echo "=== Case 15 (RED, packaging-fix fix round 1, real deployed layout): the staged deploy/production/mirofish-runtime.sh is a SYMLINK to an arbitrary sentinel-writing script -- the early library-source guard must reject it (same existence/not-a-symlink/regular-file discipline validate_staged_config_file applies to every other CONFIG_FILES entry) BEFORE sourcing (executing) it, never after -- no sentinel, no secret/control-state/prior-library byte touched ==="
CASE_COUNT=$((CASE_COUNT + 1))
s15="$(new_scratch case15)"
cp "$DEPLOY_SH" "$s15/app/deploy.sh"
seed_control_state "$s15/control-state"
seed_prior_artifacts "$s15" "case15-prior"
for name in tradingagents.env ai-hedge-fund.env vibe-trading.env vibe-gateway.env auth.env cloudflared.env; do
  printf 'OLD_VALUE=old-%s\n' "$name" >"$s15/secrets/$name"
  chmod 0600 "$s15/secrets/$name"
done
# An arbitrary script OUTSIDE the staging directory entirely -- standing in
# for "a compromised staging step points this script at an arbitrary path",
# validate_staged_config_file's own stated threat. If the early guard ever
# sources this (executes it, as root in production) before rejecting it,
# this writes a sentinel file proving the compromise ran.
mkdir -p "$s15/outside-staging"
cat >"$s15/outside-staging/evil.sh" <<EOF
#!/usr/bin/env bash
echo PWNED >"$s15/outside-staging/sentinel"
EOF
chmod 0755 "$s15/outside-staging/evil.sh"
rm -f "$s15/config-staging/deploy/production/mirofish-runtime.sh"
ln -s "$s15/outside-staging/evil.sh" "$s15/config-staging/deploy/production/mirofish-runtime.sh"
status15=0
(
  APP_DIR="$s15/app"
  AI_TRADING_SECRETS_DIR="$s15/secrets"
  ENV_STAGING_DIR="$s15/ci-staging"
  APP_CONFIG_STAGING_DIR="$s15/config-staging"
  AI_TRADING_STATE_DIR="$s15/control-state"
  AI_TRADING_UNIT_DIR="$s15/unit-dir"
  FAMILY_CONFIG_CREDENTIALS="$s15/fake-reader-key.json"
  DEPLOY_SH_SKIP_CHOWN=1
  IMAGE_TAG=dddddddddddddddddddddddddddddddddddddddd
  export APP_DIR AI_TRADING_SECRETS_DIR ENV_STAGING_DIR APP_CONFIG_STAGING_DIR AI_TRADING_STATE_DIR AI_TRADING_UNIT_DIR FAMILY_CONFIG_CREDENTIALS DEPLOY_SH_SKIP_CHOWN IMAGE_TAG
  install_fake_docker "$s15"
  install_fake_systemctl "$s15"
  bash "$s15/app/deploy.sh" >"$s15/stdout.log" 2>"$s15/stderr.log"
) || status15=$?
if [[ "$status15" == 0 ]]; then
  fail "case15: expected non-zero exit for a symlinked staged mirofish-runtime.sh, got 0: $(cat "$s15/stdout.log" 2>/dev/null)"
fi
grep -q 'must be a regular file, not a symlink' "$s15/stderr.log" 2>/dev/null \
  || fail "case15: expected a clear 'must be a regular file, not a symlink' rejection: $(cat "$s15/stderr.log" 2>/dev/null)"
[[ -e "$s15/outside-staging/sentinel" ]] \
  && fail "case15: the symlinked staged library must be REJECTED, never sourced/executed -- the sentinel file proves it ran"
if [[ -f "$s15/control-state/control.json" ]]; then
  grep -q '"revision":0' "$s15/control-state/control.json" \
    || fail "case15: control.json's revision must never advance -- this must fail before acquiring the lifecycle lock"
else
  fail "case15: control.json must still exist (install.sh already seeded it before this run)"
fi
if [[ -e "$s15/secrets/tradingagents.env" ]]; then
  grep -q 'OLD_VALUE' "$s15/secrets/tradingagents.env" \
    || fail "case15: no secret file may be touched before the symlink rejection runs"
else
  fail "case15: the pre-seeded secret file must still exist"
fi
grep -q 'OLD mirofish-runtime.sh stand-in, marker=case15-prior' "$s15/app/deploy/production/mirofish-runtime.sh" 2>/dev/null \
  || fail "case15: the genuinely prior deploy/production/mirofish-runtime.sh must stay byte-for-byte untouched"
[[ -z "$(cat "$s15/systemctl.log" 2>/dev/null)" ]] \
  || fail "case15: the control helper unit must never be touched before this check runs: $(cat "$s15/systemctl.log" 2>/dev/null)"
echo "    exit=$status15"

echo
cleanup
if [[ "$FAIL_COUNT" -eq 0 ]]; then
  echo "RESULT: GREEN -- $CASE_COUNT cases, 0 failures (shell); see below for the Linux installer container suite"
else
  echo "RESULT: RED -- $CASE_COUNT cases, $FAIL_COUNT failure(s) (shell)"
fi
SHELL_FAILURES="$FAIL_COUNT"

# =======================================================================
# Linux installer (bootstrap) suite: real Linux userland inside a
# disposable container, every Linux-specific external command
# (id/getent/useradd/groupadd/systemctl/docker) faked via a PATH-prepended
# fixture bin directory. Skipped (not failed) when Docker is unavailable.
# =======================================================================
INSTALL_FAIL_COUNT=0
INSTALL_CASE_COUNT=0
install_fail() {
  INSTALL_FAIL_COUNT=$((INSTALL_FAIL_COUNT + 1))
  echo "    FAIL: $*" >&2
}

if ! docker info >/dev/null 2>&1; then
  echo
  echo "SKIP: Docker unavailable -- Linux installer suite not run"
else
  IROOT="$HOME/.cache/ai-trading-app-controls-install-test-$$"
  rm -rf "$IROOT"
  mkdir -p "$IROOT/bin" "$IROOT/src/ai-trading/control" "$IROOT/src/ai-trading/deploy/production" "$IROOT/src/infrastructure/host/app-controls" "$IROOT/fake-state"
  chmod 0700 "$IROOT"
  install_cleanup() { rm -rf "$IROOT"; }
  trap 'install_cleanup; cleanup' EXIT

  cp "$CONTROL_DIR_REAL/catalog.json" "$IROOT/src/ai-trading/control/catalog.json"
  cp "$CONTROL_DIR_REAL/state.py" "$IROOT/src/ai-trading/control/state.py"
  cp "$CONTROL_DIR_REAL/runtime.py" "$IROOT/src/ai-trading/control/runtime.py"
  cp "$CONTROL_DIR_REAL/server.py" "$IROOT/src/ai-trading/control/server.py"
  cp "$MIROFISH_LIB_SH" "$IROOT/src/ai-trading/deploy/production/mirofish-runtime.sh"
  cp "$PREPARE_MIROFISH_SH" "$IROOT/src/ai-trading/deploy/production/prepare-mirofish.sh"
  cp "$UNIT_FILE" "$IROOT/src/infrastructure/host/app-controls/ai-trading-control.service"
  cp "$INSTALL_SH" "$IROOT/src/install.sh"

  cat >"$IROOT/bin/id" <<'EOF'
#!/bin/bash
[[ "$1" == -u && "$2" == ai-trading-gateway ]] && { [[ -f /fake-state/user-exists ]] && { echo 22001; exit 0; }; exit 1; }
[[ "$1" == -g && "$2" == ai-trading-gateway ]] && { [[ -f /fake-state/user-exists ]] && { echo 22001; exit 0; }; exit 1; }
[[ "$1" == -nG && "$2" == ai-trading-gateway ]] && { echo "ai-trading-gateway"; exit 0; }
exit 1
EOF
  cat >"$IROOT/bin/getent" <<'EOF'
#!/bin/bash
if [[ "$1" == passwd ]]; then
  [[ "$2" == 22001 && -f /fake-state/user-exists ]] && { echo "ai-trading-gateway:x:22001:22001::/x:/usr/sbin/nologin"; exit 0; }
  exit 2
fi
if [[ "$1" == group ]]; then
  { [[ "$2" == 22001 || "$2" == ai-trading-gateway ]] && [[ -f /fake-state/group-exists ]]; } && { echo "ai-trading-gateway:x:22001:"; exit 0; }
  exit 2
fi
exit 2
EOF
  cat >"$IROOT/bin/groupadd" <<'EOF'
#!/bin/bash
echo "groupadd $*" >> /fake-state/calls.log
touch /fake-state/group-exists
EOF
  cat >"$IROOT/bin/useradd" <<'EOF'
#!/bin/bash
echo "useradd $*" >> /fake-state/calls.log
touch /fake-state/user-exists
EOF
  cat >"$IROOT/bin/systemctl" <<'EOF'
#!/bin/bash
echo "systemctl $*" >> /fake-state/calls.log
EOF
  cat >"$IROOT/bin/docker" <<'EOF'
#!/bin/bash
[[ "$1" == info ]] && { echo '[{"Name":"seccomp"}]'; exit 0; }
exit 0
EOF
  chmod +x "$IROOT/bin/"*

  run_install() {
    # run_install EXTRA_SRC_DIR [EXTRA_DOCKER_PATH_DIR]
    docker run --rm \
      -v "$IROOT/bin:/fakebin:ro" \
      -v "${1:-$IROOT/src}:/src:ro" \
      -v "$IROOT/fake-state:/fake-state" \
      -e PATH="${2:-}:/fakebin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
      python:3.12-slim \
      bash /src/install.sh --src-dir /src --state-dir /var/lib/family-app/ai-trading --run-dir /run/family-app
  }

  echo "=== Install Case 1 (GREEN, task-5-review fix round 1 Critical #1): fresh bootstrap on a genuinely empty host -- group/user created, no Docker group membership -- and it NEVER installs/activates the control code or systemd unit (that is deploy.sh's own job now, so install.sh's backup-free run can never race deploy.sh's backup) ==="
  INSTALL_CASE_COUNT=$((INSTALL_CASE_COUNT + 1))
  rm -f "$IROOT/fake-state/calls.log" "$IROOT/fake-state/user-exists" "$IROOT/fake-state/group-exists"
  out1="$(run_install 2>&1)" && rc1=0 || rc1=$?
  if [[ "$rc1" != 0 ]]; then
    install_fail "install1: expected exit 0: $out1"
  else
    echo "$out1" | grep -q 'bootstrap complete' || install_fail "install1: missing success message: $out1"
    grep -q '^groupadd --gid 22001 ai-trading-gateway$' "$IROOT/fake-state/calls.log" || install_fail "install1: expected groupadd call"
    grep -q 'useradd --uid 22001 --gid 22001 --no-create-home --shell /usr/sbin/nologin --system ai-trading-gateway' "$IROOT/fake-state/calls.log" || install_fail "install1: expected useradd call without any -G docker"
    grep -q -- '-G docker' "$IROOT/fake-state/calls.log" && install_fail "install1: must never add the gateway user to the docker group"
    grep -q 'systemctl' "$IROOT/fake-state/calls.log" && install_fail "install1: install.sh must never call systemctl at all -- that is deploy.sh's own job (task-5-review fix round 1, Critical #1)"
  fi
  echo "    exit=$rc1"

  echo "=== Install Case 2 (GREEN, task-5-review fix round 1 Critical #1): install.sh NEVER touches \$APP_DIR/control or any unit path -- a pre-existing, genuinely-prior version of both is left byte-for-byte untouched ==="
  INSTALL_CASE_COUNT=$((INSTALL_CASE_COUNT + 1))
  out2="$(docker run --rm \
    -v "$IROOT/bin:/fakebin:ro" -v "$IROOT/src:/src:ro" -v "$IROOT/fake-state:/fake-state" \
    -e PATH="/fakebin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    python:3.12-slim bash -c '
set -e
mkdir -p /opt/family-app/ai-trading/control /etc/systemd/system
echo "OLD-PRIOR-CONTROL-CODE-MARKER" > /opt/family-app/ai-trading/control/state.py
echo "OLD-PRIOR-UNIT-MARKER" > /etc/systemd/system/ai-trading-control.service
bash /src/install.sh --src-dir /src --state-dir /var/lib/family-app/ai-trading --run-dir /run/family-app
cat /opt/family-app/ai-trading/control/state.py
cat /etc/systemd/system/ai-trading-control.service
' 2>&1)" && rc2=0 || rc2=$?
  if [[ "$rc2" != 0 ]]; then
    install_fail "install2: expected exit 0: $out2"
  else
    echo "$out2" | grep -q 'OLD-PRIOR-CONTROL-CODE-MARKER' || install_fail "install2: install.sh must never overwrite the genuinely prior \$APP_DIR/control/state.py: $out2"
    echo "$out2" | grep -q 'OLD-PRIOR-UNIT-MARKER' || install_fail "install2: install.sh must never overwrite the genuinely prior unit file: $out2"
  fi
  echo "    exit=$rc2"

  echo "=== Install Case 3 (GREEN): idempotent re-run never resets an existing, valid preference file ==="
  INSTALL_CASE_COUNT=$((INSTALL_CASE_COUNT + 1))
  out3="$(docker run --rm \
    -v "$IROOT/bin:/fakebin:ro" -v "$IROOT/src:/src:ro" -v "$IROOT/fake-state:/fake-state" \
    -e PATH="/fakebin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    python:3.12-slim bash -c '
set -e
mkdir -p /var/lib/family-app/ai-trading
chmod 700 /var/lib/family-app/ai-trading
cat >/var/lib/family-app/ai-trading/control.json <<EOF2
{"schemaVersion":1,"revision":7,"desired":{"tradingagents":false,"ai-hedge-fund":true,"vibe-trading":true,"mirofish":true},"results":{"tradingagents":null,"ai-hedge-fund":null,"vibe-trading":null,"mirofish":null},"lastChange":null,"operation":null}
EOF2
chmod 600 /var/lib/family-app/ai-trading/control.json
bash /src/install.sh --src-dir /src --state-dir /var/lib/family-app/ai-trading --run-dir /run/family-app
cat /var/lib/family-app/ai-trading/control.json
' 2>&1)" && rc3=0 || rc3=$?
  if [[ "$rc3" != 0 ]]; then
    install_fail "install3: expected exit 0: $out3"
  else
    echo "$out3" | grep -q '"revision":7' || install_fail "install3: pre-existing preferences were not preserved: $out3"
    echo "$out3" | grep -q '"mirofish":true' || install_fail "install3: pre-existing MiroFish preference was not preserved: $out3"
  fi
  echo "    exit=$rc3"

  echo "=== Install Case 4 (RED): occupied UID 22001 under a different name is rejected before any mutation ==="
  INSTALL_CASE_COUNT=$((INSTALL_CASE_COUNT + 1))
  mkdir -p "$IROOT/override4"
  cat >"$IROOT/override4/getent" <<'EOF'
#!/bin/bash
[[ "$1" == passwd && "$2" == 22001 ]] && { echo "someoneelse:x:22001:22001::/x:/bin/sh"; exit 0; }
exit 2
EOF
  chmod +x "$IROOT/override4/getent"
  out4="$(docker run --rm \
    -v "$IROOT/bin:/fakebin:ro" -v "$IROOT/override4:/overridebin:ro" -v "$IROOT/src:/src:ro" -v "$IROOT/fake-state:/fake-state" \
    -e PATH="/overridebin:/fakebin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    python:3.12-slim bash /src/install.sh --src-dir /src --state-dir /var/lib/family-app/ai-trading --run-dir /run/family-app 2>&1)" && rc4=0 || rc4=$?
  [[ "$rc4" != 0 ]] || install_fail "install4: expected non-zero exit for an occupied UID, got 0"
  echo "$out4" | grep -q "already in use by 'someoneelse'" || install_fail "install4: expected the occupied-UID message: $out4"
  echo "    exit=$rc4"

  echo "=== Install Case 5 (RED): rootless Docker is rejected ==="
  INSTALL_CASE_COUNT=$((INSTALL_CASE_COUNT + 1))
  mkdir -p "$IROOT/override5"
  cat >"$IROOT/override5/docker" <<'EOF'
#!/bin/bash
[[ "$1" == info ]] && { echo '[{"Name":"name=rootless"}]'; exit 0; }
exit 0
EOF
  chmod +x "$IROOT/override5/docker"
  out5="$(docker run --rm \
    -v "$IROOT/bin:/fakebin:ro" -v "$IROOT/override5:/overridebin:ro" -v "$IROOT/src:/src:ro" -v "$IROOT/fake-state:/fake-state" \
    -e PATH="/overridebin:/fakebin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    python:3.12-slim bash /src/install.sh --src-dir /src --state-dir /var/lib/family-app/ai-trading --run-dir /run/family-app 2>&1)" && rc5=0 || rc5=$?
  [[ "$rc5" != 0 ]] || install_fail "install5: expected non-zero exit for rootless Docker, got 0"
  echo "$out5" | grep -q 'rootless Docker is not supported' || install_fail "install5: expected the rootless-Docker message: $out5"
  echo "    exit=$rc5"

  echo "=== Install Case 6 (RED): Docker userns-remap is rejected ==="
  INSTALL_CASE_COUNT=$((INSTALL_CASE_COUNT + 1))
  mkdir -p "$IROOT/override6"
  cat >"$IROOT/override6/docker" <<'EOF'
#!/bin/bash
[[ "$1" == info ]] && { echo '[{"Name":"name=userns"}]'; exit 0; }
exit 0
EOF
  chmod +x "$IROOT/override6/docker"
  out6="$(docker run --rm \
    -v "$IROOT/bin:/fakebin:ro" -v "$IROOT/override6:/overridebin:ro" -v "$IROOT/src:/src:ro" -v "$IROOT/fake-state:/fake-state" \
    -e PATH="/overridebin:/fakebin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    python:3.12-slim bash /src/install.sh --src-dir /src --state-dir /var/lib/family-app/ai-trading --run-dir /run/family-app 2>&1)" && rc6=0 || rc6=$?
  [[ "$rc6" != 0 ]] || install_fail "install6: expected non-zero exit for Docker userns-remap, got 0"
  echo "$out6" | grep -q 'userns-remap is not supported' || install_fail "install6: expected the userns-remap message: $out6"
  echo "    exit=$rc6"

  echo "=== Install Case 7 (RED): a symlinked state directory is refused ==="
  INSTALL_CASE_COUNT=$((INSTALL_CASE_COUNT + 1))
  out7="$(docker run --rm \
    -v "$IROOT/bin:/fakebin:ro" -v "$IROOT/src:/src:ro" -v "$IROOT/fake-state:/fake-state" \
    -e PATH="/fakebin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    python:3.12-slim bash -c 'mkdir -p /var/lib/family-app && ln -s /tmp /var/lib/family-app/ai-trading && bash /src/install.sh --src-dir /src --state-dir /var/lib/family-app/ai-trading --run-dir /run/family-app' 2>&1)" && rc7=0 || rc7=$?
  [[ "$rc7" != 0 ]] || install_fail "install7: expected non-zero exit for a symlinked state directory, got 0"
  echo "$out7" | grep -q 'must not be a symlink' || install_fail "install7: expected the symlink-rejection message: $out7"
  echo "    exit=$rc7"

  echo "=== Install Case 8 (RED): a symlinked socket directory is refused ==="
  INSTALL_CASE_COUNT=$((INSTALL_CASE_COUNT + 1))
  out8="$(docker run --rm \
    -v "$IROOT/bin:/fakebin:ro" -v "$IROOT/src:/src:ro" -v "$IROOT/fake-state:/fake-state" \
    -e PATH="/fakebin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    python:3.12-slim bash -c 'mkdir -p /run/family-app && ln -s /tmp /run/family-app/ai-trading-control && bash /src/install.sh --src-dir /src --state-dir /var/lib/family-app/ai-trading --run-dir /run/family-app' 2>&1)" && rc8=0 || rc8=$?
  [[ "$rc8" != 0 ]] || install_fail "install8: expected non-zero exit for a symlinked socket directory, got 0"
  echo "$out8" | grep -q 'must not be a symlink' || install_fail "install8: expected the symlink-rejection message: $out8"
  echo "    exit=$rc8"

  echo "=== Install Case 9 (RED): incomplete staged source (missing catalog.json/state.py) is rejected before any mutation ==="
  INSTALL_CASE_COUNT=$((INSTALL_CASE_COUNT + 1))
  mkdir -p "$IROOT/incomplete-src/ai-trading/control"
  cp "$INSTALL_SH" "$IROOT/incomplete-src/install.sh"
  out9="$(run_install "$IROOT/incomplete-src" 2>&1)" && rc9=0 || rc9=$?
  [[ "$rc9" != 0 ]] || install_fail "install9: expected non-zero exit for incomplete artifacts, got 0"
  echo "$out9" | grep -q 'missing or non-regular required source file' || install_fail "install9: expected the incomplete-artifacts message: $out9"
  echo "    exit=$rc9"

  echo "=== Install Case 10 (GREEN): a genuinely fresh host (no docker-compose.yml) adopts the fresh-host defaults -- three standard apps on, MiroFish off ==="
  INSTALL_CASE_COUNT=$((INSTALL_CASE_COUNT + 1))
  rm -f "$IROOT/fake-state/calls.log" "$IROOT/fake-state/user-exists" "$IROOT/fake-state/group-exists"
  out10="$(docker run --rm \
    -v "$IROOT/bin:/fakebin:ro" -v "$IROOT/src:/src:ro" -v "$IROOT/fake-state:/fake-state" \
    -e PATH="/fakebin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    python:3.12-slim bash -c 'bash /src/install.sh --src-dir /src --state-dir /var/lib/family-app/ai-trading --run-dir /run/family-app && cat /var/lib/family-app/ai-trading/control.json' 2>&1)" && rc10=0 || rc10=$?
  if [[ "$rc10" != 0 ]]; then
    install_fail "install10: expected exit 0: $out10"
  else
    echo "$out10" | grep -q '"tradingagents":true' || install_fail "install10: expected tradingagents on by default: $out10"
    echo "$out10" | grep -q '"mirofish":false' || install_fail "install10: expected mirofish off by default: $out10"
  fi
  echo "    exit=$rc10"

  echo "=== Install Case 11 (GREEN): an existing stack adopts ANY actually running app, including MiroFish, instead of the fresh-host defaults ==="
  INSTALL_CASE_COUNT=$((INSTALL_CASE_COUNT + 1))
  mkdir -p "$IROOT/override11"
  # Hardened docker ps contract (was: ignored --format entirely and always
  # printed a fixed, bare service-name list -- a real Docker daemon rejects
  # install.sh's actual format template `{{index .Labels "..."}}` with
  # "cannot index slice/array with type string" because `ps`'s own .Labels
  # is a flat string, not a map, unlike `docker inspect`'s .Config.Labels.
  # This fake now actually inspects the --format argument it is given and
  # fails exactly like real Docker would for that broken accessor, so a
  # regression back to `index .Labels` fails THIS install case, not just
  # the separate genuine-Docker probe below.
  cat >"$IROOT/override11/docker" <<'EOF'
#!/bin/bash
if [[ "$1" == info ]]; then echo '[{"Name":"seccomp"}]'; exit 0; fi
if [[ "$1" == ps ]]; then
  format=""
  prev=""
  for arg in "$@"; do
    [[ "$prev" == --format ]] && format="$arg"
    prev="$arg"
  done
  case "$format" in
    *'index .Labels'*)
      echo 'failed to execute template: template: :1:2: executing "" at <index .Labels "com.docker.compose.service">: error calling index: cannot index slice/array with type string' >&2
      exit 1
      ;;
    '{{.Label "com.docker.compose.service"}}')
      printf 'mirofish\nvibe-trading\n'
      exit 0
      ;;
    *)
      echo "fake docker ps: unexpected --format: $format" >&2
      exit 1
      ;;
  esac
fi
exit 0
EOF
  chmod +x "$IROOT/override11/docker"
  out11="$(docker run --rm \
    -v "$IROOT/bin:/fakebin:ro" -v "$IROOT/override11:/overridebin:ro" -v "$IROOT/src:/src:ro" -v "$IROOT/fake-state:/fake-state" \
    -e PATH="/overridebin:/fakebin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    python:3.12-slim bash -c '
install -d /opt/family-app/ai-trading
touch /opt/family-app/ai-trading/docker-compose.yml
bash /src/install.sh --src-dir /src --state-dir /var/lib/family-app/ai-trading --run-dir /run/family-app
cat /var/lib/family-app/ai-trading/control.json
' 2>&1)" && rc11=0 || rc11=$?
  if [[ "$rc11" != 0 ]]; then
    install_fail "install11: expected exit 0: $out11"
  else
    echo "$out11" | grep -q '"mirofish":true' || install_fail "install11: expected MiroFish adopted as on (actually running): $out11"
    echo "$out11" | grep -q '"vibe-trading":true' || install_fail "install11: expected vibe-trading adopted as on: $out11"
    echo "$out11" | grep -q '"tradingagents":false' || install_fail "install11: expected tradingagents adopted as off (not running): $out11"
  fi
  echo "    exit=$rc11"

  echo "=== Install Case 12 (GREEN, real systemd-analyze, task-5-review minor ledger): a genuinely valid unit file passes the REAL systemd-analyze verify binary (no PID 1 needed -- static analysis only), run against deploy.sh's own stage_unit() validation path ==="
  INSTALL_CASE_COUNT=$((INSTALL_CASE_COUNT + 1))
  if docker run --rm debian:12-slim bash -c 'command -v apt-get' >/dev/null 2>&1; then
    out12="$(docker run --rm -v "$UNIT_FILE:/unit/ai-trading-control.service:ro" debian:12-slim bash -c '
set -e
apt-get update -qq >/dev/null 2>&1
apt-get install -y -qq systemd python3 >/dev/null 2>&1
mkdir -p /opt/family-app/ai-trading/control
touch /opt/family-app/ai-trading/control/server.py
cat >/etc/systemd/system/docker.service <<EOF2
[Unit]
Description=dummy docker for verify
[Service]
ExecStart=/usr/bin/true
EOF2
systemd-analyze verify /unit/ai-trading-control.service
echo VERIFY_OK
' 2>&1)" && rc12=0 || rc12=$?
    if [[ "$rc12" != 0 ]]; then
      install_fail "install12: real systemd-analyze verify failed against the actual production unit: $out12"
    else
      echo "$out12" | grep -q VERIFY_OK || install_fail "install12: expected VERIFY_OK: $out12"
    fi
    echo "    exit=$rc12"
  else
    echo "    SKIP: debian:12-slim/apt-get unavailable -- real systemd-analyze probe not run"
  fi

  echo "=== Install Case 13 (GREEN, genuine Docker probe, task-5-review no-other-callers follow-up): the EXACT 'docker ps --format' template install.sh ships -- read from install.sh itself, never a hardcoded copy -- is run by the REAL local Docker daemon against a disposable, network-disabled, uniquely-labeled dummy container, and must correctly extract its compose-service label. Guards production even if a test-only fake's contract goes stale again: no Docker socket is mounted into any fixture above, and no ai-trading/expense container, image, volume, or real username is touched. The dummy container runs python:3.12-slim (never busybox -- that name only ever appears inside this file's FAKE docker-compose.yml fixture *content*, never actually run as a container, so it is NOT guaranteed pulled on a cold runner); python:3.12-slim is the one image this very suite already actually pulls and runs moments earlier, in Install Case 1 above, so by construction it is always already cached here, with no new image, dependency, or network fetch added by this case ==="
  INSTALL_CASE_COUNT=$((INSTALL_CASE_COUNT + 1))
  probe_format="$(awk '/docker ps --filter/{found=1} found && /--format/{print; exit}' "$INSTALL_SH" \
    | grep -oE "'\{\{[^']*\}\}'" | sed -E "s/^'(.*)'\$/\1/")"
  if [[ -z "$probe_format" ]]; then
    install_fail "install13: could not read install.sh's own 'docker ps --format' template"
  else
    probe_id="ai-trading-install-probe-$$"
    probe_service="probe-service-$$"
    rc13=0
    (
      trap 'docker rm -f "$probe_id" >/dev/null 2>&1 || true' EXIT
      docker run -d --network none \
        --label "com.docker.compose.project=$probe_id" \
        --label "com.docker.compose.service=$probe_service" \
        --name "$probe_id" python:3.12-slim sleep 30 >/dev/null
      probe_got="$(docker ps --filter "label=com.docker.compose.project=$probe_id" --format "$probe_format")"
      [[ "$probe_got" == "$probe_service" ]] \
        || { echo "install13: expected '$probe_service' from the real daemon via install.sh's own template '$probe_format', got '$probe_got'" >&2; exit 1; }
    ) 2>"$IROOT/install13-stderr.log" || rc13=$?
    [[ "$rc13" == 0 ]] || install_fail "install13: $(cat "$IROOT/install13-stderr.log" 2>/dev/null)"
    echo "    exit=$rc13"
  fi

  echo
  if [[ "$INSTALL_FAIL_COUNT" -eq 0 ]]; then
    echo "RESULT: GREEN -- $INSTALL_CASE_COUNT cases, 0 failures (Linux installer)"
  else
    echo "RESULT: RED -- $INSTALL_CASE_COUNT cases, $INSTALL_FAIL_COUNT failure(s) (Linux installer)"
  fi
fi

TOTAL_FAIL=$((SHELL_FAILURES + INSTALL_FAIL_COUNT))
[[ "$TOTAL_FAIL" -eq 0 ]]
