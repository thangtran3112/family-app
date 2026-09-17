# Phase 3D Premium Connected Mailbox Design

**Date:** 2026-09-12  
**Status:** Approved; implementation not started; blocked by Phase 3C
**Depends on:** Phase 3C auto-tagging, Phase 0J1 entitlements, Phase 0L Temporal worker, Phase 0P forwarded intake, Phase 3B deduplication, Phase 1C gateway hardening

## Objective

Allow entitled users to connect Gmail, run scheduled or manual read-only receipt
scans, ingest PDF/image attachments and deterministic structured-HTML receipts,
and route ambiguous items to review. OAuth tokens remain outside App PostgreSQL,
Temporal history, browsers, logs, and VPS files.

Gmail is the first provider. Provider-neutral contracts and cursor semantics allow
later Outlook support without rewriting App data ownership or workflows.

## Product Decisions

- Feature requires effective entitlement `connected_mailbox_scan`.
- Gmail ships first behind a provider adapter.
- Google scope is `https://www.googleapis.com/auth/gmail.readonly` only.
- A connection has one authorized default Personal/business scope.
- High-confidence receipt candidates use the default scope.
- Ambiguous receipt or scope classification enters an explicit review queue.
- First release processes PDF/image attachments and deterministic structured HTML.
- Ambiguous free text is review-only; no live LLM classification or extraction.
- Phase 3B duplicate candidates remain pending review and never auto-merge.
- Cloud Run broker uses min instances `0` and managed GCP identity.
- `main`/production deployment remains subject to a later release decision.

## Service Architecture

```text
Office Web
  -> App API (tenant/scope auth, entitlement, metadata, review)
  -> mailbox-broker on Cloud Run (OAuth, Secret Manager, Gmail calls)

App API
  -> Temporal Schedule / MailboxScanWorkflow

Python worker
  -> App API job-bound input
  -> mailbox-broker authenticated internal API
  -> App API versioned scan/candidate callbacks

mailbox-broker
  -> GCP Secret Manager (refresh token per connection)
  -> Gmail API (gmail.readonly)
  -> App API internal staging/upload callbacks

Accepted candidate
  -> existing file/OCR or structured-receipt result path
  -> expense materialization
  -> Phase 3B provenance/deduplication
```

### Why Cloud Run broker

The VPS has no safe workload identity for GCP Secret Manager. A long-lived GCP
service-account key on the VPS creates rotation and exfiltration risk. The broker
runs with a managed service account, scales to zero, and keeps Google credentials
off the VPS.

Cloud Run ingress must allow the public OAuth callback and calls from VPS services,
which cannot present Google IAM ID tokens without another Google credential.
Application routes therefore enforce:

- Public: `GET /oauth/google/callback`, protected by encrypted one-time OAuth
  state and bounded rate limits.
- Internal: Clerk M2M issuer, exact mailbox-broker audience, exact App/worker
  subjects, and route-specific scopes.
- Health: GET/HEAD only, no customer data.
- Unknown host/path/method: reject.

Google IAM protects Secret Manager access through the broker's attached service
account. Clerk M2M protects application calls. Neither replaces tenant/scope
authorization in App API.

Provision three dedicated Clerk machine identities; do not reuse existing OCR or
Foundry credentials:

- App API -> broker: subject `app-api-mailbox`, broker audience, scopes
  `oauth:start`, `connections:read`, `connections:revoke`.
- AI worker -> broker: subject `ai-worker-mailbox`, broker audience, scopes
  `mailbox:discover`, `mailbox:materialize`.
- Broker -> App API: subject `mailbox-broker-app`, App service audience, scopes
  `mailbox:write`, `files:write`.

Broker verifies exact issuer, singleton audience, subject, and route scope. App API
verifies exact broker subject/audience/scopes on staging and upload callbacks.
Machine secrets are stored in Secret Manager or the existing protected production
bundle according to runtime location; they are never shared between principals.
Contract and negative authorization tests cover every subject/audience/scope
confusion pair.

## Mailbox Broker

Add a Node 24 TypeScript Fastify service under `services/mailbox-broker`. It owns
no database. It uses:

