# Remediation plan

Run every `gcloud` command with `CLOUDSDK_ACTIVE_CONFIG_NAME=personal`. `P=tobytran-portfolio`. Before each destructive step, read the target (list it) and confirm it is the right one. Never print a key string. Decisions referenced as D1 to D4 are in `README.md`.

## Phase 0: verify family-app after reinstatement (read-only)

1. Confirm the project and accounts: `gcloud projects describe $P --format='value(lifecycleState)'` is `ACTIVE`; `gcloud iam service-accounts list --project=$P --format='table(email.basename("@"),disabled)'` shows `False` everywhere.
2. Owner laptop read of the config store: `common/config/family_config.py keys expense-tax-management/production` succeeds.
3. VPS read with the reader key: run the same command on the VPS with `FAMILY_CONFIG_CREDENTIALS=/etc/family-app/config-reader.json` (as `install-reader-key.sh` does for its verify step). If it fails with a token error, the key may have been invalidated by the suspension; go to Phase 3 and rotate.
4. Re-run the last failed `ai-trading` and `expense-tax` deploy workflow dispatches only if they failed during the suspension. Do not push just to test (Actions minutes, AGENTS.md).
5. Check the Cloud Function `contact` still answers and `next-marketplace` is a service you recognize:
   `gcloud run services list --project=$P`.

Done when: config reads work from laptop and VPS, and no workflow is stuck on a disabled account.

## Phase 1: take the `ci-deployer` key out of play (D1)

Why now: it is an owner-level key in a public repo's secret store, unused since July. The static site keeps serving without it.

1. Check for other consumers before deleting:
   - `for r in $(gh repo list thangtran3112 --limit 100 --json name -q '.[].name'); do gh secret list -R thangtran3112/$r 2>/dev/null | grep -i 'GCP_SA_KEY\|GOOGLE_CREDENTIALS' | sed "s|^|$r: |"; done`
   - Search the other local machines or CI systems the owner uses for a copy of the key file; the key ID is `04124c30…` (first 8). Delete any copy found.
2. Delete the key (this cannot be undone):
   - `gcloud iam service-accounts keys list --iam-account=ci-deployer@$P.iam.gserviceaccount.com --managed-by=user --project=$P` and check the ID starts `04124c30`.
   - `gcloud iam service-accounts keys delete <full key id> --iam-account=ci-deployer@$P.iam.gserviceaccount.com --project=$P`
3. Delete the stale GitHub secret: `gh secret delete GCP_SA_KEY -R thangtran3112/personal-portfolio`.
4. Confirm: the keys list for `ci-deployer` is empty. `deploy-gcp.yml` now fails at the auth step until Phase 2; that is expected. Tell the owner the portfolio GCP deploy is paused. (The AWS workflow, `deploy.yml`, is separate and unaffected.)

## Phase 2: Workload Identity for `personal-portfolio`, and drop `roles/owner` (D2)

Work in `~/personal/personal-portfolio` (separate session; push to `main` triggers a deploy).

1. **Terraform or script.** Create, following `infrastructure/gcp/ai-trading/main.tf`:
   - a workload identity pool (for example `portfolio-deploy`) and a GitHub OIDC provider;
   - `attribute_condition` that accepts only repository `thangtran3112/personal-portfolio` and ref `refs/heads/main`;
   - a new service account `portfolio-deployer` and a `roles/iam.workloadIdentityUser` binding for that provider's principal set.
   Keep the pool and provider in a place that is **not** overwritten by the site's own Terraform run (bootstrap once by hand with the owner account, or a separate Terraform root). Otherwise the deployer can edit its own trust.
2. **Roles for `portfolio-deployer` (starting set, tighten by iterating on a real run):**
   `roles/serviceusage.serviceUsageAdmin`, `roles/firebase.admin`, `roles/cloudfunctions.developer`, `roles/run.admin`, `roles/cloudbuild.builds.editor`, `roles/artifactregistry.writer`, `roles/secretmanager.admin`, `roles/storage.admin` (the state bucket and the source bucket), `roles/iam.serviceAccountAdmin` and `roles/iam.serviceAccountUser` (create and use `contact-fn-runtime`).
   Do **not** grant `projectIamAdmin`. Instead, pre-grant `roles/cloudbuild.builds.builder` to the default compute account once with the owner account, and remove `google_project_iam_member.compute_sa_builder` from `gcp/terraform/function.tf` (use `terraform state rm` so it is not destroyed).
   Use IAM Recommender (`gcloud recommender recommendations list --recommender=google.iam.policy.Recommender --project=$P --location=global`) after a few runs to trim.
3. **Workflow.** In `.github/workflows/deploy-gcp.yml`: add `permissions: { id-token: write, contents: read }` to the job; replace `credentials_json: ${{ secrets.GCP_SA_KEY }}` with `workload_identity_provider` and `service_account` (store both as repository **variables**, not secrets). The Firebase CLI step already reads `GOOGLE_APPLICATION_CREDENTIALS` from the auth step output; keep that.
4. **Cutover test.** Make one harmless commit on `main` that triggers the GCP workflow (a markdown-only commit skips it, so touch a file the workflow watches). Confirm: auth succeeds, `terraform plan` shows no unexpected changes (especially no IAM destroy), Firebase deploy passes.
5. **Remove owner.** `gcloud projects remove-iam-policy-binding $P --member=serviceAccount:ci-deployer@$P.iam.gserviceaccount.com --role=roles/owner`. Then delete the `ci-deployer` service account if nothing references it (`gcloud iam service-accounts delete ...`), after checking `terraform state list` for references.
6. Update `personal-portfolio/gcp/README.md` and `PLAN_AND_PROGRESS.md`: remove the key and `roles/owner` instructions, describe the Workload Identity setup. These are public files.

