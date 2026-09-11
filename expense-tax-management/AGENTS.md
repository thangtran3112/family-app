# Expense Tax Management Agent Rules

## Architecture

- App API + Foundry: Fastify/Zod/Kysely; separate PostgreSQL ownership.
- Python: Temporal worker only; no direct App/Foundry DB access.
- Zod contracts canonical; generated files read-only.
- Customer resources require explicit Personal/business scope authorization; tenant role alone never grants profile access.
- Foundry rejects tenant tokens; platform authorization remains PostgreSQL-owned.
- `expense-service` and `frontend/web` transitional; leave untouched.
- Frontend mockup gates remain app-specific.

## Completed Baseline

Local phases 0I, 0J Waves 1-4, 0J1, 0K Waves A+B, 0L, 0C, 0D, 0E, 0P, 0F0, 0F, 0M, and 0N complete. Details: `plans/PLAN.md` and `plans/sub-plans/`. Do not duplicate completed-phase history here.

## Current Production

- Clerk production + private Cloudflare Tunnel deployed.
- Hosts: `expense.tobytran.dev`, `expense-api.tobytran.dev`, `expense-capture.tobytran.dev`, `expense-office.tobytran.dev`, `expense-foundry.tobytran.dev`.
- Clerk Frontend API: `https://clerk.tobytran.dev`.
- VPS app ports loopback-only; Tunnel connector healthy.
- Production Clerk invitations redirect to `/accept-invitation`; ticket binds signup to invited email.
- Password policy: minimum 8 characters; compromised-password rejection on; complexity rules off.
- Clerk SPF/DKIM CNAMEs verified. DMARC: `_dmarc.tobytran.dev` = `v=DMARC1; p=none; adkim=s; aspf=s`.
- Remaining: users finish invitations, then provision PostgreSQL identity/operator mappings and run authenticated smoke tests. Webhook remains deferred until endpoint verification.

## Boundaries

- Preserve unrelated worktree changes, especially `plans/mockups/**`; stage exact paths only.
- Never inspect, print, commit, or expose secrets.
- Keep runtime and migration DB credentials separate.
- Do not edit generated contracts/clients directly.
- Use tests first for behavior changes; config-only changes need direct verification.
- Smallest correct diff.

## Authorization

- Explicit Personal/business scope on every customer resource.
- Reject Foundry tenant tokens in every auth path.
- Treat graph output as navigation evidence, never authorization proof.

## Git Safety

- Work on current branch; no feature branches.
- Do not commit/push/reset/stash/clean/switch unless user explicitly requests.
- Inspect status + diff before editing; never revert unrelated changes.

## Verification

- Report commands and exact outcomes.
- Do not run `opencode debug config`; resolved output may expose provider secrets.
- Restart opencode after project config/agent/rule changes.

## Infrastructure Policy

- Production mutation requires explicit deployment approval.
- VPS hosts APIs, Temporal, workers, and stateful orchestration; no always-on GCP compute.
- GCP owns Secret Manager/IAM/GitHub OIDC/WIF only.
- Secret Manager production bundle retains exactly one non-destroyed version.
- Current infrastructure sources: `infrastructure/vps/`, `infrastructure/cloudflare/expense-tax/`, `.github/workflows/expense-tax-deploy.yml`.
