# Phase 0I - Polyglot Platform Rebaseline Implementation Plan

> **Date**: 2026-09-07
> **Status**: In progress
> **Approved design**: [Phase 0I Polyglot Platform Rebaseline Design](phase-0i-polyglot-platform-rebaseline-design.md)
> **Scope**: TypeScript workspace, canonical contracts, App API and Foundry skeletons, service authentication, database ownership, generated Python DTOs, local containers, and verification harness
> **Execution model**: GPT-5.6 Sol orchestrates and reviews; OpenCode GPT-5.6 Luna with `xhigh` thinking implements one task at a time

## 1. Goal

Establish the smallest production-shaped foundation required before customer-domain work begins in Phase 0J.

Phase 0I ends with:

- One pnpm workspace containing `packages/contracts`, `services/app-api`, and `services/foundry-service` alongside transitional `frontend/web`.
- Canonical Zod v4 transport schemas producing deterministic JSON Schema, OpenAPI documents, TypeScript client types, and generated Pydantic v2 DTOs.
- Independently startable Fastify application factories and server entrypoints for App API and Foundry.
- Tenant, platform, and service-token verification primitives with exact issuer, audience, principal, role, and scope checks.
- Kysely-based, service-owned PostgreSQL migration/runtime foundations with separate App and Foundry schemas and credentials.
- Local Compose services and one-shot migration jobs that never give runtime services migration credentials.
- Essential contract, auth, health, OpenAPI, database-isolation, and Compose-boundary tests plus lint, type-check, and build checks.

## 1.1 Velocity and Compatibility Policy

Phase 0I is velocity-first and may make breaking changes to prototype code, scripts, package layout, generated artifacts, and local development setup.

- Do not add backward-compatibility adapters, deprecated aliases, dual configuration names, dual writes, or transitional shims.
- Approved architecture and security boundaries remain mandatory; “breaking changes allowed” never weakens isolation, authorization, or credential controls.
- Preserve unrelated user/mockup edits, but compatibility with current FastAPI/front-end behavior is not a Phase 0I gate.
- Add only tests that protect cross-language contracts, public health/readiness behavior, authentication boundaries, generated-artifact parity, or database/credential isolation.
- Do not add unit tests for trivial getters, package metadata, script wiring, framework behavior, compiler-enforced types, generated code internals, or one-line configuration accessors.
- Listed essential behavioral tests still follow red-green. Configuration/scaffolding tasks use direct static/build verification under user's explicit TDD exception.

## 2. Explicit Non-Goals

Do not implement these in Phase 0I:

- Registration, login, tenant CRUD, Personal profiles, businesses, projects, expenses, categories, or FastAPI endpoint parity. Phase 0J owns them.
- Plans, add-ons, entitlement snapshots, provider catalog, AI modes, quotas, reservations, or telemetry. Phases 0J1 and 0K own them.
- Temporal clients, workflows, activities, worker processes, or `services/ai-worker`. Phase 0L owns them.
- GCS uploads, OCR, email forwarding, mailbox scanning, search, tax reports, or exports.
- Frontend application creation or mockup approval.
- Production gateway routing or production deployment hardening.
- FastAPI, SQLAlchemy, Alembic, `frontend/web`, or legacy Python contract removal. They remain transitional until later parity and cutover tasks.
- Legacy data migration, backfill, or dual writes. Development data may be reset.

## 3. Fixed Technical Decisions

| Concern | Decision | Evidence |
|---|---|---|
| Node runtime | Node.js 24; package engines `>=22.0.0` | Local Node is 24.16.0; Kysely requires Node 22+; Vitest 5 supports Node 22.12+/24+ |
| Package manager | pnpm 11.9.0, one root lockfile | Existing root package manager and workspace |
| HTTP framework | Fastify 5.12+ | Approved design; application-factory and `inject()` testing patterns verified against current Fastify docs |
| Runtime schemas | Zod 4.5+ with `fastify-type-provider-zod` 7 | Provider peer range supports Fastify 5 and Zod 4 |
| OpenAPI | `@fastify/swagger` 9.8+ and deterministic checked-in JSON | Separate App and Foundry documents; no runtime dependency on docs UI |
| TypeScript clients | `openapi-typescript` 7.13+ plus maintained `openapi-fetch` factories | Generated route types, no handwritten request shapes |
| Python DTO generation | `datamodel-code-generator==0.76.2`, Pydantic v2 output, timestamps disabled | Deterministic generated artifact |
| Database access | Kysely 0.29+ with `pg`; Kysely `Migrator` and `FileMigrationProvider` | Typed SQL, explicit schemas, migration locking, no ORM model duplication |
| Token verification | `jose` 6.2+ | Exact JWT issuer/audience/signature checks; injected local keys in tests and remote JWKS in runtime |
| TypeScript tests | Vitest 5 and Fastify `inject()` | Minimal boundary tests without listening sockets; no test-per-helper policy |
| Formatting/lint | TypeScript compiler plus ESLint 9; existing Ruff for generated Python package | Matches repository conventions |
| Builder model | `openai/gpt-5.6-luna`, variant `xhigh` | Primary implementation model; active and on same provider as orchestrator |
| Orchestrator model | `openai/gpt-5.6-sol` | Current session and user requirement |

Approved fallback order if Luna is unavailable for a new task:

1. OpenCode Zen Muse Spark 1.3: `opencode/muse-spark-1.3-contributor-free`
2. OpenCode Go Muse Spark 1.3: `opencode-go/muse-spark-1.3-contributor`
3. OpenCode Zen Muse Spark 1.2 free: `opencode/muse-spark-1.2-contributor-free`

Every fallback also uses variant `xhigh`. Never switch model during a task retry without recording why; resume the original OpenCode session first.

Dependency versions above are minimum compatible lines. `pnpm-lock.yaml` and Python `uv.lock` hold exact resolved versions.

## 4. Initial-State Findings

- Git root is `family-app/`; project lives in `expense-tax-management/`.
- `pnpm-workspace.yaml` currently includes only `frontend/*`.
- Root scripts still target `frontend/web` and `expense-service`.
- `opencode.json`, `AGENTS.md`, and `.opencode/rules/*` still describe FastAPI as target architecture.
- Current FastAPI app creates tables at startup and owns auth, CRUD, storage, and SQLAlchemy models.
- Current Python `expense-contracts` package manually owns expense DTOs and enums.
- Shared PostgreSQL currently exposes one superuser-backed `expense_tax_db`.
- Compose resolves overlay paths relative to `infrastructure/docker-compose.common.yml`; current `./expense-service` therefore resolves to nonexistent `infrastructure/expense-service`.
- Existing worktree contains unrelated and approved planning/mockup edits. Every builder must preserve them.

