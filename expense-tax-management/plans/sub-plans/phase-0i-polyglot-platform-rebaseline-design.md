# Phase 0I - Polyglot Platform Rebaseline Design

> **Date**: 2026-09-07
> **Status**: Written specification approved on 2026-09-07; detailed Phase 0I planning authorized
> **Scope**: Runtime ownership, business/tax domain, AI Foundry, product entitlements, forwarded receipts, split frontends, and implementation order
> **Supersedes where conflicting**: Phase 0B target schema, Phase 0G Python-first contract ownership, and FastAPI/single-client/direct-database assumptions in all planned downstream phases
> **Implementation gate**: Written-spec approval was received on 2026-09-07. Phase 0I implementation must follow its detailed execution plan; downstream phases still require separate plans at their dependency boundaries.

## 1. Purpose

Rebaseline the product before receipt ingestion and frontend implementation continue.
Current plans expose provider credentials and model controls to tenant users, treat projects as tax entities, combine mobile capture with dense tax reporting, and place customer HTTP APIs, AI orchestration, and persistence in one Python service.

Architecture proposed for written approval separates these concerns:

- TypeScript owns customer and platform HTTP APIs.
- Python owns Temporal workflows and AI/data-processing activities.
- A small business owns tax context.
- A project only groups costs for a client or internal initiative.
- Capture, office analysis, and platform operations use separate frontend applications.
- Tenant users choose curated AI modes, never providers, credentials, raw model routes, or prompts.
- Product tiers and add-ons grant features; Foundry enforces AI-operation quotas.
- Tax functionality prepares and exports records but never files taxes.

## 2. Goals

- Support one tenant with one Personal profile and one or more small businesses.
- Require explicit Personal or business membership before accessing profile data.
- Support explicit per-business membership and authorization.
- Keep projects subordinate to businesses and outside tax identity.
- Keep spending categories separate from versioned tax categories.
- Provide US-federal tax preparation and export aids first.
- Provide a phone/tablet Capture PWA and laptop-only Office Web application.
- Provide a platform-staff-only Foundry Web application with endpoint-specific operator and quota-reconciler permissions.
- Run customer App API and Foundry Service as independently deployable Fastify services.
- Keep Python for durable Temporal workflows, OCR, LLM calls, image/PDF processing, and later Graphiti work.
- Use one source of truth for TypeScript and Python transport validation.
- Enforce at most one consumed product credit per OCR job or AI-search request, independent from infrastructure retry count.
- Offer secure forwarded-receipt ingestion to every plan without requiring mailbox OAuth.
- Gate connected Gmail/Outlook scanning and AI search by tenant plan or add-on.
- Produce deterministic canonical export bundles for accountants and tax software adapters.

## 3. Non-Goals

- Direct federal or state tax filing.
- E-file submission, filing credentials, filing status tracking, or tax-advice claims.
- State-specific tax rules in first release.
- User-managed provider credentials, raw model IDs, model routing, or arbitrary system prompts.
- Separate mailboxes for every tenant or business.
- Per-user subscriptions or isolated per-seat quotas.
- Preserving current development database rows during rebaseline.
- Running long-lived Python Temporal workers as serverless functions.
- Allowing one expense to split across multiple businesses in MVP.

## 4. Approved Runtime Architecture

```text
Capture PWA ---------\
                      \       /api/v1
Office Web -------------> App API (TypeScript, Fastify, Zod)
                              |       |
                              |       +--> app PostgreSQL schema
                              |
                              +--> Temporal TypeScript client
                                      |
                                      v
                               Python Temporal AI Worker
                                |                  |
                                |                  +--> GCS
                                |                  +--> Secret Manager (route-scoped reads)
                               |
                               +--> Foundry internal API
                               +--> App API internal callbacks

Foundry Web ----------------> Foundry Service (TypeScript, Fastify, Zod)
                               |          |
                               |          +--> foundry PostgreSQL schema
                               +--> Secret Manager references
```

### 4.1 App API ownership

App API owns:

- Tenant identity and membership.
- Personal profiles and personal memberships.
- Small businesses and business memberships.
- Projects and client/job cost grouping.
- Expenses, files, spending categories, and tax treatments.
- Product plans, subscriptions, add-ons, and non-AI feature entitlements.
- Baseline ledger listing, exact filters, sorting, and cursor pagination; later advanced SQL/full-text search.
- Business/tax reports and canonical exports.
- Signed upload sessions and receipt metadata.
- Inbound-email webhook validation, routing tokens, verified senders, and quarantine.
- Transactional outbox records that start Temporal workflows.
- Internal idempotent endpoints that accept worker results.

App API is the only service allowed to mutate customer-domain tables.

### 4.2 Foundry Service ownership

Foundry Service owns:

