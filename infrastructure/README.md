# Shared Infrastructure

`infrastructure/` owns shared local services, VPS base provisioning, and Cloudflare production ingress.

## Production Sources

- `cloudflare/expense-tax/`: live Cloudflare Tunnel, product DNS/ingress, Clerk DNS, and GCS-backed Terraform state.
- `vps/bootstrap-cloudflared.sh`: installs the outbound Tunnel connector on an existing VPS.
- `vps/`: reusable SSH hardening, UFW, Docker, and shared-PostgreSQL bootstrap.
- `expense-tax-management/deploy/production/`: application production Compose, deploy, migration, rollback, and health-check scripts.
- `.github/workflows/expense-tax-deploy.yml`: immutable-image build and main-only production deployment.

Production application origins bind to VPS loopback and are reachable publicly only through Cloudflare Tunnel.

## Local/Transitional Sources

- `docker-compose.common.yml`: local PostgreSQL, Neo4j, Temporal, Temporal UI, and Nginx services.
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

## Deferred

- Automated PostgreSQL backup/restore to GCS.
- Proven fresh-host restore and provider migration drill.
- Live proof of shared-cluster `vps/steps/30-postgres.sh` on a fresh VPS.
- Search/graph production infrastructure.

See `expense-tax-management/plans/ROADMAP.md` for current status and migration order.
