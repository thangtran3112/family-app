# Phase 0J Wave 2 Business, Categories, and Projects Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Status**: Complete; verified 2026-09-08

**Goal:** Add deterministic industry onboarding, small-business scopes, business memberships, tenant spending categories, and business projects to App API without conflating projects or spending categories with tax identity.

**Architecture:** Canonical Zod schemas define all transport behavior. Migration `003_business_categories_projects` establishes core Wave 2 records; forward migration `004_industry_category_mappings` adds 24 global spending-category definitions and 25 ordered industry mappings. Focused domain services enforce active tenant plus exact business membership, while route tests isolate HTTP wiring and PostgreSQL tests prove composite scope constraints, idempotent industry-template application, and concurrent final-owner protection.

**Tech Stack:** Node.js 24, TypeScript 5.9 strict mode, Fastify 5, Zod 4, Kysely 0.29, PostgreSQL 17, Vitest 5, pnpm 11.9, Docker Compose

**Spec:** `plans/sub-plans/phase-0j-personal-business-tax-domain-design.md`

## Global Constraints

- Git root is `family-app/`; project root is `expense-tax-management/`.
- Preserve all existing `plans/mockups/**` changes without editing, staging, stashing, resetting, or cleaning them.
- Shared `../infrastructure/**` remains read-only.
- Do not commit or push unless user explicitly requests it.
- App API remains sole writer for customer-domain tables.
- Tenant membership is necessary but never sufficient for business records.
- Projects group business work only and contain no tax classification or filing fields.
- Spending categories remain tenant-owned and separate from tax categories.
- Public schemas are strict Zod objects; database row types remain private.
- Runtime role performs DML only; migration role owns all DDL and seed rows.
- No legacy backfill, dual write, compatibility adapter, VPS change, or GCP change.

---

### Task 1: Wave 2 Canonical Contracts

**Files:**
- Create: `packages/contracts/src/businesses.ts`
- Create: `packages/contracts/src/spending-categories.ts`
- Create: `packages/contracts/src/projects.ts`
- Modify: `packages/contracts/src/memberships.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `packages/contracts/test/wave2-contracts.test.ts`

**Interfaces:**
- Consumes: Wave 1 UUID, timestamp, version, role, and status conventions.
- Produces: strict schemas and inferred types used by every Wave 2 route and domain service.

- [ ] **Step 1: Write failing contract tests**

Cover exact accepted and rejected shapes:

- industries contain only `code`, `name`, and `status`
- business create requires `name`, `industryCode`, IANA `timezone`, and uppercase three-letter `baseCurrency`
- business update requires `expectedVersion` and at least one mutable field
- business membership roles are `owner|editor|viewer`
- category create/update validates `#RRGGBB` color and stable icon name
- project contains no tax fields and rejects `taxEntity`, `deductionType`, or `filingStatus`
- project date range rejects `endsOn < startsOn`
- archive requests require `expectedVersion`
- [ ] **Step 2: Verify RED**

Run: `pnpm --filter @expense-tax/contracts exec vitest run test/wave2-contracts.test.ts`

Expected: FAIL because Wave 2 modules do not exist.

- [ ] **Step 3: Implement exact schemas**

Export these transport types:

```typescript
type BusinessStatus = "active" | "archived";
type BusinessRole = "owner" | "editor" | "viewer";
type ProjectStatus = "active" | "completed" | "archived";
type SpendingCategoryStatus = "active" | "archived";

interface SmallBusiness {
  id: string;
  tenantId: string;
  name: string;
  industryCode: string;
  timezone: string;
  baseCurrency: string;
  status: BusinessStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
}
```

Create strict request, response, list, path-parameter, membership, and archive schemas for:

```text
BusinessIndustry
SmallBusiness
BusinessMembership
SpendingCategory
Project
```

Use `z.string().regex(/^[A-Z]{3}$/)` for currency, `z.string().regex(/^#[0-9A-Fa-f]{6}$/)` for color, ISO `YYYY-MM-DD` strings for project dates, and object-level refinements for non-empty updates and date order.

- [ ] **Step 4: Export and verify**

Run:

```bash
pnpm --filter @expense-tax/contracts test
pnpm --filter @expense-tax/contracts typecheck
pnpm --filter @expense-tax/contracts build
```

Expected: all contract tests, typecheck, and build pass.

---

### Task 2: Business Schema and Deterministic Industry Seeds

**Files:**
- Create: `services/app-api/src/database/migrations/003_business_categories_projects.ts`
- Create: `services/app-api/src/database/migrations/004_industry_category_mappings.ts`
- Modify: `services/app-api/src/database/types.ts`
- Create: `test/integration/app-domain-wave2.test.ts`