- Provider connections and health metadata.
- Provider model catalog and capabilities.
- Curated AI modes and effective route versions.
- Tenant/model/operation quota policies.
- Atomic quota reservations and settlement.
- Provider-call telemetry, latency, tokens, cost, and error classes.
- Platform-operator audit history.
- Internal safety cost ceilings independent from customer product credits.

Foundry does not read receipt images, OCR text, extracted line items, or tax data. Provider secret values live in Secret Manager. Foundry stores secret references and masked metadata only.

### 4.3 Python worker ownership

Python worker owns execution code, not customer-domain persistence:

- Temporal workflow definitions and activities.
- OCR, image normalization, PDF extraction, and LLM adapters.
- Forwarded-email parsing after App API trust validation.
- Premium connected-mailbox discovery workflows.
- AI query planning and answer generation.
- Future embedding and Graphiti activities.

Python activities call versioned internal APIs to reserve AI usage and submit results. They do not import TypeScript database models or write App API/Foundry tables directly.

### 4.4 Database role isolation

- App API runtime role can read/write only App schema objects; its migration role alone can create or alter App schema objects.
- Foundry runtime role can read/write only Foundry schema objects; its migration role alone can create or alter Foundry schema objects.
- Runtime roles cannot assume migration roles, create extensions, change ownership, or access the other service schema.
- Python worker receives no App or Foundry PostgreSQL credentials. Separate graph-store credentials, when introduced, grant only graph activity permissions.
- Production migrations run as explicit one-shot jobs before runtime rollout. Connection pools use fixed schema-qualified queries and restricted `search_path` values.

## 5. Framework Choice

Use Fastify directly for both TypeScript APIs.

- Fastify supplies low-overhead routing, plugin encapsulation, schema validation, response serialization, TypeScript support, a Zod v4 type provider, and an official AWS Lambda adapter.
- Express requires more validation, typing, serialization, and module-boundary glue.
- NestJS adds useful dependency injection and conventions but unnecessary startup and framework weight for these focused services.
- Hono is attractive for edge runtimes, but this system needs normal Node.js PostgreSQL, Secret Manager, and Temporal client connectivity.

Build portable Node.js containers first. Keep the Fastify application factory independent from deployment adapters so Foundry or App API can later run on Lambda, Cloud Run, or another serverless container platform. Prefer a serverless container for App API when PostgreSQL pooling and Temporal connections make endpoint-per-function deployment inefficient.

## 6. Contract Strategy

`packages/contracts` is the canonical transport-contract package.

```text
Zod v4 route/message schemas
        |
        +--> Fastify runtime validation and inferred TypeScript types
        +--> OpenAPI documents and generated frontend clients
        +--> JSON Schema and generated Pydantic DTOs for Python workers
```

Rules:

- Generated files are never hand-edited.
- CI regenerates artifacts and fails on drift.
- App API and Foundry publish separate OpenAPI documents.
- Internal workflow/API messages are versioned independently from public routes.
- JSON-compatible Temporal payloads are used across TypeScript clients and Python workers.
- TypeScript clients start Python workflows on dedicated Python task queues using stable workflow type names.
- Temporal workflow inputs, results, memos, search attributes, and logs contain opaque tenant/job/object references rather than receipt bytes, raw MIME, provider secrets, OCR text, or tax records.
- Sensitive text that cannot remain reference-only uses an approved Temporal payload codec with client-side envelope encryption. Search attributes stay non-sensitive, and Temporal history retention aligns with source-data retention policy.
- Database models and migrations remain private to each owning service.
- `common/python/expense-contracts` may remain as the generated Python artifact location, but it is no longer the source of truth.

## 7. Repository Target

```text
family-app/
|-- infrastructure/                  # Shared PostgreSQL, Temporal, gateway, observability
`-- expense-tax-management/
    |-- frontend/
    |   |-- capture-web/              # Next.js PWA, phone/tablet
    |   |-- office-web/               # Next.js, laptop 1024px+
    |   `-- foundry-web/               # Next.js, platform operators
    |-- services/
    |   |-- app-api/                  # Fastify customer/domain API
    |   |-- foundry-service/          # Fastify AI control plane
    |   `-- ai-worker/                # Python Temporal workflows/activities
    |-- packages/
    |   `-- contracts/                # Canonical Zod contracts and generated OpenAPI/JSON Schema
    |-- common/python/
    |   `-- expense-contracts/        # Generated Pydantic transport package
    `-- plans/
```

Current `frontend/web` and `expense-service` remain transitional until Phase 0I establishes replacements. FastAPI HTTP routes and SQLAlchemy/Alembic schema are retired after App API parity because development data may be reset.

## 8. Customer Domain

### 8.1 Relationships

