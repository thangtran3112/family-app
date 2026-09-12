# Phase 1D Protected Development Workflow Design

**Date:** 2026-09-12  
**Status:** Approved
**Depends on:** Phase 1A CI, Phase 1B production deployment, Phase 1C gateway hardening

## Objective

Move all future implementation work to isolated feature branches and protected
pull requests targeting `dev`. GitHub must reject merges when the required
unit/quality check is not successful. Integration checks remain visible but
advisory. `main` and its production deployment behavior are outside this phase
and remain unchanged.

## Branch Topology

- `dev` becomes the repository default and development integration branch.
- Every coding-harness implementation session starts in a git worktree on a
  `feature/*` branch created from current `origin/dev`.
- Feature branches merge only through pull requests targeting `dev`.
- Direct pushes to `dev` are prohibited after bootstrap.
- Force pushes and branch deletion are prohibited for `dev`.
- `main` receives no development merges during this phase.
- Promotion from `dev` to `main` is deferred to a separately approved release
  design.

Planning-only discussion does not require a worktree. Any session that edits
tracked files, including implementation plans, workflow configuration, or agent
rules, uses a worktree and feature branch.

## Required and Advisory Checks

The existing `Expense Tax CI` workflow remains the single source of truth. Do
not duplicate its install, build, test, or integration steps in another workflow.

Add a first quality-job step for pull requests that rejects any source branch
whose `github.head_ref` does not start with `feature/`. This makes the branch-name
rule executable through the same required check instead of relying on convention.

### Required unit/quality gate

Stable check context:

```text
Contracts, services, workers, frontends
```

It continues to run:

- Frozen pnpm and uv dependency installs.
- Canonical contract build and generated-artifact drift checks.
- TypeScript lint and typecheck.
- TypeScript unit/component/service tests.
- Production frontend/service builds.
- Python lint and format checks.
- Python unit tests.

This is the only required status check for `dev`. GitHub must reject merge when
the check is missing, pending, cancelled, skipped, or unsuccessful.

### Advisory integration check

Check context:

```text
Postgres, Temporal, cross-language, Docker
```

This job continues to run full PostgreSQL migrations, Temporal worker loops,
cross-language contracts, and Docker builds. A failure remains red and visible
on the pull request, but the `dev` ruleset does not require it. Do not use
`continue-on-error`; that would hide the warning. Advisory behavior comes only
from excluding this context from required status checks. The current
`needs: quality` dependency remains: when the required quality job fails,
integration may be skipped because the pull request is already blocked.

## Workflow Trigger Changes

Modify `.github/workflows/expense-tax-ci.yml`:

```yaml
on:
  push:
    branches: [main, master]
    paths:
      - "expense-tax-management/**"
      - "infrastructure/docker-compose.common.yml"
      - ".github/workflows/expense-tax-ci.yml"
  pull_request:
    branches: [dev]
  workflow_dispatch:
```

The `pull_request` trigger intentionally has no path filter. A required workflow
with path filters can leave a pull request waiting forever because GitHub never
creates the required check for an out-of-scope change. Every pull request to
`dev`, including documentation and workflow changes, therefore creates the
stable required quality check.

The existing `push` trigger on `main` remains unchanged because
`.github/workflows/expense-tax-deploy.yml` consumes successful main-branch runs.
The deploy workflow continues to require `head_branch == 'main'`; `dev` pull
requests and merges cannot deploy production.

## GitHub Ruleset

Create one active repository ruleset targeting exactly `refs/heads/dev`:

```json
{
  "name": "Protect development",
  "target": "branch",
  "enforcement": "active",
  "conditions": {
    "ref_name": {
      "include": ["refs/heads/dev"],
      "exclude": []
    }
  },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    {
      "type": "pull_request",
      "parameters": {
        "dismiss_stale_reviews_on_push": false,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_approving_review_count": 0,
        "required_review_thread_resolution": false
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "do_not_enforce_on_create": true,
        "strict_required_status_checks_policy": true,
        "required_status_checks": [
          { "context": "Contracts, services, workers, frontends" }
        ]
      }
    }
  ],
  "bypass_actors": []
}
```

No actor, including repository administrators and automation, may bypass the
ruleset. Pull requests require zero human approvals because this is currently a
single-owner repository; CI is the merge gate. The branch must be updated with
the latest `dev` before merge.

## Bootstrap Sequence

