# Phase 0J - Personal, Business, Project, and Tax Domain Design

> **Date**: 2026-09-08
> **Status**: Approved; Waves 1-4 complete locally; infrastructure gate remains
> **Depends on**: [Phase 0I Polyglot Platform Rebaseline](phase-0i-polyglot-platform-rebaseline-design.md)
> **Scope**: Provider-neutral identity provisioning, tenant and profile memberships, small businesses, projects, spending categories, expenses, versioned US-federal tax categories, tax treatments, and baseline ledger pagination in App API

## 1. Goal

Replace the prototype tenant-wide expense model with a TypeScript-owned customer domain that distinguishes Personal and small-business work, enforces profile membership at every resource boundary, and supports deterministic business tax preparation without treating projects as tax entities.

Phase 0J completes local App API domain parity. It does not deploy or expose new production routes. Production gateway and VPS/GCP cutover remain later release work.

## 2. Approved Product Boundaries

- External identity providers handle OAuth, social login, username/password login, recovery, and multi-factor authentication.
- Gateway authentication normalizes supported providers into one internal RS256 tenant token contract.
- App API owns users, tenants, memberships, invitations, Personal profiles, businesses, projects, categories, expenses, tax profiles, and tax treatments.
- App API independently verifies signed identity and loads domain authorization from its database. Gateway roles never grant customer-record access by themselves.
- App API is the only service allowed to mutate customer-domain tables.
- Every expense belongs to exactly one Personal profile or one business.
- Projects group business client or job costs. Projects never represent tax identity or tax filing scope.
- Spending categories organize tenant data. Tax categories classify business deductions. They are separate concepts.
- Tax support is preparation and export aid only. The product does not calculate a final tax liability or file returns.

## 3. Non-Goals

- Building Clerk, Cognito, Google Identity Platform, or another provider adapter.
- Gateway routing, public exposure, production secrets, VPS deployment, or GCP deployment.
- Billing, plans, add-ons, entitlements, quotas, or AI provider configuration.
- OCR, files, signed uploads, email ingestion, Temporal workflows, or worker callbacks.
- AI category prediction or AI tax advice.
- Full-text, fuzzy, semantic, or natural-language search.
- Tax reports, export bundles, tax-software adapters, or return submission.
- Legacy database backfill, dual writes, or compatibility shims.

## 4. Delivery Strategy

Phase 0J ships as four vertical capability waves. Each wave adds canonical contracts, App API migration changes, domain services, routes, authorization, focused tests, generated artifacts, and aggregate verification before the next wave starts.

1. Identity, tenants, invitations, Personal profiles, memberships, and audit.
2. Business industries, small businesses, business memberships, spending categories, and projects.
3. Expenses, taxonomies, business tax profiles, and expense tax treatments.
4. Exact ledger filters, sorting, cursor pagination, endpoint parity evidence, and local transitional cleanup decisions.

Schema-first implementation is rejected because it delays authorization and constraint proof until the full domain is already coupled. API-first in-memory adapters are rejected because they duplicate persistence work and postpone PostgreSQL isolation tests.

## 5. Identity and Gateway Boundary

### 5.1 Authentication flow

An external provider authenticates the person. A provider adapter at the gateway validates that provider's token or session and issues a short-lived internal RS256 tenant token with:

- fixed internal issuer
- App API tenant audience
- canonical immutable subject
- token ID, issued-at, not-before when applicable, and expiry
- coarse gateway roles or scopes when needed for routing

App API validates signature, issuer, audience, algorithm, time claims, and token ID through its configured JWKS. It uses `(issuer, subject)` to resolve a local identity. Forwarded user, tenant, profile, business, email, and role headers are untrusted and ignored for domain authorization.

### 5.2 Identity provisioning

`POST /internal/v1/identity-provisionings` accepts normalized identity attributes from the `gateway-auth` service principal with `identity:provision` scope. The body contains issuer, subject, verified email, email-verification state, and display name. Provisioning is idempotent on `(issuer, subject)` and never links identities by matching email.

Provisioning creates or updates a global `User` and its `AuthIdentity`. It does not create a tenant automatically. This avoids creating unwanted private tenants for business-only invitees.

