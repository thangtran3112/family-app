# Phase 1B Production CI/CD and VPS Deployment Design

> Approved direction: 2026-09-09
> Replaces deployment assumptions in `phase-1b-vps-deployment.md`.

## Goal

Deploy the current polyglot application reproducibly to the live OVH VPS
after Phase 1A succeeds, while keeping application traffic private until
identity and public-hostname decisions are approved.

## Compute Placement Policy

- Use GCP serverless functions for future short-lived, event-driven work that
  fits an AWS Lambda-style execution model.
- Keep always-on APIs and stateful orchestration on the existing VPS to avoid
  GCP always-on compute cost.
- Consider Cloud Run for non-time-sensitive services only after a case-by-case
  user decision.
- Do not provision a GCP VM at this stage.

Phase 1B places App API, Foundry Service, Temporal, the Python worker, Capture
Web, Office Web, and Foundry Web on the VPS. GCP hosts only Secret Manager,
IAM, and GitHub workload identity for this phase.

## Existing Production State

- VPS: `158.69.202.250`, Ubuntu, SSH port 2222, key-only authentication.
- Capacity: 96 GB disk with 88 GB free; 11 GiB memory with about 10 GiB
  available at design time.
- UFW allows SSH/HTTP/HTTPS. No process currently listens on 80 or 443.
- PostgreSQL 17 + pgvector is healthy as `expense-tax-postgres`, published only
  on VPS loopback `127.0.0.1:5432`.
- Existing PostgreSQL Docker network is `postgres_default`; alias `postgres`
  resolves the container from attached application containers.
- App schema is migrated through 012 and Foundry through 004. No user dataset
  exists yet.

## GCP Secret Architecture

Create project `expense-tax-tobytran-2026` under organization
`177410718350`, attached to billing account `013C6D-EEE26E-EAA1A1`. Enable
Secret Manager, IAM, IAM Credentials, Security Token Service, and Resource
Manager APIs.

Store one automatic-replication secret named `expense-tax-production-env`.
Its dotenv payload contains:

- `OPENAI_API_KEY` and `OPENROUTER_API_KEY`, imported directly from the local
  shell environment without displaying their values.
- App and Foundry runtime/migrator database URLs, converted from local tunnel
  hostnames to Docker-network hostname `postgres:5432` without displaying
  passwords.
- Fresh random values for storage URL signing, inbound webhook signing, and
  inbound routing-token derivation.
- A dedicated Temporal database password.

Secret Manager is intrinsically versioned. Repository tooling enforces one
retained active version: create a new version, verify it can be accessed, then
irreversibly destroy every older enabled or disabled version. Initial creation
therefore retains only version 1. Rotation has a brief two-version transaction
window but leaves no rollback version.

The deployment workflow accesses only this secret through GitHub OIDC Workload
Identity Federation and a dedicated GCP service account with
`roles/secretmanager.secretAccessor` on this secret. No GCP service-account
key is created or stored in GitHub.

## Image Delivery

After successful Phase 1A CI on `main`, GitHub-hosted runners build these six
images:

- App API
- Foundry Service
- Python AI worker
- Capture Web
- Office Web
- Foundry Web

Images publish to GHCR with immutable full-commit-SHA tags. The workflow uses
the repository-scoped `GITHUB_TOKEN`; no registry password is retained. During
deployment, the same short-lived token authenticates VPS Docker only for image
pull, then Docker logs out.

## Deployment Identity

Generate a dedicated Ed25519 deployment key. Add only its public key to the VPS
`ubuntu` account. Store the private key in GitHub production-environment secret
`VPS_DEPLOY_SSH_KEY`; do not reuse the personal operator key. Store host, port,
GCP provider, and service-account identifiers as GitHub environment variables,
not secrets.

The deploy key permits normal `ubuntu` SSH access. Existing passwordless sudo
is required for atomic installation under `/opt/expense-tax-management/app`
and Docker operations. Phase 1B does not broaden firewall rules.

## VPS Runtime

Install a production Compose manifest and deploy helper under
`/opt/expense-tax-management/app`. Runtime services use prebuilt SHA-tagged
images and attach to external network `postgres_default`; production Compose
does not create or replace PostgreSQL.

Create dedicated `temporal` and `temporal_visibility` databases owned by a
dedicated Temporal role before first application deployment. Initial bootstrap
uses the existing VPS-only PostgreSQL superuser credential; that credential is
not copied into GCP or GitHub.

Deployment sequence:

1. Confirm Phase 1A succeeded for the exact SHA.
2. Build and publish immutable images.
3. Fetch the production bundle through GCP workload identity.
4. Upload the bundle to a temporary VPS path, then install it atomically as a
   root-owned `0600` file.
5. Record the currently deployed image SHA.
6. Pull new images and run App/Foundry migrations.
7. Start or update services with Compose.
8. Probe App API, Foundry, Temporal, and all three web clients through VPS
   loopback over SSH.
9. On failure, restore the previous SHA and restart. Database migrations remain
   forward-only, so every migration shipped in this phase must be compatible
   with the previous application image.

Only one deployment runs at a time through GitHub environment concurrency.

## Exposure and Authentication Gate

Phase 1B exposes no application port publicly. App API, Foundry, and web ports
remain bound to VPS loopback; Temporal has no public UI. Current placeholder
identity authorities and worker tokens fail closed, so authenticated workflows
remain unavailable until identity issuance is designed.

Before public routing, stop for explicit decisions on:

- Tenant and platform identity provider, issuers, audiences, JWKS URLs, client
  IDs, and role mapping.
- Public hostnames for Capture, Office, Foundry, and APIs.
- Gateway choice and TLS/DNS changes for revised Phase 1C.
- Local object storage versus GCS.
- Real provider adapter activation and API spending limits.
- Any service proposed for GCP Functions or Cloud Run.

## Security and Failure Handling

- GitHub CI retains `contents: read`; image/deploy jobs receive only
  `packages: write` and `id-token: write` where required.
- Pull requests never receive production credentials and never deploy.
- Secret values are piped or written to mode-0600 temporary files; commands do
  not print them. Temporary runner files are removed after deployment.
- Migration failure stops before service restart.
- Health failure triggers image rollback and leaves diagnostics in Actions.
- Existing PostgreSQL data and volume are never recreated by app deployment.

## Acceptance Criteria

- New isolated GCP project and WIF trust exist without a service-account key.
- Exactly one non-destroyed production secret version remains.
- Six SHA-tagged images publish after green CI.
- Clean VPS deployment uses existing PostgreSQL and passes all private health
  probes.
- Failed deployment restores previous image SHA.
- No public route, DNS record, GCP VM, or production identity placeholder is
  presented as functional authentication.
