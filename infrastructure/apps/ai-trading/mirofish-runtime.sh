#!/usr/bin/env bash
# Shared MiroFish Firestore-profile rendering/validation/install library
# (Task 2, app-controls): extracted unchanged from production/deploy.sh so
# both deploy.sh (the full deploy pipeline) and the standalone
# production/prepare-mirofish.sh (used by control/runtime.py's
# Runtime.prepare_mirofish() to render credentials outside a full redeploy,
# when an operator turns MiroFish on from the Settings switch) share one
# checked render/validate/backup/self-heal implementation. Never sourced on
# its own: the caller must already define `compose()` (its own fixed
# Compose wrapper -- deploy.sh's and prepare-mirofish.sh's differ only in
# which project/images.env they point at) and
# `stop_remove_mirofish_container()` (deploy.sh's does a best-effort
# `compose rm -s -f mirofish`; prepare-mirofish.sh's own version below
# instead maps to `compose stop` only -- this script must never remove a
# container, per the controls runtime's own no-removal contract) before
# calling activate_mirofish/restore_or_remove_mirofish. Bash resolves a
# function name at call time, not at source time, so it does not matter
# that those two functions are defined by the *caller*, not here.
#
# No real Firestore, Docker, or VPS credential is used by this file itself;
# it only defines functions. infrastructure/apps/ai-trading/tests/test-deploy-firestore.sh
# copies this file's content ahead of deploy.sh's own sourced functions for
# its offline fixtures (see that file's source_lib()).

MIROFISH_REQUIRED_KEYS=(ZEP_API_KEY LLM_API_KEY)
# Prior/new-state tracking for mirofish.env, mirrors PRIOR_EXISTED/.previous/
# in deploy.sh but for the one optional MiroFish runtime file: MIROFISH_INSTALLED_THIS_RUN
# is only ever 1 between a successful install and either activate_mirofish's
# own post-install checks or restore_or_remove_mirofish() consuming it (both
# reset it to 0), so a later, unrelated pipeline failure's rollback() never
# redoes work activate_mirofish already finished or already self-healed.
MIROFISH_RUNTIME_ENV_FILE=""
MIROFISH_PRIOR_EXISTED=0
MIROFISH_INSTALLED_THIS_RUN=0

# install_secret_file SRC DEST: writes DEST atomically (a root:root 0600 temp
# file on DEST's filesystem, then `mv -f` over DEST) so a reader never sees a
# partially-written file and a failure never leaves DEST truncated. Used by
# deploy.sh for its own five/seven SECRET_FILES as well as by
# activate_mirofish/restore_or_remove_mirofish below -- kept here so this
# library is self-contained for prepare-mirofish.sh, which has no other
# source of this helper.
install_secret_file() {
  local src="$1" dest="$2" tmp
  tmp="$(mktemp "$(dirname "$dest")/.$(basename "$dest").XXXXXX")"
  if [[ -n "${DEPLOY_SH_SKIP_CHOWN:-}" ]]; then
    install -m 0600 "$src" "$tmp"
  else
    install -o root -g root -m 0600 "$src" "$tmp"
  fi
  mv -f "$tmp" "$dest"
}

# mirofish_env_valid FILE: soft (non-dying) sibling of validate_staged_file,
# for the optional MiroFish profile only. A malformed or incomplete
# ai-trading/mirofish profile must leave MiroFish disabled, never abort the
# whole deploy -- so this returns 1 instead of calling die(). Checks the
# same NUL/CR/KEY=value shape as validate_staged_file, plus presence of
# every MIROFISH_REQUIRED_KEYS name (never echoes a value).
mirofish_env_valid() {
  local file="$1" line key
  [[ -f "$file" ]] || return 1
  cmp -s <(LC_ALL=C tr -d '\000' <"$file") "$file" || return 1
  if LC_ALL=C grep -q $'\r' "$file"; then
    return 1
  fi
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == '#'* ]] && continue
    [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*=.+$ ]] || return 1
  done <"$file"
  for key in "${MIROFISH_REQUIRED_KEYS[@]}"; do
    grep -q "^${key}=.\+$" "$file" || return 1
  done
}

