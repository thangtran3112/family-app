#!/usr/bin/env bash
set -euo pipefail
umask 077

PROJECT_ID="expense-tax-tobytran-2026"
SERVICE_ACCOUNT_ID="expense-tax-cf-terraform"
POOL_ID="expense-tax-github"
PROVIDER_ID="cloudflare"
REPOSITORY="thangtran3112/family-app"
WORKFLOW_REF="thangtran3112/family-app/.github/workflows/expense-tax-cloudflare.yml@refs/heads/main"
WIF_ATTRIBUTE_CONDITION="assertion.repository=='${REPOSITORY}' && assertion.ref=='refs/heads/main' && assertion.workflow_ref=='${WORKFLOW_REF}' && assertion.environment=='production'"

command -v gcloud >/dev/null || { echo "gcloud is required" >&2; exit 1; }

if ! gcloud iam service-accounts describe \
  "${SERVICE_ACCOUNT_ID}@${PROJECT_ID}.iam.gserviceaccount.com" \
  --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$SERVICE_ACCOUNT_ID" \
    --project="$PROJECT_ID" \
    --display-name="Expense Tax Cloudflare Terraform"
else
  echo "service account already exists: $SERVICE_ACCOUNT_ID"
fi

if ! gcloud iam workload-identity-pools describe "$POOL_ID" \
  --project="$PROJECT_ID" --location=global >/dev/null 2>&1; then
  gcloud iam workload-identity-pools create "$POOL_ID" \
    --project="$PROJECT_ID" --location=global \
    --display-name="Expense Tax GitHub Actions"
fi

if ! gcloud iam workload-identity-pools providers describe "$PROVIDER_ID" \
  --project="$PROJECT_ID" --location=global --workload-identity-pool="$POOL_ID" \
  >/dev/null 2>&1; then
  gcloud iam workload-identity-pools providers create-oidc "$PROVIDER_ID" \
    --project="$PROJECT_ID" --location=global --workload-identity-pool="$POOL_ID" \
    --display-name="Expense Tax CF Terraform" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref,attribute.workflow_ref=assertion.workflow_ref,attribute.environment=assertion.environment" \
    --attribute-condition="$WIF_ATTRIBUTE_CONDITION"
else
  gcloud iam workload-identity-pools providers update-oidc "$PROVIDER_ID" \
    --project="$PROJECT_ID" --location=global --workload-identity-pool="$POOL_ID" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref,attribute.workflow_ref=assertion.workflow_ref,attribute.environment=assertion.environment" \
    --attribute-condition="$WIF_ATTRIBUTE_CONDITION"
fi

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
SERVICE_ACCOUNT_EMAIL="${SERVICE_ACCOUNT_ID}@${PROJECT_ID}.iam.gserviceaccount.com"
PRINCIPAL_SET="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/attribute.repository/${REPOSITORY}"

gcloud iam service-accounts add-iam-policy-binding "$SERVICE_ACCOUNT_EMAIL" \
  --project="$PROJECT_ID" \
  --role="roles/iam.workloadIdentityUser" \
  --member="$PRINCIPAL_SET"

echo "Cloudflare Terraform identity ready: ${SERVICE_ACCOUNT_EMAIL}"
echo "Set GCP_CLOUDFLARE_WORKLOAD_IDENTITY_PROVIDER to projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/providers/${PROVIDER_ID}"
echo "Set GCP_CLOUDFLARE_SERVICE_ACCOUNT to ${SERVICE_ACCOUNT_EMAIL}"
echo "Run bootstrap-state.sh separately to grant this identity state-bucket object access."
