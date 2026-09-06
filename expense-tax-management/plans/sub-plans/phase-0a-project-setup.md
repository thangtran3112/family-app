# Phase 0A — Project Bootstrap & Monorepo Setup

> **Milestone**: 1 (Core Expense Management MVP)
> **Dependencies**: None (first phase)
> **Estimated Effort**: 2-3 days

---

## Objective

Set up the monorepo structure, tooling, and development environment so all subsequent phases have a solid foundation.

---

## Tasks

### 1. Initialize Project Structure

- [x] Set up monorepo directory layout:
  ```
  frontend/
  ├── web/                   — Next.js 16 Client-Side PWA (React 19, Tailwind v4)
  └── mobile/                — Future mobile client (evaluating Flutter for Android, M5)
  expense-service/
  ├── app/                   — FastAPI application (REST APIs, Auth, Services)
  ├── workers/               — Temporal Python Worker (Ingestion, Email, OCR, Graph)
  ├── alembic/               — Database migrations
  └── pyproject.toml         — Python dependencies (FastAPI, SQLAlchemy, Temporal, Graphiti)
  infrastructure/
  ├── docker-compose.yml     — Local dev (macOS): Postgres, FalkorDB, Temporal, FastAPI, Traefik
  ├── docker-compose.prod.yml— Production (Ubuntu self-hosted)
  └── traefik/                 — Traefik gateway config
  ```

### 2. Bootstrap Next.js Client Web App (`frontend/web/`)

- [x] Initialize Next.js 16+ (`v16.3+`) with App Router, Turbopack, and React 19
- [x] Configure as **Client-Side Presentation Layer (PWA)**:
  - Install `@serwist/next` for modern service worker & offline caching
  - Setup `manifest.json` with icons, theme color, standalone display
  - Mobile camera integration (`getUserMedia` and `<input capture="environment">`)
- [x] Set up Tailwind CSS v4 (`v4.3+`) with native `@theme` engine
- [x] Install Radix UI primitives & Shadcn components
- [x] Set up `openapi-typescript` script to generate TypeScript types from FastAPI `openapi.json`

### 3. Bootstrap Python FastAPI Expense Service (`expense-service/`)

- [x] Initialize Python 3.14/3.13 project with `pyproject.toml` (using `uv` or `poetry`):
  - Dependencies: `fastapi>=0.120.0`, `uvicorn>=0.35.0`, `sqlalchemy[asyncio]>=2.0.38`, `asyncpg>=0.30.0`, `alembic>=1.14.0`, `pydantic>=2.10.0`, `pydantic-settings>=2.7.0`
- [x] Set up async database session factory (`app/core/database.py`)
- [x] Initialize Alembic with asyncpg template (`alembic init -t async alembic`)
- [x] Set up FastAPI main application (`app/main.py`) with CORS and OpenAPI docs at `/docs`
- [x] Implement Tenant context middleware (`app/core/middleware.py`)

### 4. Docker Compose for Local Development

- [x] Create `infrastructure/docker-compose.yml` with:
  - PostgreSQL 17+ with pgvector (`pgvector/pgvector:pg17`)
  - Neo4j 5.26+ Community (or FalkorDB)
  - Temporal server (`temporalio/auto-setup`)
   - FastAPI expense-service container
  - Traefik API gateway
- [ ] Create `infrastructure/docker-compose.prod.yml` for Ubuntu self-hosted
- [x] Create `infrastructure/traefik/traefik.yml`:
  - Route `/` → Next.js PWA (port 7331)
   - Route `/api/` → FastAPI Expense Service (port 8000)
  - Route `/temporal/` → Temporal Web UI (port 8233)
- [x] Create `.env.example` with database, GCS, and LLM configuration keys

### 5. Authentication & Multi-Tenancy Setup

- [x] Implement JWT-based auth in FastAPI (`/api/v1/auth/register`, `/api/v1/auth/login`)
- [x] Implement Password Hashing with Argon2 or bcrypt
- [x] Multi-tenancy from day one:
  - `Tenant` model in SQLAlchemy (`tenants` table)
  - First tenant seeded on initialization ("Family")
  - FastAPI dependency `get_current_tenant` enforces tenant scoping on every DB transaction
- [x] Next.js Auth Context & client API layer consuming FastAPI auth endpoints

### 6. Git & CI Setup

- [x] Configure `.gitignore` for monorepo
- [ ] Set up pre-commit hooks (lint, format)
- [x] Create GitHub Actions CI workflow (lint, type-check, test)
- [ ] Establish branch strategy (main → dev → feature branches)

---

## Definition of Done

- [x] `pnpm install` succeeds in `frontend/web/` and `uv sync` in `expense-service/`
- [x] `pnpm --filter web dev` starts the Next.js dev server on port 7331
- [x] `docker compose up` configuration verified
- [x] Alembic environment configured for PostgreSQL 17 with asyncpg
- [x] User registration, login, and tenant resolution tested via pytest
- [x] CI pipeline passes (Ruff lint, pytest, and Next.js build clean)

---

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Frontend | Next.js 16+ (React 19) | Client-side PWA, mobile-first camera scanning, modern UI |
| Backend | Python 3.14 / 3.13 (FastAPI) | High-speed REST API, native AI/agent ecosystem compatibility |
| ORM | SQLAlchemy 2.0 (asyncpg) / SQLModel | Async Python DB access with automatic tenant filtering |
| Migrations | Alembic | Industry standard for Python schema versioning |
| Mobile Future | Flutter (Candidate) | Prime candidate for future Android app (single codebase, native camera; undecided, may not be Expo React Native) |
| Multi-tenancy | Yes, from day one | Tenant-scoped data isolation; first tenant = family |
| Gateway | Traefik v3.3+ | Docker-native API gateway with automatic HTTPS, ForwardAuth, and service discovery |

---

## Reference

- TaxHacker `package.json`: scripts, dependencies list
- TaxHacker `docker-compose.yml`: PostgreSQL service config
- TaxHacker `.env.example`: environment variable patterns
