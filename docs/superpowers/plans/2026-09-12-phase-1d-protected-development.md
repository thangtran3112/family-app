# Phase 1D Protected Development Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move development integration to protected `dev`, require the stable unit/quality CI check for every pull request to `dev`, keep integration CI advisory, and leave `main` production behavior unchanged.

**Architecture:** Keep `Expense Tax CI` as the only CI workflow and make its existing `quality` job the sole required GitHub status context. Add a pull-request-only `feature/*` source-branch guard as the first quality step, remove the pull-request path filter, and protect exactly `refs/heads/dev` with one active ruleset. Update the repository agent rules to encode worktree/feature-branch/PR-to-`dev` behavior, then bootstrap `dev` at the exact green feature SHA before changing the default branch.

**Tech Stack:** GitHub Actions, GitHub CLI `gh`, GitHub REST API, YAML, Node.js 24, pnpm 11.9.0, Vitest, existing `Expense Tax CI`, existing `Expense Tax Deploy`.

**Spec:** `docs/superpowers/specs/2026-09-12-phase-1d-protected-development-design.md`

## Global Constraints

- `dev` becomes the repository default and development integration branch.
- Every coding-harness implementation session starts in a git worktree on a `feature/*` branch created from current `origin/dev`.
- Feature branches merge only through pull requests targeting `dev`.
- Direct pushes to `dev` are prohibited after bootstrap.
- Force pushes and branch deletion are prohibited for `dev`.
- `main` receives no development merges during this phase.
- Promotion from `dev` to `main` is deferred to a separately approved release design.
- The existing `Expense Tax CI` workflow remains the single source of truth. Do not duplicate its install, build, test, or integration steps in another workflow.
- `Contracts, services, workers, frontends` is the only required status check for `dev`.
- `Postgres, Temporal, cross-language, Docker` remains visible and advisory; do not add `continue-on-error`.
- The required check must reject a pull request whose `github.head_ref` does not start with `feature/`.
- The pull-request trigger has no path filter.
- The existing `main` push trigger remains unchanged because `expense-tax-deploy.yml` consumes successful main-branch runs.
- `expense-tax-deploy.yml` continues to require `head_branch == 'main'`; `dev` pull requests and merges cannot deploy production.
- Replace the entire contradictory `expense-tax-management/AGENTS.md` Git Safety block, including its blanket prohibition on branch/commit/push operations.
- Every remote write requires explicit execution-time user confirmation immediately before its command; standing authorization in `AGENTS.md` does not remove this checkpoint.
- Ruleset activation and repository default-branch change are separate confirmation checkpoints.
- Creating `dev` at the already green bootstrap SHA is the sole no-PR exception.
- If ruleset creation or verification fails, leave repository default on `main`, keep `dev` non-default, and report the blocker.
- If default-branch update fails after protection, leave the protective ruleset active and retry only that reversible setting.
- No destructive push, force-push, branch-deletion, or reset test is allowed.
- Preserve unrelated worktree changes, especially modified Phase 3 design specs; stage exact Phase 1D paths only.
- Never inspect, print, commit, or expose secrets.
- Do not edit generated contracts or clients.
- `main` and its production deployment behavior remain unchanged.

---

## File Map

Implementation work must touch only these repository paths:

- Modify: `.github/workflows/expense-tax-ci.yml` — change pull-request targeting to `dev`, remove only the pull-request path filter, and add the first quality-job `feature/*` guard without changing existing install/build/test/integration commands.
- Modify: `expense-tax-management/package.json` — add `check:phase-1d-protected-development` to expose the static workflow/rules assertions.
- Create: `expense-tax-management/scripts/check-phase-1d-protected-development.mjs` — export a deterministic static checker and provide a CLI that reads the CI workflow, deploy workflow, and `AGENTS.md`.
- Create: `expense-tax-management/scripts/check-phase-1d-protected-development.test.mjs` — Vitest tests for valid policy and each protected invariant regression.
- Modify: `expense-tax-management/AGENTS.md` — replace the complete `## Git Safety` block with Phase 1D worktree, branch, PR, merge, and confirmation rules; preserve all other sections byte-for-byte.
- Do not modify: `.github/workflows/expense-tax-deploy.yml` — it is inspected by the checker and must remain main-only.
- Do not modify: `pnpm-lock.yaml` — adding a package script changes no dependencies.
- Do not modify: any existing Phase 3 spec, plan, SDD ledger, application source, generated artifact, or infrastructure file.

Runtime-only remote operations have no repository files:

- `feature/phase-1d-protected-development` bootstrap branch and workflow run.
- `dev` ref creation at the verified green bootstrap SHA.
- `Protect development` ruleset creation and API verification.
- Repository default branch change from `main` to `dev`.
- Optional validation branch/PR targeting `dev`.

## Interfaces

- `checkPhase1dProtectedDevelopment({ ciSource, deploySource, agentsSource })` returns `string[]`; an empty array means all static invariants pass.
- The checker CLI reads `.github/workflows/expense-tax-ci.yml`, `.github/workflows/expense-tax-deploy.yml`, and `expense-tax-management/AGENTS.md`, prints `PASS Phase 1D protected development static checks` on success, and exits with status `1` after printing one `FAIL ...` line per violation.
- CI quality job remains named exactly `Contracts, services, workers, frontends`; this exact string is the required GitHub status context.
- CI integration job remains named exactly `Postgres, Temporal, cross-language, Docker`, retains `needs: quality`, and has no `continue-on-error`.
- Bootstrap SHA is the exact `head_sha` returned by the manually dispatched `Expense Tax CI` run for `feature/phase-1d-protected-development`.

## Task 1: Add Failing Static Policy Tests

**Files:**
- Create: `expense-tax-management/scripts/check-phase-1d-protected-development.test.mjs`

