#!/usr/bin/env bash
# ShellCheck cannot see test shims called through the sourced deploy functions.
# shellcheck disable=SC2317,SC2329
# Offline test for the Vibe release gate across a long `compose pull`
# (production incident 2026-11-01, ai-trading-deploy runs 41272700983 ..
# 41275454516): the drain lease Vibe issues expires 600 s after its last
# renewal, the release pull can outlive that, and the pre-switch re-check then
# aborted every deploy with no cause in the log.
#
# Cases:
#   2  a lease that is genuinely lost mid-pull still aborts before the switch,
#      and says why
#   3  every other pre-switch refusal (chat admitted, container replaced,
#      bootstrap bound) still aborts, names its cause, and the heartbeat never
#      renews past the bound
#   4  a gate with no lease (none, legacy) sends no lease traffic during a pull
#   5  a failing pull still reaches the caller's ERR trap with the pull's own
#      exit status, and no heartbeat outlives the call
#   6  begin_vibe_release_gate / wait_for_vibe_idle name each failing branch
#
# The fake Vibe server keeps its lease deadline in a file (real seconds, a
# TTL of FAKE_TTL) because every drain request runs in a command substitution.
# No Docker, Vibe, GitHub or VPS is touched; everything lives under one mktemp -d.
#
# Usage: infrastructure/apps/ai-trading/tests/test-vibe-gate-pull.sh
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_SH="$SCRIPT_DIR/../deploy.sh"
MIROFISH_LIB_SH="$SCRIPT_DIR/../mirofish-runtime.sh"
[[ -f "$DEPLOY_SH" ]] || { echo "test-vibe-gate-pull: missing $DEPLOY_SH" >&2; exit 1; }
[[ -f "$MIROFISH_LIB_SH" ]] || { echo "test-vibe-gate-pull: missing $MIROFISH_LIB_SH" >&2; exit 1; }

TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT
FAIL_COUNT=0
CASE_COUNT=0
fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  echo "    FAIL: $*" >&2
}

# Same marker-based technique as test-deploy-firestore.sh: deploy.sh's function
# definitions without its main flow.
LIB_FILE="$TEST_ROOT/deploy-lib.sh"
awk '/^# --- main flow below this line;/{exit} {print}' "$DEPLOY_SH" >"$LIB_FILE"
cp "$MIROFISH_LIB_SH" "$TEST_ROOT/mirofish-runtime.sh"

LEASE=fake-private-lease-abcdef1234567890
SHA=0000000000000000000000000000000000000000

new_dir() {
  local d="$TEST_ROOT/$1"
  mkdir -p "$d/app" "$d/secrets" "$d/scratch/control"
  printf '#!/usr/bin/env bash\nexit 0\n' >"$d/scratch/health-check.sh"
  chmod 0755 "$d/scratch/health-check.sh"
  echo "$d"
}

# shims D: the deploy_tag collaborators and a fake Vibe server. FAKE_TTL is the
# server's lease lifetime in real seconds; FAKE_COUNTS is "<chat> <committees>".
shims() {
  D="$1"
  FAKE_TTL="${FAKE_TTL:-4}"
  FAKE_COUNTS="${FAKE_COUNTS:-0 0}"
  export D FAKE_TTL FAKE_COUNTS
  vibe_drain_request() {
    local action="$2" lease="${3:-}" now deadline
    now="$(date +%s)"
    printf '%s\n' "$action" >>"$D/requests.log"
    if [[ "$action" == start ]]; then
      echo $((now + FAKE_TTL)) >"$D/deadline"
      printf '{"lease":"%s"}\n' "$LEASE"
      return 0
    fi
    [[ "$lease" == "$LEASE" && -f "$D/deadline" ]] || return 1
    deadline="$(cat "$D/deadline")"
    ((now < deadline)) || return 1 # expired server-side, like a 409
    case "$action" in
      renew) echo $((now + FAKE_TTL)) >"$D/deadline"; printf '{"status":"renewed"}\n' ;;
      # shellcheck disable=SC2086 # FAKE_COUNTS is two words on purpose
      status) printf '{"active_chat":%s,"active_private_committees":%s}\n' ${FAKE_COUNTS} ;;
      release) rm -f "$D/deadline"; printf '{"status":"released"}\n' ;;
      *) return 1 ;;
    esac
  }
  compose() {
    printf '%s\n' "$*" >>"$D/compose.log"
    if [[ "${1:-}" == pull ]]; then
      sleep "${FAKE_PULL_SECONDS:-0}"
      [[ "${FAKE_PULL_FAIL:-0}" == 0 ]] || return 17
    fi
    return 0
  }
  migrate_desk_db() { echo migrate >>"$D/steps.log"; }
  apply_selected_services() { echo app-up >>"$D/steps.log"; }
  stop_disabled_groups() { return 0; }
  vibe_container_ids() { echo old-vibe-container; }
  legacy_marker_owned() { return 0; }
  vibe_monotonic_seconds() { echo 1000; }
}

