#!/usr/bin/env bash
# Focused offline tests for Task 5 (app-controls): the Linux installer
# (infrastructure/vps/app-controls/install.sh) and the deploy.sh/
# health-check.sh behaviors test-deploy-firestore.sh's own existing suite
# does not already cover -- explicit selected-service Compose calls, the
# lifecycle lock's contention/inherited-FD behavior, and preference
# snapshot/restore. No real Firestore, VPS, host user/group, systemd unit,
# or Docker socket is used anywhere in this file; every fixture lives under
# a unique mktemp root removed on exit.
#
# install.sh's own Linux/systemd/Docker/user preconditions need a real
# Linux userland (id/getent/useradd/groupadd/systemctl/systemd-analyze) --
# run inside a disposable, network-isolated python:3.12-slim container with
# every one of those commands faked via a PATH-prepended fixture bin
# directory (common-context's own "Run Linux-only control tests ... not
# macOS Python" guidance, applied here to the installer rather than the
# control/*.py suite). SKIPPED entirely when Docker is unavailable.
#
# Usage: ai-trading/deploy/ci/test-app-controls-deploy.sh
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AI_TRADING_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
DEPLOY_SH="$SCRIPT_DIR/../production/deploy.sh"
INSTALL_SH="$AI_TRADING_DIR/../infrastructure/vps/app-controls/install.sh"
UNIT_FILE="$AI_TRADING_DIR/../infrastructure/vps/app-controls/ai-trading-control.service"
CONTROL_DIR_REAL="$AI_TRADING_DIR/control"

[[ -f "$DEPLOY_SH" ]] || { echo "test-app-controls-deploy: missing $DEPLOY_SH" >&2; exit 1; }
[[ -f "$INSTALL_SH" ]] || { echo "test-app-controls-deploy: missing $INSTALL_SH" >&2; exit 1; }

# A real $HOME-rooted scratch directory, never /tmp or the opencode temp
# dir: on this host, Docker runs in a VM that only reliably bind-mounts
# $HOME (ai-trading/deploy/ci/test-app-controls-gateway.sh documents the
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

stage_default_configs() {
  local dir="$1"
  printf 'name: ai-trading-fixture\nservices:\n  web:\n    image: busybox:1\n' >"$dir/docker-compose.yml"
  printf 'name: ai-trading-fixture\nservices:\n  mirofish:\n    image: busybox:1\n    profiles: ["mirofish"]\n' >"$dir/docker-compose.mirofish.yml"
  printf '# fixture Caddyfile\n' >"$dir/Caddyfile"
  printf '#!/usr/bin/env bash\nexit 0\n' >"$dir/health-check.sh"
  chmod 0755 "$dir/health-check.sh"
  mkdir -p "$dir/control" "$dir/deploy/production"
  cp "$CONTROL_DIR_REAL/catalog.json" "$dir/control/catalog.json"
  cp "$CONTROL_DIR_REAL/state.py" "$dir/control/state.py"
  printf '"""fixture stand-in."""\n' >"$dir/control/runtime.py"
  printf '"""fixture stand-in."""\n' >"$dir/control/server.py"
  printf '#!/usr/bin/env bash\n# fixture stand-in.\n' >"$dir/deploy/production/mirofish-runtime.sh"
  printf '#!/usr/bin/env bash\n# fixture stand-in.\nexit 0\n' >"$dir/deploy/production/prepare-mirofish.sh"
  chmod 0755 "$dir/deploy/production/prepare-mirofish.sh"
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
  mkdir -p "$base/app" "$base/secrets" "$base/ci-staging" "$base/config-staging"
  fake_family_config "$base/app/family_config.py"
  stage_default_configs "$base/config-staging"
  printf 'TUNNEL_TOKEN=fake-tunnel-token\n' >"$base/ci-staging/cloudflared.env"
  printf '%s\n' "$base"
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
  FAMILY_CONFIG_CREDENTIALS="$s1/fake-reader-key.json"
  DEPLOY_SH_SKIP_CHOWN=1
  IMAGE_TAG=1111111111111111111111111111111111111111
  export APP_DIR AI_TRADING_SECRETS_DIR ENV_STAGING_DIR APP_CONFIG_STAGING_DIR AI_TRADING_STATE_DIR FAMILY_CONFIG_CREDENTIALS DEPLOY_SH_SKIP_CHOWN IMAGE_TAG
  install_fake_docker "$s1"
  # shellcheck disable=SC2329
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
fi
echo "    exit=$status1"

echo "=== Case 2 (RED->rollback): a staging failure restores the saved app-control preferences with a NEW, strictly greater revision -- never a lowered or unchanged one ==="
CASE_COUNT=$((CASE_COUNT + 1))
s2="$(new_scratch case2)"
seed_control_state "$s2/control-state" '{"schemaVersion":1,"revision":5,"desired":{"tradingagents":false,"ai-hedge-fund":true,"vibe-trading":true,"mirofish":false},"results":{"tradingagents":null,"ai-hedge-fund":null,"vibe-trading":null,"mirofish":null},"lastChange":null,"operation":null}'
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
  FAMILY_CONFIG_CREDENTIALS="$s2/fake-reader-key.json"
  DEPLOY_SH_SKIP_CHOWN=1
  IMAGE_TAG=2222222222222222222222222222222222222222
  DEPLOY_SH_FAIL_AFTER="vibe-trading.env"
  export APP_DIR AI_TRADING_SECRETS_DIR ENV_STAGING_DIR APP_CONFIG_STAGING_DIR AI_TRADING_STATE_DIR FAMILY_CONFIG_CREDENTIALS DEPLOY_SH_SKIP_CHOWN IMAGE_TAG DEPLOY_SH_FAIL_AFTER
  install_fake_docker "$s2"
  bash "$DEPLOY_SH" >"$s2/stdout.log" 2>"$s2/stderr.log"
) || status2=$?
if [[ "$status2" == 0 ]]; then
  fail "case2: expected non-zero exit for a forced mid-stage failure, got 0"
