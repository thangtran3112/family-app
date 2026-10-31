#!/usr/bin/env bash
# Fast, offline checks for mint-authkey.sh: no network, no real credentials.
# The script runs from a temp tree whose common/config/family_config.py is a
# stub, with a stub `curl` on PATH that records argv and the `-K -` config it
# reads from stdin, and answers like the Tailscale API.
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
scratch="$d/tmp"
workdir="$d/cwd"
mkdir -p "$tree/infrastructure/tailscale" "$tree/common/config" "$stubs" "$cap" "$values" "$scratch" "$workdir"
cp "$SCRIPT_DIR/mint-authkey.sh" "$tree/infrastructure/tailscale/mint-authkey.sh"

secret='tskey-client-FAKE-ENROLL-SECRET-DO-NOT-LEAK-91c4'
tailnet='fake-tailnet.example'
client_id='kFAKEenrollclientid'
access_token='tskey-api-FAKEACCESSTOKEN-5d2e'
minted_key='tskey-auth-FAKEMINTEDKEY-77ab'

# The Terraform credential (TAILSCALE_TF_*) is deliberately absent: it cannot
# mint keys, so the script must work from the enrollment credential alone.
reset_values() {
  rm -f "$values"/*
  printf '%s' "$tailnet" >"$values/TAILSCALE_TAILNET"
  printf '%s' "$client_id" >"$values/TAILSCALE_ENROLL_OAUTH_CLIENT_ID"
  printf '%s' "$secret" >"$values/TAILSCALE_ENROLL_OAUTH_CLIENT_SECRET"
}

cat >"$tree/common/config/family_config.py" <<'SH'
#!/usr/bin/env bash
# Stub of family_config.py: `get` over files in $STUB_VALUES.
[[ "$1" == get && "${2:-}" == shared/tailscale ]] || { echo "stub: unexpected call $*" >&2; exit 3; }
[[ -f "$STUB_VALUES/$3" ]] || { echo "family-config: shared/tailscale has no $3" >&2; exit 1; }
cat "$STUB_VALUES/$3"
SH
chmod +x "$tree/common/config/family_config.py"

# Stub curl: logs argv, saves the stdin config of each call, answers by URL.
cat >"$stubs/curl" <<SH
#!/usr/bin/env bash
n=\$(( \$(cat "\$STUB_CAPTURE/curl-count" 2>/dev/null || echo 0) + 1 ))
echo "\$n" >"\$STUB_CAPTURE/curl-count"
printf '%s\n' "\$*" >>"\$STUB_CAPTURE/curl-argv"
cat >"\$STUB_CAPTURE/curl-config-\$n"
case "\$(cat "\$STUB_CAPTURE/curl-config-\$n")" in
  *"/oauth/token"*)
    [[ "\${STUB_CURL_FAIL:-}" == token ]] && exit 22
    printf '{"access_token":"$access_token","token_type":"Bearer","expires_in":3600,"scope":"auth_keys"}'
    ;;
  *"/keys"*)
    [[ "\${STUB_CURL_FAIL:-}" == keys ]] && exit 22
    [[ "\${STUB_CURL_NOKEY:-}" == 1 ]] && { printf '{"id":"k1"}'; exit 0; }
    printf '{"id":"k1","key":"$minted_key","description":""}'
    ;;
  *) exit 2 ;;
esac
SH
chmod +x "$stubs/curl"

run() { # run <env assignments...>; sets code; stdout in $d/out, stderr in $d/err
  rm -f "$cap"/*
  code=0
  (cd "$workdir" && env "$@" PATH="$stubs:$PATH" STUB_VALUES="$values" STUB_CAPTURE="$cap" TMPDIR="$scratch" \
    bash "$tree/infrastructure/tailscale/mint-authkey.sh") >"$d/out" 2>"$d/err" || code=$?
}

no_leak() { # no_leak <label> <files...>: no credential or key in the given files
  local label=$1
  shift
  for s in "$secret" "$access_token" "$minted_key"; do
    if grep -qF "$s" "$@"; then fail "a credential or key leaked into $label"; fi
  done
}

reset_values
run X=1
[[ "$code" == 0 ]] || { cat "$d/err" >&2; fail "mint-authkey.sh exited $code"; }
ok "mint-authkey.sh exits 0 against stubbed config and curl, from the enrollment credential alone"

[[ "$(cat "$d/out")" == "$minted_key" ]] || fail "stdout was: $(cat "$d/out")"
[[ "$(wc -l <"$d/out" | tr -d ' ')" == 1 && "$(grep -cF "$minted_key" "$d/out")" == 1 ]] || fail "the key is not printed exactly once"
ok "stdout is exactly the minted key, printed once"

if grep -qF "$minted_key" "$d/err"; then fail "the minted key appeared on stderr"; fi
ok "the minted key does not appear on stderr"

[[ "$(cat "$cap/curl-count")" == 2 ]] || fail "expected 2 curl calls, got $(cat "$cap/curl-count")"
no_leak "curl argv" "$cap/curl-argv"
[[ "$(sort -u "$cap/curl-argv")" == "-fsS --max-time 30 -K -" ]] || fail "unexpected curl argv: $(cat "$cap/curl-argv")"
ok "two curl calls; credentials reach curl on stdin, never in argv"

config1=$(cat "$cap/curl-config-1")
grep -qxF 'url = "https://api.tailscale.com/api/v2/oauth/token"' <<<"$config1" || fail "token URL wrong: $config1"
[[ "$(grep -c '^url = ' <<<"$config1")" == 1 ]] || fail "token request config must hold exactly one url line (secret redacted): ${config1//$secret/<secret>}"
if grep -qi 'authorization' <<<"$config1"; then fail "the token request must carry no Authorization header"; fi
data1=$(sed -n 's/^data = "\(.*\)"$/\1/p' <<<"$config1")
[[ "$data1" == "grant_type=client_credentials&client_id=$client_id&client_secret=$secret&scope=auth_keys&tags=tag:family-host" ]] \
  || fail "token request body wrong (secret redacted): ${data1//$secret/<secret>}"
ok "token request: OAuth client-credentials grant, scope auth_keys, tags tag:family-host"

config2=$(cat "$cap/curl-config-2")
grep -qxF "url = \"https://api.tailscale.com/api/v2/tailnet/$tailnet/keys\"" <<<"$config2" || fail "keys URL wrong: $config2"
[[ "$(grep -c '^url = ' <<<"$config2")" == 1 ]] || fail "key request config must hold exactly one url line: $config2"
# The second request must authenticate with the access_token the stub returned for the first.
grep -qxF "header = \"Authorization: Bearer $access_token\"" <<<"$config2" || fail "key request lacks the Bearer access_token: $config2"
[[ "$(grep -ci '^header = "authorization' <<<"$config2")" == 1 ]] || fail "key request must carry exactly one Authorization header: $config2"
data2=$(sed -n 's/^data = "\(.*\)"$/\1/p' <<<"$config2")
# curl config strings unescape \" to "; mirror that, then parse the JSON body.
python3 -I - "${data2//\\\"/\"}" <<'PY' || fail "key request body is wrong"
import json, sys
body = json.loads(sys.argv[1])
want = {"capabilities": {"devices": {"create": {
    "reusable": False, "ephemeral": False, "preauthorized": True, "tags": ["tag:family-host"]}}},
    "expirySeconds": 3600}
assert body == want, body
PY
ok "key request: one url line, Bearer access_token from the token call (token call carries none), single-use pre-authorized tag:family-host body, expirySeconds 3600"

[[ -z "$(find "$scratch" "$workdir" -mindepth 1)" ]] || fail "files were left in TMPDIR or the working directory"
ok "no files are written to TMPDIR or the working directory"

for key in TAILSCALE_TAILNET TAILSCALE_ENROLL_OAUTH_CLIENT_ID TAILSCALE_ENROLL_OAUTH_CLIENT_SECRET; do
  reset_values
  rm -f "$values/$key"
  run X=1
  [[ "$code" != 0 ]] || fail "missing $key should fail"
  [[ ! -s "$d/out" ]] || fail "stdout was not empty with $key missing"
  [[ ! -e "$cap/curl-count" ]] || fail "curl ran with $key missing"
  grep -q "$key" "$d/err" || fail "stderr does not name the missing key $key"
  no_leak "output on the missing-$key path" "$d/out" "$d/err"
  ok "missing $key fails non-zero, names the key, calls no curl, prints nothing on stdout"
done

reset_values
printf '%s\n"; evil = "1' "$secret" >"$values/TAILSCALE_ENROLL_OAUTH_CLIENT_SECRET"
run X=1
[[ "$code" != 0 && ! -e "$cap/curl-count" && ! -s "$d/out" ]] || fail "a value with quotes/newlines should be rejected before curl"
ok "a credential with quote or newline characters is rejected before curl"

reset_values
run STUB_CURL_FAIL=token
[[ "$code" != 0 && ! -s "$d/out" && "$(cat "$cap/curl-count")" == 1 ]] || fail "token failure should stop with no output"
no_leak "output on the token-failure path" "$d/out" "$d/err"
ok "a failed token request fails non-zero, makes no key request, prints nothing on stdout"

run STUB_CURL_FAIL=keys
[[ "$code" != 0 && ! -s "$d/out" ]] || fail "key failure should fail with no output"
no_leak "output on the key-failure path" "$d/out" "$d/err"
ok "a failed key request fails non-zero and prints nothing on stdout"

run STUB_CURL_NOKEY=1
[[ "$code" != 0 && ! -s "$d/out" ]] || fail "a response without key should fail with no output"
ok "a key response without a key fails non-zero and prints nothing on stdout"

printf '\n%d checks passed (mint-authkey.sh)\n' "$PASS"