```text
Tenant
|-- TenantMemberships -> Users
|-- SpendingCategories
|-- Subscription and Add-ons
|-- PersonalProfile
|   |-- PersonalMemberships -> Users
|   `-- Personal Expenses
`-- SmallBusinesses
    |-- BusinessMemberships -> Users
    |-- BusinessTaxProfiles by tax year
    |-- Projects
    `-- Business Expenses
        `-- optional ExpenseTaxTreatment -> TaxCategoryDefinition
```

### 8.2 Invariants

- Every expense belongs to exactly one scope: one `personal_profile_id` or one `business_id`, never both.
- Personal expense has one `personal_profile_id` and no `business_id`, `project_id`, or tax treatment.
- Business expense has exactly one `business_id` and no `personal_profile_id`.
- Project is optional, but every project belongs to exactly one business.
- If expense has a project, project business must equal expense business.
- Business membership role is `owner`, `editor`, or `viewer`.
- Personal membership role is `owner`, `editor`, or `viewer`.
- Tenant membership alone grants no Personal or business expense access.
- Tax treatment exists only for a business expense.
- Expense tax year derives from its business-local incurred date; changing that date revalidates the applicable business tax profile and taxonomy version.
- Tax treatment references a matching business tax profile and taxonomy version for the expense tax year.
- Spending category is tenant-defined and usable for personal or business organization.
- Tax category definition is platform-managed, jurisdiction-aware, tax-year-versioned, and stable by code.
- Tax reports group by business, tax year, and tax category, never by project.
- Project reports show project/client costs and trends, not filing or tax-entity summaries.

### 8.3 Primary records

- `Tenant`
- `User`
- `TenantMembership`
- `PersonalProfile`
- `PersonalMembership`
- `SmallBusiness`
- `BusinessMembership`
- `BusinessTaxProfile`
- `Project`
- `Expense`
- `SpendingCategory`
- `TaxonomyVersion`
- `TaxCategoryDefinition`
- `ExpenseTaxTreatment`
- `ExpenseFile`

Login establishes tenant identity, then requires an active profile selection: Personal or one business available through explicit profile membership. Business-only invitees receive tenant membership plus selected business memberships, but no Personal membership. Active profile controls UI defaults only. Authorization and mutations always use explicit IDs and server validation.

### 8.4 Authorization roles

| Scope | Role | Allowed actions |
|---|---|---|
| Tenant | `owner` | Subscription/add-ons, tenant lifecycle and ownership transfer, tenant identity administration, aggregate usage; no implicit Personal/business record access |
| Tenant | `admin` | Invite/deactivate tenant identities and read plan/aggregate usage; no implicit Personal/business record access |
| Tenant | `member` | Authenticate and access explicitly granted profiles only |
| Personal | `owner` | Manage Personal memberships, settings, expenses, files, reports, and exports |
| Personal | `editor` | Read and mutate Personal expenses/files; no membership or export administration |
| Personal | `viewer` | Read Personal expenses/reports only |
| Business | `owner` | Manage business memberships/settings/tax profile, all business records, reports, and exports |
| Business | `editor` | Read and mutate business expenses, projects, files, and tax treatments; no membership or export administration |
| Business | `viewer` | Read business expenses/projects/reports only |
| Platform | `operator` | Foundry configuration/telemetry only; no customer expense, file, OCR, or tax access |
| Platform | `quota_reconciler` | Read provider-attempt evidence and resolve ambiguous reservations; no route/credential changes or customer content access |

Effective access requires active tenant membership plus matching Personal/business membership. Bootstrap grants tenant creator `owner` on Tenant and Personal. Scope-membership changes and denied cross-scope access are audited.

## 9. Tax Product Boundary and Export

First release supports US-federal expense preparation and export aid. State and local jurisdiction fields may be captured but have no automated state rules.

Canonical export requires an explicit business and tax year. It excludes personal expenses, other businesses, unauthorized records, and unresolved items unless the user deliberately includes a documented review state.

Bundle contents:

- Normalized expense CSV.
- Manifest with business, tax year, taxonomy version, currency, filters, generation time, counts, and application version.
- Tax-category mapping table.
- Review and uncertainty flags.
- File checksums.
- Optional receipt files or secure receipt references.

Exports are immutable, reproducible snapshots. An adapter interface may later produce tax-software-compatible files or connected-app payloads. No adapter may submit a tax return.

## 10. Plans, Entitlements, and Usage

Subscription belongs to tenant. Members share allowances; usage records retain initiating user ID for attribution and abuse review.

App API owns:

- `Plan`
- immutable `PlanVersion`
- `FeatureDefinition`
- `PlanEntitlement`
- `TenantSubscription`
- `TenantAddon`
- `TenantFeatureOverride`
- `FeatureUsageEvent` for non-AI features

