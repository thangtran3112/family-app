# family-app Agent Rules

Each package's rules live in its own `AGENTS.md` (see "Package rules"). This file covers the git checkout that all sessions share and the rules that apply everywhere.

## Shared Git Checkout

- Many coding sessions work in this repository at the same time, by design. Assume high parallelism and plan for it.
- **A git worktree is the default and required place for any coding change** (owner rule, 2026-10-31; supersedes the earlier "worktrees are opt-in"). This holds for every harness and every agent — Claude Code, OpenCode, Hermes, subagents, human operators — and for plans and documentation as much as for code. Create one worktree per task under `.worktrees/`, on its own `feature/*` branch, and do all edits, tests and commits there.
- **Every worktree branch starts at `origin/dev`.** Run `git fetch origin` and cut from `origin/dev` — never from `feature/toby`, never from another lane's branch, never from the main checkout's HEAD. `feature/toby` is the owner's own sync branch and carries other lanes' unpushed commits: a worktree cut from it silently inherits their work and blocks them.
- **The owner's local branch `feature/toby` belongs to the owner.** The main checkout stays on it and is where the owner syncs `origin/dev`; agents never switch it, edit files in it, merge into it, reset it, or push it.
- Deliver a finished worktree branch by pushing that branch and opening a pull request to `dev` (one PR per phase or meaningful batch). Then remove the worktree and delete the branch.
- Before any merge, stash, or reset in the main checkout, run `git status --short --branch`. Uncommitted or untracked files there belong to whichever other session left them: never stage, commit, stash, discard, or "clean up" them, and do not assume they are yours. If they block the merge, stop and tell the owner.
- A reset of `feature/toby` discards every session's commits that are not on `dev` yet. Agents never reset it; the owner does that.

## Package rules

Start a session inside the package you are changing. Each package's `AGENTS.md` governs that package only; where rules conflict, the package being edited wins. Never apply one app's branch, release, or deploy policy to another.

`infrastructure/apps/<app>/` belongs to `<app>` for release scoping and delivery. An ai-trading release may carry `infrastructure/apps/ai-trading/**`, and the expense rules govern `infrastructure/apps/expense-tax/**`. The shared roots under `infrastructure/` (`host/`, `gcp/`, `cloudflare/`, `backup/`, `temporal/`) belong to the infrastructure plans in `infrastructure/plans/`.

| Path | What | Rules |
|---|---|---|
| `ai-trading/` | Trading Hub (open-source apps) and the Family Desk | `ai-trading/AGENTS.md` |
| `expense-tax-management/` | Expense and tax apps | `expense-tax-management/AGENTS.md` |
| `infrastructure/` | Terraform, VPS bootstrap, shared compose, backups | `infrastructure/README.md` |
| `infrastructure/tailscale/` | Tailnet policy for CI/CD deploys and break-glass admin (operator SSH is Cloudflare Access) | `infrastructure/tailscale/README.md` |
| `common/config/` | Firestore `family-config` CLI | `common/config/README.md` |
| `docs/superpowers/` | Cross-app specs and plans | n/a |

## Rules and skills: shared at the root, package-specific in the package

`AGENTS.md` is the always-loaded baseline. Everything else is lazy-loaded from `.claude/`, one markdown file per area (`tailscale.md`, `deploy.md`, …), so it costs a session nothing until it is relevant.

- **Shared rules and skills live at the repository root**: `.claude/rules/*.md` and `.claude/skills/<name>/SKILL.md`. A rule or procedure that applies to more than one package belongs there and exists once. `.claude/rules/tailscale.md` and the `manage-family-tailscale` and `manage-cloudflare-tunnel` skills are the first of these. A package `AGENTS.md` keeps a pointer to it, not a copy.
- A `.claude/rules/` inside a package is only for that package's own rules. When a package gains one, it also needs the OpenCode wiring below; a package with no rules has no `opencode.json` glob.
- **Claude Code** loads `.claude/rules/*.md` natively: the ones in the working directory and above it at launch, and a subdirectory's own rules on demand. An optional `paths:` list in the frontmatter scopes a file to matching globs; omit it when the rule covers the whole component. Only `paths` is read, and the frontmatter is stripped before the rule enters context. Skills at the root are found from a package directory too; this is checked, not assumed.
- **OpenCode** has no native support for these paths: the root `opencode.json` lists `"instructions": ["AGENTS.md", ".claude/rules/*.md"]` once for the whole repository, and a package `opencode.json` lists its own `AGENTS.md` plus any package rule glob it has. OpenCode resolves the root config and the package config separately, so both apply from inside a package. A package that adds a rule without adding the glob will not load it in OpenCode.
- Put a rule in `AGENTS.md` when it applies to every session; put it in `.claude/rules/` when it applies to one area; make it a skill when it is a procedure with commands.
- **The laptop is reached passwordlessly, never by prompt.** Skill `laptop-access` is the only documented path to the family-app host: a valid key from Firestore, `ssh -o BatchMode=yes`, `sudo -n`. sshd has no password path and `sudo` without `-n` is a bug. No harness may ever ask the owner for this machine's password.

## Everywhere

- Public repo: never commit or print secrets, email addresses, account numbers, or VPS addresses.
- All secrets and env values live in Firestore `family-config`, read and written only through `common/config/family_config.py`. No `.env` or key files in the repo.
- Infrastructure is code under `infrastructure/`; no console edits. GCP commands use `CLOUDSDK_ACTIVE_CONFIG_NAME=personal`. One shared Cloudflare token (`shared/cloudflare`): never create another.
- The family-app tailnet is for CI/CD deployment only (the deploy runners join as `tag:ci`). Operator and admin SSH to the host goes through the Cloudflare tunnel behind Cloudflare Access: skill `manage-cloudflare-tunnel`. Tailnet details: skill `manage-family-tailscale`.
- The family-app tailnet is separate from any other tailnet the owner belongs to. Nothing in this repo may name, reference, or read another tailnet. Tailnet ID, MagicDNS names, device names, and IPs live in Firestore `shared/tailscale`, never in the repo.
- One shared VPS: touch only your own app's containers, images, and volumes; never run a global `docker system prune`.
- Never commit to or force-push `dev` or `main`; work reaches `dev` by pull request; `main` releases carry only the owning package's paths. Delivery authorization is per package.
- **Conserve GitHub Actions minutes (owner rule, 2026-10-10, revised 2026-10-31; every package):** the pipeline is deployment-only: no workflow runs unit, integration or E2E suites ([ADR-0013](ai-trading/decisions/adr/ADR-0013-ci-deployment-only.md)). `ai-trading` and `expense-tax-management` keep their suites as local gates the delivering session runs before it ships; `expense-tax-deploy.yml` fires on a push to `main`, with no test job in front of it. Open a pull request only when a phase is finished or a batch of work is meaningful on its own, never for a single small task or a docs fix. Stack commits on your task's worktree branch and let small changes ride along with the next phase's pull request. Push to an open pull request only when a check fails or the change needs it, because every push re-runs the workflows that remain.

## Parallel sessions

Stay inside your area, follow any plan another session has published in the repo, keep edits to shared files (such as `ai-trading/plans/STATUS.md`) small and additive, merge `origin/dev` before you push, and never stage or revert another session's changes.