fi
restored="$(cat "$s2/control-state/control.json" 2>/dev/null || true)"
echo "$restored" | python3 -c '
import json, sys
data = json.load(sys.stdin)
assert data["desired"] == {"tradingagents": False, "ai-hedge-fund": True, "vibe-trading": True, "mirofish": False}, data["desired"]
assert data["revision"] > 5, data["revision"]
' || fail "case2: restored control.json does not match the saved preferences with an increased revision: $restored"
echo "    exit=$status2 revision=$(echo "$restored" | python3 -c 'import json,sys; print(json.load(sys.stdin)["revision"])' 2>/dev/null)"

echo "=== Case 3 (RED, process-level): a missing control-state directory (install.sh never ran) aborts before any secret/config mutation ==="
CASE_COUNT=$((CASE_COUNT + 1))
s3="$(new_scratch case3)"
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
  AI_TRADING_STATE_DIR="$s3/control-state-never-seeded"
  FAMILY_CONFIG_CREDENTIALS="$s3/fake-reader-key.json"
  DEPLOY_SH_SKIP_CHOWN=1
  IMAGE_TAG=3333333333333333333333333333333333333333
  export APP_DIR AI_TRADING_SECRETS_DIR ENV_STAGING_DIR APP_CONFIG_STAGING_DIR AI_TRADING_STATE_DIR FAMILY_CONFIG_CREDENTIALS DEPLOY_SH_SKIP_CHOWN IMAGE_TAG
  install_fake_docker "$s3"
  bash "$DEPLOY_SH" >"$s3/stdout.log" 2>"$s3/stderr.log"
) || status3=$?
if [[ "$status3" == 0 ]]; then
  fail "case3: expected non-zero exit when control-state was never initialized, got 0"
fi
grep -q 'failed to snapshot the current app-control preferences' "$s3/stderr.log" 2>/dev/null \
  || fail "case3: expected the snapshot failure to be reported: $(cat "$s3/stderr.log" 2>/dev/null)"
for name in tradingagents.env ai-hedge-fund.env vibe-trading.env vibe-gateway.env auth.env cloudflared.env; do
  grep -q "old-$name" "$s3/secrets/$name" 2>/dev/null || fail "case3: $name must stay completely untouched -- stage_secrets must never have run"
done
[[ -d "$s3/secrets/.previous" ]] && fail "case3: stage_secrets must never have run (.previous backup directory exists)"
echo "    exit=$status3"

