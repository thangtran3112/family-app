# Expense Tax GCP Bootstrap

Scripts provision GCP identity and synchronize one production Secret Manager
version. They run from `expense-tax-management`, never create service-account
keys, and never put secret payloads in command arguments or logs.

## Fixed resources

- Project: `expense-tax-tobytran-2026`
- Billing account: `013C6D-EEE26E-EAA1A1`
- Secret: `expense-tax-production-env`
- GitHub repository condition: `thangtran3112/family-app`
- Deploy service account: `expense-tax-github-deploy`
- WIF pool/provider: `expense-tax-github/github`

## Bootstrap

Prerequisites: authenticated `gcloud`, billing access, Node.js 22+, and a
local checkout. Existing resources are reported as no-op and reused.

```bash
cd expense-tax-management
gcloud auth list
./infrastructure/gcp/expense-tax/bootstrap.sh
```

Bootstrap writes machine-readable identity metadata by default to the gitignored
`.keys/gcp/expense-tax-bootstrap-outputs.json` with mode `0600`. It contains no
secret payload. Existing WIF provider metadata and project placement/billing are
validated for exact issuer, attribute mapping, repository condition, organization,
and billing account; drift aborts bootstrap.

## Secret synchronization

Before running, ensure `~/.zshrc` defines `OPENAI_API_KEY` and
`OPENROUTER_API_KEY`, and local database env exists at
`.keys/ovh/postgres-vps.env` (or set `DATABASE_ENV_PATH`). The database file is
parsed as dotenv data, never executed. PostgreSQL superuser values are not
selected by the bundle builder.

```bash
cd expense-tax-management
./infrastructure/gcp/expense-tax/sync-production-secret.sh
```

The script builds through `scripts/lib/production-secret-bundle.mjs`, keeps
generated signing keys from the current payload, uploads through a protected
temporary `--data-file`, verifies the new version by SHA-256, and destroys
every older enabled or disabled version. It prints version IDs and hashes only.
If current-version access fails, synchronization aborts unless the version list
proves no non-destroyed version exists. Destruction attempts continue across
all old versions, then synchronization verifies exactly one non-destroyed
version equal to the new version; any failure aborts loudly. It sources `~/.zshrc`
only inside an isolated zsh with tracing disabled and startup output discarded;
only the two required API-key variables enter the protected builder input.

## Verification

```bash
node scripts/check-phase-1b-infrastructure.mjs
pnpm exec vitest run scripts/lib/production-secret-bundle.test.mjs
```

These checks do not contact GCP, read local secret files, or print secret
values. Policy intentionally keeps exactly one non-destroyed version after a
successful synchronization.