**Interfaces:**
- Tests import `{ checkPhase1dProtectedDevelopment }` from `./check-phase-1d-protected-development.mjs`.
- Tests pass three strings and assert returned failure messages; no GitHub network call occurs.

- [ ] **Step 1: Write the valid-policy test.**

Create a Vitest test that reads the three target files and expects an empty result:

```js
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkPhase1dProtectedDevelopment } from "./check-phase-1d-protected-development.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(appRoot, "..");

async function readPolicyInputs() {
  return {
    ciSource: await readFile(path.join(repoRoot, ".github/workflows/expense-tax-ci.yml"), "utf8"),
    deploySource: await readFile(path.join(repoRoot, ".github/workflows/expense-tax-deploy.yml"), "utf8"),
    agentsSource: await readFile(path.join(appRoot, "AGENTS.md"), "utf8"),
  };
}

describe("Phase 1D protected development policy", () => {
  it("accepts the repository policy", async () => {
    expect(checkPhase1dProtectedDevelopment(await readPolicyInputs())).toEqual([]);
  });
});
```

- [ ] **Step 2: Add regression tests for branch and trigger policy.**

Use `await readPolicyInputs()` and exact string replacement to create invalid sources. Assert failures for each mutation:

```js
it("rejects a pull-request path filter", async () => {
  const input = await readPolicyInputs();
  input.ciSource = input.ciSource.replace('  pull_request:\n    branches: [dev]\n', '  pull_request:\n    branches: [dev]\n    paths:\n      - "expense-tax-management/**"\n');
  expect(checkPhase1dProtectedDevelopment(input)).toContain("pull_request must not define paths");
});

it("rejects a pull-request path exclusion filter", async () => {
  const input = await readPolicyInputs();
  input.ciSource = input.ciSource.replace('  pull_request:\n    branches: [dev]\n', '  pull_request:\n    branches: [dev]\n    paths-ignore:\n      - "docs/**"\n');
  expect(checkPhase1dProtectedDevelopment(input)).toContain("pull_request must not define paths-ignore");
});

it("rejects a non-feature source branch guard", async () => {
  const input = await readPolicyInputs();
  input.ciSource = input.ciSource.replace("feature/*", "bugfix/*");
  expect(checkPhase1dProtectedDevelopment(input)).toContain("quality first policy check must accept feature/*");
});

it("rejects a changed main deployment workflow", async () => {
  const input = await readPolicyInputs();
  input.deploySource = input.deploySource.replaceAll("github.event.workflow_run.head_branch == 'main'", "github.event.workflow_run.head_branch == 'dev'");
  expect(checkPhase1dProtectedDevelopment(input)).toContain("deployment workflow must remain main-only");
});

it("rejects contradictory Git Safety rules", async () => {
  const input = await readPolicyInputs();
  input.agentsSource = input.agentsSource.replace("Create a `feature/*` branch", "Work on current branch");
  expect(checkPhase1dProtectedDevelopment(input)).toContain("AGENTS.md must require feature/* worktrees");
});

it("rejects a required command that exists only in a YAML comment", async () => {
  const input = await readPolicyInputs();
  input.ciSource = input.ciSource.replace("        run: pnpm ci:lint", "        run: '# pnpm ci:lint'");
  input.ciSource += "\n# pnpm ci:lint\n";
  expect(checkPhase1dProtectedDevelopment(input)).toContain("quality command pnpm ci:lint: missing executable step");
});
```

Add tests for the exact required context, integration `needs: quality`, no `continue-on-error`, main push branches, `pull_request.branches: [dev]`, and preserved `no-deploy.needs: [quality, integration]`.

- [ ] **Step 3: Run the focused test and verify expected failure.**

Run from `expense-tax-management`:

```bash
pnpm exec vitest run scripts/check-phase-1d-protected-development.test.mjs
```

Expected: FAIL during module loading with `Cannot find module './check-phase-1d-protected-development.mjs'`.

## Task 2: Implement Static Checker and Register Command

**Files:**
- Create: `expense-tax-management/scripts/check-phase-1d-protected-development.mjs`
- Modify: `expense-tax-management/package.json`
- Test: `expense-tax-management/scripts/check-phase-1d-protected-development.test.mjs`

**Interfaces:**
- `checkPhase1dProtectedDevelopment({ ciSource, deploySource, agentsSource }) -> string[]` parses YAML with the existing `yaml` dependency and accumulates all failures instead of stopping at the first one.
- CLI command is exactly `pnpm check:phase-1d-protected-development`.

- [ ] **Step 1: Implement parser and assertion helpers.**

Use this module shape; do not add dependencies:

```js
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import YAML from "yaml";

function triggerOf(workflow) {
  return workflow.on ?? workflow["on"];
}

function equal(failures, actual, expected, label) {
  if (actual !== expected) failures.push(`${label}: expected ${expected}, got ${actual}`);
}

function includes(failures, source, value, label) {
  if (!source.includes(value)) failures.push(`${label}: missing ${value}`);
}

export function checkPhase1dProtectedDevelopment({ ciSource, deploySource, agentsSource }) {
  const failures = [];
  const ci = YAML.parse(ciSource);
  const deploy = YAML.parse(deploySource);
  const ciTrigger = triggerOf(ci);
  const deployTrigger = triggerOf(deploy);

  equal(failures, ci.name, "Expense Tax CI", "CI workflow name");
  equal(failures, ciTrigger?.push?.branches?.join(","), "main,master", "CI push branches");
  if (ciTrigger?.push?.paths?.join("|") !== "expense-tax-management/**|infrastructure/docker-compose.common.yml|.github/workflows/expense-tax-ci.yml") {
    failures.push("CI main push paths changed");
  }
  equal(failures, ciTrigger?.pull_request?.branches?.join(","), "dev", "CI pull-request branch");
  if (ciTrigger?.workflow_dispatch === undefined) failures.push("workflow_dispatch trigger missing");
  if (ciTrigger?.pull_request?.paths !== undefined) failures.push("pull_request must not define paths");
  if (ciTrigger?.pull_request?.["paths-ignore"] !== undefined) failures.push("pull_request must not define paths-ignore");
  equal(failures, ci.jobs?.quality?.name, "Contracts, services, workers, frontends", "required quality context");
  equal(failures, ci.jobs?.integration?.name, "Postgres, Temporal, cross-language, Docker", "advisory integration context");
  equal(failures, ci.jobs?.integration?.needs, "quality", "integration needs quality");
  if (ci.jobs?.integration?.["continue-on-error"] !== undefined) failures.push("integration must not use continue-on-error");
  equal(failures, ci.jobs?.["no-deploy"]?.needs?.join(","), "quality,integration", "no-deploy dependencies");

  const qualitySteps = ci.jobs?.quality?.steps ?? [];
  const checkoutStep = qualitySteps[0];
  const branchStep = qualitySteps[1];
  equal(failures, checkoutStep?.uses, "actions/checkout@v4", "quality checkout first step");
  equal(failures, branchStep?.name, "Enforce feature source branch", "quality first policy check name");
  equal(failures, branchStep?.if, "github.event_name == 'pull_request'", "quality branch guard condition");
  equal(failures, branchStep?.["working-directory"], ".", "quality policy check working directory");
  includes(failures, branchStep?.run ?? "", "feature/*", "quality first policy check must accept feature/*");
  includes(failures, branchStep?.run ?? "", "HEAD_REF", "quality branch guard must inspect github.head_ref");
  includes(failures, branchStep?.env?.HEAD_REF ?? "", "github.head_ref", "quality branch guard source");

  const qualityRuns = qualitySteps
    .filter((step) => typeof step.run === "string")
    .map((step) => step.run.split("\n").map((line) => line.trim()));
  for (const command of [
    "pnpm install --frozen-lockfile",
    "uv sync --frozen --project common/python/expense-contracts",
    "uv sync --frozen --project services/ai-worker",
    "pnpm --filter @expense-tax/contracts build",
    "pnpm contracts:check",
    "pnpm ci:lint",
    "pnpm ci:typecheck",
    "pnpm ci:test",
    "pnpm ci:build",
    "pnpm ci:python:lint",
    "pnpm ci:python:test",
  ]) {
    if (!qualityRuns.some((lines) => lines.includes(command))) {
      failures.push(`quality command ${command}: missing executable step`);
    }
  }

  equal(failures, deployTrigger?.workflow_run?.branches?.join(","), "main", "deployment workflow branch");
  for (const job of ["build", "deploy"]) {
    includes(
      failures,
      deploy.jobs?.[job]?.if ?? "",
      "github.event.workflow_run.head_branch == 'main'",
      `deployment ${job} guard must remain main-only`,
    );
  }
  if (deployTrigger?.pull_request !== undefined) failures.push("deployment workflow must not trigger on pull_request");

  for (const rule of [
    "Every coding-harness implementation session must use a git worktree.",
    "Refresh `origin/dev` before creating the worktree.",
    "Create a `feature/*` branch from `origin/dev`.",
    "Never commit directly on `dev` or `main`.",
    "Push only the feature branch, then open a pull request to `dev`.",
    "Unit/quality check must succeed before merge.",
    "Never bypass branch protection or force-push.",
  ]) includes(failures, agentsSource, rule, "AGENTS.md policy");
  if (agentsSource.includes("- Work on current branch; no feature branches.")) failures.push("AGENTS.md retains contradictory Git Safety rule");

  return failures;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const repoRoot = path.resolve(appRoot, "..");
  const failures = checkPhase1dProtectedDevelopment({
    ciSource: await readFile(path.join(repoRoot, ".github/workflows/expense-tax-ci.yml"), "utf8"),
    deploySource: await readFile(path.join(repoRoot, ".github/workflows/expense-tax-deploy.yml"), "utf8"),
    agentsSource: await readFile(path.join(appRoot, "AGENTS.md"), "utf8"),
  });
  if (failures.length) {
    console.error(failures.map((failure) => `FAIL ${failure}`).join("\n"));
    process.exitCode = 1;
  } else {
    console.log("PASS Phase 1D protected development static checks");
  }
}
```

The implementation must also assert `workflow_dispatch` exists, neither `pull_request.paths` nor `pull_request.paths-ignore` exists, `main/master` push paths remain unchanged, both deployment jobs retain their `head_branch == 'main'` guard, and the deployment workflow has no pull-request trigger. Keep the exact failure labels used by Task 1 tests.

- [ ] **Step 2: Register the static command.**

Add this property to `expense-tax-management/package.json` without changing existing scripts or dependencies:

```json
"check:phase-1d-protected-development": "node scripts/check-phase-1d-protected-development.mjs"
```

- [ ] **Step 3: Run checker tests and CLI.**

Run:

```bash
pnpm exec vitest run scripts/check-phase-1d-protected-development.test.mjs
pnpm check:phase-1d-protected-development
```

Expected before Task 3: tests for the valid policy fail because current workflow/AGENTS state still describes `main/master` pull requests and no feature guard. This is expected red state; do not weaken tests.

## Task 3: Change CI Trigger/Guard and Replace Git Safety Block

**Files:**
- Modify: `.github/workflows/expense-tax-ci.yml`
- Modify: `expense-tax-management/AGENTS.md`
- Test: `expense-tax-management/scripts/check-phase-1d-protected-development.test.mjs`

**Interfaces:**
- Pull requests targeting `dev` always create `quality`, including documentation and workflow-only changes.
- `quality` checks out code first because the job inherits `working-directory: expense-tax-management`; its first executable policy check then rejects non-`feature/*` pull requests and is skipped for push/manual runs.
- `AGENTS.md` standing rules describe the workflow but do not authorize remote mutations without execution-time confirmation.

- [ ] **Step 1: Write the exact CI trigger.**

Replace only the trigger block with:

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

Do not add `paths` under `pull_request`. Do not alter the existing push paths.

- [ ] **Step 2: Add checkout first, then the first executable policy check.**

Keep `actions/checkout@v4` as the first quality step. It is an action setup step, not a shell command. Insert the following immediately after checkout and before pnpm/uv setup or any install/build/test command. This is the first executable policy check; explicitly override inherited `working-directory` to `.` so it can run after checkout:

```yaml
      - name: Enforce feature source branch
        if: github.event_name == 'pull_request'
        working-directory: .
        env:
          HEAD_REF: ${{ github.head_ref }}
        run: |
          set -euo pipefail
          case "$HEAD_REF" in
            feature/*) ;;
            *)
              echo "Pull requests to dev must originate from feature/*; got: $HEAD_REF"
              exit 1
              ;;
          esac
```

The shell may print the branch name but must not print credentials. Checkout action setup remains first; the guard is first executable policy step. Because the job inherits `working-directory: expense-tax-management`, the guard explicitly runs in `.` after checkout. Keep existing `quality.name`, `integration.name`, `integration.needs`, and all existing command steps unchanged. Do not add `continue-on-error`.

- [ ] **Step 3: Replace the entire Git Safety block.**

Replace lines from `## Git Safety` through the line before `## Verification` with this complete block:

```markdown
## Git Safety

- Every coding-harness implementation session must use a git worktree.
- Refresh `origin/dev` before creating the worktree.
- Create a `feature/*` branch from `origin/dev`.
- Never commit directly on `dev` or `main`.
- Push only the feature branch, then open a pull request to `dev`.
- Unit/quality check must succeed before merge.
- Integration result is advisory and must be reported when red.
- GitHub CLI merge is authorized after the required check is green and the PR is mergeable, squash merge is enabled, and the feature branch includes current `origin/dev`; use squash merge.
- Never bypass branch protection or force-push.
- `main` remains outside the development flow until a later release phase.
- No GitHub or Git remote write may run without explicit execution-time confirmation immediately before the command, including push, workflow dispatch, ref creation, ruleset activation, default-branch change, pull-request creation, and merge.
- Preserve unrelated worktree changes, especially `plans/mockups/**`; stage exact paths only.
- Never inspect, print, commit, or expose secrets.
- Inspect status and diff before editing; never revert unrelated changes.
```

Do not retain `Work on current branch; no feature branches.` or `Do not commit/push/reset/stash/clean/switch unless user explicitly requests.` because they contradict Phase 1D. Preserve the existing secrets, unrelated-change, exact-staging, and infrastructure safeguards outside this block.

- [ ] **Step 4: Run focused static verification.**

Run:

```bash
pnpm exec vitest run scripts/check-phase-1d-protected-development.test.mjs
pnpm check:phase-1d-protected-development
```

Expected: PASS with the static checker success line and all Vitest tests passing.

- [ ] **Step 5: Inspect diff scope.**

Run:

```bash
git diff --check
git diff -- .github/workflows/expense-tax-ci.yml expense-tax-management/AGENTS.md expense-tax-management/package.json expense-tax-management/scripts/check-phase-1d-protected-development.mjs expense-tax-management/scripts/check-phase-1d-protected-development.test.mjs
git status --short
```

Expected: no whitespace errors; diff contains only the five mapped Phase 1D paths plus no unrelated modified spec changes. Do not stage or revert existing modified specs.

- [ ] **Step 6: Commit repository implementation.**

After focused verification passes, stage exact paths and commit:

```bash
git add .github/workflows/expense-tax-ci.yml expense-tax-management/AGENTS.md expense-tax-management/package.json expense-tax-management/scripts/check-phase-1d-protected-development.mjs expense-tax-management/scripts/check-phase-1d-protected-development.test.mjs
git commit -m "feat(ci): protect dev development workflow"
```

Expected: one commit containing only Phase 1D implementation files. Do not include modified Phase 3 specs or unrelated files.

## Task 4: Run Required Local Quality Verification

**Files:**
- Read: `.github/workflows/expense-tax-ci.yml`
- Read: `expense-tax-management/package.json`
- Read: `expense-tax-management/scripts/check-phase-1d-protected-development.mjs`

**Interfaces:**
- Local commands exactly mirror the required `quality` job commands; no duplicate workflow is added.
- Integration remains a separate advisory verification and is not promoted to a required check by local results.

- [ ] **Step 1: Run the same quality commands as CI.**

From `expense-tax-management`, run:

```bash
pnpm install --frozen-lockfile
uv sync --frozen --project common/python/expense-contracts
uv sync --frozen --project services/ai-worker
pnpm --filter @expense-tax/contracts build
pnpm contracts:check
pnpm ci:lint
pnpm ci:typecheck
pnpm ci:test
pnpm ci:build
pnpm ci:python:lint
pnpm ci:python:test
pnpm check:phase-1d-protected-development
```

Expected: every command exits `0`. Record exact counts only if useful; never print credentials or environment contents.

- [ ] **Step 2: Run integration as advisory evidence.**

Run the existing integration sequence without changing its workflow semantics:

```bash
./scripts/compose.sh up -d --wait postgres
./scripts/compose.sh run --rm app-api-migrate
./scripts/compose.sh run --rm foundry-service-migrate
PHASE_0I_INTEGRATION=1 PHASE_0J_INTEGRATION=1 PHASE_0J_WAVE2_INTEGRATION=1 PHASE_0J_WAVE3_INTEGRATION=1 PHASE_0J_WAVE4_INTEGRATION=1 PHASE_0J1_INTEGRATION=1 PHASE_0K_WAVE_A_INTEGRATION=1 PHASE_0K_WAVE_B_INTEGRATION=1 PHASE_0L_INTEGRATION=1 PHASE_0L_WORKER_LOOP=1 PHASE_0D_INTEGRATION=1 PHASE_0C_INTEGRATION=1 PHASE_0C_OCR_LOOP=1 PHASE_0E_INTEGRATION=1 PHASE_0P_INTEGRATION=1 PHASE_0N_INTEGRATION=1 pnpm verify:phase-0n
```

Expected: pass is recorded; failure is recorded as advisory with likely impact and does not change ruleset configuration. Clean local containers only with the existing non-destructive compose command if needed: `./scripts/compose.sh down`.

- [ ] **Step 3: Verify production workflow remains unchanged.**

Run:

```bash
git diff HEAD^ -- .github/workflows/expense-tax-deploy.yml
git show HEAD:.github/workflows/expense-tax-deploy.yml | grep -F "github.event.workflow_run.head_branch == 'main'"
```

Expected: first command has no output; second prints the main-only condition. Do not edit or deploy production.

## Task 5: Push Bootstrap Feature Branch and Run Exact-SHA CI

**Files:**
- Runtime only; no additional repository changes.

**Interfaces:**
- Bootstrap branch: `feature/phase-1d-protected-development`.
- Bootstrap source: current `origin/main`, specifically SHA `4d260c828394e052d299be1a98fc5117c2f0ed4a` only if `origin/main` still resolves to that SHA at execution time; otherwise use the freshly fetched `origin/main` SHA and record it.
- Bootstrap workflow: `Expense Tax CI` manual dispatch; quality context must succeed; integration result is advisory.

- [ ] **Step 1: Stop and obtain execution-time confirmation for feature push.**

Before any remote write, show:

```bash
git status --short
git log -1 --format='%H %s'
git branch --show-current
```

Confirm user explicitly authorizes pushing `feature/phase-1d-protected-development` to `origin`. Without confirmation, stop with no remote mutation.

- [ ] **Step 2: Verify bootstrap source and feature commit.**

Run from `/Users/toby.tran/personal/family-app`:

```bash
git fetch origin main
git rev-parse origin/main
git show --no-patch --format='%H %s' origin/main
```

The implementation commit must be based on current `origin/main`; do not update `main`. If implementation occurred in a worktree created from `origin/main`, verify:

```bash
git merge-base --is-ancestor origin/main feature/phase-1d-protected-development
git log --oneline --decorate -3 feature/phase-1d-protected-development
```

Expected: exit `0` for ancestor check; feature branch contains the implementation commit; `main` has no new commit.

- [ ] **Step 3: Push only feature branch after confirmation.**

Immediately before this remote write, ask for and receive explicit execution-time confirmation to push the feature branch. Then run exactly:

```bash
git push --set-upstream origin feature/phase-1d-protected-development
```

Expected: remote creates/updates only `refs/heads/feature/phase-1d-protected-development`; no `dev` or `main` push occurs. Capture `BOOTSTRAP_SHA=$(git rev-parse feature/phase-1d-protected-development)` locally.

- [ ] **Step 4: Dispatch CI after separate execution-time confirmation.**

Before dispatch, record all currently visible run IDs for this branch. This prevents selecting an older manual run for the same SHA:

```bash
PRE_DISPATCH_RUN_IDS="$(gh run list --repo thangtran3112/family-app --workflow expense-tax-ci.yml --branch feature/phase-1d-protected-development --limit 100 --json databaseId --jq '[.[].databaseId]')"
BOOTSTRAP_SHA="$(git rev-parse feature/phase-1d-protected-development)"
```

Immediately before this remote write, ask for and receive explicit execution-time confirmation to dispatch `Expense Tax CI` for the pushed feature branch. Then run:

```bash
gh workflow run expense-tax-ci.yml --repo thangtran3112/family-app --ref feature/phase-1d-protected-development
```

The dispatch command does not return a run URL. Poll for at most 30 attempts, sleeping 10 seconds between attempts. Each poll must require exact `BOOTSTRAP_SHA`, event `workflow_dispatch`, and a run ID absent from `PRE_DISPATCH_RUN_IDS`. If repeated dispatches create multiple new matches, retain all candidates, sort by `createdAt`, and select newest new match; never select any pre-dispatch ID:

```bash
RUN_ID=""
MATCHED_RUNS='[]'
for attempt in $(seq 1 30); do
  RUNS_JSON="$(gh run list --repo thangtran3112/family-app --workflow expense-tax-ci.yml --branch feature/phase-1d-protected-development --limit 100 --json databaseId,headSha,event,status,conclusion,url,createdAt)"
  MATCHED_RUNS="$(printf '%s' "$RUNS_JSON" | jq -c --arg sha "$BOOTSTRAP_SHA" --argjson before "$PRE_DISPATCH_RUN_IDS" '[.[] | select(.headSha == $sha and .event == "workflow_dispatch" and ((.databaseId as $id | ($before | index($id))) == null))] | sort_by(.createdAt) | reverse')"
  if [ "$(printf '%s' "$MATCHED_RUNS" | jq 'length')" -gt 0 ]; then
    RUN_ID="$(printf '%s' "$MATCHED_RUNS" | jq -r '.[0].databaseId')"
    break
  fi
  if [ "$attempt" -lt 30 ]; then sleep 10; fi
done
if [ -z "$RUN_ID" ]; then
  printf 'No new workflow_dispatch run found for bootstrap SHA %s within 300 seconds\n' "$BOOTSTRAP_SHA" >&2
  exit 1
fi
printf 'selected_run_id=%s\nnew_matching_run_ids=%s\n' "$RUN_ID" "$(printf '%s' "$MATCHED_RUNS" | jq -r '[.[].databaseId] | join(",")')"
gh run watch "$RUN_ID" --repo thangtran3112/family-app || printf 'Workflow conclusion is non-success; inspect required and advisory jobs independently below.\n'
```

Expected: selected run has exact `BOOTSTRAP_SHA` and event `workflow_dispatch`. `gh run watch` is observational only; its result does not decide bootstrap success. If quality fails, fix the same feature branch, obtain a new immediate push confirmation, push normally, obtain a new dispatch confirmation, dispatch/watch the replacement run, and do not create `dev`.

- [ ] **Step 5: Verify job conclusions and stable context.**

Run:

```bash
gh api --paginate repos/thangtran3112/family-app/actions/runs/$RUN_ID/jobs --jq '.jobs[] | [.name, .conclusion] | @tsv'
QUALITY_CONCLUSIONS="$(gh api --paginate repos/thangtran3112/family-app/actions/runs/$RUN_ID/jobs --jq '[.jobs[] | select(.name == "Contracts, services, workers, frontends") | .conclusion] | .[]')"
if [ "$QUALITY_CONCLUSIONS" != "success" ]; then
  printf 'Required quality conclusion: %s\n' "$QUALITY_CONCLUSIONS" >&2
  exit 1
fi
```

Expected: quality row is present exactly once with conclusion `success`. Integration row is inspected and recorded independently as `success`, `failure`, or `skipped`; its failure or skip never changes the quality assertion and never blocks creation of `dev` when quality succeeded.

## Task 6: Create `dev` at Green SHA and Activate Ruleset

**Files:**
- Runtime only; no repository changes.

**Interfaces:**
- New ref is exactly `refs/heads/dev` at `BOOTSTRAP_SHA`.
- Ruleset JSON exactly targets `refs/heads/dev`, has `enforcement: active`, no bypass actors, deletion/non-fast-forward/pull-request/required-status-check rules, and only required context `Contracts, services, workers, frontends`.

- [ ] **Step 1: Stop for execution-time confirmation before creating `dev`.**

Show the verified SHA and run result:

```bash
printf 'bootstrap_sha=%s\nrun_id=%s\n' "$BOOTSTRAP_SHA" "$RUN_ID"
gh run view "$RUN_ID" --repo thangtran3112/family-app --json headSha,status,conclusion,jobs
```

Confirm user explicitly authorizes creating `dev` at this exact green SHA. This is the sole no-PR exception. Do not open a bootstrap PR and do not push a later commit to `dev`.

- [ ] **Step 2: Create `dev` ref at exact green SHA.**

Immediately before this remote write, ask for and receive explicit execution-time confirmation to create `refs/heads/dev` at `BOOTSTRAP_SHA`. Then run:

```bash
gh api --method POST repos/thangtran3112/family-app/git/refs \
  -f ref='refs/heads/dev' \
  -f sha="$BOOTSTRAP_SHA"
```

Verify without mutation:

```bash
gh api repos/thangtran3112/family-app/git/ref/heads/dev --jq '.object.sha'
```

Expected: output exactly equals `BOOTSTRAP_SHA`.

- [ ] **Step 3: Enumerate existing rulesets and effective `dev` rules before activation.**

Current `gh api` documentation states that `--paginate` emits each page as a separate JSON array/object and `--slurp` wraps those pages in an outer array. The repository currently has a tiny ruleset list, so request one page with `per_page=100` and do not use `--slurp`; the endpoint response is a simple array. If the response ever reaches 100 items, stop and use the documented fallback below, which flattens page arrays with `add` rather than assuming a `.rulesets` wrapper. Run these read-only commands before creating the ruleset:

```bash
RULESETS_BEFORE_JSON="$(gh api 'repos/thangtran3112/family-app/rulesets?per_page=100')"
printf '%s' "$RULESETS_BEFORE_JSON" | jq -e 'type == "array"' >/dev/null
printf '%s' "$RULESETS_BEFORE_JSON" | jq -r '.[] | [.id,.name,.target,.enforcement,((.conditions.ref_name.include // []) | join(","))] | @tsv'
BEFORE_ACTIVE_DEV_COUNT="$(printf '%s' "$RULESETS_BEFORE_JSON" | jq '[.[] | select(.enforcement == "active" and .conditions.ref_name.include == ["refs/heads/dev"] and .conditions.ref_name.exclude == [])] | length')"
printf 'active_exact_dev_rulesets_before=%s\n' "$BEFORE_ACTIVE_DEV_COUNT"
if [ "$BEFORE_ACTIVE_DEV_COUNT" -ne 0 ]; then
  printf 'Expected zero active exact-dev rulesets before bootstrap activation\n' >&2
  exit 1
fi
gh api repos/thangtran3112/family-app/rules/branches/dev --jq '.[] | {type,parameters}'
```

Fallback only when one-page response length is 100:

```bash
RULESET_PAGES_BEFORE_JSON="$(gh api --paginate --slurp repos/thangtran3112/family-app/rulesets)"
RULESETS_BEFORE_JSON="$(printf '%s' "$RULESET_PAGES_BEFORE_JSON" | jq -c 'if type == "array" and all(.[]; type == "array") then add else error("expected slurped array pages") end')"
```

Expected: every existing ruleset is enumerated, `active_exact_dev_rulesets_before=0`, and effective branch rules are either empty or unrelated to this new ruleset. If the branch-rules endpoint returns an error other than an empty rules response, stop and report it; do not create a second policy.

- [ ] **Step 4: Stop for separate ruleset activation confirmation.**

Do not combine this confirmation with default-branch confirmation. Explain that the next command activates irreversible branch enforcement against exactly `dev`, with no bypass actors.

- [ ] **Step 5: Create exact active ruleset.**

Immediately before this remote write, ask for and receive explicit execution-time confirmation to activate the `Protect development` ruleset. Then run:

```bash
RULESET_JSON="$(gh api --method POST repos/thangtran3112/family-app/rulesets --input - <<'JSON'
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
JSON
)
RULESET_ID="$(printf '%s' "$RULESET_JSON" | jq -r '.id')"
```

Capture returned JSON in `RULESET_JSON`, then set `RULESET_ID="$(printf '%s' "$RULESET_JSON" | jq -r '.id')"` without printing unrelated response fields.

- [ ] **Step 6: Enumerate and verify stored/effective rules before default-branch mutation.**

Run:

```bash
RULESETS_AFTER_JSON="$(gh api 'repos/thangtran3112/family-app/rulesets?per_page=100')"
printf '%s' "$RULESETS_AFTER_JSON" | jq -e 'type == "array"' >/dev/null
printf '%s' "$RULESETS_AFTER_JSON" | jq -r '.[] | [.id,.name,.target,.enforcement,((.conditions.ref_name.include // []) | join(","))] | @tsv'
AFTER_ACTIVE_DEV_COUNT="$(printf '%s' "$RULESETS_AFTER_JSON" | jq '[.[] | select(.enforcement == "active" and .conditions.ref_name.include == ["refs/heads/dev"] and .conditions.ref_name.exclude == [])] | length')"
printf 'active_exact_dev_rulesets_after=%s\n' "$AFTER_ACTIVE_DEV_COUNT"
if [ "$AFTER_ACTIVE_DEV_COUNT" -ne 1 ]; then
  printf 'Expected exactly one active exact-dev ruleset after activation\n' >&2
  exit 1
fi
RULESET_JSON="$(gh api repos/thangtran3112/family-app/rulesets/$RULESET_ID)"
printf '%s' "$RULESET_JSON" | jq -e '
  .name == "Protect development"
  and .target == "branch"
  and .enforcement == "active"
  and .conditions.ref_name.include == ["refs/heads/dev"]
  and .conditions.ref_name.exclude == []
  and .bypass_actors == []
  and ([.rules[].type] | sort) == ["deletion", "non_fast_forward", "pull_request", "required_status_checks"]
  and ([.rules[] | select(.type == "required_status_checks")] | length) == 1
  and ([.rules[] | select(.type == "required_status_checks") | .parameters.strict_required_status_checks_policy] | .[0]) == true
  and ([.rules[] | select(.type == "required_status_checks") | .parameters.required_status_checks] | .[0]) == [{"context":"Contracts, services, workers, frontends"}]
' >/dev/null
gh api repos/thangtran3112/family-app/rules/branches/dev \
  --jq '.[] | {type,parameters}'
```

The executable `jq -e` assertion must fail on any mismatch, including target, active enforcement, exact `refs/heads/dev` condition, empty bypass actors, exactly one each of deletion/non-fast-forward/pull-request/required-status rules, strict required-status policy, and exact required context.

Use `GET /repos/thangtran3112/family-app/rules/branches/dev` to inspect effective branch rules; all rule assertions come from the ruleset response and effective-branch response, with no separate per-ruleset rules request. The post-creation inventory must prove exactly one active exact-dev ruleset. If any verification fails, do not change default branch; report blocker and keep `main` default.

## Task 7: Change Default Branch and Validate PR Trigger

**Files:**
- Runtime only; optional validation branch creates temporary documentation-only content outside the implementation branch.

**Interfaces:**
- Default branch changes from `main` to `dev` only after Task 6 ruleset verification.
- Validation source branch starts with `feature/` and targets `dev`.
- No direct push, force push, deletion, or destructive test is used.

- [ ] **Step 1: Stop for separate default-branch confirmation.**

Show current branch state and verified ruleset:

```bash
gh repo view thangtran3112/family-app --json defaultBranchRef --jq '.defaultBranchRef.name'
gh api repos/thangtran3112/family-app/rulesets/$RULESET_ID --jq '{name,enforcement,conditions,bypass_actors}'
```

Confirm user explicitly authorizes changing repository default branch to `dev`. This confirmation is distinct from ruleset activation.

- [ ] **Step 2: Change default branch only.**

Immediately before this remote write, ask for and receive explicit execution-time confirmation to change the repository default branch from `main` to `dev`. Then run:

```bash
gh api --method PATCH repos/thangtran3112/family-app \
  -f default_branch='dev' \
  --jq '.default_branch'
```

Expected: output `dev`. Verify:

```bash
gh repo view thangtran3112/family-app --json defaultBranchRef --jq '.defaultBranchRef.name'
```

If this fails, leave the active ruleset untouched and retry only this command after a new explicit confirmation. Do not update any branch ref.

- [ ] **Step 3: Optionally create validation PR after confirmation.**

If validating immediately is useful, create a temporary worktree from `dev`:

```bash
git fetch origin dev
git worktree add -b feature/phase-1d-trigger-validation /Users/toby.tran/personal/family-app/.worktrees/phase-1d-trigger-validation origin/dev
```

Create exactly `docs/superpowers/validation/phase-1d-trigger-validation.md` in that validation worktree with:

```markdown
# Phase 1D Trigger Validation

This documentation-only change verifies that pull requests targeting `dev` create the required quality check.
```

Then run:

```bash
git add docs/superpowers/validation/phase-1d-trigger-validation.md
git commit -m "test(ci): validate protected dev trigger"
```

Immediately before `git push --set-upstream origin feature/phase-1d-trigger-validation`, ask for and receive explicit execution-time confirmation to push this validation branch, then run that command. Immediately before `gh pr create`, ask for and receive a separate explicit execution-time confirmation to create the validation PR, then run:

```bash
gh pr create --repo thangtran3112/family-app --base dev --head feature/phase-1d-trigger-validation --title "test(ci): validate protected dev trigger" --body "Documentation-only validation of the dev pull-request trigger and required quality context."
```

Expected: PR base is `dev`, source branch is `feature/phase-1d-trigger-validation`, required context appears, and non-feature branch guard is not involved because source branch is valid. Do not merge throwaway history unless user explicitly confirms it is useful; otherwise leave PR open or close it using a separately confirmed remote write, and never delete `dev` or use force-push.

- [ ] **Step 4: Verify rollback-safe protection behavior without destructive pushes.**

Run read-only checks:

```bash
gh api repos/thangtran3112/family-app/git/ref/heads/dev --jq '{ref,sha:.object.sha}'
gh api repos/thangtran3112/family-app/rulesets/$RULESET_ID --jq '{name,target,enforcement,conditions,bypass_actors,rules}'
gh repo view thangtran3112/family-app --json defaultBranchRef --jq '.defaultBranchRef.name'
gh run list --repo thangtran3112/family-app --workflow expense-tax-ci.yml --branch dev --limit 5 --json databaseId,headSha,status,conclusion,event,url
```

Expected: `dev` still points to `BOOTSTRAP_SHA` until a PR merge; ruleset remains active and exact; default branch is `dev`; no production deploy run is associated with the bootstrap branch. Do not attempt direct push rejection, force-push rejection, or deletion rejection because those are destructive remote tests; ruleset API state is sufficient evidence.

- [ ] **Step 5: Verify `main` production boundary.**

Run read-only API checks:

```bash
gh api repos/thangtran3112/family-app/branches/main --jq '{name,protected}'
gh api repos/thangtran3112/family-app/actions/workflows/expense-tax-deploy.yml --jq '{name,state,path}'
```

Expected: no Phase 1D ruleset targets `main`; deploy workflow remains present and its static checker confirms `workflow_run.branches: [main]` plus `head_branch == 'main'`. No production deployment is triggered by `dev` creation or a `dev` pull request.

- [ ] **Step 6: Merge a real green feature PR only after explicit confirmation.**

For a real implementation PR, first update its branch without rewriting history, then inspect merge state:

```bash
git fetch origin dev
git switch feature/phase-1d-trigger-validation
git merge --no-edit origin/dev
```

Immediately before `git push origin feature/phase-1d-trigger-validation`, ask for and receive explicit execution-time confirmation to push the updated feature branch, then run:

```bash
git push origin feature/phase-1d-trigger-validation
```

After that push, run:

```bash
PR_NUMBER="$(gh pr list --repo thangtran3112/family-app --base dev --head feature/phase-1d-trigger-validation --state open --json number --jq '.[0].number')"
gh pr view "$PR_NUMBER" --repo thangtran3112/family-app --json baseRefName,headRefName,mergeable,mergeStateStatus,statusCheckRollup
gh pr checks "$PR_NUMBER" --repo thangtran3112/family-app --required
```

The source branch must be an actual `feature/*` branch, base must be `dev`, `mergeable` must be `MERGEABLE`, `mergeStateStatus` must be `CLEAN`, and required context `Contracts, services, workers, frontends` must be successful. Obtain execution-time confirmation immediately before the remote merge, then run:

```bash
gh pr merge "$PR_NUMBER" --repo thangtran3112/family-app --squash --delete-branch=false
```

Expected: GitHub performs a squash merge into `dev`; no direct `dev` push occurs; feature history is not rewritten; `--delete-branch=false` avoids an unnecessary branch-deletion mutation. If integration is red, include failure and likely impact in merge summary before requesting confirmation. Never use `--admin`, `--auto`, `--merge`, or `--rebase`.

## Task 8: Final Evidence and Handoff

**Files:**
- Read: all mapped implementation files and spec.
- No SDD ledger or plan edits are required by this implementation plan.

- [ ] **Step 1: Run final local verification.**

From `expense-tax-management`, run:

```bash
pnpm exec vitest run scripts/check-phase-1d-protected-development.test.mjs
pnpm check:phase-1d-protected-development
pnpm ci:lint
pnpm ci:typecheck
pnpm ci:test
pnpm ci:build
pnpm ci:python:lint
pnpm ci:python:test
git diff --check
```

Expected: all required unit/quality checks pass; integration result is reported separately; no generated artifacts or unrelated files changed.

- [ ] **Step 2: Capture nonsecret GitHub evidence.**

Record only repository name, branch names, commit SHA, workflow run ID/URL, job names/conclusions, ruleset name/ID, target ref, enforcement, required context, default branch, and deployment-boundary result. Never record tokens, cookies, secrets, database URLs, or full environment output.

- [ ] **Step 3: Verify final worktree scope.**

Run:

```bash
git status --short
git log --oneline --decorate -5
git diff --name-only origin/main...HEAD
```

Expected: only the mapped Phase 1D implementation paths are in the implementation commit; pre-existing modified Phase 3 specs remain un-staged/uncommitted and untouched. No commit is amended. No commit is created by this plan-writing task.

- [ ] **Step 4: Report outcomes and blockers.**

Report separately:

```text
Repository changes: CI trigger/guard, static checker, package command, AGENTS Git Safety block.
Required check: Contracts, services, workers, frontends = success/failure.
Advisory check: Postgres, Temporal, cross-language, Docker = result and impact.
Bootstrap SHA: exact SHA or not created.
Ruleset: Protect development, refs/heads/dev, active, bypass_actors=[] = verified/not verified.
Default branch: dev/main = result.
Production boundary: Expense Tax Deploy remains main-only = verified/not verified.
Remote writes: list exact confirmed operations; state any skipped operation.
```
