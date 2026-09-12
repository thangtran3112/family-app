# Phase 3B Deterministic Deduplication Design

**Date:** 2026-09-11  
**Status:** Proposed  
**Depends on:** Phase 0I/0J/0J1/0K/0L/0P, Phase 1B/1C release gates

## Scope

Replace legacy Python/SQLAlchemy deduplication assumptions with App API-owned
duplicate evidence and resolution. First slice is deterministic and has no new
paid AI/provider cost:

- Exact uploaded-file SHA-256 matches.
- Canonical merchant/amount/date fingerprints.
- Deterministic fuzzy candidates: same authorized scope, merchant match, amount
  within 5%, incurred date within 2 days.
- Manual review actions: merge, keep both, or discard new.
- Explicit provenance linking manual files and forwarded-email attachments.

Perceptual image hashing, embeddings, semantic similarity, mailbox scanning, and
automatic tagging remain separate follow-up phases. Existing `expense-service`
legacy SQLAlchemy models are historical and are not modified.

## Authorization Boundary

App API remains sole writer for customer data. Every candidate query and every
resolution is constrained by:

- Same tenant.
- Same explicit Personal profile, or same explicit Business.
- Active membership resolved from authenticated caller.
- No matching solely by tenant role or active UI profile.

Python worker receives only opaque job references and extracted evidence. It does
not receive database credentials and does not mutate App tables directly.

## Data Model

### Expense provenance

Add `app.expense_sources`:

- `id` UUID primary key.
- `tenant_id` UUID.
- `personal_profile_id` nullable UUID.
- `business_id` nullable UUID.
- `expense_id` UUID.
- `source_type`: `manual_upload` or `forwarded_email`.
- `source_file_id` nullable UUID.
- `inbound_email_id` nullable UUID.
- `metadata` JSONB for non-secret source facts such as order number or sender.
- `created_at` timestamp.

Constraints enforce exactly one Personal/Business scope and at least one source
reference. Unique source references prevent duplicate provenance links.

### Duplicate matches

Add `app.expense_duplicate_matches`:

- `id`, `tenant_id`, `personal_profile_id`, `business_id`.
- `existing_expense_id`, `candidate_expense_id`.
- `match_type`: `file_sha256`, `fingerprint`, or `fuzzy_fields`.
- `confidence` numeric between 0 and 1.
- `evidence` JSONB containing normalized non-secret comparison facts.
- `status`: `pending`, `merged`, `separate`, or `dismissed`.
- `resolved_by`, `resolved_at`, `created_at`.
- Unique active match key for the same candidate/existing/match type.

No expense is hard-deleted by deduplication. Merge/discard archives the candidate
through the existing versioned App API domain behavior.

### Fingerprint

Store a versioned canonical fingerprint on the expense or a dedicated
`app.expense_dedup_fingerprints` table. Canonical input:

```text
fingerprint_version\n
normalized_merchant\n
amount_minor_units\n
currency\n
incurred_on
```

Scope is stored as columns and used in queries; it is not relied upon as a secret
inside the hash. Blank merchant/date values do not generate a field fingerprint.

## Processing Flow

1. App API confirms an uploaded file and computes/stores SHA-256 before the file
   becomes available to processing.
2. App API creates/updates a processing job with the existing opaque job
   reference.
3. Worker OCR produces extracted merchant, amount, currency, incurred date, and
   optional order/receipt number.
4. Worker calls an authenticated App API internal dedup-evidence endpoint with
   job reference, expected job version, extraction evidence, source file ID, and
   idempotency key.
5. App API resolves the job binding and scope server-side, computes canonical
   fingerprint, checks exact file hash/fingerprint/fuzzy candidates within the
   same scope, and transactionally creates pending match rows plus provenance.
6. App API returns candidate match IDs and decision `no_match` or `review`.
7. Worker submits the normal versioned job result. Duplicate evidence never lets
   the worker choose a tenant, profile, business, existing expense, or merge
   target.

All callbacks are idempotent and optimistic-version checked. A retry cannot create
duplicate match rows or duplicate provenance links.

## Resolution API

Add authenticated App API routes:

- `GET /api/v1/tenants/:tenantId/personal-profiles/:profileId/duplicate-matches`
- `GET /api/v1/tenants/:tenantId/businesses/:businessId/duplicate-matches`
- `POST .../duplicate-matches/:matchId/resolve`

Resolution request:

```json
{
  "action": "merge" | "keep_both" | "discard_new",
  "expectedMatchVersion": 1,
  "idempotencyKey": "uuid-or-client-key"
}
```

Behavior:

- `merge`: preserve existing expense as canonical, attach candidate provenance,
  merge only allowed missing/enrichment fields, archive candidate, mark match
  `merged`, emit audit event.
- `keep_both`: leave both expenses active, mark match `separate`, emit audit.
- `discard_new`: archive candidate without deleting it, mark match `dismissed`,
  emit audit.

Only pending matches resolve. Repeated identical requests return the prior result;
conflicting actions fail with a typed conflict.

## Deferred Similarity

Do not add `imagehash`, embedding generation, pgvector queries, or paid provider
calls in this slice. Later similarity work must introduce its own evidence version,
cost/quota policy, false-positive evaluation, and review UI before activation.

## UI

Phase 3B backend ships reviewable duplicate-match data and resolution actions for
Office Web. UI must show:

- Existing versus candidate expense.
- Match reason, confidence, and evidence summary.
- Source/provenance badges.
- Merge, keep both, and discard-new actions.
- Loading, conflict, failure, and completed states.

Capture only surfaces a review handoff; Foundry has no customer duplicate data.

## Verification

- Same file hash in same scope creates one pending match and is idempotent.
- Same merchant/amount/date fingerprint in different scope creates no match.
- Fuzzy candidates stay pending and never auto-merge.
- Worker cannot select arbitrary tenant/profile/business/existing expense.
- Retry with same idempotency key creates no duplicate match/provenance.
- Merge archives candidate and preserves source/audit records.
- Keep-both preserves both active expenses.
- Discard-new archives candidate without hard deletion.
- Cross-tenant, cross-profile, and cross-business reads fail closed.
- Existing OCR/M2M/service authorization and job version semantics remain green.
