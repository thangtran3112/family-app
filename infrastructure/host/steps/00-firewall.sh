#!/usr/bin/env bash
# Idempotent UFW baseline for a family-app VPS.
# Runs ON the target host as root/sudo. Safe to re-run.
#
# Required env vars:
#   TARGET_SSH_PORT   - the SSH port that must stay reachable (e.g. 2222)
#
# Optional env vars (the defaults keep the original VPS behavior):
#   ALLOW_HTTP=1      - 1 (default) opens 80/443. 0 is for a tunnel-only host: 80/443 are
#                       not opened and an existing allow rule for them is removed.
#   SSH_INTERFACE=    - empty (default) allows SSH on every interface. A name such as
#                       tailscale0 allows SSH only on that interface and removes the
#                       any-interface rule for TARGET_SSH_PORT. The interface must already
#                       exist (join the tailnet first), so this cannot lock the operator out.
#
# Deliberately does NOT touch the provider's external network firewall/
# security-group panel (OVH Control Panel, Database Mart panel, etc.) --
# that layer is outside this box and outside what SSH can configure. See
# ../README.md "Provider network firewall (manual, per provider)".
set -euo pipefail

: "${TARGET_SSH_PORT:?TARGET_SSH_PORT is required}"
ALLOW_HTTP="${ALLOW_HTTP:-1}"
SSH_INTERFACE="${SSH_INTERFACE:-}"
[[ "$ALLOW_HTTP" == 0 || "$ALLOW_HTTP" == 1 ]] || { echo "[firewall] ALLOW_HTTP must be 0 or 1" >&2; exit 1; }
[[ -z "$SSH_INTERFACE" || "$SSH_INTERFACE" =~ ^[A-Za-z0-9_.-]{1,15}$ ]] \
  || { echo "[firewall] SSH_INTERFACE is not a valid interface name: $SSH_INTERFACE" >&2; exit 1; }

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

# An interface-scoped allow renders as "2222/tcp on tailscale0   ALLOW   Anywhere".
want_iface_rule() {
  local port="$1" proto="$2" iface="$3"
  ufw status | grep -qE "^${port}/${proto} on ${iface}[[:space:]]+ALLOW[[:space:]]+Anywhere"
}

changed=0

if [[ -z "$SSH_INTERFACE" ]]; then
  if ! want_rule "$TARGET_SSH_PORT" tcp; then
    echo "[firewall] allowing ${TARGET_SSH_PORT}/tcp (SSH)"
    ufw allow "${TARGET_SSH_PORT}/tcp" comment 'SSH'
    changed=1
  fi
else
  # Refuse to scope SSH to an interface that is not there yet: the any-interface rule is
  # removed below, and with the interface down nothing could reach the host.
  if ! ip link show dev "$SSH_INTERFACE" >/dev/null 2>&1; then
    echo "[firewall] ERROR: interface $SSH_INTERFACE does not exist; bring it up first (steps/15-tailscale.sh) so SSH stays reachable" >&2
    exit 1
  fi
  if ! want_iface_rule "$TARGET_SSH_PORT" tcp "$SSH_INTERFACE"; then
    echo "[firewall] allowing ${TARGET_SSH_PORT}/tcp (SSH) on ${SSH_INTERFACE} only"
    ufw allow in on "$SSH_INTERFACE" to any port "$TARGET_SSH_PORT" proto tcp comment 'SSH'
    changed=1
  fi
  if want_rule "$TARGET_SSH_PORT" tcp; then
    echo "[firewall] removing the any-interface allow for ${TARGET_SSH_PORT}/tcp"
    ufw delete allow "${TARGET_SSH_PORT}/tcp"
    changed=1
  fi
fi

for port in 80 443; do
  if [[ "$ALLOW_HTTP" == 1 ]]; then
    if ! want_rule "$port" tcp; then
      echo "[firewall] allowing ${port}/tcp"
      ufw allow "${port}/tcp" comment "$([[ $port == 80 ]] && echo HTTP || echo HTTPS)"
      changed=1
    fi
  elif want_rule "$port" tcp; then
    echo "[firewall] ALLOW_HTTP=0: removing the allow for ${port}/tcp"
    ufw delete allow "${port}/tcp"
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