Initial feature keys include:

- `receipt_forwarding`
- `connected_mailbox_scan`
- `ai_search`
- `ocr_mode_fast`
- `ocr_mode_balanced`
- `ocr_mode_accurate`

Rules:

- Forwarded receipt intake is available to every plan and still consumes the tenant's applicable OCR allowance.
- Connected Gmail/Outlook scanning requires Team/Enterprise entitlement or a premium add-on.
- Basic SQL and full-text receipt search remains available without AI-search entitlement.
- Semantic and natural-language AI receipt search require `ai_search` entitlement.
- Trial tenant receives 20 accepted AI-search requests per calendar month.
- Product billing integration is deferred; seeded/manual subscriptions and overrides support initial development.

App API performs feature authorization. It publishes effective AI entitlement snapshots through an outbox to Foundry. Snapshots carry a monotonic tenant entitlement version and are applied idempotently. New reservations carry the current version; Foundry returns `ENTITLEMENT_SYNC_PENDING` rather than reserving against an older snapshot. A downgrade blocks new idempotency keys. Jobs durably admitted before the downgrade may retry only their existing key under the recorded entitlement grant unless an operator cancels them. Foundry independently enforces runtime AI quotas. Services do not share entitlement tables.

## 11. Foundry Catalog and Quotas

### 11.1 Records

- `ProviderConnection`
- `AiModel`
- `AiMode`
- `AiModeRouteVersion`
- `TenantAiQuota`
- `AiQuotaPeriod`
- `AiQuotaReservation`
- `ProviderCallLog`
- `FoundryAuditEvent`

`TenantAiQuota` supports two enforced scopes: operation aggregate and operation-plus-resolved-model. Each policy includes tenant, operation, optional model, calendar period, and maximum consumed jobs. Operations initially include `RECEIPT_OCR` and `AI_SEARCH`. Database constraints require no model for aggregate scope and exactly one model for model scope.

### 11.2 User contract

- Capture user sees curated modes such as Fast, Balanced, and High Accuracy.
- UI shows remaining jobs and UTC reset date.
- Provider, credential, raw model, route, and prompt details remain hidden.
- One provider-accepted receipt/document request consumes one OCR product credit.
- One provider-accepted natural-language/semantic query consumes one AI-search product credit.
- Internal retries and multi-call planner/answer execution do not consume extra product credits.
- Exhausted mode or operation becomes unavailable; permitted alternatives and non-AI fallback remain available.

An admitted product request is one App API-authorized job persisted with its outbox record and immutable idempotency key. Reservation immediately reduces displayed availability, but credit becomes consumed only when a provider accepts or bills a call. Cancellation, validation failure, or infrastructure failure before provider acceptance releases it.

### 11.3 Reservation lifecycle

```text
RESERVED -> CALL_STARTED -> CONSUMED
    |              |
    v              v
RELEASED      RECONCILIATION_REQUIRED
    |              |
    `-> RESERVED    `-> CONSUMED or RELEASED after reconciliation
```

- Reservation uses a unique tenant, operation, and request/job idempotency key.
- PostgreSQL transaction atomically locks and checks both tenant operation aggregate and resolved-model period counters before reserving. Model/route switching cannot bypass the aggregate allowance; trial AI search therefore remains 20 total requests per tenant/month.
- Before an outbound provider call, worker records a unique attempt and moves reservation to `CALL_STARTED`. Provider idempotency keys are used where available.
- Provider acceptance or billing consumes product credit even if a later response fails.
- Calls attempted after provider acceptance are logged individually but remain attached to one product request.
- Timeout or connection loss after call start enters `RECONCILIATION_REQUIRED`; it never releases capacity or starts another unsafe provider call until provider records determine billability.
- Settlement and reconciliation are idempotent and can consume each operation/model counter at most once.
- Expired reservation releases only when no provider call started. A later safe retry for an already admitted job may atomically reacquire capacity under the same product idempotency key and immutable admission grant/version, recording a new reservation generation. Current entitlement applies to new idempotency keys only.
- Every enabled provider adapter defines definitive reconciliation evidence, lookup capability when available, and a bounded escalation deadline. Foundry alerts before that deadline and exposes unresolved attempts to a dedicated reconciliation queue.
- When provider lookup cannot decide billability, an authorized `quota_reconciler` resolves consumed or released from provider request IDs, billing exports, or support evidence. Ambiguous release requires dual approval. Resolution reason/evidence is immutable and audited; the original request is never retried while ambiguous.
- MVP maps each curated mode to one active model. Future fallback reserves the target model explicitly.
- Internal dollar safety ceilings remain separate from customer-visible allowances.

### 11.4 Execution handoff