- `googleapis` Gmail/OAuth2 client.
- `@google-cloud/secret-manager` with ambient Cloud Run credentials.
- Existing Clerk JWT/M2M verification patterns.
- Existing gateway hardening patterns for body limits, timeouts, rate limits,
  method policy, and security headers.

Provider interface:

```ts
interface MailboxProviderAdapter {
  createAuthorizationUrl(input: OAuthStartInput): Promise<OAuthStartResult>;
  exchangeAuthorizationCode(input: OAuthCallbackInput): Promise<ConnectedAccount>;
  discover(input: DiscoveryInput): Promise<DiscoveryPage>;
  materialize(input: MaterializeInput): Promise<MaterializeResult>;
  revoke(input: RevokeConnectionInput): Promise<void>;
}
```

Gmail is the only implementation in Phase 3D. Provider-specific message/history
IDs remain opaque strings behind App-owned connection/candidate records.

## OAuth Flow and Token Lifecycle

1. Office calls App API to start a Gmail connection with explicit default scope,
   timezone, and schedule.
2. App API verifies owner/admin connection permission, effective entitlement, and
   current membership to the requested Personal profile or Business.
3. App API creates pending connection and one-time OAuth attempt metadata. No code
   verifier, token, or client secret is stored in App PostgreSQL.
4. App API calls broker `POST /internal/v1/oauth/google/start` with connection and
   attempt IDs using Clerk M2M.
5. Broker returns a Google authorization URL using offline access, PKCE, exact
   readonly scope, encrypted state, and a short expiry. State uses AES-256-GCM
   authenticated encryption. It contains key ID, connection/attempt IDs, initiating
   user/session nonce, PKCE verifier, issued-at, expiry, and redirect-origin binding.
   Browser cannot read or modify it.
6. Google redirects to broker `GET /oauth/google/callback`.
7. Broker selects state key by key ID, verifies AEAD tag, expiry, redirect origin,
   initiating session binding, and one-time pending attempt, then compares a
   constant-time state digest with App API before exchanging the code.
8. Broker validates returned scopes and Gmail profile, creates one opaque
   per-connection Secret Manager secret, and stores refresh token as version 1.
   Short-lived access tokens exist only in broker memory.
9. Broker calls authenticated App API completion endpoint with connection ID,
   attempt ID, secret resource name, provider account ID, email, granted scopes,
   and initial Gmail history ID. No token value crosses this boundary.
10. App API atomically activates connection and closes attempt. Broker redirects
    browser to Office connection result page.

Google may emit a new refresh token through the OAuth client's `tokens` event.
Broker writes a new secret version, verifies it, then disables/destroys the prior
version. Token revocation marks connection `reauth_required`; it does not silently
fall back to broader scopes.

State AEAD keys live in broker project Secret Manager and rotate by overlapping
key IDs. New starts use current key; callbacks may use prior key only until their
10-minute attempt expiry. App API stores only state digest/session nonce digest,
never plaintext state or verifier.

Refresh, reauthorization, and revoke operations acquire an App API connection
lease bound to expected connection version. Secret payload includes monotonic
token generation. Broker adds and verifies a new version, then App API
compare-and-swaps active generation/version before old version is disabled. A
losing operation destroys only its own newly created version. Revocation increments
connection version, invalidates refresh leases, revokes provider credentials, then
destroys every token version. Repeated cleanup/revoke is idempotent.

Secret names use opaque connection UUIDs, never tenant names or email addresses.
The existing production environment-bundle secret remains separate. Its
single-active-version policy does not apply to per-connection token secrets.

The Google Secret Manager Node client may log full request payloads at info level,
including `addSecretVersion.payload.data`. Broker must disable Google client info
logging, redact authorization/token/secret fields at logger construction, and test
that no token appears in logs or errors.

## GCP IAM and Cost Boundary

Use a dedicated GCP project for mailbox broker and mailbox-token secrets. This is
mandatory because secret creation needs project-level permission and a name prefix
or label is not a reliable IAM boundary. Existing production-bundle secrets remain
in their current project.

Use a dedicated Cloud Run runtime service account. A custom project role grants
only secret create/get, version add/access/get/disable/destroy, and required project
metadata read. It excludes secret delete, list unrelated projects, IAM policy
mutation, owner/editor, deploy, storage, database, and production-bundle access.
Deployment identity is separate from runtime identity.

