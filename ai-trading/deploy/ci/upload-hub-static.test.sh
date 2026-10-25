#!/usr/bin/env bash
# Offline transaction tests. The fake gcloud stores every version locally.
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="$SCRIPT_DIR/upload-hub-static.sh"
STATIC_CHECK="$SCRIPT_DIR/check-static-export.sh"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { PASS=$((PASS + 1)); echo "ok   $*"; }
PASS=0

fixture() {
  local dir="$1" marker="${2:-old}"
  mkdir -p "$dir/apps" "$dir/_next/static/chunks"
  printf '<html>%s index</html>\n' "$marker" >"$dir/index.html"
  printf '<html>%s 404</html>\n' "$marker" >"$dir/404.html"
  printf '<html>%s settings</html>\n' "$marker" >"$dir/settings.html"
  for app in tradingagents ai-hedge-fund vibe-trading mirofish; do
    printf '<html>%s %s</html>\n' "$marker" "$app" >"$dir/apps/$app.html"
  done
  printf 'console.log(%q)\n' "$marker" >"$dir/_next/static/chunks/app-abc123.js"
  printf 'icon-%s\n' "$marker" >"$dir/favicon.ico"
  # Next 16 exports an RSC segment index for each known route.
  for route in '' login settings _not-found apps/tradingagents apps/ai-hedge-fund apps/vibe-trading apps/mirofish; do
    mkdir -p "$dir/${route}"
    printf 'Flight segment index %s\n' "$marker" >"$dir/${route:+$route/}__next._index.txt"
  done
}