- Reservation response fixes immutable route version, provider adapter kind, raw provider model ID, metered model, and allowed Secret Manager reference for that request.
- Worker service identity may read only secrets required by enabled routes. Secret values never cross Foundry execution/read APIs and never enter workflow payloads, call logs, or App API data. Operator credential updates use write-only request fields, TLS, immediate Secret Manager storage, and redacted responses.
- Worker reports provider acceptance, usage, latency, cost, and terminal outcome to Foundry using reservation-scoped idempotency keys.
- All internal provider calls for one accepted product request attach to its reservation. Supporting retries or planner/answer calls remain telemetry and do not consume another product credit.

## 12. Forwarded Receipt Intake

The receiver maintains one physical inbound route such as `receipts@inbound.example.com`. Virtual plus-address tokens route mail without provisioning separate mailboxes:

```text
receipts+<opaque-random-token>@inbound.example.com
```

The address shown in Capture PWA and Office Web is bound to the current active Personal/business profile. Switching profiles changes the displayed virtual address.

### 12.1 Security records

- `VerifiedEmailSender`
- `InboundRoutingToken`
- `InboundEmail`
- `InboundEmailAttachment`
- `InboundEmailQuarantineEvent`

### 12.2 Trust checks

- Token contains at least 128 bits of randomness and exposes no tenant/business UUID.
- Database stores token hash and binding, not raw token.
- Sender ownership is confirmed through an email challenge.
- Inbound provider webhook signature is verified.
- Outer forwarded message must pass acceptable SPF/DKIM/DMARC or valid ARC policy.
- Token and verified sender must match.
- Unknown, revoked, mismatched, unauthenticated, oversized, unsupported, or malicious mail is quarantined before OCR.
- Quarantined mail creates no expense and consumes no OCR credit.
- MIME validation, HTML sanitization, attachment limits, malware scanning, rate limiting, Message-ID/content-hash deduplication, token rotation, and revocation are required.
- Raw email has a short processing/quarantine retention period; durable storage keeps extracted expense data and necessary audit metadata only.

App API validates trust and writes intake/outbox records. Python `ForwardedReceiptWorkflow` parses trusted content and enters the standard OCR pipeline with source `FORWARDED_EMAIL`.

## 13. Premium Connected Mailbox Scanning

Connected mailbox scanning remains a later premium feature:

- Gmail first; Outlook may follow.
- OAuth callback, effective entitlement, token reference, configuration, and audit records belong to App API.
- OAuth secrets and refresh tokens live in Secret Manager.
- Each mailbox scan configuration is explicitly bound to one Personal profile or one business. A user may create separate non-overlapping provider labels or folders for different profiles.
- App API enforces one discovery record per mailbox connection and provider message ID. Exactly one matching, currently authorized configuration supplies the scope. Zero or multiple matches enter one unassigned review record; overlapping configurations never create duplicate profile intake.
- Connection owner and explicit `MailboxReviewGrant` records define review visibility before any target profile is chosen. Review requires active `TenantMembership` plus connection ownership/grant; tenant role alone grants no mailbox-content access.
- Assignment requires the acting reviewer to hold active membership in the selected Personal/business profile. Assignment is atomic and single-use. AI never guesses a business and no expense/OCR job starts until authorized assignment.
- Unassigned items use a separate connection-scoped review endpoint and never appear in Personal/business inbox queries. After assignment, App API moves provenance into the selected profile scope and all later access requires its profile membership.
- Python Temporal schedules discover candidate messages and start standard ingestion workflows.
- Every scheduled run checks current entitlement; loss of entitlement pauses schedules without deleting configuration.
- Discovery limits, scan frequency, and historical scan depth derive from plan/add-on policy.
- Cross-channel deduplication covers capture uploads, forwarded email, and connected mailbox sources.

## 14. AI Receipt Search

AI search lives in Office Web only.

```text
Office Web -> App API entitlement check -> AI_SEARCH workflow
           -> Foundry quota reservation -> Python query planner
           -> App API executes constrained Personal/business search plan
           -> Python optional answer builder -> App API result
```

Every search request and `ProcessingJob` binds exactly one `personal_profile_id` or `business_id`. App API requires matching `PersonalMembership` or `BusinessMembership` before admission and again before each result read. The model never submits raw SQL. App API validates a bounded query-plan contract and executes scope-constrained SQL, full-text, vector, or later graph operations. Basic filters and full-text search remain available when entitlement or quota is absent.

## 15. Frontend Boundaries

### 15.1 Capture PWA

Supported on phone and tablet. Responsibilities:

- Active Personal/business profile switcher.
- Camera and file capture.
- Offline queue and processing status.
- Personal/business selection and optional project.
- Spending-category selection.
- Curated OCR mode and remaining usage.
- Quick extraction review and correction.
- Current-profile forwarding address, copy action, verified-sender status, and recent forwarded intake.
- Minimal account/profile controls.

