#!/usr/bin/env bash
# Fast, Docker-free static checks for the Task 6 systemd units. Plain
# grep/awk assertions (no systemd available in CI) proving the specific
# numeric properties the plan requires. Wired into pnpm ci:test via
# check:vps-backup-infrastructure.
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
SERVICE="$SCRIPT_DIR/family-app-backup.service"
TIMER="$SCRIPT_DIR/family-app-backup.timer"
RETRY="$SCRIPT_DIR/family-app-backup-retry.service"
PASS=0
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
ok() { PASS=$((PASS + 1)); printf 'ok %d - %s\n' "$PASS" "$*"; }

for f in "$SERVICE" "$TIMER" "$RETRY"; do
  [[ -f "$f" ]] || fail "missing unit file: $f"
done
ok "all three unit files exist"

grep -Eq '^OnCalendar=\*-\*-\* 00/12:00:00 UTC$' "$TIMER" || fail "timer must fire at least every 12 hours"
ok "timer fires every 12 hours"

grep -Eq '^Persistent=true$' "$TIMER" || fail "timer must catch up after downtime (Persistent=true)"
ok "timer is Persistent=true (startup catch-up)"

delay=$(grep -E '^RandomizedDelaySec=' "$TIMER" | cut -d= -f2)
[[ -n "$delay" ]] || fail "timer must set RandomizedDelaySec"
(( delay <= 900 )) || fail "RandomizedDelaySec must be at most 15 minutes (900s), got ${delay}s"
ok "timer's randomized delay is at most 15 minutes (${delay}s)"

for f in "$SERVICE" "$RETRY"; do
  runtime_max=$(grep -E '^RuntimeMaxSec=' "$f" | cut -d= -f2)
  [[ "$runtime_max" == "7200" ]] || fail "$f must enforce a two-hour (7200s) RuntimeMaxSec, got '${runtime_max:-unset}'"
done
ok "both service units enforce a two-hour runtime deadline"

grep -Eq '^OnFailure=family-app-backup-retry\.service$' "$SERVICE" || fail "main service must trigger the retry service OnFailure"
ok "main service triggers family-app-backup-retry.service on failure"

grep -Eq '^OnFailure=family-app-backup-retry\.service$' "$RETRY" || fail "retry service must self-chain via its own OnFailure"
start_limit_interval=$(grep -E '^StartLimitIntervalSec=' "$RETRY" | cut -d= -f2)
start_limit_burst=$(grep -E '^StartLimitBurst=' "$RETRY" | cut -d= -f2)
[[ "$start_limit_interval" == "21600" ]] || fail "retry service's StartLimitIntervalSec must be 6 hours (21600s), got '${start_limit_interval:-unset}'"
[[ "$start_limit_burst" == "4" ]] || fail "retry service's StartLimitBurst must be 4, got '${start_limit_burst:-unset}'"
ok "retry service is bounded to at most 4 attempts within a 6-hour window"

grep -Eq 'sleep 3600' "$RETRY" || fail "retry service must space attempts roughly an hour apart"
ok "retry attempts are spaced about an hour apart"

for f in "$SERVICE" "$RETRY"; do
  grep -Fq -- '--read-only' "$f" || fail "$f must run the container with a read-only root filesystem"
  grep -Fq -- '--tmpfs /staging' "$f" || fail "$f must mount /staging as tmpfs"
  grep -Fq -- ':/receipts:ro' "$f" || fail "$f must mount the receipt volume read-only"
done
ok "both service units run the backup container read-only with a tmpfs /staging and a read-only receipt mount"

