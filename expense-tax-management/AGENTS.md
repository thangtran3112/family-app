# AGENTS.md - Expense Tax Management

> Project-level rules and context for AI agents working on this codebase.

## Current Architecture

- App API and Foundry are Fastify/Zod/Kysely services.
- Python is worker-only and cannot access App/Foundry PostgreSQL.
- Zod contracts are canonical; generated files are read-only.
- Every customer resource requires explicit Personal/business scope authorization; tenant role alone never grants profile access.
- Foundry tenant tokens are always invalid.
- Runtime and migration database credentials are separate.
- Transitional `expense-service` and `frontend/web` remain untouched until their owning cutover phases.
- Frontend mockup gates remain application-specific.

## Change Boundaries

- Treat current architecture statements above as authoritative over legacy plans, rules, and directory names.
- Do not add App API or Foundry database access to Python workers.
- Do not edit generated contract or client files directly. Update their Zod sources and regenerate only when task explicitly requires it.
- Keep runtime credentials and migration credentials separate in code, configuration, and documentation.
- Never inspect, print, commit, or expose environment/provider configuration or secrets.
- Preserve every unrelated worktree change.

## Authorization

- Authorize every customer resource with explicit Personal/business scope.
- Tenant role alone never grants profile access.
- Reject Foundry tenant tokens in every Foundry authentication path.

## Transitional Areas

- `expense-service` is transitional. Do not extend or migrate it as part of current App API or Foundry work.
- `frontend/web` is transitional. Do not extend or migrate it as part of current frontend work.
- Leave both areas untouched until their owning cutover phases.

## Frontend Gates

- Frontend mockup gates remain application-specific.
- Complete the applicable mockup preflight before implementing a frontend application. Do not apply one application's gate blindly to another.

## Engineering Rules

- Use tests first for behavior changes. For approved configuration/scaffolding tasks that need no new unit tests, use direct configuration and integration verification instead.
- Preserve existing docstrings and comments unless task explicitly requests changes.
- Use smallest correct diff.
- Use CodeGraph first for framework-oriented source flows and codebase-memory for architecture, boundaries, and impact analysis.
- Treat graph output as navigation evidence, not proof of authorization, tenant isolation, or dynamic dispatch. Verify those claims in source and tests.

## Git Safety

- Do not create feature branches. Work on current branch.
- Do not commit, push, reset, stash, clean, checkout, or switch branches unless explicitly requested.
- Inspect status and diff before editing. Never revert unrelated worktree changes.

## Verification

- Report commands and exact outcomes.
- Do not run `opencode debug config`; resolved output may include provider secrets.
- Restart opencode after changing project configuration, agents, or rules so changes load in a new process.
