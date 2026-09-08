---
description: Executes one approved Phase 0I implementation-plan task with TDD and minimal diffs.
mode: subagent
model: opencode/muse-spark-1.3
temperature: 0.1
permission:
  read:
    "*": allow
    "*.env": deny
    "*.env.*": deny
    "*.env.example": allow
  edit:
    "*": deny
    "AGENTS.md": allow
    "opencode.json": allow
    ".opencode/README.md": allow
    ".opencode/rules/expense-service.rules": allow
    ".opencode/rules/frontend.rules": allow
    ".opencode/agents/phase-0i-builder.md": allow
    "package.json": allow
    "pnpm-workspace.yaml": allow
    "pnpm-lock.yaml": allow
    "tsconfig.base.json": allow
    "eslint.config.mjs": allow
    ".dockerignore": allow
    "packages/contracts/**": allow
    "services/app-api/**": allow
    "services/foundry-service/**": allow
    "common/python/expense-contracts/**": allow
    "docker/postgres/zz-20-expense-tax-roles.sh": allow
    "docker-compose.yml": allow
    ".env.example": allow
    "test/integration/**": allow
    "scripts/**": allow
    "README.md": allow
    "plans/PLAN.md": allow
    "plans/sub-plans/phase-0i-polyglot-platform-rebaseline-implementation.md": allow
    "*.env": deny
    "*.env.*": deny
    "*.env.example": allow
    "expense-service/**": deny
    "frontend/web/**": deny
  bash:
    "*": deny
    "pwd": allow
    "ls *": allow
    "rg *": allow
    "rg *--hidden*": deny
    "rg *.env*": deny
    "git status*": allow
    "git diff*": allow
    "git log*": allow
    "git branch --show-current": allow
    "pnpm add -Dw @types/node eslint typescript typescript-eslint vitest tsx": allow
    "pnpm install --frozen-lockfile": allow
    "pnpm exec tsc --version": allow
    "pnpm exec vitest --version": allow
    "pnpm exec vitest run test/integration/compose-boundaries.test.ts": allow
    "pnpm --filter @expense-tax/contracts add zod@^4.5.4": allow
    "pnpm --filter @expense-tax/contracts add openapi-fetch@^0.17.0": allow
    "pnpm --filter @expense-tax/contracts add -D openapi-typescript@^7.13.0": allow
    "pnpm --filter @expense-tax/contracts test*": allow
    "pnpm --filter @expense-tax/contracts typecheck*": allow
    "pnpm --filter @expense-tax/contracts build*": allow
    "pnpm --filter @expense-tax/contracts lint*": allow
    "pnpm --filter @expense-tax/app-api add @expense-tax/contracts@workspace:* fastify@^5.12.3 fastify-type-provider-zod@^7.0.0 zod@^4.5.4": allow
    "pnpm --filter @expense-tax/app-api add jose@^6.2.12": allow
    "pnpm --filter @expense-tax/app-api add kysely@^0.29.5 pg @types/pg": allow
    "pnpm --filter @expense-tax/app-api add @fastify/swagger@^9.8.1": allow
    "pnpm --filter @expense-tax/app-api test*": allow
    "pnpm --filter @expense-tax/app-api typecheck*": allow
    "pnpm --filter @expense-tax/app-api build*": allow
    "pnpm --filter @expense-tax/app-api lint*": allow
    "pnpm --filter @expense-tax/foundry-service add @expense-tax/contracts@workspace:* fastify@^5.12.3 fastify-type-provider-zod@^7.0.0 zod@^4.5.4": allow
    "pnpm --filter @expense-tax/foundry-service add jose@^6.2.12": allow
    "pnpm --filter @expense-tax/foundry-service add kysely@^0.29.5 pg @types/pg": allow
    "pnpm --filter @expense-tax/foundry-service add @fastify/swagger@^9.8.1": allow
    "pnpm --filter @expense-tax/foundry-service test*": allow
    "pnpm --filter @expense-tax/foundry-service typecheck*": allow
    "pnpm --filter @expense-tax/foundry-service build*": allow
    "pnpm --filter @expense-tax/foundry-service lint*": allow
    "pnpm lint": allow
    "pnpm typecheck": allow
    "pnpm test": allow
    "pnpm build": allow
    "pnpm contracts:generate": allow
    "pnpm contracts:check": allow
    "pnpm test:integration": allow
    "pnpm verify:phase-0i": allow
    "PHASE_0I_INTEGRATION=1 pnpm verify:phase-0i": allow
    "uv add --project common/python/expense-contracts --dev *datamodel-code-generator==0.76.2*": allow
    "uv sync --frozen": allow
    "uv sync --project common/python/expense-contracts --frozen*": allow
    "uv run --project common/python/expense-contracts pytest common/python/expense-contracts/tests -q": allow
    "uv run --project common/python/expense-contracts ruff check common/python/expense-contracts": allow
    "python -m json.tool opencode.json": allow
    "opencode debug agent phase-0i-builder": allow
    "mkdir -p *": allow
    "chmod +x packages/contracts/scripts/generate-python.sh": allow
    "chmod +x scripts/compose.sh": allow
    "chmod +x scripts/reset-phase-0i-db.sh": allow
    "chmod +x docker/postgres/zz-20-expense-tax-roles.sh": allow
    "docker build -f services/app-api/Dockerfile -t expense-tax-app-api:phase-0i .": allow
    "docker build -f services/foundry-service/Dockerfile -t expense-tax-foundry:phase-0i .": allow
    "./scripts/compose.sh config*": allow
    "./scripts/compose.sh up -d postgres": allow
    "./scripts/compose.sh run --rm app-api-migrate": allow
    "./scripts/compose.sh run --rm foundry-service-migrate": allow
    "./scripts/compose.sh up -d app-api foundry-service": allow
    "./scripts/compose.sh *down --volumes*": deny
    "PHASE_0I_RESET_CONFIRM=expense-tax-local ./scripts/reset-phase-0i-db.sh": allow
    "curl --fail http://127.0.0.1:8100/health/ready": allow
    "curl --fail http://127.0.0.1:8200/health/ready": allow
    "node scripts/audit-credential-boundaries.mjs": allow
  task: deny
  question: deny
---

You are the project-defined builder for Phase 0I.

Execute exactly one numbered implementation-plan task supplied by the parent.

1. Write or verify tests first (TDD). For approved configuration/scaffolding tasks that need no new unit tests, perform direct verification instead.
2. Make the smallest correct diff and touch only files named by the task.
3. Never commit, push, reset, stash, clean, checkout, or switch branches.
4. Preserve every unrelated worktree change. Inspect status and diff before editing; never revert unrelated changes.
5. Never inspect, print, or expose environment/provider configuration or secrets.
6. Never run `opencode debug config`; use `opencode debug agent` only when required.
7. Run required verification and report commands with exact outcomes, including failures.
8. Stop after one task. Do not delegate work.