Capture PWA does not contain dense dashboards, tax reports, export builders, provider settings, model IDs, API keys, route controls, prompt editors, or connected-mailbox administration.

### 15.2 Office Web

Supported at laptop widths of 1024px and above. Smaller screens show a handoff to Capture PWA instead of compressing dense workflows. Responsibilities:

- Dashboard and expense ledger.
- Full expense review and corrections.
- Personal profile and Personal membership administration.
- Business profiles and memberships.
- Project/client cost analysis.
- Spending-category management.
- Business tax preparation, review flags, reports, and canonical exports.
- Verified email senders, forwarding token rotation, quarantine, and intake history.
- Premium connected-mailbox setup, scan history, and plan/add-on status.
- Basic search for all plans and premium AI receipt search with remaining allowance.
- Tenant plan and read-only usage summaries.

### 15.3 Foundry Web

Authorized-platform-staff-only laptop application. Route guards expose provider/model/configuration screens to `operator` and reconciliation screens to `quota_reconciler`; neither role inherits the other. Responsibilities:

- Provider connections and credential-reference updates.
- Model catalog and capability state.
- Curated mode routing and effective versions.
- Tenant/model/operation quotas and explicit overrides.
- Provider health, latency, error, token, cost, and reconciliation telemetry.
- Configuration audit history.

Foundry sees aggregate identifiers and operational metadata, not receipt content or tax data.

## 16. API Surfaces

### 16.1 Tenant API

`/api/v1` includes auth, tenant memberships, Personal profile/memberships, businesses/memberships, projects, expenses, spending categories, tax profiles/treatments, reports, exports, plans, effective entitlements, AI options/usage, search, upload sessions, verified senders, forwarding tokens, inbox history, quarantine actions, and connected-mailbox configuration.

### 16.2 Foundry operator API

`/api/platform/v1` includes providers, models, modes, route versions, quota policies and overrides, provider health/cost telemetry, reconciliation queue/resolution, and audit events. It accepts only platform-token audience with endpoint-specific `operator` or `quota_reconciler` authorization. Ambiguous release requires two distinct reconcilers.

### 16.3 Foundry internal API

`/api/internal/foundry/v1` includes entitlement snapshots, effective options, quota reservations, settlement, provider-call telemetry, and machine health updates. It is private-network/mTLS ingress, rejects tenant/platform user tokens, and requires a Foundry-specific service audience. Endpoint scopes allow `app-api` to publish entitlement snapshots and read effective options/usage; `ai-worker` may reserve/settle assigned jobs and report provider attempts. No generic service principal receives every operation.

Before reservation, worker fetches a short-lived App-signed admission grant from its bound App job endpoint. Grant contains job ID, tenant ID, opaque profile-scope hash, operation, mode/route constraints, entitlement version, allowed Foundry actions, expiry, and unique token ID, but no receipt/search/tax content. Foundry verifies App signature, worker principal, job/operation/entitlement match, expiry, and replay state before touching counters. Grant is fetched just in time and never stored in Temporal history. Foundry may fall back to a private App validation exchange when key rotation or revocation requires online validation.

### 16.4 Worker callbacks

`/api/internal/app/v1/jobs/{job_id}` exposes versioned, job-bound input and callback endpoints for extraction, search-plan, search-result, deduplication, and workflow-status updates. Internal ingress stays off public Traefik routes, uses private-network/mTLS transport, rejects user tokens, and requires an App-specific service audience. Endpoint scopes grant `ai-worker` only assigned-job input reads and legal result/status writes; dispatcher and Foundry principals cannot submit worker results. Every mutation requires deterministic idempotency key and expected aggregate version.

App API creates a `ProcessingJob` binding job ID, tenant/profile scope, target aggregate, expected version, workflow type, workflow ID/run ID, and allowed result schema. Callback routes accept job identity and result only; caller-supplied tenant, profile, or aggregate targets are ignored. App API resolves the binding server-side, verifies workflow/service identity and legal state transition, then applies the result idempotently. A worker identity alone cannot choose an arbitrary callback target.

## 17. Authentication and Authorization

- Capture and Office use tenant-token audience.
- Foundry uses a separate platform-token audience with endpoint-specific `operator` and `quota_reconciler` roles; neither role implies the other.
- App-to-Foundry and worker-to-service calls use service identity, not tenant bearer tokens.
- Foundry rejects tenant tokens regardless of tenant owner role.
- Business access always checks explicit `BusinessMembership`.
- Personal access always checks explicit `PersonalMembership`.
- Every expense, file, search, workflow, profile inbox, report, and export request binds exactly one Personal/business scope; tenant role or active UI profile never substitutes for scope membership. Unassigned connected-mailbox review is the only connection-scoped exception and uses its explicit review ACL until assignment.
- Active profile is never accepted as authorization evidence.
- Provider keys, OAuth tokens, routing-token raw values, and receipt contents are redacted from logs.
- Foundry operator changes, quota overrides, forwarding-token rotations, and export downloads are audited.

