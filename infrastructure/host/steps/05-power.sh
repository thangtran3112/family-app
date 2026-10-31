#!/usr/bin/env bash
# Idempotent "always-on laptop" baseline: the host never sleeps, reboots only in a Saturday
# window, keeps its journal small and has swap. Runs ON the target host as root/sudo.
# Safe to re-run; each file is rewritten (and its service poked) only when its content changes.
#
#   - sleep, suspend, hibernate and hybrid-sleep targets masked;
#   - logind ignores the lid switch (on battery, on AC and docked);
#   - GNOME idle-suspend off (system dconf database, locked), when dconf is present;
#   - swap: at least SWAP_SIZE_GB in total (a /swapfile is added only when short);
#   - unattended-upgrades for security updates, never rebooting on its own; a systemd timer
#     reboots only when /var/run/reboot-required exists, only inside the Saturday window;
#   - journald capped at 512 MiB.
#
# Optional env vars:
#   SWAP_SIZE_GB=8                      total swap to guarantee
#   REBOOT_ON_CALENDAR="Sat *-*-* 04:00:00"   systemd OnCalendar of the reboot window
#   FAMILY_HOST_ROOT=                   test-only: prefix for every path this script writes
set -euo pipefail

R="${FAMILY_HOST_ROOT:-}"
SWAP_SIZE_GB="${SWAP_SIZE_GB:-8}"
REBOOT_ON_CALENDAR="${REBOOT_ON_CALENDAR:-Sat *-*-* 04:00:00}"
[[ "$SWAP_SIZE_GB" =~ ^[0-9]+$ ]] || { echo "[power] SWAP_SIZE_GB must be a whole number" >&2; exit 1; }

changed_files=()

# put_file PATH MODE: install stdin at PATH when the content differs; records PATH in changed_files.
put_file() {
  local path="$1" mode="$2" tmp
  tmp="$(mktemp)"
  cat >"$tmp"
  if [[ -f "$path" ]] && cmp -s "$tmp" "$path"; then
    rm -f "$tmp"
    return 0
  fi
  install -d -m 0755 "$(dirname "$path")"
  install -m "$mode" "$tmp" "$path"
  rm -f "$tmp"
  changed_files+=("$path")
  echo "[power] wrote $path"
}

was_changed() {
  local f
  for f in "${changed_files[@]+"${changed_files[@]}"}"; do
    [[ "$f" == "$1" ]] && return 0
  done
  return 1
}

echo "[power] masking sleep targets"
systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target

put_file "$R/etc/systemd/logind.conf.d/50-family-app-power.conf" 0644 <<'CONF'
[Login]
HandleLidSwitch=ignore
HandleLidSwitchExternalPower=ignore
HandleLidSwitchDocked=ignore
IdleAction=ignore
CONF
if was_changed "$R/etc/systemd/logind.conf.d/50-family-app-power.conf"; then
  # HUP makes logind re-read its config without ending logged-in sessions.
  systemctl kill -s HUP --kill-whom=main systemd-logind.service || true
fi

if command -v dconf >/dev/null 2>&1; then
  put_file "$R/etc/dconf/db/local.d/00-family-app-power" 0644 <<'CONF'
[org/gnome/settings-daemon/plugins/power]
sleep-inactive-ac-type='nothing'
sleep-inactive-battery-type='nothing'
sleep-inactive-ac-timeout=0
sleep-inactive-battery-timeout=0
CONF
  put_file "$R/etc/dconf/db/local.d/locks/00-family-app-power" 0644 <<'CONF'