## 5. Target Layout Created by Phase 0I

```text
expense-tax-management/
|-- .opencode/
|   |-- agents/phase-0i-builder.md
|   `-- rules/
|-- common/python/expense-contracts/
|   `-- src/expense_contracts/generated/
|-- docker/postgres/zz-20-expense-tax-roles.sh
|-- packages/contracts/
|   |-- fixtures/
|   |-- generated/
|   |   |-- json-schema/
|   |   |-- openapi/
|   |   `-- typescript/
|   |-- scripts/
|   |-- src/
|   `-- test/
|-- scripts/
|-- services/
|   |-- app-api/
|   |   |-- scripts/
|   |   |-- src/
|   |   |   |-- auth/
|   |   |   |-- database/migrations/
|   |   |   |-- plugins/
|   |   |   `-- routes/
|   |   `-- test/
|   `-- foundry-service/
|       |-- scripts/
|       |-- src/
|       |   |-- auth/
|       |   |-- database/migrations/
|       |   |-- plugins/
|       |   `-- routes/
|       `-- test/
|-- test/integration/
|-- .dockerignore
|-- eslint.config.mjs
`-- tsconfig.base.json
```

## 6. Orchestration Protocol

GPT-5.6 Sol owns task sequencing, review, and verification. Builders never self-approve.

For Task 0, before project agent configuration exists:

```bash
opencode run --agent build --model openai/gpt-5.6-luna \
  --variant xhigh \
  --dir /Users/toby.tran/personal/family-app/expense-tax-management \
  --title "Phase 0I Task 0" \
  "Implement Task 0 from plans/sub-plans/phase-0i-polyglot-platform-rebaseline-implementation.md exactly. Use TDD where behavior exists. Preserve all unrelated worktree changes. Do not commit."
```

For later tasks:

```bash
opencode run --agent phase-0i-builder \
  --variant xhigh \
  --dir /Users/toby.tran/personal/family-app/expense-tax-management \
  --title "Phase 0I Task N" \
  "Implement Task N from plans/sub-plans/phase-0i-polyglot-platform-rebaseline-implementation.md exactly. Run listed focused checks. Preserve unrelated changes. Do not commit."
```

Execution rules:

1. Run one builder at a time. Tasks share workspace and lockfiles.
2. Before dispatch, Sol records `git status --short` and identifies files builder may touch.
3. Builder writes failing tests first only for essential boundary behavior listed in Section 1.1, confirms expected failure, then implements minimum code. Scaffolding/configuration relies on direct verification.
4. Builder may touch only task-listed files plus lockfiles and generated artifacts caused by listed commands.
5. Builder does not edit mockups, architecture decisions, unrelated legacy plans, or transitional FastAPI code unless task explicitly says so.
6. Builder never commits, pushes, resets, checks out, stashes, or cleans worktree.
7. Sol reviews diff after every task, checks scope, reruns focused checks, and rejects scope creep.
8. Sol runs full Phase 0I gate only after all focused tasks pass.
9. Commits remain user-controlled. Logical checkpoints appear below, but no commit command runs without explicit user authorization.
10. Every implementation or review subagent uses `xhigh` thinking.

Unless a step says otherwise, every command runs with this working directory:

```text
/Users/toby.tran/personal/family-app/expense-tax-management
```

Paths in task file lists are relative to that directory. `infrastructure/*` is outside Phase 0I edit scope; the app overlay may reference it but builders must not modify it.

## 7. Task Dependency Graph

```text
0 Agent context
`-> 1 Workspace
    `-> 2 Canonical contracts
        `-> 3 App API skeleton
            `-> 4 Foundry skeleton
                `-> 5 App auth
                    `-> 6 Foundry auth
                        `-> 7 App database
                            `-> 8 Foundry database
                                `-> 9 Artifact generation
                                    `-> 10 PostgreSQL/Compose isolation
                                        `-> 11 Cross-service verification and documentation
```

Task 9 requires Tasks 2-4. Task 10 requires Tasks 2-4 and 7-8. Task 11 requires every prior task. Tasks 3/4, 5/6, and 7/8 are logically independent pairs, but execute sequentially because they share root lockfile and application-factory files.

## 8. Detailed Tasks

### Task 0: Rebaseline Agent Context and Configure Luna Builder

**Files**

- Modify: `AGENTS.md`
- Modify: `opencode.json`
- Modify: `.opencode/README.md`
- Replace contents: `.opencode/rules/expense-service.rules`
- Modify: `.opencode/rules/frontend.rules`
- Create: `.opencode/agents/phase-0i-builder.md`

**Step 1: Write configuration assertions before edits**

Capture expected failure:

```bash
opencode debug agent phase-0i-builder
```

Expected: agent not found or no project-defined builder.

Search stale target claims:

```bash
rg -n "FastAPI|Python-first|frontend/web|monthly budget|ForwardAuth.*no per-service" AGENTS.md .opencode opencode.json
```

Expected: stale architecture matches exist.

**Step 2: Make `opencode.json` schema-valid**

Remove custom non-OpenCode keys such as `projectRoot`, `frontend`, `expenseService`, `conventions`, and `paths`.

Keep only supported configuration:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "openai/gpt-5.6-sol",
  "small_model": "openai/gpt-5.6-luna",
  "instructions": [
    "AGENTS.md",
    ".opencode/rules/*.rules"
  ]
}
```

Do not place provider credentials or environment values in repository config.

**Step 3: Define project builder**

Create `.opencode/agents/phase-0i-builder.md` with:

- `mode: subagent`
- `model: openai/gpt-5.6-luna`
- `variant: xhigh`
- low temperature
- edit and focused Bash permission
- task delegation denied
- prompt requiring one numbered plan task, TDD, smallest diff, no commits, no destructive Git, and preservation of unrelated worktree changes

**Step 4: Rewrite agent guidance**

`AGENTS.md` and `.opencode` guidance must state:

- App API and Foundry are Fastify/Zod/Kysely services.
- Python is worker-only and cannot access App/Foundry PostgreSQL.
- Zod contracts are canonical; generated files are read-only.
- Every customer resource requires explicit Personal/business scope authorization; tenant role alone never grants profile access.
- Foundry tenant tokens are always invalid.
- Runtime and migration database credentials are separate.
- Transitional `expense-service` and `frontend/web` remain untouched until their owning cutover phases.
- Frontend mockup gates remain application-specific.

**Step 5: Verify resolved agent without printing resolved global config**

```bash
opencode debug agent phase-0i-builder
```

