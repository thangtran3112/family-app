# TradingAgents progress feedback delivered

## Live release

- Dashboard: https://tradingagents.tobytran.dev/research
- Dev PR [#112](https://github.com/thangtran3112/family-app/pull/112) merged as `57e130dcc705a6616ea67987be08bdb00973a310`.
- Scoped Main PR [#114](https://github.com/thangtran3112/family-app/pull/114) merged as `e17e6b4bd6a56ed6fb88c65244b98484b830c8e1`; only ten TradingAgents wrapper files changed. The newer Vibe release on Main was preserved. No Desk/expense paths, upstream source/pin, infrastructure, or secret/profile changes.
- Release CI [38164651273](https://github.com/thangtran3112/family-app/actions/runs/38164651273) passed at the exact release head. Production deploy [38168169652](https://github.com/thangtran3112/family-app/actions/runs/38168169652) succeeded at the Main merge SHA.
- Read-only VPS checks confirmed that release tag, healthy owned services, six deployed source hashes matching the reviewed files, and MiroFish still enabled. No activation/stop dispatch or Hub/MiroFish static upload was needed: research assets ship in the wrapper image.

## User-visible behavior

- Authenticated status polling remains every **3 seconds**. A real worker heartbeat runs every **5 seconds**, including while upstream model/tool calls wait.
- Heartbeat and completed research activity have separate timestamps. The UI shows elapsed time, phase, last activity, and heartbeat age; terminal elapsed time freezes at a recorded end timestamp, not a later sharing update.
- **20 seconds** without a heartbeat warns that liveness is unconfirmed. **3 minutes** without research activity warns that a step may be slow/stalled. Neither warning marks the task failed, kills it, or starts another research.
- A Hermes-inspired moving rainbow border marks healthy running work. Warning/disconnection/error/terminal states stop it; reduced-motion users get no rainbow animation or native animated progress bar.
- Read failures, malformed replies, and response bodies stalled beyond **10 seconds** preserve the last authorized snapshot and retry status reads. Authorization-denial headers clear private content immediately, without waiting for a stalled error body. Mutations are never automatically retried.
- Safe failure explanations retain saved analysis. If research fails after producing output, the UI shows error finalization while partial downloads are prepared, then records Failed after publication so polling cannot stop just before downloads become ready.
- Old records migrate additively. Unknown historical monitoring/end times remain null; no activity or duration is invented. Upstream remains unmodified; compatibility details live in `tradingagents-web/DIVERGENCE.md`.

## Verification

- **133 backend tests**, **14 native UI tests**, Ruff/diff hygiene, **133 in-image tests** with startup health 200, and **125 real-Caddy smoke checks** passed. Exact release CI also passed its image/gateway, script, Compose, and Hub-build checks.
- Independent full-range, adversarial, partial-export-fix, and transport-fix reviews completed with no unresolved Critical/Important finding. Documentation audit was current with zero blockers and exact source/doc hashes. Optional outside Codex review was unavailable, not represented as completed.
- Actual offline browser checks exercise the real assets, worker/SQLite tests, and a real local HTTP server with unfinished response bodies: heartbeat/progress separation, thresholds, focus, clock skew, malformed responses, reconnect without mutations, denial clearing, partial downloads, root/prefix/mobile layouts, and reduced motion. This browser check is runnable but opt-in, not an installed CI dependency; no coverage percentage is invented.
- One actual sponsored-provider AAPL/market/depth-1 research completed in **1m 38s**, private, with market/final reports, ready exports, no error/partial flag, and a persisted end time. Four distinct live heartbeats were observed; heartbeat advanced while research activity stayed unchanged. Metrics and the rainbow border updated, then elapsed time and animation stopped on completion.
- Browser-only disconnection retained the same task and saved analysis, showed a warning, stopped animation, recovered, and submitted **zero new research requests**. Live reduced-motion mode stopped both animations. No worker or provider failure was injected.
- Closing/reopening the private URL retained monitoring/results. Dedicated and `/u/tradingagents/research` routes rendered completed monitoring. Anonymous credential-omitted requests with a forged identity header returned **401** on both API deployments.
- All three authorized download GETs returned attachment responses: Markdown **24,928 bytes**, HTML **55,320 bytes**, ZIP **39,030 bytes**. This follow-up checked response bytes, not a new browser-saved file; actual file-save evidence remains in the original [dashboard delivery receipt](2026-10-11-trading-hub-01n-research.md).
- Observed JavaScript uncaught errors/unhandled rejections: **0/0**. The reviewed task's public-safe screenshot contains only the progress panel, not reports, identifiers, or identity.

## Limits and handoff

- The live verification run finished before the three-minute no-activity threshold. Slow/dead/error cases are proven by worker/SQLite and offline browser/HTTP regression checks, not claimed as naturally observed live failures.
- One research at a time and explicit historical-import ownership/source assignments remain unchanged. No token/log stream, artificial percentage, automatic rerun/cancellation, or timeout-based termination was added.
- Deferred nonblocking items: CI automation of the opt-in DOM check; bounded heartbeat-thread shutdown latency; minor Interrupted/exporting wording if the operator stops a worker during partial publication; HTTP-Date freshness remains an advisory estimate. The live focus sample crossed a real output update, so heartbeat-only focus retention is cited from the offline check, not that sample.
- Preserve the owner's TradingAgents/Vibe submodule work and untracked `opencode.jsonc`. Never reset, deinitialize, or include them in this phase's commits. Receipt/tracker-only changes ride the next meaningful phase PR; no standalone bookkeeping CI/release.
- Detailed safe evidence is preserved outside the repository in the phase's protected execution scratch. Private IDs/URLs, report bodies, identities, credentials, and VPS addresses are intentionally absent here.