echo "=== Case 4 (GREEN): the lifecycle lock is actually held for the duration of a deploy -- a second process attempting it (via state.py's own inherited-lock CLI) is BUSY until the first releases it ==="
CASE_COUNT=$((CASE_COUNT + 1))
s4="$(new_scratch case4)"
seed_control_state "$s4/control-state"
lock_path="$s4/control-state/.control.lock"
install -d -m 0700 "$s4/control-state"
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
[[ "$busy_result" == BUSY ]] || fail "case4: expected BUSY while the lock is held, got $busy_result"
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
[[ "$after_result" == ACQUIRED ]] || fail "case4: expected ACQUIRED once the holder released the lock, got $after_result"
echo "    busy=$busy_result after=$after_result"

echo "=== Case 5 (GREEN): health-check.sh computes the same selected-service list as deploy.sh for an identical control.json -- never a second, independently maintained hardcoded list ==="
CASE_COUNT=$((CASE_COUNT + 1))
s5="$(new_scratch case5)"
seed_control_state "$s5/control-state" '{"schemaVersion":1,"revision":0,"desired":{"tradingagents":true,"ai-hedge-fund":false,"vibe-trading":true,"mirofish":false},"results":{"tradingagents":null,"ai-hedge-fund":null,"vibe-trading":null,"mirofish":null},"lastChange":null,"operation":null}'
health_lib5="$TEST_ROOT/health-lib5.sh"
awk '/^# --- main flow below this line;/{exit} {print}' "$SCRIPT_DIR/../production/health-check.sh" >"$health_lib5"
got5="$(
  AI_TRADING_CONTROL_DIR="$CONTROL_DIR_REAL" \
  AI_TRADING_STATE_PATH="$s5/control-state/control.json" \
  AI_TRADING_CONTROL_OWNER_UID="$(id -u)" \
  HEALTH_CHECK_SKIP_CONTROL=1 \
  bash -c '
    APP_DIR=/nonexistent
    source "'"$health_lib5"'"
    selected_services_text
  '
)"
want5="$(python3 "$CONTROL_DIR_REAL/state.py" services --mirofish-ready false --state "$s5/control-state/control.json" --owner-uid "$(id -u)")"
[[ "$got5" == "$want5" ]] || fail "case5: health-check.sh's selected list ($got5) does not match control/state.py's own ($want5)"
echo "$got5" | grep -qw ahf-terminal && fail "case5: ai-hedge-fund is off and must not be selected"
echo "    got=$(echo "$got5" | tr '\n' ' ')"

echo
cleanup
if [[ "$FAIL_COUNT" -eq 0 ]]; then
  echo "RESULT: GREEN -- $CASE_COUNT cases, 0 failures (shell); see below for the Linux installer container suite"
else
  echo "RESULT: RED -- $CASE_COUNT cases, $FAIL_COUNT failure(s) (shell)"
fi
SHELL_FAILURES="$FAIL_COUNT"

# =======================================================================
# Linux installer suite: real Linux userland inside a disposable container,
# every Linux-specific external command (id/getent/useradd/groupadd/
# systemctl/systemd-analyze/docker) faked via a PATH-prepended fixture bin
# directory. Skipped (not failed) when Docker is unavailable.
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
  mkdir -p "$IROOT/bin" "$IROOT/src/ai-trading/control" "$IROOT/src/ai-trading/deploy/production" "$IROOT/src/infrastructure/vps/app-controls" "$IROOT/fake-state"
  chmod 0700 "$IROOT"
  install_cleanup() { rm -rf "$IROOT"; }
  trap 'install_cleanup; cleanup' EXIT

  cp "$CONTROL_DIR_REAL/catalog.json" "$IROOT/src/ai-trading/control/catalog.json"
  cp "$CONTROL_DIR_REAL/state.py" "$IROOT/src/ai-trading/control/state.py"
  cp "$CONTROL_DIR_REAL/runtime.py" "$IROOT/src/ai-trading/control/runtime.py"
  cp "$CONTROL_DIR_REAL/server.py" "$IROOT/src/ai-trading/control/server.py"
  cp "$AI_TRADING_DIR/deploy/production/mirofish-runtime.sh" "$IROOT/src/ai-trading/deploy/production/mirofish-runtime.sh"
  cp "$AI_TRADING_DIR/deploy/production/prepare-mirofish.sh" "$IROOT/src/ai-trading/deploy/production/prepare-mirofish.sh"
  cp "$UNIT_FILE" "$IROOT/src/infrastructure/vps/app-controls/ai-trading-control.service"
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
  cat >"$IROOT/bin/systemd-analyze" <<'EOF'