`dev` does not exist and current CI ignores pull requests targeting it. A normal
feature pull request cannot bootstrap its own trigger because GitHub evaluates
pull-request workflow eligibility from the base/default branch. Bootstrap must
therefore use one explicit branch-creation exception:

1. Create a worktree and `feature/phase-1d-protected-development` branch from
   current `origin/main`, without changing `main`.
2. Commit workflow, `AGENTS.md`, and Phase 1D verification changes on the feature
   branch.
3. Push only the feature branch.
4. Run `Expense Tax CI` manually on that exact feature-branch SHA. Require the
   quality context to succeed; record advisory integration result.
5. Create the new `dev` ref at that exact green feature-branch SHA. This creates
   the branch with its future pull-request trigger already active. Do not push a
   later commit directly to `dev`.
6. Create the active `Protect development` ruleset with no bypass actors.
7. Read the stored/evaluated ruleset and verify exact ref condition,
   `bypass_actors: []`, pull-request rule, strict required check, deletion rule,
   and non-fast-forward rule.
8. Change repository default branch from `main` to `dev` only after ruleset
   verification succeeds.
9. Open a harmless documentation-only validation pull request from a new
   `feature/*` branch to `dev`; verify the pull-request event creates the required
   quality context. Merge only if useful; otherwise leave validation to the first
   real feature PR rather than creating throwaway history.

Creating `dev` at the already green bootstrap SHA is the sole no-PR exception.
After step 6, no direct update to `dev` is permitted. If ruleset creation or
verification fails, leave repository default on `main`, keep `dev` non-default,
and report the blocker. If the default-branch update fails after protection,
leave the protective ruleset active and retry only that reversible setting.

## Agent Rules

Replace the entire contradictory `expense-tax-management/AGENTS.md` Git Safety
block, including its blanket prohibition on branch/commit/push operations, with
durable rules and the user's standing authorization for this workflow:

- Every coding-harness implementation session must use a git worktree.
- Refresh `origin/dev` before creating the worktree.
- Create a `feature/*` branch from `origin/dev`.
- Never commit directly on `dev` or `main`.
- Push only the feature branch, then open a pull request to `dev`.
- Unit/quality check must succeed before merge.
- Integration result is advisory and must be reported when red.
- GitHub CLI merge is authorized after the required check is green and the PR is
  mergeable, squash merge is enabled, and the feature branch includes current
  `origin/dev`; use squash merge.
- Never bypass branch protection or force-push.
- `main` remains outside the development flow until a later release phase.

Existing safeguards about secrets, unrelated worktree changes, exact staging,
and explicit production mutation remain in force.

## Failure Behavior

- Required quality failure: merge is rejected. Fix on the same feature branch;
  push; wait for a new successful check.
- Missing required check: merge is rejected. Do not override; repair trigger or
  workflow configuration.
- Advisory integration failure: PR may merge after required check succeeds, but
  failure and likely impact must be stated in merge summary.
- Cancelled required check: treat as non-success; rerun only with explicit GitHub
  write authorization unless a new push naturally creates a replacement run.
- Stale branch: update feature branch from `origin/dev`; do not force-push.
- Update a stale feature branch by merging current `origin/dev` into it and
  pushing the normal merge commit; never rewrite published feature history.
- Ruleset/API setup failure: leave `dev` non-default and report blocker; do not
  claim direct pushes are disabled.

## Verification

- `dev` exists at expected bootstrap SHA.
- Repository default branch is `dev` after ruleset activation.
- `Expense Tax CI` runs for every pull request targeting `dev`.
- Quality check has exact stable context `Contracts, services, workers, frontends`.
- Quality failure blocks merge.
- Advisory integration failure does not block merge.
- Direct push, force push, and deletion of `dev` are rejected.
- Effective ruleset API output shows exact `dev` target, no bypass actors, strict
  required quality context, pull-request requirement, deletion protection, and
  non-fast-forward protection. No destructive push is used as a test.
- A non-`feature/*` pull request fails the required quality check.
- A green feature PR can be squash-merged with `gh`.
- Merge into `dev` does not trigger production deployment.
- Existing `main` push CI and `main`-only deploy workflow remain unchanged.
- `AGENTS.md` requires worktree + feature branch + PR-to-dev workflow.

## Non-Goals

- No `dev` to `main` promotion workflow.
- No protection or default-branch changes for `main`.
- No required human reviewer or CODEOWNERS policy.
- No requirement for advisory integration success.
- No production deployment from `dev`.
- No new CI provider or duplicated CI workflow.
