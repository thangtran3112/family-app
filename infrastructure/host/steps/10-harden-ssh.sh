#!/usr/bin/env bash
# Idempotent SSH hardening for a family-app VPS.
# Runs ON the target host as root/sudo. Safe to re-run.
#
# Required env vars:
#   TARGET_SSH_PORT   - desired SSH port (e.g. 2222)
#
# IMPORTANT — sshd_config precedence:
# `Include /etc/ssh/sshd_config.d/*.conf` is processed in filename-sort
# order, and sshd uses FIRST-obtained-value-wins per directive. Ubuntu
# cloud images ship 50-cloud-init.conf with `PasswordAuthentication yes`.
# Any drop-in meant to override it MUST sort before "50-" or it silently
# loses (confirmed via `sshd -T` on the OVH box on 2026-09-08 -- a prior
# 99-analyst-ai.conf tried to set PasswordAuthentication no and was
# silently defeated by 50-cloud-init.conf). Hence the "01-" prefix below.
#
# Deliberately does NOT lock/disable the Linux account password itself --
# only disables it as an SSH auth method. Keeping the OS password intact
# preserves the provider's web console (OVH KVM, etc.) as a recovery path
# if SSH ever breaks again.
set -euo pipefail

: "${TARGET_SSH_PORT:?TARGET_SSH_PORT is required}"

DROPIN=/etc/ssh/sshd_config.d/01-family-app-hardening.conf
DESIRED=$(cat <<EOF
# Managed by family-app/infrastructure/vps/steps/10-harden-ssh.sh
# Sorts before 50-cloud-init.conf so these values actually win
# (sshd_config uses first-obtained-value-wins per directive).
Port ${TARGET_SSH_PORT}
PermitRootLogin prohibit-password
PasswordAuthentication no
KbdInteractiveAuthentication no
EOF
)

# Capture the full dump ONCE into a variable, then parse the string.
# (Piping a live `sshd -T` process straight into `awk '{...; exit}'` is a
# timing-dependent SIGPIPE trap under `set -o pipefail`: if awk closes its
# input after the first match while sshd is still writing later lines,
# sshd gets SIGPIPE and the pipeline's exit status becomes 141, aborting
# this script under `set -e` before anything else runs. Command
# substitution instead waits for sshd to finish writing, so there's no
# pipe to close early.)
sshd_effective="$(sshd -T 2>/dev/null)"
effective_port="$(grep -m1 '^port ' <<<"$sshd_effective" | awk '{print $2}')"
effective_pwauth="$(grep -m1 '^passwordauthentication ' <<<"$sshd_effective" | awk '{print $2}')"
effective_rootlogin="$(grep -m1 '^permitrootlogin ' <<<"$sshd_effective" | awk '{print $2}')"

if [[ -f "$DROPIN" ]] && diff -q <(echo "$DESIRED") "$DROPIN" >/dev/null 2>&1 \
   && [[ "$effective_port" == "$TARGET_SSH_PORT" ]] \
   && [[ "$effective_pwauth" == "no" ]] \
   && [[ "$effective_rootlogin" == "without-password" ]]; then
  echo "[ssh] already hardened (port=$effective_port passwordauth=$effective_pwauth rootlogin=$effective_rootlogin), no changes"
  exit 0
fi

echo "[ssh] current effective: port=$effective_port passwordauth=$effective_pwauth rootlogin=$effective_rootlogin"
echo "[ssh] writing $DROPIN"
echo "$DESIRED" > "$DROPIN"
chmod 644 "$DROPIN"

echo "[ssh] validating new config with sshd -t"
sshd -t

echo "[ssh] reloading sshd (existing sessions are not dropped by reload)"
systemctl reload ssh || systemctl reload sshd

sshd_effective_after="$(sshd -T 2>/dev/null)"
new_port="$(grep -m1 '^port ' <<<"$sshd_effective_after" | awk '{print $2}')"
new_pwauth="$(grep -m1 '^passwordauthentication ' <<<"$sshd_effective_after" | awk '{print $2}')"
echo "[ssh] effective after reload: port=$new_port passwordauth=$new_pwauth"

if [[ "$new_pwauth" != "no" ]]; then
  echo "[ssh] WARNING: PasswordAuthentication still not 'no' after reload -- check for a conflicting drop-in that sorts even earlier than 01-" >&2
  exit 1
fi

echo "[ssh] hardening applied successfully"