Expected: model resolves to provider `openai`, model `gpt-5.6-luna`, variant `xhigh`, mode `subagent`.

Never run `opencode debug config` in logs because resolved output may include provider secrets.

```bash
rg -n "FastAPI.*core backend|Python-first|no per-service JWT|llm_monthly" AGENTS.md .opencode opencode.json
```

Expected: no active target-architecture claims; historical references must be explicitly marked transitional.

**Logical checkpoint**: agent context matches approved architecture.

### Task 1: Create TypeScript Workspace Foundation

**Files**

- Modify: `package.json`
- Modify: `pnpm-workspace.yaml`
- Modify: `pnpm-lock.yaml`
- Create: `tsconfig.base.json`
- Create: `eslint.config.mjs`

**Step 1: Capture current workspace state**

Inspect `pnpm-workspace.yaml` and root `package.json`, then record these expected changes in builder report:

- workspace includes `frontend/*`, `services/*`, and `packages/*`
- package manager is pnpm 11.9.0
- root exposes `lint`, `typecheck`, `test`, `build`, `contracts:generate`, and `contracts:check`
- root no longer treats legacy FastAPI as target API through default scripts
- legacy scripts remain available under explicit `legacy:*` names

No unit test: package metadata and workspace globs are configuration covered by pnpm install and package-target commands.

**Step 2: Expand workspace and root scripts**

Use package names:

- `@expense-tax/contracts`
- `@expense-tax/app-api`
- `@expense-tax/foundry-service`

Root scripts must use recursive pnpm filters and keep transitional commands explicit:

- `dev:app-api`
- `dev:foundry`
- `lint`
- `typecheck`
- `test`
- `build`
- `contracts:generate`
- `contracts:check`
- `db:migrate:app`
- `db:migrate:foundry`
- `test:integration`
- `verify:phase-0i`
- `legacy:frontend:*`
- `legacy:expense-service:*`

Exact legacy rename map:

| Current script | Replacement key |
|---|---|
| `dev:frontend` | `legacy:frontend:dev` |
| `build:frontend` | `legacy:frontend:build` |
| `lint:frontend` | `legacy:frontend:lint` |
| `gen:api` | `legacy:frontend:gen-api` |
| `expense-service:dev` | `legacy:expense-service:dev` |
| `expense-service:test` | `legacy:expense-service:test` |
| `docker:up` | replaced by `compose:up` in Task 10 |
| `docker:down` | replaced by `compose:down` in Task 10 |

Exact aggregate behavior after all Phase 0I packages exist:

| Script | Required body/behavior |
|---|---|
| `lint` | run `lint` in exactly contracts, App API, and Foundry packages |
| `typecheck` | run `typecheck` in exactly contracts, App API, and Foundry packages |
| `test` | run package tests for contracts, App API, and Foundry |
| `build` | build contracts before App API and Foundry |
| `contracts:generate` | JSON Schema, App OpenAPI, Foundry OpenAPI, TS client types, then Python DTOs |
| `contracts:check` | regenerate in temporary directories and byte-compare expected artifacts |
| `db:migrate:app` | run App API migration entrypoint only |
| `db:migrate:foundry` | run Foundry migration entrypoint only |
| `test:integration` | `vitest run test/integration`; runs Compose boundary and PostgreSQL role-isolation tests |
| `verify:phase-0i` | run `scripts/verify-phase-0i.mjs` |

Use explicit package filters. Do not use a broad recursive command that silently omits one required Phase 0I package.

Do not implement script targets that silently skip missing required packages. `--if-present` is acceptable only for transitional packages outside Phase 0I scope.

**Step 3: Add shared TypeScript and ESLint configuration**

`tsconfig.base.json` requirements:

- target `ES2023`
- module and resolution `NodeNext`
- `strict: true`
- `noUncheckedIndexedAccess: true`
- `exactOptionalPropertyTypes: true`
- declarations and source maps enabled
- no path alias that bypasses package exports

Root ESLint config covers `services/**/*.ts`, `packages/**/*.ts`, `scripts/**/*.ts`, and TypeScript tests. Ignore generated files, `dist`, `.next`, and legacy frontend config ownership.

**Step 4: Install root tooling**

Add development dependencies using pnpm from project root:

```bash
pnpm add -Dw @types/node eslint typescript typescript-eslint vitest tsx
```

**Step 5: Verify**

```bash
pnpm install --frozen-lockfile
pnpm exec tsc --version
pnpm exec vitest --version
```

Expected: install reports lockfile current; TypeScript and Vitest execute on Node 24; explicit package filters resolve after their owning tasks.

**Logical checkpoint**: pnpm workspace can host target packages without removing transitional packages.

### Task 2: Build Canonical Zod Contract Package

**Files**

- Create: `packages/contracts/package.json`
- Create: `packages/contracts/tsconfig.json`
- Create: `packages/contracts/src/index.ts`
- Create: `packages/contracts/src/system.ts`
- Create: `packages/contracts/src/errors.ts`
- Create: `packages/contracts/src/internal/job-reference-v1.ts`
- Create: `packages/contracts/test/contracts.test.ts`
- Create: `packages/contracts/fixtures/job-reference-v1.json`
- Modify: `pnpm-lock.yaml`

**Step 1: Write failing schema tests**

Test these contracts:

```ts
ServiceNameSchema // "app-api" | "foundry-service"
HealthStatusSchema // "ok" | "degraded"
HealthResponseSchema
ErrorResponseSchema
JobReferenceV1Schema
```

`HealthResponseSchema` fields:

```ts
{
  status: "ok" | "degraded"
  service: "app-api" | "foundry-service"
  version: string
}
```

`ErrorResponseSchema` fields:

```ts
{
  error: {
    code: string
    message: string
    requestId: string
  }
}
```

`JobReferenceV1Schema` fields:

```ts
{
  schemaVersion: 1
  jobId: UUID
  workflowType: non-empty string
  workflowId: non-empty string
}
```

Tests accept fixture, reject extra keys, reject malformed UUIDs, and confirm inferred TypeScript types compile.

Run:

```bash
pnpm --filter @expense-tax/contracts test
```

Expected: failure because package/schemas do not exist.

**Step 2: Implement strict schemas and package exports**

Use Zod v4 strict objects. Export schemas and inferred types. Add no customer-domain DTOs yet.

Package scripts:

- `test`: Vitest run
- `typecheck`: `tsc --noEmit`
- `build`: `tsc -p tsconfig.json`
- `lint`: root ESLint scoped to package source/tests

Dependencies:

```bash
pnpm --filter @expense-tax/contracts add zod@^4.5.4
```

**Step 3: Verify**

