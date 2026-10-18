# Handoff: GCP project `tobytran-portfolio` compliance after the abuse suspension

**Date:** 2026-10-18
**From:** main-checkout session that investigated the suspension (read-only; nothing in GCP or GitHub was changed)
**For:** the family-app coding session that continues this work
**Files here:**
- `README.md` — this summary, the decisions the owner must make, and the order of work
- `01-evidence.md` — everything found, with the commands to reproduce it
- `02-remediation-plan.md` — the phased plan with commands

> This repo is public. Nothing here is a secret. It names no email, billing account, IP address, or VPS address. Key IDs are shortened to 8 characters. Keep it that way when you edit these files.

## What happened

- Google suspended `tobytran-portfolio` for "abusive activity consistent with hijacking" and said a service account key or API key was probably published.
- The owner appealed. Google **reinstated** the project on 2026-10-18 (Cloud Logging event `abuse_events`: `action: REINSTATE`, `detectionType: NO_ABUSE`). The notice still says to fix outstanding issues, so a repeat suspension is possible.
- While suspended, every service account was disabled and `family-config` (Firestore) was unreachable. All 11 service accounts are enabled again.

## What we know

- **Root cause is not proven.** No leaked credential was found in any repo, in git history, in GitHub secret scanning for this project's keys, or in the local hermes/OpenCode files.
- **No abuse is visible in the retained logs.** Admin-activity logs reach back to project creation (2026-06-14). They show no Compute Engine activity ever, no principal other than the owner, Google-managed agents, `ci-deployer` (normal Terraform and Functions deploys, June to July), and the `ai-trading-*` deploy accounts (Workload Identity). There are no VMs now.
- **Gemini keys are cleared.** Both are unused for 28 days per AI Studio (the owner's screenshot).
- **The weakest credential is `ci-deployer`.** It has `roles/owner`, its key is the `GCP_SA_KEY` secret of the **public** repo `personal-portfolio`, the workflows run on `push` only, and there are no forks. It has not been used since July.

## Decisions the owner must make (the plan assumes the recommended answer)

| # | Decision | Recommended |
|---|---|---|
| 1 | Delete the `ci-deployer` key now, before Workload Identity is ready? The Firebase site keeps serving; only deploys pause. | Yes, now |
| 2 | Replace the key with Workload Identity Federation (same pattern as `infrastructure/gcp/ai-trading/main.tf`), and drop `roles/owner`? | Yes |
| 3 | Move `family-config` Firestore out of the portfolio project into a dedicated project, so a suspension of the public site cannot lock every family app? | Yes, as a separate later phase; `FAMILY_CONFIG_PROJECT` already allows it |
| 4 | Delete the unused `gemini-deerflow` key, and delete or restrict `OpenCode and Archer`? | Delete both unless something uses them |

## Order of work

1. Phase 0: verify `family-app` still works after reinstatement (`02-remediation-plan.md`).
2. Phase 1: delete the `ci-deployer` key and the `GCP_SA_KEY` secret (decision 1).
3. Phase 2: build Workload Identity for `personal-portfolio`, cut over, remove `roles/owner` (decision 2).
4. Phase 3: rotate the `family-config-reader` key.
5. Phase 4: hygiene (API keys, firewall, default service account roles, budget alert).
6. Phase 5: decide on moving `family-config` to its own project (decision 3).

## Rules that apply to this work

- `AGENTS.md` (repo root): GCP commands use `CLOUDSDK_ACTIVE_CONFIG_NAME=personal`. Infrastructure is code; no console edits. Touch only your own app's resources on the VPS. Never print secrets.
- `personal-portfolio` is a **separate repo** (`~/personal/personal-portfolio`, branch `main`, public, deploys on every push). Its changes need a session there, and a push to `main` runs a real deploy. The family-app PR rules (open a PR only for a finished phase) apply to family-app, not to that repo.
- Never print or log a key string. Compare by key ID or by hash.

## Not done and not verified

- Whether the suspension came from a real leak or a false positive. The Google emails (not readable by Gmail MCP in the session) may name the credential.
- Billing: the owner could not open Billing while suspended. Now that the project is back, check Reports grouped by SKU for September and October.
- Whether anything else uses the `ci-deployer` key (other repos, other machines). Phase 1 has the check.
- Whether `family-app` deploys and the VPS config reads work again. Phase 0 has the check.