# gate_open: the state begin_vibe_release_gate leaves behind in runtime mode.
gate_open() {
  VIBE_GATE_MODE=runtime
  VIBE_GATE_CONTAINER_ID=old-vibe-container
  VIBE_DRAIN_LEASE="$LEASE"
  BOOTSTRAP_STARTED=1000
  vibe_drain_request old-vibe-container start >/dev/null
}

load_lib() {
  APP_DIR="$1/app"
  AI_TRADING_SECRETS_DIR="$1/secrets"
  AI_TRADING_STATE_DIR="$1/state"
  IMAGE_TAG="$SHA"
  export APP_DIR AI_TRADING_SECRETS_DIR AI_TRADING_STATE_DIR IMAGE_TAG
  # shellcheck source=/dev/null
  source "$LIB_FILE"
  CONTROL_SCRATCH_DIR="$1/scratch"
}

echo "=== Case 2 (RED): a lease genuinely lost mid-pull aborts before the switch and says why ==="
CASE_COUNT=$((CASE_COUNT + 1))
d2="$(new_dir case2)"
rc2=0
(
  load_lib "$d2"
  FAKE_TTL=4 FAKE_PULL_SECONDS=3
  shims "$d2"
  VIBE_HEARTBEAT_SECONDS=1
  gate_open
  # Vibe forgets the lease one second into the pull (restart, expiry, takeover).
  compose() {
    printf '%s\n' "$*" >>"$D/compose.log"
    if [[ "${1:-}" == pull ]]; then sleep 1; rm -f "$D/deadline"; sleep 2; fi
    return 0
  }
  deploy_tag "$IMAGE_TAG" 2>"$d2/stderr.log"
) || rc2=$?
[[ "$rc2" != 0 ]] || fail "case2: a lost lease must abort deploy_tag"
[[ ! -e "$d2/steps.log" ]] || fail "case2: the switch ran despite a lost lease: $(cat "$d2/steps.log")"
grep -q 'deploy: vibe gate: lease renew rejected before switch' "$d2/stderr.log" || fail "case2: missing the specific cause: $(cat "$d2/stderr.log")"
! grep -q 'deploy: vibe gate: heartbeat: lease renew rejected' "$d2/stderr.log" || [[ "$(grep -c 'heartbeat: lease renew rejected' "$d2/stderr.log")" == 1 ]] || fail "case2: the heartbeat logged the same loss more than once"

