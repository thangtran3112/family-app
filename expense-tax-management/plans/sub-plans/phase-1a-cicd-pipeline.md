# Phase 1A — GitHub Actions CI/CD Pipeline

> **Replan required (2026-09-07)**: Keep useful GitHub Actions patterns below, but replace single FastAPI/Next.js jobs with a polyglot matrix for App API, Foundry Service, Python worker, three clients, generated-contract drift, migrations, service authorization, and fake-provider integration. Begin revised CI immediately after Phase 0I and extend it at each later phase boundary.

> **Milestone**: 1 (CI/CD, Deployment & API Gateway)
> **Dependencies**: Phase 0A (Project Bootstrap), Phase 0B (Data Model)
> **Estimated Effort**: 2 days

---

## Objective

Set up automated CI/CD pipelines that lint, test, and build both backend and frontend on every push, and deploy to the OVH VPS on merges to `main`.

---

## Architecture

```
Developer pushes to GitHub (main or dev)
         │
         ▼
┌─────────────────────────────────────────────────────┐
│  GitHub Actions Workflow                            │
│  ┌─────────────────────┐  ┌──────────────────────┐  │
│  │  backend-ci.yml     │  │  frontend-ci.yml     │  │
│  │  ├─ Lint (Ruff)     │  │  ├─ Lint (ESLint)    │  │
│  │  ├─ Type Check      │  │  ├─ Type Check (tsc) │  │
│  │  ├─ Unit Tests      │  │  ├─ Build (next)     │  │
│  │  └─ Build Image     │  │  └─ Build Image      │  │
│  └─────────┬───────────┘  └──────────┬───────────┘  │
│            └───────────┬─────────────┘              │
│                        ▼                             │
│  ┌───────────────────────────────────────────────┐  │
│  │  deploy.yml (on merge to main)               │  │
│  │  ├─ SSH to OVH VPS                           │  │
│  │  ├─ Pull latest images / git pull            │  │
│  │  ├─ docker compose up -d (rolling restart)   │  │
│  │  ├─ Run Alembic migrations                   │  │
│  │  └─ Health check verification                │  │
│  └───────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

---

## Tasks

### 1. Backend CI Workflow (`.github/workflows/backend-ci.yml`)

- [ ] Trigger on push to `main`, `dev`, and PRs to `main`/`dev`
- [ ] Set up Python 3.13 via `astral-sh/setup-uv@v5`
- [ ] Install dependencies: `uv sync --all-extras --dev`
- [ ] Lint: `uv run ruff check app tests`
- [ ] Format check: `uv run ruff format --check app tests`
- [ ] Type check: `uv run mypy app` (if mypy is configured)
- [ ] Unit tests: `uv run pytest tests/ -v --tb=short`
- [ ] Cache `uv` dependencies for faster runs

### 2. Frontend CI Workflow (`.github/workflows/frontend-ci.yml`)

- [ ] Trigger on push to `main`, `dev`, and PRs to `main`/`dev`
- [ ] Set up Node.js 24 via `actions/setup-node@v4`
- [ ] Install via `pnpm install --frozen-lockfile`
- [ ] Lint: `pnpm run lint`
- [ ] Type check: `pnpm run type-check` (if script exists)
- [ ] Build: `pnpm run build`
- [ ] Cache `pnpm` store for faster runs

### 3. Deploy Workflow (`.github/workflows/deploy.yml`)

- [ ] Trigger on push to `main` only (after CI passes)
- [ ] Use GitHub Environments (`production`) for deployment protection
- [ ] Store VPS SSH key as GitHub Secret (`VPS_SSH_KEY`)
- [ ] Store VPS host/user as GitHub Secrets (`VPS_HOST`, `VPS_USER`)
- [ ] SSH to VPS and execute deployment script:
  ```bash
  ssh $VPS_USER@$VPS_HOST "cd /opt/expense-app && ./infrastructure/scripts/deploy.sh"
  ```
- [ ] Run health check after deployment
- [ ] Send notification on failure (GitHub Actions built-in)

### 4. Deployment Script (`infrastructure/scripts/deploy.sh`)

- [ ] Pull latest code: `git pull origin main`
- [ ] Pull latest Docker images (if using registry) or rebuild locally
- [ ] Run `docker compose -f docker-compose.prod.yml up -d --build`
- [ ] Wait for health checks to pass
- [ ] Run Alembic migrations: `docker compose exec backend uv run alembic upgrade head`
- [ ] Print deployment summary

### 5. GitHub Repository Configuration

- [ ] Add repository secrets: `VPS_SSH_KEY`, `VPS_HOST`, `VPS_USER`
- [ ] Configure branch protection on `main` (require CI to pass before merge)
- [ ] Optional: Add `dev` branch for staging deployments

---

## Definition of Done

- [ ] Pushing to `main` or `dev` triggers backend + frontend CI
- [ ] All lint, test, and build steps pass in CI
- [ ] Merging to `main` triggers automated deployment to OVH VPS
- [ ] Health check confirms services are running after deploy
- [ ] Deployment failures send notifications