Production protects the endpoint with private routing and signed service identity. Local development uses deterministic development credentials or injected verifiers; it does not bypass authorization logic.

### 5.3 Tenant bootstrap

An authenticated provisioned user calls `POST /api/v1/tenants`. One transaction creates:

- tenant
- tenant owner membership
- tenant's single Personal profile
- Personal owner membership for the creator
- baseline spending categories
- audit records

Failure rolls back every record. Repeated requests with the same idempotency key return the original result when payload matches and return `409` when payload differs.

### 5.4 Invitations

Tenant owner or admin may create a tenant-only invitation for a normalized verified email. A Personal owner or business owner may create an invitation with a grant only for that owned scope; App API also grants tenant `member` when needed. Each invitation includes at most one initial scope grant: Personal or one business. Business-only invitations grant tenant membership plus business membership and no Personal membership.

Raw invitation token is returned once, stored only as a hash, omitted from logs, expires, and is single-use. Acceptance requires authenticated identity with a matching active, verified `auth_identities.verified_email`. Acceptance transaction creates missing memberships, marks invitation accepted, and writes audit records. Additional business memberships use owner-managed membership routes after acceptance.

## 6. API Scope Addressing

Customer scope is explicit in route paths. No request selects customer scope through gateway claims or client-supplied context headers.

Primary route prefixes are:

```text
/api/v1/tenants/:tenantId
/api/v1/tenants/:tenantId/personal-profiles/:profileId
/api/v1/tenants/:tenantId/businesses/:businessId
```

Every scoped handler validates all path relationships. A business must belong to the tenant, a project must belong to the business, and an expense must belong to the selected Personal profile or business. Active UI profile is a client preference only and has no authorization effect.

## 7. Data Model

All customer tables live in the `app` schema. IDs are UUIDs. Timestamps use timezone-aware PostgreSQL timestamps. Business-local financial dates use PostgreSQL `date`.

### 7.1 Identity and membership records

#### `users`

- `id`
- `primary_email`
- `display_name`
- `status`: `active` or `disabled`
- `created_at`, `updated_at`

Email is not a cross-provider identity key and is not unique globally.

#### `auth_identities`

- `id`, `user_id`
- `issuer`, `subject`
- `verified_email`, `email_verified`
- `last_authenticated_at`
- `created_at`, `updated_at`

Unique `(issuer, subject)` prevents duplicate provisioning. Multiple identities may later point to one user only through an explicit account-linking flow outside Phase 0J.

#### `tenants`

- `id`, `name`, `slug`
- `status`: `active` or `archived`
- `version`
- `created_at`, `updated_at`, `archived_at`

Slug is globally unique, normalized, and immutable in Phase 0J.

#### `tenant_memberships`

- `tenant_id`, `user_id`
- `role`: `owner`, `admin`, or `member`
- `status`: `active` or `inactive`
- `version`
- `created_at`, `updated_at`

Unique `(tenant_id, user_id)` permits one membership state per user and tenant.

#### `personal_profiles`

- `id`, `tenant_id`, `name`
- `version`
- `created_at`, `updated_at`

Unique `tenant_id` enforces at most one Personal profile per tenant. Atomic tenant bootstrap plus prohibition of profile deletion maintains exactly one profile for every active tenant.

#### `personal_memberships`

- `personal_profile_id`, `tenant_id`, `user_id`
- `role`: `owner`, `editor`, or `viewer`
- `status`: `active` or `inactive`
- `version`
- `created_at`, `updated_at`

Composite foreign keys ensure profile and tenant match. Unique `(personal_profile_id, user_id)` permits one membership state per user and profile.

#### `tenant_invitations`

- `id`, `tenant_id`
- `normalized_email`, `tenant_role`
- nullable `personal_profile_id` and `personal_role`
- nullable `business_id` and `business_role`
- `token_hash`, `expires_at`, `accepted_at`, `revoked_at`
- `created_by_user_id`, `accepted_by_user_id`
- `created_at`

Check constraints permit no initial scope grant, one Personal grant, or one business grant, never both.

### 7.2 Business and organization records

