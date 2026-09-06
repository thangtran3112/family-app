# AGENTS.md — Expense Tax Management

> Project-level rules and context for AI agents working on this codebase.

---

## Project Overview

This is a multi-tenant, AI-powered expense management system built as a monorepo.
See [`plans/PLAN.md`](plans/PLAN.md) for the full architecture and milestone roadmap.
See [`plans/ROADMAP.md`](plans/ROADMAP.md) for infrastructure and deployment strategy.

---

## Architecture & Stack

| Layer | Technology | Notes |
| :--- | :--- | :--- |
| **Frontend** | Next.js 16+ (client-side PWA) | `frontend/web/`, strictly presentation layer, no service logic |
| **Expense Service** | Python 3.13+ / FastAPI | `expense-service/`, expense-domain APIs, OCR, AI, DB access |
| **Shared Contracts** | Python package | `common/python/expense-contracts/`, reusable Pydantic DTOs and transport-safe enums |
| **Database** | PostgreSQL 17 + pgvector | SQLAlchemy 2.0, Alembic migrations |
| **Graph DB** | FalkorDB (Graphiti) | Temporal knowledge graph for relational expense queries |
| **Workflow** | Temporal Python SDK | Async ingestion, dedup, auto-tag, Gmail scan |
| **Gateway** | Traefik v3.3+ | API gateway, auto-TLS, ForwardAuth for AuthN/AuthZ |
| **Storage** | Google Cloud Storage | Receipt images, PDFs, database backups |
| **Deployment** | Docker Compose on VPS | OVH VPS (12 GB RAM), IaC-portable to any provider |

---

## Coding Conventions

### Expense Service (Python)

- **Package manager**: `uv` (not pip, not poetry)
- **Linting**: `cd expense-service && uv run ruff check .`
- **Formatting**: `cd expense-service && uv run ruff format .`
- **Tests**: `cd expense-service && uv run python -m pytest tests/ -v`
- **API routes**: Always use `/api/v1/...` prefix
- **Models**: SQLAlchemy 2.0 declarative with `Mapped[]` type annotations
- **Schemas**: Pydantic v2 (`BaseModel`) for all API request/response types
- **Multi-tenancy**: Every database query MUST be scoped by `tenant_id`
- **LLM calls**: Always check `tenant.llm_monthly_used < tenant.llm_monthly_budget` before making LLM API calls
- **Imports**: Use absolute imports (`from app.models.expense import Expense`)
- **Async**: Use `async def` for all API endpoints and DB operations (via `asyncpg`)
- **Shared contracts**: Import reusable Pydantic DTOs/enums from `expense_contracts`; keep SQLAlchemy models and Alembic migrations service-owned

### Frontend (Next.js)

- **Package manager**: `pnpm` (not npm, not yarn)
- **Build**: `pnpm run build`
- **Lint**: `pnpm run lint`
- **Styling**: Tailwind CSS v4 with `@theme` engine
- **Components**: React 19+ with Radix UI primitives
- **API client**: Typed OpenAPI client generated from FastAPI's `/openapi.json`
- **Role**: Strictly client-side presentation. NO direct database connections, NO ORM, NO backend workers
- **Mockup preflight (mandatory)**: every frontend phase/task/sub-plan requires a preflight producing reviewed mockups in `plans/mockups/` first (see `plans/sub-plans/phase-0f0-web-ui-mockups.md` for the 0F gate). No `frontend/web` implementation starts until its preflight is ✅ Complete.

### General

- **Docstrings**: Preserve all existing docstrings and comments unless explicitly asked to modify
- **Tests first**: Write or verify tests before implementing features or bug fixes (TDD)
- **Verification**: Always run `uv run ruff check .` and `uv run pytest` before claiming backend work is complete
- **Git**: Do NOT create feature branches. The user controls branching. Make changes on the current branch.
- **CI/CD**: GitHub Actions workflows live in `.github/workflows/`

### Structural Code Exploration

- Use **CodeGraph** first for framework-oriented source flows: FastAPI routes and dependencies, Next.js/React components, SQLAlchemy call paths, and Temporal workflows and activities.
- Use **codebase-memory-mcp** first for architecture overviews, infrastructure-as-code, cross-service boundaries, git-diff impact, broad custom code, and dead-code analysis.
- Use **Graphify** only for explicit documentation or media mapping; it is not the primary source-code index.
- Keep both code indexes local and automatically synchronized; do not add generated graph databases to source control.
- Treat graph output as navigation evidence, not proof of tenant isolation, security behavior, or dynamic dispatch. Verify those claims in source and tests.

---

## Directory Structure

