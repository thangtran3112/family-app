# ADR-0008: Scoped releases, one PR per phase

Status: standing rule (owner, CI-minutes conservation). Sources: root + package AGENTS.md.

Decision: open a pull request **only when a phase is finished or a batch is meaningful**, never per small task. Stack routine commits on the lane branch and let them ride the next phase PR. Releases to `main` carry **only the completed phase's ai-trading paths** plus its app-specific workflow changes: `git rm -rq --cached ai-trading/` then `git checkout origin/dev -- ai-trading/`, with a scope guard that aborts on any out-of-scope path. Push to an open PR only when its CI fails; monitor CI and merge only when green; deploy only on push-to-`main` after verifying disk headroom. Never merge all of `dev` into `main`; never commit to or force-push `dev`/`main`. Owner's standing delivery authorization covers the routine commit/push/PR/merge/deploy of a requested phase once verification passes — routine steps need no further approval.

Consequences: phase PRs are the unit of delivery; releases are mechanical and auditable; parallel lanes reconcile scope in `STATUS.md` by renumbering, never by editing each other's rows.

Amended by [ADR-0013](ADR-0013-ci-deployment-only.md): ai-trading has no test CI any more, so "monitor CI and merge only when green" now means the remaining checks (infra validate) plus the local gates run before the PR. Expense-tax lost its test CI too (follow-up in ADR-0013).