Secret resources carry labels identifying broker ownership and connection ID.
Labels aid audit but are not authorization. IAM tests prove runtime identity can
access mailbox project secrets and cannot access existing production project
secrets.

Cloud Run configuration:

- Min instances `0`.
- Small bounded max instance count initially (`2`).
- CPU allocated only during requests.
- Request/body/time limits matched to Phase 0P attachment caps.
- No Cloud Armor baseline and no paid always-on compute.
- Budget alert and usage dashboard before production enablement.

This phase targets Cloud Run/Secret Manager free or low usage, not guaranteed zero
cost. Expected monthly and per-scan cost must be recorded before production
deployment. Any live LLM cost remains separately prohibited.

## App API Data Model

Add migrations after Phase 3C.

### Mailbox connections

Add `app.mailbox_connections`:

- `id`, `tenant_id`, `owner_user_id`.
- `provider`: `gmail` (schema permits later `outlook`).
- `provider_account_id`, normalized account email.
- `secret_resource_name` opaque reference, never secret value.
- Exactly one default `personal_profile_id` or `business_id`.
- `status`: `pending`, `active`, `paused`, `reauth_required`, `disconnecting`,
  `revocation_pending`, or `revoked`.
- Granted scopes, timezone, local scan time, scan enabled flag.
- Provider cursor (`history_id`) and cursor timestamp.
- Active token generation and nullable token-operation lease ID/expiry.
- Nullable active scan-run ID/lease expiry for connection-wide single flight.
- Last scan timestamp, next schedule timestamp, version, created/updated/revoked.
- Unique active `(tenant_id, provider, provider_account_id, scope)`.

Composite foreign keys and triggers enforce exact tenant/scope agreement.
Changing default scope requires current authorization and versions the connection;
it never rewrites already-ingested candidates/expenses.

### Review grants

Add `app.mailbox_connection_reviewers`:

- Connection/tenant/user IDs.
- Role `reviewer` or `manager`.
- Version and audit timestamps.

Connection owner is an implicit manager. Explicit grants make unassigned candidates
visible before a Personal/business assignment exists. Tenant role alone never
grants review access. Assignment requires target-scope membership at action time.

### OAuth attempts

Add `app.mailbox_oauth_attempts`:

- Attempt/connection/tenant/actor IDs.
- State digest, expiry, terminal status, created/completed timestamps.
- No authorization code, PKCE verifier, access token, refresh token, or client
  secret.

Attempts are one-time and expire after 10 minutes.

### Scan runs

Add `app.mailbox_scan_runs`:

- Run/connection/tenant IDs and initiating actor or `schedule`.
- Bound entitlement version, connection version, cursor-before/cursor-after.
- Status: `pending`, `running`, `completed`, `partial`, `failed`, `skipped`.
- Counts: discovered, staged, ingested, review, duplicate, skipped, failed.
- Typed error code, started/completed timestamps, idempotency key.
- Unique `(connection_id, idempotency_key)` with permanent replay result.

### Mailbox candidates

Add `app.mailbox_candidates`:

- Candidate/run/connection/tenant IDs.
- Provider message ID and thread ID.
- Received timestamp, sender address/domain, bounded subject.
- Message content hash and attachment manifest containing names, MIME types,
  sizes, and SHA-256 only.
- Classification: `receipt`, `ambiguous`, or `not_receipt`; confidence/evidence.
- Exactly one assigned Personal/business scope or unassigned review state.
- Status: `staged`, `review`, `queued`, `processed`, `duplicate`, `skipped`,
  `failed`.
- Processing job, expense, inbound/provenance, and duplicate-match references.
- Version, idempotency key, error code, timestamps.
- Unique `(connection_id, provider_message_id)`.
- Unique `(connection_id, idempotency_key)`; same key/different normalized payload
  returns conflict.

Raw MIME, body HTML/text, inline images, and OAuth values are never stored here.
Accepted PDF/image attachments become normal encrypted/signed storage objects under
existing file retention rules.

All scan/candidate/upload/result callbacks use operation-scoped permanent keys:
`connection:run:operation:provider-message-or-page:version`. Database uniqueness,
not temporary HTTP idempotency retention, returns original result for identical
replay and rejects same-key/different-payload replay.

## Gmail Discovery and Cursor Semantics

