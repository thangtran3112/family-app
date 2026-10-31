# Infrastructure

Everything that provisions or deploys the family-app platform lives here as code. Two rules shape the layout:

- **Shared** pieces (host, Postgres, Temporal, backups, tunnel connector, tailnet, plans) sit at the top level and belong to the infrastructure plans in `plans/`.
- **App-specific** deploy assets sit under `apps/<app>/` and belong to that app for release scoping. `ai-trading` and `expense-tax-management` each own their own folder.

Per-area READMEs hold the runbooks. This file is the map.

## Layout

```
infrastructure/
├── host/                  shared host bootstrap (VPS today, laptop next) + cloudflared installer
├── apps/
│   ├── ai-trading/        Compose, deploy.sh, health-check.sh, render-env.sh, Caddyfile, tests
│   └── expense-tax/       Compose (+ mailbox overlay), deploy.sh, health-check.sh, operator DB bootstrap
├── gcp/                   GCP projects, identities, buckets (Terraform and bootstrap scripts)
│   ├── bootstrap-state.sh   one-time Terraform state bucket
│   ├── family-config/       Firestore config store + read-only host service account
│   ├── ai-trading/          deploy/terraform workload identity, hub/desk/mirofish buckets
│   ├── expense-tax/         project + GitHub workload identity pool, Cloudflare CI identity
│   └── backup/              backup bucket, writer and freshness-monitor identities
├── cloudflare/            Terraform: tunnels, DNS, ingress, Workers
│   ├── ai-trading/  expense-tax/  zero-trust/ (deferred)
├── tailscale/             tailnet policy as code (admin + CI SSH only)
├── temporal/              shared Temporal server (+ local variant) and namespace bootstrap
├── postgres/ nginx/       local shared-cluster init and transitional gateway config
├── backup/                encrypted Postgres + volume backup, restore, recovery drill, freshness check
├── docker-compose.common.yml   local Postgres + transitional Nginx
└── plans/                 infrastructure plans (laptop migration, 0001a to 0001g)
```

## Shared

| Path | What it is | Owner of its rules |
|---|---|---|
| `host/` | Idempotent bash steps that turn a fresh machine into a family host: firewall, power (opt-in), SSH hardening, Tailscale (opt-in), Docker, shared Postgres, shared Temporal (opt-in), backup (opt-in). `host/bootstrap-cloudflared.sh` installs the outbound tunnel connector. Per-app config in `host/apps/`; ai-trading app-controls in `host/app-controls/`. | `host/README.md` |
| `gcp/bootstrap-state.sh` | Creates the GCS bucket that holds Terraform state for every root (one bucket, one prefix per root, e.g. `cloudflare/expense-tax`). | this file |
| `gcp/family-config/` | Creates the Firestore `family-config` database (deny-all client rules) and the read-only reader service account; `install-reader-key.sh` puts the reader key on a host. Config is read only through `common/config/family_config.py`. | `common/config/README.md` |
| `cloudflare/` | One shared Cloudflare token (`shared/cloudflare`). Each root owns its tunnel, DNS and ingress; plans run in CI, applies are dispatched. | `cloudflare/<root>/README.md` |
| `tailscale/` | Default-deny tailnet policy: `autogroup:admin` and `tag:ci` reach `tag:family-host` on the SSH port, nothing else. Operator-applied. Separate from any other tailnet. | `tailscale/README.md` |
| `temporal/` | One Temporal server (`family-temporal`) shared by apps, one namespace per app (`expense-tax`). Joins the `postgres_default` and `family_shared` networks. | section below |
| Postgres | One cluster, one database and role set per app, created by `host/steps/30-postgres.sh`. Container `family-app-postgres`, network `postgres_default`, loopback-bound. Local development uses `docker-compose.common.yml` and `postgres/init-multiple-dbs.sh`. | `host/README.md` |
| `nginx/` | Local gateway for the transitional `expense-service` and `frontend/web` only. Not a production edge. | n/a |
| `backup/` | Encrypted daily Postgres and receipt-volume backups to GCS, restore, recovery drill, freshness check. Not part of any app Compose file. | `backup/README.md` |
| `plans/` | The laptop migration plan and its sub-plans. | `plans/0001-laptop-migration.md` |

## App-specific

| Path | Deployed by | Notes |
|---|---|---|
| `apps/ai-trading/` | `.github/workflows/ai-trading-deploy.yml` | Trading Hub, upstream apps, Family Desk, MiroFish. Runbook: `apps/ai-trading/README.md`. |
| `apps/expense-tax/` | `.github/workflows/expense-tax-deploy.yml` | App API, Foundry, workflow worker, three web apps, mailbox broker (overlay). `bootstrap-temporal-db.sh` and `bootstrap-mailbox-vault-db.sh` are operator-only, never part of a deploy. Runbook: `expense-tax-management/plans/production-activation-runbook.md`. |

Both deploy workflows accept a manual `target` (`vps` or `laptop`), `dark` (start the stack without the component that does work: ai-trading leaves out cloudflared and the Desk scheduler, expense-tax leaves out `workflow-worker`) and `image_tag` (deploy an already-pushed image, skip the build). A push to `main` always deploys to the VPS. `target=laptop` first joins the tailnet as `tag:ci`.

## GCP versus host

| | GCP (cloud-side, stays) | Host (VPS now, laptop next) |
|---|---|---|
| What | Projects, workload identity pools, service accounts, buckets, Firestore `family-config`, Terraform state | Firewall, SSH, Docker, Postgres, Temporal, cloudflared, backups, app containers |
| Code | `gcp/` and the Terraform in `cloudflare/` | `host/` and `apps/<app>/` |
| Applied by | Operator, or a dispatched workflow with an approval gate | `host/bootstrap.sh` from the operator machine; deploys by workflow over SSH |
| Config and secrets | Firestore `family-config` | Read at deploy time through `family_config.py` with the reader key; nothing lives in the repo |

