# Clerk Authentication Integration Design

**Date:** 2026-09-10

**Status:** Approved provider, tenant mapping, and revised M2M topology; revised spec pending review

## Goal

Replace placeholder/self-issued browser authentication with Clerk while
preserving application-owned authorization and resource ownership.

## Decisions

- Clerk is sole external identity provider for tenant users and platform staff.
- One Clerk instance serves Capture, Office, Foundry, and service clients.
- One Clerk Organization maps to one application `Tenant`.
- PostgreSQL remains authoritative for tenants, memberships, profile/business
  ownership, platform roles, plans, and entitlements.
- Clerk user/org identifiers are external references, not replacements for
  application UUID primary keys.
- Clerk M2M uses four machines: `app-api` and `foundry-service` are targets;
  `ai-worker-app` and `ai-worker-foundry` are source machines. Each source is
  scoped to exactly one target and has a distinct secret.
- No public DNS, gateway, TLS, or identity-dependent live exposure changes in
  this integration phase.
- Clerk Hobby is target plan initially: two users, one organization, no paid
  add-ons. Detailed application roles stay in PostgreSQL, avoiding Clerk custom
  organization-role add-on requirements.

## Token Model

Clerk custom JWT templates provide stable audiences while Clerk owns signing,
rotation, and JWKS publication:

| Token | Issuer | Audience | Consumer | Claims |
|---|---|---|---|---|
| Tenant session | Clerk | `expense-app` | App API, Capture, Office | `sub`, `sid`/`jti`, email, email verification, active org, external org role |
| Platform session | Clerk | `expense-foundry-platform` | Foundry Service/Web | `sub`, `sid`/`jti`, platform role marker |
| App service M2M | Clerk M2M | singleton array containing the Clerk `app-api` machine ID | AI worker to App API | `sub` source machine ID, `jti`, custom route scope |
| Foundry service M2M | Clerk M2M | singleton array containing the Clerk `foundry-service` machine ID | AI worker to Foundry | `sub` source machine ID, `jti`, custom route scope |

The exact Clerk claim names are configured and verified in contract tests before
production use. Session verifiers accept Clerk's session identifier (`sid`) as
the token ID when `jti` is absent. Service verifiers use Clerk's signed machine
subject (`sub`) as the service identity and do not use a caller-supplied
`client_id` or `azp` as the authorization anchor. All verifiers enforce issuer,
exact audience, algorithm, expiry, not-before, and required token type.

No service token is minted in browser code. The worker obtains or reuses a
short-lived Clerk M2M JWT using the Secret Manager-held credential dedicated to
the destination service. App API and Foundry reject tenant tokens on service
routes and service tokens on tenant/platform routes.

### Clerk-Native M2M Contract

A live development-instance probe on 2026-09-10 established these Clerk Backend
API constraints:

- `token_format` and `seconds_until_expiration` belong in the JSON request body.
  Query-string values are ignored and produce the default opaque token.
- `aud` is reserved. Clerk replaces a custom `aud` claim with an array of the
  source machine's scoped target machine IDs.
- `sub` is the Clerk source machine ID and `jti` is supplied by Clerk.
- Custom route scope claims are allowed, but cannot replace machine target scope
  as the audience boundary.

The worker therefore uses two source credentials. `ai-worker-app` is scoped only
to `app-api`; `ai-worker-foundry` is scoped only to `foundry-service`. Each JWT
must have exactly one audience entry, matching its destination target machine
ID. Services also require the exact configured source machine ID in `sub`.

## Data Model

Add nullable external identity references with unique indexes:

- App API user: `clerk_user_id`.
- App API tenant: `clerk_org_id`.
- Foundry platform operator: `clerk_user_id` or an equivalent operator identity
  mapping owned by Foundry.

Existing UUID relationships remain unchanged. A Clerk webhook synchronizes
user/org creation, updates, membership changes, and deletion markers. Webhook
processing is signature-verified, idempotent, and never trusts a browser-supplied
tenant ID. Initial local seed data may use deterministic Clerk reference values
only in tests; no production Clerk user is invented by migrations.

## Request Flows

### Tenant Browser Flow

1. Capture or Office renders Clerk sign-in UI/SDK.
2. User selects active Clerk Organization.
3. Client requests `getToken({ template: "expense-app", organizationId })`.
4. Client sends bearer token to App API.
5. App API verifies Clerk token and resolves `clerk_user_id` + `clerk_org_id` to
   application user/tenant rows.
6. Existing membership and resource-ownership checks decide authorization.

### Foundry Operator Flow

