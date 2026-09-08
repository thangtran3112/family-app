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

## Phase State

- Phase 0I complete: TypeScript App/Foundry baseline, canonical contracts, isolated PostgreSQL ownership, auth boundaries, generated artifacts, and local Compose verification.
- Phase 0J Waves 1-4 complete locally: identity/tenants/memberships, industry-specific businesses/categories/projects, expenses, 2025 Schedule C taxonomy, tax profiles/treatments, and cursor-paginated ledgers.
- App API migrations `002_identity_memberships` through `006_tax_profiles_treatments` are applied and verified locally.
- Final local gate: `PHASE_0I_INTEGRATION=1 PHASE_0J_INTEGRATION=1 PHASE_0J_WAVE2_INTEGRATION=1 PHASE_0J_WAVE3_INTEGRATION=1 PHASE_0J_WAVE4_INTEGRATION=1 pnpm verify:phase-0j:wave4`.
- Final evidence: `.superpowers/sdd/phase-0j-waves-3-4/task-report.md`.

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

## Remaining Pre-Infrastructure Work

- `0J1`: tenant plans, add-ons, entitlements, effective feature snapshots, and usage accounting.
- `0K`: Foundry provider/model catalog, curated AI modes, quotas, reservations, telemetry, and reconciliation.
- `0L`: Python Temporal worker foundation and durable OCR/AI workflow handoff.
- `0D`: App-owned signed upload sessions and local/GCS storage adapter boundary.
- `0C`: receipt capture/OCR pipeline after storage, Foundry, and worker foundations.
- `0E`: business/tax-year reports and export bundles based on completed tax treatment data.
- `0P`: secure forwarded receipt intake and quarantine before OCR.
- `0F0`, `0F`, `0M`, `0N`: application-specific mockup gates and Capture/Office/Foundry frontends.
- `1A`: CI/CD source and verification work may proceed; `1B` VPS deployment and `1C` production gateway hardening wait for infrastructure approval.
- Later search, graph, premium mailbox, and mobile phases remain after core pre-infrastructure capabilities.

## Infrastructure Gate

- Do not mutate VPS, GCP, production databases, gateway routes, DNS, shared infrastructure, or production secrets without explicit deployment approval.