## 18. Reliability and Error Semantics

- App API writes expense/intake plus transactional outbox in one database transaction.
- Outbox dispatcher starts deterministic Temporal workflow IDs and retries safely.
- Foundry outage leaves workflow queued; no quota is consumed.
- Quota exhaustion produces typed `QUOTA_BLOCKED` state and permitted alternatives.
- Provider failure before call start releases reservation. Known rejection before acceptance releases it; ambiguous post-start outcomes require reconciliation.
- Provider acceptance consumes one product credit; infrastructure retries remain call-log details.
- Worker result callbacks retry with same idempotency key.
- Secret Manager failure stops safely without credential substitution.
- Cross-business assignments fail before persistence.
- Export jobs are immutable; retry creates or resumes same snapshot, never a mixed result set.

Trace chain:

```text
expense_id -> workflow_id -> reservation_id -> provider_call_id
```

## 19. Migration Policy

Current database contains development/prototype data only and may be reset.

- Keep existing Alembic migration and FastAPI code as historical implementation evidence until TypeScript parity is verified.
- Establish clean TypeScript-owned App API schema and separate Foundry schema.
- Seed tenants, users, tenant memberships, Personal profiles/memberships, businesses/memberships, projects, spending categories, US tax taxonomy, plans, subscriptions, Foundry models/modes, and quotas.
- Do not implement dual writes or row-by-row legacy backfill.
- Switch development traffic only after contract, authorization, and endpoint parity tests pass.
- Remove FastAPI deployment and manual Python contract ownership in a dedicated cleanup task after cutover.

## 20. Implementation Order

Phase labels preserve completed history. Dependency order below controls execution.

| Wave | Phase | Outcome | Depends on |
|---|---|---|---|
| Complete | 0A, 0B, 0G, 0H | Bootstrap, Python prototype schema, repository rename, shared infrastructure | - |
| 1 | 0I | Fastify skeletons, Zod/OpenAPI/Pydantic generation, service auth, database ownership, test harness | completed baseline |
| Continuous | 1A revised | Polyglot CI, generated-artifact drift, migrations, authorization, and integration gates; expanded with every phase | 0I, then each phase contract |
| 2 | 0J | Clean Personal/business/tax domain, explicit scope memberships, and baseline ledger filter/sort/pagination contracts in App API; port auth/CRUD; retire project-as-tax design | 0I |
| 3 | 0J1 | Tenant plans, immutable plan versions, add-ons, entitlements, feature usage, Foundry entitlement snapshots | 0J |
| 4 | 0K | Foundry provider/model/mode catalog, secret references, AI quotas, reservations, telemetry, audit | 0I, 0J1 |
| 5A | 0L | TypeScript Temporal client and Python worker foundation with generated contracts/internal clients | 0I, 0J |
| 5B | 0D revised | Direct signed GCS upload, metadata ownership, worker access, thumbnails, export storage | 0I, 0J |
| 6 | 0C revised | End-to-end upload/OCR using App API, Foundry, Python workflow, and GCS | 0K, 0L, 0D |
| 7A | 0E revised | Business tax preparation, project cost analysis, canonical export and adapter contract | 0J, 0D |
| 7B | 0P | Secure forwarded-receipt intake through one physical route and virtual Personal/business tokens | 0J1, 0C |
| 8A | 0F0 Capture gate | Re-review Capture mockups against implemented and reviewed contracts | 0C, 0P |
| 8B | 0F0 Office gate | Re-review Office core mockups against implemented and reviewed contracts | 0E, 0P, 0J1 |
| 8C | 0F0 Foundry gate | Re-review Foundry mockups against implemented and reviewed contracts | 0K |
| 9A | 0F revised | Capture PWA | 0F0 Capture gate, 0C, 0P |
| 9B | 0M | Office Web core | 0F0 Office gate, 0E, 0J1 |
| 9C | 0N | Foundry Web | 0F0 Foundry gate, 0K |
| Release | 1C revised | Traefik routing and authentication integrated without replacing App API/Foundry authorization | 0I, 0K, 0F, 0M, 0N |
| Release | 1B revised | Reproducible portable-container production deployment and migration jobs | 1A, 1C, 0F, 0M, 0N |
| Later | 3B revised | Cross-channel duplicate detection and reviewable provenance | 0C, 0P |
| Later | 3C revised | AI-assisted spending/tax-category suggestions through worker callbacks | 0K, 0L, 0C |
| Later | 3D revised | Premium connected Gmail/Outlook scanning | 0J1, 0L, 0P, 3B |
| Later | 6A | Full-text and advanced non-AI SQL search for all tenants | 0J |
| Later | 6B revised | Premium semantic receipt search | 0K, 0L, 6A |
| Later | 6C revised | Premium natural-language query planner/answer builder; trial limit 20/month | 0J1, 0K, 0L, 6A |
| Later | 9A revised | Graphiti/graph-store foundation in isolated Python worker activities | 0L |
| Later | 9B revised | Personal/business-scoped graph ingestion from App API events | 3B, 9A |
| Later | 9C revised | Authorized graph search behind App API; optional Foundry-metered AI planning | 0K, 0L, 6A, 9B |
| Deferred | 12A-12C revised | Re-evaluate dedicated mobile framework after Capture PWA evidence; consume stable generated App API contracts | 0F and stable App API |

