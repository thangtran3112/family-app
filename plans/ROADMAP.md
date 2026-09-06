# 🗺️ Infrastructure & Deployment Roadmap

> **Project**: Expense Tax Management System
> **Last Updated**: 2026-09-05
> **Companion**: See [PLAN.md](PLAN.md) for feature milestones and architecture.

---

## 📍 Current Situation

| Asset | Details |
| :--- | :--- |
| **VPS** | OVH, 12 GB RAM, available until **Feb 2027** (currently unused) |
| **Risk** | OVH raising rates in 2027; need portability to alternative VPS providers (Database Mart, Hetzner, etc.) |
| **GCP** | Existing project with OAuth client configured; free-tier resources available |
| **Timeline** | Personal project for ~1 year; commercialization is possible but not certain |

### Guiding Principles

1. **VPS-Portable IaC**: Every piece of infrastructure on the VPS must be reproducible from code. Zero manual setup steps.
2. **GCP Free-Tier Only**: Use GCP serverless and on-demand resources exclusively. **No always-on GCP compute.**
3. **Automated Backups to GCP**: Database state is continuously backed up to Google Cloud Storage, enabling rapid recovery on any new VPS.
4. **Provider-Agnostic**: Switching VPS providers should take **< 2 hours** with a tested runbook.

---

## 🏗️ Phase A — Personal Use (Now → Feb 2027)

### Target Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  Google Cloud Platform (Free-Tier / Serverless Only)            │
│                                                                  │
│  ┌──────────────────┐  ┌──────────────────┐  ┌───────────────┐  │
│  │  Cloud Run       │  │  Cloud Storage   │  │  Cloud        │  │
│  │  (min-instances=0│  │  (Receipt files  │  │  Scheduler    │  │
│  │   Next.js PWA)   │  │   & DB backups)  │  │  (Cron jobs)  │  │
│  └────────┬─────────┘  └──────────────────┘  └───────┬───────┘  │
│           │ HTTPS                                     │ Webhook  │
└───────────┼───────────────────────────────────────────┼──────────┘
            │                                           │
            ▼                                           ▼
