# Expense Tax Management Agent Rules

## Architecture

- App API + Foundry: Fastify/Zod/Kysely; separate PostgreSQL ownership.
- Temporal workers: TypeScript only (`services/workflow-worker`); no direct App/Foundry DB access.
- Zod contracts canonical; generated files read-only.
- Customer resources require explicit Personal/business scope authorization; tenant role alone never grants profile access.
- Foundry rejects tenant tokens; platform authorization remains PostgreSQL-owned.
- `expense-service` and `frontend/web` transitional; leave untouched.
- Frontend mockup gates remain app-specific.

## Completed Baseline

Phase 0 baseline, Phase 1A CI (retired 2026-10-31: the pipeline is deployment-only, see `plans/ROADMAP.md`), Phase 1B private production deployment/auth, Phase 1C gateway hardening, Phase 1D protected development, and Phase 3B deduplication are complete. Canonical status: `plans/PLAN.md`. Completed implementation detail remains in git history, not live planning files.

## Current Production

- Clerk production + private Cloudflare Tunnel deployed.
- Hosts: `expense.tobytran.dev`, `expense-api.tobytran.dev`, `expense-capture.tobytran.dev`, `expense-office.tobytran.dev`, `expense-foundry.tobytran.dev`.
- Clerk Frontend API: `https://clerk.tobytran.dev`.
- VPS app ports loopback-only; Tunnel connector healthy.
- Production Clerk invitations redirect to `/accept-invitation`; ticket binds signup to invited email.
- Password policy: minimum 8 characters; compromised-password rejection on; complexity rules off.
- Clerk SPF/DKIM CNAMEs verified. DMARC: `_dmarc.tobytran.dev` = `v=DMARC1; p=none; adkim=s; aspf=s`.
- Clerk user/org mappings and Foundry operator roles provisioned; signed webhook delivery/replay verified.
- Authenticated production smoke passed 13/13.
- Release 2026-10-05 (`main` `d7426e5`, expense only; ai-trading stays on `dev`) is deployed: Phases 3B, 3C, 3D-A/B/C (3D inert: `MAILBOX_FEATURE_ENABLED=false`), runtime migration Task 7 Stage A/B, and family-config runtime env (the VPS loads the production profile from Firestore at deploy time).
- Releases 2026-10-06 (#31) and 2026-10-07 (#33, `main` `0a8831b`) are deployed:
  - web session wiring: Capture/Office sessions, scopes endpoint, CORS, auto-upload, public `/privacy`;
  - first-upload fixes: App API 2s job-dispatch loop, Capture duplicate-upload guard, OCR bytes kept out of Temporal history, app-owned storage volumes.
- Expense-only releases now cherry-pick the `dev` squash commits onto `main`, because `dev` carries ai-trading changes in shared paths.
- Shared Temporal `family-temporal` is active (`/opt/family-app/temporal`); legacy Expense Temporal is stopped (`restart=no`).
- Dispatch routing advanced to generation 2 on 2026-10-06. New jobs run on the TypeScript `workflow-worker` (namespace `expense-tax`, queue `expense-tax-processing`).
- Real Capture OCR jobs completed on the TypeScript worker on 2026-10-07. Stage C is done (2026-10-07, #35/#36, `main` `f20c451`): the Python `ai-worker` is gone from code, CI, and production; a rollback cannot restore it.
- Connected mailbox (Phase 4) is live since 2026-10-08/09 (`MAILBOX_FEATURE_ENABLED=true`, `main` `be7af1e`, releases #59 #62 #64 #66 #68):
  - Gmail OAuth client "Mailbox broker (expense-mailbox.tobytran.dev)" in `expense-tax-tobytran-2026`, with the Gmail API enabled;
  - 4 Clerk M2M machines, one per audience: `app-api-mailbox`, `mailbox-broker-app`, `workflow-worker-mailbox` (to the broker), `workflow-worker-mailbox-app` (to App API);
  - the family tenant's `connected_mailbox_scan` entitlement comes from an operator override in `app.tenant_feature_overrides` (the `trial` plan keeps it off);
  - the owner's Gmail is connected (Personal), with a daily 02:00 scan schedule;
  - Gmail's per-user quota is 6,000 units per rolling minute (a full message fetch costs ~30-60), and it answers an exhausted quota with 403 `rateLimitExceeded`; the broker retries it with a 1 s doubling backoff (63 s in total);
  - one discovery page can take minutes, so the worker's `/discover` timeout is 240 s, the activity's `startToCloseTimeout` 5 min, and the broker's socket timeout 300 s;
  - a document whose OCR total is 0.00 is skipped automatically (candidate `skipped`, no OpenAI retries); the first real Gmail receipt became an expense on 2026-10-10;
  - re-run a scan on the VPS: `docker exec family-temporal temporal schedule trigger --address temporal:7233 --namespace expense-tax --schedule-id mailbox-schedule-<connectionId>`.
- Receipt OCR (Capture/Office uploads and Gmail attachments) uses OpenAI through Foundry route versions: `ocr_mode_fast` and `ocr_mode_balanced` use `gpt-5.4-mini`, `ocr_mode_accurate` uses `gpt-5.4`.
  - The worker rotates `OPENAI_API_KEY`, `OPENAI_API_KEY_1`, `OPENAI_API_KEY_2` (Firestore `shared/llm`, linked into the expense profiles) with failover; only `workflow-worker` receives them.
  - A route whose provider kind is `fake` still returns placeholder data; there is no silent fallback from OpenAI to the fake.
- Clerk production Google sign-in uses a custom OAuth client in GCP project `expense-tax-tobytran-2026` (Google Auth Platform app `Family Expense Tax`, published "In production"). Its ID/secret live in Firestore `expense-tax-management/ops` (`CLERK_GOOGLE_OAUTH_CLIENT_*`).

## Boundaries

- Preserve unrelated worktree changes, especially `plans/mockups/**`; stage exact paths only.
- Never inspect, print, commit, or expose secrets.
- Keep runtime and migration DB credentials separate.
- Do not edit generated contracts/clients directly.
- Use tests first for behavior changes; config-only changes need direct verification.
- Smallest correct diff.
- Production is the only environment until commercialization (no dev or staging); local runs and the VPS are both production, except that local frontends keep Clerk development keys because Clerk rejects production keys on `localhost`.

## Env and Secrets

- Single source for all family-app env and secrets: Firestore `family-config` (`tobytran-portfolio`): `shared/*` reused values, `apps/<app>/profiles/<profile>` app env; access only via `common/config/family_config.py`.
- Laptop and VPS mirror: both load env at runtime through that CLI; no env/key files in the repo; GitHub keeps CI copies only, refreshed from Firestore.

## Authorization

- Explicit Personal/business scope on every customer resource.
- Reject Foundry tenant tokens in every auth path.
- Treat graph output as navigation evidence, never authorization proof.

## Git Safety

- **A git worktree is the default and required place for any coding change** (owner rule, 2026-10-31; root `AGENTS.md`). One worktree per task under `.worktrees/`, on its own `feature/*` branch cut from `origin/dev` after a `git fetch origin`. Never cut it from `feature/toby` or another lane's branch. Every harness and agent — Claude Code, opencode, subagents, and operators — follows this.
- The main checkout (`/Users/tobytran/personal/family-app`) is the integration and review checkout: it stays on `feature/toby` and is never edited. Uncommitted or untracked files there belong to another session; never stage, commit, stash, discard, or clean them up.
- Before starting new work: `git fetch origin`, then cut the task's worktree branch from `origin/dev`.
- Never commit directly on `dev` or `main`.
- Push the task's worktree branch (cut from the latest `origin/dev`), then open a pull request to `dev`. The owner's `feature/toby` is his own sync branch: agents never merge into it, reset it, or push it.
- Unit/quality check must succeed before merge.
- GitHub Actions runs no expense-tax test job (`expense-tax-ci.yml` removed 2026-10-31; ADR-0013 in `ai-trading/decisions/adr/`). The quality check is a local gate: `pnpm ci:lint`, `pnpm ci:typecheck`, `pnpm ci:test`, `pnpm ci:build`, `pnpm contracts:check`. Run it before you push and report the result.
- Integration (`pnpm verify:phase-0n` with the `PHASE_*_INTEGRATION` gates, Docker PostgreSQL) is a local, advisory gate. Report it when red.
- GitHub CLI merge is authorized after the local quality check has passed and been reported, the PR is mergeable, squash merge is enabled, and the branch includes current `origin/dev`; use squash merge. If GitHub still blocks the PR on the removed `Contracts, services, workers, frontends` status check (a `dev` ruleset setting), do not bypass it: tell the owner.
- After a squash merge, cut the next task's worktree branch from the new `origin/dev` tip. Never force-push `dev` or `main`, and never reset or push the owner's `feature/toby`.
- Never bypass branch protection.
- `main` remains outside the development flow until a later release phase.
- Personal repository standing approval: agents may push `feature/*` branches, open pull requests to `dev`, and squash-merge them into `origin/dev` without execution-time confirmation once the merge conditions above hold.
- Conserve GitHub Actions minutes: stack commits locally, push only after local verification, and open exactly one pull request per phase; avoid extra pushes to an open pull request unless the change needs it.
- Every other remote write still needs explicit execution-time confirmation immediately before the command: anything targeting `main`, workflow dispatch, ruleset or default-branch changes, and any force-push.
- Preserve unrelated worktree changes, especially `plans/mockups/**`; stage exact paths only.
- Never inspect, print, commit, or expose secrets.
- Inspect status and diff before editing; never revert unrelated changes.

## Verification

- Report commands and exact outcomes.
- Do not run `opencode debug config`; resolved output may expose provider secrets.
- Restart opencode after project config/agent/rule changes.

## Infrastructure Policy

- Production mutation requires explicit deployment approval.
- VPS hosts APIs, Temporal, workers, and stateful orchestration; no always-on GCP compute.
- Production GCP owns the Cloudflare Terraform WIF and state; family config lives in Firestore `family-config` (`tobytran-portfolio`); Phase 3D mailbox broker runs as a VPS container; no new GCP compute.
- Temporal database bootstrap remains an explicit operator-only Task 8; normal deploy never runs `bootstrap-temporal-db.sh`.
- Current infrastructure sources: `infrastructure/vps/`, `infrastructure/cloudflare/expense-tax/`, `.github/workflows/expense-tax-deploy.yml`.

## Tailscale

- The family-app tailnet carries admin and CI SSH only (port 2222 on `tag:family-host`); public traffic stays on the Cloudflare tunnel.
- All of it is Terraform under `infrastructure/tailscale/`. Rule: `.claude/rules/tailscale.md`; skill: `manage-family-tailscale`.
- Never the employer tailnet, never a console edit.
