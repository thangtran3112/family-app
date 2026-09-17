# Infrastructure and Deployment Roadmap

> **Status:** Private production deployment live. Backup/restore and provider migration remain unimplemented.
> **Last updated:** 2026-09-13
> **Companion:** See [PLAN.md](PLAN.md) for feature order and active implementation plans.

## Current Production Topology

```text
Internet
  -> Cloudflare free-tier DNS/Tunnel
  -> cloudflared on OVH VPS
  -> loopback-only application origins
       - Capture Web
       - Office Web
       - Foundry Web
       - App API
       - Foundry Service

VPS private runtime
  - PostgreSQL 17 + pgvector
  - Temporal
  - Python AI worker
  - six immutable application images deployed by GitHub Actions

GCP
  - Secret Manager production environment bundle
  - GitHub OIDC/WIF identities
  - Cloudflare Terraform state bucket
```

## Completed Infrastructure

- VPS SSH hardening, UFW policy, Docker, and reusable bootstrap scripts.
- Private production Compose deployment under `expense-tax-management/deploy/production/`.
- GitHub Actions immutable-image build, migration, health check, rollback, and deployment workflow.
- Cloudflare Tunnel with explicit product host/path routing and no public VPS application ports.
- Clerk DNS, SPF/DKIM, DMARC monitoring, signed webhook delivery, and authenticated smoke verification.
- Application-origin body limits, bounded process-local rate limits, security headers, and fail-closed route policy.
- Protected `dev` development branch; production deployment remains restricted to successful `main` CI.

## Current Sources of Truth

| Concern | Path |
|---|---|
| Production deployment workflow | `.github/workflows/expense-tax-deploy.yml` |
| Production Compose and scripts | `expense-tax-management/deploy/production/` |
| Cloudflare Tunnel/DNS Terraform | `infrastructure/cloudflare/expense-tax/` |
| VPS base provisioning | `infrastructure/vps/` |
| Local shared services | `infrastructure/docker-compose.common.yml` |
| App-local development overlay | `expense-tax-management/docker-compose.yml` |

`infrastructure/docker-compose.common.yml`, its Nginx gateway, `expense-service/`, and `frontend/web/` are local/transitional surfaces. They are not the current production edge or canonical application services.

## Remaining Infrastructure Work

| Work | Status | Trigger/owner |
|---|---|---|
| Automated PostgreSQL backup to GCS | Designed only | Separate infrastructure plan and credential approval |
| Restore verification and recovery drill | Not built | Follows backup implementation |
| Production GCS receipt-storage adapter and credentials | Not built; local storage adapter only | Separate storage/infrastructure plan |
| VPS provider migration runbook automation | Partial base bootstrap only | Required before OVH term ends in Feb 2027 |
| Shared-cluster `30-postgres.sh` live proof | Designed, not run on current box | Fresh VPS or second family app |
| Phase 3D mailbox broker Cloud Run project | Planned | Phase 3D-A after Phase 3C |
| Gmail OAuth production verification | Planned with Phase 3D | Start during mailbox implementation; external review may take weeks |
| Search/graph production infrastructure | Deferred | Replan with Phases 6 and 9 |
| Cloud Run deployment for web frontends | Not current architecture | Separate migration/cost decision only |

## Cost and Security Policy

- Keep VPS stateful/orchestration services always-on; no always-on GCP compute.
- Scale-to-zero Cloud Run is allowed only when an approved phase requires it; Phase 3D broker uses `min-instances=0`.
- Cloudflare use stays on free Tunnel/DNS/proxy controls. Paid WAF, distributed rate limiting, Workers, Access, or Cloud Armor requires explicit cost approval.
- Production secrets stay in Secret Manager. Exactly one non-destroyed environment-bundle version remains after rotation.
- PostgreSQL superuser credentials never enter GitHub or GCP.
- VPS origins stay loopback-only. Cloudflare Tunnel is the public ingress path.
- No production mutation, Terraform apply, GCP/Clerk write, workflow dispatch, push, PR creation, or merge without immediate explicit confirmation.

## VPS Provider Switch

OVH availability ends in February 2027. Before migration:

1. Implement and test backup/restore against disposable infrastructure.
2. Select replacement provider and provision reachable Ubuntu host manually.
3. Run `infrastructure/vps/bootstrap.sh` through the provider-specific first-access bridge.
4. Restore PostgreSQL and validate role/schema ownership.
5. Deploy current immutable images with production Compose.
6. Install Cloudflare Tunnel connector and switch ingress only after health checks pass.
7. Monitor for 24 hours before decommissioning old host.

Target cutover remains under two hours after backup/restore automation is proven. Current scripts alone do not meet that target yet.