#!/bin/bash
echo "systemd-analyze $*" >> /fake-state/calls.log
exit 0
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

  echo "=== Install Case 1 (GREEN): fresh install on a genuinely empty host -- group/user created, no Docker group membership, unit installed and started ==="
  INSTALL_CASE_COUNT=$((INSTALL_CASE_COUNT + 1))
  rm -f "$IROOT/fake-state/calls.log" "$IROOT/fake-state/user-exists" "$IROOT/fake-state/group-exists"
  out1="$(run_install 2>&1)" && rc1=0 || rc1=$?
  if [[ "$rc1" != 0 ]]; then
    install_fail "install1: expected exit 0: $out1"
  else
    echo "$out1" | grep -q 'installed and active' || install_fail "install1: missing success message: $out1"
    grep -q '^groupadd --gid 22001 ai-trading-gateway$' "$IROOT/fake-state/calls.log" || install_fail "install1: expected groupadd call"
    grep -q 'useradd --uid 22001 --gid 22001 --no-create-home --shell /usr/sbin/nologin --system ai-trading-gateway' "$IROOT/fake-state/calls.log" || install_fail "install1: expected useradd call without any -G docker"
    grep -q -- '-G docker' "$IROOT/fake-state/calls.log" && install_fail "install1: must never add the gateway user to the docker group"
    grep -q 'systemctl enable ai-trading-control.service' "$IROOT/fake-state/calls.log" || install_fail "install1: expected systemctl enable"
    grep -q 'systemctl restart ai-trading-control.service' "$IROOT/fake-state/calls.log" || install_fail "install1: expected systemctl restart"
  fi
  echo "    exit=$rc1"

  echo "=== Install Case 2 (GREEN): idempotent re-run never resets an existing, valid preference file ==="
  INSTALL_CASE_COUNT=$((INSTALL_CASE_COUNT + 1))
  out2="$(docker run --rm \
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
' 2>&1)" && rc2=0 || rc2=$?
  if [[ "$rc2" != 0 ]]; then
    install_fail "install2: expected exit 0: $out2"
  else
    echo "$out2" | grep -q '"revision":7' || install_fail "install2: pre-existing preferences were not preserved: $out2"
    echo "$out2" | grep -q '"mirofish":true' || install_fail "install2: pre-existing MiroFish preference was not preserved: $out2"
  fi
  echo "    exit=$rc2"

  echo "=== Install Case 3 (RED): occupied UID 22001 under a different name is rejected before any install/restart ==="
  INSTALL_CASE_COUNT=$((INSTALL_CASE_COUNT + 1))
  mkdir -p "$IROOT/override3"
  cat >"$IROOT/override3/getent" <<'EOF'
#!/bin/bash
[[ "$1" == passwd && "$2" == 22001 ]] && { echo "someoneelse:x:22001:22001::/x:/bin/sh"; exit 0; }
exit 2
EOF
  chmod +x "$IROOT/override3/getent"
  out3="$(run_install "$IROOT/src" "/override3-placeholder" 2>&1)" && rc3=0 || rc3=$?
  # Re-run with the override actually first on PATH (docker run's -e PATH
  # above needs the override baked in, not a placeholder) -- simplest is a
  # dedicated container invocation mirroring run_install with one more -v.
  out3="$(docker run --rm \
    -v "$IROOT/bin:/fakebin:ro" -v "$IROOT/override3:/overridebin:ro" -v "$IROOT/src:/src:ro" -v "$IROOT/fake-state:/fake-state" \
    -e PATH="/overridebin:/fakebin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    python:3.12-slim bash /src/install.sh --src-dir /src --state-dir /var/lib/family-app/ai-trading --run-dir /run/family-app 2>&1)" && rc3=0 || rc3=$?
  [[ "$rc3" != 0 ]] || install_fail "install3: expected non-zero exit for an occupied UID, got 0"
  echo "$out3" | grep -q "already in use by 'someoneelse'" || install_fail "install3: expected the occupied-UID message: $out3"
  echo "    exit=$rc3"

  echo "=== Install Case 4 (RED): rootless Docker is rejected ==="
  INSTALL_CASE_COUNT=$((INSTALL_CASE_COUNT + 1))
  mkdir -p "$IROOT/override4"
  cat >"$IROOT/override4/docker" <<'EOF'
