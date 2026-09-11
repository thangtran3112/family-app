#!/usr/bin/env bash
set -euo pipefail

BUCKET="expense-tax-tobytran-2026-tfstate"
PROJECT_ID="expense-tax-tobytran-2026"
APP_DEPLOY_SERVICE_ACCOUNT_EMAIL="expense-tax-github-deploy@expense-tax-tobytran-2026.iam.gserviceaccount.com"
CLOUDFLARE_TERRAFORM_SERVICE_ACCOUNT="expense-tax-cf-terraform@expense-tax-tobytran-2026.iam.gserviceaccount.com"
TEMP_DIR="$(mktemp -d)"
LIFECYCLE_FILE="${TEMP_DIR}/lifecycle.json"

cleanup() {
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

command -v gcloud >/dev/null || { echo "gcloud is required" >&2; exit 1; }

if ! gcloud storage buckets describe "gs://${BUCKET}" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://${BUCKET}" \
    --project="$PROJECT_ID" \
    --location=us \
    --uniform-bucket-level-access
else
  echo "state bucket already exists: ${BUCKET}"
fi

EXPECTED_PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
verify_bucket_project() {
  local bucket_project_number
  bucket_project_number="$(gcloud storage buckets describe "gs://${BUCKET}" --format='value(projectNumber)')"
  [[ -n "$bucket_project_number" && "$bucket_project_number" == "$EXPECTED_PROJECT_NUMBER" ]] || {
    echo "state bucket belongs to unexpected GCP project: ${BUCKET}" >&2
    exit 1
  }
}

verify_bucket_project

cat > "$LIFECYCLE_FILE" <<'JSON'
{
  "rule": [
    {
      "action": {"type": "Delete"},
      "condition": {
        "isLive": false,
        "daysSinceNoncurrentTime": 30
      }
    }
  ]
}
JSON

gcloud storage buckets update "gs://${BUCKET}" --versioning
gcloud storage buckets update "gs://${BUCKET}" --lifecycle-file="$LIFECYCLE_FILE"
gcloud storage buckets remove-iam-policy-binding "gs://${BUCKET}" \
  --member="serviceAccount:${APP_DEPLOY_SERVICE_ACCOUNT_EMAIL}" \
  --role="roles/storage.objectAdmin" >/dev/null 2>&1 || true
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --member="serviceAccount:${CLOUDFLARE_TERRAFORM_SERVICE_ACCOUNT}" \
  --role="roles/storage.objectAdmin"

echo "state bucket ready: gs://${BUCKET}"