```
family-app/                            # New git root (renamed from expense-tax-management)
  ├── infrastructure/                  # Shared stack
  │   ├── docker-compose.common.yml    # postgres (pgvector), neo4j, temporal, gateway
  │   ├── nginx/nginx.conf
  │   ├── postgres/init-multiple-dbs.sh
  │   └── .env.example
  ├── expense-tax-management/          # This app — retains opencode.json & .opencode/
  │   ├── frontend/
  │   │   └── web/                     # Next.js 16 PWA (pnpm)
  │   ├── expense-service/             # Python FastAPI expense service (uv)
  │   │   ├── app/
  │   │   │   ├── api/v1/              # API endpoints
  │   │   │   ├── core/                # Config, security, middleware
  │   │   │   ├── models/              # SQLAlchemy models
  │   │   │   ├── schemas/             # Pydantic v2 schemas (re-exports expense-contracts)
  │   │   │   └── services/            # Business logic services
  │   │   ├── workers/                 # Temporal Python workers
  │   │   ├── alembic/                 # Database migrations
  │   │   └── tests/                   # pytest test suites
  │   ├── common/
  │   │   └── python/
  │   │       └── expense-contracts/   # Shared Pydantic DTOs and transport enums
  │   ├── plans/                       # Architecture plans & sub-plans
  │   ├── docs/                        # Architecture docs, ADRs
  │   ├── opencode.json                # Retained here (projectRoot = this subfolder)
  │   └── .opencode/                   # Retained sessions & rules
  └── <future-family-app>/             # Sibling app, same pattern, reuses ../infrastructure
```

---

## Testing

### Expense Service Tests

```bash
cd expense-service
uv run python -m pytest tests/ -v --tb=short
```

- SQLite with custom compilation hooks (`expense-service/app/core/sqlite_compat.py`) is used for fast in-memory unit tests
- PostgreSQL-specific features (`TSVECTOR`, `ARRAY`, `pgvector`) have SQLite compile-time stubs

### Frontend Tests

```bash
cd frontend/web
pnpm run build   # Type-check + build verification
pnpm run lint     # ESLint
```

---

## Gateway Authentication Pattern

This project uses **Traefik ForwardAuth** for centralized gateway-level authentication.

- Traefik validates JWT tokens via a `/auth/verify` endpoint on the FastAPI expense service
- On success, Traefik injects trusted identity headers into downstream requests:
  - `X-User-Id`, `X-Tenant-Id`, `X-User-Email`, `X-User-Role`, `X-User-Name`
- Expense services read these headers directly — no per-service JWT validation needed
- Public routes (login, register, health) bypass ForwardAuth via separate Traefik routers

When adding new API endpoints:
- Protected routes: Apply `auth-forward@docker` middleware via Traefik labels
- Public routes: Create a separate router without the auth middleware
- Read identity: Use `get_current_user(request)` from `expense-service/app/core/gateway_auth.py`

---

## GitHub Access

The `gh` CLI is authenticated and available with the following capabilities:

- **Account**: `thangtran3112`
- **Repository**: `thangtran3112/family-app`
- **Permissions**: admin, maintain, pull, push, triage
- **Token scopes**: `gist`, `read:org`, `repo`, `workflow`

### Available Operations via `gh` CLI

```bash
# Workflow management
gh workflow list                          # List all workflows
gh workflow view <name>                   # View workflow details
gh run list                               # List recent workflow runs
gh run view <run-id> --log                # View workflow run logs

# Repository settings
gh api repos/{owner}/{repo}               # Read repo settings
gh api -X PATCH repos/{owner}/{repo} -f <field>=<value>  # Update settings

# Secrets management
gh secret set <name> --body <value>       # Set repository secret
gh secret list                            # List repository secrets

# Branch protection
gh api repos/{owner}/{repo}/branches/main/protection  # View protection rules

# Issues & PRs
gh issue list / gh pr list                # List issues/PRs
gh pr create --title "..." --body "..."   # Create PRs
```

### What I Can Do

- ✅ Create, edit, and debug GitHub Actions workflows
- ✅ Manage repository secrets (VPS_SSH_KEY, VPS_HOST, etc.)
- ✅ Configure branch protection rules
- ✅ View workflow run logs and debug failures
- ✅ Create issues and PRs
- ✅ Manage repository settings
- ✅ Push commits via `git push`

No additional setup is needed — the `gh` CLI token already has `repo` and `workflow` scopes.

---

## Milestone Phase Numbering

Milestones use **spaced numbering** (0, 3, 6, 9, 12) to allow inserting new milestones without renumbering:

| Milestone | Description | Status |
| :--- | :--- | :--- |
| **0** | Core Expense Management (MVP) | 🟡 In Progress |
| **1** | CI/CD, Deployment & API Gateway | ⚪ Planned |
| **3** | Ingestion Pipeline, Email Scanning & Auto-Tagging | ⚪ Planned |
| **6** | Search & AI Query | ⚪ Planned |
| **9** | Graph RAG & Knowledge Graph | ⚪ Planned |
| **12** | Mobile App (Flutter, deferred) | ⚪ Planned |

---

## Important Constraints

1. **No always-on GCP compute** — Use GCP only for free-tier serverless (Cloud Run scale-to-zero, Cloud Storage, Cloud Scheduler)
2. **VPS-portable IaC** — All VPS infrastructure must be reproducible via `bootstrap.sh` for easy provider switching
3. **No Gemini Flash** for OCR — Use OpenRouter, OpenAI, or PaddleOCR
4. **Multi-tenant from day one** — All queries scoped by `tenant_id`, even for single-user usage
5. **FalkorDB over Neo4j** — Lightweight graph DB (~100 MB RAM vs. 1.5–3 GB for Neo4j)
6. **Traefik over Nginx/Caddy** — Docker-native discovery, ForwardAuth for gateway auth