**Interfaces:**
- Consumes: Wave 1 users, tenants, tenant memberships, invitations, migration runner, and runtime grants.
- Produces: typed `app.business_industries`, `app.spending_category_templates`, `app.industry_spending_category_templates`, `app.businesses`, `app.business_memberships`, `app.spending_categories`, and `app.projects` tables plus additive business invitation columns.

- [ ] **Step 1: Write failing PostgreSQL tests**

Require:

- five active industry codes: `restaurant`, `salon`, `daycare`, `grocery`, `construction`
- 24 unique global template definitions and 25 ordered industry mappings
- duplicate `(industry_code, template_key)` rejection
- business membership composite tenant/business foreign key rejection
- project composite tenant/business foreign key rejection
- duplicate active normalized category name rejection, including surrounding whitespace
- archived category name reuse acceptance
- invitation check rejects simultaneous Personal and business grants
- [ ] **Step 2: Verify RED**

Run: `PHASE_0J_WAVE2_INTEGRATION=1 pnpm exec vitest run test/integration/app-domain-wave2.test.ts`

Expected: FAIL with missing `app.business_industries`.

- [ ] **Step 3: Implement migration**

Migration `003` creates core Wave 2 tables with explicit named constraints, composite unique keys `(id, tenant_id)`, optimistic `version > 0` checks, archive-state checks, and partial unique index:

```sql
CREATE UNIQUE INDEX spending_categories_active_normalized_name_unique
ON app.spending_categories (tenant_id, lower(trim(name)))
WHERE status = 'active';
```

Alter `tenant_invitations` to add nullable `business_id` and `business_role`, replace the Wave 1 Personal-only grant check with an exclusive none/Personal/business grant check, and add composite business/tenant foreign key after `businesses` exists.

Migration `004` seeds global definitions and ordered industry mappings with stable keys:

```text
restaurant: food-inventory, beverages, kitchen-supplies, delivery-fees, equipment-maintenance
salon: beauty-supplies, linens-laundry, booth-equipment, booking-fees, licensing
daycare: learning-supplies, meals-snacks, toys-equipment, cleaning-safety, licensing-training
grocery: resale-inventory, packaging, refrigeration-maintenance, delivery-fees, store-supplies
construction: building-materials, subcontractors, equipment-rental, permits-inspections, jobsite-supplies
```

There are 24 unique global definitions and 25 mapping rows; `sort_order` belongs to mapping rows. Shared definitions such as `delivery-fees` are inserted once and mapped to multiple industries. Seed only through migration SQL with deterministic conflict-safe statements. Migration `004` also replaces the applied generic seed set as the onboarding source and changes active category uniqueness to `lower(trim(name))`.

- [ ] **Step 4: Apply and verify**

Run:

```bash
./scripts/compose.sh run --rm --build app-api-migrate
PHASE_0J_WAVE2_INTEGRATION=1 pnpm exec vitest run test/integration/app-domain-wave2.test.ts
```

Expected: migration and schema tests pass.

---

### Task 3: Business Domain and Routes

**Files:**
- Create: `services/app-api/src/domain/businesses.ts`
- Create: `services/app-api/src/routes/businesses.ts`
- Modify: `services/app-api/src/app.ts`
- Create: `services/app-api/test/businesses.test.ts`
- Extend: `test/integration/app-domain-wave2.test.ts`

**Interfaces:**
- Consumes: authenticated user, tenant membership, industry rows, business tables, idempotency helper, audit helper, and business contracts.
- Produces: industry list and business create/list/get/update/archive methods and routes.

- [ ] **Step 1: Write failing route tests**

Test:

- industry list returns exactly five stable options
- unprovisioned user cannot create business
- active tenant member can create business with `Idempotency-Key`
- business creation returns owner membership and idempotently applies only missing selected-industry category template keys
- repeated key with same body replays; different body returns `409`
- tenant membership without business membership cannot read business
- viewer can read, but only owner can update/archive business settings
- stale update/archive version returns `409`
- archive returns `204`

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter @expense-tax/app-api exec vitest run test/businesses.test.ts`

Expected: FAIL with route-not-found assertions.

- [ ] **Step 3: Implement domain**

Expose:

```typescript
interface BusinessDomain {
  listIndustries(): Promise<readonly BusinessIndustry[]>;
  create(input: CreateBusinessCommand): Promise<MutationResult<BusinessBootstrap, 201>>;
  list(actorUserId: string, tenantId: string): Promise<readonly SmallBusiness[]>;
  get(actorUserId: string, tenantId: string, businessId: string): Promise<SmallBusiness>;
  update(input: UpdateBusinessCommand): Promise<SmallBusiness>;
  archive(input: ArchiveBusinessCommand): Promise<void>;
}

