# Handoff: point `packages/vibe-trading` at HKUDS upstream (the fork was deleted)

**Date:** 2026-10-18
**From:** main-checkout session (GCP suspension follow-up). It found this while trying to merge PR #146 and changed nothing about the submodules.
**For:** the ai-trading coding session
**Blocks:** PR #146 (`feature/toby` into `dev`): its CI job "Images and smoke tests" fails at checkout until this is fixed. This handoff covers every remaining step to merge it (see "Remaining steps to merge PR #146").

## Owner decisions (2026-10-18)

- The owner **deleted** `thangtran3112/Vibe-Trading` on purpose. It must not come back.
- Every submodule under `ai-trading/packages/` must point at the **original author's** GitHub repo. Any fork in the owner's account is deleted by the owner, not by us.
- For Vibe-Trading the owner chose: **point at `https://github.com/HKUDS/Vibe-Trading.git` and drop the family-app patches.** Do not recreate the fork.
- The ai-trading session owns the submodule work. The main-checkout session does not touch `.gitmodules`, the gitlinks, or the submodule checkouts.

## What the audit found

| Package | `.gitmodules` URL | Original author? | Pin | State vs upstream default branch (GitHub compare, 2026-10-18) | Action |
|---|---|---|---|---|---|
| `trading-agents` | `TauricResearch/TradingAgents` | yes | `1394a3f7` | an ancestor of `main`; `main` is 11 commits ahead | none (normal drift; the sync skill moves it) |
| `ai-hedge-fund` | `virattt/ai-hedge-fund` | yes | `78b779c1` | identical to `main` | none |
| `mirofish` | `666ghj/MiroFish` | yes | `7657031a` | identical to `main` | none |
| `vibe-trading` | `thangtran3112/Vibe-Trading` | **no, a deleted fork** | `8be01c8f` | diverged: fork-only commits, not on upstream | **fix (this handoff)** |

- `ai-trading/packages/family-desk` is a normal directory (our own code), not a submodule.
- GitHub forks left in the owner's account: `public-apis` and `fire-detection-from-images`. Neither is in this repo; the owner deletes them.
- The fork is gone for real: `git ls-remote https://github.com/thangtran3112/Vibe-Trading.git` returns "Repository not found", also with the owner's admin token. CI worked on 2026-10-13 and broke after the deletion.

## The failure in PR #146

CI job "Images and smoke tests" (`ai-trading-ci.yml`, `actions/checkout` with `submodules: recursive`):

```
fatal: repository 'https://github.com/thangtran3112/Vibe-Trading.git/' not found
fatal: clone of 'https://github.com/thangtran3112/Vibe-Trading.git' into submodule path '.../ai-trading/packages/vibe-trading' failed
```

Nothing in PR #146 changed `.gitmodules` or the Vibe pin; both are identical on `dev`. The other checks passed or were still running except "Desk contracts and backend", which failed on `ruff format --check`. That one is fixed in local commit `7dcce9a` (see "PR #146 state").

## What the fork carried (what is lost)

