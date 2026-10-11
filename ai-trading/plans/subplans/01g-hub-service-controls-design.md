# Trading Hub App Start/Stop Controls

**Updated:** 2026-10-11. **Status:** feature scope approved by the owner; revised
written design awaiting review before an implementation plan is written.

This replaces the earlier three-app-era proposal. The owner wants browser-based
switches after disk housekeeping, plans to retire this VPS in a few months, and
may move deployment to a personal Ubuntu laptop or another VPS. Recurring
backup/restore development is out of scope; cleanup and switches preserve data.

## 1. Goal and approach

Either authorized family user can open `/settings` in the Trading Hub and turn
an app on/off to save RAM. The Hub stays online; a switch affects both users.
Stopping ends active work but never deletes volumes, reports, uploads or config.

Use a small Linux host helper, reached only over a protected Unix socket from
the existing Caddy gateway. Its deployment is scripted under `infrastructure/`
and portable to a supported replacement Linux host. Reuse existing Clerk
verification and Docker Compose; do not add a container-management framework.

Alternatives considered:
- **Host helper (selected):** no extra controller image/container and no Docker
  socket mounted inside a web container; needs a scripted systemd installation.
- **Private controller container:** easier to package entirely in Compose, but
  requires a privileged Docker-socket mount and another image to maintain.
- **SSH-only operations:** smallest overall, but does not provide the browser
  switches the owner has now requested.

Target support is Linux with systemd and rootful Docker, covering the current VPS
and a normally provisioned Ubuntu laptop/VPS. Rootless Docker requires an
explicit peer-identity/deployment adaptation, not a weakened socket check.

## 2. App groups and protected services

| App ID / label | Controlled services | Effect when stopped |
|---|---|---|
| `tradingagents` / TradingAgents | `ta-terminal`, `ta-research` | Terminal sessions and research workers stop. Both separate data volumes remain. |
| `ai-hedge-fund` / AI Hedge Fund | `ahf-terminal` | TUI/backtests stop; paper books and cached files remain. |
| `vibe-trading` / Vibe-Trading | `vibe-trading` | Its UI/API and active work stop; sessions/uploads remain. |
| `mirofish` / MiroFish | `mirofish` | Simulation processes stop. GCS static UI remains; its API reports Stopped. |

Always-on infrastructure: `web` (until the Desk hostname cutover), `gateway`,
`auth`, `cloudflared`, and `market-data`. Family Desk and expense services are
never controllable here. A shared catalog defines these exact app/service groups
for the helper, deployment and health checks.

The current gateway `depends_on: ta-research` must not implicitly restart an off
TradingAgents group. Replace implicit lifecycle coupling with explicit enabled
service selection. Keep the research network's gateway-only identity boundary
and separate `ta-data` / `ta-research-data` volumes unchanged.

## 3. Settings and launcher experience

- Retain the approved dark/amber Hub style. `/settings` has four labeled rows,
  actual status text, an accessible switch, and Refresh. Add a Settings link to
  the desktop/mobile navigation without replacing the read-only Account menu.
- Explain: **These switches affect both family members. The Hub stays online.**
- Turning a running app off requires confirmation that current analyses,
  backtests or simulations end. No confirmation is needed for an on request.
- Switches represent desired state. Status separately reports `Running`,
  `Starting`, `Stopping`, `Stopped`, `Needs setup`, `Unhealthy`, or `Error`.
  Do not display Running until all services in that app group are healthy.
- A failed start retains the desired choice but reports Error and allows Retry.
  Retrying reconciles the same choice; it does not queue duplicate operations.
- Poll while a transition is active, otherwise refresh periodically and when the
  page regains focus. A stale revision refreshes state and explains the conflict.
- Off app cards show Stopped and a Settings link. Backend paths return an
  authenticated 503 with an actionable message, not a misleading tunnel 502.
  Status uses text/icons as well as color, with 44px minimum controls.

## 4. Public API and authentication

- `GET /__control/apps` returns the global revision, desired flags, actual
  service-group health/status and last change time.
- `PUT /__control/apps/{id}` accepts only `{enabled: boolean, expectedRevision:
  integer}`. Reject unknown fields, unknown/path-like IDs, invalid types and
  unsupported methods. A stale revision returns 409; an accepted operation
  returns 202 and an operation identifier until reconciliation finishes.
- A repeated request for an already converged choice is a no-op. While the same
  operation is in progress, return that operation rather than execute twice.
  Different concurrent changes are rejected/bounded, never silently overwritten.
- **Every GET/PUT verifies a short-lived Clerk bearer token**, issuer, audience,
  authorized party and family email allowlist using the existing verifier. A
  gateway cookie alone cannot authorize controls. The mutation also rejects
  missing/disallowed Origin before any helper operation occurs.
- A dedicated internal auth check returns the verified Clerk `sub` for auditing.
  Caddy overwrites client-supplied actor headers and forwards only this verified
  identity. Strip Authorization/Cookie before proxying to the privileged helper;
  it needs the trusted actor ID, not the user's token.
- The existing one-hour gateway cookie and terminal authentication are unchanged.
  This design does not claim immediate revocation of already-issued Clerk JWTs.
- The existing hub Worker already reserves `/__control/*`; it only forwards to
  the tunnel origin and never receives a Docker credential or new admin token.

## 5. Private host helper boundary

- Install a root-owned Python-stdlib helper and systemd unit/socket with an
  app-specific bootstrap script under `infrastructure/vps/`. No hand-edited
  console settings or changes to the expense stack.
