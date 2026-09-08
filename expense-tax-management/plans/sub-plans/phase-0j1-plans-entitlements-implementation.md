# Phase 0J1: Plans, Add-ons & Entitlements — Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans or superpowers:subagent-driven-development to implement task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** App API owns Plan/PlanVersion/FeatureDefinition/PlanEntitlement (full CRUD, platform-operator scoped), TenantSubscription/TenantAddon/TenantFeatureOverride (tenant-facing, owner-scoped), FeatureUsageEvent (non-AI usage accounting), and publishes effective AI entitlement snapshots to Foundry via a pollable outbox.

**Architecture:** Same TS/Fastify/Zod/Kysely vertical-slice pattern as Phase 0J Waves 1-4 (contracts → migration → domain → routes → tests → generated artifacts → verify script). New concept: a **platform-operator** service-token scope (`plans:manage`, principal `platform-admin`) for admin CRUD, distinct from both tenant JWTs and the existing named service principals (`gateway-auth`, `ai-worker`) — reuses the existing `serviceGuard()` helper in `plugins/auth.ts` unchanged.

**Tech Stack:** Fastify, Zod, Kysely, PostgreSQL 17, Vitest.

**Spec:** `plans/sub-plans/phase-0i-polyglot-platform-rebaseline-design.md` §10 (approved architecture) + this session's brainstorming confirmation (full CRUD scope, REST not GraphQL, platform-operator scope, pollable-outbox mechanism).

## Global Constraints (from AGENTS.md, apply to every task)

- Every customer resource requires explicit Personal/business scope authorization; tenant role alone never grants profile access. (N/A to platform-operator CRUD, which is intentionally outside the tenant scope system entirely — see Task 5.)
- Foundry tenant tokens are always invalid — the internal entitlement-snapshot endpoint is service-scoped only, never tenant-scoped.
- Runtime and migration database credentials are separate — reuse existing `expense_app_runtime`/`expense_app_migrator` roles, no new roles.
- Zod contracts are canonical; do not hand-edit generated OpenAPI/client files.
- Use tests first (TDD) for every behavior change.
- Use smallest correct diff — do not touch Wave 1-4 files except where explicitly listed below.

## Implementation Decisions Not Fully Specified in the Design Doc

Documented here (not asked as new questions) because they're implementation-level fill-ins within the already-approved architecture:

1. **Entitlement versioning lives on `tenant_subscriptions`** (one row per tenant, PK = `tenant_id`), as `current_entitlement_version integer`. It bumps by 1 (in the same transaction) on any change that affects effective entitlements for that tenant: subscription plan change, addon add/remove, override add/remove. A new outbox row is written in the same transaction.
2. **Every tenant gets a subscription lazily, not at tenant-creation time** — to avoid touching already-shipped Wave 1 `domain/tenants.ts`. The first call to `resolveEffectiveEntitlements(tenantId)` (or any addon/override mutation) auto-provisions a `tenant_subscriptions` row against the current version of the plan whose `key = 'trial'`, if one doesn't already exist. This is idempotent (`ON CONFLICT DO NOTHING` keyed on `tenant_id`, re-read after).
3. **`granted_by` on addons/overrides is free text**, not a FK — it holds either a user UUID (tenant owner self-service) or a service `clientId` (platform-admin grant), since both routes can create these rows. Documented, not enforced at the DB level; both call sites pass a string.
4. **Outbox polling cursor is a separate global `bigserial`** (`outbox_sequence`), distinct from the per-tenant `entitlement_version` carried in the payload — the query param is `afterSequence`, not `afterVersion`, to avoid conflating a global pagination cursor with the per-tenant version number in the payload.
5. **`FeatureUsageEvent` in this phase only records non-AI feature gating events** (`receipt_forwarding`, `connected_mailbox_scan`) for audit/analytics. AI usage/quota accounting (the `ocr_mode_*`/`ai_search` counters against monthly limits) is Foundry's own runtime quota system per design doc §11 — Phase 0K's job, not built here.
6. **No new env vars.** `serviceGuard` reuses the existing single service-token issuer/audience/JWKS config (`APP_SERVICE_TOKEN_ISSUER` etc.) already wired in `config.ts` — a service token's `client_id`/`scope` claims are what distinguish `platform-admin` from `gateway-auth`/`ai-worker`, not a separate token authority.

## File Structure

- `services/app-api/src/database/migrations/007_plans_entitlements.ts` — new (9 tables + seed data)
- `services/app-api/src/database/types.ts` — modify (add 9 table types + `AppDatabase` entries)
- `packages/contracts/src/plans.ts` — new (all Zod schemas)
- `services/app-api/src/domain/plans.ts` — new (all business logic)
- `services/app-api/src/routes/plans.ts` — new (all routes)
- `services/app-api/src/app.ts` — modify (wire `plansDomain` + `registerPlanRoutes`)
- `services/app-api/test/plans.test.ts` — new (route/auth unit tests, mocked domain — mirrors `test/identity.test.ts`)
- `test/integration/app-domain-0j1.test.ts` — new (real-DB precedence/outbox/constraint tests — mirrors `test/integration/app-domain-wave3.test.ts`)
- `packages/contracts/test/generated-artifacts.test.ts` — modify (assert new paths present)
- `scripts/verify-phase-0j1.mjs` — new (mirrors `scripts/verify-phase-0j-wave4.mjs`)
- `package.json` — modify (add `verify:phase-0j1` script)

