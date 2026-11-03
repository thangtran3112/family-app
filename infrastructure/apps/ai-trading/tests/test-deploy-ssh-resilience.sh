#!/usr/bin/env bash
# Offline checks for the "Deploy over SSH" step of ai-trading-deploy.yml.
# Found 2026-11-03 (run 41679618876): the deploy channel dropped twice against a
# healthy host ("Connection ... closed by remote host", "Broken pipe"), and the
# host had already finished the transaction while the run reported failure.
#
# The script the step generates (the SCRIPT_EOF heredoc) is extracted and run
# for real. `ssh`, `scp` and `sleep` are fakes driven by environment fixtures,
# so no host, key, network, or Firestore is involved. Asserts:
#   (a) every ssh and scp call carries the keepalive set and keeps strict host
#       key checking; ssh calls also carry ConnectTimeout;
#   (b) a transport-class failure is re-checked over a fresh connection and
#       exits 0 only when last-good-tag equals IMAGE_TAG;
#   (c) the lifecycle-lock residue and any real deploy failure stay failures.
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
WORKFLOW="${WORKFLOW_OVERRIDE:-$REPO_ROOT/.github/workflows/ai-trading-deploy.yml}"
ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT
PASS=0

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
ok() { PASS=$((PASS + 1)); printf 'ok %d - %s\n' "$PASS" "$*"; }

TAG=9cbc3256aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
OTHER=1111111111111111111111111111111111111111

# --- Static: the workflow text -------------------------------------------------
grep -q 'common_opts=(.*-o ServerAliveInterval=15 -o ServerAliveCountMax=4 -o TCPKeepAlive=yes' "$WORKFLOW" \
  || fail "common_opts lacks the keepalive set"
grep -q 'ssh_opts=("${common_opts\[@\]}" -o ConnectTimeout=20 ' "$WORKFLOW" || fail "ssh_opts is not built from common_opts with ConnectTimeout=20"
grep -q 'scp_opts=("${common_opts\[@\]}" ' "$WORKFLOW" || fail "scp_opts is not built from common_opts"
grep -q 'common_opts=(.*-o StrictHostKeyChecking=yes' "$WORKFLOW" || fail "StrictHostKeyChecking=yes is gone"
grep -q 'common_opts=(.*-o UserKnownHostsFile="\$KNOWN_HOSTS_FILE"' "$WORKFLOW" || fail "UserKnownHostsFile is gone"
! grep -Eq 'StrictHostKeyChecking=(no|accept-new)|UserKnownHostsFile=/dev/null' "$WORKFLOW" || fail "host key checking was weakened"
ok "static: ssh_opts and scp_opts share one keepalive set; host key checking intact"

transport_re="$(sed -n "s/.*grep -Eq '\\(Connection[^']*\\)'.*/\\1/p" "$WORKFLOW")"
[[ -n "$transport_re" ]] || fail "transport-failure pattern not found"
for msg in 'Connection to host closed by remote host' 'client_loop: send disconnect: Broken pipe' 'Timeout, server host not responding'; do
  grep -Eq "$transport_re" <<<"$msg" || fail "transport pattern misses: $msg"
done
! grep -Eq "$transport_re" <<<'state operation failed: lifecycle lock is held elsewhere' \
  || fail "the transport pattern matches the lock-residue message"
grep -n "lifecycle lock is held" "$WORKFLOW" | grep -q "grep -q" || fail "lock-residue guard missing"
guard_line="$(grep -n "grep -q 'lifecycle lock is held'" "$WORKFLOW" | head -1 | cut -d: -f1)"
branch_line="$(grep -n "grep -Eq 'Connection" "$WORKFLOW" | head -1 | cut -d: -f1)"
((guard_line < branch_line)) || fail "the lock-residue guard must come before the transport branch"
ok "static: transport pattern is bounded; lock residue is checked first and is not in it"

# --- Behavioral: extract the generated script and run it with fakes -----------
awk '/<<.SCRIPT_EOF.$/ { f = 1; next } /^ *SCRIPT_EOF$/ { f = 0 } f { sub(/^ {10}/, ""); print }' "$WORKFLOW" >"$ROOT/deploy-remote.sh"
[[ -s "$ROOT/deploy-remote.sh" ]] || fail "could not extract the generated deploy script"
bash -n "$ROOT/deploy-remote.sh" || fail "generated deploy script does not parse"

