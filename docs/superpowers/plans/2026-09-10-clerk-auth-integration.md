# Clerk Authentication Integration

> Implementation plan archived into compact status. Detailed task history lives in `.superpowers/sdd/2026-09-10-clerk-auth-integration/`.

## Goal

Use Clerk for user, organization, platform, and service identity while PostgreSQL remains authoritative for tenant, membership, profile, business, operator, plan, and entitlement authorization.

## Completed

- App API/Foundry/worker Clerk config and strict issuer/JWKS/audience verification.
- Clerk user/org identity mappings and signed webhook primitives.
- Capture, Office, and Foundry Clerk frontend integration.
- Clerk-native two-source/two-target M2M topology with scoped worker clients.
- Production Clerk runtime bundle, machines, Family organization, and private deployment.
- Cloudflare Tunnel, product host routing, Clerk DNS, SPF/DKIM, and DMARC.
- Ticket-based invitation route at `expense-tax-management/frontend/capture-web/src/app/accept-invitation/page.tsx`.

## Current Production State

- Deploy workflow `34619777986` passed at commit `a45b46a`.
- Invitation links redirect to `/accept-invitation`, bind signup to invited email, mount CAPTCHA, and accept 8-character passwords.
- Production Clerk password policy: minimum 8; compromised-password rejection on; complexity rules off.
- No public gateway or paid provider activation.

## Remaining

1. Users finish signup from pending Family invitations.
2. Provision App API `clerk_user_id`/`clerk_org_id` mappings.
3. Provision Foundry PostgreSQL operator identity.
4. Configure and verify Clerk webhook after endpoint approval.
5. Run authenticated Capture/Office/Foundry/API/worker smoke tests.

## Constraints

- Never store Clerk secrets, session tokens, machine tokens, or webhook secrets in repository, evidence, or chat.
- Preserve unrelated `expense-tax-management/plans/mockups/**` changes.
- Keep VPS app ports loopback-only and use Cloudflare Tunnel for HTTPS access.
- Do not activate paid OpenAI/OpenRouter providers during auth verification.

## References

- Design: `docs/superpowers/specs/2026-09-10-clerk-auth-integration-design.md`
- Status ledger: `.superpowers/sdd/2026-09-10-clerk-auth-integration/progress.md`
- Runtime status: `expense-tax-management/production-clerk-runtime-report.md`
