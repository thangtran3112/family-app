# Vibe US-stock committee gate: verification record

**Date:** 2026-10-12 · **Status:** pre-release verification in progress; not a production receipt. [Design](01r-vibe-committee-gate-design.md) · [plan](01r-vibe-committee-gate-plan.md) · [SP3 baseline](01q-vibe-golden-eval-results.md).

## Safety contract exercised

- A US-stock own Buy/Sell or target requires one completed, substantively approved committee run for the locked ticker, a matching parent run and reviewed task IDs, and fresh independent Yahoo/Finnhub counts. A completed swarm whose chair says `INCOMPLETE — ANALYSIS ONLY` cannot authorize it.
- An own numeric 12-month target additionally requires a filed SEC diluted-EPS fact, the Yahoo quote's **source** time and USD venue/share basis, checked split history, stated growth/multiple and confidence range. The server computes and renders the target; a claimed $999 against a computed $201.42 is withheld.
- US-stock drafts, reasoning tails, tool previews, swarm reports, trace sidecars, grounding-check prose and reconnect checkpoints are quarantined until release. Progress-only tool/stage events remain; an inherited HTTP proxy cannot receive the bridge's internal auth header.
- Server-owned automatic committee runs live in a private store subtree, not the public swarm list/detail/events API; manually started swarms keep their existing public behavior.
- The private Python 3.12 bridge is a Vibe-group service, health-checkable without a Finnhub key. Optional key profile is `ai-trading/consensus`, never the Vibe/market-data env. Group-off deploys do not revive either Vibe service; rollback restores or removes the staged file.

## Local offline evidence

| Check | Observed |
|---|---|
| Shared provider type and adapters | 175 passing; Ruff clean |
| Bridge contract | 12 passing; image health 200, unauthorized 401, missing-key 503 |
| Family Desk backend against the additive shared type | 660 passing, 107 skipped; Ruff clean |
| Family Desk contracts and hub frontend | TypeScript clean; contracts 47/47, hub 109/109 |
| Fork backend at `a48f695` | 17,610 passing, 77 skipped; 24 upstream/library warnings |
| Fork frontend | TypeScript clean; Vitest 770/770; production build succeeded |
| Deploy rollback and app controls | 56/56 render/rollback cases, 16/16 app-control shell cases, 13/13 installer cases, 120/120 control unit tests |
| Full images/Caddy/Clerk | Docker Bake loaded all default images at fork `a48f695`; full real-Caddy smoke passed. MiroFish static export built separately |
| CI/config and evaluation tooling | `actionlint` clean; ShellCheck 0.9 with `-x` clean; Compose private-network/no-port check passed; golden tooling 51/51 |
| Bridge footprint | 67.5 MiB local image; 54.46 MiB idle container memory (`--network none --read-only`) |

Targeted RED→GREEN tests cover source month versus fetch time (45-day bound), unsupported/zero counts, forged and incomplete chair/run IDs, split/share mismatch, stale source quote after a fresh fetch, a false-positive classifier around mixed analyst/own advice, invented figures during rewrite, direct swarm callback leaks, cancelled and late events, duplicate model-triggered swarm calls, restart checkpoint recovery, the parent watchdog's bounded committee wait, implicit company/analyst questions, and a raw chair report's public swarm-route bypass.

## Real-model and browser evidence

The first local `gpt-6.1-sol` / `xhigh` pass used an earlier fork process. R07 completed in 1,472s without an own rating or target; F17 failed after 2,313s when the parent stall watchdog raced the committee's 1,800s wait. That failure motivated fork `488b429`; those runs **do not certify the final code**. The local browser showed F17's tool-stage progress without draft text, and sampled SSE replay contained no reasoning tail, tool preview or raw swarm report.

An isolated Sol server started F17 and R07 at `xhigh` from fork `eaf179a`; their terminal outcomes and post-reload history remain **pending**. The later `a48f695` change only broadens buffering for implicit company questions, not these explicitly US-stock cases. No model winner is declared: SP3's two calibration disagreements still require human adjudication. The `ai-trading/consensus` Firestore profile is absent, so live Finnhub corroboration and any own verdict/target are unavailable; the approved positive path is verified only with offline fake-source fixtures, **not** a live free Finnhub call.

## Delivery state

Fork commits and superproject implementation are local in the isolated worktree. Fork push, gitlink update, finished-phase `dev` PR, scoped `main` release, VPS deploy, CI and production browser verification have not yet happened. SP5 deploy-safe recovery remains a separate phase.
