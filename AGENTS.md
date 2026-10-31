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

| Path | What | Rules |
|---|---|---|
| `ai-trading/` | Trading Hub (open-source apps) and the Family Desk | `ai-trading/AGENTS.md` |
| `expense-tax-management/` | Expense and tax apps | `expense-tax-management/AGENTS.md` |
| `infrastructure/` | Terraform, VPS bootstrap, shared compose, backups | `infrastructure/README.md` |
| `infrastructure/tailscale/` | Tailnet policy for admin and CI SSH | `infrastructure/tailscale/README.md` |
| `common/config/` | Firestore `family-config` CLI | `common/config/README.md` |
| `docs/superpowers/` | Cross-app specs and plans | n/a |

## Component rules are lazy-loaded from `.claude/rules/`

`AGENTS.md` is the always-loaded baseline. Rules that only matter in one component of the app live in that component's `.claude/rules/`, one markdown file per area (`tailscale.md`, `deploy.md`, …), so they cost a session nothing until they are relevant. Expect this directory to grow into the repository's rule library.

- **Claude Code** loads `.claude/rules/*.md` natively: the ones in the working directory and above it at launch, and a subdirectory's own rules on demand. An optional `paths:` list in the frontmatter scopes a file to matching globs; omit it when the rule covers the whole component. Only `paths` is read, and the frontmatter is stripped before the rule enters context.
- **OpenCode** has no native support for this path: each package lists the glob in the `instructions` array of its `opencode.json` (`"instructions": ["AGENTS.md", ".claude/rules/*.md"]`, beside any `.opencode/rules/*.rules` it already has). A package without an `opencode.json` will not load its rules in OpenCode, so add the file when you add the directory.
- The same rule applies to skills: `<package>/.claude/skills/<name>/SKILL.md` is discovered by both harnesses, so a procedure that outgrows a rule belongs there rather than in a longer rule file.
- Put a rule here in `AGENTS.md` when it applies to every session; put it in a component rule when it applies to one area, and add that component's rule file only to the component that needs it.

## Everywhere

- Public repo: never commit or print secrets, email addresses, account numbers, or VPS addresses.
- All secrets and env values live in Firestore `family-config`, read and written only through `common/config/family_config.py`. No `.env` or key files in the repo.
- Infrastructure is code under `infrastructure/`; no console edits. GCP commands use `CLOUDSDK_ACTIVE_CONFIG_NAME=personal`. One shared Cloudflare token (`shared/cloudflare`): never create another.
- The family-app tailnet is separate from any other tailnet the owner belongs to. Nothing in this repo may name, reference, or read another tailnet. Tailnet ID, MagicDNS names, device names, and IPs live in Firestore `shared/tailscale`, never in the repo.
- One shared VPS: touch only your own app's containers, images, and volumes; never run a global `docker system prune`.
- Never commit to or force-push `dev` or `main`; work reaches `dev` by pull request; `main` releases carry only the owning package's paths. Delivery authorization is per package.
- **Conserve GitHub Actions minutes (owner rule, 2026-10-10; every package):** open a pull request only when a phase is finished or a batch of work is meaningful on its own, never for a single small task or a docs fix. Stack commits on your task's worktree branch and let small changes ride along with the next phase's pull request. Push to an open pull request only when its CI fails, because every push re-runs CI.

## Parallel sessions

Stay inside your area, follow any plan another session has published in the repo, keep edits to shared files (such as `ai-trading/plans/STATUS.md`) small and additive, merge `origin/dev` before you push, and never stage or revert another session's changes.