MOCK_BIN="$WORKDIR/bin"; mkdir -p "$MOCK_BIN"
FAKE_GCS_ROOT="$WORKDIR/gcs"; CALL_LOG="$WORKDIR/calls.log"
export FAKE_GCS_ROOT CALL_LOG
cat >"$MOCK_BIN/gcloud" <<'MOCK'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "$*" >>"$CALL_LOG"
root="$FAKE_GCS_ROOT"
parse() { local u b o g=""; u="${1#gs://}"; b="${u%%/*}"; o="${u#*/}"; [[ "$o" == *#* ]] && { g="${o##*#}"; o="${o%#*}"; }; printf '%s\t%s\t%s\n' "$b" "$o" "$g"; }
dir() { printf '%s/%s/%s' "$root" "$1" "$2"; }
[[ "$1" == storage ]] || exit 2; shift
case "$1" in
  ls)
    url="${*: -1}"; b="${url#gs://}"; b="${b%%/*}"
    [[ "${FAIL_LIST:-}" != 1 ]] || { echo 'HTTPError 403: Forbidden' >&2; exit 1; }
    # Like real `gcloud storage ls --recursive`: "gs://b/:" header lines (also
    # for an empty bucket) and per-directory headers, not just object URLs.
    printf 'gs://%s/:\n' "$b"
    if [[ -d "$root/$b" ]]; then
      while IFS= read -r -d '' live; do
        [[ -s "$live" ]] || continue; obj="${live#$root/$b/}"; obj="${obj%/live}"
        [[ "$obj" == */* ]] && printf '\ngs://%s/%s/:\n' "$b" "${obj%/*}"
        printf 'gs://%s/%s\n' "$b" "$obj"
      done < <(find "$root/$b" -name live -print0)
    fi
    ;;
  objects)
    shift; [[ "$1" == describe ]] || exit 2; shift; url="$1"; shift; fmt="${*: -1}"; fmt="${fmt#--format=}"
    IFS=$'\t' read -r b o _ <<<"$(parse "$url")"
    [[ "$o" != "${FAIL_DESCRIBE_OBJECT:-}" ]] || { echo 'HTTPError 403: Forbidden' >&2; exit 1; }
    d="$(dir "$b" "$o")"; live=""; [[ -s "$d/live" ]] && live="$(<"$d/live")"
    if [[ -z "$live" ]]; then echo "The following URLs matched no objects or files: $url" >&2; exit 1; fi
    case "$fmt" in value\(generation\)) printf '%s\n' "$live";; value\(content_type\)) sed -n '1p' "$d/$live.meta";; value\(cache_control\)) sed -n '2p' "$d/$live.meta";; *) exit 2;; esac
    ;;
  cp)
    shift; ct=""; cc=""; args=(); while (($#)); do case "$1" in --quiet) ;; --content-type=*) ct="${1#*=}";; --cache-control=*) cc="${1#*=}";; *) args+=("$1");; esac; shift; done
    src="${args[0]}"; dst="${args[1]}"
    if [[ "$src" != gs://* ]]; then
      IFS=$'\t' read -r b o _ <<<"$(parse "$dst")"; [[ "$o" != "${FAIL_UPLOAD_OBJECT:-}" ]] || { echo "upload failure $o" >&2; exit 1; }; d="$(dir "$b" "$o")"; mkdir -p "$d"; n=0; [[ -f "$d/counter" ]] && n="$(<"$d/counter")"; n=$((n+1)); cp "$src" "$d/$n.content"; printf '%s\n%s\n' "$ct" "$cc" >"$d/$n.meta"; echo "$n" >"$d/counter"; echo "$n" >"$d/live"
    elif [[ "$dst" != gs://* ]]; then
      IFS=$'\t' read -r b o _ <<<"$(parse "$src")"; d="$(dir "$b" "$o")"; [[ -s "$d/live" ]] || exit 1; cp "$d/$(<"$d/live").content" "$dst"
    else
      IFS=$'\t' read -r b o g <<<"$(parse "$src")"; IFS=$'\t' read -r db do _ <<<"$(parse "$dst")"; d="$(dir "$db" "$do")"; mkdir -p "$d"; n=0; [[ -f "$d/counter" ]] && n="$(<"$d/counter")"; n=$((n+1)); cp "$(dir "$b" "$o")/$g.content" "$d/$n.content"; cp "$(dir "$b" "$o")/$g.meta" "$d/$n.meta"; echo "$n" >"$d/counter"; echo "$n" >"$d/live"
    fi
    ;;
  rm)
    url="${*: -1}"; IFS=$'\t' read -r b o _ <<<"$(parse "$url")"; [[ "$o" != "${FAIL_DELETE_OBJECT:-}" ]] || { echo "delete failure $o" >&2; exit 1; }; : >"$(dir "$b" "$o")/live"
    ;;
  *) exit 2;;
esac
MOCK
chmod +x "$MOCK_BIN/gcloud"
cat >"$MOCK_BIN/gsutil" <<'MOCK'
#!/usr/bin/env bash
echo "gsutil must not be called" >&2
exit 99
MOCK
chmod +x "$MOCK_BIN/gsutil"
export PATH="$MOCK_BIN:$PATH"

live_gen() {
  local d="$FAKE_GCS_ROOT/$1/$2/live"
  if [[ -s "$d" ]]; then
    printf '%s' "$(<"$d")"
  fi
}
live_file() { local b="$1" o="$2" g; g="$(live_gen "$b" "$o")"; [[ -n "$g" ]] && printf '%s/%s/%s/%s.content' "$FAKE_GCS_ROOT" "$b" "$o" "$g"; }

BUCKET=test-hub
D1="$WORKDIR/one"; fixture "$D1" old
echo 'old immutable hash' >"$D1/_next/static/chunks/old-stays-abc123.js"
"$TARGET" "$D1" "$BUCKET" >/dev/null || fail "valid export upload failed"
pass "valid export uploads without gsutil"

# Desk uses the same transaction, but an explicit route profile: no hub-only
# required files, arbitrary source files, or wildcard Flight paths.
DESK="$WORKDIR/desk"; mkdir -p "$DESK/_next/static/chunks" "$DESK/strategies/new"
for route in index 404 strategies strategies/new; do
  printf '<html>Desk %s</html>\n' "$route" >"$DESK/$route.html"
done
# The MVP route set: every desktop page must pass the desk allowlist.
for route in today screener screener/filters strategies/library alerts alerts/new watchlists technicals futures futures/specs settings more paper holdings ask covered-calls stocks backtests; do
  mkdir -p "$DESK/$(dirname "$route")"
  printf '<html>Desk %s</html>\n' "$route" >"$DESK/$route.html"
done
printf 'chunk\n' >"$DESK/_next/static/chunks/desk.js"
printf 'Flight\n' >"$DESK/strategies/new/__next.strategies.new.__PAGE__.txt"
"$TARGET" "$DESK" test-desk desk >/dev/null || fail "Desk export profile rejected"
cmp -s "$(live_file test-desk strategies.html)" "$DESK/strategies.html" || fail "Desk strategies not published"
pass "Desk profile uploads its own routes with the shared transaction"
for extra in api/desk/strategies.html private.txt strategies/__next._unknown.txt unknown.html .txt; do
  mkdir -p "$DESK/$(dirname "$extra")"; printf 'private\n' >"$DESK/$extra"; : >"$CALL_LOG"
  "$TARGET" "$DESK" test-desk desk >/dev/null 2>&1 && fail "Desk accepted $extra"
  [[ ! -s "$CALL_LOG" ]] || fail "Desk rejection reached cloud calls"
  rm "$DESK/$extra"
done
pass "Desk profile rejects API, private, unknown route and unknown Flight files before cloud calls"
: >"$CALL_LOG"
"$TARGET" "$DESK" test-desk unknown >/dev/null 2>&1 && fail "unknown profile passed"
[[ ! -s "$CALL_LOG" ]] || fail "unknown profile reached cloud calls"
pass "unknown export profile fails closed"

# The Hub verifier itself owns this release gate. Test it directly so removing
# the uploader allowlist entry cannot accidentally become the only protection.
HUB_WITH_DESK="$WORKDIR/hub-with-desk"; fixture "$HUB_WITH_DESK" dark
printf '<html>Desk must stay dark</html>\n' >"$HUB_WITH_DESK/apps/desk.html"
out="$("$STATIC_CHECK" "$HUB_WITH_DESK" hub 2>&1)" && fail "hub static verifier accepted apps/desk.html"
[[ "$out" == *"apps/desk.html exists but Family Desk is not live yet"* ]] || fail "wrong Hub Desk guard error: $out"
pass "Hub static verifier rejects apps/desk.html with the Release 1 gate message"

for desk_path in apps/desk.html apps/desk.txt apps/desk/__next._tree.txt apps/desk/__next._full.txt apps/desk/__next._index.txt "apps/desk/__next.apps.\$d\$slug.__PAGE__.txt"; do
  : >"$CALL_LOG"; HUB_DESK_PATH="$WORKDIR/hub-desk-path"; rm -rf "$HUB_DESK_PATH"; fixture "$HUB_DESK_PATH" dark
  mkdir -p "$HUB_DESK_PATH/$(dirname "$desk_path")"
  printf 'Desk must stay dark until Phase 4\n' >"$HUB_DESK_PATH/$desk_path"
  "$TARGET" "$HUB_DESK_PATH" "$BUCKET" >/dev/null 2>&1 && fail "$desk_path passed the Hub uploader"
  [[ ! -s "$CALL_LOG" ]] || fail "$desk_path reached cloud calls"
done
pass "Hub uploader rejects every Desk HTML, text and Flight artifact before cloud calls"

# A successful second release deletes stale non-hashed objects but retains old
# content-hashed files for already-loaded pages and rollback revisions.
printf 'removed route\n' >"$WORKDIR/removed.html"
gcloud storage cp --quiet --content-type='text/html; charset=utf-8' --cache-control=no-store "$WORKDIR/removed.html" "gs://$BUCKET/apps/removed.html"
DSECOND="$WORKDIR/second"; fixture "$DSECOND" second
"$TARGET" "$DSECOND" "$BUCKET" >/dev/null || fail "second valid export upload failed"
[[ -z "$(live_gen "$BUCKET" apps/removed.html)" ]] || fail "stale non-hashed object remained live"
[[ -n "$(live_gen "$BUCKET" _next/static/chunks/old-stays-abc123.js)" ]] || fail "old hashed asset was deleted"
cmp -s "$(live_file "$BUCKET" index.html)" "$DSECOND/index.html" || fail "second release index content is not live"
index_gen="$(live_gen "$BUCKET" index.html)"
[[ "$(sed -n '1p' "$FAKE_GCS_ROOT/$BUCKET/index.html/$index_gen.meta")" == 'text/html; charset=utf-8' ]] || fail "second release index MIME is wrong"
[[ "$(sed -n '2p' "$FAKE_GCS_ROOT/$BUCKET/index.html/$index_gen.meta")" == no-store ]] || fail "second release index cache-control is wrong"
pass "second release removes stale non-hashed object and retains old hash"

# This is the actual Next 16 static export, not a synthetic approximation.
# Its Flight payload files must pass the upload allowlist unchanged.
: >"$CALL_LOG"
REAL_OUT="$SCRIPT_DIR/../../frontend/out"
"$TARGET" "$REAL_OUT" real-next-out >/dev/null || fail "real Next static export was rejected"
[[ -s "$CALL_LOG" ]] || fail "real Next static export made no fake-GCS calls"
pass "real Next static export uploads through the fake GCS transaction"
flight_gen="$(live_gen real-next-out __next._index.txt)"
[[ "$(sed -n '1p' "$FAKE_GCS_ROOT/real-next-out/__next._index.txt/$flight_gen.meta")" == text/x-component ]] || fail "Flight index MIME is wrong"
[[ "$(sed -n '2p' "$FAKE_GCS_ROOT/real-next-out/__next._index.txt/$flight_gen.meta")" == no-store ]] || fail "Flight index cache-control is wrong"
pass "Flight segment index has component MIME and no-store"

settings_gen="$(live_gen real-next-out settings.html)"
[[ -n "$settings_gen" ]] || fail "settings.html did not upload"
[[ "$(sed -n '1p' "$FAKE_GCS_ROOT/real-next-out/settings.html/$settings_gen.meta")" == 'text/html; charset=utf-8' ]] || fail "settings.html MIME is wrong"
[[ "$(sed -n '2p' "$FAKE_GCS_ROOT/real-next-out/settings.html/$settings_gen.meta")" == no-store ]] || fail "settings.html cache-control is wrong"
settings_segment_gen="$(live_gen real-next-out settings/__next.settings.__PAGE__.txt)"
[[ -n "$settings_segment_gen" ]] || fail "settings page segment did not upload"
[[ "$(sed -n '1p' "$FAKE_GCS_ROOT/real-next-out/settings/__next.settings.__PAGE__.txt/$settings_segment_gen.meta")" == text/x-component ]] || fail "settings page segment MIME is wrong"
pass "known Settings route uploads with HTML MIME, component segment MIME and no-store"

: >"$CALL_LOG"; OUTSIDE="$WORKDIR/outside-secret.txt"; echo 'sk-proj-THISISAFAKETAINTEDTOKEN1234567890' >"$OUTSIDE"
SYMLINK="$WORKDIR/symlink"; fixture "$SYMLINK" symlink; ln -s "$OUTSIDE" "$SYMLINK/evil"
out="$("$TARGET" "$SYMLINK" "$BUCKET" 2>&1)" && fail "symlink passed"
grep -q 'symlink found' <<<"$out" || fail "symlink was not rejected before static-export check: $out"
! grep -q 'check-static-export: ok' <<<"$out" || fail "static-export check ran before symlink rejection: $out"
! grep -q 'secret-shaped string' <<<"$out" || fail "static-export check read outside the trusted export: $out"
[[ ! -s "$CALL_LOG" ]] || fail "symlink made cloud call"
pass "symlink is rejected before secret scan or cloud calls"

: >"$CALL_LOG"; BAD="$WORKDIR/bad"; fixture "$BAD" bad; echo private >"$BAD/private.txt"
out="$("$TARGET" "$BAD" "$BUCKET" 2>&1)" && fail "unknown file passed"
grep -q 'unexpected path' <<<"$out" || fail "wrong unknown-file error: $out"
[[ ! -s "$CALL_LOG" ]] || fail "unknown file made cloud call"
pass "unknown private file rejected before cloud calls"

: >"$CALL_LOG"; UNKNOWN_ROUTE="$WORKDIR/unknown-route"; fixture "$UNKNOWN_ROUTE" unknown
mkdir -p "$UNKNOWN_ROUTE/apps/unlisted"
printf 'unlisted Flight index\n' >"$UNKNOWN_ROUTE/apps/unlisted/__next._index.txt"
out="$("$TARGET" "$UNKNOWN_ROUTE" "$BUCKET" 2>&1)" && fail "unlisted route Flight index passed"
grep -q 'unexpected path' <<<"$out" || fail "wrong unlisted-route error: $out"
[[ ! -s "$CALL_LOG" ]] || fail "unlisted route made cloud call"
pass "Flight index for an unknown route is rejected before cloud calls"

: >"$CALL_LOG"; UNKNOWN_SETTINGS="$WORKDIR/unknown-settings"; fixture "$UNKNOWN_SETTINGS" unknown-settings
printf 'not a real settings segment\n' >"$UNKNOWN_SETTINGS/settings/__next._unknown.txt"
out="$("$TARGET" "$UNKNOWN_SETTINGS" "$BUCKET" 2>&1)" && fail "unknown settings-like segment passed"
grep -q 'unexpected path' <<<"$out" || fail "wrong unknown-settings-segment error: $out"
[[ ! -s "$CALL_LOG" ]] || fail "unknown settings-like segment made cloud call"
pass "an unlisted settings-like file is rejected before cloud calls, not wildcarded"

: >"$CALL_LOG"; SETTINGS_ADMIN="$WORKDIR/settings-admin"; fixture "$SETTINGS_ADMIN" settings-admin
printf '<html>fake admin page</html>\n' >"$SETTINGS_ADMIN/settings-admin.html"
out="$("$TARGET" "$SETTINGS_ADMIN" "$BUCKET" 2>&1)" && fail "unlisted settings-admin.html passed"
grep -q 'unexpected path' <<<"$out" || fail "wrong settings-admin.html error: $out"
[[ ! -s "$CALL_LOG" ]] || fail "settings-admin.html made cloud call"
pass "an unlisted settings-prefixed file is rejected before cloud calls, not wildcarded"

: >"$CALL_LOG"; SECRET="$WORKDIR/secret"; fixture "$SECRET" secret; echo 'sk-proj-THISISAFAKETAINTEDTOKEN1234567890' >>"$SECRET/index.html"
"$TARGET" "$SECRET" "$BUCKET" >/dev/null 2>&1 && fail "secret passed"
[[ ! -s "$CALL_LOG" ]] || fail "secret made cloud call"
pass "secret rejected before cloud calls"

: >"$CALL_LOG"; BINARY_SECRET="$WORKDIR/binary-secret"; fixture "$BINARY_SECRET" binary
printf '\x89PNG\r\n\x1a\n\x00sk-proj-THISISAFAKETAINTEDTOKEN1234567890\xff' >"$BINARY_SECRET/favicon.ico"
"$TARGET" "$BINARY_SECRET" "$BUCKET" >/dev/null 2>&1 && fail "binary secret passed"
[[ ! -s "$CALL_LOG" ]] || fail "binary secret made cloud call"
pass "binary secret-shaped string is rejected before cloud calls"

: >"$CALL_LOG"
out="$(FAIL_DESCRIBE_OBJECT='index.html' "$TARGET" "$DSECOND" "$BUCKET" 2>&1)" && fail "per-object 403 describe passed"
grep -q 'not a confirmed 404' <<<"$out" || fail "per-object 403 was mistaken for a missing object: $out"
! grep -q 'storage cp' "$CALL_LOG" || fail "per-object 403 reached an upload before aborting: $(<"$CALL_LOG")"
pass "per-object 403 describe aborts before first upload"

D2="$WORKDIR/two"; fixture "$D2" new; echo 'new hash' >"$D2/_next/static/chunks/new-def456.js"
pre_index="$(live_gen "$BUCKET" index.html)"; pre_404="$(live_gen "$BUCKET" 404.html)"
out="$(FAIL_UPLOAD_OBJECT='_next/static/chunks/new-def456.js' "$TARGET" "$D2" "$BUCKET" 2>&1)" && fail "mid-upload failure passed"
[[ "$(live_gen "$BUCKET" index.html)" == "$pre_index" ]] || fail "index changed after mid-hashed/nonhashed failure"
[[ "$(live_gen "$BUCKET" 404.html)" == "$pre_404" ]] || fail "404 changed after failure"
[[ -z "$(live_gen "$BUCKET" _next/static/chunks/new-def456.js)" ]] || fail "new hash remained live"
[[ "$(grep -c 'rolling back' <<<"$out")" == 1 ]] || fail "rollback fired more than once"
pass "mid-hashed failure leaves old HTML and removes new hash exactly once"

: >"$CALL_LOG"; pre_unmutated="$(live_gen "$BUCKET" index.html)"
out="$(FAIL_UPLOAD_OBJECT='index.html' "$TARGET" "$D2" "$BUCKET" 2>&1)" && fail "unmutated index failure passed"
[[ "$(live_gen "$BUCKET" index.html)" == "$pre_unmutated" ]] || fail "unmutated index generation changed"
! grep -qF "index.html#$pre_unmutated" "$CALL_LOG" || fail "rollback restored unmutated index"
[[ "$(grep -c 'rolling back' <<<"$out")" == 1 ]] || fail "unmutated index rollback fired more than once"
pass "unmutated object keeps its live generation during rollback"

D3="$WORKDIR/three"; fixture "$D3" next; echo 'new hash after HTML' >"$D3/_next/static/chunks/new-post-html.js"
printf 'stale root object\n' >"$WORKDIR/stale.html"
gcloud storage cp --quiet --content-type='text/html; charset=utf-8' --cache-control=no-store "$WORKDIR/stale.html" "gs://$BUCKET/stale.html"
pre_stale="$(live_gen "$BUCKET" stale.html)"
pre_index_content="$(live_file "$BUCKET" index.html)"; pre_404_content="$(live_file "$BUCKET" 404.html)"; pre_app_content="$(live_file "$BUCKET" apps/tradingagents.html)"
out="$(FAIL_DELETE_OBJECT='stale.html' "$TARGET" "$D3" "$BUCKET" 2>&1)" && fail "stale-delete failure passed"
[[ "$(live_gen "$BUCKET" stale.html)" == "$pre_stale" ]] || fail "stale object changed after root cleanup failure"
cmp -s "$(live_file "$BUCKET" index.html)" "$pre_index_content" || fail "index not restored after post-HTML failure"
cmp -s "$(live_file "$BUCKET" 404.html)" "$pre_404_content" || fail "404 not restored after post-HTML failure"
cmp -s "$(live_file "$BUCKET" apps/tradingagents.html)" "$pre_app_content" || fail "app HTML not restored after post-HTML failure"
[[ -z "$(live_gen "$BUCKET" _next/static/chunks/new-post-html.js)" ]] || fail "new post-HTML hash remained live"
[[ -f "$FAKE_GCS_ROOT/$BUCKET/index.html/1.content" ]] || fail "rollback removed noncurrent index generation"
grep -q 'delete stale object failed' <<<"$out" || fail "missing stale-delete failure: $out"
pass "post-HTML stale cleanup failure restores index, 404, apps and new objects"

: >"$CALL_LOG"; before="$(live_gen "$BUCKET" index.html)"
out="$(FAIL_LIST=1 "$TARGET" "$D2" "$BUCKET" 2>&1)" && fail "permission error passed"
grep -q 'could not list remote objects' <<<"$out" || fail "wrong list error"
[[ "$(live_gen "$BUCKET" index.html)" == "$before" ]] || fail "permission error mutated live object"
pass "ambiguous permission error aborts before mutation"

echo "upload-hub-static.test: ok ($PASS/$PASS)"