---

### Task 1: Migration `007_plans_entitlements`

**Files:**
- Create: `services/app-api/src/database/migrations/007_plans_entitlements.ts`
- Test: `test/integration/app-domain-0j1.test.ts` (schema-shape assertions, Task 8)

**Interfaces:**
- Produces: tables `app.plans`, `app.plan_versions`, `app.feature_definitions`, `app.plan_entitlements`, `app.tenant_subscriptions`, `app.tenant_addons`, `app.tenant_feature_overrides`, `app.feature_usage_events`, `app.entitlement_snapshot_outbox`; seeds one `trial` plan with version 1 and 6 `feature_definitions`.

- [ ] **Step 1: Write the migration**

```typescript
import { type Kysely, sql } from "kysely";

export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE app.plans (
      id uuid PRIMARY KEY,
      key text NOT NULL UNIQUE,
      name text NOT NULL,
      description text,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT plans_key_check CHECK (key ~ '^[a-z][a-z0-9_-]*$')
    )
  `.execute(database);

  await sql`
    CREATE TABLE app.plan_versions (
      id uuid PRIMARY KEY,
      plan_id uuid NOT NULL REFERENCES app.plans(id) ON DELETE CASCADE,
      version_number integer NOT NULL,
      effective_at timestamptz NOT NULL DEFAULT now(),
      is_current boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT plan_versions_plan_number_unique UNIQUE (plan_id, version_number),
      CONSTRAINT plan_versions_id_plan_unique UNIQUE (id, plan_id),
      CONSTRAINT plan_versions_number_check CHECK (version_number > 0)
    )
  `.execute(database);
  await sql`
    CREATE UNIQUE INDEX plan_versions_one_current_per_plan
      ON app.plan_versions (plan_id) WHERE is_current
  `.execute(database);

  await sql`
    CREATE TABLE app.feature_definitions (
      id uuid PRIMARY KEY,
      key text NOT NULL UNIQUE,
      name text NOT NULL,
      description text,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT feature_definitions_key_check CHECK (key ~ '^[a-z][a-z0-9_]*$')
    )
  `.execute(database);

  await sql`
    CREATE TABLE app.plan_entitlements (
      plan_version_id uuid NOT NULL REFERENCES app.plan_versions(id) ON DELETE CASCADE,
      feature_definition_id uuid NOT NULL REFERENCES app.feature_definitions(id),
      is_enabled boolean NOT NULL,
      limit_value integer,
      limit_period text,
      PRIMARY KEY (plan_version_id, feature_definition_id),
      CONSTRAINT plan_entitlements_limit_period_check
        CHECK (limit_period IS NULL OR limit_period IN ('monthly', 'unlimited')),
      CONSTRAINT plan_entitlements_limit_value_check
        CHECK (limit_value IS NULL OR limit_value >= 0)
    )
  `.execute(database);

  await sql`
    CREATE TABLE app.tenant_subscriptions (
      tenant_id uuid PRIMARY KEY REFERENCES app.tenants(id) ON DELETE CASCADE,
      plan_version_id uuid NOT NULL REFERENCES app.plan_versions(id),
      status text NOT NULL DEFAULT 'trialing',
      current_entitlement_version integer NOT NULL DEFAULT 1,
      started_at timestamptz NOT NULL DEFAULT now(),
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT tenant_subscriptions_status_check
        CHECK (status IN ('trialing', 'active', 'canceled')),
      CONSTRAINT tenant_subscriptions_version_check CHECK (version > 0),
      CONSTRAINT tenant_subscriptions_entitlement_version_check
        CHECK (current_entitlement_version > 0)
    )
  `.execute(database);

  await sql`
    CREATE TABLE app.tenant_addons (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
      feature_definition_id uuid NOT NULL REFERENCES app.feature_definitions(id),
      enabled boolean NOT NULL DEFAULT true,
      granted_by text NOT NULL,
      expires_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT tenant_addons_tenant_feature_unique UNIQUE (tenant_id, feature_definition_id)
    )
  `.execute(database);

  await sql`
    CREATE TABLE app.tenant_feature_overrides (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
      feature_definition_id uuid NOT NULL REFERENCES app.feature_definitions(id),
      override_enabled boolean NOT NULL,
      reason text NOT NULL,
      granted_by text NOT NULL,
      expires_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT tenant_feature_overrides_tenant_feature_unique
        UNIQUE (tenant_id, feature_definition_id),
      CONSTRAINT tenant_feature_overrides_reason_check
        CHECK (char_length(reason) BETWEEN 1 AND 2000)
    )
  `.execute(database);

  await sql`
    CREATE TABLE app.feature_usage_events (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
      feature_definition_id uuid NOT NULL REFERENCES app.feature_definitions(id),
      initiating_user_id uuid NOT NULL REFERENCES app.users(id),
      occurred_at timestamptz NOT NULL DEFAULT now(),
      quantity integer NOT NULL DEFAULT 1,
      metadata jsonb,
      CONSTRAINT feature_usage_events_quantity_check CHECK (quantity > 0)
    )
  `.execute(database);
  await sql`
    CREATE INDEX feature_usage_events_tenant_feature_time_index
      ON app.feature_usage_events (tenant_id, feature_definition_id, occurred_at)
  `.execute(database);

  await sql`
    CREATE TABLE app.entitlement_snapshot_outbox (
      outbox_sequence bigserial PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
      entitlement_version integer NOT NULL,
      payload jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT entitlement_snapshot_outbox_tenant_version_unique
        UNIQUE (tenant_id, entitlement_version)
    )
  `.execute(database);

  // Seed: trial plan, version 1, six initial feature definitions, all
  // disabled except the free-tier baseline (receipt_forwarding is always
  // available per design doc "available to every plan"; ai_search on
  // trial is capped at 20/month per design doc).
  await sql`
    INSERT INTO app.feature_definitions (id, key, name, description) VALUES
      ('bbbbbbbb-0001-4000-8000-000000000001', 'receipt_forwarding', 'Receipt Forwarding', 'Forward receipts by email for OCR intake'),
      ('bbbbbbbb-0001-4000-8000-000000000002', 'connected_mailbox_scan', 'Connected Mailbox Scan', 'Scan a connected Gmail/Outlook inbox for receipts'),
      ('bbbbbbbb-0001-4000-8000-000000000003', 'ai_search', 'AI Receipt Search', 'Semantic and natural-language receipt search'),
      ('bbbbbbbb-0001-4000-8000-000000000004', 'ocr_mode_fast', 'OCR Mode: Fast', 'Fast/low-cost OCR extraction mode'),
      ('bbbbbbbb-0001-4000-8000-000000000005', 'ocr_mode_balanced', 'OCR Mode: Balanced', 'Balanced OCR extraction mode'),
      ('bbbbbbbb-0001-4000-8000-000000000006', 'ocr_mode_accurate', 'OCR Mode: Accurate', 'High-accuracy OCR extraction mode')
  `.execute(database);

  await sql`
    INSERT INTO app.plans (id, key, name, description) VALUES
      ('cccccccc-0001-4000-8000-000000000001', 'trial', 'Trial', 'Default plan for new tenants')
  `.execute(database);
  await sql`
    INSERT INTO app.plan_versions (id, plan_id, version_number, is_current) VALUES
      ('dddddddd-0001-4000-8000-000000000001', 'cccccccc-0001-4000-8000-000000000001', 1, true)
  `.execute(database);
  await sql`
    INSERT INTO app.plan_entitlements
      (plan_version_id, feature_definition_id, is_enabled, limit_value, limit_period) VALUES
      ('dddddddd-0001-4000-8000-000000000001', 'bbbbbbbb-0001-4000-8000-000000000001', true, NULL, 'unlimited'),
      ('dddddddd-0001-4000-8000-000000000001', 'bbbbbbbb-0001-4000-8000-000000000002', false, NULL, NULL),
      ('dddddddd-0001-4000-8000-000000000001', 'bbbbbbbb-0001-4000-8000-000000000003', true, 20, 'monthly'),
      ('dddddddd-0001-4000-8000-000000000001', 'bbbbbbbb-0001-4000-8000-000000000004', true, NULL, 'unlimited'),
      ('dddddddd-0001-4000-8000-000000000001', 'bbbbbbbb-0001-4000-8000-000000000005', true, NULL, 'unlimited'),
      ('dddddddd-0001-4000-8000-000000000001', 'bbbbbbbb-0001-4000-8000-000000000006', false, NULL, NULL)
  `.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  await database.schema.dropTable("app.entitlement_snapshot_outbox").ifExists().execute();
  await database.schema.dropTable("app.feature_usage_events").ifExists().execute();
  await database.schema.dropTable("app.tenant_feature_overrides").ifExists().execute();
  await database.schema.dropTable("app.tenant_addons").ifExists().execute();
  await database.schema.dropTable("app.tenant_subscriptions").ifExists().execute();
  await database.schema.dropTable("app.plan_entitlements").ifExists().execute();
  await database.schema.dropTable("app.feature_definitions").ifExists().execute();
  await database.schema.dropTable("app.plan_versions").ifExists().execute();
  await database.schema.dropTable("app.plans").ifExists().execute();
}
```

- [ ] **Step 2: Run migration against local ephemeral Postgres and verify**

Run: `PHASE_0I_INTEGRATION=1 pnpm --filter @expense-tax/app-api run db:migrate` (with compose Postgres up)
Expected: `migration "007_plans_entitlements" up status: Success`

- [ ] **Step 3: Commit** — `git add services/app-api/src/database/migrations/007_plans_entitlements.ts && git commit -m "feat(0j1): add plans/entitlements migration"`

---

### Task 2: Database types

**Files:**
- Modify: `services/app-api/src/database/types.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `PlanTable`, `PlanVersionTable`, `FeatureDefinitionTable`, `PlanEntitlementTable`, `TenantSubscriptionTable`, `TenantAddonTable`, `TenantFeatureOverrideTable`, `TenantFeatureOverrideTable`, `FeatureUsageEventTable`, `EntitlementSnapshotOutboxTable` — column names snake_case matching Task 1's DDL exactly, following the existing `Selectable<XTable>` / `Insertable`-via-`Generated<>` pattern already used for e.g. `BusinessTaxProfileTable`. Add all 9 to the `AppDatabase` interface with their `app.<table>` keys.