```bash
pnpm --filter @expense-tax/contracts test
pnpm --filter @expense-tax/contracts typecheck
pnpm --filter @expense-tax/contracts build
```

Expected: all pass; `dist` exports declarations and JavaScript.

**Logical checkpoint**: canonical package validates only Phase 0I transport primitives.

### Task 3: Create App API Fastify Skeleton

**Files**

- Create: `services/app-api/package.json`
- Create: `services/app-api/tsconfig.json`
- Create: `services/app-api/src/config.ts`
- Create: `services/app-api/src/app.ts`
- Create: `services/app-api/src/server.ts`
- Create: `services/app-api/src/routes/health.ts`
- Create: `services/app-api/src/errors.ts`
- Create: `services/app-api/test/health.test.ts`
- Create: `services/app-api/Dockerfile`
- Create: `.dockerignore`
- Modify: `pnpm-lock.yaml`

**Step 1: Write failing Fastify injection tests**

Tests require:

- `buildApp()` returns a Fastify instance without opening a socket.
- `GET /health/live` returns 200 and contract-valid `{status:"ok",service:"app-api",version}`.
- unknown route returns contract-valid 404 error envelope and request ID.

Run:

```bash
pnpm --filter @expense-tax/app-api test
```

Expected: package/app missing.

**Step 2: Implement application factory and entrypoint**

Requirements:

- `buildApp(options)` owns plugin/route registration.
- `buildApp(options)` is fully dependency/config injected and never reads `process.env` or contacts a network service during construction.
- `server.ts` alone reads process environment, calls `buildApp`, listens, and handles shutdown.
- Zod validator and serializer compilers are installed before routes.
- Logger redacts authorization, cookies, database URLs, keys, secrets, and token-like fields.
- Error handler never returns stack traces or raw validation internals.
- `/health/live` never touches database.
- Port default is `8100`.

Dependencies:

```bash
pnpm --filter @expense-tax/app-api add @expense-tax/contracts@workspace:* fastify@^5.12.3 fastify-type-provider-zod@^7.0.0 zod@^4.5.4
```

**Step 3: Add development container**

Use Node 24 Alpine, Corepack/pnpm, non-root runtime user, deterministic build, and `node dist/server.js`. Container exposes 8100. Production image receives no migration credentials by default.

Per-service `tsconfig.json` must set `rootDir: "src"` and `outDir: "dist"`, producing `dist/server.js` exactly.

Root `.dockerignore` excludes at minimum:

- `.git`, `.env`, `.env.*`, and credential/key files
- `node_modules`, `.pnpm-store`, `.next`, `dist`, Python virtualenvs/caches, and test caches
- `.opencode`, `.codegraph`, `.superpowers`, local tool output, and editor state
- transitional frontend/FastAPI build artifacts and mockup PNGs not needed by service images

Dockerfiles use explicit `COPY` paths for root workspace metadata, `packages/contracts`, and owning service only. Never use `COPY . .`.

**Step 4: Verify**

```bash
pnpm --filter @expense-tax/app-api test
pnpm --filter @expense-tax/app-api typecheck
pnpm --filter @expense-tax/app-api build
docker build -f services/app-api/Dockerfile -t expense-tax-app-api:phase-0i .
```

Expected: all pass; image builds from repository root context.

**Logical checkpoint**: App API has portable, socket-free test factory and separate startup adapter.

### Task 4: Create Foundry Fastify Skeleton

**Files**

- Create: `services/foundry-service/package.json`
- Create: `services/foundry-service/tsconfig.json`
- Create: `services/foundry-service/src/config.ts`
- Create: `services/foundry-service/src/app.ts`
- Create: `services/foundry-service/src/server.ts`
- Create: `services/foundry-service/src/routes/health.ts`
- Create: `services/foundry-service/src/errors.ts`
- Create: `services/foundry-service/test/health.test.ts`
- Create: `services/foundry-service/Dockerfile`
- Modify: `pnpm-lock.yaml`

Repeat Task 3 pattern with these differences:

- service name `foundry-service`
- port `8200`
- no import from App API
- no customer-domain or receipt contract
- logs redact provider/model credential fields in addition to generic secrets

Run failing test first:

```bash
pnpm --filter @expense-tax/foundry-service test
```

Implement, then verify:

```bash
pnpm --filter @expense-tax/foundry-service test
pnpm --filter @expense-tax/foundry-service typecheck
pnpm --filter @expense-tax/foundry-service build
docker build -f services/foundry-service/Dockerfile -t expense-tax-foundry:phase-0i .
```

**Logical checkpoint**: Foundry is independently buildable and imports only canonical transport package.

### Task 5: Implement App API Audience and Scope Authentication

**Files**

- Create: `services/app-api/src/auth/types.ts`
- Create: `services/app-api/src/auth/verifier.ts`
- Create: `services/app-api/src/plugins/auth.ts`
- Modify: `services/app-api/src/config.ts`
- Modify: `services/app-api/src/app.ts`
- Create: `services/app-api/test/auth.test.ts`
- Modify: `services/app-api/package.json`
- Modify: `pnpm-lock.yaml`

**Step 1: Write failing auth tests with ephemeral asymmetric keys**

Use `jose.generateKeyPair` and `SignJWT`; never use repository secrets.

Test matrix:

| Token | Expected |
|---|---|
| valid tenant issuer/audience/signature | tenant principal accepted |
| platform audience on tenant guard | 401 |
| expired token | 401 |
| wrong issuer | 401 |
| invalid signature | 401 |
| token using any algorithm except RS256 | 401 |
| token missing `sub`, `jti`, `iat`, or `exp` | 401 |
| token with future `nbf` outside tolerance | 401 |
| token with audience array instead of exact scalar | 401 |
| valid `ai-worker` service token with required scope | accepted by matching service guard |
| tenant token on service guard | 401 |
| service token carrying Foundry internal audience | 401 |
| valid service token missing endpoint scope | 403 |
| valid service token with wrong principal | 403 |

The test registers private test-only routes against exported guard functions. No debug endpoint enters production app.

Run:

```bash
pnpm --filter @expense-tax/app-api test -- auth.test.ts
```

Expected: missing verifier/plugin.

**Step 2: Implement verifier**

- Runtime uses these required, no-default environment keys:

| Key | Local documented value |
|---|---|
| `APP_TENANT_TOKEN_ISSUER` | `https://identity.expense-tax.local` |
| `APP_TENANT_TOKEN_AUDIENCE` | `expense-app` |
| `APP_TENANT_JWKS_URL` | identity-provider JWKS URL |
| `APP_SERVICE_TOKEN_ISSUER` | `https://services.expense-tax.local` |
| `APP_SERVICE_TOKEN_AUDIENCE` | `expense-app-internal` |
| `APP_SERVICE_JWKS_URL` | service-identity JWKS URL |