Initial full sync:

- Read current Gmail profile history ID as pre-sync fence.
- Use `messages.list` with readonly scope, receipt-oriented query, maximum 100
  messages, and configured lookback.
- Default lookback is 30 days; hard maximum is 90 days.
- Fetch message details in bounded pages/batches.
- After durable staging, replay `users.history.list` from pre-sync fence to catch
  messages arriving during full sync.
- Persist post-replay history ID only after every discovered message ID has a
  durable candidate or durable retry record.

Incremental sync:

- Use `users.history.list(startHistoryId)` and follow pagination.
- Gmail history is typically available for at least one week but may be shorter.
- Gmail returns HTTP 404 when `startHistoryId` is outside retained history.
- On that 404, perform a bounded 30-day full sync. Existing unique message IDs
  make recovery idempotent; use same pre-fence/full-sync/replay sequence.
- A failed message fetch creates durable retry state before cursor advances.
- Cursor advances only after App API records every page/message outcome, so later
  retries do not depend on Gmail retaining old history.

First release uses scheduled polling, not Gmail Pub/Sub/watch. Sender allow/block
lists are optional connection settings. The scanner never labels, modifies,
archives, marks read, or deletes mailbox messages.

## Deterministic Classification and Extraction

Broker classifies using versioned rules:

- Allowed PDF/image attachments with Phase 0P MIME, size, magic-byte, and malware
  checks.
- JSON-LD or microdata with recognized order/invoice/receipt structures.
- Known structured HTML patterns validated against merchant/sender rules.
- Subject/sender receipt keywords as evidence, not sufficient alone for automatic
  ingestion.

High-confidence attachment or structured-HTML receipts are staged for default
scope ingestion. Ambiguous or conflicting evidence enters review. Plain free text
never creates an expense automatically.

Parser limits are fixed: maximum 1 MiB decoded HTML, 20,000 DOM nodes, depth 64,
2-second parse budget, no external resource fetch, no script execution, no XML
DTD/entity expansion, and no decompression beyond bounded Gmail decoding. Message
may include at most 5 accepted attachments, each at most existing
`MAX_UPLOAD_BYTES` (25 MiB). Exceeding a limit creates typed review/skip outcome,
never partial parsing.

### Attachment path

1. Broker refetches candidate by App-bound connection/message reference.
2. Broker requests an internal App upload grant bound to candidate and default or
   reviewed scope.
3. Broker streams attachment to existing storage path without placing bytes in
   Temporal history.
4. App API creates standard file/OCR job.
5. Existing OCR result materializes expense and Phase 3B records
   `connected_mailbox` provenance/dedup evidence.

### Structured HTML path

1. Broker parses recognized structured fields in memory.
2. Broker submits a versioned structured-receipt result bound to candidate.
3. App API validates merchant, money/currency scale, date, order number, scope,
   connection, and candidate versions.
4. App API materializes a ready expense through `insertExpenseInTransaction` (or
   its shared transaction helper), atomically creating the Phase 3C enrichment
   job/outbox exactly like manual and OCR/forwarded expenses.
5. App API invokes Phase 3B evidence/provenance path.

No raw HTML/text enters result contracts or Temporal history.

## Temporal Scheduling

Create one Temporal Schedule per active connection:

- Default daily at `02:00` in connection timezone.
- User may change local time/timezone or run manually.
- Schedule overlap policy skips a new run while prior run is active.
- Stable schedule ID derived from connection UUID.
- Manual scan uses distinct deterministic workflow ID/idempotency key.

Schedule and manual starts both acquire the same database-backed connection scan
lease by compare-and-swap. If an unexpired run owns the lease, scheduled start
returns typed `skipped_overlap` and manual start returns the existing run with
HTTP 409 semantics; neither starts another workflow. Lease expiry/recovery is
audited and requires confirming the prior workflow is terminal.

`MailboxScanWorkflow` receives only opaque scan-run reference. First activity calls
App API for job-bound input and re-checks:

- Effective `connected_mailbox_scan` entitlement and version.
- Connection status/version.
- Default scope existence.
- Connection owner/reviewer policy.