- Listen on a Unix socket only; no public port. The socket directory and socket
  are accessible only to root and the dedicated gateway group.
- Run Caddy with dedicated UID/GID **22001**. Bootstrap refuses an incompatible
  existing UID or unsupported identity mapping. Give Caddy private writable
  runtime config locations if required; don't widen host permissions.
- The helper validates Linux `SO_PEERCRED` against UID 22001 before servicing any
  request. Merely finding the socket or forging a header is insufficient.
- Mount the socket directory only into the gateway. Never mount the Docker
  socket into the gateway, frontend, terminal or research service.
- Only the four fixed IDs, a boolean and revision are accepted. Compose project
  `ai-trading`, config paths and service names are fixed, not supplied by callers.
  Use subprocess argument lists, never shell interpolation of request values.
- Start only the mapped group using local deployed images; stop only that group
  with a bounded graceful timeout. No `down`, volume deletion, image deletion,
  arbitrary exec/shell or Docker API pass-through exists.
- Availability probes used internally by Caddy are peer-checked/read-only and
  never exposed as unauthenticated public status endpoints. Run normal app auth
  first, then the availability gate, then proxy to the existing upstream.
- Helpers unavailable or uncertain state produce a bounded, clear 503. Existing
  app identity stripping and the research network's isolated peer set remain.
- Audit actor ID, app ID, time, result and exit code in a small rotated root-only
  local log. Do not return/log tokens, provider keys, environment values or raw
  command output that could contain them.

## 6. State, deploy, rollback and reboot

- Store desired booleans, schema version and a monotone revision atomically in a
  root-owned file under `/var/lib/family-app/ai-trading/`. This is operational
  state, not another secret/environment store. Configuration stays in Firestore.
- On first activation with an existing stack, adopt current actual app states:
  an app group is desired On if any of its services is running. A partially
  running group reports drift/unhealthy until reconciled; do not silently stop
  its running member. Preserve MiroFish if it is already running. On a genuinely
  fresh host with no managed app containers, initialize the three standard apps
  On and MiroFish Off unless the explicit operator activation requests it. A
  copied, valid preference file always takes precedence over these defaults.
- Helper operations and `deploy.sh` share one `flock` lock. State mutations and
  Docker operations cannot race a deployment. GET polling reads atomic snapshots
  without waiting behind a long start operation.
- Deployment starts protected services plus explicitly enabled app groups and
  requires healthy only those effective groups. Disabled services stay stopped
  through deploy and reboot; no blanket Compose up can undo a user's preference.
- Respect MiroFish's existing fail-safe configuration policy: absent/invalid
  profile or render failure leaves it stopped with Needs setup and does not fail
  other apps. An otherwise configured, enabled MiroFish that dies fails health
  checking rather than silently being treated as intentionally off.
- Existing `activate_mirofish` / `stop_mirofish` operator inputs update the same
  desired state under the lock. Plain pushes/dispatches preserve that state.
- MiroFish environment rendering after reboot/while starting reuses the shared
  render/validate/install path; don't duplicate its secret handling in the helper.
- Snapshot pre-deploy choices/tag before mutation. On a failed release restore
  prior choices, credentials and image tag together, preserving intentionally
  disabled apps. Do not clear choices on helper restart.
- Reconcile the persisted choices after Docker starts on boot. Unexpected
  external Docker changes show drift/error rather than rewriting preferences.
- Keep the existing scoped image retention and 30 GiB free-space check. Pulling
  disabled app images may still use disk; these switches save RAM, not disk.

## 7. Portability and non-goals

Bootstrap, helper, systemd definition, Compose/config changes and deployment
wiring are all versioned. No VPS address or host-specific credential is hard
coded; the established Firestore/deploy profiles remain the operator interface.
The future host move uses the supported Linux provisioning path and can copy the
small operational-state file if preferences should carry over. Actual migration
and data-retention choices will be separate work.

No backup/restore system, migration execution, arbitrary container console,
scheduled toggling, new paid service, account editing/roles, portfolio features,
Family Desk controls, expense controls or upstream-source edits in this phase.

## 8. Verification and rollout gate

1. Unit tests: fixed allowlist/schema, revisions/idempotency, busy/timeout/error,
   atomic/corrupt state handling, no caller-supplied command/path, peer UID denial,
   fresh Clerk issuer/audience/party/email checks and Origin rejection. Cookie
   alone and forged actor headers cannot authorize an operation.
2. Fake-Compose integration: each app group affects only its mapped services;
   off choices survive deploy/rollback/reboot; gateway startup doesn't revive
   off research; shared services/volumes are unchanged; MiroFish profile errors
   and post-reboot rendering preserve the existing fail-safe policy.
3. Linux/real-Caddy checks: dedicated peer/socket permissions, identity stripping,
   availability-before-proxy behavior, direct API bypass denial, cross-site and
   missing bearer rejection, and research-network isolation remain covered.
4. Browser: Settings state/confirmation/Retry/409/Refresh, stopped launcher,
   keyboard/focus and mobile sizing, with current theme and real auth.
5. After approved plan execution: verify production GET/state, rejected requests
   and an idempotent no-op first. **No production stop/start demonstration that
   interrupts work without separate confirmation of the app and quiet window.**
   Named volumes and expense resources must remain unchanged.

Implementation begins only after this written design is reviewed, followed by
the written task plan and execution-method selection. One finished-phase PR to
`dev`, scoped release to `main`, then verified rollout; no docs-only PR now.