interface CreateBusinessCommand {
  actorUserId: string;
  tenantId: string;
  request: BusinessCreateRequest;
  idempotencyKey: string;
  requestId: string;
}

interface UpdateBusinessCommand {
  actorUserId: string;
  tenantId: string;
  businessId: string;
  request: BusinessUpdateRequest;
  requestId: string;
}

interface ArchiveBusinessCommand {
  actorUserId: string;
  tenantId: string;
  businessId: string;
  expectedVersion: number;
  requestId: string;
}
```

`BusinessBootstrap` is a Task 1 contract containing `business`, creator
`businessMembership`, and `createdSpendingCategories`.

Business bootstrap transaction must:

1. require active global user, tenant, and tenant membership
2. insert business
3. insert creator business owner membership
4. query ordered `industry_spending_category_templates` rows for selected industry
5. insert only missing `spending_categories.template_key` rows for selected industry
5. write success audit and idempotency response in same transaction

Reads join active tenant and business memberships. Updates and archive require active business owner role and `WHERE version = expectedVersion`.

- [ ] **Step 4: Register exact routes**

```text
GET    /api/v1/business-industries
POST   /api/v1/tenants/:tenantId/businesses
GET    /api/v1/tenants/:tenantId/businesses
GET    /api/v1/tenants/:tenantId/businesses/:businessId
PATCH  /api/v1/tenants/:tenantId/businesses/:businessId
DELETE /api/v1/tenants/:tenantId/businesses/:businessId
```

Use contract schemas only and tenant plus authenticated-user guards on every route.

- [ ] **Step 5: Add real transaction tests and verify**

Prove one business, one owner membership, one idempotency record, and exactly five selected-industry category keys after concurrent create retries. Prove a second business in the same industry creates no duplicate template categories, while a different industry adds only unmapped tenant keys and reuses shared mappings.

Run App tests and Wave 2 integration suite; both must pass.

---

### Task 4: Business Memberships and Invitation Grants

**Files:**
- Modify: `services/app-api/src/domain/memberships.ts`
- Modify: `services/app-api/src/routes/memberships.ts`
- Modify: `services/app-api/src/app.ts`
- Create: `services/app-api/test/business-memberships.test.ts`
- Extend: `test/integration/app-domain-wave2.test.ts`

**Interfaces:**
- Consumes: Wave 1 invitation flow and Wave 2 business tables/contracts.
- Produces: business invitation grants and business membership list/create/update/deactivate routes.

- [ ] **Step 1: Write failing authorization tests**

Test:

- tenant owner/admin without business owner role cannot attach a business grant
- business owner can invite with matching business grant
- business-only acceptance creates tenant plus business membership and no Personal membership
- business viewer cannot list or mutate membership administration
- business owner can add an already provisioned user
- foreign business under valid tenant returns `404`
- concurrent removal of two business owners leaves one active owner

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter @expense-tax/app-api exec vitest run test/business-memberships.test.ts`

Expected: FAIL because business grants and routes are absent.

- [ ] **Step 3: Extend domain and routes**

Extend invitation grant union with:

```typescript
{ type: "business"; businessId: string; role: BusinessRole }
```

Add exact routes:

```text
GET   /api/v1/tenants/:tenantId/businesses/:businessId/memberships
POST  /api/v1/tenants/:tenantId/businesses/:businessId/memberships
PATCH /api/v1/tenants/:tenantId/businesses/:businessId/memberships/:userId
```

Reuse secure invitation token behavior. Acceptance upserts tenant membership and business membership atomically. Business membership administration requires matching active business owner. Serialize final-owner changes with scope advisory lock plus locked active-owner rows.

- [ ] **Step 4: Verify routes and PostgreSQL concurrency**

Run App tests and Wave 2 integration suite; both must pass.

---

### Task 5: Spending Category Domain and Routes

**Files:**
- Create: `services/app-api/src/domain/spending-categories.ts`
- Create: `services/app-api/src/routes/spending-categories.ts`
- Modify: `services/app-api/src/app.ts`
- Create: `services/app-api/test/spending-categories.test.ts`
- Extend: `test/integration/app-domain-wave2.test.ts`

**Interfaces:**
- Consumes: tenant authority, category tables/contracts, audit helper, and optimistic versions.
- Produces: tenant-scoped category list/create/get/update/archive routes.

- [ ] **Step 1: Write failing tests**

Test owner/admin list access, owner-only mutation, normalized duplicate conflict, immutable template key, stale version conflict, foreign tenant `404`, and archive `204`.

- [ ] **Step 2: Implement exact routes**

