# Task 8: Ship Batch 1 (shared with sub-project 1)

Part of [01p-vibe-effort-picker-plan.md](../01p-vibe-effort-picker-plan.md). Read its Global Constraints first. **Prerequisite:** sub-project 1's plan ([01o-vibe-answer-integrity-plan.md](../01o-vibe-answer-integrity-plan.md)) is complete and its commits are already on the `family-app` branch of `ai-trading/packages/vibe-trading` in this same worktree (01n section 4: "Sub-projects 1 and 2 ship together — one fork commit set, one pull request, one deploy"). Tasks 1–7 of this plan are complete.

This batch also flips `LANGCHAIN_USE_RESPONSES_API=true` in production (01n section 4: "without it 3 of 6 simultaneous runs on a fresh server failed with the Sol `reasoning_effort` 400"). Confirm that Firestore value is set in `ai-trading/vibe-trading` before this task's deploy step — it is a prerequisite this plan depends on but does not itself set (not a code change; set it with `common/config/family_config.py set ai-trading/vibe-trading LANGCHAIN_USE_RESPONSES_API true` if it is not already there).

Everything below runs from the repository root unless a step says otherwise. `ai-trading/AGENTS.md`'s "Standing delivery authorization" covers this entire sequence: verify, merge to `dev`, release to `main`, deploy, verify live — without stopping for approval at any intermediate step.

**Owner-approved branch exception (2026-10-10):** open this batch's PR from the isolated `feature/vibe-evals` worktree branch directly to `dev`, not from `feature/toby`. The main checkout currently has unmerged Desk commits and unrelated working changes; merging this Vibe batch there would mix lanes and could stage someone else's work. This exception is for this scoped Vibe batch only; do not reset, rebase, stash or modify `feature/toby`.

**Files:**
- Modify: superproject gitlink `ai-trading/packages/vibe-trading`, `ai-trading/plans/STATUS.md` pin/status rows.
- PR and scoped release include the 01n/01o/01p design and implementation plan docs, 01o measured-results doc, and `ai-trading/tools/vibe-eval/` from Task 1 of 01o.
- No fork source changes here; prior tasks include all fork code and ledger entries.

**Interfaces:**
- Consumes: SP1 Task 10 results and SP2 Task 7 verified fork commit set.
- Produces: a reviewed PR to `dev`, a path-scoped release PR to `main`, a verified live deployment, and an updated pin table.

## Steps

- [ ] **Step 1: Verify the fork's full suites one more time against the final combined state (both sub-projects).**

```sh
(cd ai-trading/packages/vibe-trading/agent && "$VENV/bin/python" -m pytest tests -q -n 8)
```

Expected: matches the numbers Task 7 recorded, now also covering sub-project 1's changes (if 01o's own plan left different real numbers, that is expected — record what you see here, not what Task 7 saw).

```sh
(cd ai-trading/packages/vibe-trading/frontend && npx tsc -b && npx vitest run && npm run build)
```

Expected: clean/pass/succeeds.

- [ ] **Step 2: Push the fork branch to its own remote, before the superproject's gitlink moves.**

```sh
git -C ai-trading/packages/vibe-trading remote -v   # origin must be the fork, not upstream
git -C ai-trading/packages/vibe-trading push origin family-app
```

- [ ] **Step 3: Build the image and smoke-test it.**

From the repository root:

```sh
docker buildx bake -f ai-trading/deploy/docker-bake.hcl vibe-trading --load
ai-trading/deploy/ci/smoke-test.sh vibe-trading
```

