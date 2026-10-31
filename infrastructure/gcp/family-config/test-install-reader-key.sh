#!/usr/bin/env bash
# Offline check of install-reader-key.sh: syntax and argument parsing only. It never runs gcloud,
# ssh or the Firestore CLI (the script defines only functions when sourced).
# Usage: infrastructure/gcp/family-config/test-install-reader-key.sh
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/install-reader-key.sh"
PASS=0
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
ok() { PASS=$((PASS + 1)); printf 'ok %d - %s\n' "$PASS" "$*"; }

bash -n "$SCRIPT" || fail "install-reader-key.sh has a syntax error"
bash -n "$SCRIPT_DIR/bootstrap.sh" || fail "bootstrap.sh has a syntax error"
ok "scripts parse"

# parse ARGS...: runs parse_args in a subshell and prints "PROFILE KEEP_EXISTING SSH_KEY"; the
# subshell's exit status is parse_args's.
parse() {
  (
    # shellcheck disable=SC1091 # path is computed; sourcing only defines functions
    source "$SCRIPT"
    # `|| exit`: inside the caller's `if parse ...`, errexit is off, so a failing parse_args would
    # otherwise fall through to the printf.
    parse_args "$@" 2>/dev/null || exit $?
    printf '%s %s %s\n' "$PROFILE" "$KEEP_EXISTING" "$SSH_KEY"
  )
}

[[ "$(parse)" == "shared/vps 0 " ]] || fail "defaults must be shared/vps and delete-older-keys: $(parse)"
ok "defaults: --profile shared/vps, older keys deleted"

[[ "$(parse --profile shared/laptop)" == "shared/laptop 0 " ]] || fail "--profile shared/laptop not honoured"
ok "--profile selects another group"

[[ "$(parse --keep-existing)" == "shared/vps 1 " ]] || fail "--keep-existing not honoured"
ok "--keep-existing sets the keep flag"

[[ "$(parse --profile shared/laptop --keep-existing --ssh-key /tmp/k)" == "shared/laptop 1 /tmp/k" ]] \
  || fail "combined flags and the internal --ssh-key must all parse"
ok "flags combine and the internal --ssh-key re-exec argument still parses"

for bad in "--bogus" "--profile" "--profile vps" "--profile shared/" "--profile shared/Bad" "--profile ai-trading/deploy" "--ssh-key"; do
  # shellcheck disable=SC2086 # intentional word splitting of the case string
  if parse $bad >/dev/null 2>&1; then fail "'$bad' must be rejected"; fi
done
ok "unknown flags, missing values and non-shared/<group> profiles are rejected"

printf '\n%d checks passed (install-reader-key.sh)\n' "$PASS"