#### `business_industries`

- stable `code`
- display `name`
- `status`
- `created_at`, `updated_at`

Initial codes cover restaurant, salon, daycare, grocery, and construction businesses. Codes are product classifications, not tax categories.

#### `spending_category_templates`

- globally unique stable `template_key`
- default name, description, color, and icon

#### `industry_spending_category_templates`

- `industry_code`
- `template_key`
- `sort_order` from 1 through 5

The five active industry mappings are:

- restaurant: `food-inventory`, `beverages`, `kitchen-supplies`, `delivery-fees`, `equipment-maintenance`
- salon: `beauty-supplies`, `linens-laundry`, `booth-equipment`, `booking-fees`, `licensing`
- daycare: `learning-supplies`, `meals-snacks`, `toys-equipment`, `cleaning-safety`, `licensing-training`
- grocery: `resale-inventory`, `packaging`, `refrigeration-maintenance`, `delivery-fees`, `store-supplies`
- construction: `building-materials`, `subcontractors`, `equipment-rental`, `permits-inspections`, `jobsite-supplies`

There are 24 unique global definitions and 25 mapping rows. Shared definitions such as `delivery-fees` are mapped to multiple industries. All seed data is deterministic and version-controlled through migrations.

#### `businesses`

- `id`, `tenant_id`
- `name`, `industry_code`
- `timezone`, `base_currency`
- `status`: `active` or `archived`
- `version`
- `created_at`, `updated_at`, `archived_at`

Timezone is an IANA zone. Base currency is uppercase ISO-4217.

#### `business_memberships`

- `business_id`, `tenant_id`, `user_id`
- `role`: `owner`, `editor`, or `viewer`
- `status`: `active` or `inactive`
- `version`
- `created_at`, `updated_at`

Composite foreign keys ensure business and tenant match. Unique `(business_id, user_id)` permits one membership state per user and business.

#### `spending_categories`

- `id`, `tenant_id`
- stable nullable `template_key`
- `name`, `description`, `color`, `icon`
- `status`: `active` or `archived`
- `version`
- `created_at`, `updated_at`, `archived_at`

Spending categories are tenant-owned and available to Personal and business expenses. Unique normalized active name prevents visible duplicates. Applying an industry template idempotently creates only missing template keys.

#### `projects`

- `id`, `tenant_id`, `business_id`
- `name`, nullable `client_name`, nullable `description`
- `status`: `active`, `completed`, or `archived`
- nullable `starts_on`, `ends_on`
- `version`
- `created_at`, `updated_at`, `archived_at`

Projects contain no tax entity, filing status, deduction type, or taxonomy fields.

### 7.3 Expense records

#### `expenses`

- `id`, `tenant_id`, `created_by_user_id`
- nullable `personal_profile_id`, nullable `business_id`
- nullable `project_id`, nullable `spending_category_id`
- `merchant`, nullable `description`
- `amount` as positive `numeric(14,2)`
- `currency` as uppercase ISO-4217 code
- `incurred_on` as scope-local calendar date
- stored generated `tax_year` from `incurred_on`
- `source`: `manual`
- `status`: `draft`, `ready`, or `archived`
- `version`
- `created_at`, `updated_at`, `archived_at`

Exactly one of `personal_profile_id` or `business_id` is non-null. Personal expenses require null project. Composite foreign keys enforce tenant/profile, tenant/business, tenant/category, and business/project relationships. Money is serialized through public contracts as decimal strings.

### 7.4 Tax records

#### `taxonomy_versions`

- `id`
- `jurisdiction_code`: initially `US-FEDERAL`
- `tax_year`
- `code`, `name`, `status`
- `source_url`, `source_revision`, `source_checksum`
- `created_at`

Unique `(jurisdiction_code, tax_year, code)` identifies one immutable taxonomy release.

#### `tax_category_definitions`

- `id`, `taxonomy_version_id`
- stable `code`
- `name`, `description`
- nullable official form and line references
- `status`
- `sort_order`