Temporal workflow inputs, activity inputs/results, heartbeats, exceptions, and
retry details contain only scan-run/candidate UUIDs, bounded counts, page ordinal,
and typed error codes. They never contain Gmail message/thread/history IDs, sender,
subject, attachment metadata/bytes, structured receipt fields, HTML/text, OAuth
state, or provider error bodies. Broker stages metadata directly into App API and
returns only opaque App IDs/counts to worker.

Entitlement disabled or connection paused returns typed `skipped`, pauses future
scheduling, and preserves configuration. Re-enablement requires explicit resume.

Per-message failures do not roll back successful candidates. Workflow records a
partial run and bounded error counts. All broker/App callbacks use deterministic
idempotency keys and expected versions.

## Scope and Review Behavior

- Connection creation requires authorization to default scope.
- Every scheduled run revalidates default scope existence and owner access.
- High-confidence candidates use default scope.
- Ambiguous candidates remain unassigned and visible only to owner or explicit
  connection reviewers.
- Assigning/reassigning requires current membership to target scope.
- Once ingestion starts, scope is immutable for that candidate; correction occurs
  through existing expense move/correction policy, not by rewriting provenance.
- No tenant-admin shortcut grants access to Personal/business candidate data.

Every connection/candidate list, detail, and mutation revalidates current tenant
membership, connection status/version, owner or non-revoked reviewer grant, and
grant version. Review assignment additionally revalidates target-scope membership.
Revoked connection/grant immediately removes read and mutation access even if a
browser retained old candidate data.

Review actions:

- `ingest`: assign authorized scope and queue processing.
- `skip`: retain metadata/audit, no expense.
- `not_receipt`: terminal training/audit outcome, no mailbox modification.
- `retry`: allowed for typed transient failure only.

## APIs

Office/App API:

- `POST /api/v1/tenants/:tenantId/mailbox-connections/google/start`
- `GET /api/v1/tenants/:tenantId/mailbox-connections`
- `GET/PATCH /api/v1/tenants/:tenantId/mailbox-connections/:connectionId`
- `POST .../:connectionId/scan-runs`
- `GET .../:connectionId/scan-runs`
- `GET .../:connectionId/candidates`
- `POST .../candidates/:candidateId/resolve`
- `POST .../:connectionId/disconnect`
- Reviewer grant management under connection.

Internal App/broker/worker routes are versioned separately and accept only
connection/attempt/scan/candidate/job references, expected versions, result data,
and idempotency keys. Caller-provided tenant/profile/business/expense targets are
not trusted; App API resolves bindings server-side.

## Office Web

Settings owns connected-mailbox administration:

- Connect Gmail and OAuth result.
- Account, status, granted readonly scope, default Personal/business scope.
- Reviewer grants.
- Daily local scan time/timezone and enable/pause.
- Manual Scan now action.
- Last/next scan and run history counts.
- Reauthorization and disconnect.
- Candidate review queue with sender, subject, received date, attachment summary,
  deterministic reason, scope selector, ingest/skip/not-receipt actions.

Capture Web shows resulting expenses but does not manage mailbox connections.
Foundry sees no mailbox account, message, receipt, or token data.

## Disconnect and Revocation

1. App API marks connection disconnecting and pauses Temporal schedule.
2. Broker loads refresh token, calls Google revocation, clears in-memory
   credentials, and destroys/disables all token secret versions.
3. App API marks connection `revoked`, closes pending candidates, and writes audit.
4. Minimal scan/candidate metadata remains for audit and duplicate prevention.

Failure to contact Google records `revocation_pending` internally and retries
boundedly; local scan access remains disabled immediately. No hard deletion of
expenses, provenance, or audit history occurs.

## Failure Behavior

- Gmail 401/invalid grant: connection `reauth_required`; no repeated refresh loop.
- Gmail 429/5xx: bounded retries honoring `Retry-After`; run may end partial.
- Expired history ID HTTP 404: bounded full-sync recovery, not connection failure.
- Entitlement disabled: typed skipped run and paused schedule.
- Candidate conflict/version mismatch: no ingestion; return stale/conflict.
- Broker/App callback uncertainty: retry same idempotency key; never duplicate
  candidate, file, job, expense, or provenance.
- Secret write succeeds but App completion fails: broker retains attempt ID and
  retries completion; expired orphan token version is destroyed by cleanup.