Fork-only content on branch `family-app` (pin `8be01c8f`): about 50 commits by `git rev-list` against upstream `main` (GitHub's compare says 141, counting merges), 390 files changed, +24k and -5k lines. From `DIVERGENCE.md` and the commit subjects:

- Settings loads reasoning efforts per model (live probe) and refuses ones the model rejects; default OpenAI model `gpt-6.1-sol`; temperature, QVeris and Tushare/Gildata/BaoStock credentials removed from Settings.
- A research "committee" runner and grounding checks (buy-and-hold benchmark wording, grounded-release stages, committee decision markup rejection, quote-time targets, swarm-run isolation), with tests.
- Lock-file and `pyproject.toml` changes.

Upstream Vibe-Trading has none of this. After the change, the Settings page can offer a reasoning effort the model rejects. `deploy/upstream/vibe-trading/start-vibe.py` already drops a rejected level at boot, so a saved bad value is caught at start, not in Settings.

## Backup of the fork history

The deleted fork's history now exists **only on this laptop**. Keep it.

- Bundle: `~/vibe-trading-family-app-8be01c8.bundle` (58 MB, `git bundle verify` passed, full history, ref `refs/backup/family-app-8be01c8` pointing at the pin `8be01c8f`).
- The same ref exists in the submodule's git directory (`ai-trading/packages/vibe-trading`, via `.git/modules/...`), so garbage collection keeps those objects too.
- Restore later: `git fetch ~/vibe-trading-family-app-8be01c8.bundle refs/backup/family-app-8be01c8:refs/heads/family-app` inside any Vibe-Trading clone.
- The local submodule checkout is at `d402c2df` (an older fork commit, detached, clean). Its `origin` is still the deleted fork URL.

## Choosing the new pin

- `.gitmodules` URL: `https://github.com/HKUDS/Vibe-Trading.git`.
- **Recommended pin: `251b094320c1f97d1486626d3618113526914d4c`** (upstream, 2026-10-04). It is the commit the fork was first based on, the wrapper was written against it, and GitHub confirms it is an ancestor of upstream `main` (main is 463 commits ahead), so a depth-1 submodule fetch can reach it.
- Do **not** reuse `8e430079` (the upstream point the fork last synced to): GitHub reports it as *diverged* from `main`, so it is not reachable from upstream's current history.
- Upstream `main` tip at time of writing: `c546e877` (2026-10-18). A newer pin may need lock-file and wrapper updates. Bump later through the `sync-vibe-trading` skill, not now.
- Before committing the pin, check reachability the way CI does:
  `gh api repos/HKUDS/Vibe-Trading/compare/<sha>...main --jq .status` should print `ahead` or `identical`.

## Steps for the ai-trading session

Work in the main checkout on `feature/toby` (see root `AGENTS.md`). Run `git status --short --branch` first; stage exact paths only.

1. Edit `.gitmodules`: set the `vibe-trading` URL to the HKUDS URL.
2. `git submodule sync -- ai-trading/packages/vibe-trading` (updates the submodule's local `origin`).
3. In `ai-trading/packages/vibe-trading`: `git checkout --detach 251b094320c1f97d1486626d3618113526914d4c`. Its working tree is clean and the objects are already there. Do not stash, reset or delete anything in it; the backup above is the only copy of the fork.
4. Stage only `.gitmodules` and the `ai-trading/packages/vibe-trading` gitlink. Other submodule entries (`trading-agents`, `ai-hedge-fund`) may show as modified from other sessions; leave them alone.
5. Update the docs that describe the fork:
   - `ai-trading/AGENTS.md`: line 7 ("Vibe-Trading is a small family-app fork"), line 63 (add `packages/vibe-trading` to the never-edit list), line 64 (the fork rule: remove it), and the sentence "Vibe's source differs from upstream only as listed in its `DIVERGENCE.md`; the other three stay unmodified" (all four are unmodified now). Revisit the `gpt-6.1-sol` and reasoning-effort sentences: they describe fork behavior.
   - `ai-trading/plans/STATUS.md`: add a decision row for this change and mark the 2026-10-10 fork rows as superseded. Leave the old rows as history.
   - `.opencode/skills/sync-vibe-trading/SKILL.md`, `.opencode/skills/sync-ai-hedge-fund/SKILL.md` and `.github/dependabot.yml`: they refer to the fork or `DIVERGENCE.md`. Align them with the three other sync skills (upstream-only, no patch branch).
   - Old subplans (`01f`, `01j`, `01n`, `01o`, `01p`, `01r`) mention the fork; leave them as history.
6. Review what depended on the patches (grep result, outside `packages/`): `ai-trading/tools/vibe-eval/*`, `ai-trading/deploy/ci/smoke-test.sh`, `ai-trading/deploy/upstream/vibe-trading/start-vibe.py`, `ai-trading/deploy/production/README.md`, `ai-trading/deploy/local/README.md`. Check whether smoke tests or evals assert fork-only behavior (per-model effort in Settings, committee runner, `gpt-6.1-sol` default) and adjust or drop those assertions. Also check that `requirements-anthropic.lock` still passes `pip check` against the chosen pin's locked packages (the fork changed `requirements-lock.txt`).
7. Verify locally what you can: `git submodule status`, and `git submodule update --init --depth=1 ai-trading/packages/vibe-trading` in a fresh clone or temp worktree to prove CI's checkout works.
8. Commit, push once, and watch CI. Fix failures from the smoke job (they are the real consequence of dropping the patches).

## Remaining steps to merge PR #146

You own the whole path from here to a merged PR. `plans/portolio-compliance/` (the `tobytran-portfolio` deployer fix) is handled by another session and is out of scope; its commit is already in this PR.

### State on 2026-10-18

- PR: https://github.com/thangtran3112/family-app/pull/146, base `dev`, head `feature/toby`. Remote head is `a204ebd9`.
- Local `feature/toby` is 4 commits ahead of `origin/feature/toby`: `7dcce9a` (ruff format fix), `0f680c0` (this handoff), and 2 commits from other sessions (one is `39224a4`, a merge of `origin/dev` after PR #145). `feature/toby` is 0 commits behind `origin/dev`.
- CI on the remote head:
  - Passing: `Contracts, services, workers, frontends`, `Deployment gate remains closed`, `Desk web app`, `Hub web app`, `Postgres, Temporal, cross-language, Docker`, `Scripts and compose`, `Scripts and shellcheck`, the Terraform validate jobs.
  - Failing: `Desk contracts and backend` (`ruff format --check`; fixed locally in `7dcce9a`, not pushed) and `Images and smoke tests` (deleted fork; fixed by the steps above).
  - Skipped: `Terraform plan`, `Terraform apply`, `Terraform plan/apply (ai-trading only)` (normal on a PR).
- Ruleset "Protect development" on `dev` (no bypass actors): changes must come by pull request (0 approvals needed); the only required status check is `Contracts, services, workers, frontends`; the branch must be up to date with `dev` (strict policy); no branch deletion, no non-fast-forward push. The repo allows merge, squash and rebase; auto-merge is off; branches are not auto-deleted.
- Because only one check is required, GitHub can show the PR as mergeable while the two jobs above are red. Merging that way would put a red CI on `dev`. Fix first, merge when all checks are green. Merge earlier only if the owner says so.

### Steps

1. **Preflight.** In the main checkout (`/Users/tobytran/personal/family-app`, branch `feature/toby`): `git status --short --branch`, `git fetch origin`, `git log origin/dev..feature/toby --oneline | head` (other sessions' commits are expected and ride along), `gh pr view 146 --json mergeable,mergeStateStatus`. Stage exact paths only; never stage, stash or discard another session's changes.
2. **Do the submodule work** from "Steps for the ai-trading session" above, in commits on `feature/toby`.
3. **Check locally before any push** (each push re-runs CI and costs Actions minutes):
   - `cd ai-trading/packages/family-desk/backend && uv run ruff check . && uv run ruff format --check .` (must pass; `7dcce9a` already fixes the 5 files).
   - A submodule checkout in a clean temp clone or worktree: `git submodule update --init --depth=1 ai-trading/packages/vibe-trading` must succeed.
   - Whatever of `ai-trading/deploy/ci/smoke-test.sh` and the Vibe tests you can run offline.
4. **Bring in `dev` if it moved** (the ruleset requires an up-to-date branch): `git rev-list --count feature/toby..origin/dev`; if above 0, `git merge origin/dev`, resolve conflicts, never rebase or force-push `feature/toby`.
5. **Push once, without force:** `git push origin feature/toby`. This is allowed on an open PR because CI failed. It also publishes `7dcce9a`, this handoff, and the other sessions' commits.
6. **Watch CI:** `gh pr checks 146 --watch`, or `gh run list --branch feature/toby --limit 6` then `gh run view <run-id> --log-failed`. Expect the real work here: the smoke job after the Vibe pin changes.
7. **If a check still fails**, classify it, fix, and batch the fixes into one push:
   - Submodule checkout error: URL or pin wrong; confirm with `gh api repos/HKUDS/Vibe-Trading/compare/<sha>...main --jq .status` (`ahead` or `identical`).
   - Smoke or eval assertion on fork-only behavior (per-model reasoning effort in Settings, committee runner, `gpt-6.1-sol` default): change or drop the assertion, and say so in the commit message.
   - Image build or `pip check` failure (`requirements-anthropic.lock` against upstream's locked packages): fix the wrapper under `ai-trading/deploy/upstream/vibe-trading/`, not the submodule.
   - Ruff format: run `uv run ruff format` on the listed files.
8. **Confirm mergeability:** `gh pr view 146 --json mergeable,mergeStateStatus -q '"\(.mergeable) \(.mergeStateStatus)"'` should be `MERGEABLE CLEAN`, and `gh pr checks 146` shows no `fail`.
9. **Merge:** `gh pr merge 146 --merge`. A merge commit matches this repo's history; do not squash a branch this size. No `--admin`: the ruleset has no bypass and the owner has not asked to override it. No `--delete-branch`: `feature/toby` is the long-lived branch.
10. **After the merge:** `git fetch origin && git merge origin/dev` on `feature/toby` (a fast-forward, since the merge commit has `feature/toby` as a parent). Check `git log origin/dev -3` shows the PR merge.
11. **Tell the other sessions and checkouts**: after a merge that moves `.gitmodules` or the Vibe pin, every other checkout and worktree runs `git submodule sync -- ai-trading/packages/vibe-trading` and then `git submodule update --init ai-trading/packages/vibe-trading` (root rule in `ai-trading/AGENTS.md`). Until they do, those checkouts still point at the deleted fork.
12. **Close out:** add a line to `ai-trading/plans/STATUS.md` (done as part of step 5 of the session steps), and note in this file that the PR merged, with the merge commit hash.

### Out of scope here

- Releasing to `main` (per-package release PR; `ai-trading-deploy.yml` and `expense-tax-deploy.yml` deploy on `main`). Dropping the Vibe patches changes what the next ai-trading release ships; that release needs its own smoke check and the owner's authorization.
- Never push to `dev` or `main` directly (the ruleset forbids it; a direct push was also blocked in this session).
- `~/vibe-trading-family-app-8be01c8.bundle` stays until the owner says otherwise.

## Not verified

- Whether upstream Vibe-Trading at `251b0943` builds and passes the hub smoke tests with the current wrapper. Not tried.
- How many of the fork's patches the owner still wants; the owner chose "drop all". If something matters later, restore from the bundle and carry it as a separate decision.
- Why upstream's history no longer contains `8e430079` (possible upstream rewrite). It does not affect the plan above.