# --- Durable image reference (2026-10-27..31 outage: a bare local image ID was pruned and could not
# be rebuilt or pulled). The units stay templates; 40-backup.sh installs a local versioned tag (or a
# registry digest) and refuses anything else; each run first self-heals the image through
# ensure-backup-image.sh (present -> pull -> build from /opt/family-app/backup/src).
for f in "$SERVICE" "$RETRY"; do
  # The image is the last argument of `docker run`, still templated, never hard-coded here.
  awk '/^ExecStopPost=/{run=0} run && /^  /{last=$0} /^ExecStart=/{run=1} END{print last}' "$f" | grep -Eq '^  __BACKUP_IMAGE__$' \
    || fail "$f: the final docker run argument must be the templated image placeholder __BACKUP_IMAGE__"
  if grep -Eq 'sha256:|ghcr\.io|family-app-backup:' "$f"; then
    fail "$f must not hard-code an image reference; 40-backup.sh substitutes __BACKUP_IMAGE__"
  fi
  [[ "$(grep -c '^ExecStartPre=/opt/family-app/backup/ensure-backup-image.sh$' "$f")" == "1" ]] \
    || fail "$f: ExecStartPre must be exactly /opt/family-app/backup/ensure-backup-image.sh (once)"
  grep -Fxq 'Environment=BACKUP_IMAGE=__BACKUP_IMAGE__' "$f" || fail "$f: must hand the templated image to the helper via Environment=BACKUP_IMAGE=__BACKUP_IMAGE__"
  if grep -Eq '^ExecStartPre=.*docker (pull|image inspect)' "$f"; then
    fail "$f: ExecStartPre must not pull directly (the registry is private and the host has no login); use the helper"
  fi
done
ok "both service units template the image and self-heal it through ensure-backup-image.sh (ExecStartPre), with no hard-coded reference"

# The helper the units run must exist, be executable, and be installed by 40-backup.sh.
[[ -x "$SCRIPT_DIR/ensure-backup-image.sh" ]] || fail "ensure-backup-image.sh must be executable"
grep -Fq 'ensure-backup-image.sh' "$SCRIPT_DIR/../host/steps/40-backup.sh" || fail "40-backup.sh must install ensure-backup-image.sh"
ok "the helper exists, is executable, and is installed by 40-backup.sh (its branches: test-ensure-backup-image.sh)"

for f in "$SERVICE" "$RETRY"; do
  run_block=$(awk '/^ExecStart=/{run=1} run{print} /^ExecStopPost=/{run=0}' "$f")
  for flag in \
    '--rm' \
    '--network postgres_default' \
    '--read-only' \
    '--tmpfs /staging:size=512m,mode=1700' \
    '--env-file /etc/family-app/backup.env' \
    '-v /etc/family-app/backup-pgpassword:/run/secrets/pgpassword:ro' \
    '-v /etc/family-app/backup-writer-key.json:/run/secrets/writer-key.json:ro' \
    '-v /opt/family-app/backup/state:/state' \
    '-v /opt/family-app/backup/ciphertext:/ciphertext' \
    '-v __RECEIPT_VOLUME__:/receipts:ro'; do
    printf '%s\n' "$run_block" | grep -Fq -- "$flag" || fail "$f: docker run lost '$flag'"
  done
done
grep -Fxq 'ExecStopPost=-/usr/bin/docker rm -f family-app-backup-run' "$SERVICE" || fail "main service must keep its ExecStopPost cleanup"
grep -Fxq 'ExecStopPost=-/usr/bin/docker rm -f family-app-backup-retry-run' "$RETRY" || fail "retry service must keep its ExecStopPost cleanup"
ok "docker run keeps --rm, --read-only, the /staging tmpfs, the env file, and every mount; ExecStopPost cleanup kept"

for f in "$SERVICE" "$RETRY"; do
  grep -Eq '^\[Install\]$' "$f" && fail "$f must have no [Install] section (activated only by the timer or OnFailure, never \`systemctl enable\` directly)"
done
ok "neither service unit is directly enable-able (timer/OnFailure-activated only)"

for f in "$SERVICE" "$TIMER" "$RETRY"; do
  if grep -Eiq 'PASSWORD=|AGE-SECRET-KEY|BEGIN (RSA |EC )?PRIVATE KEY|"private_key"' "$f"; then
    fail "$f appears to contain a literal secret value; secrets must only ever be runtime-mounted paths"
  fi
done
ok "no unit file contains a literal secret value (checked-in files reference only runtime-mounted paths)"

echo
echo "$PASS checks passed (systemd units)"
