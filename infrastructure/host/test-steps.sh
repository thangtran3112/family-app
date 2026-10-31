#!/usr/bin/env bash
# Offline checks of the host bootstrap steps (no root, no Docker daemon, no network): each step
# runs for real against stub commands (ufw, docker, systemctl, tailscale, ...) on PATH and
# scratch directories. Covers the options added for the laptop host while proving the VPS
# defaults are unchanged:
#   00-firewall   ALLOW_HTTP, SSH_INTERFACE        05-power       sleep/swap/updates/journal policy
#   15-tailscale  join, tag check, key handling    20-docker      data-root check
#   30-postgres   compose pins, digest, --data-from-copy
#   35-temporal   staging, env file, legacy guard  40-backup      required inputs
#   bootstrap.sh  option validation
# Usage: infrastructure/host/test-steps.sh
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
STEPS="$SCRIPT_DIR/steps"
PASS=0
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
ok() { PASS=$((PASS + 1)); printf 'ok %d - %s\n' "$PASS" "$*"; }

d="$(mktemp -d)"
trap 'rm -rf "$d"' EXIT
stub="$d/stub"
mkdir -p "$stub"

# --- stubs ------------------------------------------------------------------------------------
# ufw: a stateful fake. State file lines look like the real `ufw status` rows.
cat >"$stub/ufw" <<'SH'
#!/usr/bin/env bash
state="$UFW_STATE"
touch "$state"
printf '%s\n' "$*" >>"$state.log"
case "$1" in
  status)
    echo "Status: active"
    if [[ "${2:-}" == verbose ]]; then echo "Default: deny (incoming), allow (outgoing), disabled (routed)"; fi
    cat "$state"
    ;;
  allow)
    if [[ "$2" == in ]]; then
      echo "${8}/tcp on ${4}   ALLOW   Anywhere" >>"$state"
    else
      echo "$2   ALLOW   Anywhere" >>"$state"
    fi
    ;;
  delete)
    grep -vE "^${3//\//\\/}[[:space:]]+ALLOW" "$state" >"$state.new" || true
    mv "$state.new" "$state"
    ;;
esac
exit 0
SH
cat >"$stub/ip" <<'SH'
#!/usr/bin/env bash
# `ip link show dev IFACE` succeeds only for the interfaces listed in FAKE_IFACES.
[[ " ${FAKE_IFACES:-} " == *" ${4:-} "* ]]
SH
cat >"$stub/systemctl" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$SYSTEMCTL_LOG"
SH
cat >"$stub/dconf" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$SYSTEMCTL_LOG.dconf"
SH
cat >"$stub/swapon" <<'SH'
#!/usr/bin/env bash
case "$*" in
  "--show=SIZE --bytes --noheadings") printf '%s\n' "${FAKE_SWAP_BYTES:-0}" ;;
  "--show=NAME --noheadings") cat "$SWAP_ACTIVE" 2>/dev/null || true ;;
  *) echo "$1" >>"$SWAP_ACTIVE" ;;
esac
SH
cat >"$stub/fallocate" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$SYSTEMCTL_LOG.swap"
: >"$3"
SH
cat >"$stub/mkswap" <<'SH'
#!/usr/bin/env bash
printf 'mkswap %s\n' "$*" >>"$SYSTEMCTL_LOG.swap"
SH
cat >"$stub/dpkg" <<'SH'
#!/usr/bin/env bash
exit 0
SH
cat >"$stub/apt-get" <<'SH'
#!/usr/bin/env bash
exit 0
SH
# docker: a recorder with switches for the behaviors the steps look at.
cat >"$stub/docker" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$DOCKER_LOG"
case "$1" in
  --version) echo "Docker version 99 (fake)" ;;
  info) printf '%s\n' "${FAKE_DOCKER_ROOT:-/var/lib/docker}" ;;
  inspect) echo healthy ;;
  ps) printf '%s\n' "${FAKE_LEGACY_TEMPORAL:-}" ;;
  network) [[ "$2" == inspect ]] && exit 1 || exit 0 ;;
  run) [[ -z "${FAKE_NO_PGDATA:-}" ]] || exit 1 ;;
  compose)
    shift
    if [[ "${1:-}" == version ]]; then echo "Docker Compose version 99 (fake)"; exit 0; fi
    # `compose exec -T postgres psql ... SELECT 1 ...` answers "1" (the database exists).
    if [[ " $* " == *" exec "* && " $* " == *" psql "* && " $* " == *"SELECT 1"* ]]; then echo 1; fi
    ;;