# file_mode_octal FILE: this file's permission bits as a 3-digit octal
# string (e.g. "600"), GNU stat first (the real VPS), BSD/macOS stat as a
# fallback (this repo's own offline tests).
file_mode_octal() {
  stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null
}

# cleanup_mirofish_scratch DIR: removes activate_mirofish's one-shot render
# scratch directory, which may still contain the rendered ai-trading/mirofish
# profile's plaintext values (review P2, round 3: a bare, unchecked `rm -rf`
# here could fail silently and leave that secret-bearing directory sitting
# on disk even on an otherwise fully successful activation). Explicitly
# checked everywhere it's used: a failure on an already-failing path just
# gets an extra path-only warning logged (the activation is being aborted
# either way); a failure on the post-install-success path is escalated by
# the caller into a hard activation failure instead of silently exporting
# COMPOSE_PROFILES over a leftover copy of the rendered secret. Never prints
# a key's value, only the scratch directory's own path.
cleanup_mirofish_scratch() {
  if ! rm -rf "$1"; then
    echo "deploy: mirofish: failed to remove render scratch $1; it may still contain the rendered profile's values on disk" >&2
    return 1
  fi
}

# restore_or_remove_mirofish: undoes activate_mirofish's one mutation this
# run -- the mirofish.env it just installed -- the same prior/new-state
# discipline restore_or_remove_secrets already applies to the five
# SECRET_FILES. A no-op unless this run actually installed a new
# mirofish.env (MIROFISH_INSTALLED_THIS_RUN); resets that flag immediately
# so a second call (activate_mirofish's own post-install self-heal, then
# later rollback() for an unrelated later failure) never re-applies it
# twice. PRIOR_EXISTED=1 restores the pre-run backup and keeps
# COMPOSE_PROFILES=mirofish (the previous good deploy had MiroFish active,
# so a rollback to it should too); PRIOR_EXISTED=0 deletes the file this run
# created and unsets COMPOSE_PROFILES (MiroFish was never active before
# this run, so nothing should start it).
#
# Every restore/delete step is explicitly checked (review P2): a missing
# backup, a failed install_secret_file, or a failed rm is never silently
# ignored. On any such failure this returns 1 and -- the safe default when
# the on-disk state can no longer be confirmed -- always unsets
# COMPOSE_PROFILES rather than risk re-enabling MiroFish against a file
# that was never actually restored. Never prints a key's value, only paths.
#
# Review P2, round 3: when restore/delete itself fails, a container this
# same deploy already started (a successful `compose up` before a later
# health-check/post-Compose failure triggered rollback) would otherwise
# keep running with no corresponding mirofish.env and no COMPOSE_PROFILES
# -- "MiroFish left disabled" in the log, but not in reality. Each of these
# three failure branches also makes a best-effort
# stop_remove_mirofish_container call (the CALLER's own definition -- bash
# resolves it at call time, so deploy.sh's stop+remove and
# prepare-mirofish.sh's stop-only each get their own caller's semantics
# here); its own result is logged by that function and never changes this
# function's outcome (already returning 1 either way) -- this is defense in
# depth on top of the file-state fix, not a replacement for it.
restore_or_remove_mirofish() {
  [[ "$MIROFISH_INSTALLED_THIS_RUN" == 1 ]] || return 0
  MIROFISH_INSTALLED_THIS_RUN=0
  if [[ "$MIROFISH_PRIOR_EXISTED" == 1 ]]; then
    if [[ ! -f "$RUNTIME_ENV_DIR/.previous/mirofish.env" ]]; then
      echo "deploy: mirofish: rollback: missing backup $RUNTIME_ENV_DIR/.previous/mirofish.env; cannot restore, leaving MiroFish disabled" >&2
      unset COMPOSE_PROFILES
      stop_remove_mirofish_container || true
      return 1
    fi
    if ! install_secret_file "$RUNTIME_ENV_DIR/.previous/mirofish.env" "$MIROFISH_RUNTIME_ENV_FILE"; then
      echo "deploy: mirofish: rollback: failed to restore $MIROFISH_RUNTIME_ENV_FILE from backup; leaving MiroFish disabled" >&2
      unset COMPOSE_PROFILES
      stop_remove_mirofish_container || true
      return 1
    fi
    export COMPOSE_PROFILES=mirofish
  else
    if ! rm -f "$MIROFISH_RUNTIME_ENV_FILE"; then
      echo "deploy: mirofish: rollback: failed to remove $MIROFISH_RUNTIME_ENV_FILE; leaving MiroFish disabled" >&2
      unset COMPOSE_PROFILES
      stop_remove_mirofish_container || true
      return 1
    fi
    unset COMPOSE_PROFILES
    # Whole-branch review reopen: this run's own activate_mirofish may have
    # already started a mirofish container (a successful `compose up`
    # before some later, unrelated failure triggered this rollback) --
    # removing mirofish.env alone doesn't stop it. Best-effort here,
    # consistent with the three failure branches above and with rollback()'s
    # own established "report, never block the rest of recovery" discipline
    # -- the forward path's hard-fail gate is ensure_mirofish_stopped(),
    # not this recovery path.
    stop_remove_mirofish_container || true
  fi
}