- Runtime uses remote JWKS URL plus exact issuer and audience. Missing config prevents server startup; Docker image contains no defaults.
- Tests inject a local key resolver; no network.
- Canonical claims are `sub`, `iss`, `aud`, `exp`, `iat`, `jti`, optional `client_id`, space-delimited `scope`, and `roles` string array. Parsed principal includes subject, client ID, audience, issuer, roles, scopes, and token ID.
- Accept only RS256 in Phase 0I; reject symmetric, unsigned, algorithm-confusion, and any other asymmetric algorithm.
- Require scalar exact audience, non-empty `sub` and `jti`, numeric `iat` and `exp`, and valid `nbf` when present. Allow at most 30 seconds clock tolerance.
- Service tokens additionally require non-empty `client_id`; platform tokens require a roles array; tenant tokens must not gain service/platform claims through permissive parsing.
- Missing/duplicate/invalid bearer headers fail closed.
- Error envelope remains generic; logs omit raw token.
- Guard takes exact allowed service principal and all required scopes.
- Tenant guard authenticates account only. It must not claim Personal/business authorization.

Add `jose@^6.2.12`.

**Step 3: Verify**

```bash
pnpm --filter @expense-tax/app-api test -- auth.test.ts
pnpm --filter @expense-tax/app-api test
pnpm --filter @expense-tax/app-api typecheck
```

**Logical checkpoint**: App API rejects platform tokens and enforces service principal plus scope independently from gateway policy.

### Task 6: Implement Foundry Operator and Service Authentication

**Files**

- Create: `services/foundry-service/src/auth/types.ts`
- Create: `services/foundry-service/src/auth/verifier.ts`
- Create: `services/foundry-service/src/plugins/auth.ts`
- Modify: `services/foundry-service/src/config.ts`
- Modify: `services/foundry-service/src/app.ts`
- Create: `services/foundry-service/test/auth.test.ts`
- Modify: `services/foundry-service/package.json`
- Modify: `pnpm-lock.yaml`

Write failing tests first:

| Token | Endpoint guard | Expected |
|---|---|---|
| tenant owner | platform operator | 401 |
| platform `operator` | operator | accepted |
| platform `operator` | quota reconciler | 403 |
| platform `quota_reconciler` | quota reconciler | accepted |
| platform `quota_reconciler` | operator | 403 |
| service `app-api` with entitlement publish scope | matching internal guard | accepted |
| service `ai-worker` with reservation scope | matching internal guard | accepted |
| `app-api` token on worker-only action | matching internal guard | 403 |
| service token carrying App internal audience | any Foundry internal guard | 401 |
| user/platform token on service guard | internal guard | 401 |

Implementation requirements mirror Task 5, but platform roles are exact endpoint permissions and never imply one another.
Apply the same RS256-only, required-claim, scalar-audience, and 30-second clock-tolerance policy. Repeat algorithm, missing-claim, future-`nbf`, and audience-array negative tests for Foundry.

Foundry runtime requires these no-default environment keys:

| Key | Local documented value |
|---|---|
| `FOUNDRY_PLATFORM_TOKEN_ISSUER` | `https://identity.expense-tax.local` |
| `FOUNDRY_PLATFORM_TOKEN_AUDIENCE` | `expense-foundry-platform` |
| `FOUNDRY_PLATFORM_JWKS_URL` | platform identity-provider JWKS URL |
| `FOUNDRY_SERVICE_TOKEN_ISSUER` | `https://services.expense-tax.local` |
| `FOUNDRY_SERVICE_TOKEN_AUDIENCE` | `expense-foundry-internal` |
| `FOUNDRY_SERVICE_JWKS_URL` | service-identity JWKS URL |

Missing config prevents server startup; Docker image contains no defaults. Tests use injected local key resolvers and the same config shape as runtime.

Verify:

```bash
pnpm --filter @expense-tax/foundry-service test -- auth.test.ts
pnpm --filter @expense-tax/foundry-service test
pnpm --filter @expense-tax/foundry-service typecheck
```

**Logical checkpoint**: Foundry rejects tenant tokens and separates operator, reconciler, App, and worker capabilities.

### Task 7: Add App API Kysely Runtime and Migration Foundation

**Files**

- Create: `services/app-api/src/database/types.ts`
- Create: `services/app-api/src/database/client.ts`
- Create: `services/app-api/src/database/migrate.ts`
- Create: `services/app-api/src/database/migrations/001_service_metadata.ts`
- Create: `services/app-api/src/plugins/database.ts`
- Modify: `services/app-api/src/config.ts`
- Modify: `services/app-api/src/app.ts`
- Modify: `services/app-api/src/routes/health.ts`
- Create: `services/app-api/test/database.test.ts`
- Modify: `services/app-api/package.json`
- Modify: `pnpm-lock.yaml`

**Step 1: Write failing unit tests**

Tests require:

- equal `APP_DATABASE_URL` and `APP_MIGRATION_DATABASE_URL` values are rejected
- `GET /health/ready` returns 200 after injected database probe succeeds
- `GET /health/ready` returns 503 with generic response after probe fails
- `GET /health/live` stays database-free

Use one injected database probe for readiness behavior. Kysely role/schema behavior is tested once against real PostgreSQL in Task 10, not duplicated in unit tests.

**Step 2: Implement Kysely boundaries**

Add `kysely@^0.29.5`, `pg`, and `@types/pg`.

`001_service_metadata.ts` creates `app.service_metadata` with:

- `key text primary key`
- `value jsonb not null`
- `updated_at timestamptz not null default now()`

Migration runner:

- uses only migration URL
- stores Kysely migration tables in private schema `app_migrations`
- uses absolute migration folder path
- reports each migration status
- always destroys migration pool in `finally`
- exits nonzero on error

Runtime client:

- uses only runtime URL
- schema-qualifies tables in database type
- uses bounded pool defaults
- never runs migrations or DDL
- never receives or imports `APP_MIGRATION_DATABASE_URL`

**Step 3: Verify unit/build behavior**

```bash
pnpm --filter @expense-tax/app-api test -- database.test.ts
pnpm --filter @expense-tax/app-api test
pnpm --filter @expense-tax/app-api typecheck
pnpm --filter @expense-tax/app-api build
```

**Logical checkpoint**: App runtime and migration code paths require different credentials and lifecycle handling.

### Task 8: Add Foundry Kysely Runtime and Migration Foundation

**Files**