echo "=== Case 3 (RED): chat admitted, replaced container and the bootstrap bound each abort with their own cause ==="
CASE_COUNT=$((CASE_COUNT + 1))
d3="$(new_dir case3)"
(
  load_lib "$d3"
  FAKE_TTL=60
  shims "$d3"
  gate_open
  check() { # check WANT_MESSAGE
    if verify_vibe_gate_before_switch 2>"$d3/err.log"; then echo "case3: $1: verify passed" >&2; return 1; fi
    grep -q "deploy: vibe gate: $1" "$d3/err.log" || { echo "case3: missing '$1' in: $(cat "$d3/err.log")" >&2; return 1; }
  }
  verify_vibe_gate_before_switch 2>/dev/null || { echo "case3: baseline gate must verify" >&2; exit 1; }
  FAKE_COUNTS='1 0' check 'chat admission is not idle before switch (active chat/private committees: 1 0)'
  FAKE_COUNTS='0 0'
  vibe_container_ids() { echo replaced-vibe-container; }
  check 'running Vibe container changed since the gate opened'
  vibe_container_ids() { return 1; }
  check 'running Vibe container could not be listed'
  vibe_container_ids() { echo old-vibe-container; }
  legacy_marker_owned() { return 1; }
  check 'admission marker is no longer owned by this run'
  legacy_marker_owned() { return 0; }
  vibe_monotonic_seconds() { echo 4900; }
  check 'bootstrap bound of 3900s exceeded'
  vibe_monotonic_seconds() { echo 1000; }
  rm -f "$D/deadline"
  check 'lease renew rejected before switch'
) || fail "case3: a pre-switch refusal was silent or wrong"
# The heartbeat stops at the same bound verify enforces: past it, no renew.
d3b="$(new_dir case3b)"
rc3=0
(
  load_lib "$d3b"
  FAKE_TTL=60 FAKE_PULL_SECONDS=3
  shims "$d3b"
  VIBE_HEARTBEAT_SECONDS=1
  gate_open
  : >"$d3b/requests.log"
  vibe_monotonic_seconds() { echo 4900; }
  deploy_tag "$IMAGE_TAG" 2>"$d3b/stderr.log"
) || rc3=$?
[[ "$rc3" != 0 ]] || fail "case3: past the bootstrap bound deploy_tag must abort"
[[ ! -s "$d3b/requests.log" ]] || fail "case3: lease traffic past the bootstrap bound: $(tr '\n' ' ' <"$d3b/requests.log")"
[[ ! -e "$d3b/steps.log" ]] || fail "case3: the switch ran past the bootstrap bound"

echo "=== Case 4: a gate with no lease sends no lease traffic during the pull ==="
CASE_COUNT=$((CASE_COUNT + 1))
for mode in none legacy; do
  d4="$(new_dir "case4-$mode")"
  rc4=0
  (
    load_lib "$d4"
    FAKE_PULL_SECONDS=2
    shims "$d4"
    VIBE_HEARTBEAT_SECONDS=1
    VIBE_GATE_MODE="$mode"
    VIBE_GATE_CONTAINER_ID=old-vibe-container
    legacy_active_counts() { echo '0 0'; }
    BOOTSTRAP_STARTED=1000
    deploy_tag "$IMAGE_TAG" 2>"$d4/stderr.log"
  ) || rc4=$?
  [[ "$rc4" == 0 ]] || fail "case4($mode): deploy_tag returned $rc4: $(cat "$d4/stderr.log")"
  [[ ! -e "$d4/requests.log" ]] || fail "case4($mode): unexpected lease traffic: $(tr '\n' ' ' <"$d4/requests.log")"
  grep -qx 'pull' "$d4/compose.log" || fail "case4($mode): compose pull did not run"
done

echo "=== Case 5: a failing pull reaches the ERR trap with its own status; no heartbeat survives ==="
CASE_COUNT=$((CASE_COUNT + 1))
d5="$(new_dir case5)"
cat >"$d5/driver.sh" <<DRIVER
set -Eeuo pipefail
export D="$d5" LEASE="$LEASE" SHA="$SHA"
export FAKE_TTL=60 FAKE_PULL_SECONDS=2 FAKE_PULL_FAIL=1
$(declare -f new_dir shims gate_open load_lib | sed 's/^/ /')
load_lib "$d5"
shims "$d5"
VIBE_HEARTBEAT_SECONDS=1
gate_open
trap 'echo "err-trap status=\$?" >"\$D/err-trap.log"; exit 3' ERR
trap 'echo exit-trap >>"\$D/exit-trap.log"' EXIT
deploy_tag "\$IMAGE_TAG"
echo "unreachable: deploy_tag survived a failing pull" >&2
DRIVER
rc5=0
D="$d5" LIB_FILE="$LIB_FILE" bash "$d5/driver.sh" 2>"$d5/stderr.log" || rc5=$?
[[ "$rc5" == 3 ]] || fail "case5: expected the ERR trap to end the run with 3, got $rc5: $(cat "$d5/stderr.log")"
[[ "$(cat "$d5/err-trap.log" 2>/dev/null)" == 'err-trap status=17' ]] || fail "case5: the ERR trap must see the pull's own status 17: $(cat "$d5/err-trap.log" 2>/dev/null)"
[[ "$(wc -l <"$d5/exit-trap.log")" -eq 1 ]] || fail "case5: the EXIT trap must run exactly once, not once more in the pull's child: $(cat "$d5/exit-trap.log")"
[[ ! -e "$d5/steps.log" ]] || fail "case5: the switch ran after a failed pull"
renews5="$(grep -c '^renew$' "$d5/requests.log" 2>/dev/null || true)"
sleep 2
[[ "$(grep -c '^renew$' "$d5/requests.log" 2>/dev/null || true)" == "$renews5" ]] || fail "case5: a renew was sent after the run ended"