Done when: the site deploys with no long-lived key, no service account other than the owner has `roles/owner`, and `gcloud iam service-accounts keys list` shows no user-managed key for the deploy account.

## Phase 3: rotate the `family-config-reader` key

1. Run `infrastructure/gcp/family-config/install-reader-key.sh` (owner laptop, configuration `personal`). It creates a new key, streams it to the VPS, verifies a Firestore read there, and only then deletes the old key. It never writes the key to local disk.
2. Confirm afterwards: one user-managed key for the account, created today.
3. Optional hardening: the reader holds project-wide `datastore.user`, `secretmanager.secretAccessor`, and `storage.objectAdmin`. Narrow with IAM conditions, or to the specific database, secrets, and buckets, as the design doc allows (`docs/superpowers/specs/2026-10-05-family-config-firestore-design.md`). Check with that design before changing roles.

## Phase 4: hygiene

1. **Gemini keys (D4).** `gcloud services api-keys delete projects/$P/locations/global/keys/<uid>` for `gemini-deerflow` (`45276967…`) and, if unused, `OpenCode and Archer` (`62a4098c…`). If a key stays: tighten the restrictions. Both are API-restricted to Generative Language only; there is no application restriction. Re-create from AI Studio when needed.
2. **Open firewall.** No VM exists, so delete `default-allow-ssh` and `default-allow-rdp` on the `default` network, or delete the default network. Leave `compute.googleapis.com` enabled for now: Cloud Functions gen2 builds use the default compute account, and `apis.tf` lists it.
3. **Default roles.** The default compute and App Engine accounts hold `roles/editor`. Replace with the specific roles the function build needs (`cloudbuild.builds.builder` already granted), then remove `editor`. Test with one function deploy.
4. **Budget alert.** Create a budget with email alerts on the billing account at low thresholds (for example 10, 50, 100 USD). An abuse spike then shows within hours. Do it in the console under Billing, or with `gcloud billing budgets create`. Record the setting here without the billing account ID.
5. **Billing review.** Billing, Reports, group by SKU, September to October. Look for Compute, Vertex, or Gemini SKUs. Record the finding in `01-evidence.md`.
6. **GitHub alerts.** Revoke or close the old secret-scanning alerts on `website-templates`, `gen-ai`, and `ecom` (revoke the credential at its provider first).
7. **Recurring audit.** Monthly: `gcloud iam service-accounts keys list --managed-by=user` for every service account (expect only `family-config-reader`), `gcloud services api-keys list`, and the owner/editor IAM listing from `01-evidence.md`.
8. Reply to Google? The reinstatement email asks to fix outstanding issues; the steps above are that fix. Keep a short note of what was done and when in case of a second suspension.

## Phase 5: separate `family-config` from the public site (D3)

Why: a suspension of the project that hosts a public portfolio took the secret store for every family app with it.

1. Create a dedicated project (for example `family-config-prod`) with billing linked, only Firestore and IAM enabled, and no public resources.
2. **Back up first.** Export the `family-config` database (`gcloud firestore export` to a bucket in the new project, or use the repo's existing backup job; check `infrastructure/` for it). Confirm the backup is restorable before any move.
3. Create the database there, import, create a new reader account and key (`install-reader-key.sh` with `FAMILY_CONFIG_PROJECT` set), and switch the `FAMILY_CONFIG_PROJECT` default in `common/config/family_config.py` and every place that hard-codes `tobytran-portfolio` (grep result in `01-evidence.md`: `ai-trading/AGENTS.md`, `ai-trading/deploy/production/README.md`, `.github/workflows/ai-trading-infra.yml`, `.github/workflows/ai-trading-deploy.yml`, `infrastructure/gcp/ai-trading/main.tf`, `infrastructure/gcp/family-config/install-reader-key.sh`, `common/config/README.md`, and others).
4. The Workload Identity pools for `ai-trading` also live in `tobytran-portfolio`; moving them is a separate Terraform change in `infrastructure/gcp/ai-trading`. Plan it with the ai-trading owner session.
5. Do this as its own phase with a spec under `docs/superpowers/specs/`, then a plan. It changes every deploy path.

## Verification after each phase

- Phase 1: key list for `ci-deployer` empty; secret gone from the repo.
- Phase 2: successful deploy run; `gcloud projects get-iam-policy $P --flatten='bindings[].members' --filter='bindings.role:roles/owner' --format='value(bindings.members)'` shows only the owner's personal account.
- Phase 3: VPS reads Firestore with the new key; one user-managed key.
- Phase 4: budget exists; no `0.0.0.0/0` SSH/RDP rule; no unused API key.
- Always: `family-app` deploy still works (`family_config.py` render on the VPS).

## Risks and notes

- Deleting a key or role is permanent. Re-create from the list above.
- A deploy-time failure after a role change means a role is missing; add the specific role from the error, not `owner`.
- Google can re-suspend. Keep Phase 1 and Phase 4 done even if Phase 2 takes time.
- The earlier session could not read the original Google notices (Gmail connectors failed: `Insufficient scope`, `disabled_client`). The owner should look for a notice that names the credential.