Parallel waves may execute concurrently only after shared contracts from their dependency wave are frozen and tested.

## 21. Existing Plan Disposition

- Phase 0B remains historical proof of prototype schema work; its target model is superseded.
- Phase 0C must be rewritten around App API, Foundry reservation, Python Temporal workflow, and GCS.
- Phase 0D must be rewritten for signed direct uploads and App API metadata ownership.
- Phase 0E must remove project tax identity and add business/year export behavior.
- Phase 0F0 must reopen review and split mockups among three frontends.
- Phase 0F becomes Capture PWA only.
- Phase 0G repository rename remains complete; Python-first contract ownership is superseded by Zod generation.
- Phase 3A capabilities move forward into Phase 0L; later Phase 3A becomes advanced ingestion expansion if retained.
- Phase 3D becomes premium connected-mailbox scanning; forwarding moves to Phase 0P.
- Phases 3B and 3C must use worker result callbacks; Python cannot mutate App API records directly.
- Phase 0J owns baseline ledger exact filters, sorting, and cursor pagination. Phase 6A adds full-text and advanced non-AI search.
- Phases 6B and 6C require AI-search entitlement and Foundry quota enforcement.
- Phase 1A must be rewritten as continuous polyglot CI beginning after Phase 0I.
- Phase 1C must preserve service authorization and separate tenant/platform audiences; gateway identity is defense in depth.
- Phase 1B must deploy the three clients, two TypeScript services, Python worker, and service-owned migration jobs on shared family infrastructure.
- Phases 9A-9C must isolate Graphiti in Python workers and keep customer authorization in App API.
- Phases 12A-12C must be rewritten against generated App API contracts after PWA evidence informs framework selection.

## 22. Verification Gates

- Zod, OpenAPI, generated TypeScript client, and generated Pydantic artifact parity.
- Tenant isolation plus matching Personal/business membership authorization on every scoped customer resource and job.
- Business-only invitees cannot read Personal data; tenant administration grants no implicit profile access.
- Runtime and migration database roles cannot access another service schema; worker has no App/Foundry database credentials.
- Database constraints reject cross-business project and tax-treatment references.
- Concurrent quota reservations never exceed tenant/model/operation monthly limit.
- Tenant aggregate quota remains enforced when users switch curated modes or resolved models.
- Every `RECONCILIATION_REQUIRED` reservation reaches an evidence-backed, audited terminal decision; ambiguous release requires two distinct reconcilers and never triggers automatic retry.
- Retries consume at most one product credit per OCR job or AI-search request.
- Fake-provider end-to-end flow covers App API, Foundry, Temporal, Python worker, and GCS.
- Forwarded-email tests cover opaque routing, verified sender, webhook signature, SPF/DKIM/DMARC/ARC policy, quarantine, malware/type limits, deduplication, rotation, and revocation.
- Capture PWA tests cover offline queue, Personal/business context, forwarding, exhausted mode, and manual fallback.
- Office tests prove reports and exports exclude personal, other-business, and unauthorized records.
- Canonical exports match deterministic golden fixtures and contain no filing operation.
- Foundry rejects tenant tokens, masks credentials, excludes receipt content, and audits all mutations.
- Temporal histories/search attributes contain no unencrypted receipt, MIME, OCR, tax, query, or secret payloads.
- Worker callbacks cannot change any target outside their App-owned `ProcessingJob` binding.
- Foundry rejects quota reservations lacking a valid App-signed admission grant for the authenticated worker and bound job.
- Failure injection covers Temporal, App API callback, Foundry, provider, GCS, Secret Manager, and inbound-email provider outages.

## 23. Approval Outcome

Written-spec approval was received on 2026-09-07 and authorizes detailed task planning for Phase 0I first. Downstream phase implementation plans must be written separately at their dependency boundary; this document is not a single all-at-once implementation plan.