echo "=== Case 6 (RED): begin_vibe_release_gate and wait_for_vibe_idle name each failing branch ==="
CASE_COUNT=$((CASE_COUNT + 1))
d6="$(new_dir case6)"
(
  load_lib "$d6"
  FAKE_TTL=60
  shims "$d6"
  VIBE_ADMISSION_MARKER="$d6/marker"
  read_desired_vibe() { echo true; }
  vibe_monotonic_seconds() { python3 -c 'import time; print(int(time.monotonic()))'; }
  systemctl() { return 0; }
  systemd-run() { return 0; }
  vibe_drain_request() {
    case "$2" in
      probe)
        [[ "$FAKE" != probe ]] || return 1
        [[ "$FAKE" != probebad ]] || { echo '{"nope":1}'; return 0; }
        [[ "$FAKE" != probe500 ]] || { echo '{"http_status":500}'; return 0; }
        echo '{"http_status":409}' ;;
      start)
        [[ "$FAKE" != start ]] || return 1
        [[ "$FAKE" != startbad ]] || { echo '{"lease":"x"}'; return 0; }
        echo "{\"lease\":\"$LEASE\"}" ;;
      status)
        [[ "$FAKE" != status ]] || return 1
        [[ "$FAKE" != statusbad ]] || { echo 'not-json'; return 0; }
        echo '{"active_chat":0,"active_private_committees":0}' ;;
      renew)
        [[ "$FAKE" != renew ]] || return 1
        echo '{"status":"renewed"}' ;;
      *) return 1 ;;
    esac
  }
  expect() { # expect FAKE MESSAGE...
    local want
    FAKE="$1"
    shift
    VIBE_GATE_MODE=none VIBE_DRAIN_LEASE='' ADMISSION_MARKER_ACTIVE=0
    rm -f "$VIBE_ADMISSION_MARKER"
    if begin_vibe_release_gate 2>"$d6/err.log"; then echo "case6: $FAKE: gate opened" >&2; return 1; fi
    for want in "$@"; do
      grep -q "deploy: vibe gate: $want" "$d6/err.log" || { echo "case6: $FAKE: missing '$want' in: $(cat "$d6/err.log")" >&2; return 1; }
    done
  }
  expect probe 'drain probe request failed'
  expect probebad 'drain probe reply malformed'
  expect probe500 'unexpected drain probe status 500'
  expect start 'drain start request failed'
  expect startbad 'drain lease reply malformed'
  expect status 'drain status request failed' 'runtime drain did not go idle'
  expect statusbad 'drain status reply malformed'
  expect renew 'drain lease renew rejected while waiting for idle'
  systemd-run() { return 1; }
  expect none 'admission marker could not be armed'
  systemd-run() { return 0; }
  read_desired_vibe() { return 1; }
  expect none 'desired Vibe preference unreadable'
  read_desired_vibe() { echo maybe; }
  expect none 'desired Vibe preference is not true or false'
  read_desired_vibe() { echo true; }
  vibe_container_ids() { return 1; }
  expect none 'running Vibe containers could not be listed'
  vibe_container_ids() { printf 'a\nb\n'; }
  expect none 'more than one running Vibe container'
) || fail "case6: a begin_vibe_release_gate branch failed silently"

echo
if [[ "$FAIL_COUNT" -eq 0 ]]; then
  echo "RESULT: GREEN -- $CASE_COUNT cases, 0 failures"
  exit 0
fi
echo "RESULT: RED -- $CASE_COUNT cases, $FAIL_COUNT failure(s)"
exit 1