Initial definitions follow finalized 2025 IRS Schedule C, the current revision listed by the IRS as of this design date. Source metadata references `https://www.irs.gov/forms-pubs/about-schedule-c-form-1040` and the finalized form artifact; migration records its checksum. New tax-year changes create a new taxonomy version rather than mutating old definitions.

#### `business_tax_profiles`

- `id`, `tenant_id`, `business_id`
- `tax_year`, `taxonomy_version_id`
- `tax_form`: initially `schedule_c`
- `accounting_method`: `cash` or `accrual`
- `status`: `draft`, `active`, or `closed`
- `version`
- `created_at`, `updated_at`

Unique `(business_id, tax_year)` permits one selected tax profile per business year in Phase 0J. Only Schedule C-compatible preparation is supported initially.

Phase 0J activates only the finalized 2025 taxonomy. Expenses from any year remain valid ledger records, but tax-profile activation and tax-treatment creation require an active taxonomy for that exact year. A 2026 taxonomy is added later from finalized IRS material rather than copying 2025 definitions under a misleading year.

#### `expense_tax_treatments`

- `expense_id`, `tenant_id`, `business_id`, `tax_year`
- `business_tax_profile_id`
- `taxonomy_version_id`, `tax_category_definition_id`
- `deductible_percent` from `0.00` through `100.00`
- `review_status`: `unreviewed`, `reviewed`, or `excluded`
- nullable user-facing note
- `version`
- `created_by_user_id`, `updated_by_user_id`
- `created_at`, `updated_at`

Expense ID is unique, making treatment a singleton. Composite foreign keys bind treatment to the same business, generated tax year, business tax profile, taxonomy version, and category definition. Personal expenses cannot satisfy these keys and therefore cannot receive tax treatment.

### 7.5 Audit records

#### `app_audit_events`

- `id`, nullable `tenant_id`
- nullable `actor_user_id`, nullable `actor_service_principal`
- `action`, `outcome`, `resource_type`, nullable `resource_id`
- request correlation ID
- minimal JSON metadata
- `created_at`

Audit rows are append-only to runtime code. Metadata may include role, scope type, and denial reason code. It never contains bearer tokens, invitation tokens, password data, receipt content, tax identifiers, or full external provider payloads.

#### `idempotency_records`

- `id`
- actor key and operation key
- client idempotency key and request hash
- response status and non-sensitive response snapshot
- nullable resource type and resource ID
- `expires_at`, `created_at`

Unique `(actor_key, operation_key, idempotency_key)` prevents duplicate mutations within one operation. Reuse with a different request hash returns `409`. Provisioning still relies on `(issuer, subject)` as its permanent identity key; idempotency records protect retry response behavior rather than identity uniqueness.

## 8. Database Invariants

- Every customer-owned row includes tenant identity directly or through an enforced composite foreign key.
- Tenant membership is necessary for every Personal or business operation but grants no profile access by itself.
- Personal and business membership is necessary for its matching resource scope.
- Tenant creator receives tenant owner and Personal owner memberships atomically.
- Business creator must already have active tenant membership and receives business owner membership atomically.
- Business-only invite acceptance never creates Personal membership.
- Expense scope is an exclusive Personal/business choice.
- Expense project, when present, shares tenant and business with expense.
- Expense spending category shares tenant with expense.
- Tax treatment exists only for business expense and matches expense tax year.
- Tax profile and category definition use the same taxonomy version.
- Runtime role can perform domain DML but cannot alter schema, migration metadata, or cross-service tables.
- Migrator owns schema objects; application code never executes DDL.

## 9. Authorization

Effective access requires active global user, active tenant, active tenant membership, and matching active scope membership.

| Scope | Role | Permissions |
|---|---|---|
| Tenant | `owner` | Tenant lifecycle, ownership, identities, invitations, aggregate settings; no implicit profile records |
| Tenant | `admin` | Invite and deactivate identities, read tenant settings; no implicit profile records |
| Tenant | `member` | Authenticate and use explicitly granted profiles |
| Personal | `owner` | Manage Personal memberships and all Personal records |
| Personal | `editor` | Read and mutate Personal expenses |
| Personal | `viewer` | Read Personal expenses |
| Business | `owner` | Manage business, memberships, tax profile, projects, expenses, and treatments |
| Business | `editor` | Read and mutate projects, expenses, and treatments |
| Business | `viewer` | Read business, projects, expenses, and treatments |

