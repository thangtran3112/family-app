# Backup Bucket and Identities (Task 1)

Terraform for the dedicated GCS backup bucket and its two identities. Full
design: [`vps-backup-and-restore.md`](../../expense-tax-management/plans/sub-plans/vps-backup-and-restore.md) Task 1.

**This directory's Terraform is never applied by an agent.** Only
`terraform fmt -check`, `terraform init -backend=false`, `terraform
validate`, and `test-policy.sh` run automatically; `terraform plan`/`apply`
require a human operator with explicit approval, run from their own
machine with real GCP credentials.

## What this provisions

- One bucket (`google_storage_bucket.backup`): uniform bucket-level access,
  enforced public-access prevention, versioning, a **locked** 7-day
  retention policy, and two lifecycle rules (`daily/` expires at 30 days,
  `monthly/` at 365 days).
- A **writer** identity (`backup_writer`) with `roles/storage.objectCreator`
  on this bucket, plus a get-only custom role (`expenseTaxBackupObjectGetter`:
  bucket metadata, object names, and one object by name). `gcloud storage cp`
  checks the bucket, the destination prefix, and the destination object before
  it uploads, so creation alone fails (found on the first production run,
  2026-10-12). The writer still cannot replace or delete objects.
- A **freshness-monitor** identity (`backup_freshness_monitor`), entirely
  separate from the writer, authenticated via its own GitHub Actions
  OIDC/WIF provider (reusing the existing `expense-tax-github` pool from
  `infrastructure/gcp/expense-tax/bootstrap.sh`,
  but with its own attribute-condition-scoped provider -- that pool's
  existing `github` provider is hard-scoped to the deploy workflow and
  would reject this one's tokens). It holds a custom, list-only IAM role
  (`storage.objects.list` only -- explicitly **not**
  `storage.objects.get`), so it can check "does a recent object exist"
  without ever being able to read or download backup content.

## What this deliberately does NOT provision

- **No writer key.** `google_service_account_key` never appears in this
  module (enforced by `test-policy.sh`). The writer's JSON key is created once
  through the IAM API, outside Terraform state, and stored centrally in
  Firestore `family-config` profile group `shared/vps-backup`
  (`BACKUP_WRITER_KEY_JSON`), next to the age identity (`BACKUP_AGE_IDENTITY`)
  and recipient (`BACKUP_AGE_RECIPIENT`). Key creation needs the project
  override below. VPS bootstrap streams the key to a root-only, mode-0400 file
  (`infrastructure/host/bootstrap.sh --only backup`); it is never re-derived
  from Terraform.

  ```bash
  curl -s -X POST -H "Authorization: Bearer $(gcloud auth print-access-token)" \
    -H 'Content-Type: application/json' -d '{"privateKeyType":"TYPE_GOOGLE_CREDENTIALS_FILE"}' \
    "https://iam.googleapis.com/v1/projects/-/serviceAccounts/<writer-email>/keys" \
    | jq -r .privateKeyData | base64 -D \
    | python3 common/config/family_config.py set shared/vps-backup BACKUP_WRITER_KEY_JSON
  ```

## Project override and bootstrap grant (outside Terraform)

The organization enforces `iam.disableServiceAccountKeyCreation`. The module
adds a project-level exception for this project only
(`google_org_policy_policy.backup_allow_sa_key_creation`; other projects stay
enforced). Org policy permissions cannot be bound at project level, so the
operator grants them once, at the organization, before the first apply:

```bash
gcloud organizations add-iam-policy-binding <ORG_ID> \
  --member="user:<operator-email>" --role=roles/orgpolicy.policyAdmin --condition=None
```

Organization Admin already allows granting that role, so this adds no reach
beyond what the operator holds.

- **No persistent VPS-side reader key.** Restore does not use a
  long-lived "reader" service account key kept anywhere. Instead, an
  operator temporarily grants their own restore identity object-level read
  access immediately before a restore drill, and revokes it immediately
  after:

  ```bash
  # Before restoring (operator's own gcloud user, or a short-lived SA):
  gcloud storage buckets add-iam-policy-binding gs://expense-tax-tobytran-2026-backups \
    --member="user:operator@example.com" --role="roles/storage.objectViewer" \
    --condition=None

  # restore.sh runs with that operator's ADC/credentials as
  # RESTORE_GOOGLE_APPLICATION_CREDENTIALS (see infrastructure/backup/README.md)

  # Immediately after:
  gcloud storage buckets remove-iam-policy-binding gs://expense-tax-tobytran-2026-backups \
    --member="user:operator@example.com" --role="roles/storage.objectViewer"
  ```

  This keeps "who can currently read backup content" at zero outside an
  active, deliberate restore window.

## Required variables (no defaults)

Fix round 1 (Important #6): `project_id`, `bucket_name`,
`github_repository`, and `wif_pool_id` have **no default** -- each names
a real, project-specific resource, and a default would let an
unparameterized `terraform apply` silently target production.
`terraform validate` (which this repo runs automatically) does not need
concrete values; `plan`/`apply` (operator-only, explicit approval
required) do. Supply them via an **untracked** tfvars file:

```bash
# infrastructure/gcp/backup/terraform.tfvars (gitignored -- see **/.terraform/
# and this directory's own entry if one is added; never commit this file)
project_id        = "expense-tax-tobytran-2026"
bucket_name       = "expense-tax-tobytran-2026-backups"
github_repository = "thangtran3112/family-app"
wif_pool_id       = "expense-tax-github"
```

or pass each as `-var`. `region`/`location`/`freshness_workflow_file`/
`freshness_workflow_ref` keep sensible generic defaults since they do not
themselves identify a specific project, bucket, or repository.

## Commands actually run (by this implementation, and by CI)

```bash
docker run --rm -v "$PWD:/work" -w /work hashicorp/terraform:1.9 fmt -check
docker run --rm -v "$PWD:/work" -w /work hashicorp/terraform:1.9 init -backend=false
docker run --rm -v "$PWD:/work" -w /work hashicorp/terraform:1.9 validate
bash test-policy.sh
```

Operator plan and apply (after approval) use the same pinned image with the
personal gcloud token: `CLOUDSDK_ACTIVE_CONFIG_NAME=personal` and
`GOOGLE_OAUTH_ACCESS_TOKEN="$(gcloud auth print-access-token)"`, passing the
four required variables with `-var`. Colima shares only `$HOME` into its VM,
so keep plan files under `.terraform/` in this directory, not under `$TMPDIR`.

`terraform` is not installed on every contributor machine; the pinned
`hashicorp/terraform:1.9` image is used instead of a global install, per
this repo's tooling policy.