- Raw provider/API errors are mapped to typed codes and scrubbed of headers,
  tokens, MIME bodies, and email content.

## Implementation Decomposition

One design governs three independently reviewable implementation plans:

Phase 3D-A defines canonical `MailboxConnectionV1`, OAuth attempt, reviewer,
broker M2M, typed error, connection-version, token-generation, and permanent
idempotency contracts consumed unchanged by B/C. Phase 3D-B adds `MailboxScanRunV1`
and `MailboxCandidateV1`; Phase 3D-C may add ingestion result variants but cannot
reinterpret A/B states. Each migration has a distinct name/order and each callback
version remains accepted until no persisted job/run references it.

### Phase 3D-A: Broker and connection lifecycle

- Mailbox broker service, Cloud Run/IAM/Secret Manager infrastructure.
- Gmail OAuth start/callback/revoke.
- App connection/OAuth/reviewer schema and APIs.
- Office connect/status/reauth/disconnect UI.
- Dedicated Clerk machine identities and negative auth tests.

### Phase 3D-B: Scheduling, discovery, and review

- Temporal schedule and workflow.
- Entitlement/version checks.
- Gmail full/incremental sync and HTTP 404 recovery.
- Scan/candidate persistence, deterministic classification, review queue.

### Phase 3D-C: Ingestion and deduplication

- Attachment streaming into existing upload/OCR path.
- Structured HTML parser/result contract.
- Connected-mailbox provenance extension.
- Phase 3B cross-channel dedup integration.
- End-to-end Office scan history and candidate resolution.

Each plan ships working, testable behavior and cannot assume later subphase code.

## Verification

- OAuth uses offline access, PKCE, exact readonly scope, short-lived encrypted
  state, and one-time attempts.
- App PostgreSQL, Temporal history, Office/browser storage or response bodies, VPS
  files, and logs contain no access token, refresh token, authorization code,
  PKCE verifier, or client secret. Google necessarily sends the one-time
  authorization code in the broker callback URL; broker disables query logging,
  consumes it immediately, and never persists or returns it.
- Google client info logging cannot print Secret Manager payload data.
- Broker runs in dedicated mailbox GCP project; runtime identity cannot access
  production environment bundle or resources in existing production project.
- App, worker, and broker machine identities reject wrong audience, subject, and
  scope combinations.
- Cross-tenant/profile/business connection/candidate access fails closed.
- Tenant admin without connection grant or target-scope membership cannot review
  or assign candidates.
- Initial and incremental scans are idempotent.
- Concurrent schedule/manual/retry starts produce one connection scan lease/run.
- Expired Gmail history ID recovers through fenced bounded full sync and replays
  messages arriving during recovery.
- Cursor never advances before durable staging.
- Failed message fetch has durable retry state before cursor advancement.
- Entitlement removal pauses scans without deleting configuration.
- Attachment path uses existing security checks, OCR, and pending dedup review.
- Structured HTML path stores no raw HTML and produces validated expense data.
- Oversize/deep/slow/external-resource HTML fails within parser limits.
- Ambiguous free text creates no automatic expense.
- Disconnect disables access immediately and destroys/disables token versions.
- Refresh/revoke races cannot disable newest committed generation or retain usable
  token after revocation.
- Cloud Run scales to zero and no unapproved paid edge/AI product is enabled.
- Broker, App API, worker, Office, PostgreSQL integration, and end-to-end tests
  pass with generated artifacts clean.

## Non-Goals

- No Outlook implementation in Phase 3D; adapter compatibility only.
- No Gmail modify/labels scope.
- No Gmail Pub/Sub push notifications.
- No LLM classification or extraction.
- No raw mailbox body retention.
- No OAuth tokens in PostgreSQL or production environment bundle.
- No static GCP service-account key on VPS.
- No automatic duplicate merge.
- No automatic cross-scope routing without authorized review.
- No changes to transitional `expense-service` or `frontend/web`.

## Documentation References

- Google APIs Node.js client: OAuth offline access, token refresh events, and
  credential revocation.
- Gmail synchronization guide (updated 2026-09-10): full sync,
  `users.history.list`, and HTTP 404 recovery for expired history IDs.
- Google Cloud Node.js Secret Manager client: per-secret version lifecycle and
  ambient managed identity.
