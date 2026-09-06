# Phase 1B — Production VPS Deployment (Docker Compose + Traefik)

> **Milestone**: 1 (CI/CD, Deployment & API Gateway)
> **Dependencies**: Phase 0A (Project Bootstrap)
> **Estimated Effort**: 2–3 days

---

## Objective

Create a fully reproducible, IaC-driven production deployment on the OVH VPS using Docker Compose with Traefik as the reverse proxy and API gateway.

---

## Why Traefik Over Caddy or Nginx

We initially considered Caddy for its simplicity and automatic HTTPS. After evaluating all three options against our future architecture requirements (gateway-level AuthN/AuthZ, multi-service Docker Compose, header injection), **Traefik** emerges as the strongest choice:

### Gateway Comparison

| Capability | Caddy | Traefik | Nginx |
| :--- | :--- | :--- | :--- |
| **Automatic HTTPS** | ✅ Built-in (zero config) | ✅ Built-in (Let's Encrypt) | ❌ Manual (Certbot) |
| **Docker-Native Discovery** | ❌ Manual config | ✅ Docker labels (auto-detect new services) | ❌ Manual config |
| **ForwardAuth Middleware** | ⚠️ CVE-2026-30851 header injection vulnerability in `forward_auth` (v2.10–v2.11) | ✅ Mature, battle-tested `ForwardAuth` middleware | ⚠️ Requires Lua module (`lua-resty-openidc`) |
| **Header Propagation** | ⚠️ Requires manual header stripping | ✅ `authResponseHeaders` whitelist (secure by default) | ⚠️ Complex `proxy_set_header` chains |
| **Rate Limiting** | Plugin (custom build) | ✅ Built-in middleware | ✅ Built-in (`limit_req`) |
| **Dashboard / Monitoring** | ❌ None | ✅ Built-in dashboard (API + UI) | ❌ Requires NGINX Plus or 3rd party |
| **Circuit Breaker** | ❌ None | ✅ Built-in middleware | ❌ None |
| **Config Reload on Service Change** | ❌ Manual reload | ✅ Dynamic (watches Docker events) | ❌ `nginx -s reload` |
| **Memory Footprint** | ~50 MB | ~70 MB | ~30 MB |
| **Learning Curve** | Low | Medium | Medium |

### Why Traefik Wins for Our Architecture

1. **Docker-Native Service Discovery**: When we add new microservices to `docker-compose.prod.yml`, Traefik automatically detects them via Docker labels — no config file changes or restarts needed.

2. **Secure ForwardAuth**: Traefik's `ForwardAuth` middleware is the industry-standard approach for gateway-level auth. Unlike Caddy's `forward_auth` (which has an active CVE for header injection), Traefik's `authResponseHeaders` uses an explicit whitelist — only headers you specify are propagated, and client-supplied headers of the same name are **overwritten** (not passed through).

3. **Built-In Operational Middleware**: Rate limiting, circuit breakers, retry logic, and request buffering are all built-in middleware — no plugins or custom builds required.

4. **Future-Proof**: If we ever move to Kubernetes (Phase C in ROADMAP.md), Traefik has first-class `IngressRoute` CRDs. Zero migration friction.

5. **Dashboard**: Built-in monitoring dashboard showing all routers, services, and middleware — invaluable for debugging routing issues.

> [!NOTE]
> Caddy remains excellent for simpler setups. We chose Traefik specifically because of our gateway-level auth requirement and multi-service Docker Compose architecture. If we only needed a reverse proxy + TLS, Caddy would be sufficient.

---

## Architecture

```
Internet
    │
    ▼ (Port 443 only)
┌─────────────────────────────────────────────────────────────────┐
│  Traefik (API Gateway + TLS Termination)                       │
│  ├─ Auto HTTPS via Let's Encrypt                                │
│  ├─ ForwardAuth Middleware → Auth Service (JWT validation)      │
│  ├─ Rate Limiting Middleware (per-tenant, per-IP)               │
│  ├─ Route: Host(`app.example.com`)         → Next.js PWA       │
│  ├─ Route: Host(`api.example.com`)/api/*   → FastAPI Backend   │
│  └─ Route: Host(`temporal.example.com`)    → Temporal UI (dev) │
├─────────────────────────────────────────────────────────────────┤
│  Docker Compose Internal Network (not exposed to internet)      │
│  ├─ fastapi       (Uvicorn, :8000)                              │
│  ├─ postgres      (PostgreSQL 17 + pgvector, :5432)             │
│  ├─ falkordb      (FalkorDB, :6379)                             │
│  ├─ temporal      (Temporal Server, :7233)                      │
│  ├─ temporal-ui   (Temporal Dashboard, :8080)                   │
│  ├─ worker        (Temporal Python Worker)                      │
│  └─ backup        (Nightly pg_dump → GCS)                       │
└─────────────────────────────────────────────────────────────────┘
```

---

## Tasks

### 1. Production Docker Compose (`infrastructure/docker-compose.prod.yml`)

- [ ] Define all services with proper resource limits (`mem_limit`, `cpus`)
- [ ] Traefik service with Docker socket mount and Let's Encrypt ACME
- [ ] PostgreSQL 17 + pgvector with volume persistence and tuned `postgresql.conf`
- [ ] FalkorDB with volume persistence
- [ ] Temporal Server + Temporal Admin Tools + Temporal UI
- [ ] FastAPI expense service (built from `expense-service/Dockerfile`)
- [ ] Temporal Python Worker (built from `expense-service/Dockerfile.worker`)
- [ ] Backup container (nightly `pg_dump` → GCS)
- [ ] Shared Docker network (`expense-net`) for internal communication
- [ ] `.env.example` template with all required secrets

### 2. Traefik Configuration

- [ ] Static config (`infrastructure/traefik/traefik.yml`):
  - ACME Let's Encrypt certificate resolver (TLS-ALPN-01 challenge)
  - Docker provider enabled (watch for label changes)
  - Dashboard enabled (protected by basic auth or ForwardAuth)
  - Access log + JSON structured logging
- [ ] Dynamic config via Docker labels on each service:
  ```yaml
  labels:
    - "traefik.enable=true"
    - "traefik.http.routers.fastapi.rule=Host(`api.example.com`)"
    - "traefik.http.routers.fastapi.tls.certresolver=letsencrypt"
    - "traefik.http.routers.fastapi.middlewares=auth-forward@docker"
  ```

### 3. VPS Bootstrap Script (`infrastructure/scripts/bootstrap.sh`)

- [ ] Install Docker Engine + Docker Compose v2 on Ubuntu 22.04+
- [ ] Clone repository to `/opt/expense-app`
- [ ] Generate `.env` from `.env.example` (prompt for secrets)
- [ ] Pull all Docker images
- [ ] Start services: `docker compose -f docker-compose.prod.yml up -d`
- [ ] Run Alembic migrations
- [ ] Seed default categories
- [ ] Run health checks and print status

### 4. Deployment Script (`infrastructure/scripts/deploy.sh`)

- [ ] Pull latest code from `main`
- [ ] Rebuild changed images: `docker compose build`
- [ ] Rolling restart: `docker compose up -d --remove-orphans`
- [ ] Run pending Alembic migrations
- [ ] Verify all health checks pass
- [ ] Print deployment summary with service versions

### 5. Health Check Script (`infrastructure/scripts/health-check.sh`)

- [ ] Check each service is running and healthy
- [ ] Verify FastAPI `/health` endpoint returns 200
- [ ] Verify PostgreSQL accepts connections
- [ ] Verify Traefik dashboard is accessible
- [ ] Exit with non-zero code on any failure

### 6. VPS Migration Script (`infrastructure/scripts/migrate-vps.sh`)

- [ ] Document step-by-step migration runbook
- [ ] Backup current state → GCS
- [ ] Bootstrap new VPS
- [ ] Restore from GCS backup
- [ ] DNS update instructions
- [ ] Verification checklist

---

## Traefik Docker Labels Example

```yaml
services:
  traefik:
    image: traefik:v3.3
    command:
      - "--api.dashboard=true"
      - "--providers.docker=true"
      - "--providers.docker.exposedByDefault=false"
      - "--entrypoints.web.address=:80"
      - "--entrypoints.websecure.address=:443"
      - "--certificatesresolvers.letsencrypt.acme.tlschallenge=true"
      - "--certificatesresolvers.letsencrypt.acme.email=${ACME_EMAIL}"
      - "--certificatesresolvers.letsencrypt.acme.storage=/letsencrypt/acme.json"
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - "/var/run/docker.sock:/var/run/docker.sock:ro"
      - "letsencrypt:/letsencrypt"

  fastapi:
    build:
      context: ./backend
      dockerfile: Dockerfile
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.api.rule=Host(`api.${DOMAIN}`) && PathPrefix(`/api`)"
      - "traefik.http.routers.api.tls.certresolver=letsencrypt"
      - "traefik.http.routers.api.middlewares=auth-forward@docker,rate-limit@docker"
      - "traefik.http.services.api.loadbalancer.server.port=8000"
```

---

## Definition of Done

- [ ] `docker-compose.prod.yml` brings up all services on a fresh VPS
- [ ] Traefik terminates TLS and routes to correct backends
- [ ] `bootstrap.sh` provisions a fresh VPS from zero to running in < 15 minutes
- [ ] `deploy.sh` deploys latest code with zero downtime
- [ ] `health-check.sh` validates all services after deployment
- [ ] All infrastructure is code — zero manual SSH configuration