/org/gnome/settings-daemon/plugins/power/sleep-inactive-ac-type
/org/gnome/settings-daemon/plugins/power/sleep-inactive-battery-type
/org/gnome/settings-daemon/plugins/power/sleep-inactive-ac-timeout
/org/gnome/settings-daemon/plugins/power/sleep-inactive-battery-timeout
CONF
  profile="$R/etc/dconf/profile/user"
  if [[ ! -f "$profile" ]]; then
    printf 'user-db:user\nsystem-db:local\n' | put_file "$profile" 0644
  elif ! grep -qx 'system-db:local' "$profile"; then
    { cat "$profile"; echo 'system-db:local'; } | put_file "$profile" 0644
  fi
  if was_changed "$R/etc/dconf/db/local.d/00-family-app-power" \
    || was_changed "$R/etc/dconf/db/local.d/locks/00-family-app-power" \
    || was_changed "$profile"; then
    dconf update
  fi
else
  echo "[power] no dconf (not a GNOME install); skipping the GNOME idle-suspend lock"
fi

# Swap: count what is already active, add a swapfile only for the shortfall's sake.
swapfile="$R/swapfile"
have_bytes="$(swapon --show=SIZE --bytes --noheadings 2>/dev/null | awk '{sum += $1} END {print sum + 0}')"
want_bytes=$((SWAP_SIZE_GB * 1024 * 1024 * 1024))
if ((have_bytes >= want_bytes)); then
  echo "[power] swap already ${have_bytes} bytes (>= ${SWAP_SIZE_GB} GiB); no swapfile needed"
else
  if [[ ! -f "$swapfile" ]]; then
    echo "[power] creating ${SWAP_SIZE_GB} GiB swapfile at $swapfile"
    fallocate -l "${SWAP_SIZE_GB}G" "$swapfile"
    chmod 0600 "$swapfile"
    mkswap "$swapfile" >/dev/null
  fi
  if ! swapon --show=NAME --noheadings | grep -qx "$swapfile"; then
    swapon "$swapfile"
  fi
  if ! grep -qE "^${swapfile}[[:space:]]" "$R/etc/fstab" 2>/dev/null; then
    echo "$swapfile none swap sw 0 0" >>"$R/etc/fstab"
    echo "[power] added $swapfile to /etc/fstab"
  fi
fi

if ! dpkg -s unattended-upgrades >/dev/null 2>&1; then
  echo "[power] installing unattended-upgrades"
  apt-get update -y
  apt-get install -y unattended-upgrades
fi
put_file "$R/etc/apt/apt.conf.d/51family-app-auto-upgrades" 0644 <<'CONF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
CONF
# Ubuntu's stock 50unattended-upgrades already allows only the security pockets; this file only
# pins the reboot policy: unattended-upgrades never reboots, the timer below does.
put_file "$R/etc/apt/apt.conf.d/52family-app-unattended-upgrades" 0644 <<'CONF'
Unattended-Upgrade::Automatic-Reboot "false";
CONF

put_file "$R/etc/systemd/system/family-app-saturday-reboot.service" 0644 <<'UNIT'
[Unit]
Description=Reboot into pending security updates (only when one is required)
ConditionPathExists=/var/run/reboot-required

[Service]
Type=oneshot
ExecStart=/usr/bin/systemctl reboot
UNIT
put_file "$R/etc/systemd/system/family-app-saturday-reboot.timer" 0644 <<UNIT
[Unit]
Description=Saturday reboot window for pending security updates

[Timer]
OnCalendar=${REBOOT_ON_CALENDAR}
Persistent=false
RandomizedDelaySec=15min

[Install]
WantedBy=timers.target
UNIT
if was_changed "$R/etc/systemd/system/family-app-saturday-reboot.service" \
  || was_changed "$R/etc/systemd/system/family-app-saturday-reboot.timer"; then
  systemctl daemon-reload
fi
systemctl enable --now family-app-saturday-reboot.timer

put_file "$R/etc/systemd/journald.conf.d/50-family-app.conf" 0644 <<'CONF'
[Journal]
SystemMaxUse=512M
CONF
if was_changed "$R/etc/systemd/journald.conf.d/50-family-app.conf"; then
  systemctl restart systemd-journald
fi

echo "[power] done: ${#changed_files[@]} file(s) changed"