mkdir -p "$ROOT/bin" "$ROOT/env"
cat >"$ROOT/bin/ssh" <<'FAKE'
#!/usr/bin/env bash
# Fake ssh. The deploy call (its command runs deploy.sh) replays FAKE_DEPLOY_OUT
# and exits FAKE_DEPLOY_RC. The verify call (reads last-good-tag) answers the
# nth word of FAKE_VERIFY_TAGS ("-" = that attempt's connection fails).
set -euo pipefail
printf 'ssh %s\n' "$*" >>"$FAKE_LOG"
cmd="${*: -1}"
case "$cmd" in
  *deploy.sh*)
    cat >/dev/null
    [[ -z "${FAKE_DEPLOY_OUT:-}" ]] || printf '%s\n' "$FAKE_DEPLOY_OUT" >&2
    exit "${FAKE_DEPLOY_RC:-0}"
    ;;
  *last-good-tag*)
    n=$(($(cat "$FAKE_LOG.verify" 2>/dev/null || echo 0) + 1))
    echo "$n" >"$FAKE_LOG.verify"
    read -ra tags <<<"${FAKE_VERIFY_TAGS:-}"
    tag="${tags[$((n - 1))]:-${tags[${#tags[@]} - 1]:-}}"
    [[ "$tag" != - ]] || exit 255
    printf '%s\n' "$tag"
    ;;
  *) exit 0 ;;
esac
FAKE
cat >"$ROOT/bin/scp" <<'FAKE'
#!/usr/bin/env bash
printf 'scp %s\n' "$*" >>"$FAKE_LOG"
FAKE
cat >"$ROOT/bin/sleep" <<'FAKE'
#!/usr/bin/env bash
printf 'sleep %s\n' "$*" >>"$FAKE_LOG"
FAKE
chmod +x "$ROOT/bin/ssh" "$ROOT/bin/scp" "$ROOT/bin/sleep"
touch "$ROOT/key" "$ROOT/known-hosts"

# run_case <name> -- env assignments are read from the caller's exported FAKE_*.
# Sets rc, log (file), out (file).
run_case() {
  FAKE_LOG="$ROOT/$1.log"
  : >"$FAKE_LOG"
  rm -f "$FAKE_LOG.verify"
  export FAKE_LOG
  rc=0
  env PATH="$ROOT/bin:$PATH" SSH_KEY_FILE="$ROOT/key" KNOWN_HOSTS_FILE="$ROOT/known-hosts" \
    VPS_HOST=deploy-host VPS_PORT=2222 VPS_USER=deployer GITHUB_TOKEN=fake-token GHCR_USER=fake-user \
    IMAGE_TAG="$TAG" MIROFISH_ACTIVATE=keep DEPLOY_DARK=0 ENV_DIR="$ROOT/env" \
    bash "$ROOT/deploy-remote.sh" >"$ROOT/$1.out" 2>&1 || rc=$?
  log="$FAKE_LOG"
  out="$ROOT/$1.out"
}
count() { grep -c "$1" "$log" || true; }

# (a) Case 1: a clean deploy. Every ssh and scp call carries the keepalive set.
FAKE_DEPLOY_RC=0 FAKE_DEPLOY_OUT="deploy: ai-trading is running $TAG" FAKE_VERIFY_TAGS="" run_case clean
[[ $rc -eq 0 ]] || fail "clean deploy: exit $rc"
(($(count '^ssh ') == 2 && $(count '^scp ') == 7)) || fail "clean deploy: expected 2 ssh and 7 scp calls, got $(count '^ssh ') / $(count '^scp ')"
[[ $(count 'last-good-tag') -eq 0 ]] || fail "clean deploy: must not run the fresh-connection check"
for opt in 'ServerAliveInterval=15' 'ServerAliveCountMax=4' 'TCPKeepAlive=yes' 'StrictHostKeyChecking=yes' 'UserKnownHostsFile='; do
  [[ $(grep -c '^s[sc][hp] ' "$log") -eq $(grep -c -- "-o $opt" "$log") ]] || fail "clean deploy: a call lacks -o $opt"
done
[[ $(grep -c '^ssh ' "$log") -eq $(grep '^ssh ' "$log" | grep -c -- '-o ConnectTimeout=20') ]] || fail "an ssh call lacks ConnectTimeout=20"
! grep '^scp ' "$log" | grep -q ConnectTimeout || fail "scp must not carry ConnectTimeout"
ok "clean deploy: 2 ssh + 7 scp calls, every one with the keepalive set; ssh with ConnectTimeout=20"

