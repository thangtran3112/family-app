# Evidence: what the investigation found

All commands are read-only. Run them with `CLOUDSDK_ACTIVE_CONFIG_NAME=personal`. Project ID: `tobytran-portfolio`.

## Timeline

| Date | Event |
|---|---|
| 2026-06-14 | Project created. `ci-deployer` created with `roles/owner` and a key; key stored as GitHub secret `GCP_SA_KEY` in `personal-portfolio`. |
| 2026-06-26, 2026-09-07 | Gemini API keys `gemini-deerflow` and `OpenCode and Archer` created. |
| 2026-07-13 | Last `personal-portfolio` workflow run (push, success). |
| 2026-10-05 | Firestore `family-config` created. `family-config-reader` created with a key installed on the VPS. |
| 2026-10-17 | Suspension notice. All service accounts disabled by Google. Compute, Logging, and Billing reads fail with `CONSUMER_SUSPENDED`. |
| 2026-10-18 | Reinstated. All service accounts enabled again. |

## Inventory after reinstatement

**Service accounts (11, all enabled):** `<project-number>-compute` (default), `firebase-adminsdk-fbsvc`, `tobytran-portfolio@appspot`, `contact-fn-runtime`, `ci-deployer`, `ai-trading-terraform`, `ai-trading-hub-upload`, `ai-trading-deploy`, `ai-trading-mirofish-upload`, `ais-gemini-key-…` (created by AI Studio), `family-config-reader`.

**User-managed service account keys (2):**

| Account | Key ID (first 8) | Created | Where it lives |
|---|---|---|---|
| `ci-deployer` | `04124c30` | 2026-06-14 | GitHub secret `GCP_SA_KEY` in `thangtran3112/personal-portfolio` (public repo) |
| `family-config-reader` | `94b81354` | 2026-10-05 | VPS `/etc/family-app/config-reader.json` only (`infrastructure/gcp/family-config/install-reader-key.sh` streams it there; never on local disk) |

Every other account uses Workload Identity (no keys): the `ai-trading-*` accounts.

**API keys (3):** `OpenCode and Archer` (Gemini only), `gemini-deerflow` (Gemini only), Firebase browser key (auto-created, Firebase APIs). Neither Gemini key has a referrer or IP restriction. AI Studio shows no use of the two Gemini keys in 28 days.

**Project IAM (owner and editor):**
- `roles/owner`: `ci-deployer`, and the owner's personal account.
- `roles/editor`: the default compute account and the App Engine default account (Google defaults).
- `family-config-reader`: `datastore.user`, `secretmanager.secretAccessor`, `storage.objectAdmin`, all project-wide.

**Running resources:** no VMs. Cloud Run services `contact` and `next-marketplace` (us-west1), Cloud Function `contact` (gen2). The `default` network has `default-allow-ssh` (22) and `default-allow-rdp` (3389) open to `0.0.0.0/0`; no VM uses them. `compute.googleapis.com` is enabled (Terraform lists it in `apis.tf`).

## Repos and secret scanning

| Repo | Visibility | Result |
|---|---|---|
| `personal-portfolio` | public | No key or `private_key` in any commit. `deploy-gcp.yml` reads the key from a secret. Triggers: `push` only. 0 forks. |
| `family-app` | public | No key strings. Its CI uses Workload Identity and has no repository secrets. 0 forks. |
| `agentic-assets`, `daycare`, `local-llm`, `resume-behavior` | private | The three live API key strings do not appear in any of them or their history. |

- Method: for each live API key, fetch the key string, then search the working tree and `git log --all -S` of every repo in `~/personal`. Print only repo and path names.
- The two service account key IDs were also searched in git history of all local repos and with GitHub code search (`gh search code <id> --owner thangtran3112`). No hits. Key IDs are not secret; the private key itself never matched anything.
- GitHub secret-scanning alerts exist on other public repos (`website-templates`: 2 Google API keys, May 2024; `gen-ai`: Datastax and Hugging Face tokens; `ecom`: Stripe test key). The Google keys there predate this project (created 2026-06-14), so they are **not** the cause. They are still open alerts; revoke them if they are live.
- Local machine: no live key string in `~/.hermes`, `~/.config/opencode`, `~/.local/share/opencode`, `~/personal/local-llm`, shell rc files, or the environment. The key file `~/ci-deployer-key.json` mentioned in the public `PLAN_AND_PROGRESS.md` no longer exists.