# activate_mirofish: operator opt-in (MIROFISH_ACTIVATE=1, or =keep while a
# mirofish container is already running). Renders the
# optional ai-trading/mirofish Firestore profile into a root-only scratch
# directory, validates it holds every MIROFISH_REQUIRED_KEYS name (never
# printing a value), backs up any mirofish.env this install is about to
# replace (so a later failure elsewhere in this deploy can roll it back,
# same as the five SECRET_FILES), and only on a *confirmed* install --
# required keys present and mode exactly 0600, re-checked against the
# installed file itself, not just the scratch copy -- exports
# COMPOSE_PROFILES=mirofish so deploy_tag's `compose up` actually starts the
# service.
#
# Every step below is its own explicit `if ! cmd; then ...; return 1; fi` (or
# equivalent) -- this function is always called as `activate_mirofish ||
# true` from main flow (a deliberate soft-failure contract: a failed/absent
# MiroFish activation must never fail the other three apps' deploy), and
# bash's errexit does not propagate out of *any* command run while
# evaluating the left side of a `||` list, including every command inside a
# function called that way. Relying on `set -e` here would mean a silently
# failed install could still fall through to exporting COMPOSE_PROFILES --
# never let that happen; every required step checks its own exit status.
#
# The very first thing this does, unconditionally, is unset any inherited
# COMPOSE_PROFILES (a parent shell/CI export, or a stale value left over
# from nothing at all in this process) so a prior run's activation -- or an
# operator's leftover export -- can never bypass this run's own decision;
# only a confirmed-good activation below ever re-sets it.
#
# Depends on the CALLER defining `compose()` (its own fixed project/image
# wrapper) and `$APP_DIR`/`$RUNTIME_ENV_DIR` -- deploy.sh and
# prepare-mirofish.sh each set these up before sourcing this file.
activate_mirofish() {
  unset COMPOSE_PROFILES
  case "${MIROFISH_ACTIVATE:-}" in
    1) ;;
    keep)
      [[ -n "$(compose ps -q --status running mirofish 2>/dev/null)" ]] || return 0
      echo "deploy: mirofish: running; keeping it enabled for this deploy" >&2
      ;;
    *) return 0 ;;
  esac
  local family_config="$APP_DIR/family_config.py" scratch
  if [[ ! -x "$family_config" ]]; then
    echo "deploy: mirofish: missing $family_config; leaving MiroFish disabled" >&2
    return 1
  fi
  if ! install -d -m 0700 "$RUNTIME_ENV_DIR"; then
    echo "deploy: mirofish: failed to create $RUNTIME_ENV_DIR; leaving MiroFish disabled" >&2
    return 1
  fi
  if ! scratch="$(mktemp -d "$RUNTIME_ENV_DIR/.mirofish-render-XXXXXX")"; then
    echo "deploy: mirofish: failed to create a render scratch directory; leaving MiroFish disabled" >&2
    return 1
  fi
  if ! FAMILY_CONFIG_CREDENTIALS="${FAMILY_CONFIG_CREDENTIALS:-/etc/family-app/config-reader.json}" \
       "$family_config" render ai-trading/mirofish --out-dir "$scratch"; then
    cleanup_mirofish_scratch "$scratch"
    echo "deploy: mirofish: render of ai-trading/mirofish failed; leaving MiroFish disabled" >&2
    return 1
  fi
  if ! mirofish_env_valid "$scratch/mirofish.env"; then
    cleanup_mirofish_scratch "$scratch"
    echo "deploy: mirofish: ai-trading/mirofish profile missing a required key (${MIROFISH_REQUIRED_KEYS[*]}) or malformed; leaving MiroFish disabled" >&2
    return 1
  fi

  MIROFISH_RUNTIME_ENV_FILE="$RUNTIME_ENV_DIR/mirofish.env"
  if [[ -f "$MIROFISH_RUNTIME_ENV_FILE" ]]; then
    if ! install -d -m 0700 "$RUNTIME_ENV_DIR/.previous" || ! cp -p "$MIROFISH_RUNTIME_ENV_FILE" "$RUNTIME_ENV_DIR/.previous/mirofish.env"; then
      cleanup_mirofish_scratch "$scratch"
      echo "deploy: mirofish: failed to back up the existing mirofish.env; leaving MiroFish disabled" >&2
      return 1
    fi
    MIROFISH_PRIOR_EXISTED=1
  else
    MIROFISH_PRIOR_EXISTED=0
  fi

  if ! install_secret_file "$scratch/mirofish.env" "$MIROFISH_RUNTIME_ENV_FILE"; then
    cleanup_mirofish_scratch "$scratch"
    echo "deploy: mirofish: failed to install $MIROFISH_RUNTIME_ENV_FILE; leaving MiroFish disabled" >&2
    return 1
  fi
  MIROFISH_INSTALLED_THIS_RUN=1

  # test-only: see deploy.sh's header doc. Lets test-deploy-firestore.sh force
  # the cleanup immediately below to fail for real (a genuine permission-denied
  # rm), without needing a separate hand-rolled timing hack in the test
  # file. Never set this in production.
  [[ -n "${DEPLOY_SH_MIROFISH_CHMOD_SCRATCH_AFTER_INSTALL:-}" ]] && chmod "$DEPLOY_SH_MIROFISH_CHMOD_SCRATCH_AFTER_INSTALL" "$scratch"

  # Unlike every cleanup above (already aborting this activation regardless
  # of whether cleanup itself also succeeds), this one guards a file that
  # just got marked as successfully installed: a failed cleanup here must
  # not silently fall through to exporting COMPOSE_PROFILES over a leftover
  # scratch copy of the rendered secret (review P2, round 3) -- escalate it
  # into a full activation failure and self-heal (restore the prior file,
  # or remove what was just written) exactly like the two post-install
  # validation checks right below.
  if ! cleanup_mirofish_scratch "$scratch"; then
    echo "deploy: mirofish: post-install cleanup failed; leaving MiroFish disabled" >&2
    restore_or_remove_mirofish
    return 1
  fi

  # Confirm the actual installed file -- not just the scratch copy -- before
  # enabling anything. A failure here self-heals immediately (restores the
  # prior file, or removes what was just written) rather than leaving a
  # known-bad file for some later, unrelated failure's rollback to find.
  if ! mirofish_env_valid "$MIROFISH_RUNTIME_ENV_FILE"; then
    echo "deploy: mirofish: installed mirofish.env failed post-install validation; leaving MiroFish disabled" >&2
    restore_or_remove_mirofish
    return 1
  fi
  if [[ "$(file_mode_octal "$MIROFISH_RUNTIME_ENV_FILE")" != 600 ]]; then
    echo "deploy: mirofish: installed mirofish.env is not mode 600; leaving MiroFish disabled" >&2
    restore_or_remove_mirofish
    return 1
  fi

  export COMPOSE_PROFILES=mirofish
  echo "deploy: mirofish: ai-trading/mirofish profile rendered; MiroFish enabled for this deploy" >&2
}
