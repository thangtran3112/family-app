#!/usr/bin/env bash
# Offline checks for health-check.sh's rollback mode. deploy.sh sets
# HEALTH_CHECK_ROLLBACK=1 before it redeploys a previous tag: that tag's own
# compose decides which services are required. The real health-check.sh and the
# real control/state.py run; `docker` is a fake driven by environment fixtures,
# so no Docker daemon, VPS, or Firestore is involved. Found 2026-10-12: a
# rollback to a pre-Desk release failed because this run's catalog still listed
# api and scheduler, which that release never ran.
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
HEALTH_SH="${HEALTH_SH_OVERRIDE:-$SCRIPT_DIR/../health-check.sh}"
CONTROL_DIR="$REPO_ROOT/ai-trading/control"
ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT
PASS=0

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
ok() { PASS=$((PASS + 1)); printf 'ok %d - %s\n' "$PASS" "$*"; }

mkdir -p "$ROOT/bin" "$ROOT/app" "$ROOT/state"
chmod 700 "$ROOT/state"

cat >"$ROOT/bin/docker" <<'FAKE'
#!/usr/bin/env bash
# Fake docker for health-check.sh. FAKE_COMPOSE_SERVICES is what the target
# compose defines; FAKE_RUNNING is what has a running container; FAKE_UNHEALTHY
# is what runs but fails its health check.
set -euo pipefail
if [[ "${1:-}" == compose ]]; then
  shift
  sub=""
  rest=()
  while (($#)); do
    case "$1" in
      --project-name | --env-file | -f) shift 2 ;;
      config | ps | exec)
        sub="$1"
        shift
        rest=("$@")
        break
        ;;
      *) shift ;;
    esac
  done
  case "$sub" in
    config)
      read -ra defined_list <<<"${FAKE_COMPOSE_SERVICES:-}"
      printf '%s\n' "${defined_list[@]+"${defined_list[@]}"}"
      ;;
    ps)
      svc="${rest[${#rest[@]}-1]}"
      read -ra running_list <<<"${FAKE_RUNNING:-}"
      for running in "${running_list[@]+"${running_list[@]}"}"; do
        if [[ "$running" == "$svc" ]]; then
          echo "id-$svc"
        fi
      done
      ;;
    exec)
      # tunnel probe: FAKE_TUNNEL_DOWN makes it fail
      if [[ -n "${FAKE_TUNNEL_DOWN:-}" ]]; then exit 1; fi
      ;;
    *)
      echo "fake docker: unsupported compose subcommand: $sub" >&2
      exit 1
      ;;
  esac
  exit 0
fi
if [[ "${1:-}" == inspect ]]; then
  id="${*: -1}"
  svc="${id#id-}"
  if [[ "$*" == *State.Health* ]]; then
    read -ra unhealthy_list <<<"${FAKE_UNHEALTHY:-}"
    state=healthy
    for bad in "${unhealthy_list[@]+"${unhealthy_list[@]}"}"; do
      if [[ "$bad" == "$svc" ]]; then
        state=unhealthy
      fi
    done
    echo "$state"
  else
    echo running
  fi
  exit 0
fi
echo "fake docker: unsupported invocation: $*" >&2
exit 1
FAKE
chmod 0755 "$ROOT/bin/docker"

python3 "$CONTROL_DIR/state.py" init --state "$ROOT/state/control.json" \
  --lock "$ROOT/state/control.lock" --owner-uid "$(id -u)" --running-services-json null \
  || fail "could not create the control state fixture"

# run_health ROLLBACK DEFINED RUNNING UNHEALTHY: one real health-check.sh run,
# a single attempt with no delay. Sets RC, OUT (stdout) and ERR (stderr).
run_health() {
  local rollback="$1" defined="$2" running="$3" unhealthy="$4"
  local -a extra=()
  if [[ -n "$rollback" ]]; then
    extra=(HEALTH_CHECK_ROLLBACK=1)
  fi
  # RUN_DARK / RUN_TUNNEL_DOWN: set by the dark-mode cases below, empty otherwise.
  if [[ -n "${RUN_DARK:-}" ]]; then extra+=(DEPLOY_DARK=1); fi
  if [[ -n "${RUN_TUNNEL_DOWN:-}" ]]; then extra+=(FAKE_TUNNEL_DOWN=1); fi
  OUT="$ROOT/out.txt"
  ERR="$ROOT/err.txt"
  set +e
  env -i PATH="$ROOT/bin:$PATH" HOME="$ROOT" \
    APP_DIR="$ROOT/app" \
    AI_TRADING_CONTROL_DIR="$CONTROL_DIR" \
    AI_TRADING_STATE_PATH="$ROOT/state/control.json" \
    AI_TRADING_CONTROL_OWNER_UID="$(id -u)" \
    HEALTH_CHECK_SKIP_CONTROL=1 HEALTH_CHECK_ATTEMPTS=1 HEALTH_CHECK_DELAY_SECONDS=0 \
    FAKE_COMPOSE_SERVICES="$defined" FAKE_RUNNING="$running" FAKE_UNHEALTHY="$unhealthy" \
    ${extra[@]+"${extra[@]}"} \
    bash "$HEALTH_SH" >"$OUT" 2>"$ERR"
  RC=$?
  set -e
}

# The selected list comes from the same state.py the health check uses, so the
# fixtures follow the catalog instead of a copy of it.
SELECTED="$(python3 "$CONTROL_DIR/state.py" services --mirofish-ready false \
  --state "$ROOT/state/control.json" --owner-uid "$(id -u)")" || fail "could not compute the selected services"