## Audit logs (read after reinstatement)

- **Admin-activity log:** oldest entry 2026-06-14 (project creation); 400-day search.
  - Principals other than the owner and Google system accounts: `ci-deployer` (Terraform apply and function deploys: `UpdateFunction`, `CreateFunction`, `BatchEnableServices`, `CreateSecret`, `SetIamPolicy`, `AddFirebase`, bucket create), the Cloud Functions and Firebase service agents, and Google-managed events at project creation.
  - 3 `CreateServiceAccount` events with no principal on 2026-06-14 22:48 (`appengine-default`, `service-<project-number>`): Google-managed, at project setup.
  - **No Compute Engine method at any time.**
- **Data-access log, last 30 days:** only the `ai-trading-deploy`, `ai-trading-terraform`, `ai-trading-hub-upload`, and `ai-trading-mirofish-upload` accounts (Workload Identity token generation) and the owner.
- **Abuse event log** (`abuseevent.googleapis.com/abuse_events`): one entry, the reinstatement. The suspension event itself is not in the retained log.
- **Not visible in these logs:** Gemini API calls and any activity before a 30-day data-access window. That is why the AI Studio usage page and Billing by SKU still matter.

Reproduce:

```bash
export CLOUDSDK_ACTIVE_CONFIG_NAME=personal; P=tobytran-portfolio
gcloud logging read 'logName:"cloudaudit.googleapis.com%2Factivity" AND NOT protoPayload.authenticationInfo.principalEmail="<owner>" AND NOT protoPayload.authenticationInfo.principalEmail:"system.gserviceaccount.com"' \
  --project=$P --freshness=400d --limit=500 \
  --format='value(protoPayload.authenticationInfo.principalEmail,protoPayload.methodName)' | sort | uniq -c | sort -rn
gcloud logging read 'protoPayload.serviceName="compute.googleapis.com"' --project=$P --freshness=400d --limit=5
gcloud logging read 'logName="projects/tobytran-portfolio/logs/abuseevent.googleapis.com%2Fabuse_events"' --project=$P --freshness=120d
```

## Dependencies on this project (blast radius)

- `common/config/family_config.py` defaults `FAMILY_CONFIG_PROJECT` to `tobytran-portfolio`; the Firestore database `family-config` holds every family-app env value and key.
- The VPS runs `family_config.py` **at deploy time** (`ai-trading/deploy/production/deploy.sh`, `.github/workflows/expense-tax-deploy.yml`) with `FAMILY_CONFIG_CREDENTIALS=/etc/family-app/config-reader.json`. Running containers keep the env they were deployed with, so they probably kept working during the suspension; deploys did not. This was inferred from the scripts, not tested.
- `family-app` CI (`ai-trading-deploy.yml`, `ai-trading-infra.yml`) authenticates through Workload Identity providers in this project. `expense-tax-deploy.yml` reaches the VPS and runs the config render there.
- The Terraform state bucket for the portfolio site (`tobytran-portfolio-tfstate`) and the portfolio site itself (Firebase Hosting, Cloud Function `contact`) are in this project.

## Facts that shape the plan

- `personal-portfolio/gcp/terraform` manages: API enablement, Firebase project and hosting site with two custom domains, the `fn_runtime` service account, an IAM binding `roles/cloudbuild.builds.builder` for the default compute account, a source bucket and object, the gen2 function, a public `roles/run.invoker` for `allUsers`, a Secret Manager secret, and its accessor binding. State is in GCS. This set needs several admin roles and **project IAM admin** (for the builder binding). `roles/resourcemanager.projectIamAdmin` can grant itself anything, so dropping `owner` for it is a smaller step than it looks. Moving that one binding out of Terraform removes the need.
- `infrastructure/gcp/ai-trading/main.tf` (lines about 81-150) already defines pool, provider, `attribute_condition` on repository and ref, a service account, and the `roles/iam.workloadIdentityUser` binding. Reuse that shape.
- The owner has no Google Cloud organization (personal Gmail account), so the org policy `iam.disableServiceAccountKeyCreation` cannot be applied. Key hygiene is by audit instead.