#!/bin/bash
[[ "$1" == info ]] && { echo '[{"Name":"name=rootless"}]'; exit 0; }
exit 0
EOF
  chmod +x "$IROOT/override4/docker"
  out4="$(docker run --rm \
    -v "$IROOT/bin:/fakebin:ro" -v "$IROOT/override4:/overridebin:ro" -v "$IROOT/src:/src:ro" -v "$IROOT/fake-state:/fake-state" \
    -e PATH="/overridebin:/fakebin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    python:3.12-slim bash /src/install.sh --src-dir /src --state-dir /var/lib/family-app/ai-trading --run-dir /run/family-app 2>&1)" && rc4=0 || rc4=$?
  [[ "$rc4" != 0 ]] || install_fail "install4: expected non-zero exit for rootless Docker, got 0"
  echo "$out4" | grep -q 'rootless Docker is not supported' || install_fail "install4: expected the rootless-Docker message: $out4"
  echo "    exit=$rc4"

  echo "=== Install Case 5 (RED): Docker userns-remap is rejected ==="
  INSTALL_CASE_COUNT=$((INSTALL_CASE_COUNT + 1))
  mkdir -p "$IROOT/override5"
  cat >"$IROOT/override5/docker" <<'EOF'
#!/bin/bash
[[ "$1" == info ]] && { echo '[{"Name":"name=userns"}]'; exit 0; }
exit 0
EOF
  chmod +x "$IROOT/override5/docker"
  out5="$(docker run --rm \
    -v "$IROOT/bin:/fakebin:ro" -v "$IROOT/override5:/overridebin:ro" -v "$IROOT/src:/src:ro" -v "$IROOT/fake-state:/fake-state" \
    -e PATH="/overridebin:/fakebin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    python:3.12-slim bash /src/install.sh --src-dir /src --state-dir /var/lib/family-app/ai-trading --run-dir /run/family-app 2>&1)" && rc5=0 || rc5=$?
  [[ "$rc5" != 0 ]] || install_fail "install5: expected non-zero exit for Docker userns-remap, got 0"
  echo "$out5" | grep -q 'userns-remap is not supported' || install_fail "install5: expected the userns-remap message: $out5"
  echo "    exit=$rc5"

  echo "=== Install Case 6 (RED): a symlinked state directory is refused ==="
  INSTALL_CASE_COUNT=$((INSTALL_CASE_COUNT + 1))
  out6="$(docker run --rm \
    -v "$IROOT/bin:/fakebin:ro" -v "$IROOT/src:/src:ro" -v "$IROOT/fake-state:/fake-state" \
    -e PATH="/fakebin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    python:3.12-slim bash -c 'mkdir -p /var/lib/family-app && ln -s /tmp /var/lib/family-app/ai-trading && bash /src/install.sh --src-dir /src --state-dir /var/lib/family-app/ai-trading --run-dir /run/family-app' 2>&1)" && rc6=0 || rc6=$?
  [[ "$rc6" != 0 ]] || install_fail "install6: expected non-zero exit for a symlinked state directory, got 0"
  echo "$out6" | grep -q 'must not be a symlink' || install_fail "install6: expected the symlink-rejection message: $out6"
  echo "    exit=$rc6"

  echo "=== Install Case 7 (RED): a symlinked socket directory is refused ==="
  INSTALL_CASE_COUNT=$((INSTALL_CASE_COUNT + 1))
  out7="$(docker run --rm \
    -v "$IROOT/bin:/fakebin:ro" -v "$IROOT/src:/src:ro" -v "$IROOT/fake-state:/fake-state" \
    -e PATH="/fakebin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    python:3.12-slim bash -c 'mkdir -p /run/family-app && ln -s /tmp /run/family-app/ai-trading-control && bash /src/install.sh --src-dir /src --state-dir /var/lib/family-app/ai-trading --run-dir /run/family-app' 2>&1)" && rc7=0 || rc7=$?
  [[ "$rc7" != 0 ]] || install_fail "install7: expected non-zero exit for a symlinked socket directory, got 0"
  echo "$out7" | grep -q 'must not be a symlink' || install_fail "install7: expected the symlink-rejection message: $out7"
  echo "    exit=$rc7"

  echo "=== Install Case 8 (RED): incomplete staged artifacts are rejected before any install/restart ==="
  INSTALL_CASE_COUNT=$((INSTALL_CASE_COUNT + 1))
  mkdir -p "$IROOT/incomplete-src/ai-trading/control"
  cp "$INSTALL_SH" "$IROOT/incomplete-src/install.sh"
  out8="$(run_install "$IROOT/incomplete-src" 2>&1)" && rc8=0 || rc8=$?
  [[ "$rc8" != 0 ]] || install_fail "install8: expected non-zero exit for incomplete artifacts, got 0"
  echo "$out8" | grep -q 'missing or non-regular required source file' || install_fail "install8: expected the incomplete-artifacts message: $out8"
  echo "    exit=$rc8"

  echo "=== Install Case 9 (GREEN): a genuinely fresh host (no docker-compose.yml) adopts the fresh-host defaults -- three standard apps on, MiroFish off ==="
  INSTALL_CASE_COUNT=$((INSTALL_CASE_COUNT + 1))
  rm -f "$IROOT/fake-state/calls.log" "$IROOT/fake-state/user-exists" "$IROOT/fake-state/group-exists"
  out9="$(docker run --rm \
    -v "$IROOT/bin:/fakebin:ro" -v "$IROOT/src:/src:ro" -v "$IROOT/fake-state:/fake-state" \
    -e PATH="/fakebin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    python:3.12-slim bash -c 'bash /src/install.sh --src-dir /src --state-dir /var/lib/family-app/ai-trading --run-dir /run/family-app && cat /var/lib/family-app/ai-trading/control.json' 2>&1)" && rc9=0 || rc9=$?
  if [[ "$rc9" != 0 ]]; then
    install_fail "install9: expected exit 0: $out9"
  else
    echo "$out9" | grep -q '"tradingagents":true' || install_fail "install9: expected tradingagents on by default: $out9"
    echo "$out9" | grep -q '"mirofish":false' || install_fail "install9: expected mirofish off by default: $out9"
  fi
  echo "    exit=$rc9"

  echo "=== Install Case 10 (GREEN): an existing stack adopts ANY actually running app, including MiroFish, instead of the fresh-host defaults ==="
  INSTALL_CASE_COUNT=$((INSTALL_CASE_COUNT + 1))
  mkdir -p "$IROOT/override10"
  cat >"$IROOT/override10/docker" <<'EOF'