Tenant owner or admin may invite tenant identities but cannot attach Personal or business grants without owning that scope. Personal and business owners may attach a grant only for their matching scope. Membership mutation prevents removing or demoting the final active tenant owner, Personal owner, or business owner.

Requests for a foreign or inaccessible resource ID return `404` to limit enumeration and emit a denial audit event. Requests for a known accessible scope with insufficient role return `403`.

## 10. Public and Internal Routes

### 10.1 Identity and tenant

- `POST /internal/v1/identity-provisionings`
- `GET /api/v1/users/me`
- `POST /api/v1/tenants`
- `GET /api/v1/tenants`
- `GET /api/v1/tenants/:tenantId`
- `PATCH /api/v1/tenants/:tenantId`
- `POST /api/v1/tenants/:tenantId/invitations`
- `POST /api/v1/invitations/accept`
- tenant membership list/update/deactivate routes under `/api/v1/tenants/:tenantId/memberships`
- Personal membership list/create/update/deactivate routes under `/api/v1/tenants/:tenantId/personal-profiles/:profileId/memberships`

### 10.2 Business, categories, and projects

- business list/create routes under `/api/v1/tenants/:tenantId/businesses`
- business get/update/archive routes under `/api/v1/tenants/:tenantId/businesses/:businessId`
- business membership routes under `/api/v1/tenants/:tenantId/businesses/:businessId/memberships`
- spending-category CRUD under `/api/v1/tenants/:tenantId/spending-categories`
- project CRUD under `/api/v1/tenants/:tenantId/businesses/:businessId/projects`
- industry list under `/api/v1/business-industries`

### 10.3 Expenses and tax

- Personal expense CRUD under `/api/v1/tenants/:tenantId/personal-profiles/:profileId/expenses`
- business expense CRUD under `/api/v1/tenants/:tenantId/businesses/:businessId/expenses`
- business tax-profile CRUD under `/api/v1/tenants/:tenantId/businesses/:businessId/tax-profiles`
- tax-treatment get/put/delete under each business expense
- supported taxonomy versions and definitions under `/api/v1/taxonomies`

Create returns `201`. Reads and updates return canonical resources. Archive/deactivate operations return `204` where no representation is required. Membership and financial mutations require expected `version`; stale versions return `409`.

## 11. Ledger Query Contract

Personal and business expense collections support:

- `incurredFrom`, `incurredTo`
- `amountMin`, `amountMax`
- `status`
- `spendingCategoryId`
- `projectId` for business routes only
- `taxReviewStatus` for business routes only
- `sort`: `incurredOn`, `amount`, `merchant`, or `createdAt`
- `direction`: `asc` or `desc`
- `limit`: default 50, maximum 100
- `cursor`

Filters are exact and conjunctive. Keyword search is not accepted in Phase 0J.

Pagination uses keyset ordering. Every sort appends UUID `id` as deterministic tie-breaker. Cursor is opaque base64url JSON containing version, route scope, filter hash, sort, direction, last sort value, and last ID. Cursor schema and filter hash are validated; malformed or mismatched cursors return `400`. Cursor contains no secrets and does not require signing for authorization because every query independently reapplies membership and scope predicates.

List response is:

```json
{
  "items": [],
  "nextCursor": null
}
```

## 12. Error and Transaction Behavior

App API keeps the Phase 0I error envelope with stable codes:

- `400 VALIDATION_ERROR`: malformed body, query, path, or cursor
- `401 REQUEST_ERROR`: missing or invalid authentication
- `403 REQUEST_ERROR`: valid identity lacks action permission in visible scope
- `404 NOT_FOUND`: route or inaccessible/missing resource
- `409 CONFLICT`: stale version, duplicate immutable key, exhausted idempotency key, or invitation state conflict
- `500 INTERNAL_ERROR`: redacted unexpected failure

Internal logs include request ID, stable error class, operation, and non-sensitive resource IDs. They redact tokens, invitation secrets, database URLs, provider payloads, and user-entered financial text.

