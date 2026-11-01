# 0001b: IaC consolidation (move host and deploy assets into `infrastructure/`)

Parent: [0001](../0001-laptop-migration.md) §4, §6.2, §7.4. Runs in parallel with
[0001a](0001a-laptop-bootstrap.md). It must merge and be proven on the **VPS** before
[0001c](0001c-staging-bring-up.md).

**Outcome:** every host and deploy artifact lives under `infrastructure/`. Both apps redeploy to
the VPS from the new paths with no behavior change. The workflows can target either host.

Two sessions and two PRs, so that each package's rules govern its own files (root `AGENTS.md`
"Package rules"):

- **0001b-1:** the ai-trading lane plus shared infra. Session starts in `ai-trading/` or
  `infrastructure/`; ai-trading's standing delivery authorization applies to its own release.
- **0001b-2:** the expense lane. Session starts in `expense-tax-management/`; expense
  `AGENTS.md` applies (explicit approval for production mutation; exact-path staging; release by
  cherry-pick).

The orchestrator first adds the ownership rule to root `AGENTS.md`:
"`infrastructure/apps/<app>/` belongs to `<app>` for release scoping and delivery." It also
amends `ai-trading/AGENTS.md` ("Application deployment artifacts ... live in
`ai-trading/deploy/`") and `expense-tax-management/AGENTS.md:103` in the matching PRs.

## 0001b-1: ai-trading lane plus shared infra

### Moves (`git mv`, so history follows the files)

| From | To |
|---|---|
| `infrastructure/vps/**` | `infrastructure/host/**` (Q12) |
| `infrastructure/vps/app-controls/**` | `infrastructure/host/app-controls/**` |
| `ai-trading/deploy/production/{docker-compose.yml,docker-compose.mirofish.yml,Caddyfile,deploy.sh,health-check.sh,mirofish-runtime.sh,prepare-mirofish.sh,README.md}` | `infrastructure/apps/ai-trading/` |
| `ai-trading/deploy/ci/render-env.sh` | `infrastructure/apps/ai-trading/render-env.sh` |
| `ai-trading/deploy/ci/{test-deploy-firestore.sh,test-app-controls-deploy.sh,test-health-rollback.sh,test-l6-desk.sh,test-app-controls-gateway.sh,test-render-env.sh,desk-target-state/}` | `infrastructure/apps/ai-trading/tests/` |

### Path fixes (each comes from the probe; fix all of them in the same PR)

- **Tests:**
  - `test-deploy-firestore.sh:71-75`, `test-app-controls-deploy.sh:29-31,1283-1284`,
    `test-health-rollback.sh:12`, `test-l6-desk.sh:16-20` and `test-app-controls-gateway.sh:23`
    use `$SCRIPT_DIR/../production/...`. Point them at the new siblings.
  - `test-app-controls-deploy.sh` also reads `ai-trading/control/*` through the repo root;
    resolve that path from the root.
- **`ai-trading/deploy/ci/smoke-test.sh:477`:** the Caddyfile bind-mount moves to
  `infrastructure/apps/ai-trading/Caddyfile`.
- **Local dev.** `ai-trading/deploy/local/docker-compose.override.yml:17`'s `../local/Caddyfile`
  resolves against the first compose file's directory. Fix it in one of two ways:
  - use an absolute-from-root path through `--project-directory ai-trading/deploy/local`; or
  - change the override to `../../../ai-trading/deploy/local/Caddyfile`.

  Also update `deploy/local/README.md:40-41`.
- **`ai-trading-ci.yml`:**
  - shellcheck globs (`:289-291`) move to `infrastructure/apps/ai-trading/*.sh` and
    `infrastructure/host/app-controls/*.sh`;
  - compose validation (`:340-352`) uses the new paths;
  - the `scripts` job runs the moved tests;
  - `desk-caddy-acceptance` runs `test-l6-desk.sh` from its new path.
- **`ai-trading-deploy.yml`:**
  - sparse-checkout (`:194-199`) and scp sources (`:257-301`) use the new repo paths. **The staged
    names on the host stay the same** (`config/`, `config/deploy/production/`, `bootstrap/`),
    because `deploy.sh:173,211-215` and `control/runtime.py` resolve them;
  - push `paths` add `infrastructure/apps/ai-trading/**` and
    `infrastructure/host/app-controls/**`;
  - `render-env.sh` is called from its new path.
- **Comments only:** `infrastructure/cloudflare/ai-trading/main.tf:47,112,136`, `mirofish.tf:30`,
  `ai-trading/auth/src/server.js:1`, and Desk `api/{auth,main}.py` docstrings.
- **Expense-owned references to `infrastructure/vps/`.** `package.json:29-30` runs
  `../infrastructure/vps/test-*.sh`. `check-cloudflare-infrastructure.mjs:21,74` pins
  `infrastructure/vps/bootstrap-cloudflared.sh`. `expense-tax-cloudflare.yml:9-10` has path
  filters. These are expense files, so the rename lands **with 0001b-2**. Until then, 0001b-1
  keeps `infrastructure/vps/bootstrap-cloudflared.sh` and `infrastructure/vps/test-bootstrap.sh`
  as a **one-line wrapper** that `exec`s the new path. 0001b-2 deletes the wrapper. It is the only
  transitional shim.

### Behavior changes (small, each with a test)

1. **Host-target selection** in `ai-trading-deploy.yml`:
   - dispatch input `target: vps|laptop` (push default `vps` until cutover);
   - the Firestore group (`shared/vps` or `shared/laptop`) is read directly for host, port, user,
     key and known hosts, replacing the `ai-trading/deploy` link indirection for SSH. The
     `ai-trading/deploy` profile keeps rendering whatever else it carries;
   - when `target=laptop`, a pinned `tailscale/github-action` step joins the tailnet as `tag:ci`,
     with OAuth credentials from `shared/tailscale`, masked;
   - dispatch input `image_tag`: deploy an already-pushed GHCR tag and skip the build job. The
     dark deploys use it, and so does the cutover, so the freeze contains no build time.
2. **Dark mode:** dispatch input `dark: true`, which becomes `DEPLOY_DARK=1` for `deploy.sh`:
   - `cloudflared` and `scheduler` are left out of the selected services. The protected-set
     logic must allow this only in dark mode;
   - `health-check.sh` skips the `cloudflared:2000/ready` probe;
   - test: `test-deploy-firestore.sh` and `test-health-rollback.sh` gain dark-mode cases. A dark
     deploy never starts cloudflared or scheduler; a normal deploy still requires both.
3. **`install-reader-key.sh`:** add `--profile <group>` (default `shared/vps`) and
   `--keep-existing` (delete nothing). Rename the SA display name "(VPS)" to "(host)" in
   `gcp/family-config/bootstrap.sh`. Add a test: a small `bash -n` and argument-parsing check
   beside the script.
4. **Host steps:**
   - `05-power.sh` and `15-tailscale.sh` (new, 0001a Part 2);
   - `00-firewall.sh`: `ALLOW_HTTP=0` and `SSH_INTERFACE=tailscale0` options. Defaults keep VPS
     behavior;
   - `20-docker.sh`: data-root check.
5. **`30-postgres.sh` reconciled with live:**
   - write `name: postgres` into the generated compose, so the network is `postgres_default` no
     matter which directory is used;
   - pin the image by digest (taken from the VPS in 0001d step 0);
   - container `family-app-postgres` (Q6); keep the `postgres` alias; bind `127.0.0.1:5432`;
   - add a `--data-from-copy` mode that skips initdb and the role scripts when a copied data dir
     is present (0001e).
6. **`35-temporal.sh`** (new): stages `infrastructure/temporal/` to `/opt/family-app/temporal/`;
   renders `/etc/family-app/temporal.env` from `shared/temporal` (root, 0600); runs
   `compose up -d`; runs `bootstrap-namespaces.sh`. This replaces the hand runbook in
   `infrastructure/README.md:39-58`.
7. **`40-backup.sh`:** read the Postgres superuser password from Firestore `shared/vps-postgres`
   instead of `${SHARED_PG_DIR}/.env`, which does not exist in the live layout. Make
   `BACKUP_HOST_ID` a required argument.
8. **Operator script defaults:**
   - `infrastructure/backup/recovery-drill.sh` already defaults to `family-app-postgres`;
   - the expense `bootstrap-*-db.sh` defaults change in 0001b-2.
9. **`infrastructure/tailscale/`** (new Terraform root):
   - `tailscale` provider; backend `gs://tobytran-portfolio-tfstate` prefix `tailscale`;
   - `tailscale_acl` (tag owners `tag:family-host` and `tag:ci`; the two SSH rules);
   - `tailscale_tailnet_key` for the laptop (tagged, reusable=false, preauthorized);
   - an OAuth client resource **if the pinned provider version supports it**. Otherwise, the
     one-time console exception (Q3), with the values stored in `shared/tailscale`;
   - `ai-trading-infra.yml`'s PR job gains `infrastructure/tailscale` in its fmt/validate list.
   - Operator-applied (Q19).
10. **Optional (Q14):** `cloudflare_notification_policy` for tunnel health in
    `cloudflare/ai-trading` (CI plan on main, apply on dispatch, as today).

### Gates (0001b-1)

- [ ] `ai-trading-ci.yml` green: scripts job, shellcheck, compose config (with and without the
      local override), `desk-caddy-acceptance`
- [ ] `docker buildx bake -f ai-trading/deploy/docker-bake.hcl --load` then
      `ai-trading/deploy/ci/smoke-test.sh all` green (real Caddy, new Caddyfile path)
- [ ] `terraform validate` for `infrastructure/tailscale` (`init -backend=false`)
- [ ] **No-op production proof:** ai-trading deploys to the **VPS** from the moved paths
      (push to `main` with `target` defaulting to `vps`). `health-check.sh` passes; container
      set and image tags unchanged; `last-good-tag` advances
- [ ] `git grep -n "deploy/production" -- ai-trading .github` returns only the intended
      references (comments updated, no stale sources)

## 0001b-2: expense lane

### Moves

| From | To |
|---|---|
| `expense-tax-management/deploy/production/*` (2 compose files, `deploy.sh`, `health-check.sh`, `bootstrap-temporal-db.sh`, `bootstrap-mailbox-vault-db.sh`) | `infrastructure/apps/expense-tax/` |
| `expense-tax-management/infrastructure/gcp/expense-tax/*` | `infrastructure/gcp/expense-tax/` (also closes phase-0h's "no copy of infrastructure/ under expense-tax-management/") |

### Path fixes (pinned paths from the probe)

1. `test/integration/production-deployment-boundaries.test.ts`:
   - `:22-27,606`: deploy file list;
   - `:24`: temporal compose;
   - `:500,521-524`: workflow install and run strings. **The host path
     `/opt/expense-tax-management/app/` stays**;
   - `:530`: the GCP bootstrap path;
   - `:56-59`: `postgres_default` (unchanged).
2. `services/mailbox-broker/test/deploy-script.test.ts:25-27`.
3. `scripts/check-cloudflare-infrastructure.mjs`:
   - `:13-20`: GCP bootstrap paths;
   - `:21,74`: `infrastructure/host/bootstrap-cloudflared.sh`;
   - `:152`: "must not reference `expense-tax-management/deploy/production`" becomes "must not
     reference `infrastructure/apps/expense-tax`".
4. `package.json:29-30`: `../infrastructure/host/test-*.sh`.
5. `infrastructure/temporal/test-temporal-infrastructure.sh:67`: reads the expense
   `health-check.sh` at its new path.
6. (Retired 2026-10-31: `check-phase-1d-protected-development.mjs` is deleted with `expense-tax-ci.yml`, ADR-0013.)
7. `scripts/check-phase-1b-workflow.mjs`: manual check; repoint it.
8. `.github/workflows/expense-tax-deploy.yml`: push paths add `infrastructure/apps/expense-tax/**`.
9. `.github/workflows/expense-tax-deploy.yml`: sparse and scp sources.
10. `.github/workflows/expense-tax-cloudflare.yml:9-10,17-18`: the path filters.
11. `bootstrap-temporal-db.sh` and `bootstrap-mailbox-vault-db.sh` default
    `POSTGRES_CONTAINER=family-app-postgres` (Q6). Update the warning in
    `production-activation-runbook.md:320`.
12. Delete the `infrastructure/vps/` wrappers left by 0001b-1.

### Behavior changes

1. `expense-tax-deploy.yml`:
   - `workflow_dispatch` with `target: vps|laptop`, `dark`, and `image_tag` (reuse a pushed tag;
     skip the build);
   - the `target=laptop` path uses the Tailscale step with GitHub env secret copies
     `TS_CI_OAUTH_CLIENT_ID` and `TS_CI_OAUTH_CLIENT_SECRET`, plus a second set of copies for the laptop
     host (`LAPTOP_HOST`, `LAPTOP_PORT`, `LAPTOP_USER` vars; `LAPTOP_DEPLOY_SSH_KEY` and
     `LAPTOP_DEPLOY_KNOWN_HOSTS` secrets), set with `gh secret set` / `gh variable set` from
     `shared/laptop`. The VPS copies stay until 0001f.
   - **No `id-token`; the existing test still holds.**
2. `deploy.sh` dark mode (`DEPLOY_DARK=1`): `workflow-worker` is not started, so no Temporal
   workflow runs. Everything else comes up. The health check skips the worker's healthy check in
   dark mode only. Add tests in `production-deployment-boundaries.test.ts`.

### Gates (0001b-2)

- [ ] Expense `ci:test` green, including the moved infra tests and `check:cloudflare-infrastructure`
- [ ] **No-op production proof:** one expense deploy to the VPS from the moved paths (owner
      confirms the `main` release at execution time, per expense AGENTS.md); `health-check.sh`
      green; `deployed-image-tag` advances
- [ ] `git grep -n "expense-tax-management/deploy/production\|expense-tax-management/infrastructure"` returns only historical plan text

## Owner-gated items

- AGENTS.md amendments (orchestrator);
- the Tailscale OAuth client creation path (Q3);
- the expense `main` release confirmation;
- applying `infrastructure/tailscale/` (operator).

## Rollback

Each PR is a plain revert. Host layouts never change, so a revert plus one redeploy restores the
previous state. If a merged move breaks a parallel session's branch, that session re-applies its
edits at the new path. Do not revert the move for one branch.

## Delivered

- **0001b-1 delivered 2026-11-01 (PR #225, merged `eaecd77e`).** All moves (`infrastructure/vps/**` → `infrastructure/host/**`; the ai-trading production/deploy/render-env/test set → `infrastructure/apps/ai-trading/`), path fixes, and behavior changes (#2 dark mode/#3 reader-key/#4 host steps/#5 postgres reconcile/#6 temporal/#7 backup/#8 defaults) landed with two transitional `infrastructure/vps/` shims for expense-owned references.
- **Reconciled against #224** (merged `2180050c`) which removed `.github/workflows/ai-trading-ci.yml` (ADR-0013, CI is deployment-only) and added `infrastructure/tailscale/`. The #225 path fixes to the deleted CI file were dropped; `AGENTS.md`/`ai-trading/AGENTS.md`/`infrastructure/README.md` carry both sets. Local gates now replace the PR CI (test-deploy-firestore 81, health-rollback 9, render-env 14, host/test-steps 30, test-bootstrap 9, l6-desk 26; shellcheck + bash -n + compose config).
- **Tailscale parts of behavior change #1 and #9 are superseded by #224** — `infrastructure/tailscale/` (ACL as code, mint-authkey, run-terraform) exists; the `target=laptop` deploy join remains 0001c's job.
- **No-op VPS proof sequenced but not yet run:** `main` is ~866 commits behind `dev`, so the scoped release that proves the moved paths is batched with the next ai-trading release (to avoid carrying #222's unreleased 5S wave as a side effect). The Deploy workflow's `target` defaults to `vps`, so `gh workflow run ai-trading-deploy.yml --ref main -f deploy_app=true` after that release is the proof.
