# family-app Agent Rules

Each package's rules live in its own `AGENTS.md` (see "Package rules"). This file covers the git checkout that all sessions share and the rules that apply everywhere.

## Shared Git Checkout

- Many coding sessions work in this repository at the same time, by design. Assume high parallelism and plan for it.
- **A git worktree is the default and required place for any coding change** (owner rule, 2026-10-31; supersedes the earlier "worktrees are opt-in"). This holds for every harness and every agent — Claude Code, OpenCode, Hermes, subagents, human operators — and for plans and documentation as much as for code. Create one worktree per task under `.worktrees/`, on its own `feature/*` branch cut from the latest `origin/dev` (`git fetch origin` first), and do all edits, tests and commits there.
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