The CI-to-host path is SSH with pinned host keys. Hosts are chosen by Firestore group: `shared/vps` today, `shared/laptop` after cutover; the laptop is reached over the tailnet (`shared/tailscale`). Workflows read GitHub copies of those values until the VPS is retired (plan 0001f).

## Production Sources

- `cloudflare/expense-tax/`: live Cloudflare Tunnel, product DNS/ingress, Clerk DNS, and GCS-backed Terraform state.
- `host/bootstrap-cloudflared.sh`: installs the outbound Tunnel connector on an existing host.
- `temporal/docker-compose.yml`: independently owned shared Temporal server and loopback-only UI.
- `temporal/dynamicconfig.yaml`: shared Temporal dynamic configuration.
- `apps/expense-tax/`: application production Compose, deploy, migration, rollback, and health-check scripts.
- `.github/workflows/expense-tax-deploy.yml`: immutable-image build and main-only production deployment.

Production application origins bind to host loopback and are reachable publicly only through Cloudflare Tunnel.

## Local/Transitional Sources

- `docker-compose.common.yml`: local PostgreSQL and transitional Nginx only; Neo4j remains blocked by the Phase 9A graph evidence gate.
- `temporal/docker-compose.local.yml`: pinned local Temporal server/UI included by the Expense development Compose wrapper.
- `postgres/init-multiple-dbs.sh`: local shared-cluster database creation.
- `nginx/nginx.conf`: local gateway for transitional `expense-service`/`frontend/web` paths.
- `expense-tax-management/docker-compose.yml`: application-local development overlay.

Local Nginx and transitional Python/web services are not the current production edge or canonical application architecture.

## Local Usage

```bash
cd expense-tax-management
pnpm compose:up
pnpm compose:down
```

## Why Shared PostgreSQL

One VPS PostgreSQL cluster reduces memory and operations overhead. Each family app receives a separate database and service-owned roles, preserving application isolation without running duplicate PostgreSQL containers.

## Shared Temporal Activation (operator-only)

Source changes alone do not migrate the live Temporal server. Production activation needs a separately approved, coordinated cutover. On a host bootstrapped with `host/bootstrap.sh --only temporal`, `host/steps/35-temporal.sh` performs the staging, env file, start and namespace steps (2 and 3 below, minus the downtime handling); the runbook remains the VPS procedure:

1. Keep the existing `temporal` and `temporal_visibility` PostgreSQL databases and the `expense_temporal` role. `infrastructure/apps/expense-tax/bootstrap-temporal-db.sh` remains an operator-only database creation step; do not run it during normal deployment. Record the last known-good image tag and preserve the existing Expense Compose file, deploy scripts, and root-only production environment file in a root-only recovery directory before replacing anything.
2. Create `family_shared` once. Transfer `infrastructure/temporal/docker-compose.yml`, `dynamicconfig.yaml`, and `bootstrap-namespaces.sh` together into `/opt/family-app/temporal/` on the VPS. Provision `/etc/family-app/temporal.env` as root-owned mode `0600` with **only** `TEMPORAL_DB_PASSWORD` set to the existing `expense_temporal` role password. Keep that password in a separate shared-infrastructure secret bundle; do not generate a new password or take it from a new Expense bundle. The shared server also joins `postgres_default`.
3. In the approved downtime window, stop the old `expense-tax-production` Temporal service and verify no container with Compose labels `com.docker.compose.project=expense-tax-production` and `com.docker.compose.service=temporal` is running. **Never run both Temporal servers against the same databases.** Start the shared server and UI from the staged files:

   ```bash
   sudo docker compose --project-name family-temporal --env-file /etc/family-app/temporal.env -f /opt/family-app/temporal/docker-compose.yml up -d --wait
   sudo bash /opt/family-app/temporal/bootstrap-namespaces.sh
   sudo docker exec family-temporal temporal operator namespace describe --address temporal:7233 --namespace default
   ```

   Namespace bootstrap creates `expense-tax` once and leaves the Python worker's `default` histories intact.
4. After the shared server is healthy, publish an Expense production bundle without `TEMPORAL_DB_PASSWORD` using the existing protected secret sync procedure. The next Expense deployment attaches App API and the Python worker to `family_shared`; its preflight rejects a running legacy Temporal container and requires `expense-tax`. Confirm both applications resolve `temporal` to the running `family-temporal` container and that the Python worker continues to process `default` histories before resuming dispatch.

Application image rollback cannot recover a failed shared Temporal server. If shared activation fails, stop the shared server first. Restore the saved Expense Compose file, deploy scripts, environment file, and image tag; then restart the old Temporal service against the **same preserved databases**. Verify `default` namespace histories and Python worker polling before resuming dispatch. Never start the legacy server until the shared server is stopped. Rehearse this operator rollback in an isolated environment before live activation.

Future Stock Analysis onboarding may create `stock-analysis` with `temporal operator namespace create --address temporal:7233 --namespace stock-analysis --retention 72h` after its separate approval. No Stock service or namespace is provisioned in this task.

## Deferred

- Automated PostgreSQL backup/restore to GCS.
- Proven fresh-host restore and provider migration drill.
- Live proof of shared-cluster `host/steps/30-postgres.sh` on a fresh VPS.
- Search/graph production infrastructure.

See `expense-tax-management/plans/ROADMAP.md` for current status and migration order.
