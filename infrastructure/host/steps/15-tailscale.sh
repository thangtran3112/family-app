#!/usr/bin/env bash
# Idempotent Tailscale step: tailscaled installed and enabled, the host joined to the tailnet
# with the expected tag. Runs ON the target host as root/sudo. Safe to re-run.
#
# Joining: when the host is not on the tailnet yet, the auth key is read from STDIN (one line),
# never from argv or the environment, so it cannot show up in `ps` or a shell history. Either a
# pre-auth key (tskey-auth-...) or an OAuth client secret (tskey-client-...; the step then adds
# the ephemeral/preauthorized parameters Tailscale expects). With no key and no existing
# membership the step fails and says how to join by hand. A host that is already on the tailnet
# needs no key.
#
# After joining it checks that the device carries the expected tag and warns when its node key
# is set to expire (a host that must stay reachable should have key expiry disabled).
#
# Optional env vars:
#   TS_EXPECTED_TAG=tag:family-host   tag the device must carry
set -euo pipefail

TS_EXPECTED_TAG="${TS_EXPECTED_TAG:-tag:family-host}"
[[ "$TS_EXPECTED_TAG" =~ ^tag:[a-z0-9-]+$ ]] || { echo "[tailscale] TS_EXPECTED_TAG must look like tag:name" >&2; exit 1; }

if ! command -v tailscale >/dev/null 2>&1; then
  echo "[tailscale] installing from the official Tailscale repository"
  curl -fsSL https://tailscale.com/install.sh | sh
fi
systemctl enable --now tailscaled

# status_field EXPR: evaluates a python expression over the parsed `tailscale status --json` (as d).
status_field() {
  tailscale status --json 2>/dev/null | python3 -c 'import json, sys
d = json.load(sys.stdin)
print(eval(sys.argv[1]))' "$1"
}

backend_state="$(status_field 'd.get("BackendState", "")' || true)"
if [[ "$backend_state" != Running ]]; then
  auth_key=""
  if [[ ! -t 0 ]]; then
    IFS= read -r auth_key || true
  fi
  if [[ -z "$auth_key" ]]; then
    echo "[tailscale] ERROR: not on the tailnet (state: ${backend_state:-unknown}) and no auth key on stdin; join once with: sudo tailscale up --advertise-tags=$TS_EXPECTED_TAG" >&2
    exit 1
  fi
  if [[ "$auth_key" == tskey-client-* && "$auth_key" != *\?* ]]; then
    auth_key="${auth_key}?ephemeral=false&preauthorized=true"
  fi
  key_dir="$(mktemp -d)"
  trap 'rm -rf "$key_dir"' EXIT
  (umask 077 && printf '%s' "$auth_key" >"$key_dir/authkey")
  echo "[tailscale] joining the tailnet as $TS_EXPECTED_TAG"
  tailscale up --auth-key="file:$key_dir/authkey" --advertise-tags="$TS_EXPECTED_TAG"
fi

tags="$(status_field '" ".join(d.get("Self", {}).get("Tags") or [])')"
if [[ " $tags " != *" $TS_EXPECTED_TAG "* ]]; then
  echo "[tailscale] ERROR: this device carries tags [${tags:-none}], expected $TS_EXPECTED_TAG; re-tag it in the tailnet policy or admin console" >&2
  exit 1
fi
if [[ "$(status_field 'd.get("Self", {}).get("KeyExpiry") or ""')" != "" ]]; then
  echo "[tailscale] WARNING: the node key expires; disable key expiry for this device so it stays reachable" >&2
fi
echo "[tailscale] on the tailnet with $TS_EXPECTED_TAG"