FULL="$(tr '\n' ' ' <<<"$SELECTED")"
PRE_DESK="$(grep -vxE 'api|scheduler' <<<"$SELECTED" | tr '\n' ' ')"
grep -qx api <<<"$SELECTED" || fail "the catalog must select api (fixture precondition)"
grep -qx scheduler <<<"$SELECTED" || fail "the catalog must select scheduler (fixture precondition)"

run_health "" "$PRE_DESK" "$PRE_DESK" ""
[[ $RC -eq 1 ]] || fail "a forward deploy whose compose lacks api/scheduler must fail (rc=$RC)"
grep -q "failing services:.*api" "$ERR" || fail "forward deploy must name api: $(cat "$ERR")"
grep -q "failing services:.*scheduler" "$ERR" || fail "forward deploy must name scheduler: $(cat "$ERR")"
ok "a forward deploy keeps the strict check: a protected service missing from compose fails"

run_health 1 "$PRE_DESK" "$PRE_DESK" ""
[[ $RC -eq 0 ]] || fail "a rollback to a pre-Desk release must pass (rc=$RC): $(cat "$ERR")"
grep -q "rollback target does not run api" "$ERR" || fail "rollback must say it skipped api: $(cat "$ERR")"
grep -q "rollback target does not run scheduler" "$ERR" || fail "rollback must say it skipped scheduler: $(cat "$ERR")"
grep -q "all services healthy" "$OUT" || fail "rollback success message missing: $(cat "$OUT")"
ok "a rollback to a pre-Desk release passes without api or scheduler, and says so"

run_health 1 "$PRE_DESK" "$PRE_DESK" "web"
[[ $RC -eq 1 ]] || fail "a rollback must still fail on an unhealthy service the target defines (rc=$RC)"
grep -q "failing services: web;" "$ERR" || fail "rollback must name the unhealthy service: $(cat "$ERR")"
ok "a rollback still fails on an unhealthy service the target defines"

STOPPED_GATEWAY="$(tr ' ' '\n' <<<"$PRE_DESK" | grep -vx gateway | tr '\n' ' ')"
run_health 1 "$PRE_DESK" "$STOPPED_GATEWAY" ""
[[ $RC -eq 1 ]] || fail "a rollback must fail when a service the target defines is not running (rc=$RC)"
grep -q "failing services:.*gateway" "$ERR" || fail "rollback must name the stopped service: $(cat "$ERR")"
ok "a rollback still fails when a service the target defines is not running"

run_health 1 "$FULL" "$FULL" ""
[[ $RC -eq 0 ]] || fail "a rollback to a release that runs everything must pass (rc=$RC): $(cat "$ERR")"
if grep -q "does not run" "$ERR"; then
  fail "a rollback to a release that runs everything must skip nothing: $(cat "$ERR")"
fi
ok "a rollback to a release that runs every protected service still checks all of them"

# --- Dark mode (DEPLOY_DARK=1): cloudflared and scheduler are not required and the tunnel probe is
# skipped; a normal deploy still requires both and the tunnel.
DARK_SELECTED="$(python3 "$CONTROL_DIR/state.py" services --mirofish-ready false --dark \
  --state "$ROOT/state/control.json" --owner-uid "$(id -u)")" || fail "could not compute the dark selected services"
DARK_LIST="$(tr '\n' ' ' <<<"$DARK_SELECTED")"
if grep -qxE 'cloudflared|scheduler' <<<"$DARK_SELECTED"; then fail "the dark selection must omit cloudflared and scheduler"; fi

RUN_DARK=1 RUN_TUNNEL_DOWN=1 run_health "" "$DARK_LIST" "$DARK_LIST" ""
[[ $RC -eq 0 ]] || fail "a dark deploy without cloudflared, scheduler or a tunnel must pass (rc=$RC): $(cat "$ERR")"
grep -q "all services healthy" "$OUT" || fail "dark success message missing: $(cat "$OUT")"
ok "a dark deploy passes with no cloudflared, no scheduler and no tunnel"

RUN_TUNNEL_DOWN=1 run_health "" "$FULL" "$FULL" ""
[[ $RC -eq 1 ]] || fail "a normal deploy must still fail when the tunnel is down (rc=$RC)"
grep -q "tunnel connected: no" "$ERR" || fail "a normal deploy must report the tunnel as down: $(cat "$ERR")"
ok "a normal deploy still requires the tunnel"

run_health "" "$DARK_LIST" "$DARK_LIST" ""
[[ $RC -eq 1 ]] || fail "a normal deploy missing cloudflared and scheduler must fail (rc=$RC)"
grep -q "failing services:.*cloudflared" "$ERR" || fail "a normal deploy must name cloudflared: $(cat "$ERR")"
grep -q "failing services:.*scheduler" "$ERR" || fail "a normal deploy must name scheduler: $(cat "$ERR")"
ok "a normal deploy still requires cloudflared and scheduler"

STOPPED_DARK_GATEWAY="$(tr ' ' '\n' <<<"$DARK_LIST" | grep -vx gateway | tr '\n' ' ')"
RUN_DARK=1 run_health "" "$DARK_LIST" "$STOPPED_DARK_GATEWAY" ""
[[ $RC -eq 1 ]] || fail "a dark deploy must still fail when another protected service is down (rc=$RC)"
grep -q "failing services:.*gateway" "$ERR" || fail "a dark deploy must name the stopped gateway: $(cat "$ERR")"
ok "a dark deploy still requires every other protected service"

printf '\n%d checks passed (health-check rollback mode)\n' "$PASS"