┌──────────────────────────────────────────────────────────────────┐
│  OVH VPS (12 GB RAM) — Docker Compose via IaC                    │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │ Traefik (API Gateway + TLS + ForwardAuth)                  │ │
│  │  ├─ /api/*  → FastAPI (Uvicorn)                            │ │
│  │  └─ ForwardAuth → JWT validation → X-User-Id headers       │ │
│  ├─────────────────────────────────────────────────────────────┤ │
│  │ FastAPI Backend (Python 3.13+)                              │ │
│  │ PostgreSQL 17 + pgvector                                    │ │
│  │ FalkorDB (Graphiti graph backend, ~100 MB RAM)              │ │
│  │ Temporal Server + Temporal Python Worker                    │ │
│  │ Backup Cron Container (pg_dump → GCS)                       │ │
│  └─────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

### What Runs Where

| Component | Location | Cost | Rationale |
| :--- | :--- | :--- | :--- |
| **Next.js 16 PWA** | GCP Cloud Run (`min-instances=0`) | $0 (free tier: 2M requests/mo) | Global CDN, scale-to-zero, no cold-start concerns for a static-heavy PWA |
| **Receipt & PDF Storage** | GCP Cloud Storage | < $0.15/mo for 5 GB | Scalable, CDN-ready, signed URLs for direct browser upload |
| **Database Backups** | GCP Cloud Storage (separate bucket, Nearline class) | < $0.10/mo | Nearline for infrequent access; 30-day retention lifecycle policy |
| **Cloud Scheduler** | GCP Cloud Scheduler | $0 (free tier: 3 jobs) | Triggers daily Gmail scan and nightly backup verification |
| **FastAPI Backend** | OVH VPS | Included | Sub-millisecond query latency to collocated PostgreSQL & FalkorDB |
| **PostgreSQL 17 + pgvector** | OVH VPS | Included | Primary data store, full-text search, vector similarity |
| **FalkorDB** | OVH VPS | Included | Lightweight graph DB for Graphiti (~100 MB RAM vs. Neo4j's 1.5–3 GB) |
| **Temporal Server + Worker** | OVH VPS | Included | Long-polling workers cannot be serverless; VPS is already always-on |
| **Traefik** | OVH VPS | Included | API gateway with automatic HTTPS, Docker-native service discovery, ForwardAuth for gateway-level AuthN/AuthZ, rate limiting |

### VPS RAM Budget (12 GB)

| Service | Estimated RAM | Notes |
| :--- | :--- | :--- |
| PostgreSQL 17 | ~1.5 GB | `shared_buffers=512MB`, `work_mem=64MB` |
| FalkorDB | ~100 MB | Redis module, vastly lighter than Neo4j |
| Temporal Server | ~500 MB | Go binary, efficient |
| Temporal Worker (Python) | ~500 MB | PaddleOCR model loaded in-process |
| FastAPI (Uvicorn, 2 workers) | ~400 MB | Python + SQLAlchemy + Pydantic |
| Traefik | ~70 MB | API gateway + auto-TLS + ForwardAuth |
| OS + Docker overhead | ~1 GB | Ubuntu base + Docker daemon |
| **Total Used** | **~4.1 GB** | |
| **Available Headroom** | **~7.9 GB** | Comfortable margin for spikes, PaddleOCR inference, future services |

---

## 🔧 Infrastructure as Code (IaC) Strategy

The entire VPS deployment must be reproducible from a single repository checkout. No manual SSH and install steps.

### Repository Structure

```
infrastructure/
├── docker-compose.yml              # Local dev (macOS Docker Desktop)
├── docker-compose.prod.yml         # Production VPS deployment
├── traefik/
│   ├── traefik.yml                 # Static config (ACME, Docker provider, dashboard)
│   └── dynamic/                    # Dynamic config (middleware definitions)
├── postgres/
│   ├── postgresql.conf             # Tuned for 12 GB VPS (shared_buffers, etc.)
│   └── init.sql                    # Extension setup (pgvector, pg_trgm)
├── backup/
│   ├── Dockerfile                  # Lightweight Alpine + pg_dump + gsutil
│   ├── backup.sh                   # pg_dump → compress → gsutil cp to GCS
│   ├── restore.sh                  # gsutil cp → pg_restore
│   └── crontab                     # Nightly backup schedule (inside container)
├── temporal/
│   └── dynamicconfig.yaml          # Temporal server tuning
├── scripts/
│   ├── bootstrap.sh                # One-command VPS setup (install Docker, clone repo, up)
│   ├── deploy.sh                   # Pull latest images, rolling restart
│   ├── health-check.sh             # Verify all services are healthy
│   └── migrate-vps.sh              # Full migration runbook script (see below)
├── .env.example                    # Template for production secrets
└── README.md                       # Deployment documentation
```

### One-Command VPS Bootstrap

```bash
# On a fresh Ubuntu 22.04+ VPS:
curl -fsSL https://raw.githubusercontent.com/<repo>/main/infrastructure/scripts/bootstrap.sh | bash
```

`bootstrap.sh` will:
1. Install Docker Engine + Docker Compose v2
2. Clone the repository
3. Copy `.env.example` → `.env` (prompt for secrets)
4. Pull all Docker images
5. Run `docker compose -f docker-compose.prod.yml up -d`
6. Run Alembic migrations (`uv run alembic upgrade head`)
7. Seed default categories
8. Run `health-check.sh` and print status

### VPS Migration Runbook (`migrate-vps.sh`)

When switching from OVH to another provider (Database Mart, Hetzner, etc.):

```
Step 1: On OLD VPS  → Run backup.sh (final pg_dump → GCS)
Step 2: On NEW VPS  → Run bootstrap.sh (provision from scratch)
Step 3: On NEW VPS  → Run restore.sh (pull latest backup from GCS → pg_restore)
Step 4: Update DNS  → Point domain A record to new VPS IP
Step 5: On NEW VPS  → Run health-check.sh (verify all services)
Step 6: On OLD VPS  → docker compose down (decommission)
```

**Target migration time: < 2 hours** (mostly waiting for DNS propagation).

---

## 💾 Database Backup Strategy

### Automated Nightly Backups

A dedicated lightweight Docker container (`backup/Dockerfile`) runs inside the VPS Docker Compose network:

```yaml
# In docker-compose.prod.yml
backup:
  build: ./infrastructure/backup
  environment:
    - PGHOST=postgres
    - PGUSER=${POSTGRES_USER}
    - PGPASSWORD=${POSTGRES_PASSWORD}
    - PGDATABASE=${POSTGRES_DB}
    - GCS_BUCKET=${BACKUP_GCS_BUCKET}
    - GOOGLE_APPLICATION_CREDENTIALS=/secrets/gcs-sa-key.json
  volumes:
    - ./infrastructure/backup:/scripts:ro
    - ${GCS_SA_KEY_PATH}:/secrets/gcs-sa-key.json:ro
  depends_on:
    - postgres
```

### Backup Flow

```
Nightly (2:00 AM UTC via crontab inside container)
    │
    ├─ pg_dump --format=custom --compress=9 → /tmp/backup_YYYYMMDD.dump
    ├─ gsutil cp → gs://${BACKUP_BUCKET}/postgres/backup_YYYYMMDD.dump
    ├─ FalkorDB: GRAPH.DUMP → gsutil cp → gs://${BACKUP_BUCKET}/falkordb/
    ├─ Prune local: keep last 3 days locally
    └─ GCS Lifecycle: Nearline 30-day retention, auto-delete after 90 days
```

### Backup Verification

**Cloud Scheduler** (GCP free tier) triggers a weekly `POST /api/v1/admin/verify-backup` endpoint that:
1. Lists the latest backup file in GCS
2. Checks timestamp is within 26 hours (guards against missed backups)
3. Checks file size is within expected range (guards against corrupt/empty dumps)
4. Logs result; sends alert email on failure

### Recovery Point Objective (RPO)

| Scenario | Data Loss Window |
| :--- | :--- |
| VPS hardware failure | ≤ 24 hours (nightly backup) |
| Accidental data deletion | ≤ 24 hours (restore from GCS) |
| VPS provider switch | ≤ 24 hours (same backup + restore flow) |

> [!NOTE]
> For tighter RPO (e.g., < 1 hour) in a future commercial scenario, PostgreSQL WAL archiving to GCS can be added. This is not needed for personal use.

---

## ☁️ GCP Services Used (Free-Tier & On-Demand Only)

| GCP Service | Usage | Pricing Tier | Monthly Est. |
| :--- | :--- | :--- | :--- |
| **Cloud Run** | Next.js PWA (scale-to-zero) | Free tier (2M requests, 360K vCPU-s) | $0.00 |
| **Cloud Storage** (Standard) | Receipt images & PDFs | $0.020/GB/mo | < $0.15 |
| **Cloud Storage** (Nearline) | Database backups (90-day retention) | $0.010/GB/mo | < $0.05 |
| **Cloud Scheduler** | 2 cron jobs (daily Gmail scan trigger, weekly backup verify) | Free tier (3 jobs) | $0.00 |
| **Artifact Registry** | Docker images for Cloud Run | Free tier (500 MB) | $0.00 |
| **Secret Manager** | API keys, OAuth tokens | Free tier (6 active versions) | $0.00 |
| **Cloud Build** (optional) | CI/CD pipeline on push | Free tier (120 min/day) | $0.00 |
| **Total GCP** | | | **< $0.25/mo** |

### GCP Services Explicitly Avoided

| Service | Why Not |
| :--- | :--- |
| **Cloud SQL** | Always-on managed PostgreSQL starts at ~$7/mo. VPS is cheaper and already running. |
| **GKE / GCE** | Always-on Kubernetes or VM. Not needed for personal use. |
| **Cloud Functions (Gen 2)** | Considered for the FastAPI backend, but cold starts (3–5s for Python + heavy deps) degrade UX. Also, Temporal workers require persistent connections that Cloud Functions cannot maintain. |
| **Memorystore** | Managed Redis. FalkorDB on VPS is sufficient and free. |

---

## 🔄 Phase B — VPS Provider Switch (Feb 2027+)

### Trigger

OVH contract expires or rates become uncompetitive.

### Candidate Providers

| Provider | Plan | RAM | Storage | Monthly Cost | Notes |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Database Mart** | VPS-2 | 8 GB | 100 GB SSD | ~$8/mo | US-based, good peering |
| **Hetzner Cloud** | CPX31 | 8 GB | 160 GB SSD | ~€10/mo (~$11) | EU (Falkenstein/Helsinki), excellent price-performance |
| **Contabo** | Cloud VPS M | 16 GB | 200 GB SSD | ~$7/mo | Budget option, sometimes slower I/O |
| **Vultr** | Cloud Compute | 8 GB | 160 GB SSD | $48/mo | Premium, global locations |
| **DigitalOcean** | Droplet | 8 GB | 160 GB SSD | $48/mo | Premium, good docs |

### Migration Checklist

- [ ] Run `backup.sh` on current VPS (final backup to GCS)
- [ ] Provision new VPS (Ubuntu 22.04+ LTS)
- [ ] Run `bootstrap.sh` on new VPS
- [ ] Run `restore.sh` (pull latest backup from GCS)
- [ ] Update DNS A record to new VPS IP
- [ ] Run `health-check.sh` on new VPS
- [ ] Verify Next.js PWA (Cloud Run) connects to new API endpoint
- [ ] Update Cloud Scheduler webhook URLs if backend domain changed
- [ ] Monitor for 24h, then decommission old VPS
- [ ] Update `.env` in Secret Manager if any secrets changed

---

## 🚀 Phase C — Commercialization (If/When, 1+ Year Out)

If the project is commercialized, the architecture can evolve toward fully managed GCP services for operational simplicity and scalability. This is **not needed now** and should only be considered when:
- Multiple paying tenants exist
- SLA/uptime requirements exceed what a single VPS provides
- You have revenue to justify the cost increase

### Option C1: Hybrid (Keep VPS for Stateful, GCP for Stateless)

Minimal change from Phase A. Add:
- **Cloud Monitoring + Alerting** for uptime SLA
- **Cloud Armor** (WAF) in front of Cloud Run for DDoS protection
- **Multiple VPS nodes** behind a load balancer for HA (if needed)

**Cost**: ~$15–25/mo (VPS + minimal GCP)

### Option C2: Full GCP Migration (Managed Services)

| Component | Current (VPS) | GCP Managed | Monthly Est. |
| :--- | :--- | :--- | :--- |
| FastAPI Backend | Docker on VPS | **Cloud Run** (scale-to-zero, `min-instances=1` for low latency) | ~$5–15 |
| PostgreSQL + pgvector | Docker on VPS | **Cloud SQL for PostgreSQL** (db-f1-micro + pgvector) | ~$7–15 |
| FalkorDB / Neo4j | Docker on VPS | **Neo4j AuraDB Free** (limited) or **Cloud Memorystore** + FalkorDB module | $0–29 |
| Temporal Server | Docker on VPS | **Temporal Cloud** (managed SaaS) | $0 (free tier: 100 actions/mo) → ~$25/mo at scale |
| Temporal Worker | Docker on VPS | **Cloud Run Jobs** (on-demand, scale-to-zero) | ~$2–5 |
| **Total** | **~$11/mo** | | **~$40–90/mo** |

> [!WARNING]
> Full GCP migration is 4–8× more expensive than VPS for the same workload.
> Only justified when you need managed HA, automated patching, and SLA guarantees
> that a single VPS cannot provide.

### Option C3: Kubernetes (GKE Autopilot)

Only if the system grows to many microservices and needs auto-scaling:
- **GKE Autopilot**: Pay only for pod resources consumed. No node management.
- **Cost**: Starts at ~$70/mo minimum (Autopilot management fee + pod resources).
- **When**: 10+ microservices, multiple workers, high traffic.

> [!CAUTION]
> GKE is overkill for this project unless it reaches significant commercial scale.
> Avoid premature Kubernetes adoption.

---

## 📋 IaC Implementation Tasks (Phase A)

These will be implemented as part of the feature milestones in [PLAN.md](PLAN.md):

| Task | Implemented In | Status |
| :--- | :--- | :--- |
| GitHub Actions CI (backend + frontend) | Phase 1A (CI/CD Pipeline) | ⚪ Planned |
| `docker-compose.prod.yml` (production stack) | Phase 1B (VPS Deployment) | ⚪ Planned |
| Traefik config (API gateway + auto-TLS + ForwardAuth) | Phase 1B / 1C (VPS + Gateway Auth) | ⚪ Planned |
| `bootstrap.sh` (one-command VPS setup) | Phase 1B (VPS Deployment) | ⚪ Planned |
| `deploy.sh` (pull + rolling restart) | Phase 1A / 1B (CI/CD + VPS) | ⚪ Planned |
| `health-check.sh` (service verification) | Phase 1B (VPS Deployment) | ⚪ Planned |
| `migrate-vps.sh` (provider switch runbook) | Phase 1B (VPS Deployment) | ⚪ Planned |
| Gateway AuthN/AuthZ (JWT + header injection) | Phase 1C (Gateway Auth) | ⚪ Planned |
| `backup.sh` + `restore.sh` + backup Dockerfile | Phase 0D (Cloud Storage) | ⚪ Planned |
| Cloud Run deployment (Next.js) | Phase 0F (Web UI) | ⚪ Planned |
| Cloud Scheduler cron jobs | Phase 3D (Email Scanning) | ⚪ Planned |
| GCS lifecycle policies | Phase 0D (Cloud Storage) | ⚪ Planned |

---

## 📎 References

- [Docker Compose Production Best Practices](https://docs.docker.com/compose/production/)
- [Traefik v3 Documentation](https://doc.traefik.io/traefik/)
- [GCS Nearline Storage Class](https://cloud.google.com/storage/docs/storage-classes#nearline)
- [Cloud Run Pricing (Free Tier)](https://cloud.google.com/run/pricing)
- [Cloud Scheduler Free Tier](https://cloud.google.com/scheduler/pricing)
- [Temporal Cloud Pricing](https://temporal.io/pricing)
- [FalkorDB vs Neo4j Benchmarks](https://www.falkordb.com/)
- [pg_dump Documentation](https://www.postgresql.org/docs/17/app-pgdump.html)