- Create: `services/foundry-service/src/database/types.ts`
- Create: `services/foundry-service/src/database/client.ts`
- Create: `services/foundry-service/src/database/migrate.ts`
- Create: `services/foundry-service/src/database/migrations/001_service_metadata.ts`
- Create: `services/foundry-service/src/plugins/database.ts`
- Modify: `services/foundry-service/src/config.ts`
- Modify: `services/foundry-service/src/app.ts`
- Modify: `services/foundry-service/src/routes/health.ts`
- Create: `services/foundry-service/test/database.test.ts`
- Modify: `services/foundry-service/package.json`
- Modify: `pnpm-lock.yaml`

Repeat Task 7 for schema `foundry` and table `foundry.service_metadata`, keeping only equal-URL rejection plus live/ready boundary tests.

Foundry runtime consumes only `FOUNDRY_DATABASE_URL`; its migrator consumes only `FOUNDRY_MIGRATION_DATABASE_URL`. Kysely migration metadata lives in private schema `foundry_migrations`. Equal runtime/migration URLs are rejected.

Foundry database types must contain no App/customer tables. App API database types must contain no Foundry tables.
Foundry adds the same exact `GET /health/ready` behavior while keeping `GET /health/live` database-free.

Verify:

```bash
pnpm --filter @expense-tax/foundry-service test -- database.test.ts
pnpm --filter @expense-tax/foundry-service test
pnpm --filter @expense-tax/foundry-service typecheck
pnpm --filter @expense-tax/foundry-service build
```

**Logical checkpoint**: Foundry owns isolated migration/runtime path and no customer-domain database surface.

### Task 9: Generate OpenAPI, JSON Schema, TypeScript Clients, and Pydantic DTOs

**Files**

- Create: `packages/contracts/scripts/generate-json-schema.ts`
- Create: `packages/contracts/scripts/generate-typescript-clients.ts`
- Create: `packages/contracts/scripts/generate-python.sh`
- Create: `packages/contracts/scripts/check-generated.mjs`
- Create: `packages/contracts/src/clients/app-api.ts`
- Create: `packages/contracts/src/clients/foundry-service.ts`
- Create: `services/app-api/scripts/generate-openapi.ts`
- Create: `services/foundry-service/scripts/generate-openapi.ts`
- Modify: both service `src/app.ts` files
- Modify: both service `package.json` files
- Modify: `packages/contracts/package.json`
- Modify: root `package.json`
- Create generated files under `packages/contracts/generated/`
- Create: `packages/contracts/test/generated-artifacts.test.ts`
- Create: `common/python/expense-contracts/src/expense_contracts/generated/__init__.py`
- Generate: `common/python/expense-contracts/src/expense_contracts/generated/internal_messages.py`
- Modify: `common/python/expense-contracts/src/expense_contracts/__init__.py`
- Modify: `common/python/expense-contracts/pyproject.toml`
- Modify: `common/python/expense-contracts/tests/test_expense_contracts.py`
- Modify: `common/python/expense-contracts/uv.lock`
- Modify: `pnpm-lock.yaml`

**Step 1: Write failing artifact tests**

Tests assert:

- App OpenAPI title/version/path contains `/health/live` and excludes Foundry branding.
- Foundry OpenAPI title/version/path contains `/health/live` and excludes App branding.
- both documents use OpenAPI 3.1 and stable sorted output
- internal JSON Schema validates `job-reference-v1.json`
- generated TypeScript path types compile
- generated Python model accepts same fixture and rejects extra fields/malformed UUID
- generator output contains no timestamps or absolute local paths

Run:

```bash
pnpm --filter @expense-tax/contracts test -- generated-artifacts.test.ts
```

Expected: generated files absent.

**Step 2: Register Swagger before routes**

Each application factory registers `@fastify/swagger` with Zod transform and a service-specific OpenAPI 3.1 document. Security schemes describe tenant/platform/service bearer tokens but do not expose signing keys, JWKS internals, or sample secrets.

Generators call `buildApp()` with injected non-network test configuration and local verifier stubs. Importing either factory or generating OpenAPI must require no environment variable, database connection, JWKS request, or secret.

**Step 3: Implement deterministic generators**

Generation order:

1. Canonical Zod schemas -> `generated/json-schema/internal-messages.schema.json`.
2. App factory -> `generated/openapi/app-api.openapi.json`.
3. Foundry factory -> `generated/openapi/foundry-service.openapi.json`.
4. OpenAPI docs -> generated TypeScript path types.
5. Checked-in maintained `src/clients/app-api.ts` and `src/clients/foundry-service.ts` factories import generated path types.
6. Internal JSON Schema -> generated Pydantic v2 module.

Use `datamodel-code-generator==0.76.2` with timestamp disabled and Pydantic v2 output. Generated Python lives only under `expense_contracts/generated`; transitional manual expense contracts remain until Phase 0J.

Exact output paths:

- `packages/contracts/generated/json-schema/internal-messages.schema.json`
- `packages/contracts/generated/openapi/app-api.openapi.json`
- `packages/contracts/generated/openapi/foundry-service.openapi.json`
- `packages/contracts/generated/typescript/app-api.paths.ts`
- `packages/contracts/generated/typescript/foundry-service.paths.ts`
- `common/python/expense-contracts/src/expense_contracts/generated/internal_messages.py`

Package exports expose canonical schemas, both maintained client factories, and both generated path-type modules. They do not expose service implementation modules.

Install generator/runtime dependencies explicitly:

```bash
pnpm --filter @expense-tax/app-api add @fastify/swagger@^9.8.1
pnpm --filter @expense-tax/foundry-service add @fastify/swagger@^9.8.1
pnpm --filter @expense-tax/contracts add openapi-fetch@^0.17.0
pnpm --filter @expense-tax/contracts add -D openapi-typescript@^7.13.0
uv add --project common/python/expense-contracts --dev "datamodel-code-generator==0.76.2"
chmod +x packages/contracts/scripts/generate-python.sh
```

**Step 4: Add drift check**

`contracts:check` must create temporary output roots, regenerate every artifact there, byte-compare relative files against these working-tree paths, then remove the temporary output:

- `packages/contracts/generated/`
- `common/python/expense-contracts/src/expense_contracts/generated/`

Generators accept explicit output-root arguments or environment variables so the check never mutates canonical artifacts. Do not use Git state for drift detection: generated files may still be untracked before the user creates a commit, and unrelated mockup/plan edits already exist.

**Step 5: Verify**

```bash
pnpm contracts:generate
pnpm contracts:check
pnpm --filter @expense-tax/contracts test
uv run --project common/python/expense-contracts pytest common/python/expense-contracts/tests -q
uv run --project common/python/expense-contracts ruff check common/python/expense-contracts
```