esac
exit 0
SH
cat >"$stub/tailscale" <<'SH'
#!/usr/bin/env bash
case "$1" in
  status)
    state="${TS_STATE:-NeedsLogin}"; tags="${TS_TAGS:-}"
    if [[ -f "$TS_STATE_FILE" ]]; then read -r state tags <"$TS_STATE_FILE"; fi
    python3 - "$state" "$tags" "${TS_KEY_EXPIRY:-}" <<'PY'
import json, sys
state, tags, expiry = sys.argv[1:4]
print(json.dumps({"BackendState": state, "Self": {"Tags": [t for t in tags.split(",") if t], "KeyExpiry": expiry or None}}))
PY
    ;;
  up)
    keyfile="${2#--auth-key=file:}"
    cat "$keyfile" >"$TS_UP_KEY"
    printf '%s\n' "$*" >>"$TS_UP_LOG"
    tag="${3#--advertise-tags=}"
    printf 'Running %s\n' "$tag" >"$TS_STATE_FILE"
    ;;
esac
SH
cat >"$stub/curl" <<'SH'
#!/usr/bin/env bash
echo "stub curl must not be called" >&2
exit 1
SH
chmod +x "$stub"/*
export PATH="$stub:$PATH"
export UFW_STATE="$d/ufw-state" SYSTEMCTL_LOG="$d/systemctl.log" DOCKER_LOG="$d/docker.log"
export SWAP_ACTIVE="$d/swap-active" TS_STATE_FILE="$d/ts-state" TS_UP_KEY="$d/ts-up-key" TS_UP_LOG="$d/ts-up.log"

reset_logs() { : >"$UFW_STATE"; rm -f "$UFW_STATE.log" "$SYSTEMCTL_LOG"* "$DOCKER_LOG" "$SWAP_ACTIVE" "$TS_STATE_FILE" "$TS_UP_KEY" "$TS_UP_LOG"; }

# --- 00-firewall.sh -----------------------------------------------------------------------------
reset_logs
TARGET_SSH_PORT=2222 FAKE_IFACES="" bash "$STEPS/00-firewall.sh" >"$d/out" 2>&1 || fail "firewall defaults: $(cat "$d/out")"
for rule in '^2222/tcp ' '^80/tcp ' '^443/tcp '; do
  grep -qE "$rule" "$UFW_STATE" || fail "firewall defaults must allow $rule: $(cat "$UFW_STATE")"
done
ok "firewall defaults (VPS): SSH on any interface, 80 and 443 open"

reset_logs
TARGET_SSH_PORT=2222 bash "$STEPS/00-firewall.sh" >/dev/null 2>&1
before="$(cat "$UFW_STATE")"
TARGET_SSH_PORT=2222 bash "$STEPS/00-firewall.sh" >"$d/out" 2>&1
if [[ "$(cat "$UFW_STATE")" != "$before" ]] || ! grep -q "already in desired state" "$d/out"; then fail "firewall defaults must be idempotent"; fi
ok "firewall defaults are idempotent"

reset_logs
printf '80/tcp   ALLOW   Anywhere\n443/tcp   ALLOW   Anywhere\n' >"$UFW_STATE"
TARGET_SSH_PORT=2222 ALLOW_HTTP=0 bash "$STEPS/00-firewall.sh" >"$d/out" 2>&1 || fail "ALLOW_HTTP=0: $(cat "$d/out")"
grep -qE '^(80|443)/tcp' "$UFW_STATE" && fail "ALLOW_HTTP=0 must close 80 and 443: $(cat "$UFW_STATE")"
grep -qE '^2222/tcp ' "$UFW_STATE" || fail "ALLOW_HTTP=0 must still allow SSH"
ok "ALLOW_HTTP=0 opens no 80/443 and removes existing allows"

reset_logs
printf '2222/tcp   ALLOW   Anywhere\n' >"$UFW_STATE"
TARGET_SSH_PORT=2222 SSH_INTERFACE=tailscale0 FAKE_IFACES="tailscale0" bash "$STEPS/00-firewall.sh" >"$d/out" 2>&1 || fail "SSH_INTERFACE: $(cat "$d/out")"
grep -qE '^2222/tcp on tailscale0 ' "$UFW_STATE" || fail "SSH must be allowed on tailscale0: $(cat "$UFW_STATE")"
grep -qE '^2222/tcp +ALLOW' "$UFW_STATE" && fail "the any-interface SSH allow must be removed: $(cat "$UFW_STATE")"
ok "SSH_INTERFACE=tailscale0 scopes SSH to that interface and drops the any-interface rule"

reset_logs
if TARGET_SSH_PORT=2222 SSH_INTERFACE=tailscale0 FAKE_IFACES="" bash "$STEPS/00-firewall.sh" >"$d/out" 2>&1; then
  fail "SSH_INTERFACE with a missing interface must fail"
fi
grep -q "does not exist" "$d/out" || fail "missing-interface error not explained: $(cat "$d/out")"
[[ ! -s "$UFW_STATE" ]] || fail "nothing may be allowed or removed before the interface check: $(cat "$UFW_STATE")"
ok "SSH_INTERFACE refuses an interface that does not exist (no lock-out)"

for bad in "ALLOW_HTTP=2" "SSH_INTERFACE=bad;name"; do
  reset_logs
  if env TARGET_SSH_PORT=2222 "$bad" bash "$STEPS/00-firewall.sh" >/dev/null 2>&1; then fail "'$bad' must be rejected"; fi
done
ok "firewall rejects malformed ALLOW_HTTP and SSH_INTERFACE"

# --- 05-power.sh --------------------------------------------------------------------------------
reset_logs
root="$d/hostroot"
mkdir -p "$root/etc"
FAMILY_HOST_ROOT="$root" FAKE_SWAP_BYTES=0 bash "$STEPS/05-power.sh" >"$d/out" 2>&1 || fail "05-power: $(cat "$d/out")"
for target in sleep.target suspend.target hibernate.target hybrid-sleep.target; do
  grep -q "^mask .*$target" "$SYSTEMCTL_LOG" || fail "$target must be masked: $(cat "$SYSTEMCTL_LOG")"
done
ok "05-power masks sleep, suspend, hibernate and hybrid-sleep"

logind_conf="$root/etc/systemd/logind.conf.d/50-family-app-power.conf"
grep -q '^HandleLidSwitch=ignore$' "$logind_conf" || fail "logind must ignore the lid switch on battery"
grep -q '^HandleLidSwitchExternalPower=ignore$' "$logind_conf" || fail "logind must ignore the lid switch on AC"
grep -q 'sleep-inactive-ac-type=.nothing.' "$root/etc/dconf/db/local.d/00-family-app-power" || fail "GNOME idle suspend must be off"
grep -q 'system-db:local' "$root/etc/dconf/profile/user" || fail "the dconf profile must read the local system db"
grep -q '^update$' "$SYSTEMCTL_LOG.dconf" || fail "dconf update must run after the GNOME settings change"
ok "05-power: lid switch ignored, GNOME idle suspend off and locked"

grep -q '^SystemMaxUse=512M$' "$root/etc/systemd/journald.conf.d/50-family-app.conf" || fail "journald must be capped at 512M"
grep -q 'Automatic-Reboot "false"' "$root/etc/apt/apt.conf.d/52family-app-unattended-upgrades" || fail "unattended-upgrades must not reboot on its own"
grep -q '^OnCalendar=Sat \*-\*-\* 04:00:00$' "$root/etc/systemd/system/family-app-saturday-reboot.timer" || fail "the reboot window must be Saturday only"
grep -q '^ConditionPathExists=/var/run/reboot-required$' "$root/etc/systemd/system/family-app-saturday-reboot.service" || fail "the reboot must be conditional on reboot-required"
grep -q 'enable --now family-app-saturday-reboot.timer' "$SYSTEMCTL_LOG" || fail "the reboot timer must be enabled"
ok "05-power: journald 512M, security-only updates with a Saturday-only conditional reboot"

grep -q '^8G ' <(awk '{print $2, $3}' "$SYSTEMCTL_LOG.swap") || grep -q -- '-l 8G' "$SYSTEMCTL_LOG.swap" || fail "an 8 GiB swapfile must be created when there is no swap"
grep -q "$root/swapfile none swap" "$root/etc/fstab" || fail "the swapfile must be in fstab"
ok "05-power creates an 8 GiB swapfile when swap is short"

: >"$SYSTEMCTL_LOG"
FAMILY_HOST_ROOT="$root" FAKE_SWAP_BYTES=0 bash "$STEPS/05-power.sh" >"$d/out" 2>&1
grep -q '0 file(s) changed' "$d/out" || fail "a second run must change no files: $(cat "$d/out")"
grep -q 'daemon-reload\|HUP\|restart' "$SYSTEMCTL_LOG" && fail "a second run must not reload or restart anything: $(cat "$SYSTEMCTL_LOG")"
ok "05-power is idempotent: a second run rewrites nothing and restarts nothing"

reset_logs
root2="$d/hostroot2"
mkdir -p "$root2/etc"
FAMILY_HOST_ROOT="$root2" FAKE_SWAP_BYTES=$((8 * 1024 * 1024 * 1024)) bash "$STEPS/05-power.sh" >"$d/out" 2>&1
[[ ! -e "$SYSTEMCTL_LOG.swap" ]] || fail "no swapfile may be created when 8 GiB of swap already exists"
ok "05-power adds no swapfile when swap is already big enough"

# --- 15-tailscale.sh ----------------------------------------------------------------------------
reset_logs
printf 'Running tag:family-host\n' >"$TS_STATE_FILE"
bash "$STEPS/15-tailscale.sh" </dev/null >"$d/out" 2>&1 || fail "already-joined host: $(cat "$d/out")"
[[ ! -e "$TS_UP_LOG" ]] || fail "a host already on the tailnet must not run tailscale up"
ok "15-tailscale: a host already on the tailnet with the right tag needs no key and no join"

reset_logs
if bash "$STEPS/15-tailscale.sh" </dev/null >"$d/out" 2>&1; then fail "no membership and no key must fail"; fi
grep -q "no auth key on stdin" "$d/out" || fail "the missing-key error must say how to join: $(cat "$d/out")"
ok "15-tailscale: no membership and no key fails with instructions"

reset_logs
bash "$STEPS/15-tailscale.sh" <<<"tskey-auth-FAKEKEY123" >"$d/out" 2>&1 || fail "join with a pre-auth key: $(cat "$d/out")"
[[ "$(cat "$TS_UP_KEY")" == "tskey-auth-FAKEKEY123" ]] || fail "the pre-auth key must reach tailscale up unchanged"
grep -q -- '--advertise-tags=tag:family-host' "$TS_UP_LOG" || fail "the join must advertise tag:family-host"
grep -q 'tskey-auth-FAKEKEY123' "$TS_UP_LOG" && fail "the key must travel in a file, never in argv"
ok "15-tailscale joins with a stdin key (via a 0600 file, never argv) and the family-host tag"

reset_logs
bash "$STEPS/15-tailscale.sh" <<<"tskey-client-FAKEID-FAKESECRET" >"$d/out" 2>&1 || fail "join with an OAuth client secret: $(cat "$d/out")"
[[ "$(cat "$TS_UP_KEY")" == "tskey-client-FAKEID-FAKESECRET?ephemeral=false&preauthorized=true" ]] || fail "an OAuth client secret needs the ephemeral/preauthorized parameters: $(cat "$TS_UP_KEY")"
ok "15-tailscale adds the ephemeral=false&preauthorized=true parameters to an OAuth client secret"

reset_logs
printf 'Running tag:other\n' >"$TS_STATE_FILE"
if bash "$STEPS/15-tailscale.sh" </dev/null >"$d/out" 2>&1; then fail "a device with the wrong tag must fail"; fi
grep -q "expected tag:family-host" "$d/out" || fail "the wrong-tag error must name the expected tag: $(cat "$d/out")"
ok "15-tailscale fails when the device lacks the expected tag"

# --- 20-docker.sh -------------------------------------------------------------------------------
reset_logs
bash "$STEPS/20-docker.sh" >"$d/out" 2>&1 || fail "docker defaults: $(cat "$d/out")"
grep -q "already installed" "$d/out" || fail "docker defaults must detect the install"
ok "20-docker defaults (VPS): no data-root check"

mkdir -p "$d/docker-root"
FAKE_DOCKER_ROOT="$d/docker-root" DOCKER_DATA_ROOT="$d/docker-root" bash "$STEPS/20-docker.sh" >"$d/out" 2>&1 || fail "matching data-root: $(cat "$d/out")"
grep -q "data-root OK" "$d/out" || fail "matching data-root must report OK"
ok "20-docker passes when the data-root matches"

if FAKE_DOCKER_ROOT=/var/lib/docker DOCKER_DATA_ROOT="$d/docker-root" bash "$STEPS/20-docker.sh" >"$d/out" 2>&1; then fail "a data-root mismatch must fail"; fi
grep -q "expected $d/docker-root" "$d/out" || fail "the mismatch error must name both paths: $(cat "$d/out")"
ok "20-docker fails when Docker uses a different data-root"

FAKE_DOCKER_ROOT="$d/docker-root" DOCKER_DATA_ROOT="$d/docker-root" DOCKER_DATA_MIN_GB=1 bash "$STEPS/20-docker.sh" >/dev/null 2>&1 || fail "a 1 GB minimum must pass on a real filesystem"
if FAKE_DOCKER_ROOT="$d/docker-root" DOCKER_DATA_ROOT="$d/docker-root" DOCKER_DATA_MIN_GB=99999999 bash "$STEPS/20-docker.sh" >"$d/out" 2>&1; then fail "an impossible minimum size must fail"; fi
grep -q "need at least 99999999 GB" "$d/out" || fail "the size error must state the minimum: $(cat "$d/out")"
if FAKE_DOCKER_ROOT="$d/docker-root" DOCKER_DATA_ROOT="$d/docker-root" DOCKER_DATA_MIN_GB=lots bash "$STEPS/20-docker.sh" >/dev/null 2>&1; then fail "a non-numeric minimum must fail"; fi
ok "20-docker enforces DOCKER_DATA_MIN_GB and rejects a malformed value"

# --- 30-postgres.sh -----------------------------------------------------------------------------
new_pg() {
  pg="$d/pg-$1"
  rm -rf "$pg"
  mkdir -p "$pg/initdb"
  printf '#!/bin/bash\n' >"$pg/initdb/app_db__zz-roles.sh"
}
DIGEST_IMAGE="pgvector/pgvector@sha256:0000000000000000000000000000000000000000000000000000000000000000"

reset_logs
new_pg default
SHARED_PG_DIR="$pg" POSTGRES_IMAGE="pgvector/pgvector:pg17" REQUIRED_PASSWORD_VARS="APP_DB_PASSWORD" \
  bash "$STEPS/30-postgres.sh" >"$d/out" 2>"$d/err" || fail "postgres default: $(cat "$d/out" "$d/err")"
compose="$pg/docker-compose.yml"
grep -q '^name: postgres$' "$compose" || fail "the compose project name must be pinned to postgres"
grep -q 'container_name: family-app-postgres' "$compose" || fail "the container must be family-app-postgres"
grep -q '"127.0.0.1:5432:5432"' "$compose" || fail "Postgres must bind 127.0.0.1:5432 only"
grep -q 'aliases: \[postgres\]' "$compose" || fail "the postgres network alias must be kept"
grep -q 'WARNING: POSTGRES_IMAGE is a mutable tag' "$d/err" || fail "a mutable tag must warn"
grep -q '^APP_DB_PASSWORD=' "$pg/.env" || fail "default mode must generate the app password"
grep -q '^POSTGRES_SUPERUSER_PASSWORD=' "$pg/.env" || fail "default mode must generate the superuser password"
grep -qE ' exec .* postgres bash$' "$DOCKER_LOG" || fail "default mode must apply the role scripts: $(cat "$DOCKER_LOG")"
ok "30-postgres default: pinned project name, family-app-postgres, 127.0.0.1:5432, postgres alias, role scripts applied"

reset_logs
new_pg digest
SHARED_PG_DIR="$pg" POSTGRES_IMAGE="$DIGEST_IMAGE" REQUIRE_IMAGE_DIGEST=1 REQUIRED_PASSWORD_VARS="APP_DB_PASSWORD" \
  bash "$STEPS/30-postgres.sh" >"$d/out" 2>"$d/err" || fail "digest-pinned image with REQUIRE_IMAGE_DIGEST=1: $(cat "$d/err")"
grep -q "image: $DIGEST_IMAGE" "$pg/docker-compose.yml" || fail "the digest-pinned image must reach the compose file"
grep -q WARNING "$d/err" && fail "a digest-pinned image must not warn"
new_pg tag
if SHARED_PG_DIR="$pg" POSTGRES_IMAGE="pgvector/pgvector:pg17" REQUIRE_IMAGE_DIGEST=1 REQUIRED_PASSWORD_VARS="APP_DB_PASSWORD" \
  bash "$STEPS/30-postgres.sh" >/dev/null 2>"$d/err"; then fail "REQUIRE_IMAGE_DIGEST=1 must reject a tag"; fi
[[ ! -e "$pg/docker-compose.yml" ]] || fail "a rejected image must not leave a compose file behind"
ok "30-postgres: digest pin accepted, REQUIRE_IMAGE_DIGEST=1 rejects a mutable tag before touching anything"

reset_logs
new_pg copy
printf 'POSTGRES_SUPERUSER_PASSWORD=copied-from-the-old-host\n' >"$pg/.env"
SHARED_PG_DIR="$pg" POSTGRES_IMAGE="$DIGEST_IMAGE" bash "$STEPS/30-postgres.sh" --data-from-copy >"$d/out" 2>"$d/err" \
  || fail "--data-from-copy with a copied cluster: $(cat "$d/out" "$d/err")"
grep -q ' exec ' "$DOCKER_LOG" && fail "--data-from-copy must run no database or role script: $(cat "$DOCKER_LOG")"
[[ "$(cat "$pg/.env")" == "POSTGRES_SUPERUSER_PASSWORD=copied-from-the-old-host" ]] || fail "--data-from-copy must not generate or change any password"
grep -q 'up -d' "$DOCKER_LOG" || fail "--data-from-copy must still bring the cluster up"
ok "30-postgres --data-from-copy: cluster up on the copied data, no passwords generated, no role scripts"

new_pg copy2
if SHARED_PG_DIR="$pg" POSTGRES_IMAGE="$DIGEST_IMAGE" bash "$STEPS/30-postgres.sh" --data-from-copy >/dev/null 2>"$d/err"; then fail "--data-from-copy without the copied .env password must fail"; fi
grep -q "POSTGRES_SUPERUSER_PASSWORD" "$d/err" || fail "missing-password error not explained"
reset_logs
new_pg copy3
printf 'POSTGRES_SUPERUSER_PASSWORD=x\n' >"$pg/.env"
if FAKE_NO_PGDATA=1 SHARED_PG_DIR="$pg" POSTGRES_IMAGE="$DIGEST_IMAGE" bash "$STEPS/30-postgres.sh" --data-from-copy >/dev/null 2>"$d/err"; then fail "--data-from-copy with no cluster in the volume must fail"; fi
grep -q "no PG_VERSION" "$d/err" || fail "the empty-volume error must say what is missing: $(cat "$d/err")"
grep -q 'up -d' "$DOCKER_LOG" && fail "an empty volume must be caught before the cluster starts"
ok "30-postgres --data-from-copy fails closed without the copied password or the copied cluster"

# --- 35-temporal.sh -----------------------------------------------------------------------------
stage="$d/temporal-stage"
mkdir -p "$stage"
printf 'services: {}\n' >"$stage/docker-compose.yml"
printf '{}\n' >"$stage/dynamicconfig.yaml"
printf '#!/usr/bin/env bash\necho namespaces >>"%s"\n' "$d/namespaces.log" >"$stage/bootstrap-namespaces.sh"
tenv=(TEMPORAL_STAGE_DIR="$stage" TEMPORAL_DIR="$d/opt-temporal" TEMPORAL_ENV_FILE="$d/etc/temporal.env")

reset_logs
rm -rf "${d:?}/opt-temporal" "${d:?}/etc" "${d:?}/namespaces.log"
env "${tenv[@]}" bash "$STEPS/35-temporal.sh" <<<"s3cret-Pass_word.1" >"$d/out" 2>&1 || fail "temporal: $(cat "$d/out")"
[[ "$(cat "$d/etc/temporal.env")" == "TEMPORAL_DB_PASSWORD=s3cret-Pass_word.1" ]] || fail "temporal.env must hold only TEMPORAL_DB_PASSWORD"
mode="$(stat -c '%a' "$d/etc/temporal.env" 2>/dev/null || stat -f '%Lp' "$d/etc/temporal.env")"
[[ "$mode" == 600 ]] || fail "temporal.env must be mode 0600, got $mode"
for f in docker-compose.yml dynamicconfig.yaml bootstrap-namespaces.sh; do [[ -f "$d/opt-temporal/$f" ]] || fail "$f must be staged"; done
grep -q "compose --project-name family-temporal --env-file $d/etc/temporal.env -f $d/opt-temporal/docker-compose.yml up -d --wait" "$DOCKER_LOG" || fail "the server must start with the family-temporal project and the env file: $(cat "$DOCKER_LOG")"
grep -q 'network create family_shared' "$DOCKER_LOG" || fail "family_shared must be created when missing"
[[ -f "$d/namespaces.log" ]] || fail "bootstrap-namespaces.sh must run"
grep -q 's3cret' "$DOCKER_LOG" && fail "the password must never reach a docker command line"
ok "35-temporal stages the files, writes a 0600 env file from stdin, starts family-temporal and bootstraps namespaces"

reset_logs
env "${tenv[@]}" bash "$STEPS/35-temporal.sh" </dev/null >"$d/out" 2>&1 || fail "temporal re-run with the env file kept: $(cat "$d/out")"
[[ "$(cat "$d/etc/temporal.env")" == "TEMPORAL_DB_PASSWORD=s3cret-Pass_word.1" ]] || fail "a re-run without stdin must keep the env file"
ok "35-temporal re-run without a password keeps the existing env file"

reset_logs
rm -rf "${d:?}/etc"
if env "${tenv[@]}" bash "$STEPS/35-temporal.sh" </dev/null >"$d/out" 2>&1; then fail "no password and no env file must fail"; fi
unsafe_password="bad pass\$word"
if env "${tenv[@]}" bash "$STEPS/35-temporal.sh" <<<"$unsafe_password" >/dev/null 2>&1; then fail "an unsafe password must be rejected"; fi
if env "${tenv[@]}" FAKE_LEGACY_TEMPORAL=abc123 bash "$STEPS/35-temporal.sh" <<<"ok-pass" >"$d/out" 2>&1; then fail "a running legacy Temporal must block the step"; fi
grep -q "legacy expense-tax-production Temporal is still running" "$d/out" || fail "the legacy guard must explain itself: $(cat "$d/out")"
grep -q 'up -d' "$DOCKER_LOG" && fail "nothing may start while the legacy Temporal runs"
ok "35-temporal fails closed: no password, unsafe password, or the legacy Temporal still running"

# --- 40-backup.sh -------------------------------------------------------------------------------
if env -u BACKUP_HOST_ID BACKUP_DIR=/x BACKUP_GCS_URI=gs://b AGE_RECIPIENT=age1x RECEIPT_VOLUME=v BACKUP_IMAGE=i UNIT_FILES_DIR=/tmp \
  bash "$STEPS/40-backup.sh" >"$d/out" 2>&1; then fail "40-backup must fail without BACKUP_HOST_ID"; fi
grep -q "BACKUP_HOST_ID is required" "$d/out" || fail "the missing BACKUP_HOST_ID error must name it: $(cat "$d/out")"
if grep -n 'SHARED_PG_DIR' "$STEPS/40-backup.sh" | grep -vE '^[0-9]+:#' | grep -q .; then
  fail "40-backup.sh must not read the shared-Postgres directory (the live host has no .env there)"
fi
grep -q 'backup-pgpassword' "$STEPS/40-backup.sh" || fail "40-backup.sh must expect the streamed backup-pgpassword file"
ok "40-backup: BACKUP_HOST_ID is required and the Postgres password comes from the streamed file, not a .env"

# BACKUP_IMAGE must be rebuildable on the host (the 2026-10-27..31 backup outage: a bare local image ID
# was pruned and could be neither rebuilt nor pulled). The check runs before any file is touched.
digest64=$(printf 'a%.0s' {1..64})
run_backup_image() {
  env BACKUP_DIR="$d/backup" BACKUP_GCS_URI=gs://b BACKUP_HOST_ID=h AGE_RECIPIENT=age1x RECEIPT_VOLUME=v \
    BACKUP_IMAGE="$1" UNIT_FILES_DIR="$d/units" bash "$STEPS/40-backup.sh" >"$d/out" 2>&1
}
for bad in "sha256:93747d0e1f2a${digest64:0:52}" "93747d0e1f2a" "family-app-backup" "family-app-backup:latest" \
  "ghcr.io/o/r/family-app-backup" "ghcr.io/o/r/family-app-backup:abc123" "other-image:1" \
  "ghcr.io/o/r/family-app-backup@sha256:abc" "localhost:5000/o/family-app-backup@sha256:$digest64"; do
  if run_backup_image "$bad"; then fail "40-backup must reject BACKUP_IMAGE='$bad'"; fi
  grep -q "family-app-backup:2026-10-31" "$d/out" || fail "rejecting '$bad' must name the local-tag remedy: $(cat "$d/out")"
  grep -q "family-app-backup-image.yml" "$d/out" || fail "rejecting '$bad' must name the registry-digest remedy: $(cat "$d/out")"
  grep -q "writer-key.json missing" "$d/out" && fail "'$bad' must be rejected before any other preflight: $(cat "$d/out")"
done
run_backup_image "sha256:93747d0e1f2a${digest64:0:52}" || true
grep -q "bare local image ID" "$d/out" || fail "a bare sha256 ID needs its own message: $(cat "$d/out")"
# A local versioned tag or a registry digest passes the image check; the run then stops at the next
# preflight (no writer key on this machine). Skipped on a host that really has the key, where the step
# would install units.
if [[ ! -e /etc/family-app/backup-writer-key.json ]]; then
  for good in "family-app-backup:2026-10-31" "family-app-backup:v1.2_3" \
    "ghcr.io/thangtran3112/family-app/family-app-backup@sha256:$digest64" \
    "ghcr.io/o/r/family-app-backup:abc123@sha256:$digest64"; do
    if run_backup_image "$good"; then fail "'$good' should stop at the missing writer key, not succeed"; fi
    grep -q "BACKUP_IMAGE=" "$d/out" && fail "40-backup must accept '$good': $(cat "$d/out")"
    grep -q "writer-key.json missing" "$d/out" || fail "'$good' must get past the image check: $(cat "$d/out")"
  done
  ok "40-backup: a bare image ID, :latest or other ref is refused (naming both remedies); a local versioned tag or registry digest is accepted"
else
  ok "40-backup: bad refs refused (acceptance case skipped: this host has a real writer key)"
fi

# The step stages the image build context and the self-heal helper (it runs as root, so this is a
# static check of what it installs, with the modes the image itself uses).
grep -Fq '"${BACKUP_DIR}/src"' "$STEPS/40-backup.sh" || fail "40-backup.sh must stage the build context in \${BACKUP_DIR}/src"
for f in lib.sh backup.sh restore.sh recovery-drill.sh Dockerfile ensure-backup-image.sh; do
  grep -Eq "(for f in .*\b$f\b|UNIT_FILES_DIR\}/$f)" "$STEPS/40-backup.sh" || fail "40-backup.sh must install $f"
done
grep -Fq 'install -m 0555 -o root -g root "${UNIT_FILES_DIR}/${f}" "${BACKUP_DIR}/src/${f}"' "$STEPS/40-backup.sh" || fail "the staged scripts must be root-owned 0555"
grep -Fq 'install -m 0555 -o root -g root "${UNIT_FILES_DIR}/ensure-backup-image.sh" "${BACKUP_DIR}/ensure-backup-image.sh"' "$STEPS/40-backup.sh" || fail "the helper must be installed root-owned 0555 at \${BACKUP_DIR}/ensure-backup-image.sh"
ok "40-backup: stages Dockerfile + lib/backup/restore/recovery-drill scripts in \${BACKUP_DIR}/src and installs ensure-backup-image.sh (root, 0555)"

# --- bootstrap.sh option validation ---------------------------------------------------------------
base=(--host 198.51.100.1 --ssh-user ubuntu --ssh-key /dev/null --app "$SCRIPT_DIR/apps/expense-tax-management.conf" --only firewall)
for bad in "--allow-http 2" "--ssh-interface a;b" "--docker-data-min-gb many" "--docker-data-root relative/path"; do
  # shellcheck disable=SC2086 # intentional word splitting of the option string
  if bash "$SCRIPT_DIR/bootstrap.sh" "${base[@]}" $bad >/dev/null 2>&1; then fail "bootstrap.sh '$bad' must be rejected"; fi
done
ok "bootstrap.sh rejects malformed new options before connecting anywhere"

printf '\n%d checks passed (host bootstrap steps)\n' "$PASS"