Expected: both succeed (the same two commands `ai-trading/AGENTS.md`'s "Verification" section requires after any `packages/vibe-trading` change).

- [ ] **Step 4: Move the gitlink in the superproject and update the pin table.**

```sh
cd /Users/tobytran/personal/family-app/.worktrees/vibe-evals
git add ai-trading/packages/vibe-trading
git status --short  # confirm only the gitlink changed
```

In `ai-trading/plans/STATUS.md`, find the pin table row:

```
| Vibe-Trading | `packages/vibe-trading` | `d7d09115d110` (fork `family-app`, based on upstream `251b094320c1`) | MIT + NOTICE | Small fork, see `packages/vibe-trading/DIVERGENCE.md`; own hostname; options math, IBKR connector, and Telegram pattern adapted into the Desk |
```

Replace **only** that stale pin with the SHA of the pushed fork commit; abort if the row changed under you. The row was already stale before this batch (the last upstream sync pinned `d402c2df`):

```sh
python3 - <<'PY'
from pathlib import Path
import subprocess

pin = subprocess.check_output(["git", "-C", "ai-trading/packages/vibe-trading", "rev-parse", "--short", "HEAD"], text=True).strip()
path = Path("ai-trading/plans/STATUS.md")
text = path.read_text()
old = "| Vibe-Trading | `packages/vibe-trading` | `d7d09115d110`"
assert text.count(old) == 1, "Vibe pin row changed; reconcile instead of overwriting"
path.write_text(text.replace(old, f"| Vibe-Trading | `packages/vibe-trading` | `{pin}`"))
PY
```

Update row 3C's status cell (find the row starting `| 3C |`) from "awaiting owner review and execution method" to "Batch 1 implementation verified locally; awaiting dev PR, scoped release and live verification". Do not call it shipped before the production check. Step 10 records the PR numbers after production verification.

- [ ] **Step 5: Commit the superproject changes on this worktree's branch.**

```sh
git add ai-trading/packages/vibe-trading ai-trading/plans/STATUS.md
git commit -m "chore(ai-trading): pin Vibe-Trading to the reasoning-effort + answer-integrity batch"
```

- [ ] **Step 6: Open the pull request to `dev`.**

```sh
git fetch origin
git merge origin/dev    # required by ai-trading/AGENTS.md before pushing; never reset/rebase this work
git push origin feature/vibe-evals
gh pr create --base dev --head feature/vibe-evals \
  --title "Vibe-Trading: answer integrity + per-chat reasoning effort (01o + 01p)" \
  --body "Sub-project 1 (01o): flags unverifiable figures instead of cutting/replacing them; repairs the figure checker's deterministic false rejections. Sub-project 2 (01p): per-chat reasoning-effort picker, validated per model, applied to committee runs; honest effort probe with a 10-minute cache. One fork commit set (see packages/vibe-trading/DIVERGENCE.md), one deploy. Also flips LANGCHAIN_USE_RESPONSES_API=true in production Firestore (prerequisite, not in this diff)."
```

Wait for the required check (`Contracts, services, workers, frontends` per the trading-hub handoff's recipe) and merge:

```sh
DEV_PR=$(gh pr view feature/vibe-evals --json number --jq .number)
gh pr checks "$DEV_PR" --watch
gh pr merge "$DEV_PR" --merge --match-head-commit "$(gh pr view "$DEV_PR" --json headRefOid --jq .headRefOid)"
```

If the PR falls behind `dev` while CI runs, `gh pr update-branch` first (re-runs CI once; this is the "push to an open PR only when its CI fails" exception — a rebase-behind is a CI-blocking state, not a routine push).

- [ ] **Step 7: Scoped release to `main`.**

Recreate `build-release.sh` from `ai-trading/plans/handoffs/2026-10-10-trading-hub-session.md` Appendix B in a temp directory (not committed to the repo):

```sh
T=/private/var/folders/_1/050mzm_167bd175pmv0rfhz40000gn/T/opencode
cat > "$T/build-release.sh" <<'SCRIPT'
#!/bin/sh
set -eu
branch=$1 title=$2; shift 2
git fetch -q origin dev main
idx=$(mktemp "$(dirname "$0")/release-index.XXXXXX"); export GIT_INDEX_FILE=$idx
trap 'rm -f "$idx"' EXIT
git read-tree origin/main
for p in "$@"; do
  entry=$(git ls-tree origin/dev -- "$p" | cut -f1)
  [ -n "$entry" ] || { echo "not on origin/dev: $p" >&2; exit 1; }
  git restore --source=origin/dev --staged -- "$p"
done
tree=$(git write-tree)
[ "$tree" != "$(git rev-parse 'origin/main^{tree}')" ] || { echo "no changes versus origin/main" >&2; exit 1; }
commit=$(git commit-tree "$tree" -p origin/main -m "$title")
git diff --stat origin/main "$commit"
git push -q origin "$commit:refs/heads/$branch"
SCRIPT
chmod +x "$T/build-release.sh"

"$T/build-release.sh" release/vibe-01o-01p "Vibe-Trading: answer integrity + per-chat reasoning effort" \
  ai-trading/packages/vibe-trading ai-trading/plans/STATUS.md ai-trading/plans/subplans/01n-vibe-research-quality.md \
  ai-trading/plans/subplans/01o-vibe-answer-integrity.md ai-trading/plans/subplans/01o-vibe-answer-integrity-plan.md \
  ai-trading/plans/subplans/01o-vibe-answer-integrity-tasks ai-trading/plans/subplans/01p-vibe-effort-picker.md \
  ai-trading/plans/subplans/01p-vibe-effort-picker-plan.md ai-trading/plans/subplans/01p-vibe-effort-picker-tasks \
  ai-trading/plans/subplans/01o-vibe-answer-integrity-results.md ai-trading/tools/vibe-eval
```

(List exactly the paths this batch touched — the fork gitlink, both plans, the measured results, `tools/vibe-eval/`, and `STATUS.md`. Omit any path this batch did not actually add. Step 7's `gh pr diff "$RELEASE_PR" --name-only` is the authoritative scoped-release check; `git diff origin/dev origin/main` would also show unrelated Desk work and is not suitable.)

The original handoff's `git update-index --cacheinfo` cannot stage a `040000` directory entry (the task directories and `tools/vibe-eval/` are directories). `git restore --source=origin/dev --staged -- "$p"` inside the throwaway index copies their tracked descendants (and a gitlink) without touching any worktree. Tested with a scratch index against the same three path shapes before shipping; still inspect the release PR's exact file list.

```sh
gh pr create --base main --head release/vibe-01o-01p \
  --title "Vibe-Trading: answer integrity + per-chat reasoning effort" \
  --body "Scoped release of the 01o/01p batch. See the dev PR for detail."
RELEASE_PR=$(gh pr view release/vibe-01o-01p --json number --jq .number)
gh pr diff "$RELEASE_PR" --name-only
```

The release PR historically has no required checks; inspect this exact file list against the scoped paths above, then read the actual diff before Step 8. Stop if an unrelated package appears. Do not treat "no checks reported" as CI evidence — the dev PR was the checked one.

- [ ] **Step 8: Check for active runs before the release merge that fires deploy.**

The push to `main` triggers `.github/workflows/ai-trading-deploy.yml` automatically and keeps MiroFish in its current state. A deploy restarts containers and kills in-flight runs (`ai-trading/AGENTS.md`). **Do not merge the release PR yet.** Use the read-only operator recipe in `ai-trading/plans/handoffs/2026-10-10-trading-hub-session.md` Appendix B to check the production Vibe container's persisted session attempts and swarm runs. Block the merge if any are pending/running, unreadable, or the check cannot connect; retry after they finish. This check is best-effort: until sub-project 5 adds deploy draining, a new run can start between the check and merge.

Build the one-off read-only helper in the approved temp directory (same SSH/known-host pattern as the handoff; never print credentials). From the repository root:

```sh
T=/private/var/folders/_1/050mzm_167bd175pmv0rfhz40000gn/T/opencode
cat > "$T/vps-run.py" <<'PY'
import os, pathlib, subprocess, sys, tempfile

key_file, script = sys.argv[1:3]
cli = str(pathlib.Path.cwd() / "common/config/family_config.py")
hosts = subprocess.run([cli, "get", "shared/vps", "VPS_SSH_KNOWN_HOSTS"], capture_output=True, text=True, check=True).stdout
with tempfile.NamedTemporaryFile("w", suffix=".known_hosts", delete=False) as f:
    f.write(hosts)
    known = f.name
try:
    r = subprocess.run(
        ["ssh", "-F", "/dev/null", "-i", key_file, "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes",
         "-o", "StrictHostKeyChecking=yes", "-o", "UserKnownHostsFile=" + known, "-p", os.environ["VPS_PORT"],
         os.environ["VPS_USER"] + "@" + os.environ["VPS_HOST"], "sudo -n sh -s"],
        input=pathlib.Path(script).read_text(), capture_output=True, text=True, timeout=900,
    )
    print(r.stdout)
    print(r.stderr, file=sys.stderr)
    sys.exit(r.returncode)
finally:
    pathlib.Path(known).unlink(missing_ok=True)
PY
cat > "$T/check-vibe-runs.sh" <<'SH'
set -eu
C=$(docker ps --filter label=com.docker.compose.project=ai-trading --filter label=com.docker.compose.service=vibe-trading --format '{{.Names}}' | head -1)
[ -n "$C" ] || { echo "no Vibe container found" >&2; exit 2; }
docker exec -i "$C" python - <<'PY'
import json, os, sys
from pathlib import Path

root = Path(os.environ.get("VIBE_TRADING_HOME") or Path.home() / ".vibe-trading")
if not (root / "sessions").is_dir():
    sys.exit("session store not found; active-run status unknown")
attempts = list(root.glob("sessions/*/attempts/*/attempt.json"))
swarms = list(root.glob("swarm/runs/*/run.json"))

def status(path):
    try:
        return json.loads(path.read_text(encoding="utf-8")).get("status")
    except (OSError, ValueError):
        return "unreadable"

active = {"pending", "running"}
pending_attempts = sum(status(p) in active for p in attempts)
pending_swarms = sum(status(p) in active for p in swarms)
unreadable = sum(status(p) == "unreadable" for p in attempts + swarms)
print(json.dumps({"attempts_inspected": len(attempts), "swarms_inspected": len(swarms),
                  "active_attempts": pending_attempts, "active_swarms": pending_swarms,
                  "unreadable": unreadable}))
if pending_attempts or pending_swarms or unreadable:
    sys.exit(2)
PY
SH
CLI="$PWD/common/config/family_config.py"
python3 "$CLI" run ai-trading/deploy -- python3 "$CLI" with-file shared/vps VPS_DEPLOY_SSH_PRIVATE_KEY -- python3 "$T/vps-run.py" '{}' "$T/check-vibe-runs.sh"
```

Expected: exit 0 and `"active_attempts": 0`, `"active_swarms": 0`, `"unreadable": 0`. **Any other result blocks the merge.** Re-run immediately before Step 9. The inner check was exercised against a sandboxed Vibe home with seven completed attempts (0 active); production needs the operator connection above.

- [ ] **Step 9: Merge only after Step 8 is clear, then watch the deploy and verify live.**

```sh
gh pr merge "$RELEASE_PR" --squash --match-head-commit "$(gh pr view "$RELEASE_PR" --json headRefOid --jq .headRefOid)"
MAIN_SHA=$(git ls-remote origin refs/heads/main | cut -f1)
DEPLOY_RUN=
for i in $(seq 1 60); do
  DEPLOY_RUN=$(gh run list --workflow ai-trading-deploy.yml --commit "$MAIN_SHA" --limit 1 --json databaseId --jq '.[0].databaseId // empty')
  [ -n "$DEPLOY_RUN" ] && break
  sleep 10
done
[ -n "$DEPLOY_RUN" ] || { echo "No deploy run found for $MAIN_SHA" >&2; exit 1; }
gh run watch "$DEPLOY_RUN" --exit-status
```

First check the signed-out public gate, then the container's own health. The public `/live` **currently returns 401 without a Clerk session** (verified 2026-10-10); expecting 200 from anonymous `curl` would mistake a working auth gate for a failed deploy.

```sh
curl -s -o /dev/null -w "%{http_code}\n" https://vibe-trading.tobytran.dev/live
cat > "$T/check-vibe-health.sh" <<'SH'
set -eu
C=$(docker ps --filter label=com.docker.compose.project=ai-trading --filter label=com.docker.compose.service=vibe-trading --format '{{.Names}}' | head -1)
[ -n "$C" ] || { echo "no Vibe container found" >&2; exit 2; }
docker inspect --format '{{.State.Health.Status}}' "$C"
[ "$(docker inspect --format '{{.State.Health.Status}}' "$C")" = healthy ]
SH
CLI="$PWD/common/config/family_config.py"
python3 "$CLI" run ai-trading/deploy -- python3 "$CLI" with-file shared/vps VPS_DEPLOY_SSH_PRIVATE_KEY -- python3 "$T/vps-run.py" '{}' "$T/check-vibe-health.sh"
```

Expected: `401` for the anonymous public request and `healthy` from the container's Docker health check. Through a **signed-in** `agent-browser` session (the global OpenCode `~/.config/opencode/AGENTS.md` browser rule; never the owner's personal Chrome), confirm `/live` returns 200, Vibe-Trading loads, the reasoning-effort picker shows in the chat bar, a real message at a non-default level completes and reports that level, and a refused level shows the expected error without breaking the composer. Repeat Task 7's Step 10 browser checklist against production if it was only run locally before.

- [ ] **Step 10: Finish `STATUS.md`'s row 3C.**

Back in the worktree on `feature/vibe-evals` (already merged to `dev` and `main` by this point — this is a small follow-up doc edit, not a re-release; fold it into whatever the next ai-trading PR is per "Conserve GitHub Actions minutes", or open a tiny docs-only PR if none is imminent), fill in the PR number you deferred in Step 4 and mark the row done once production verification (Step 9) is complete.

- [ ] **Step 11: Report.**

Summarize for the owner: the two merged PR numbers (dev, main), the deployed image tag, the live verification results from Step 9, and point at `packages/vibe-trading/DIVERGENCE.md`'s new Verification section (Task 7) for the full evidence trail.
