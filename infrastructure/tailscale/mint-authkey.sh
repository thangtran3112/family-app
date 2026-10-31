#!/usr/bin/env bash
# Mints a one-hour, single-use, pre-authorized auth key tagged tag:family-host
# and prints it ONCE on stdout, so the operator can pipe it straight into the
# host. The key is never written to a file or a log; credentials reach curl on
# stdin, never in argv. Uses the OAuth client in Firestore shared/tailscale.
# Usage: infrastructure/tailscale/mint-authkey.sh |
#          ssh <host> 'sudo tailscale up --auth-key=file:/dev/stdin --advertise-tags=tag:family-host'
# Request shape: https://tailscale.com/docs/features/oauth-clients (token
# endpoint, scope/tags parameters) and the official Tailscale clients' CreateKey
# (capabilities.devices.create, expirySeconds).
set -Eeuo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLI="$ROOT/common/config/family_config.py"
GROUP=shared/tailscale
API=https://api.tailscale.com/api/v2
TAG="${TAILSCALE_TAG_HOST:-tag:family-host}" # keep equal to var.tag_host
die() { echo "mint-authkey.sh: $*" >&2; exit 1; }

# Values go into curl config lines, so allow only characters that need no quoting.
safe() { [[ "$1" =~ ^[A-Za-z0-9._@:-]+$ ]]; }
get() {
  local value
  value="$("$CLI" get "$GROUP" "$1")" || die "cannot read $1 from $GROUP"
  safe "$value" || die "$1 in $GROUP is empty or has unexpected characters"
  printf '%s' "$value"
}
field() { python3 -I -c 'import json,sys; print(json.load(sys.stdin)[sys.argv[1]])' "$1"; }

tailnet="$(get TAILSCALE_TAILNET)"
client_id="$(get TAILSCALE_TF_OAUTH_CLIENT_ID)"
client_secret="$(get TAILSCALE_TF_OAUTH_CLIENT_SECRET)"
safe "$TAG" || die "unexpected characters in tag"

# printf is a builtin, so nothing below puts a credential in a process argument list.
token_response="$(
  printf 'url = "%s/oauth/token"\ndata = "grant_type=client_credentials&client_id=%s&client_secret=%s&scope=auth_keys&tags=%s"\n' \
    "$API" "$client_id" "$client_secret" "$TAG" |
    curl -fsS --max-time 30 -K -
)" || die "OAuth token request failed (does the client have the auth_keys scope for $TAG?)"
access_token="$(printf '%s' "$token_response" | field access_token)" || die "OAuth token response had no access_token"
safe "$access_token" || die "OAuth access_token has unexpected characters"

# JSON body, quotes pre-escaped for a curl config `data = "..."` line.
body='{\"capabilities\":{\"devices\":{\"create\":{\"reusable\":false,\"ephemeral\":false,\"preauthorized\":true,\"tags\":[\"'"$TAG"'\"]}}},\"expirySeconds\":3600}'
key_response="$(
  printf 'url = "%s/tailnet/%s/keys"\nheader = "Authorization: Bearer %s"\nheader = "Content-Type: application/json"\ndata = "%s"\n' \
    "$API" "$tailnet" "$access_token" "$body" |
    curl -fsS --max-time 30 -K -
)" || die "auth key request failed"
auth_key="$(printf '%s' "$key_response" | field key)" || die "auth key response had no key"

echo "minted a one-hour, single-use key for $TAG" >&2
printf '%s\n' "$auth_key"
