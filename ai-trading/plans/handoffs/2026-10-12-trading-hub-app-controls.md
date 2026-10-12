# Trading Hub app controls: delivered

## Live state

- Hub Settings: https://trading-hub.tobytran.dev/settings
- TradingAgents, AI Hedge Fund, Vibe-Trading and MiroFish remain enabled and Running. The existing running choices were adopted and persisted at revision 0.
- Final dev repair [#122](https://github.com/thangtran3112/family-app/pull/122) merged as `765a985edcd1ca44209763bb2cc233510caa1c71`; scoped main repair [#123](https://github.com/thangtran3112/family-app/pull/123) merged as live release `2536ebb6afe11835c7524e496ead756eae8e4415`.
- Backend build/smoke/deploy [38212222635](https://github.com/thangtran3112/family-app/actions/runs/38212222635) and Hub-static-only upload [38214556301](https://github.com/thangtran3112/family-app/actions/runs/38214556301) succeeded on that release. No Desk, common-provider or expense runtime paths were included in this phase's releases.

## Verification and limits

- All ten owned services run with their application health checks healthy. The systemd helper is active; gateway UID/GID is 22001; its private Unix socket is root:22001, mode 0660. The gateway peer succeeds; a root-UID client is rejected. No app container mounts the Docker socket.
- App volume names, creation timestamps, drivers and scopes are unchanged. Eleven unrelated containers retain their IDs, images and statuses.
- Live signed-in checks: ordinary terminal cookie 200; cookie-only control GET 401; forged trusted-actor header 401; fresh-bearer GET 200 with four Running groups; converged PUT 200 without operation/revision/container changes; wrong-Origin PUT 403 before credentials are inspected.
- Public Settings: 200, four checked switches, four Running statuses, no overflow or uncaught errors at 1440px and 375px, 44×44px switch targets. Dedicated TradingAgents research and AI Hedge Fund terminal navigation succeeds. Account is read-only; Escape closes and restores focus.
- Final covering checks include 120 Linux control, 85 auth, 109 frontend, 7 export, 54 Firestore and 28 lifecycle/installer cases, real-Caddy/helper integration, build/smoke, uploader checks, ShellCheck 0.9 and actionlint. All seven dev CI checks passed.
- Real production stop/start, reboot, sign-out and two-user conflict demonstrations were not performed. Isolated tests/browser fixtures cover their behavior; no literal StrictMode double-mount or live multi-user result is claimed.
- About 28.83 GiB remained after deployment. The unchanged 30 GiB pre-pull guard passed after normal scoped old-image pruning; no app data or unrelated resources were removed. Recurring backup/restore remains explicitly deferred for this temporary VPS.

## Deployment lessons

1. Docker `ps` formats `.Labels` as a string; use `.Label "com.docker.compose.service"`. The native regression reads the production formatter rather than duplicating it.
2. Production installs `deploy.sh` flat but stages the runtime library under `deploy/production/`. Load the incoming nested library; reject missing/nonregular/symlinked files before sourcing. Never preinstall active artifacts before their matched rollback snapshot.
3. Test the actual flat-installed driver and real staged library, not just a checkout-colocated source or a syntax-only stand-in.
4. Ubuntu's ShellCheck 0.9 flags exported callbacks that local 0.11 misses. Keep function-scoped annotations and verify the runner version.

## Remaining roadmap, not unfinished app controls

The Hub shell and app-controls plan are complete. The separate Vibe research-quality roadmap still contains human judge adjudication, committee-gated recommendations and deploy-safe long-run protection; see [01n](../subplans/01n-vibe-research-quality.md) and [01q results](../subplans/01q-vibe-golden-eval-results.md). Follow that phase's own spec, plan and fork ledger; do not repeat this controls implementation or take over another session's work. Family Desk remains its own lane.

Private browser/host evidence and archived execution receipts are outside Git under `~/.cache/ai-trading-controls-live-evidence/`. The owner-approved controller checkout stayed clean and merged up to `origin/dev`; the main checkout and other sessions' work were not changed. Receipt-only documentation should ride the next meaningful batch rather than create a standalone CI/release cycle.
