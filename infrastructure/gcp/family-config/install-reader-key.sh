#!/usr/bin/env bash
# Installs or rotates the host key for family-config-reader at
# /etc/family-app/config-reader.json. The new key streams from gcloud straight
# into the host and never touches the local disk. Older keys are deleted only
# after the host reads Firestore with the new one.
# Usage: infrastructure/gcp/family-config/install-reader-key.sh [--profile shared/<group>] [--keep-existing]
#   --profile GROUP    Firestore group holding the host's VPS_HOST, VPS_PORT, VPS_USER,
#                      VPS_SSH_KNOWN_HOSTS and VPS_OPERATOR_SSH_PRIVATE_KEY.
#                      Default shared/vps; use shared/laptop for the laptop.
#   --keep-existing    Delete no older key after the new one is verified. Use it to
#                      add a second host's key without revoking the first host's.
set -Eeuo pipefail
umask 077

PROFILE=shared/vps
KEEP_EXISTING=0
SSH_KEY=""

# parse_args ARGS...: sets PROFILE, KEEP_EXISTING and SSH_KEY (the internal re-exec argument).
parse_args() {
  while (($#)); do
    case "$1" in
      --profile)
        [[ $# -ge 2 ]] || { echo "install-reader-key: --profile needs a value" >&2; return 2; }
        PROFILE="$2"
        shift 2
        ;;
      --keep-existing)
        KEEP_EXISTING=1
        shift
        ;;
      --ssh-key)
        [[ $# -ge 2 ]] || { echo "install-reader-key: --ssh-key needs a value" >&2; return 2; }
        SSH_KEY="$2"
        shift 2
        ;;
      *)
        echo "install-reader-key: unknown argument: $1" >&2
        return 2
        ;;
    esac
  done
  [[ "$PROFILE" =~ ^shared/[a-z0-9][a-z0-9-]*$ ]] || {
    echo "install-reader-key: --profile must look like shared/<group>, got: $PROFILE" >&2
    return 2
  }
}

main() {
  local ROOT CLI PROJECT CONFIGURATION READER_EMAIL REMOTE_KEY
  ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
  CLI="$ROOT/common/config/family_config.py"
  PROJECT="${FAMILY_CONFIG_PROJECT:-tobytran-portfolio}"
  CONFIGURATION="${FAMILY_CONFIG_GCLOUD_CONFIG:-personal}"
  READER_EMAIL="family-config-reader@$PROJECT.iam.gserviceaccount.com"
  REMOTE_KEY=/etc/family-app/config-reader.json

  parse_args "$@" || exit 2

  # Re-run under with-file so the operator SSH key exists only as a temp file.
  if [[ -z "$SSH_KEY" ]]; then
    local reexec=(--profile "$PROFILE")
    ((KEEP_EXISTING)) && reexec+=(--keep-existing)
    exec "$CLI" with-file "$PROFILE" VPS_OPERATOR_SSH_PRIVATE_KEY -- "$0" "${reexec[@]}" --ssh-key {}
  fi

  local work host port user target old_keys key_id verified attempt remote_dir
  local common_opts ssh_opts scp_opts
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' EXIT
  host="$("$CLI" get "$PROFILE" VPS_HOST)"
  port="$("$CLI" get "$PROFILE" VPS_PORT)"
  user="$("$CLI" get "$PROFILE" VPS_USER)"
  "$CLI" get "$PROFILE" VPS_SSH_KNOWN_HOSTS >"$work/known_hosts"
  common_opts=(-i "$SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o UserKnownHostsFile="$work/known_hosts" -o StrictHostKeyChecking=yes)
  ssh_opts=("${common_opts[@]}" -p "$port")
  scp_opts=("${common_opts[@]}" -P "$port")
  target="$user@$host"
  g() { gcloud --configuration="$CONFIGURATION" --project="$PROJECT" "$@"; }

  old_keys="$(g iam service-accounts keys list --iam-account="$READER_EMAIL" --managed-by=user --format='value(name.basename())')"

  g iam service-accounts keys create /dev/stdout --iam-account="$READER_EMAIL" |
    ssh "${ssh_opts[@]}" "$target" \
      "sudo sh -c 'umask 077 && install -d -m 0755 /etc/family-app && cat > /etc/family-app/.config-reader.json.new && mv -f /etc/family-app/.config-reader.json.new $REMOTE_KEY'"
  echo "installed new reader key at $host:$REMOTE_KEY"

  remote_dir="/tmp/family-config-verify-$$"
  ssh "${ssh_opts[@]}" "$target" "install -d -m 0700 $remote_dir"
  scp "${scp_opts[@]}" "$CLI" "$target:$remote_dir/family_config.py"
  # A brand-new key can take a few seconds before Google accepts it.
  verified=0
  for attempt in 1 2 3 4 5 6; do
    if ssh "${ssh_opts[@]}" "$target" \
      "sudo env FAMILY_CONFIG_CREDENTIALS=$REMOTE_KEY python3 $remote_dir/family_config.py keys expense-tax-management/production >/dev/null"; then
      verified=1
      break
    fi
    ((attempt < 6)) && sleep 10
  done
  ssh "${ssh_opts[@]}" "$target" "rm -rf $remote_dir" || true
  ((verified == 1)) || { echo "the host could not read Firestore with the new key; older keys were kept" >&2; exit 1; }
  echo "verified Firestore reads on $host with the new key"

  if ((KEEP_EXISTING)); then
    echo "--keep-existing: older reader keys were not deleted"
    return 0
  fi
  for key_id in $old_keys; do
    g iam service-accounts keys delete "$key_id" --iam-account="$READER_EMAIL" --quiet
    echo "deleted old reader key $key_id"
  done
}

# Sourced (by test-install-reader-key.sh) only defines the functions above.
[[ "${BASH_SOURCE[0]}" != "$0" ]] || main "$@"
