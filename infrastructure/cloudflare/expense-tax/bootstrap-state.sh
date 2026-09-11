#!/usr/bin/env bash
set -euo pipefail

BUCKET="expense-tax-tobytran-2026-tfstate"
DEPLOY_SERVICE_ACCOUNT="expense-tax-github-deploy@expense-tax-tobytran-2026.iam.gserviceaccount.com"

command -v gcloud >/dev/null || { echo "gcloud is required" >&2; exit 1; }

if ! gcloud storage buckets describe "gs://${BUCKET}" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://${BUCKET}" \
    --project=expense-tax-tobytran-2026 \
    --location=us \
    --uniform-bucket-level-access
else
  echo "state bucket already exists: ${BUCKET}"
fi

gcloud storage buckets update "gs://${BUCKET}" --versioning
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --member="serviceAccount:${DEPLOY_SERVICE_ACCOUNT}" \
  --role="roles/storage.objectAdmin"

echo "state bucket ready: gs://${BUCKET}"
