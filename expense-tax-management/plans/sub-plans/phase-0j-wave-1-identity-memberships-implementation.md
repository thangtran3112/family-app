# Phase 0J Wave 1 Identity and Memberships Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Status**: Complete

**Goal:** Build provider-neutral identity provisioning, tenant bootstrap, invitations, tenant and Personal memberships, authorization context, audit, and idempotency inside App API.

**Architecture:** Canonical Zod schemas define transport behavior. Fastify routes depend on focused domain-service interfaces whose Kysely implementations own transactions and authorization queries. One forward-only App migration enforces identity and membership invariants; route tests isolate HTTP wiring, while root integration tests prove real PostgreSQL behavior.

**Tech Stack:** Node.js 24, TypeScript 5.9 strict mode, Fastify 5, Zod 4, Kysely 0.29, PostgreSQL 17, Vitest 5, pnpm 11.9, Docker Compose

**Spec:** `plans/sub-plans/phase-0j-personal-business-tax-domain-design.md`

## Global Constraints

- Git root is `family-app/`; project root is `expense-tax-management/`.
- Preserve all existing `plans/mockups/**` changes without editing, staging, stashing, resetting, or cleaning them.
- Shared `../infrastructure/**` remains read-only.
- Do not commit or push unless user explicitly requests it.
- External identity providers own credentials. Do not add passwords, OAuth SDKs, signing keys, refresh tokens, or provider-specific code.
- App API must validate signed tenant or service identity and must ignore forwarded user, tenant, profile, email, and role headers for domain authorization.
- Production private networking never replaces signed service identity.
- Database runtime role performs DML only; migration role owns DDL.
- No legacy database backfill, dual write, compatibility adapter, or Phase 0J behavior in FastAPI.
- Public schemas are strict Zod objects. Database models remain private to App API.
- Tests protect contracts, authentication, authorization, transactions, idempotency, and database constraints; avoid tests for trivial accessors or framework behavior.
- Every behavioral task follows RED, GREEN, REFACTOR. Configuration and deterministic generated output use direct verification.

---

### Task 1: Wave 1 Canonical Contracts

**Files:**
- Create: `packages/contracts/src/identity.ts`
- Create: `packages/contracts/src/tenants.ts`
- Create: `packages/contracts/src/memberships.ts`
- Create: `packages/contracts/test/wave1-contracts.test.ts`
- Modify: `packages/contracts/src/index.ts`

**Interfaces:**
- Consumes: Zod 4 and existing strict contract conventions.
- Produces: `UserSchema`, `IdentityProvisioningRequestSchema`, `TenantSchema`, `TenantCreateRequestSchema`, `TenantUpdateRequestSchema`, `TenantBootstrapSchema`, `TenantMembershipSchema`, `PersonalProfileSchema`, `PersonalMembershipSchema`, `TenantInvitationSchema`, `TenantInvitationCreateRequestSchema`, `TenantInvitationAcceptRequestSchema`, membership mutation/list schemas, and inferred TypeScript types.

- [ ] **Step 1: Write failing identity contract tests**

Add tests proving strict provider-neutral identity input and response behavior:

```typescript
import { describe, expect, it } from "vitest";
import {
  IdentityProvisioningRequestSchema,
  TenantBootstrapSchema,
  TenantInvitationCreateRequestSchema,
} from "../src/index.js";

describe("Phase 0J Wave 1 contracts", () => {
  it("requires a verified normalized identity", () => {
    expect(() =>
      IdentityProvisioningRequestSchema.parse({
        issuer: "https://identity.internal.test",
        subject: "provider-user-1",
        email: "user@example.com",
        emailVerified: false,
        displayName: "Test User",
      }),
    ).toThrow();
  });

  it("rejects unknown tenant bootstrap response keys", () => {
    expect(() => TenantBootstrapSchema.parse({ extra: true })).toThrow();
  });

  it("allows tenant-only or Personal invitation grants", () => {
    expect(
      TenantInvitationCreateRequestSchema.parse({
        email: "member@example.com",
        tenantRole: "member",
        grant: { type: "personal", profileId: crypto.randomUUID(), role: "viewer" },
      }).grant.type,
    ).toBe("personal");
  });
});
```

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter @expense-tax/contracts exec vitest run test/wave1-contracts.test.ts`

Expected: FAIL because Wave 1 schemas are not exported.

- [ ] **Step 3: Implement strict schemas**

Use shared primitives within each module rather than duplicating wire formats:

```typescript
const UuidSchema = z.string().uuid();
const TimestampSchema = z.string().datetime({ offset: true });
export const TenantRoleSchema = z.enum(["owner", "admin", "member"]);
export const ProfileRoleSchema = z.enum(["owner", "editor", "viewer"]);