# (b) Case 2: Connection closed, exit 255, host already finished -> success.
FAKE_DEPLOY_RC=255 FAKE_DEPLOY_OUT="Connection to deploy-host closed by remote host." FAKE_VERIFY_TAGS="$TAG" run_case dropped_done
[[ $rc -eq 0 ]] || fail "dropped but done: exit $rc, expected 0"
grep -q "::warning::.*dropped.*$TAG" "$out" || fail "dropped but done: no warning naming the transport failure"
[[ $(count 'last-good-tag') -eq 1 ]] || fail "dropped but done: expected one fresh-connection check"
ok "exit 255 + fresh last-good-tag == IMAGE_TAG: warns and exits 0"

# (b) Case 3: stderr pattern with another exit code ('Broken pipe', exit 1).
FAKE_DEPLOY_RC=1 FAKE_DEPLOY_OUT="client_loop: send disconnect: Broken pipe" FAKE_VERIFY_TAGS="$TAG" run_case broken_pipe
[[ $rc -eq 0 ]] || fail "Broken pipe: exit $rc, expected 0"
FAKE_DEPLOY_RC=1 FAKE_DEPLOY_OUT="Timeout, server deploy-host not responding." FAKE_VERIFY_TAGS="$TAG" run_case timeout
[[ $rc -eq 0 ]] || fail "server not responding: exit $rc, expected 0"
ok "Broken pipe / server not responding (any exit code) are transport-class too"

# (b) Case 4: the host did NOT finish: stale tag on all three tries -> still failed.
FAKE_DEPLOY_RC=255 FAKE_DEPLOY_OUT="Connection to deploy-host closed by remote host." FAKE_VERIFY_TAGS="$OTHER" run_case dropped_not_done
[[ $rc -eq 255 ]] || fail "dropped, tag differs: exit $rc, expected 255"
[[ $(count 'last-good-tag') -eq 3 && $(count '^sleep 10$') -eq 3 ]] || fail "dropped, tag differs: expected 3 checks, 10 s apart"
ok "exit 255 + last-good-tag != IMAGE_TAG: 3 checks 10 s apart, then fails with 255"

# (b) Case 5: the fresh connection itself fails twice, then the third read matches.
FAKE_DEPLOY_RC=255 FAKE_DEPLOY_OUT="Connection to deploy-host closed by remote host." FAKE_VERIFY_TAGS="- - $TAG" run_case retry_then_ok
[[ $rc -eq 0 && $(count 'last-good-tag') -eq 3 ]] || fail "retry then ok: exit $rc after $(count 'last-good-tag') checks"
FAKE_DEPLOY_RC=255 FAKE_DEPLOY_OUT="Connection to deploy-host closed by remote host." FAKE_VERIFY_TAGS="-" run_case unreachable
[[ $rc -eq 255 && $(count 'last-good-tag') -eq 3 ]] || fail "unreachable: exit $rc after $(count 'last-good-tag') checks"
ok "a failed fresh connection is retried; unreachable after 3 tries still fails"

# (c) Case 6: lock residue, even with a dead channel and a MATCHING tag, is a failure.
FAKE_DEPLOY_RC=255 FAKE_DEPLOY_OUT=$'state operation failed: lifecycle lock is held elsewhere\nConnection to deploy-host closed by remote host.' FAKE_VERIFY_TAGS="$TAG" run_case lock_and_drop
[[ $rc -eq 255 ]] || fail "lock residue + drop: exit $rc, expected 255"
[[ $(count 'last-good-tag') -eq 0 ]] || fail "lock residue + drop: must not run the fresh-connection check"
FAKE_DEPLOY_RC=1 FAKE_DEPLOY_OUT="state operation failed: lifecycle lock is held elsewhere" FAKE_VERIFY_TAGS="$TAG" run_case lock_only
[[ $rc -eq 1 && $(count 'last-good-tag') -eq 0 ]] || fail "lock residue: exit $rc, expected 1 with no check"
ok "lifecycle lock residue stays a failure and is never re-checked"

# (c) Case 7: a real deploy failure stays a failure even if last-good-tag matches.
FAKE_DEPLOY_RC=1 FAKE_DEPLOY_OUT="deploy: health check failed; rolled back" FAKE_VERIFY_TAGS="$TAG" run_case real_failure
[[ $rc -eq 1 && $(count 'last-good-tag') -eq 0 ]] || fail "real failure: exit $rc, expected 1 with no check"
ok "a non-transport failure exits with its own code and is never re-checked"

printf '\nall %d checks passed\n' "$PASS"
