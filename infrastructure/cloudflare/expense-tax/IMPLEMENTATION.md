# Cloudflare Tunnel Implementation Evidence

Date: 2026-09-10

## Scope

- Added Terraform for remotely managed Tunnel configuration and five proxied DNS CNAMEs.
- Added deterministic GCS state bootstrap instructions and script.
- Added token-file cloudflared VPS bootstrap with systemd and no public application ports.
- Added PR/manual-only GitHub Actions workflow. Apply requires manual dispatch with `apply=true`.
- Expanded GCP WIF admission to exact `expense-tax-deploy.yml` or `expense-tax-cloudflare.yml` refs, repository `thangtran3112/family-app`, `refs/heads/main`, and `production` environment.

## Safety evidence

- No Cloudflare API calls executed.
- No gcloud mutations executed.
- No VPS command, deployment, DNS mutation, or push executed.
- Existing `plans/mockups/**` and untracked AGENTS/CLAUDE files were not modified.
- `expense-clerk.tobytran.dev` was not used; production Clerk uses `clerk.tobytran.dev`.

## Verification

- `terraform fmt -check -recursive .` and `terraform validate` passed with backend disabled.
- `bash -n` passed for Cloudflare state/VPS/GCP bootstrap scripts and secret sync script.
- Existing Phase 1B infrastructure, deployment workflow, and CI static checks passed.
- Cloudflare infrastructure static policy check passed.
- Existing mocked GCP infrastructure test passed: 7 tests.
- `git diff --check` passed.

## Review hardening evidence

- PR workflow path is unprivileged: Terraform initializes with
  `-backend=false`, receives no Cloudflare secret, no production environment,
  and no OIDC permission.
- Trusted Terraform plan runs only on `push` to `refs/heads/main` or manual
  dispatch in protected `production`; apply remains manual-only with
  `apply=true`. GCP WIF admission condition remains exact and unchanged.
- State bootstrap verifies the exact bucket name appears in the
  `expense-tax-tobytran-2026` project-scoped bucket listing before versioning,
  lifecycle, or IAM mutation.
- State bucket lifecycle retains current state indefinitely and deletes
  noncurrent versions after exactly 30 days.
- VPS bootstrap accepts GNU/macOS `stat` output and installs/upgrades
  cloudflared until version `2025.4.0` or newer is present before using
  `--token-file`.

## Final review remediation evidence

- Trusted plan job uploads only binary `tfplan` artifact with one-day retention;
  apply downloads that artifact and runs `terraform apply -auto-approve tfplan`.
  PR validation remains backend-disabled, secretless, and without OIDC.
- Cloudflare Terraform now uses dedicated service account/WIF bootstrap path
  (`bootstrap-cloudflare.sh`) with exact repository, `refs/heads/main`, workflow,
  and `production` admission. State bootstrap removes legacy application deploy
  service-account object access and grants bucket object access only to the
  dedicated Cloudflare identity. No Secret Manager or application deploy role is
  granted by this path.
- VPS bootstrap now requires a mode `0600` known-hosts file and uses
  `UserKnownHostsFile` with `StrictHostKeyChecking=yes`; `accept-new` is absent.
- README token export sets `umask 077` before redirection and enforces mode `0600`.
- Verification passed: `terraform fmt -check -recursive .`,
  `terraform init -backend=false && terraform validate`, `bash -n` for all
  touched shell scripts, Cloudflare static check, twelve Vitest checks across
  Cloudflare and Phase 1B infrastructure suites, and
  `git diff --check`.
- No Cloudflare API calls, gcloud mutations, VPS commands, Terraform apply, or
  repository push executed.

## Clerk DNS Change Verification

- `terraform init -backend=false` completed using the existing provider lock; no backend or Cloudflare API access used.
- `terraform fmt -check -recursive .` passed.
- `terraform validate` passed with backend disabled.
- `bash infrastructure/cloudflare/expense-tax/test-clerk-dns.sh` passed for all five Clerk CNAME targets, `proxied = false`, and preserved Tunnel `proxied = true` configuration.
- Existing Cloudflare Vitest static suite passed: 6 tests.
- `git diff --check` passed for all changed Clerk files.
- No Terraform import/apply, external calls, DNS mutation, or repository push executed.