export const IdentityProvisioningRequestSchema = z.strictObject({
  issuer: z.string().url(),
  subject: z.string().trim().min(1).max(255),
  email: z.string().trim().toLowerCase().email(),
  emailVerified: z.literal(true),
  displayName: z.string().trim().min(1).max(100),
});
```

Contract requirements:

- `UserSchema`: UUID ID, `primaryEmail`, `displayName`, `active|disabled`, timestamps.
- `TenantSchema`: UUID ID, name, immutable slug, `active|archived`, positive integer version, timestamps.
- `TenantMembershipSchema`: tenant/user IDs, tenant role, `active|inactive`, version, timestamps.
- `PersonalProfileSchema`: ID, tenant ID, name, version, timestamps.
- `PersonalMembershipSchema`: profile/tenant/user IDs, profile role, status, version, timestamps.
- `TenantCreateRequestSchema`: name only, trimmed length 1-100.
- `TenantUpdateRequestSchema`: expected positive version and trimmed name length 1-100.
- `TenantBootstrapSchema`: tenant plus creator tenant membership, Personal profile, and Personal membership.
- Invitation create body: normalized email, tenant role, and discriminated `grant` union of `{type:"none"}` or `{type:"personal",profileId,role}`.
- Invitation response: metadata plus `invitationToken` only on creation response; stored/list representations omit raw token.
- Invitation acceptance body: raw token length 32-512.
- `TenantMembershipUpdateRequestSchema`: expected positive version, optional next tenant role, and optional next status; at least one change required.
- `PersonalMembershipCreateRequestSchema`: provisioned user UUID and profile role.
- `PersonalMembershipUpdateRequestSchema`: expected positive version, optional next profile role, and optional next status; at least one change required.
- Tenant and Personal membership list schemas: strict `{items: [...]}` envelopes.

- [ ] **Step 4: Export every schema and inferred type from package index**

Use named exports only:

```typescript
export * from "./identity.js";
export * from "./tenants.js";
export * from "./memberships.js";
```

- [ ] **Step 5: Verify GREEN**

Run: `pnpm --filter @expense-tax/contracts exec vitest run test/wave1-contracts.test.ts`

Expected: all Wave 1 contract tests PASS.

- [ ] **Step 6: Run focused static gates**

Run:

```bash
pnpm --filter @expense-tax/contracts typecheck
pnpm --filter @expense-tax/contracts lint
pnpm --filter @expense-tax/contracts build
```

Expected: all PASS.

---

### Task 2: Identity and Membership Database Schema

**Files:**
- Create: `services/app-api/src/database/migrations/002_identity_memberships.ts`
- Modify: `services/app-api/src/database/types.ts`
- Create: `test/integration/app-domain-wave1.test.ts`

**Interfaces:**
- Consumes: App schema and Kysely migrator from Phase 0I.
- Produces: typed `app.users`, `app.auth_identities`, `app.tenants`, `app.tenant_memberships`, `app.personal_profiles`, `app.personal_memberships`, `app.tenant_invitations`, `app.app_audit_events`, and `app.idempotency_records` tables.

- [ ] **Step 1: Write failing real-PostgreSQL schema tests**

Gate test on `PHASE_0J_INTEGRATION === "1"`. Resolve project root from `import.meta.url`, read normalized Compose configuration through `scripts/compose.sh config --format json`, and execute SQL through the running PostgreSQL container without printing passwords.

Test these observable constraints:

```typescript
it("rejects duplicate issuer and subject", () => {
  expect(runSqlAsAppRuntime(duplicateIdentitySql).status).not.toBe(0);
});