Transactions protect tenant bootstrap, business bootstrap, invitation acceptance, membership changes, and expense/treatment writes. Domain services execute authorization and mutation on the same database handle. Optimistic updates use `WHERE version = expectedVersion` and increment version atomically.

Security-sensitive successful mutations and their audit rows share one transaction; audit failure rolls back the mutation. Access denial never becomes access when audit persistence fails: App API emits a redacted structured security log and still returns the original `403` or `404` denial.

## 13. Contract Strategy

Canonical Zod schemas live in `packages/contracts` by domain module. Route schemas use strict objects and transport decimal money as strings. Database row types remain private to App API.

App API OpenAPI, TypeScript client definitions, JSON Schema messages, and generated Pydantic DTOs remain deterministic. Python DTO generation includes only cross-language workflow/internal messages required by current phases; it does not expose database models.

Phase 0J removes transitional manual Python expense DTO ownership only after TypeScript route and fixture parity passes. Legacy FastAPI and Alembic remain historical until release cutover; there is no dual write or backfill.

## 14. Verification Strategy

Each vertical wave follows focused red-green development:

1. Add failing contract tests for accepted and rejected transport shapes.
2. Add failing route/service tests for role and scope behavior.
3. Add failing PostgreSQL integration tests for constraints that application checks cannot prove.
4. Add minimal contracts, migration, domain service, and routes.
5. Regenerate artifacts and verify byte-for-byte drift.
6. Run root lint, typecheck, tests, builds, credential audit, Compose boundary tests, and prior Phase 0I aggregate gate.

Required Phase 0J evidence includes:

- identity provisioning idempotency and no email auto-link
- atomic tenant and business bootstrap
- business-only invitee denied Personal access
- tenant admin denied profile records without scope membership
- viewer/editor/owner role matrix
- final-owner protections
- exclusive Personal/business expense constraint
- cross-business project rejection
- cross-tax-year and cross-taxonomy treatment rejection
- Personal tax-treatment rejection
- deterministic industry category seeding
- stable cursor pagination with equal sort values and archived rows
- cursor/filter mismatch rejection
- generated OpenAPI and client drift check
- App API Docker build and local readiness against migrated PostgreSQL
- zero new database credentials in gateway, worker, Foundry, or legacy runtime

## 15. Migration and Cutover

Phase 0J adds forward-only Kysely migrations under App API. Development data is resettable, so migrations create the clean domain without importing prototype Alembic rows. Seed migrations are deterministic and idempotent for business industries, category templates, and supported taxonomies.

Local endpoint parity is measured against retained legacy behavior where behavior remains valid. Superseded prototype behavior, including project tax identity, tenant AI dollar budgets, SQLAlchemy ownership, direct Python database mutation, and manual Python contract ownership, is intentionally not preserved.

Production traffic stays on existing deployment through Phase 0J. Gateway rewrite and deployment phases consume Phase 0J OpenAPI contracts only after local completion evidence. Any VPS or GCP mutation requires a separate deployment confirmation.

## 16. Completion Criteria

Phase 0J is complete when:

- all four capability waves pass focused and aggregate verification
- every customer route enforces tenant plus exact profile membership
- database constraints reject invalid scope, project, and tax relationships
- identity and invitation flows are provider-neutral and idempotent
- industry onboarding seeds deterministic spending categories without conflating tax categories
- supported Schedule C taxonomy carries source and version metadata
- expense listing filters, sorting, and cursor pagination are stable and documented
- generated artifacts are current and reproducible
- App API image builds and starts against clean migrated PostgreSQL
- no Phase 0J behavior depends on legacy FastAPI or Alembic at runtime
- no production route, VPS, GCP resource, or shared infrastructure is changed

## 17. Deferred Decisions

These decisions are intentionally owned by later phases and do not block Phase 0J:

- external identity provider selection and provider-specific account-linking UX
- invitation email delivery
- file and receipt object model details
- AI category and tax-treatment suggestions
- tax reports, exports, and adapter formats
- non-Schedule-C tax forms and state/local rule automation
- full-text and AI search
- production gateway topology and deployment platform