1. Foundry Web uses Clerk sign-in with the platform audience template.
2. Foundry Service verifies platform audience and platform role marker.
3. Foundry database authorization remains authoritative for catalog, quota,
   reconciliation, and audit capabilities.

### Worker Flow

1. AI worker receives tenant context only from the authenticated workflow input.
2. Worker selects the destination-specific source credential and obtains a
   five-minute Clerk M2M JWT, caching only until expiry.
3. Worker calls App API/Foundry with the matching singleton target-machine
   audience and custom route scope.
4. Services verify issuer, exact singleton audience, exact source machine
   subject, and route scope.

## Webhook Flow

Expose a private App API webhook route before public gateway work:

- Verify Clerk webhook signature using `CLERK_WEBHOOK_SIGNING_SECRET`.
- Accept only configured user, organization, and membership event types.
- Use event ID as idempotency key.
- Upsert external references and safe profile fields.
- Mark deleted external identities instead of deleting financial data.
- Return success only after durable transaction completion.

Webhook delivery remains disabled until a Clerk instance and endpoint hostname
exist. Local tests use signed deterministic fixtures.

## Configuration

Secret Manager bundle additions:

- `CLERK_SECRET_KEY` for server-side Clerk Backend API operations.
- `CLERK_APP_MACHINE_SECRET_KEY` for worker-to-App API M2M issuance.
- `CLERK_FOUNDRY_MACHINE_SECRET_KEY` for worker-to-Foundry M2M issuance.
- `CLERK_WEBHOOK_SIGNING_SECRET` for event verification.

Nonsecret runtime configuration:

- `CLERK_ISSUER_URL`.
- `CLERK_JWKS_URL` when using explicit JWKS verification.
- `CLERK_APP_AUDIENCE` = `expense-app`.
- `CLERK_FOUNDRY_AUDIENCE` = `expense-foundry-platform`.
- `CLERK_APP_SERVICE_AUDIENCE` = Clerk `app-api` target machine ID.
- `CLERK_FOUNDRY_SERVICE_AUDIENCE` = Clerk `foundry-service` target machine ID.
- `CLERK_APP_SERVICE_SUBJECT` = Clerk `ai-worker-app` source machine ID.
- `CLERK_FOUNDRY_SERVICE_SUBJECT` = Clerk `ai-worker-foundry` source machine ID.
- Frontend publishable key variables, which are public by design.

Clerk secret values are never compiled into browser assets. Secret Manager
one-version policy remains unchanged: adding Clerk secrets creates one new
version, verifies access, then destroys the prior version.

## Migration Strategy

1. Add external-ID schema migrations and verifier claim compatibility.
2. Add Clerk configuration parsing and unit tests with signed fixture tokens.
3. Add webhook signature/idempotency processing.
4. Add Clerk client providers and token acquisition to Capture, Office, and
   Foundry Web behind local configuration.
5. Keep existing self-issued auth tests as test-only fixtures while replacing
   production login/register calls.
6. Run private VPS deployment with Clerk fail-closed configuration disabled from
   public traffic until real Clerk settings are supplied.
7. After user supplies Clerk instance credentials, configure templates and run
   an authenticated private smoke test.
8. Only then design public gateway/DNS exposure.

No migration attempts to copy password hashes into Clerk. Account migration,
if needed, uses a user-approved Clerk import/reset flow and preserves app user
UUIDs through `clerk_user_id` mapping.

## Testing

- Verifier tests: issuer, exact session audience, exact singleton M2M audience,
  exact M2M source subject, JWKS signature, `sid` fallback, expiry, not-before,
  token type, and cross-audience rejection.
- Mapping tests: Clerk user/org to app user/tenant, unknown external IDs,
  deleted identities, and membership/resource ownership.
- Webhook tests: valid signature, invalid signature, replayed event, malformed
  event, idempotent retry, and deletion marker.
- Frontend tests: signed-out, signed-in tenant, organization switching,
  token refresh, and fail-closed API calls.
- Worker tests: JSON-body Clerk request, JWT response extraction, separate source
  credentials, singleton target audience, source subject, custom route scope,
  cache-before-expiry, expired-token refresh, and service-route rejection.
- Full Phase 1B source verifier and private deployment health gates remain
  required.

## Explicitly Deferred Decisions

- Clerk production instance/domain and production credentials.
- Public hostnames and gateway/TLS/DNS.
- VPS-local versus GCS object storage.
- Real OpenAI/OpenRouter adapter activation and spend limits.
- Case-specific GCP Functions or Cloud Run placement.
