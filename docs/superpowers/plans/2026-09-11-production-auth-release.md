# Production Auth Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provision production Clerk identity mappings, activate signed webhook delivery, and verify private authenticated App API, Foundry, frontend, and worker paths.

**Architecture:** An operator-run Node script validates Clerk membership through Clerk Backend API, then performs idempotent PostgreSQL updates against App API and Foundry using environment-only credentials. Existing domain authorization remains source of truth. Smoke tests use no-token HTTP checks, Clerk browser sessions, Clerk M2M claims, and one signed webhook replay test.

**Tech Stack:** Node.js 22, `fetch`, `psql`, PostgreSQL 17, Clerk Backend API, Fastify, Vitest, Cloudflare Tunnel, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-11-production-auth-release-design.md`

## Global Constraints

- `thangtran3112@gmail.com` receives Foundry `operator` + `catalog_manager`; `tramilyt@gmail.com` remains tenant-only.
- Existing PostgreSQL UUIDs remain authoritative; Clerk IDs are external references.
- Foundry `platform_operator_identities` supports one row per `(clerk_user_id, role)` so thang can hold `operator` and `catalog_manager`.
- Unknown, deleted, remapped, or mismatched identities fail closed.
- Credentials arrive through environment variables or mode-0600 local files, never command arguments, repository files, logs, or chat.
- Preserve unrelated `expense-tax-management/plans/mockups/**` changes.
- Keep VPS application ports loopback-only and Cloudflare Tunnel private.
- Do not activate paid OpenAI/OpenRouter providers.
- Phase 1C gateway controls remain separate and do not replace App API/Foundry authorization.

---

### Task 1: Add Provisioning Input Validation

**Files:**
- Create: `expense-tax-management/scripts/provision-production-clerk.mjs`
- Create: `expense-tax-management/scripts/provision-production-clerk.test.mjs`
- Modify: `expense-tax-management/package.json`

**Interfaces:**
- Export `parseProvisioningInput(env)` returning validated `{ appDatabaseUrl, foundryDatabaseUrl, clerkSecretKey, clerkOrgId, thangClerkUserId, tramilyClerkUserId, appTenantId, thangAppUserId, tramilyAppUserId }`.
- Export `validateExternalId(value, field)` rejecting empty/whitespace IDs and control characters.
- CLI command: `pnpm provision:production-clerk`.
- Required environment names: `APP_DATABASE_URL`, `FOUNDRY_DATABASE_URL`, `CLERK_SECRET_KEY`, `CLERK_FAMILY_ORG_ID`, `CLERK_THANG_USER_ID`, `CLERK_TRAMILY_USER_ID`, `APP_TENANT_ID`, `APP_THANG_USER_ID`, `APP_TRAMILY_USER_ID`.

- [ ] **Step 1: Write failing validation tests.**

Test missing variables, whitespace values, control characters, and valid Clerk IDs. Assert errors contain variable names only, never secret values.

- [ ] **Step 2: Run focused test and verify failure.**

Run: `pnpm exec vitest run scripts/provision-production-clerk.test.mjs`

Expected: FAIL because script exports do not exist.

- [ ] **Step 3: Implement input validation.**

Use `process.env`, `URL`, and explicit field checks. Keep `CLERK_SECRET_KEY` in memory only. Do not print parsed values.

- [ ] **Step 4: Add package command.**

Add:

```json
"provision:production-clerk": "node scripts/provision-production-clerk.mjs"
```

- [ ] **Step 5: Run focused tests.**

Run: `pnpm exec vitest run scripts/provision-production-clerk.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add expense-tax-management/scripts/provision-production-clerk.mjs expense-tax-management/scripts/provision-production-clerk.test.mjs expense-tax-management/package.json
git commit -m "feat(auth): validate production provisioning inputs"
```

### Task 2: Verify Clerk Membership and Provision PostgreSQL

**Files:**
- Modify: `expense-tax-management/scripts/provision-production-clerk.mjs`
- Modify: `expense-tax-management/scripts/provision-production-clerk.test.mjs`
- Create: `expense-tax-management/services/foundry-service/src/database/migrations/006_platform_operator_identity_roles.ts`
- Modify: `expense-tax-management/services/foundry-service/test/database.test.ts`
- Modify: `expense-tax-management/services/foundry-service/src/domain/platform-operators.ts`

**Interfaces:**
- `fetchClerkMemberships(input)` calls `GET /v1/organizations/{organization_id}/memberships?user_id={user_id}` with `Authorization: Bearer ${CLERK_SECRET_KEY}` and verifies both users belong to `CLERK_FAMILY_ORG_ID` with `org:member` or `org:admin` membership.
- `provisionAppMappings(input, memberships)` updates `app.users.clerk_user_id` and `app.tenants.clerk_org_id` transactionally through `psql` with `PG*` environment variables derived from URLs, never URL command arguments.
- `--bootstrap-empty` explicitly creates deterministic App UUID rows for the initial Family tenant, thang/tramily users, tenant memberships, Personal profile/memberships, then applies Clerk mappings. It is allowed only when production App user/tenant tables are empty or already match the deterministic bootstrap rows.
- `provisionFoundryOperator(input, memberships)` revalidates verified Clerk memberships at its exported boundary, inserts/validates two thang rows (`operator`, `catalog_manager`) in `foundry.platform_operator_identities`, and rejects disabled rows.
- `--dry-run` performs Clerk membership verification and SQL preflight but no writes.

- [ ] **Step 1: Write failing membership and SQL tests.**

Cover Clerk `401`, missing membership, wrong organization, wrong role, exact SQL target IDs, idempotent same mapping, conflicting remap, tenant/user inactive rows, multi-role Foundry rows, and disabled-role conflict.

- [ ] **Step 2: Run tests and verify failure.**

Run: `pnpm exec vitest run scripts/provision-production-clerk.test.mjs`

Expected: FAIL on missing membership/SQL functions.

- [ ] **Step 3: Implement Clerk membership lookup.**

Use `fetch` with a bounded timeout. Accept only `2xx` responses and exact organization/user membership matches. Redact response bodies in errors.

- [ ] **Step 4: Implement DB URL-to-environment conversion.**

Parse each PostgreSQL URL with `URL`; pass `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`, and `PGSSLMODE` through child-process environment. Invoke `psql --no-psqlrc --set=ON_ERROR_STOP=1 --file=-`; never pass database URL as an argument.

- [ ] **Step 5: Add multi-role migration and tests.**

Change the existing single-column primary key to a composite primary key on
`(clerk_user_id, role)`. Preserve existing rows and make the migration
reversible. Add migration coverage proving one user can hold both roles while
duplicate `(user, role)` remains rejected.

- [ ] **Step 6: Implement transactional SQL.**

App mapping SQL must assert active target rows, allow `NULL` or same Clerk ID only, update both user rows and tenant row, and verify one affected row per mapping. Empty bootstrap SQL must fail on unrelated existing users/tenants, create Family tenant/users/tenant memberships/Personal profile and memberships transactionally, then verify exact rows. Foundry SQL must assert no conflicting role and upsert only selected thang identity.

- [ ] **Step 7: Implement dry-run and write modes.**

Print only counts and stable IDs. Default to dry-run; require `PROVISION_PRODUCTION_CLERK_CONFIRM=Family-auth-release` for writes.

- [ ] **Step 8: Run focused tests and local dry-run.**

Run:

```bash
pnpm exec vitest run scripts/provision-production-clerk.test.mjs
pnpm provision:production-clerk -- --dry-run
```

Expected: PASS; dry-run performs no database writes.

- [ ] **Step 9: Commit.**

```bash
git add expense-tax-management/scripts/provision-production-clerk.mjs expense-tax-management/scripts/provision-production-clerk.test.mjs expense-tax-management/services/foundry-service/src/database/migrations/006_platform_operator_identity_roles.ts expense-tax-management/services/foundry-service/src/domain/platform-operators.ts expense-tax-management/services/foundry-service/test/database.test.ts
git commit -m "feat(auth): provision production Clerk mappings"
```

### Task 3: Execute Provisioning Against Production

**Files:**
- Runtime only; no repository changes expected.

**Interfaces:**
- Uses accepted Clerk user IDs, Family organization ID, and existing App API user/tenant UUIDs.
- Uses `expense-tax-management/.keys/ovh/postgres-vps.env` through `set -a; source ...; set +a`.

- [ ] **Step 1: Confirm invitations are accepted.**

Do not provision until Clerk shows both users as Family members and capture exact user IDs from Clerk Dashboard/API.

- [ ] **Step 2: Run dry-run.**

Run with all required environment values and `pnpm provision:production-clerk -- --dry-run`. Confirm two users, one organization, and two Foundry role rows for one operator.

- [ ] **Step 3: Run confirmed provisioning.**

Set `PROVISION_PRODUCTION_CLERK_CONFIRM=Family-auth-release` and run command once with `--bootstrap-empty`. Capture only result counts and stable IDs.

- [ ] **Step 4: Verify database state read-only.**

Query App API mappings, active Family memberships, and Foundry operator rows. Confirm no duplicate Clerk IDs, no inactive mappings, and no unexpected operator.

- [ ] **Step 5: Record nonsecret evidence.**

Update `.superpowers/sdd/2026-09-10-clerk-auth-integration/progress.md` with IDs/status only; never record secret keys, passwords, sessions, or tokens.

### Task 4: Activate Clerk Webhook

**Files:**
- Runtime configuration only; existing code: `services/app-api/src/routes/clerk-webhooks.ts`, `services/app-api/src/integrations/clerk-webhooks.ts`, `scripts/lib/production-secret-bundle.mjs`.

**Interfaces:**
- Endpoint: `https://expense-api.tobytran.dev/api/v1/integrations/clerk/webhook`.
- Secret input: `CLERK_WEBHOOK_SIGNING_SECRET` through approved Secret Manager sync.
- Raw request bodies are capped at 1 MiB before signature verification or parsing; oversized content-length and chunked requests return `413` while draining without buffering or resetting the upstream connection.

- [ ] **Step 1: Create Clerk webhook.**

Subscribe to `user.created`, `user.updated`, `user.deleted`, `organization.created`, `organization.updated`, `organization.deleted`, `organizationMembership.created`, `organizationMembership.updated`, and `organizationMembership.deleted`.

- [ ] **Step 2: Sync signing secret.**

Run existing production secret sync with the new signing secret; verify exactly one enabled Secret Manager version after deploy.

- [ ] **Step 3: Deploy through green CI.**

Do not mutate VPS manually. Wait for `Expense Tax CI`, then verify `Expense Tax Deploy` and API ready health.

- [ ] **Step 4: Send controlled test event.**

Use Clerk webhook test delivery. Verify `202`, one database event row, and replay response with `replayed: true`.

### Task 5: Run Authenticated Smoke Tests

**Files:**
- Create: `expense-tax-management/scripts/production-auth-smoke.mjs`
- Create: `expense-tax-management/scripts/production-auth-smoke.test.mjs`
- Create: `expense-tax-management/services/app-api/src/routes/auth-check.ts`
- Create: `expense-tax-management/services/app-api/test/auth-check.test.ts`
- Create: `expense-tax-management/services/foundry-service/src/routes/auth-check.ts`
- Create: `expense-tax-management/services/foundry-service/test/auth-check.test.ts`
- Modify: `expense-tax-management/services/app-api/src/app.ts`
- Modify: `expense-tax-management/services/foundry-service/src/app.ts`
- Modify: `infrastructure/cloudflare/expense-tax/main.tf`
- Modify: `expense-tax-management/scripts/check-cloudflare-infrastructure.mjs`
- Modify: `expense-tax-management/scripts/check-cloudflare-infrastructure.test.mjs`

**Interfaces:**
- Script checks public health/pages, no-token rejection, supplied Clerk browser-session token calls against authenticated auth-check routes, M2M target audiences, and webhook replay result.
- Script prints status codes and claim metadata only; never prints bearer tokens.
- App API exposes read-only tenant and worker auth-check routes; Foundry exposes read-only platform and worker auth-check routes. Each returns only service-verified issuer/audience/subject/type and mapped IDs/role needed by smoke tests.
- Existing Foundry hostname routes `/internal/v1/*` to loopback Foundry Service port 8200 before generic host routing sends other paths to Foundry Web port 7303. No new hostname or public origin port.

- [ ] **Step 1: Write failing smoke command tests.**

Cover no-token `401`, health `200`, issuer/audience checks, thang Foundry role access, tramily Foundry denial, tenant/org mismatch denial, and M2M target separation.

- [ ] **Step 2: Run tests and verify failure.**

Run: `pnpm exec vitest run scripts/production-auth-smoke.test.mjs`

Expected: FAIL until smoke helpers exist.

- [ ] **Step 3: Implement smoke helpers.**

Add guarded auth-check routes first, then use bounded `fetch`, redact `Authorization`, and fail nonzero on any unexpected status. Capture/Office checks use `/capture` and `/dashboard`; tramily tenant token against Foundry expects `401` because platform audience verification fails before role lookup.

- [ ] **Step 4: Run local tests and private production smoke.**

Run focused tests, then run the production command only with user-approved live session/token channels. Verify Capture, Office, Foundry, App API, worker calls, and webhook replay.

- [ ] **Step 5: Commit evidence/docs.**

```bash
git add expense-tax-management/scripts/production-auth-smoke.mjs expense-tax-management/scripts/production-auth-smoke.test.mjs .superpowers/sdd/2026-09-10-clerk-auth-integration/progress.md
git commit -m "test(auth): verify production identity boundaries"
```

## Phase 1C Handoff

After Task 5 passes, create separate Phase 1C design/plan for Cloudflare/Tunnel
route policy, request limits, security headers, and public/protected route matrix.
Do not add Traefik ForwardAuth or duplicate JWT authorization before that design.