it("allows only one Personal profile per tenant", () => {
  expect(runSqlAsAppRuntime(secondPersonalProfileSql).status).not.toBe(0);
});

it("rejects invitation with conflicting Personal grant fields", () => {
  expect(runSqlAsAppRuntime(invalidInvitationGrantSql).status).not.toBe(0);
});
```

Use unique UUIDs per test and delete created rows in reverse dependency order.

- [ ] **Step 2: Verify RED before migration**

Run: `PHASE_0J_INTEGRATION=1 pnpm exec vitest run test/integration/app-domain-wave1.test.ts`

Expected: FAIL because `app.users` and related tables do not exist.

- [ ] **Step 3: Create forward migration**

Create tables in this order:

1. `users`
2. `auth_identities`
3. `tenants`
4. `tenant_memberships`
5. `personal_profiles`
6. `personal_memberships`
7. `tenant_invitations`
8. `app_audit_events`
9. `idempotency_records`

Use application-generated UUIDs, `timestamptz default now()`, integer `version default 1`, and raw Kysely `sql` only for checks or partial indexes not expressible through schema builder.

Required indexes and checks:

```sql
unique (issuer, subject)
unique (tenant_id, user_id)
unique (tenant_id) -- personal_profiles
unique (personal_profile_id, user_id)
unique (token_hash)
unique (actor_key, operation_key, idempotency_key)
check (primary_email = lower(trim(primary_email)))
check (normalized_email = lower(trim(normalized_email)))
check (tenant role in ('owner','admin','member'))
check (profile role in ('owner','editor','viewer'))
check (status values match the approved schema)
check (
  (personal_profile_id is null and personal_role is null)
  or
  (personal_profile_id is not null and personal_role is not null)
)
```

Add unique `(id, tenant_id)` on `personal_profiles` for composite references. `personal_memberships.(personal_profile_id, tenant_id)` and invitation Personal grant fields reference that pair, so profile and tenant cannot diverge. User and tenant membership use separate normal foreign keys to global `users.id` and `tenants.id`.

Down migration drops tables in exact reverse order. It never drops the `app` schema or Phase 0I metadata.

- [ ] **Step 4: Add Kysely table interfaces**

Use `ColumnType`, `Generated`, `Insertable`, `Selectable`, and `Updateable` as needed. Date reads are `Date`; JSON response snapshots use existing `JsonValue`.

```typescript
export interface UserTable {
  readonly id: string;
  primary_email: string;
  display_name: string;
  status: "active" | "disabled";
  readonly created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
```

Register every table under schema-qualified keys in `AppDatabase`.

- [ ] **Step 5: Apply migration**

Run:

```bash
./scripts/compose.sh up -d postgres
./scripts/compose.sh run --rm app-api-migrate
```

Expected: migration `002_identity_memberships` succeeds.

- [ ] **Step 6: Verify GREEN**

Run: `PHASE_0J_INTEGRATION=1 pnpm exec vitest run test/integration/app-domain-wave1.test.ts`

Expected: schema constraint tests PASS.

---

### Task 3: Domain Errors and Authenticated User Context

**Files:**
- Create: `services/app-api/src/domain/errors.ts`
- Create: `services/app-api/src/domain/types.ts`
- Create: `services/app-api/src/plugins/domain-auth.ts`
- Modify: `services/app-api/src/errors.ts`
- Create: `services/app-api/test/domain-auth.test.ts`

**Interfaces:**
- Consumes: verified `AuthPrincipal` from `tenantGuard` and Wave 1 `User` contracts.
- Produces: `DomainError`, focused identity/tenant/membership domain interfaces, `AuthenticatedUser`, `authenticatedUserGuard`, and request `authenticatedUser` decoration.

- [ ] **Step 1: Write failing domain-auth tests**

Test:

- unprovisioned valid tenant token returns `401` without revealing subject
- disabled user returns `403`
- active resolved user is attached to request
- `DomainError.notFound()` serializes `404 NOT_FOUND`
- `DomainError.conflict()` serializes `409 CONFLICT`

Use injected domain services and real Fastify injection; do not mock Kysely chains.

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter @expense-tax/app-api exec vitest run test/domain-auth.test.ts`

Expected: FAIL because domain auth context and errors do not exist.

- [ ] **Step 3: Define stable domain interfaces**

```typescript
export interface AuthenticatedUser {
  readonly id: string;
  readonly primaryEmail: string;
  readonly displayName: string;
  readonly status: "active" | "disabled";
}

export interface IdentityDomain {
  provision(input: {
    readonly identity: IdentityProvisioningRequest;
    readonly actorServicePrincipal: string;
    readonly requestId: string;
  }): Promise<{ readonly user: User; readonly created: boolean }>;
  resolve(issuer: string, subject: string): Promise<AuthenticatedUser | null>;
}

export interface MutationResult<T> {
  readonly statusCode: 200 | 201;
  readonly body: T;
  readonly replayed: boolean;
}

export interface TenantDomain {
  create(input: {
    readonly actorUserId: string;
    readonly request: TenantCreateRequest;
    readonly idempotencyKey: string;
    readonly requestId: string;
  }): Promise<MutationResult<TenantBootstrap>>;
  list(actorUserId: string): Promise<readonly Tenant[]>;
  get(actorUserId: string, tenantId: string): Promise<Tenant>;
  update(input: {
    readonly actorUserId: string;
    readonly tenantId: string;
    readonly request: TenantUpdateRequest;
    readonly requestId: string;
  }): Promise<Tenant>;
}

export interface MembershipDomain {
  createInvitation(input: CreateInvitationCommand): Promise<{
    readonly invitation: TenantInvitation;
    readonly invitationToken: string;
  }>;
  acceptInvitation(input: AcceptInvitationCommand): Promise<MutationResult<TenantInvitation>>;
  listTenantMemberships(actorUserId: string, tenantId: string): Promise<readonly TenantMembership[]>;
  updateTenantMembership(input: UpdateTenantMembershipCommand): Promise<TenantMembership>;
  listPersonalMemberships(input: PersonalScopeCommand): Promise<readonly PersonalMembership[]>;
  createPersonalMembership(input: CreatePersonalMembershipCommand): Promise<PersonalMembership>;
  updatePersonalMembership(input: UpdatePersonalMembershipCommand): Promise<PersonalMembership>;
}

export interface CreateInvitationCommand {
  readonly actorUserId: string;
  readonly tenantId: string;
  readonly request: TenantInvitationCreateRequest;
  readonly requestId: string;
}

export interface AcceptInvitationCommand {
  readonly actorUserId: string;
  readonly request: TenantInvitationAcceptRequest;
  readonly requestId: string;
}

export interface UpdateTenantMembershipCommand {
  readonly actorUserId: string;
  readonly tenantId: string;
  readonly targetUserId: string;
  readonly request: TenantMembershipUpdateRequest;
  readonly requestId: string;
}

export interface PersonalScopeCommand {
  readonly actorUserId: string;
  readonly tenantId: string;
  readonly profileId: string;
}

export interface CreatePersonalMembershipCommand extends PersonalScopeCommand {
  readonly request: PersonalMembershipCreateRequest;
  readonly requestId: string;
}

export interface UpdatePersonalMembershipCommand extends PersonalScopeCommand {
  readonly targetUserId: string;
  readonly request: PersonalMembershipUpdateRequest;
  readonly requestId: string;
}
```

Contract types in these signatures come from Task 1 exports. Use no Fastify types in domain interfaces.

- [ ] **Step 4: Implement `DomainError`**

```typescript
export class DomainError extends Error {
  constructor(
    readonly statusCode: 400 | 401 | 403 | 404 | 409,
    readonly code: "VALIDATION_ERROR" | "REQUEST_ERROR" | "NOT_FOUND" | "CONFLICT",
  ) {
    super(code);
  }
}
```

Expose named constructors for unauthorized, forbidden, not found, and conflict. Error handler uses stable public messages and never sends internal exception text.

- [ ] **Step 5: Implement authenticated-user guard**

Run after `tenantGuard`. Resolve using verified principal issuer and subject. Reject missing identity with `401`; reject disabled user with `403`; otherwise decorate request.

- [ ] **Step 6: Verify GREEN and regressions**

Run:

```bash
pnpm --filter @expense-tax/app-api exec vitest run test/domain-auth.test.ts
pnpm --filter @expense-tax/app-api test
pnpm --filter @expense-tax/app-api typecheck
```

Expected: focused and existing App API tests PASS.

---

### Task 4: Identity Provisioning and Current User

**Files:**
- Create: `services/app-api/src/domain/identity.ts`
- Create: `services/app-api/src/domain/audit.ts`
- Create: `services/app-api/src/routes/identity.ts`
- Modify: `services/app-api/src/app.ts`
- Create: `services/app-api/test/identity.test.ts`
- Extend: `test/integration/app-domain-wave1.test.ts`

**Interfaces:**
- Consumes: `IdentityDomain`, identity contracts, App Kysely tables, `serviceGuard("gateway-auth", ["identity:provision"])`, and authenticated-user guard.
- Produces: idempotent identity persistence, `POST /internal/v1/identity-provisionings`, and `GET /api/v1/users/me`.

- [ ] **Step 1: Write failing route tests**

Test:

- tenant token cannot call internal provisioning
- wrong service principal or missing scope returns `403`
- `gateway-auth` service token returns `201` for new identity
- repeated same issuer/subject returns `200` and same user ID
- unknown request fields return `400`
- `/api/v1/users/me` returns resolved active user and ignores spoofed identity headers

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter @expense-tax/app-api exec vitest run test/identity.test.ts`

Expected: FAIL with route-not-found assertions.

- [ ] **Step 3: Implement identity transaction**

Normalize email to trimmed lowercase. Query identity by exact issuer and subject. Existing identity updates verified email, last-authenticated timestamp, and user display fields. New identity inserts user, identity, and audit event in one transaction. Never query user by email for linking.

```typescript
const existing = await transaction
  .selectFrom("app.auth_identities")
  .select(["id", "user_id"])
  .where("issuer", "=", input.issuer)
  .where("subject", "=", input.subject)
  .executeTakeFirst();
```

Handle unique-race conflict outside the rolled-back transaction by re-reading `(issuer, subject)` in a new query and returning that identity; do not create a second user.

- [ ] **Step 4: Implement routes**

Route schemas come only from contracts. Internal response status is `201` for creation and `200` for idempotent update. Current-user route runs tenant token verification then authenticated-user resolution. `BuildAppOptions` gains optional `identityDomain`; default is `createIdentityDomain(database)`. Register domain-auth request decoration before identity routes.

- [ ] **Step 5: Add real database identity cases**

Integration suite provisions two identities with same email but different subjects and asserts different user IDs. It repeats one subject and asserts one identity row and one user row for that subject.

- [ ] **Step 6: Verify GREEN**

Run:

```bash
pnpm --filter @expense-tax/app-api exec vitest run test/identity.test.ts
PHASE_0J_INTEGRATION=1 pnpm exec vitest run test/integration/app-domain-wave1.test.ts
```

Expected: route and database identity tests PASS.

---

### Task 5: Tenant Bootstrap and Tenant Routes

**Files:**
- Create: `services/app-api/src/domain/idempotency.ts`
- Create: `services/app-api/src/domain/tenants.ts`
- Create: `services/app-api/src/routes/tenants.ts`
- Modify: `services/app-api/src/app.ts`
- Create: `services/app-api/test/tenants.test.ts`
- Extend: `test/integration/app-domain-wave1.test.ts`

**Interfaces:**
- Consumes: authenticated user, tenant contracts, identity tables, audit service, and idempotency table.
- Produces: atomic tenant/Personal bootstrap plus tenant create/list/get/update routes.

- [ ] **Step 1: Write failing tenant route tests**

Test:

- unprovisioned identity cannot create tenant
- create requires `Idempotency-Key`
- create returns tenant, tenant owner membership, Personal profile, Personal owner membership
- repeated key and same normalized payload returns same result
- repeated key and different payload returns `409`
- tenant list returns only active memberships
- foreign tenant get returns `404`
- tenant admin can update tenant name with expected version
- tenant member cannot update tenant

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter @expense-tax/app-api exec vitest run test/tenants.test.ts`

Expected: FAIL with route-not-found assertions.

- [ ] **Step 3: Implement idempotency helper**

Hash normalized request JSON with SHA-256. Store only non-sensitive response snapshot. Lock existing idempotency row with `FOR UPDATE`. Matching request hash returns stored status/body; differing hash throws `409`. If concurrent requests both observe no row, unique conflict rolls back one transaction; that caller re-reads the committed record in a new transaction and applies the same hash comparison.

```typescript
export interface IdempotentMutationInput<T> {
  readonly actorKey: string;
  readonly operationKey: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly execute: (transaction: Transaction<AppDatabase>) => Promise<T>;
}
```

- [ ] **Step 4: Implement atomic tenant bootstrap**

Generate tenant and profile UUIDs in application code. Slug is normalized name plus first eight tenant UUID hex characters, for example `family-a1b2c3d4`. In one transaction insert tenant, tenant owner membership, Personal profile, Personal owner membership, audit event, and idempotency result.

Wave 2 extends this same transaction with baseline spending categories; do not create a temporary category table in Wave 1.

- [ ] **Step 5: Implement tenant reads and optimistic update**

Every query joins active tenant membership. Update uses tenant owner/admin role and `WHERE version = expectedVersion`; zero updated rows after authorized read returns `409`.

`BuildAppOptions` gains optional `tenantDomain`; default is `createTenantDomain(database)`. Register tenant routes with identity and tenant domain dependencies.

- [ ] **Step 6: Add real database transaction cases**

Integration suite asserts one tenant, one Personal profile, and two owner memberships after bootstrap. Concurrent requests using the same idempotency key produce one tenant; reuse with a different payload creates no additional tenant or membership rows.

- [ ] **Step 7: Verify GREEN**

Run:

```bash
pnpm --filter @expense-tax/app-api exec vitest run test/tenants.test.ts
PHASE_0J_INTEGRATION=1 pnpm exec vitest run test/integration/app-domain-wave1.test.ts
```

Expected: tenant route and atomicity tests PASS.

---

### Task 6: Invitations and Membership Administration

**Files:**
- Create: `services/app-api/src/domain/memberships.ts`
- Create: `services/app-api/src/routes/memberships.ts`
- Modify: `services/app-api/src/app.ts`
- Create: `services/app-api/test/memberships.test.ts`
- Extend: `test/integration/app-domain-wave1.test.ts`

**Interfaces:**
- Consumes: authenticated user, membership contracts, tenant and Personal membership tables, audit service, SHA-256, and cryptographic random bytes.
- Produces: tenant-only and Personal invitations, invitation acceptance, membership list/update/deactivate, final-owner protection, and denial audit behavior.

- [ ] **Step 1: Write failing membership route tests**

Test:

- tenant admin can create tenant-only invitation
- tenant admin cannot attach Personal grant without Personal owner role
- Personal owner can attach matching Personal grant
- invitation creation returns raw token once and list response never returns it
- acceptance requires matching verified identity email
- repeated acceptance by same user returns existing result
- expired, revoked, used-by-other-user, or mismatched-email invitation returns `409` or `403` as specified
- tenant owner/admin role grants no Personal read
- viewer cannot mutate membership
- final active tenant owner and final active Personal owner cannot be demoted or deactivated
- foreign profile returns `404` and emits denial audit call
- failed denial-audit persistence still returns the original denial and emits a redacted structured security log

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter @expense-tax/app-api exec vitest run test/memberships.test.ts`

Expected: FAIL with route-not-found assertions.

- [ ] **Step 3: Implement secure invitation tokens**

Generate 32 random bytes and encode base64url. Persist `sha256(rawToken)` only. Raw token is returned only from create method result and redacted by existing logger field rules.

```typescript
const rawToken = randomBytes(32).toString("base64url");
const tokenHash = createHash("sha256").update(rawToken).digest("hex");
```

Default expiry is seven days. Acceptance locks invitation row, queries active verified identity emails by actor user ID, checks state and email match, upserts tenant membership, upserts optional Personal membership, marks accepted, and audits in one transaction.

- [ ] **Step 4: Implement authorization helpers**

Membership queries always require active tenant membership first. Tenant membership administration requires tenant owner/admin. Personal membership administration requires Personal owner. Resource lookup outside caller access returns `DomainError.notFound()`.

- [ ] **Step 5: Implement final-owner protection**

Lock all active owner rows for target scope before role/status mutation. Reject mutation with `409` when it would leave zero active owners. Use transaction row locks so concurrent owner removals cannot both pass.

- [ ] **Step 6: Implement route set**

Exact routes:

```text
POST  /api/v1/tenants/:tenantId/invitations
POST  /api/v1/invitations/accept
GET   /api/v1/tenants/:tenantId/memberships
PATCH /api/v1/tenants/:tenantId/memberships/:userId
GET   /api/v1/tenants/:tenantId/personal-profiles/:profileId/memberships
POST  /api/v1/tenants/:tenantId/personal-profiles/:profileId/memberships
PATCH /api/v1/tenants/:tenantId/personal-profiles/:profileId/memberships/:userId
```

POST Personal membership accepts an already provisioned user ID. Business grants are added in Wave 2 through additive contract and migration changes.

`BuildAppOptions` gains optional `membershipDomain`; default is `createMembershipDomain(database)`. Register membership routes after auth, database, and domain-auth plugins.

- [ ] **Step 7: Add real PostgreSQL concurrency and isolation cases**

Integration suite uses two database connections to attempt concurrent final-owner removal and proves at least one operation fails. It also proves tenant admin without Personal membership cannot list Personal memberships, and a tenant-only invitee receives no Personal membership.

- [ ] **Step 8: Verify GREEN**

Run:

```bash
pnpm --filter @expense-tax/app-api exec vitest run test/memberships.test.ts
PHASE_0J_INTEGRATION=1 pnpm exec vitest run test/integration/app-domain-wave1.test.ts
```

Expected: membership route, concurrency, and isolation tests PASS.

---

### Task 7: Generated Contracts and OpenAPI

**Files:**
- Modify generated output under: `packages/contracts/generated/**`
- Modify: `packages/contracts/test/generated-artifacts.test.ts`

**Interfaces:**
- Consumes: registered Wave 1 routes and canonical schemas.
- Produces: deterministic App API OpenAPI and TypeScript client paths containing Wave 1 endpoints.

- [ ] **Step 1: Add failing generated-artifact assertions**

Assert App API OpenAPI contains internal provisioning, current user, tenant, invitation, and membership paths; Foundry OpenAPI does not contain them.

```typescript
expect(appOpenApi.paths).toHaveProperty("/api/v1/tenants");
expect(appOpenApi.paths).toHaveProperty("/internal/v1/identity-provisionings");
expect(foundryOpenApi.paths).not.toHaveProperty("/api/v1/tenants");
```

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter @expense-tax/contracts exec vitest run test/generated-artifacts.test.ts`

Expected: FAIL because generated App API document lacks Wave 1 routes.

- [ ] **Step 3: Generate artifacts**

Run: `pnpm contracts:generate`

Never hand-edit generated files.

- [ ] **Step 4: Verify GREEN and drift**

Run:

```bash
pnpm --filter @expense-tax/contracts exec vitest run test/generated-artifacts.test.ts
pnpm contracts:check
```

Expected: tests and byte-for-byte drift check PASS.

---

### Task 8: Wave 1 Aggregate Verification and Evidence

**Files:**
- Create: `scripts/verify-phase-0j-wave1.mjs`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `plans/PLAN.md`
- Modify: `plans/sub-plans/phase-0j-personal-business-tax-domain-design.md`
- Modify: this implementation plan only after evidence exists
- Create local report: `../.superpowers/sdd/phase-0j-wave-1/task-report.md`

**Interfaces:**
- Consumes: all Wave 1 focused commands, existing Phase 0I verifier, Docker images, Compose wrapper, and PostgreSQL migrations.
- Produces: one zero-skip Wave 1 completion command and recorded evidence.

- [ ] **Step 1: Establish missing-verifier RED**

Add package script first:

```json
"verify:phase-0j:wave1": "node scripts/verify-phase-0j-wave1.mjs"
```

Run: `PHASE_0I_INTEGRATION=1 PHASE_0J_INTEGRATION=1 pnpm verify:phase-0j:wave1`

Expected: FAIL because verifier file does not exist.

- [ ] **Step 2: Implement deterministic aggregate verifier**

Use inherited stdio and fail on first nonzero command. Run in this order:

1. `PHASE_0I_INTEGRATION=1 pnpm verify:phase-0i`
2. Wave 1 contract tests
3. Wave 1 App route tests
4. `./scripts/compose.sh up -d postgres`
5. `./scripts/compose.sh run --rm app-api-migrate`
6. real Wave 1 PostgreSQL integration suite when `PHASE_0J_INTEGRATION=1`
7. root contract drift check
8. App API Docker build
9. credential-boundary audit

Without `PHASE_0J_INTEGRATION=1`, print explicit required-check `SKIP` and exit nonzero after non-database gates.

- [ ] **Step 3: Run full zero-skip gate**

Run: `PHASE_0I_INTEGRATION=1 PHASE_0J_INTEGRATION=1 pnpm verify:phase-0j:wave1`

Expected: every gate PASS with zero required checks skipped.

- [ ] **Step 4: Verify runtime and boundaries**

Run:

```bash
./scripts/compose.sh up -d app-api
curl --fail --silent --show-error http://127.0.0.1:8100/health/ready
node scripts/audit-credential-boundaries.mjs
git diff --check
git diff --name-only --diff-filter=U
```

Expected: readiness returns `status: ok`; audits pass; no whitespace errors or conflicts.

- [ ] **Step 5: Record evidence only after full pass**

- Change design status to `Approved; Wave 1 complete`.
- Change Phase 0J master-plan status to `🟡 In Progress` and link both design and Wave 1 plan.
- Mark this plan `Complete` and append dated completion evidence with exact command, test counts, migration result, generated-artifact result, Docker result, readiness result, and known non-gating warnings.
- Add local task report with files changed and verification evidence.
- Preserve Phase 0I completion evidence unchanged.

## Wave 1 Completion Gate

Wave 1 is complete only when:

- provider-neutral identity provisioning is idempotent and does not auto-link email
- authenticated tokens resolve active provisioned users through issuer and subject
- tenant bootstrap atomically creates tenant, tenant owner, Personal profile, and Personal owner
- tenant membership alone grants no Personal access
- tenant-only and Personal invitation flows enforce caller ownership and verified email
- final owner protections survive concurrent attempts
- all Wave 1 constraints pass against real PostgreSQL
- generated App API OpenAPI and TypeScript client paths include Wave 1 routes
- existing Phase 0I aggregate verification remains green
- App API image builds and readiness succeeds
- no shared infrastructure, production route, VPS, or GCP resource changes

## Completion Evidence

Completed 2026-09-08 with:

```bash
PHASE_0I_INTEGRATION=1 PHASE_0J_INTEGRATION=1 pnpm verify:phase-0j:wave1
```

Results:

- Phase 0I aggregate regression passed with zero required checks skipped.
- TypeScript suites passed: 16 contract tests, 73 App API tests, and 51 Foundry tests.
- Python contract suite passed: 5 tests; Ruff lint and format checks passed.
- PostgreSQL suites passed: 4 Phase 0I boundary tests and 7 Wave 1 identity, atomicity, isolation, and concurrency tests.
- Compose boundary suite passed: 3 tests.
- Migration `002_identity_memberships` applied successfully; aggregate rerun confirmed a clean no-pending migration state.
- Generated App API OpenAPI and TypeScript paths contain all Wave 1 routes; Foundry excludes them; byte-for-byte drift check passed.
- App API Docker image built and `/health/ready` returned `{"status":"ok","service":"app-api","version":"0.1.0"}`.
- Credential audit, `git diff --check`, and unmerged-path scan passed.
- Known non-gating warning: `datamodel-code-generator` reports its future external-formatter default change.
- Shared infrastructure, production routes, VPS resources, and GCP resources were not changed.