Expected: generation is idempotent, TS/Python parse same fixture, transitional tests still pass.

**Logical checkpoint**: Zod is demonstrably canonical across Fastify, OpenAPI, TypeScript, JSON Schema, and Pydantic.

### Task 10: Enforce PostgreSQL Roles and Fix Compose Topology

**Files**

- Create: `docker/postgres/zz-20-expense-tax-roles.sh`
- Modify: `./docker-compose.yml` (expense-tax-management overlay only; never modify `../infrastructure/*`)
- Modify: `package.json`
- Modify: `.env.example` (merge new variables; preserve every existing key)
- Create: `test/integration/database-boundaries.test.ts`
- Create: `test/integration/compose-boundaries.test.ts`
- Create: `scripts/compose.sh`
- Create: `scripts/reset-phase-0i-db.sh`
- Create: `scripts/audit-credential-boundaries.mjs`
- Modify: `pnpm-lock.yaml`

**Step 1: Write failing Compose-boundary test**

Vitest invokes `./scripts/compose.sh config --format json`, parses stdout, and asserts:

- legacy `expense-service` normalized build-context path ends with `/expense-tax-management/expense-service` and never ends with `/infrastructure/expense-service`
- `app-api` has only App runtime database URL
- `app-api-migrate` has only App migration database URL
- `foundry-service` has only Foundry runtime database URL
- `foundry-service-migrate` has only Foundry migration database URL
- no runtime service receives `POSTGRES_USER`, superuser URL, other-service URL, or migration URL
- transitional `expense-service` receives only its existing legacy database URL and receives zero new `APP_*`, `FOUNDRY_*`, or `MIGRATION_*` database variables
- internal API ports are not routed through current Nginx public gateway in Phase 0I

Run:

```bash
pnpm exec vitest run test/integration/compose-boundaries.test.ts
```

Expected: failure from bad legacy path and missing services/roles.

**Step 2: Add idempotent database bootstrap script**

On fresh local PostgreSQL initialization, create:

- `expense_app_migrator`
- `expense_app_runtime`
- `expense_foundry_migrator`
- `expense_foundry_runtime`
- schema `app` owned by App migrator
- schema `app_migrations` owned by App migrator and inaccessible to App runtime
- schema `foundry` owned by Foundry migrator
- schema `foundry_migrations` owned by Foundry migrator and inaccessible to Foundry runtime

Required grants:

- both role pairs may connect to `expense_tax_db`
- App runtime has only usage and DML/sequence permissions in `app`
- Foundry runtime has only usage and DML/sequence permissions in `foundry`
- migration roles own only their schema
- default privileges grant runtime DML on future owner-created objects in only `app` or `foundry`, never migration metadata schemas
- PUBLIC create permission is revoked where needed
- runtime roles cannot create/alter/drop schema objects or set role to migrators
- runtime roles cannot create extensions or change object ownership
- neither role pair receives usage on other service schema
- runtime role `search_path` is restricted to `pg_catalog`; application queries remain schema-qualified
- migrator `search_path` is restricted to its domain and private migration schemas plus `pg_catalog`

The source and target init filename is `zz-20-expense-tax-roles.sh`, ensuring it runs after shared `init-multiple-dbs.sh`. Add it through overlay `postgres.volumes`; do not edit shared Compose. Script is idempotent through catalog checks/conditional role and schema creation, and reapplies grants/default privileges safely. Passwords come from psql variables populated by local environment values. Preserve existing `.env.example` keys and add only documented App/Foundry local-role variables. Script refuses missing values and refuses development defaults when `APP_ENV=production`.

**Step 3: Correct Compose path base and add services**

Because paths resolve from first Compose file, use paths relative to `infrastructure/` such as `../expense-tax-management/...`.

Add:

- PostgreSQL init-script mount
- `app-api` on 8100 with runtime URL only
- `app-api-migrate` one-shot profile with migration URL only
- `foundry-service` on 8200 with runtime URL only
- `foundry-service-migrate` one-shot profile with migration URL only
- health checks and dependency conditions

Keep legacy FastAPI service transitional. Do not route new services through public gateway yet.
Bind local App and Foundry host ports to `127.0.0.1`, not every interface. Phase 0I registers no internal API routes; private-network/mTLS ingress is implemented when internal routes first arrive, before 0K/0L traffic, and remains a hard gate rather than simulated protection.

`scripts/compose.sh` exact behavior:

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
FAMILY_ROOT="$(cd -- "$PROJECT_DIR/.." && pwd)"
if [[ -n "${EXPENSE_TAX_ENV_FILE:-}" ]]; then
  ENV_FILE="$EXPENSE_TAX_ENV_FILE"
  if [[ ! -f "$ENV_FILE" ]]; then
    echo "EXPENSE_TAX_ENV_FILE does not exist" >&2
    exit 1
  fi
else
  ENV_FILE="$PROJECT_DIR/.env"
  if [[ ! -f "$ENV_FILE" ]]; then
    ENV_FILE="$PROJECT_DIR/.env.example"
  fi
fi

exec docker compose \
  --project-name infrastructure \
  --env-file "$ENV_FILE" \
  -f "$FAMILY_ROOT/infrastructure/docker-compose.common.yml" \
  -f "$PROJECT_DIR/docker-compose.yml" \
  "$@"