- [ ] **Step 1: Add table interfaces** (follow existing `Generated<T>` convention for DB-defaulted columns like `id`-less-serial, `created_at`, `is_current`, `version` — check an existing table like `BusinessTaxProfileTable` for the exact `Generated<>` wrapping convention before writing these, since it is not fully shown in this plan; match it exactly, column-for-column, against Task 1's DDL.)

- [ ] **Step 2: Add all 9 entries to `AppDatabase`**

- [ ] **Step 3: Run `pnpm --filter @expense-tax/app-api run typecheck`** (or repo-root equivalent) — Expected: no errors related to these new types (errors from not-yet-written domain code referencing them are expected and fixed in Task 3).

- [ ] **Step 4: Commit** — `git add services/app-api/src/database/types.ts && git commit -m "feat(0j1): add plans/entitlements database types"`

---

### Task 3: Zod contracts

**Files:**
- Create: `packages/contracts/src/plans.ts`
- Modify: `packages/contracts/src/index.ts` (add `export * from "./plans.js"`, matching how every other contract file is re-exported)

**Interfaces:**
- Produces (consumed by Tasks 4-5): `PlanSchema`/`Plan`, `PlanVersionSchema`/`PlanVersion`, `FeatureDefinitionSchema`/`FeatureDefinition`, `PlanEntitlementSchema`/`PlanEntitlement`, `TenantSubscriptionSchema`/`TenantSubscription`, `TenantAddonSchema`/`TenantAddon`, `TenantFeatureOverrideSchema`/`TenantFeatureOverride`, `EffectiveEntitlementSchema`/`EffectiveEntitlement` (the *resolved* view: `featureKey`, `isEnabled`, `limitValue`, `limitPeriod`, `source: "plan"|"addon"|"override"`), `EntitlementSnapshotSchema`/`EntitlementSnapshot` (outbox payload shape: `tenantId`, `entitlementVersion`, `entitlements: EffectiveEntitlement[]`), plus every Create/Update/List/Params request/response schema needed by Task 5's routes (`PlanCreateRequestSchema`, `PlanVersionCreateRequestSchema` — body is just `{ entitlements: { featureKey, isEnabled, limitValue, limitPeriod }[] }`, since version_number/effective_at/is_current are server-computed, not client-supplied — `FeatureDefinitionCreateRequestSchema`, `TenantSubscriptionUpdateRequestSchema` (`{ planKey: string }`), `TenantAddonCreateRequestSchema` (`{ featureKey: string, reason: string }`), `EntitlementSnapshotListSchema` (internal endpoint response: `{ items: EntitlementSnapshot[], nextAfterSequence: number | null }`).

- [ ] **Step 1: Write the file** using `z.strictObject`, `z.uuid()`, and the existing `TimestampSchema`/`VersionSchema` imports from `./expenses.js` (same as `tax-profiles.ts` does) for every timestamp/version field. Use `z.enum(["monthly", "unlimited"])` for `limitPeriod` (nullable), `z.enum(["plan", "addon", "override"])` for `EffectiveEntitlement.source`, `z.enum(["trialing", "active", "canceled"])` for subscription status. Feature keys are a closed set for now: `export const FeatureKeySchema = z.enum(["receipt_forwarding", "connected_mailbox_scan", "ai_search", "ocr_mode_fast", "ocr_mode_balanced", "ocr_mode_accurate"]); export type FeatureKey = z.infer<typeof FeatureKeySchema>;` — reused everywhere a feature key appears (both as the Zod schema in request bodies and the `FeatureKey` TS type in `domain/plans.ts`), so an unknown key is a 400 at the contract layer, not a domain-layer lookup miss.

- [ ] **Step 2: Add generated-artifacts test coverage** — add the new schema names to whatever list `packages/contracts/test/generated-artifacts.test.ts` already asserts against (open that file first; follow its existing pattern for Wave 2-4 schemas rather than guessing the shape).

- [ ] **Step 3: Run `pnpm --filter @expense-tax/contracts test`** — Expected: passes, including the updated generated-artifacts assertions.

- [ ] **Step 4: Commit**

---

### Task 4: Domain layer — admin CRUD + tenant self-service

**Files:**
- Create: `services/app-api/src/domain/plans.ts`

**Interfaces:**
- Consumes: `AppDatabase` (Kysely), contracts from Task 3, `DomainError` from `../errors.js`, `recordAuditEvent` from `./audit.js` (same pattern as `domain/tax.ts`).
- Produces (consumed by Task 5 routes): a `PlansDomain` interface with:
  - Admin (service-scoped): `createPlan`, `createPlanVersion` (input includes `entitlements` array; creates the new version row + its `plan_entitlements` rows in one transaction, then atomically flips `is_current` off the old version and on for the new one — this is the *only* way plan entitlements ever change, enforcing immutability), `createFeatureDefinition`, `listPlans` (admin variant includes inactive plans + all versions), `getPlan`.
  - Tenant-facing: `listActivePlans()` (only `is_active = true` plans with their current version's entitlements inlined), `getSubscription(tenantId)` (auto-provisions trial subscription per Implementation Decision #2 if missing), `updateSubscription({ tenantId, actorUserId, planKey, requestId })` (owner-only, checked by caller per Task 5's guard — this function itself does not re-check tenant role; matches `tax.ts`'s `requireRole` pattern, so add an equivalent `requireOwner` helper here that queries `app.tenant_memberships` directly, since this domain has no business-scope concept, only tenant-scope), `addAddon`, `removeAddon`, `resolveEffectiveEntitlements(tenantId)` (the precedence engine, override > addon > plan; also lazily provisions the subscription).
  - Outbox: `listEntitlementSnapshotsAfter(afterSequence, limit)` for the internal polling route.
  - Usage: `recordFeatureUsage({ tenantId, featureDefinitionKey, initiatingUserId, quantity, metadata })`.

- [ ] **Step 1: Write the failing precedence-resolution test first** (in a plain unit-test style against a seeded transaction — add this as the first `it()` in Task 8's integration file rather than a separate unit file, since it needs real rows across 4 tables to be meaningful; write it now, run it, watch it fail with "resolveEffectiveEntitlements is not a function", then implement):

```typescript
// (goes into test/integration/app-domain-0j1.test.ts — see Task 8 for full file scaffold)
it("resolves override over addon over plan", async () => {
  const tenantId = randomUUID();
  seedTenantOnly(tenantId); // helper inserting just app.tenants + a user+membership, mirrors seedScope minus business
  const domain = createPlansDomain(database);
  const baseline = await domain.resolveEffectiveEntitlements(tenantId);
  const aiSearch = baseline.find((e) => e.featureKey === "ai_search");
  expect(aiSearch).toMatchObject({ isEnabled: true, limitValue: 20, limitPeriod: "monthly", source: "plan" });

  await domain.addAddon({
    tenantId, actorId: "platform-admin",
    request: { featureKey: "connected_mailbox_scan", reason: "beta tester" },
    requestId: "0j1-precedence-addon",
  });
  const withAddon = await domain.resolveEffectiveEntitlements(tenantId);
  expect(withAddon.find((e) => e.featureKey === "connected_mailbox_scan"))
    .toMatchObject({ isEnabled: true, source: "addon" });

  await database
    .insertInto("app.tenant_feature_overrides")
    .values({
      id: randomUUID(), tenant_id: tenantId,
      feature_definition_id: (await database.selectFrom("app.feature_definitions")
        .select("id").where("key", "=", "connected_mailbox_scan").executeTakeFirstOrThrow()).id,
      override_enabled: false, reason: "abuse review", granted_by: "platform-admin",
    })
    .execute();
  const withOverride = await domain.resolveEffectiveEntitlements(tenantId);
  expect(withOverride.find((e) => e.featureKey === "connected_mailbox_scan"))
    .toMatchObject({ isEnabled: false, source: "override" });
});
```

- [ ] **Step 2: Run it, confirm it fails** — `PHASE_0J1_INTEGRATION=1 pnpm vitest run test/integration/app-domain-0j1.test.ts` — Expected: fails, `createPlansDomain` undefined.

- [ ] **Step 3: Implement `domain/plans.ts`.** Structure of the precedence engine (the core logic every other function builds around):

```typescript
async function resolveEffectiveEntitlements(
  database: Kysely<AppDatabase>,
  tenantId: string,
): Promise<EffectiveEntitlement[]> {
  const subscription = await ensureSubscription(database, tenantId); // Implementation Decision #2
  const planEntitlements = await database
    .selectFrom("app.plan_entitlements as entitlement")
    .innerJoin("app.feature_definitions as feature", "feature.id", "entitlement.feature_definition_id")
    .select(["feature.key as feature_key", "entitlement.is_enabled", "entitlement.limit_value", "entitlement.limit_period"])
    .where("entitlement.plan_version_id", "=", subscription.plan_version_id)
    .execute();
  const addons = await database
    .selectFrom("app.tenant_addons as addon")
    .innerJoin("app.feature_definitions as feature", "feature.id", "addon.feature_definition_id")
    .select(["feature.key as feature_key", "addon.enabled"])
    .where("addon.tenant_id", "=", tenantId)
    .where("addon.enabled", "=", true)
    .where((eb) => eb.or([eb("addon.expires_at", "is", null), eb("addon.expires_at", ">", new Date())]))
    .execute();
  const overrides = await database
    .selectFrom("app.tenant_feature_overrides as override")
    .innerJoin("app.feature_definitions as feature", "feature.id", "override.feature_definition_id")
    .select(["feature.key as feature_key", "override.override_enabled"])
    .where("override.tenant_id", "=", tenantId)
    .where((eb) => eb.or([eb("override.expires_at", "is", null), eb("override.expires_at", ">", new Date())]))
    .execute();

  const byKey = new Map<string, EffectiveEntitlement>();
  for (const row of planEntitlements) {
    byKey.set(row.feature_key, {
      featureKey: row.feature_key as FeatureKey, isEnabled: row.is_enabled,
      limitValue: row.limit_value, limitPeriod: row.limit_period as "monthly" | "unlimited" | null,
      source: "plan",
    });
  }
  for (const row of addons) {
    const existing = byKey.get(row.feature_key);
    byKey.set(row.feature_key, { ...(existing ?? { featureKey: row.feature_key as FeatureKey, limitValue: null, limitPeriod: null }), isEnabled: true, source: "addon" });
  }
  for (const row of overrides) {
    const existing = byKey.get(row.feature_key);
    byKey.set(row.feature_key, { ...(existing ?? { featureKey: row.feature_key as FeatureKey, limitValue: null, limitPeriod: null }), isEnabled: row.override_enabled, source: "override" });
  }
  return [...byKey.values()];
}
```

`ensureSubscription` does the lazy-provision from Implementation Decision #2: look up by `tenant_id`; if absent, `SELECT id FROM app.plan_versions WHERE is_current AND plan_id = (SELECT id FROM app.plans WHERE key = 'trial')`, then `INSERT ... ON CONFLICT (tenant_id) DO NOTHING`, then re-select (handles the race where two concurrent calls both try to provision).

Every mutation (`updateSubscription`, `addAddon`, `removeAddon`) runs in a transaction that: (1) performs its row change, (2) increments `tenant_subscriptions.current_entitlement_version`, (3) calls `resolveEffectiveEntitlements` inside the same transaction, (4) inserts one `entitlement_snapshot_outbox` row with the new version + resolved snapshot as `payload`, (5) calls `recordAuditEvent`.

`createPlanVersion`'s "atomically flip is_current" step: `UPDATE app.plan_versions SET is_current = false WHERE plan_id = $1 AND is_current` then insert the new version row with `is_current = true`, both inside one transaction — the partial unique index from Task 1 (`plan_versions_one_current_per_plan`) guarantees no two versions of the same plan are ever concurrently current even under a race, since the second concurrent transaction's insert would violate the unique index and roll back (surfaced as `DomainError.conflict()` on the `23505` Postgres error code, same pattern as `domain/tax.ts`'s `createProfile`).

- [ ] **Step 4: Run the precedence test again** — Expected: PASS.

- [ ] **Step 5: Write and pass the remaining domain tests** (admin CRUD happy path, `requireOwner` rejects non-owner, `updateSubscription` to an unknown `planKey` throws `DomainError.validation()`, `addAddon` for an already-addon'd feature is idempotent/upserts) directly into Task 8's file.

- [ ] **Step 6: Commit**

---

### Task 5: Routes

**Files:**
- Create: `services/app-api/src/routes/plans.ts`

**Interfaces:**
- Consumes: `PlansDomain` from Task 4, `IdentityResolver` from `../domain/authenticated-user.js`, `serviceGuard`/`tenantGuard`/`authenticatedUserGuard` from `../plugins/auth.js` (all pre-existing, no changes needed), contracts from Task 3.
- Produces: `registerPlanRoutes(app, { identityResolver, plansDomain })`, consumed by Task 6.

Routes (mirrors the `authentication()`/`errors` helper pattern from `routes/tax.ts` exactly):

| Method | Path | Guard | Notes |
|---|---|---|---|
| POST | `/internal/v1/plans` | `serviceGuard("platform-admin", ["plans:manage"])` | create plan |
| POST | `/internal/v1/plans/:planId/versions` | `serviceGuard("platform-admin", ["plans:manage"])` | create immutable version + entitlements, flips current |
| GET | `/internal/v1/plans` | `serviceGuard("platform-admin", ["plans:manage"])` | admin list, all plans/versions |
| POST | `/internal/v1/feature-definitions` | `serviceGuard("platform-admin", ["plans:manage"])` | create feature definition |
| GET | `/api/v1/plans` | tenant (`tenantGuard` + `authenticatedUserGuard`) | active plans only, current version's entitlements inlined |
| GET | `/api/v1/tenants/:tenantId/subscription` | tenant, owner-only inside domain call | `getSubscription` |
| PUT | `/api/v1/tenants/:tenantId/subscription` | tenant, owner-only inside domain call | `updateSubscription` |
| POST | `/api/v1/tenants/:tenantId/addons` | tenant, owner-only | `addAddon` |
| DELETE | `/api/v1/tenants/:tenantId/addons/:featureKey` | tenant, owner-only | `removeAddon` |
| GET | `/api/v1/tenants/:tenantId/entitlements` | tenant (any active member) | `resolveEffectiveEntitlements` — lets the frontend gate UI without needing owner role |
| GET | `/internal/v1/entitlement-snapshots` | `serviceGuard("foundry-service", ["entitlements:read"])` | query param `afterSequence` (default 0), `limit` (default 100, max 500); calls `listEntitlementSnapshotsAfter` |

- [ ] **Step 1: Write the file** following `routes/tax.ts`'s exact structure: `TaxRouteOptions`-equivalent interface, `authentication()`/`errors` const helpers, one `typedApp.<method>(path, { preHandler, schema }, handler)` block per row above. For the 4 `serviceGuard`-protected routes, `preHandler: [serviceGuard("platform-admin", ["plans:manage"])]` replaces the tenant `authentication()` array (no `tenantGuard`/`authenticatedUserGuard` — service tokens never carry a tenant identity, matching `routes/identity.ts`'s `/internal/v1/identity-provisionings` route exactly).

- [ ] **Step 2: Commit**

---

### Task 6: Wire into `app.ts`

**Files:**
- Modify: `services/app-api/src/app.ts:1-232` (see full current content already read this session)

- [ ] **Step 1:** Add `import { createPlansDomain, type PlansDomain } from "./domain/plans.js";` and `import { registerPlanRoutes } from "./routes/plans.js";`
- [ ] **Step 2:** Add `readonly plansDomain?: PlansDomain;` to `BuildAppOptions`
- [ ] **Step 3:** Add `const plansDomain = options.plansDomain ?? createPlansDomain(database);` alongside the other domain instantiations
- [ ] **Step 4:** Add `app.register(registerPlanRoutes, { identityResolver: identityDomain, plansDomain });` after the existing `registerTaxRoutes` call
- [ ] **Step 5:** Run `pnpm --filter @expense-tax/app-api run typecheck && pnpm --filter @expense-tax/app-api test` — Expected: all pre-existing tests still pass (this task only adds, never removes, wiring)
- [ ] **Step 6: Commit**

---

### Task 7: Route/auth unit tests

**Files:**
- Create: `services/app-api/test/plans.test.ts`

Mirrors `test/identity.test.ts`'s structure exactly: `TEST_ENV`, `servicePrincipal(clientId, scopes)` helper, `buildApp({ ..., authVerifiers: { tenant, service }, plansDomain: <mocked via vi.fn()> })`, `app.inject(...)`.

- [ ] **Step 1: Write failing tests covering:**
  - `POST /internal/v1/plans` with a tenant token → 401
  - `POST /internal/v1/plans` with a service token missing `plans:manage` scope → 403
  - `POST /internal/v1/plans` with a service token for the wrong `clientId` (e.g. `"ai-worker"`) even with the right scope → 403 (proves `serviceGuard`'s principal check, not just scope check)
  - `POST /internal/v1/plans` with `platform-admin` + `plans:manage` → 201, mocked domain called with expected args
  - `GET /internal/v1/entitlement-snapshots` with a `platform-admin` token (wrong principal for this route — only `foundry-service` is allowed) → 403
  - `GET /internal/v1/entitlement-snapshots?afterSequence=5` with a `foundry-service` token + `entitlements:read` scope → 200, mocked `listEntitlementSnapshotsAfter` called with `(5, 100)` (default limit)
  - `GET /api/v1/plans` with a valid tenant token → 200
  - `PUT /api/v1/tenants/:tenantId/subscription` with a tenant token → 200, mocked domain called with `actorUserId` from the resolved identity (not from any request body/header — same anti-spoofing check as `identity.test.ts`'s "ignoring spoofed headers" case)
- [ ] **Step 2: Run, confirm failures** — `pnpm --filter @expense-tax/app-api test plans.test.ts` — Expected: fails (route file doesn't exist yet if run before Task 5, or mocks mismatched).
- [ ] **Step 3: Fix until green.**
- [ ] **Step 4: Commit**

---

### Task 8: Real-database integration test

**Files:**
- Create: `test/integration/app-domain-0j1.test.ts`

Mirrors `test/integration/app-domain-wave3.test.ts`'s scaffold exactly (same `runSql`/`executeSql`/`expectConstraint` helpers, same `describe.skipIf(!integrationEnabled)` gate with a new env var `PHASE_0J1_INTEGRATION`, same `runKey`-suffixed cleanup in `afterAll`). Add a `seedTenantOnly(tenantId)` helper (subset of `seedScope` — just `app.tenants` + one owner `app.tenant_memberships` row, no business, since plans/entitlements are tenant-scoped not business-scoped).

- [ ] **Step 1:** Schema-shape test: assert all 9 tables exist (same `to_regclass` pattern as Wave 3's first test).
- [ ] **Step 2:** Seed-data test: assert the `trial` plan/version/6 feature_definitions/6 plan_entitlements rows exist with the exact values from Task 1's seed.
- [ ] **Step 3:** Constraint tests via `expectConstraint`: `plan_versions_one_current_per_plan` (insert a second `is_current = true` row for the same plan → fails), `tenant_addons_tenant_feature_unique`, `tenant_feature_overrides_reason_check` (empty reason fails).
- [ ] **Step 4:** The precedence-resolution test from Task 4 Step 1.
- [ ] **Step 5:** Outbox test: after `updateSubscription`/`addAddon`, assert an `entitlement_snapshot_outbox` row exists with the incremented `entitlement_version` and a `payload` matching `resolveEffectiveEntitlements`'s current result; call `listEntitlementSnapshotsAfter(0, 100)` and assert it's included; call again with `afterSequence` past it and assert it's excluded.
- [ ] **Step 6:** Owner-only enforcement test: non-owner tenant member calling `updateSubscription` → rejects with `DomainError` `FORBIDDEN` (same assertion style as Wave 3's viewer-update-rejection test).
- [ ] **Step 7: Run full suite:** `PHASE_0J1_INTEGRATION=1 pnpm vitest run test/integration/app-domain-0j1.test.ts` — Expected: all pass.
- [ ] **Step 8: Commit**

---

### Task 9: Generated artifacts + verify script

**Files:**
- Modify: whatever OpenAPI/TS-client generation command Wave 4 used (check `package.json` scripts for `generate` / `openapi`; re-run it) and `packages/contracts/test/generated-artifacts.test.ts`
- Create: `scripts/verify-phase-0j1.mjs` (copy `scripts/verify-phase-0j-wave4.mjs`, update env var names to `PHASE_0J1_INTEGRATION`, migration count expectation to include `007_plans_entitlements`, and test file list to include `plans.test.ts` + `app-domain-0j1.test.ts`)
- Modify: `package.json` — add `"verify:phase-0j1": "node scripts/verify-phase-0j1.mjs"`

- [ ] **Step 1:** Re-run whichever `pnpm` script generates the OpenAPI JSON + TS client from Zod contracts (find it in root `package.json`; Wave 2-4 already established this — do not guess, read the script first).
- [ ] **Step 2:** Update `generated-artifacts.test.ts` to assert the new `/api/v1/plans`, `/api/v1/tenants/:tenantId/subscription`, `/api/v1/tenants/:tenantId/addons`, `/api/v1/tenants/:tenantId/entitlements` paths are present in the generated App OpenAPI spec, and that `/internal/v1/plans`, `/internal/v1/feature-definitions`, `/internal/v1/entitlement-snapshots` are present too (or excluded, matching whatever rule Wave 2-4 used for internal-vs-public path inclusion — check the existing test file's assertions before writing new ones, do not assume).
- [ ] **Step 3:** Write `scripts/verify-phase-0j1.mjs` and its `package.json` script entry.
- [ ] **Step 4:** Run the full zero-skip gate:
```bash
PHASE_0I_INTEGRATION=1 PHASE_0J_INTEGRATION=1 PHASE_0J_WAVE2_INTEGRATION=1 \
PHASE_0J_WAVE3_INTEGRATION=1 PHASE_0J_WAVE4_INTEGRATION=1 PHASE_0J1_INTEGRATION=1 \
pnpm verify:phase-0j1
```
Expected: zero skips, all Wave 1-4 counts unchanged, plus new 0J1 tests passing.
- [ ] **Step 5: Commit.**

---

## Self-Review Notes

- **Spec coverage:** all 8 owned entity types from design doc §10 have tables + domain functions + at least one route; both authorization rules ("Team/Enterprise or premium add-on" for mailbox scan, "20/month trial cap" for ai_search) are represented in seed data; outbox mechanism satisfies "monotonic tenant entitlement version," "applied idempotently" (unique `(tenant_id, entitlement_version)`), and "new reservations carry current version" is Foundry-side (Phase 0K) consumption of this endpoint, not built here.
- **Deferred to Phase 0K (not gaps in this plan):** `ENTITLEMENT_SYNC_PENDING` response and quota reservation lifecycle live entirely in Foundry, which doesn't exist as a consumer of this outbox yet — this plan only builds the producer side (App API) and the pull endpoint's read path.
- **Deferred to Phase 0L (not gaps in this plan):** Python worker OpenAPI client codegen (this session's REST-vs-GraphQL discussion) — added as a follow-up note under Phase 0L's own future plan, not a task here.
