#!/usr/bin/env bash
# Idempotent UFW baseline for a family-app VPS.
# Runs ON the target host as root/sudo. Safe to re-run.
#
# Required env vars:
#   TARGET_SSH_PORT   - the SSH port that must stay reachable (e.g. 2222)
#
# Deliberately does NOT touch the provider's external network firewall/
# security-group panel (OVH Control Panel, Database Mart panel, etc.) --
# that layer is outside this box and outside what SSH can configure. See
# ../README.md "Provider network firewall (manual, per provider)".
set -euo pipefail

: "${TARGET_SSH_PORT:?TARGET_SSH_PORT is required}"

if ! command -v ufw >/dev/null 2>&1; then
  echo "[firewall] installing ufw"
  apt-get update -y
  apt-get install -y ufw
fi

want_rule() {
  local port="$1" proto="$2"
  # Plain `ufw status` renders inbound-allow rules as e.g.
  # "2222/tcp                   ALLOW       Anywhere" (no "IN" qualifier --
  # that only appears in `ufw status verbose`). Outbound rules instead
  # start with "Anywhere ... ALLOW OUT", so anchoring on "^${port}/${proto}"
  # can't cross-match those.
  ufw status | grep -qE "^${port}/${proto}[[:space:]]+ALLOW[[:space:]]+Anywhere"
}

changed=0

if ! want_rule "$TARGET_SSH_PORT" tcp; then
  echo "[firewall] allowing ${TARGET_SSH_PORT}/tcp (SSH)"
  ufw allow "${TARGET_SSH_PORT}/tcp" comment 'SSH'
  changed=1
fi

for port in 80 443; do
  if ! want_rule "$port" tcp; then
    echo "[firewall] allowing ${port}/tcp"
    ufw allow "${port}/tcp" comment "$([[ $port == 80 ]] && echo HTTP || echo HTTPS)"
    changed=1
  fi
done

current_default_incoming="$(ufw status verbose 2>/dev/null | awk -F': ' '/^Default:/{print $2}' | awk -F', ' '{print $1}')"
if [[ "$current_default_incoming" != "deny (incoming)" ]]; then
  echo "[firewall] setting default incoming policy to deny"
  ufw default deny incoming
  ufw default allow outgoing
  changed=1
fi

if ! ufw status | grep -q "Status: active"; then
  echo "[firewall] enabling ufw"
  ufw --force enable
  changed=1
fi

if [[ "$changed" == "0" ]]; then
  echo "[firewall] already in desired state, no changes"
else
  echo "[firewall] applied changes"
fi

ufw status verbose