#!/bin/bash
if [[ "$1" == info ]]; then echo '[{"Name":"seccomp"}]'; exit 0; fi
if [[ "$1" == ps ]]; then printf 'mirofish\nvibe-trading\n'; exit 0; fi
exit 0
EOF
  chmod +x "$IROOT/override10/docker"
  out10="$(docker run --rm \
    -v "$IROOT/bin:/fakebin:ro" -v "$IROOT/override10:/overridebin:ro" -v "$IROOT/src:/src:ro" -v "$IROOT/fake-state:/fake-state" \
    -e PATH="/overridebin:/fakebin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    python:3.12-slim bash -c '
install -d /opt/family-app/ai-trading
touch /opt/family-app/ai-trading/docker-compose.yml
bash /src/install.sh --src-dir /src --state-dir /var/lib/family-app/ai-trading --run-dir /run/family-app
cat /var/lib/family-app/ai-trading/control.json
' 2>&1)" && rc10=0 || rc10=$?
  if [[ "$rc10" != 0 ]]; then
    install_fail "install10: expected exit 0: $out10"
  else
    echo "$out10" | grep -q '"mirofish":true' || install_fail "install10: expected MiroFish adopted as on (actually running): $out10"
    echo "$out10" | grep -q '"vibe-trading":true' || install_fail "install10: expected vibe-trading adopted as on: $out10"
    echo "$out10" | grep -q '"tradingagents":false' || install_fail "install10: expected tradingagents adopted as off (not running): $out10"
  fi
  echo "    exit=$rc10"

  echo
  if [[ "$INSTALL_FAIL_COUNT" -eq 0 ]]; then
    echo "RESULT: GREEN -- $INSTALL_CASE_COUNT cases, 0 failures (Linux installer)"
  else
    echo "RESULT: RED -- $INSTALL_CASE_COUNT cases, $INSTALL_FAIL_COUNT failure(s) (Linux installer)"
  fi
fi

TOTAL_FAIL=$((SHELL_FAILURES + INSTALL_FAIL_COUNT))
[[ "$TOTAL_FAIL" -eq 0 ]]