```text
POST   /api/v1/tenants/:tenantId/spending-categories
GET    /api/v1/tenants/:tenantId/spending-categories
GET    /api/v1/tenants/:tenantId/spending-categories/:categoryId
PATCH  /api/v1/tenants/:tenantId/spending-categories/:categoryId
DELETE /api/v1/tenants/:tenantId/spending-categories/:categoryId
```

Owner/admin may list and read. Only tenant owner may create, update, or archive. Updates never modify `template_key`; archive sets status, timestamp, and version atomically.

- [ ] **Step 3: Verify**

Run focused App tests, full App tests, and Wave 2 PostgreSQL suite.

---

### Task 6: Project Domain and Routes

**Files:**
- Create: `services/app-api/src/domain/projects.ts`
- Create: `services/app-api/src/routes/projects.ts`
- Modify: `services/app-api/src/app.ts`
- Create: `services/app-api/test/projects.test.ts`
- Extend: `test/integration/app-domain-wave2.test.ts`

**Interfaces:**
- Consumes: business access helper, project tables/contracts, audit helper, and optimistic versions.
- Produces: business-scoped project list/create/get/update/archive routes.

- [ ] **Step 1: Write failing tests**

Test viewer read, owner/editor create and update, viewer mutation denial, cross-business project `404`, stale version conflict, invalid date range `400`, no tax fields, and archive `204`.

- [ ] **Step 2: Implement exact routes**

```text
POST   /api/v1/tenants/:tenantId/businesses/:businessId/projects
GET    /api/v1/tenants/:tenantId/businesses/:businessId/projects
GET    /api/v1/tenants/:tenantId/businesses/:businessId/projects/:projectId
PATCH  /api/v1/tenants/:tenantId/businesses/:businessId/projects/:projectId
DELETE /api/v1/tenants/:tenantId/businesses/:businessId/projects/:projectId
```

Every query binds tenant, business, and project IDs. Owner/editor mutate; viewer reads. Archive sets `status='archived'`, `archived_at`, and increments version.

- [ ] **Step 3: Verify**

Run focused App tests, full App tests, and Wave 2 PostgreSQL suite.

---

### Task 7: Generated Artifacts and Wave 2 Completion Gate

**Files:**
- Modify generated output under: `packages/contracts/generated/**`
- Modify: `packages/contracts/test/generated-artifacts.test.ts`
- Create: `scripts/verify-phase-0j-wave2.mjs`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `plans/PLAN.md`
- Modify: `plans/sub-plans/phase-0j-personal-business-tax-domain-design.md`
- Modify: this plan after evidence exists
- Create local report: `../.superpowers/sdd/phase-0j-wave-2/task-report.md`

**Interfaces:**
- Consumes: all Wave 2 routes, tests, migration, existing Wave 1 verifier, and generators.
- Produces: deterministic generated clients and one zero-skip Wave 2 completion command.

- [ ] **Step 1: Add generated path assertions and verify RED**

Require all business, business-membership, category, project, and industry paths in App OpenAPI and their absence from Foundry OpenAPI.

- [ ] **Step 2: Generate and verify drift**

Run:

```bash
pnpm contracts:generate
pnpm contracts:check
```

- [ ] **Step 3: Implement aggregate verifier**

Add:

```json
"verify:phase-0j:wave2": "node scripts/verify-phase-0j-wave2.mjs"
```

Verifier runs Wave 1 zero-skip regression, Wave 2 contract and App tests, rebuilt migration, real Wave 2 PostgreSQL suite, drift, App image build, credential audit, and readiness. Without `PHASE_0J_WAVE2_INTEGRATION=1`, print required-check `SKIP` and exit nonzero after non-database gates.

- [ ] **Step 4: Run zero-skip gate and record evidence**

```bash
PHASE_0I_INTEGRATION=1 PHASE_0J_INTEGRATION=1 PHASE_0J_WAVE2_INTEGRATION=1 pnpm verify:phase-0j:wave2
```

Only after full pass: mark Wave 2 complete, update Phase 0J status, record exact counts/warnings, and preserve all Wave 1 evidence unchanged.

## Wave 2 Completion Gate

Verification evidence: `../.superpowers/sdd/phase-0j-wave-2/task-report.md`.

Wave 2 is complete only when:

- all five industries, 24 global template definitions, and 25 ordered industry mappings are deterministic migration-owned seeds
- business creation atomically creates owner membership and missing template categories
- tenant membership alone grants no business access
- business-only invitation acceptance grants no Personal access
- business final-owner protection survives concurrent attempts
- category active-name uniqueness and project tenant/business constraints pass in PostgreSQL
- projects expose no tax identity or classification fields
- generated clients contain every Wave 2 route
- Wave 1 remains zero-skip green
- App image and readiness pass
- no shared infrastructure, production route, VPS, or GCP resource changes occur