```

Set executable bit with `chmod +x scripts/compose.sh`. File order preserves existing `infrastructure_*` resource names and makes path resolution deterministic regardless of caller working directory. Static tests invoke wrapper from project root and an unrelated temporary directory and require byte-equivalent normalized Compose configuration. They also require a missing explicit `EXPENSE_TAX_ENV_FILE` to fail without falling back. Never print explicit env-file path because it may reveal local account structure.

**Step 4: Write and run database boundary tests**

After migrations, test real PostgreSQL connections:

- App migrator can migrate `app`, not `foundry`.
- Foundry migrator can migrate `foundry`, not `app`.
- App runtime can read/write `app.service_metadata`, cannot use `foundry`, and cannot create App tables.
- Foundry runtime can read/write `foundry.service_metadata`, cannot use `app`, and cannot create Foundry tables.
- runtime cannot access `app_migrations` or `foundry_migrations` metadata at all.
- runtime `SHOW search_path` returns only approved restricted entries.
- runtime attempts to `CREATE EXTENSION`, alter object ownership, `SET ROLE` to migrator, and use cross-schema objects all fail.
- each migrator also fails to use or alter the other service's domain and migration schemas.

Use dedicated test rows and remove only those rows. Never broaden grants to make tests pass.

Create `scripts/reset-phase-0i-db.sh` for scoped local reset. It must:

- require the expected local Compose project and container name
- refuse non-local database hosts and `APP_ENV=production`
- stop only App/Foundry runtime and migration services
- drop only `app`, `app_migrations`, `foundry`, and `foundry_migrations` schemas and four Phase 0I roles
- preserve legacy tables, PostgreSQL volume, Temporal metadata, Neo4j volume, and unrelated shared services
- rerun `zz-20-expense-tax-roles.sh`
- require explicit `PHASE_0I_RESET_CONFIRM=expense-tax-local`

Run scoped reset and tests:

```bash
./scripts/compose.sh up -d postgres
PHASE_0I_RESET_CONFIRM=expense-tax-local ./scripts/reset-phase-0i-db.sh
./scripts/compose.sh run --rm app-api-migrate
./scripts/compose.sh run --rm foundry-service-migrate
pnpm test:integration
```

Never run `down --volumes` for Phase 0I. Sol verifies reset guard and normalized local Compose target before executing scoped reset.

**Step 5: Verify service readiness**

```bash
./scripts/compose.sh up -d app-api foundry-service
curl --fail http://127.0.0.1:8100/health/ready
curl --fail http://127.0.0.1:8200/health/ready
```

Expected: both return contract-valid 200 after migrations.

Smoke tests also start each built image through Compose, call `GET /health/live`, and verify container command resolves existing `dist/server.js`.

**Logical checkpoint**: credentials and PostgreSQL grants enforce ownership even if application code is compromised.

### Task 11: Add Phase 0I Aggregate Verification and Completion Evidence

**Files**

- Create: `scripts/verify-phase-0i.mjs`
- Modify: `package.json`
- Modify: `README.md` if present, otherwise create concise project README
- Modify: `plans/PLAN.md`
- Modify: this implementation plan only after evidence exists

**Step 1: Write aggregate verifier**

Verifier runs focused commands in deterministic order and exits on first failure:

1. `pnpm install --frozen-lockfile`.
2. `uv sync --frozen` for generated Python contracts.
3. Root TypeScript lint.
4. All Phase 0I TypeScript type checks.
5. Contracts generation drift check.
6. Essential contracts, App API, and Foundry tests.
7. All Phase 0I builds.
8. Generated Python package Ruff and essential cross-language fixture test.
9. Redacted credential-boundary audit.
10. Compose static boundary test.
11. PostgreSQL integration tests when `PHASE_0I_INTEGRATION=1`; otherwise prints explicit skipped status and fails completion gate.

Do not hide command output and do not convert failures into warnings.

**Step 2: Run full gate**

```bash
PHASE_0I_INTEGRATION=1 pnpm verify:phase-0i
```

Expected: every gate passes, zero skipped required checks.

**Step 3: Verify containers from clean builds**

```bash
docker build -f services/app-api/Dockerfile -t expense-tax-app-api:phase-0i .
docker build -f services/foundry-service/Dockerfile -t expense-tax-foundry:phase-0i .
./scripts/compose.sh config --quiet
```

**Step 4: Audit final boundaries**

```bash
node scripts/audit-credential-boundaries.mjs
rg -n "expense_contracts\.expense|expense_contracts\.enums" services packages
git diff --check
git diff --name-only --diff-filter=U
```

Expected:

- migration URL appears only migration config/runner and migration Compose services
- no new runtime superuser URL
- transitional FastAPI receives none of the new App/Foundry runtime or migration credentials
- no current or future Python worker path contains App/Foundry database credentials
- no TypeScript import of manual Python contracts
- no whitespace errors or unmerged files

Credential audit reads tracked configuration/source files but reports only file path, variable/key name, and pass/fail rule. It redacts URL values and never prints passwords, tokens, provider configuration, or full matching lines.

**Step 5: Record evidence**

Only after full gate passes:

- change only Phase 0I status cell in `plans/PLAN.md` from `🟡 In Progress` to `✅ Complete`
- change this plan header from `In progress` to `Complete`
- append `## 12. Completion Evidence` to this implementation plan with date, exact `PHASE_0I_INTEGRATION=1 pnpm verify:phase-0i` command, PASS result, test counts, generated-artifact count, and image-build results
- make zero edits to `phase-0i-polyglot-platform-rebaseline-design.md`

**Logical checkpoint**: Phase 0J may begin planning only after all Phase 0I evidence is recorded.

## 9. Sol Review Checklist After Every Builder

- Diff contains only task-listed files, lockfiles, and expected generated output.
- Failing test was observed before implementation for behavioral work.
- Focused test now passes for right reason.
- No unrelated mockup or plan content changed.
- No secret, token, database password, raw auth header, or local absolute path entered tracked files/generated docs.
- No runtime service receives migration or superuser credentials.
- No service imports another service's database types or migration files.
- App API and Foundry import only `@expense-tax/contracts` across service boundary.
- Generated files changed only through generator command.
- Builder made no commit or destructive Git operation.

## 10. Phase 0I Completion Criteria

Phase 0I is complete only when all statements are true:

- `opencode debug agent phase-0i-builder` resolves `openai/gpt-5.6-luna` with variant `xhigh`.
- `pnpm verify:phase-0i` passes with integration checks enabled.
- Both clean Docker images build.
- Both readiness endpoints pass against fresh local PostgreSQL after separate one-shot migrations.
- Contract generation is idempotent and drift check passes.
- Same fixture validates in Zod and generated Pydantic.
- Tenant tokens cannot authenticate to Foundry.
- Platform tokens cannot authenticate as App tenant users.
- `operator` and `quota_reconciler` do not inherit each other.
- App and worker service principals cannot invoke each other's Foundry scopes.
- Runtime roles can perform DML only in owned schema and cannot perform DDL.
- Migration roles cannot alter other service schema.
- Runtime roles cannot access migration metadata, create extensions, change ownership, or assume migration roles.
- Runtime and migrator `search_path` values are restricted and tested.
- Runtime containers contain no migration/superuser credential.
- No application implementation from Phase 0J or later entered Phase 0I.
- No required verification is skipped.

## 11. Rollback Strategy

Before traffic cutover, rollback is simple:

- Stop App API and Foundry containers.
- Leave transitional FastAPI service unchanged.
- Drop only fresh local `app` and `foundry` schemas/roles if rebuilding development environment.
- Regenerate artifacts from canonical Zod source instead of hand-editing outputs.
- Revert Phase 0I files only through normal user-controlled Git operations; never reset unrelated worktree changes.

No customer or production data migration occurs in this phase.
