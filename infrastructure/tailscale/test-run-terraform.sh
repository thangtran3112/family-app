#!/usr/bin/env bash
# Fast, offline checks for run-terraform.sh: no network, no real credentials,
# no terraform binary. The script runs from a temp tree whose
# common/config/family_config.py is a stub, with stub `terraform` and `gcloud`
# on PATH. The stub's `with-file` replaces ONLY an argument that is exactly
# `{}`, like the real CLI, so an `env VAR=file:{}` design would fail here.
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PASS=0
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
ok() { PASS=$((PASS + 1)); printf 'ok %d - %s\n' "$PASS" "$*"; }

d=$(mktemp -d)
trap 'rm -rf "$d"' EXIT

tree="$d/tree"
stubs="$d/stubs"
cap="$d/capture"
values="$d/values"
mkdir -p "$tree/infrastructure/tailscale" "$tree/common/config" "$stubs" "$cap" "$values"
cp "$SCRIPT_DIR/run-terraform.sh" "$tree/infrastructure/tailscale/run-terraform.sh"

secret='tskey-client-FAKE-SECRET-DO-NOT-LEAK-91c4'
tailnet='fake-tailnet.example'
client_id='kFAKEclientid'

reset_values() {
  rm -f "$values"/*
  printf '%s' "$tailnet" >"$values/TAILSCALE_TAILNET"
  printf '%s' "$client_id" >"$values/TAILSCALE_TF_OAUTH_CLIENT_ID"
  printf '%s' "$secret" >"$values/TAILSCALE_TF_OAUTH_CLIENT_SECRET"
}

cat >"$tree/common/config/family_config.py" <<'SH'
#!/usr/bin/env bash
# Stub of family_config.py: `get` and `with-file` over files in $STUB_VALUES.
[[ "${2:-}" == shared/tailscale ]] || { echo "stub: unexpected target ${2:-}" >&2; exit 3; }
value_file="$STUB_VALUES/${3:-}"
missing() { echo "family-config: shared/tailscale has no ${3:-}" >&2; exit 1; }
case "$1" in
  get)
    [[ -f "$value_file" ]] || missing "$@"
    cat "$value_file"
    ;;
  with-file)
    [[ -f "$value_file" ]] || missing "$@"
    shift 3
    [[ "$1" == -- ]] && shift
    tmp=$(mktemp)
    cat "$value_file" >"$tmp"
    args=()
    for arg in "$@"; do
      if [[ "$arg" == "{}" ]]; then args+=("$tmp"); else args+=("$arg"); fi
    done
    code=0
    "${args[@]}" || code=$?
    rm -f "$tmp"
    exit "$code"
    ;;
  *) echo "stub: unsupported command $1" >&2; exit 2 ;;
esac
SH
chmod +x "$tree/common/config/family_config.py"

cat >"$stubs/terraform" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$@" >"$STUB_CAPTURE/terraform-argv"
env | cut -d= -f1 | grep -E '^(TF_VAR_|GOOGLE_)' | sort >"$STUB_CAPTURE/env-names"
env >"$STUB_CAPTURE/env-full"
secret_file=${TF_VAR_tailscale_oauth_client_secret#file:}
printf '%s' "$secret_file" >"$STUB_CAPTURE/secret-path"
cat "$secret_file" >"$STUB_CAPTURE/secret-seen"
# portable mode: 600 means no group/other bits
ls -l "$secret_file" | cut -c1-10 >"$STUB_CAPTURE/secret-mode"
exit "${STUB_TF_EXIT:-0}"
SH
cat >"$stubs/gcloud" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$STUB_CAPTURE/gcloud-argv"
printf 'fake-google-token'
SH
chmod +x "$stubs/terraform" "$stubs/gcloud"

run() { # run <args...>; sets code, out, err; clears captures
  rm -f "$cap"/*
  code=0
  PATH="$stubs:$PATH" STUB_VALUES="$values" STUB_CAPTURE="$cap" \
    bash "$tree/infrastructure/tailscale/run-terraform.sh" "$@" >"$d/out" 2>"$d/err" || code=$?
}

reset_values
run plan -out=tfplan
[[ "$code" == 0 ]] || { cat "$d/err" >&2; fail "plan exited $code"; }
ok "run-terraform.sh plan -out=tfplan exits 0"

[[ "$(cat "$cap/terraform-argv")" == $'plan\n-out=tfplan' ]] || fail "terraform argv was: $(cat "$cap/terraform-argv")"
ok "arguments are forwarded to terraform unchanged"

run fmt -check -recursive
[[ "$(cat "$cap/terraform-argv")" == $'fmt\n-check\n-recursive' ]] || fail "multi-flag argv was: $(cat "$cap/terraform-argv")"
ok "multi-flag arguments (fmt -check -recursive) are forwarded"

expected=$'GOOGLE_OAUTH_ACCESS_TOKEN\nTF_VAR_tailnet\nTF_VAR_tailscale_oauth_client_id\nTF_VAR_tailscale_oauth_client_secret'
[[ "$(cat "$cap/env-names")" == "$expected" ]] || fail "terraform saw env names: $(tr '\n' ' ' <"$cap/env-names")"
ok "terraform receives exactly TF_VAR_tailnet, TF_VAR_tailscale_oauth_client_id, TF_VAR_tailscale_oauth_client_secret, GOOGLE_OAUTH_ACCESS_TOKEN"

grep -qxF "TF_VAR_tailnet=$tailnet" "$cap/env-full" || fail "TF_VAR_tailnet has the wrong value"
grep -qxF "TF_VAR_tailscale_oauth_client_id=$client_id" "$cap/env-full" || fail "TF_VAR_tailscale_oauth_client_id has the wrong value"
ok "tailnet and client id values come from shared/tailscale"

grep -q '^TF_VAR_tailscale_oauth_client_secret=file:/' "$cap/env-full" || fail "the secret variable is not in file:<path> form"
if grep -qF "$secret" "$cap/env-full"; then fail "the secret value itself is present in terraform's environment"; fi
ok "the secret variable is file:<path>; the secret value is not in terraform's environment"

[[ "$(cat "$cap/secret-seen")" == "$secret" ]] || fail "the secret file did not hold the secret"
[[ "$(cat "$cap/secret-mode")" == "-rw-------" ]] || fail "secret file mode was $(cat "$cap/secret-mode")"
ok "the secret file holds the secret (substituted from an exact {} argument) with mode 0600"

[[ ! -e "$(cat "$cap/secret-path")" ]] || fail "the secret temp file was not removed"
ok "the secret temp file is removed after the run"

if grep -qF "$secret" "$d/out" "$d/err"; then fail "the secret appeared in the script's stdout or stderr"; fi
ok "the secret never appears in stdout or stderr"

grep -qxF -- '--configuration=personal' <(tr ' ' '\n' <"$cap/gcloud-argv") || fail "gcloud was not asked for the personal configuration: $(cat "$cap/gcloud-argv")"
ok "the GCS backend token comes from the personal gcloud configuration"

rm -f "$cap"/*
code=0
PATH="$stubs:$PATH" STUB_VALUES="$values" STUB_CAPTURE="$cap" GOOGLE_OAUTH_ACCESS_TOKEN=preset-token \
  bash "$tree/infrastructure/tailscale/run-terraform.sh" validate >"$d/out" 2>"$d/err" || code=$?
[[ "$code" == 0 && ! -e "$cap/gcloud-argv" ]] || fail "a preset GOOGLE_OAUTH_ACCESS_TOKEN should skip gcloud (exit $code)"
grep -qxF 'GOOGLE_OAUTH_ACCESS_TOKEN=preset-token' "$cap/env-full" || fail "preset token was not passed through"
ok "a preset GOOGLE_OAUTH_ACCESS_TOKEN is kept and gcloud is not called"

reset_values
STUB_TF_EXIT=3 run plan
[[ "$code" == 3 ]] || fail "terraform's exit code 3 became $code"
ok "terraform's exit code is propagated"

run
[[ "$code" != 0 ]] || fail "no arguments should fail"
[[ ! -e "$cap/terraform-argv" ]] || fail "terraform ran without arguments"
grep -q usage "$d/err" || fail "no usage message on stderr"
ok "no arguments fails with a usage message and does not run terraform"

for key in TAILSCALE_TAILNET TAILSCALE_TF_OAUTH_CLIENT_ID TAILSCALE_TF_OAUTH_CLIENT_SECRET; do
  reset_values
  rm -f "$values/$key"
  run plan
  [[ "$code" != 0 ]] || fail "missing $key should fail"
  [[ ! -e "$cap/terraform-argv" ]] || fail "terraform ran with $key missing"
  grep -q "$key" "$d/err" || fail "stderr does not name the missing key $key: $(cat "$d/err")"
  if grep -qF "$secret" "$d/out" "$d/err"; then fail "the secret leaked on the missing-$key path"; fi
  ok "missing $key fails non-zero, names the key, runs no terraform, leaks no secret"
done

reset_values
: >"$values/TAILSCALE_TAILNET"
run plan
[[ "$code" != 0 && ! -e "$cap/terraform-argv" ]] || fail "an empty TAILSCALE_TAILNET should fail before terraform"
ok "an empty value fails before terraform runs"

printf '\n%d checks passed (run-terraform.sh)\n' "$PASS"
