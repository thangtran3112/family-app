# Production Auth Release Design

**Date:** 2026-09-11

**Status:** Approved

## Scope

Finish private production Clerk release gate before Phase 1C gateway hardening:

- Map accepted Clerk users/org to existing App API UUID rows.
- Map one Foundry operator with all required platform roles.
- Configure signed Clerk webhook delivery.
- Run authenticated Capture, Office, Foundry, API, and worker smoke tests.

Phase 1C remains separate. It must not replace App API/Foundry authorization.

## Identity Assignment

- `thangtran3112@gmail.com`: Family tenant member + Foundry `operator` and `catalog_manager`.
- `tramilyt@gmail.com`: Family tenant member only.
- Existing PostgreSQL UUIDs remain authoritative. Clerk IDs are external references.
- Unknown, deleted, remapped, or mismatched identities fail closed.
- Foundry operator identities support multiple role rows per Clerk user; role checks remain exact.

## Provisioning

Use one operator-run, idempotent provisioning command after invitations are
accepted. Inputs arrive through environment variables or a mode-0600 local file,
never command arguments or repository files:

- Clerk user IDs for both accepted users.
- Clerk Family organization ID.
- Existing App API user and tenant UUIDs.
- Foundry operator Clerk user ID.
- App and Foundry database URLs from existing local env conventions.

Provisioning transaction:

1. Assert target App API user/tenant rows exist and are active.
2. Set `app.users.clerk_user_id` and `app.tenants.clerk_org_id` idempotently.
3. Assert Family membership exists in Clerk before mapping.
4. Insert/validate `operator` and `catalog_manager` rows for thang only; conflict on different status.
5. Re-read all mappings and resolve tenant identity through production domain.

No user, tenant, membership, expense, or operator row is created implicitly.
For an empty production database only, the confirmed operator provisioning
command may explicitly bootstrap the Family tenant, both App users, tenant
memberships, Personal profile/memberships, and Foundry role rows. It must fail
if existing rows conflict with the verified Clerk identities.

## Webhook

- Endpoint: `https://expense-api.tobytran.dev/api/v1/integrations/clerk/webhook`.
- Configure Clerk with exact endpoint and signing secret through approved secret
  rotation flow; do not store secret in repository or command history.
- Verify Svix signature, event ID idempotency, user/org/membership upserts, and
  deletion markers.
- Cap raw request bodies at 1 MiB before signature verification or JSON parsing;
  oversized requests return `413` without handler execution.
- Send a controlled test event only after endpoint and secret are configured.

## Smoke Tests

- No-token API request returns `401`.
- thang tenant session resolves Family tenant and App API routes authorize.
- tramily tenant session resolves Family tenant and cannot access Foundry.
- thang platform session reaches Foundry operator/catalog routes.
- Tenant/org mismatch fails closed.
- Worker M2M calls App API and Foundry with separate target audiences.
- Clerk webhook valid event returns `202`; replay returns `202` with replay marker.
- Health/ready endpoints remain public and green.

## Safety

- Keep VPS application ports loopback-only and Cloudflare Tunnel private.
- Do not activate paid AI providers.
- Preserve unrelated `plans/mockups/**` changes.
- Record IDs and nonsecret outcomes only; never log tokens, passwords, or
  webhook secrets.

## Follow-Up

After this gate passes, design and implement Phase 1C defense-in-depth controls:
Cloudflare/Tunnel route policy, request limits, security headers, and explicit
public/protected route matrix. Service-level signed token and resource
authorization remains mandatory.
