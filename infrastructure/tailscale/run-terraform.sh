#!/usr/bin/env bash
# Runs terraform for infrastructure/tailscale with credentials read from the
# Firestore group shared/tailscale. Nothing is exported in the caller's shell
# and no value is printed. The OAuth client secret exists only as a 0600 temp
# file for the life of the run; the provider reads it through its `file:` form.
# Usage: infrastructure/tailscale/run-terraform.sh <terraform args...>
#   e.g. run-terraform.sh init -backend-config="bucket=tobytran-portfolio-tfstate"
set -Eeuo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLI="$ROOT/common/config/family_config.py"
GROUP=shared/tailscale
die() { echo "run-terraform.sh: $*" >&2; exit 1; }

# Phase 1: re-run under with-file. with-file replaces only an argument that is
# exactly `{}`, so `env VAR=file:{}` would NOT be substituted; pass the path as
# its own argument instead (same pattern as gcp/family-config/install-reader-key.sh).
if [[ "${1:-}" != "--secret-file" ]]; then
  (($# > 0)) || die "usage: run-terraform.sh <terraform args...>"
  exec "$CLI" with-file "$GROUP" TAILSCALE_TF_OAUTH_CLIENT_SECRET -- "$0" --secret-file {} "$@"
fi
secret_file="$2"
shift 2

get() { "$CLI" get "$GROUP" "$1" || die "cannot read $1 from $GROUP"; }

TF_VAR_tailnet="$(get TAILSCALE_TAILNET)"
TF_VAR_tailscale_oauth_client_id="$(get TAILSCALE_TF_OAUTH_CLIENT_ID)"
TF_VAR_tailscale_oauth_client_secret="file:$secret_file"
[[ -n "$TF_VAR_tailnet" && -n "$TF_VAR_tailscale_oauth_client_id" && -s "$secret_file" ]] \
  || die "$GROUP has an empty TAILSCALE_TAILNET, TAILSCALE_TF_OAUTH_CLIENT_ID or TAILSCALE_TF_OAUTH_CLIENT_SECRET"

# The GCS state backend must use the personal account, never the operator's
# default gcloud configuration (a work account).
if [[ -z "${GOOGLE_OAUTH_ACCESS_TOKEN:-}" ]]; then
  GOOGLE_OAUTH_ACCESS_TOKEN="$(gcloud auth print-access-token --configuration="${FAMILY_CONFIG_GCLOUD_CONFIG:-personal}")" \
    || die "gcloud could not provide a personal access token"
fi

export TF_VAR_tailnet TF_VAR_tailscale_oauth_client_id TF_VAR_tailscale_oauth_client_secret GOOGLE_OAUTH_ACCESS_TOKEN
exec terraform "$@"
