#!/usr/bin/env bash
# Fast, Docker-free checks for ensure-backup-image.sh: a stub `docker` on PATH proves each branch
# (present -> pull -> build -> fail). Wired into CI via check:vps-backup-infrastructure.
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
ENSURE="$SCRIPT_DIR/ensure-backup-image.sh"
PASS=0
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
ok() { PASS=$((PASS + 1)); printf 'ok %d - %s\n' "$PASS" "$*"; }

d=$(mktemp -d)
trap 'rm -rf "$d"' EXIT
mkdir -p "$d/bin" "$d/src"
touch "$d/src/Dockerfile"
export DOCKER_LOG="$d/log"
# Each stub verb succeeds unless its STUB_*_FAILS variable is set.
cat >"$d/bin/docker" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$DOCKER_LOG"
case "$1" in
  image) [[ -z "${STUB_INSPECT_FAILS:-}" ]] ;;
  pull) [[ -z "${STUB_PULL_FAILS:-}" ]] ;;
  build) [[ -z "${STUB_BUILD_FAILS:-}" ]] ;;
  *) exit 99 ;;
esac
SH
chmod +x "$d/bin/docker"

image="family-app-backup:2026-10-31"
# run <env assignments...>: runs the helper, leaves stdout+stderr in $d/out and the status in $rc.
run() {
  : >"$DOCKER_LOG"
  rc=0
  env PATH="$d/bin:$PATH" BACKUP_IMAGE="$image" BACKUP_SRC_DIR="$d/src" "$@" bash "$ENSURE" >"$d/out" 2>&1 || rc=$?
}
logged() { grep -q "^$1" "$DOCKER_LOG"; }

run
[[ $rc -eq 0 ]] || fail "image present must exit 0: $(cat "$d/out")"
[[ ! -s "$d/out" ]] || fail "image present must print nothing: $(cat "$d/out")"
logged "image inspect $image" || fail "must inspect the exact image: $(cat "$DOCKER_LOG")"
if logged pull || logged build; then fail "image present must not pull or build: $(cat "$DOCKER_LOG")"; fi
ok "present: exit 0, silent, no pull, no build"

run STUB_INSPECT_FAILS=1
[[ $rc -eq 0 ]] || fail "absent + pull ok must exit 0: $(cat "$d/out")"
logged "pull $image" || fail "must pull the exact image: $(cat "$DOCKER_LOG")"
if logged build; then fail "a successful pull must not build: $(cat "$DOCKER_LOG")"; fi
ok "absent + pull ok: exit 0, no build"

run STUB_INSPECT_FAILS=1 STUB_PULL_FAILS=1
[[ $rc -eq 0 ]] || fail "absent + pull fails + build ok must exit 0: $(cat "$d/out")"
logged "build -t $image $d/src" || fail "must build the tag from BACKUP_SRC_DIR: $(cat "$DOCKER_LOG")"
ok "absent + pull fails + build ok: exit 0, builds the tag from the source dir"

run STUB_INSPECT_FAILS=1 STUB_PULL_FAILS=1 STUB_BUILD_FAILS=1
[[ $rc -ne 0 ]] || fail "absent + pull and build fail must exit non-zero"
for needle in "$image" "$d/src" "registry"; do
  grep -Fq -- "$needle" "$d/out" || fail "the failure line must name '$needle': $(cat "$d/out")"
done
[[ $(wc -l <"$d/out" | tr -d ' ') == 1 ]] || fail "the failure must be one line: $(cat "$d/out")"
ok "absent + pull and build fail: non-zero, one line naming the image, the build context and the registry"

rm "$d/src/Dockerfile"
run STUB_INSPECT_FAILS=1 STUB_PULL_FAILS=1
[[ $rc -ne 0 ]] || fail "absent + no build context must exit non-zero"
if logged build; then fail "must not run docker build without a Dockerfile: $(cat "$DOCKER_LOG")"; fi
grep -Fq -- "$d/src" "$d/out" || fail "the failure line must name the build context: $(cat "$d/out")"
ok "absent + no build context: non-zero, names the missing path, no build attempted"

if logged login; then fail "the helper must never log in to a registry"; fi
grep -Fq '/opt/family-app/backup/src' "$ENSURE" || fail "BACKUP_SRC_DIR must default to /opt/family-app/backup/src"
if env -u BACKUP_IMAGE PATH="$d/bin:$PATH" bash "$ENSURE" >/dev/null 2>&1; then fail "BACKUP_IMAGE is required"; fi
ok "never logs in; BACKUP_SRC_DIR defaults to /opt/family-app/backup/src; BACKUP_IMAGE is required"

echo
echo "$PASS checks passed (ensure-backup-image.sh)"
