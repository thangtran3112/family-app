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
- `expense-clerk.tobytran.dev` intentionally remains outside Terraform and documented as DNS-only Clerk custom Frontend API CNAME.

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
- State bootstrap verifies bucket project number matches
  `expense-tax-tobytran-2026` before versioning, lifecycle, or IAM mutation.
- State bucket lifecycle retains current state indefinitely and deletes
  noncurrent versions after exactly 30 days.
- VPS bootstrap accepts GNU/macOS `stat` output and installs/upgrades
  cloudflared until version `2025.4.0` or newer is present before using
  `--token-file`.
