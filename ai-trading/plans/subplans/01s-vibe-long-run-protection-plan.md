# Vibe long-run protection implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep Vibe chat and automatic committee research alive through routine deploys; show honest interruption and explicit retry after an unavoidable restart.

**Architecture:** The running Vibe process atomically pauses new chat admission and reports admitted chat plus private-committee activity through a loopback-only leased control endpoint. The existing deploy driver waits at most 60 minutes before replacing Vibe, then keeps Caddy's admission marker through health and commit so the new process cannot accept research before rollback risk ends. Restart recovery persists redacted progress and the original prompt so the existing chat UI can show amber Interrupted and offer an explicit, confirmed re-send.

**Tech Stack:** Python 3.12, FastAPI, file-backed SessionStore/SwarmStore, React/TypeScript/Vitest, Caddy 2, Bash/Docker Compose.

**Spec:** [01s-vibe-long-run-protection.md](01s-vibe-long-run-protection.md).

## Global Constraints

- Protect `SessionService` chat attempts and **private automatic committees**, including detached children; exclude standalone swarms, Alpha/scheduled jobs, persistent live runners and unrelated app groups.
- Wait at most **60 minutes** for active protected work; on timeout keep old app-group choices, secrets, installed configs, and Vibe/other app containers. The one-time bootstrap may temporarily replace only the gateway with a staged Caddyfile bind-mount override and must restore it on abort.
- Never auto-replay. Retry requires explicit confirmation and creates a new attempt in the same session with current model/effort. Warn that completed actions can repeat.
- Keep the existing SP4-sanitized response checkpoint; no unreviewed US-stock draft, tool arguments/previews, provider bodies, private committee IDs, or credentials in **new tool-progress** checkpoints, drain responses, logs, or browser retry UI.
- Preserve the 30 GiB disk guard, MiroFish `keep`, lifecycle lock, rollback, Clerk/Caddy auth gate, and current service selection.
- Keep secrets outside the repo; use `common/config/family_config.py` only. No paid-data signup, live trades, or new provider. Caddy's existing `admin off` stays off.
- Vibe fork changes go on its `family-app` branch with `DIVERGENCE.md` updated in the same fork commit; push fork before moving superproject gitlink. Work in this existing isolated superproject worktree on `feature/vibe-sp5`, not shared `feature/toby`.
- First release of SP5 must not interpret the old image's missing drain endpoint as zero work. Use a temporary gateway admission barrier and legacy preflight, or hold production release if safe quiescence cannot be demonstrated.

## File map

| Responsibility | Files |
|---|---|
| Atomic chat admission and drain lease | `packages/vibe-trading/agent/src/session/service.py`; route shim `agent/src/api/deploy_routes.py`; registration `agent/api_server.py`; 503 mapping `agent/src/api/sessions_routes.py` |
| Private committee activity beyond parent | `agent/src/tools/swarm_tool.py`, `agent/src/agent/committee_gate.py` |
| Durable, redacted interruption history | `agent/src/session/checkpoint.py`, `agent/src/session/store.py`, `agent/src/session/service.py` |
| Honest chat status and retry | `frontend/src/stores/agent.ts`, `frontend/src/pages/Agent.tsx`, `frontend/src/components/chat/ActivityLine.tsx`, `frontend/src/components/chat/MessageBubble.tsx`, `frontend/src/i18n/locales/*.json` |
| One-time ingress barrier and normal drain | `deploy/production/Caddyfile`, `deploy/production/deploy.sh`, existing `deploy/ci/smoke-test.sh` and `deploy/ci/test-deploy-firestore.sh` |
| Fork release ledger | `packages/vibe-trading/DIVERGENCE.md`, superproject gitlink, `plans/subplans/01s-vibe-long-run-protection-results.md` |

## Review Focus

1. **Legacy first deploy:** old Vibe has no drain API; signed-in POST must be blocked at gateway before a zero-work preflight, and timeout must restore old gateway (Task 5 tests).
2. **Parent/child handoff:** committee thread can start late or outlive its parent; neither interval may report idle (Task 2 tests).
3. **Lease loss during pull:** an expired lease or replaced container must abort before `compose up`, not switch based on stale zero counts (Task 6 tests).
4. **Untrusted request source:** even a valid Vibe key from a non-loopback peer, or a signed-in browser through Caddy, cannot enter drain (Task 1/5 tests).
5. **Incomplete restart record:** missing/corrupt redacted tool history or lost prompt must not look Done or enable a guessed retry; unsafe draft and private committee content stay hidden (Task 3/4 tests).

---

### Task 1: Atomic Vibe drain lease and loopback route

**Files:**
- Modify: `packages/vibe-trading/agent/src/session/service.py` (`_inflight_lock`, `_reserve_session`, new lease methods)
- Create: `packages/vibe-trading/agent/src/api/deploy_routes.py`
- Modify: `packages/vibe-trading/agent/api_server.py` (register route); `agent/src/api/sessions_routes.py` (503 before persistence)
- Test: `packages/vibe-trading/agent/tests/test_session_service_lifecycle.py`; create `agent/tests/test_deploy_drain_routes.py`

**Interfaces:** Produces `ServiceDrainingError`; `SessionService.start_deploy_drain() -> str`, `renew_deploy_drain(token: str) -> None`, `deploy_drain_status(token: str) -> dict[str, int]`, `end_deploy_drain(token: str) -> None`. Route `POST /internal/deploy/drain` returns `{lease, active_chat, active_private_committees}`, `GET` returns counts, `POST /internal/deploy/drain/renew` extends lease, `DELETE /internal/deploy/drain` ends it; subsequent calls carry token in `X-Deploy-Lease`, never URL/query. Fixed 600-second lease, renewed by driver; no configurable key.

- [ ] **Step 1: Prepare the test environment outside the repo.** Run from `packages/vibe-trading/`: `uv venv --python 3.12 /private/var/folders/_1/050mzm_167bd175pmv0rfhz40000gn/T/opencode/vibe-sp5-venv`, then `uv pip install --python /private/var/folders/_1/050mzm_167bd175pmv0rfhz40000gn/T/opencode/vibe-sp5-venv/bin/python -r requirements-lock.txt` and `uv pip install --python /private/var/folders/_1/050mzm_167bd175pmv0rfhz40000gn/T/opencode/vibe-sp5-venv/bin/python -e '.[dev,openbb,stats,anthropic]'`. The prior temporary venv lacks pytest and system Python lacks pandas; do not use either as a baseline.
- [ ] **Step 2: Add failing lease/admission tests.** Extend the existing `_service` helper's test file with:

```python
def test_drain_rejects_new_send_without_persisting(tmp_path, monkeypatch):
    async def scenario():
        service = _service(tmp_path, monkeypatch)
        session = service.create_session(title="drain")
        lease = service.start_deploy_drain()
        with pytest.raises(ServiceDrainingError):
            await service.send_message(session.session_id, "new research")
        assert service.store.get_messages(session.session_id) == []
        assert service.store.list_attempts() == []
        service.end_deploy_drain(lease)
    asyncio.run(scenario())
```

  Add cases where a previously reserved session remains counted, a wrong lease cannot renew/release, an expired lease reopens admission, and restart clears the in-memory lease. If private-work counting fails during the initial status response, the route must release its just-created lease before returning 503 (no 10-minute stuck pause). Test the new API with `TestClient(api_server.app, client=("127.0.0.1", 50000))` and a remote `("203.0.113.9", 50000)`; configured API key must be required for both. Remote with the correct key still receives 403, bad/missing key 401, and browser POST to Caddy later receives 404/403, never a lease.
- [ ] **Step 3: Run targeted RED tests.** From Vibe root: `/private/var/folders/_1/050mzm_167bd175pmv0rfhz40000gn/T/opencode/vibe-sp5-venv/bin/python -m pytest agent/tests/test_session_service_lifecycle.py::test_drain_rejects_new_send_without_persisting agent/tests/test_deploy_drain_routes.py -q`. Expect missing API/method failures, not collection failures.
- [ ] **Step 4: Implement minimal lock-shared lease and route.** Initialize `_drain_token: str | None = None` and `_drain_deadline = 0.0`; under `_inflight_lock`, expire old leases via `time.monotonic()`, refuse `_reserve_session` when current lease exists, and use `secrets.token_urlsafe(24)` for a new token. Check token equality with `hmac.compare_digest`; no owner identity or prompt is returned. Route checks `ipaddress.ip_address(request.client.host).is_loopback` **after** `require_auth`, not `_is_local_client` (which can trust a Docker gateway); wire `ServiceDrainingError` to HTTP 503 with `Retry-After: 30` before `send_message` persists. Hold the lock only to snapshot `_inflight`; private count is added in Task 2. Use this core sequence:

```python
with self._inflight_lock:
    if self._drain_token and time.monotonic() < self._drain_deadline:
        raise ServiceDrainingError("Research is paused for deployment; retry shortly")
    self._inflight.add(session_id)
```

  Route guard uses a real client address, not a forwarded header:

```python
def require_deploy_peer(request: Request) -> None:
    try:
        loopback = ipaddress.ip_address(request.client.host).is_loopback
    except (AttributeError, ValueError):
        loopback = False
    if not loopback:
        raise HTTPException(status_code=403, detail="Local deploy control only")
```

  Register the control beside the existing session routes, resolving the same service singleton:

```python
@app.post("/internal/deploy/drain", dependencies=[Depends(require_auth)])
async def begin_deploy_drain(request: Request):
    require_deploy_peer(request)
    service = _host_get_session_service()
    lease = service.start_deploy_drain()
    try:
        status = service.deploy_drain_status(lease)
    except (OSError, ValueError) as exc:
        service.end_deploy_drain(lease)
        raise HTTPException(status_code=503, detail="Deploy state unavailable") from exc
    return {"lease": lease, **status}
```

  Status/renew/release use `X-Deploy-Lease` and the same peer/auth checks; never accept the lease in query params.

- [ ] **Step 5: Run GREEN and commit exact fork paths.** Run both targeted test files and `ruff check` on touched fork Python files. Commit fork changes plus their `DIVERGENCE.md` rows with `feat(vibe): add leased chat drain control` (do not push the fork until the phase's complete verification).

### Task 2: Count detached private committees without a launch gap

**Files:**
- Modify: `packages/vibe-trading/agent/src/tools/swarm_tool.py`, `agent/src/agent/committee_gate.py`, `agent/src/session/service.py`
- Test: create `packages/vibe-trading/agent/tests/test_private_committee_drain.py`

**Interfaces:** Produces `active_private_committee_work() -> int` in `src.tools.swarm_tool`; Task 1's `deploy_drain_status()` adds that value to its `active_private_committees` key. A launch is registered before `thread.start()` and released when `execute_private_committee()` returns; persisted pending/running private runs remain counted after the launcher exits. Regular public/manual swarm root is never inspected.

- [ ] **Step 1: Write RED tests** using `SwarmStore`, `SwarmRun(id="run-1", preset_name="investment_committee", created_at="2026-10-16T00:00:00Z")`, and `private_committee_runs_root()` monkeypatched to a `tmp_path` child. Assert pending launch alone returns one; pending persisted run returns one after launch release; completed run returns zero; a manual run stored outside `.committee` returns zero; malformed private `run.json` raises an error instead of returning idle. Also race a parent `_inflight` release before its daemon child persists: status must stay nonzero throughout. Start with:

```python
def test_pending_private_launch_blocks_idle(tmp_path, monkeypatch):
    monkeypatch.setattr("src.tools.swarm_tool.private_committee_runs_root", lambda: tmp_path / ".committee")
    finish = mark_private_launch()
    try:
        assert active_private_committee_work() == 1
    finally:
        finish()
    assert active_private_committee_work() == 0
```
- [ ] **Step 2: Run RED.** `/private/var/folders/_1/050mzm_167bd175pmv0rfhz40000gn/T/opencode/vibe-sp5-venv/bin/python -m pytest agent/tests/test_private_committee_drain.py -q`; expect missing tracking function.
- [ ] **Step 3: Add a tiny launch counter and complete-store scan.** In `swarm_tool.py`, define `mark_private_launch() -> Callable[[], None]` (idempotent release closure) and `active_private_committee_work() -> int` using one lock/counter plus **every** directory in `private_committee_runs_root()`; `SwarmStore.list_runs(limit=50)` is insufficient. Use `SwarmStore.load_run` and count **raw persisted** pending/running status; do not let `reconcile_run(write=False)` classify a silent-but-live worker as stale and release the deploy gate. A stale status may delay/abort a deploy, which is safe. Refuse unreadable/invalid run files and symlinks. In `committee_gate.py`, take a launch marker before the `committee-wait` thread is started, release it in that thread's `finally`, and release it if `thread.start()` raises. Task 1's drain snapshot counts both parent and private work; no session IDs, private run IDs or reports leave the endpoint.

```python
from src.swarm.models import RunStatus
from src.swarm.store import SwarmStore

store = SwarmStore(private_committee_runs_root())
active = 0
for entry in private_committee_runs_root().iterdir():
    if entry.is_symlink() or not entry.is_dir():
        raise OSError("Invalid private committee run entry")
    run = store.load_run(entry.name)
    if run is None:
        raise OSError("Unreadable private committee run")
    if run.status in {RunStatus.pending, RunStatus.running}:
        active += 1
return pending_private_launches() + active
```

- [ ] **Step 4: Run GREEN and commit.** Run the new tests plus `test_session_service_lifecycle.py`, `test_committee_gate_stream.py`, `test_swarm_route_contracts.py`, and Ruff. Commit exact fork paths and `DIVERGENCE.md` as `feat(vibe): protect detached private committees during drain`.

### Task 3: Recover honest redacted progress and prompt identity

**Files:**
- Modify: `packages/vibe-trading/agent/src/session/checkpoint.py`, `agent/src/session/store.py`, `agent/src/session/service.py`
- Test: `packages/vibe-trading/agent/tests/test_session_restart_recovery.py`, `agent/tests/test_session_tool_trail.py`

**Interfaces:** `SessionStore.save_progress_tools(session_id: str, attempt_id: str, entries: list[dict]) -> None`, `get_progress_tools(session_id: str, attempt_id: str) -> list[dict]`, and `delete_progress_tools(session_id: str, attempt_id: str) -> None`; recovered assistant metadata adds `retry_prompt` from that exact persisted `Attempt.prompt`, `progress_complete=False`, and existing `status="interrupted"`. Progress entries contain only `tool`, `status`, `elapsed_ms`, `timestamp`; max 100 records.

- [ ] **Step 1: Write RED tests** for sanitized `tool_call`/`tool_result` after `CommitteeGate.sanitize_event`, a restart before terminal reply, corrupt/missing progress JSON, and a US-stock draft that must remain quarantined. Use this assertion shape:

```python
recovered = store.get_message_for_attempt(session.session_id, attempt.attempt_id)
assert recovered.metadata["status"] == "interrupted"
assert recovered.metadata["retry_prompt"] == attempt.prompt
assert recovered.metadata["progress_complete"] is False
assert recovered.tool_trail == [{"tool": "web_search", "status": "ok", "elapsed_ms": 12, "timestamp": 1000}]
assert "preview" not in recovered.tool_trail[0]
```

  Update the old exact metadata assertion in `test_session_restart_recovery.py`; retain its repeated-startup and already-committed terminal-reply cases.
- [ ] **Step 2: Run RED.** `/private/var/folders/_1/050mzm_167bd175pmv0rfhz40000gn/T/opencode/vibe-sp5-venv/bin/python -m pytest agent/tests/test_session_restart_recovery.py agent/tests/test_session_tool_trail.py -q`; expect the new metadata/progress assertions to fail.
- [ ] **Step 3: Persist only allowed fields after sanitization.** After `gate.sanitize_event` and before SSE, have `ResponseCheckpoint.handle_event` record `tool_call`/`tool_result` by `call_id` internally, then atomically write a capped list of four-field dictionaries via `SessionStore`; never write `arguments`, `preview`, `artifact`, `run_id`, or reasoning. On startup `SessionService._recover_interrupted_attempts` reads those records into the interrupted reply and adds the prompt reference. A broken/missing checkpoint yields an empty trail plus `progress_complete=False`, never a fabricated zero-action claim. Delete the progress file only after the terminal assistant message is committed; do not overwrite an already-completed reply on restart.

```python
if event_type in {"tool_call", "tool_result"}:
    state = "running" if event_type == "tool_call" else ("ok" if data.get("status") == "ok" else "error")
    safe = {"tool": str(data.get("tool") or ""), "status": state,
            "elapsed_ms": max(0, int(data.get("elapsed_ms") or 0)),
            "timestamp": int(time.time() * 1000)}
    if safe["tool"]:
        self._record_safe_progress(data.get("call_id"), safe)
        self._store.save_progress_tools(self._session_id, self._attempt_id, self._safe_progress[-100:])
```

  `_record_safe_progress` keeps `call_id` only in memory to pair a result with its call; it writes only the four fields above. Recovery stores `tool_trail=store.get_progress_tools(...)` and `metadata["retry_prompt"]=attempt.prompt` only for `interrupted`.

```python
def _record_safe_progress(self, call_id: str | None, safe: dict) -> None:
    if safe["status"] != "running" and call_id:
        for index in range(len(self._safe_progress) - 1, -1, -1):
            if self._safe_progress[index][0] == call_id:
                self._safe_progress[index] = (call_id, safe)
                break
        else:
            self._safe_progress.append((call_id, safe))
    else:
        self._safe_progress.append((call_id, safe))
    self._safe_progress = self._safe_progress[-100:]
```

  Initialize `self._safe_progress: list[tuple[str | None, dict]] = []` in `ResponseCheckpoint.__init__` and pass only `[entry for _, entry in self._safe_progress]` to `save_progress_tools`.
- [ ] **Step 4: Run GREEN and commit.** Run the targeted tests, `test_committee_gate_stream.py`, Ruff, and commit exact fork paths plus `DIVERGENCE.md` as `feat(vibe): retain safe interruption context`.

### Task 4: Amber interruption and deliberate same-session retry

**Files:**
- Modify: `packages/vibe-trading/frontend/src/stores/agent.ts`, `frontend/src/pages/Agent.tsx`, `frontend/src/components/chat/ActivityLine.tsx`, `frontend/src/components/chat/MessageBubble.tsx`, `frontend/src/i18n/locales/*.json`
- Test: `frontend/src/pages/__tests__/AgentActivityTimerPersistence.test.tsx`, `frontend/src/pages/__tests__/AgentInterruptedRetry.test.tsx` (new), `frontend/src/components/chat/__tests__/ActivityLine.test.tsx`

**Interfaces:** `ActivityState` gains `"interrupted"`. Hydrated answer `AgentMessageMeta` gains `retryPrompt?: string`, `progressComplete?: boolean`; `MessageBubble` gets an explicit `onRetryInterrupted?: (prompt: string) => void`. Existing `api.sendMessage`/`submitComposerPrompt` is reused; no retry API.

- [ ] **Step 1: Write RED tests.** Supply a saved assistant message with `metadata: {status: "interrupted", retry_prompt: "Research NVDA.US", progress_complete: false}` and a redacted `tool_trail`. Assert amber Interrupted instead of Done, warning that actions may have occurred, known tool status without preview, no retry if prompt missing, and `window.confirm` false performs no send. On true confirmation, click twice and assert one `api.sendMessage` for the **existing** session and original prompt; test 503/409 keeps the interrupted row, reload/reconnect does not auto-send.

```tsx
const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
render(<MessageBubble msg={interruptedMessage} onRetryInterrupted={onRetryInterrupted} />);
fireEvent.click(screen.getByRole("button", { name: /retry research/i }));
expect(confirm).toHaveBeenCalledOnce();
expect(onRetryInterrupted).not.toHaveBeenCalled();
```
- [ ] **Step 2: Run RED.** From Vibe `frontend/`: `npx vitest run src/pages/__tests__/AgentInterruptedRetry.test.tsx src/components/chat/__tests__/ActivityLine.test.tsx`; expect new cases to fail.
- [ ] **Step 3: Implement minimal UI.** Map `meta?.status === "interrupted"` to `"interrupted"` in `buildToolTimelineMessages`, render amber icon/text in `ActivityLine`, and keep answer text as the existing safe recovered notice. Read `retry_prompt` only from the linked assistant metadata; on click, use `window.confirm(t("agent.retryInterruptedWarning"))` and `submitComposerPrompt(retryPrompt)` with a synchronous in-flight guard. Render a warning even when no tool trail exists; do not infer adjacent prompt. Add the new locale keys following existing fallback conventions, with no raw private artifacts.

```tsx
const interrupted = m.role === "assistant" && meta?.status === "interrupted";
const activityState = interrupted ? "interrupted" : meta?.status === "failed" ? "failed"
  : meta?.status === "cancelled" ? "stopped" : "done";
const retryPrompt = interrupted && typeof meta?.retry_prompt === "string"
  ? meta.retry_prompt : undefined;
if (retryPrompt && window.confirm(t("agent.retryInterruptedWarning"))) {
  submitComposerPrompt(retryPrompt);
}
```
- [ ] **Step 4: Run GREEN and commit.** Run `npx tsc -b && npx vitest run && npm run build`; commit exact fork paths and `DIVERGENCE.md` as `feat(vibe): show interrupted research and explicit retry`.

### Task 5: First-upgrade gateway admission barrier

**Files:**
- Modify: `ai-trading/deploy/production/Caddyfile`, `ai-trading/deploy/production/deploy.sh`
- Test: `ai-trading/deploy/ci/test-deploy-firestore.sh`, `ai-trading/deploy/ci/smoke-test.sh`

**Interfaces:** Bash `enter_legacy_barrier <container_id>` activates a root-owned marker at `/run/family-app/ai-trading-control/vibe-admission-paused`, creates a scratch Compose override for the staged Caddyfile bind mount, and recreates **gateway only** under the existing lifecycle lock; `legacy_active_counts <container_id>` prints exactly two nonnegative decimal counts separated by one space and reads old Vibe session/private-run files without instantiating `SessionService`; `leave_legacy_barrier` removes the marker and recreates the old gateway from the **unchanged installed** Compose/Caddyfile on abort. The Caddy route denies authenticated `POST /sessions/{id}/messages` only while the marker exists, after Clerk + availability checks and before `reverse_proxy`; all other routes remain unchanged.

- [ ] **Step 1: Write RED gateway tests.** In the real-Caddy smoke, mount a temporary control directory, create its `vibe-admission-paused` file, assert signed-out POST remains 401, authenticated POST returns 503 with `Retry-After`, authenticated GET `/sessions` still proxies, and deleting the file re-enables POST. Add offline fake-Docker driver tests where the old Vibe has no endpoint: an active attempt causes abort without Vibe replacement, uncertain JSON causes abort, and the previous gateway **mount/container** returns on timeout with the installed Caddyfile unmodified.

```bash
install -m 0644 /dev/null "$control_dir/vibe-admission-paused"
signed_in_post_status="$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H "$verified_header" "$vibe_url/sessions/test123/messages")"
[[ "$signed_in_post_status" == 503 ]] || fail "admission barrier did not block new chat"
rm -f "$control_dir/vibe-admission-paused"
```

  Reuse the smoke harness's verified header and fixture base URL variables; no real credentials or live host. Also assert the header and signed-out/read-only cases above.
- [ ] **Step 2: Run RED.** From repo root: `ai-trading/deploy/ci/test-deploy-firestore.sh` and (after `CLERK_PUBLISHABLE_KEY=pk_test_Y2ktZmFrZS5jbGVyay5hY2NvdW50cy5kZXYk docker buildx bake -f ai-trading/deploy/docker-bake.hcl --load`) `ai-trading/deploy/ci/smoke-test.sh vibe-trading`; expect new barrier cases to fail, not missing images. The Clerk value is public fake test data.
- [ ] **Step 3: Implement a Caddy file matcher within the existing Vibe `route`.** Verify with Caddy `adapt --validate` and the real smoke, not a grep-only assertion. Use fixed root, method and path matchers; route order is explicit:

```caddyfile
@vibe_paused {
	method POST
	path_regexp ^/sessions/[^/]+/messages$
	file {
		root /run/family-app/ai-trading-control
		try_files vibe-admission-paused
	}
}
respond @vibe_paused `{"error":"research_paused","message":"Research is paused for deployment; retry shortly."}` 503
```

  Add `Retry-After: 30` and `Cache-Control: no-store` on this response. Deny `/internal/deploy/*` through Caddy even when marker absent; the Vibe loopback/key check remains independent.
- [ ] **Step 4: Add gateway-only bootstrap and safe cleanup.** With the old tag and old secrets, create a root-only scratch Compose override replacing **only** the gateway `/etc/caddy/Caddyfile` bind mount with the staged Caddyfile (Compose merges volumes by container target). Keep `$APP_DIR/Caddyfile` untouched so later `stage_configs` backs up the actual prior version. Arm the one-shot marker expiry **before** creating the marker; if timer setup fails, abort without changing gateway. Then create marker and recreate/health-check only `gateway`; never call `apply_selected_services` at this point. Under the marker, inspect raw persisted `attempt.json` and private `run.json` from the **running old Vibe** using `docker exec` and stdlib JSON, failing on malformed files. Require two zero-work samples 10 seconds apart after ingress closure; a late private run resets the quiet interval. Wait at most 60 minutes; recreate the old gateway from the original Compose/Caddyfile and remove the marker on failure. A one-shot host timer removes an orphaned marker after 90 minutes if the SSH driver is killed, while the driver aborts if the marker disappears before switch. Do not invoke `SessionService` in a separate process: its constructor would incorrectly mark live attempts interrupted. Record the residual unobservable in-memory handoff risk of the old image in the release gate; if it cannot be accepted safely, hold production cutover.

```bash
legacy_marker=/run/family-app/ai-trading-control/vibe-admission-paused
BOOTSTRAP_OVERRIDE="$(mktemp "$STATE_DIR/vibe-gateway.XXXXXX.yml")"
BOOTSTRAP_TIMER="ai-trading-vibe-bootstrap-expiry-$(python3 -c 'import secrets; print(secrets.token_hex(4))')"
systemd-run --unit="$BOOTSTRAP_TIMER" --on-active=90m /usr/bin/rm -f "$legacy_marker"
install -m 0644 /dev/null "$legacy_marker"
cat >"$BOOTSTRAP_OVERRIDE" <<YAML
services:
  gateway:
    volumes:
      - "$APP_CONFIG_STAGING_DIR/Caddyfile:/etc/caddy/Caddyfile:ro"
YAML
chmod 0644 "$BOOTSTRAP_OVERRIDE"
compose -f "$BOOTSTRAP_OVERRIDE" up -d --no-deps --wait --wait-timeout 300 gateway
[[ -f "$legacy_marker" ]] || die "legacy Vibe admission barrier disappeared"
first="$(legacy_active_counts "$vibe_container_id")" || die "legacy Vibe state unreadable"
if [[ "$first" == '0 0' ]]; then
  sleep 10
  second="$(legacy_active_counts "$vibe_container_id")" || die "legacy Vibe state unreadable"
  [[ "$second" == '0 0' ]] || die "legacy Vibe became active while draining"
fi
```

  Wrap this in a monotonic 3600-second retry loop; recreate the old gateway without the override through `leave_legacy_barrier` on every pre-switch exit, and leave the installed prior Caddyfile untouched. `legacy_active_counts` returns exactly `"<chat> <private>"` after strict JSON validation, with no IDs/prompts printed. Arm the one-shot marker cleanup timer before the 60-minute wait, stop its exact timer unit after marker cleanup (`systemctl stop "$BOOTSTRAP_TIMER.timer"`), and abort the entire bootstrap before 85 minutes so expiry cannot silently reopen admission mid-cutover. Each retry gets a fresh timer name; an old timer must never remove a later attempt's marker.

```python
import json
from pathlib import Path

sessions = Path("/app/agent/sessions")
private = Path("/app/agent/.swarm/runs/.committee")
chat = committee = 0
for path in sessions.glob("*/attempts/*/attempt.json"):
    if path.is_symlink():
        raise ValueError("Unsafe attempt path")
    status = json.loads(path.read_text())["status"]
    chat += status in {"pending", "running"}
if private.exists():
    for entry in private.iterdir():
        if entry.is_symlink() or not entry.is_dir():
            raise ValueError("Unsafe private run path")
        status = json.loads((entry / "run.json").read_text())["status"]
        committee += status in {"pending", "running"}
print(chat, committee)
```

  Run inside the old container, capture its two integers only; malformed JSON or missing `status` exits nonzero and aborts. Never copy its files to the CI runner.
- [ ] **Step 5: Run GREEN and commit superproject paths.** Run `ai-trading/deploy/ci/test-deploy-firestore.sh`, full real-Caddy smoke, `actionlint` if workflow touched, and ShellCheck 0.9 `-x` on edited shell files. Commit Caddy/deploy/test paths exactly as `feat(ai-trading): gate legacy Vibe upgrade without cutting runs`.

### Task 6: Routine drain in the deploy transaction, integration, delivery

**Files:**
- Modify: `ai-trading/deploy/production/deploy.sh`, `ai-trading/deploy/ci/test-deploy-firestore.sh`, `ai-trading/deploy/production/README.md`, `ai-trading/plans/STATUS.md` (small additive status)
- Test: existing deploy offline harness and full `ai-trading/deploy/ci/smoke-test.sh all`

**Interfaces:** Bash `vibe_drain_request <container_id> <start|status|renew|release> [lease]` uses `docker exec -i <id> python -c` plus Python `urllib.request` to call `127.0.0.1:8899/internal/deploy/drain`, reads `API_AUTH_KEY` **inside** the container, receives lease via stdin/header and prints only JSON for capture into a root-only local variable. `wait_for_vibe_idle <container_id> <lease>` renews each loop and succeeds only when both counts are zero; `release_vibe_drain` is idempotent in EXIT/ERR cleanup and before a no-op success.

- [ ] **Step 1: Add RED fake-deploy cases.** Prove running selected Vibe drains and waits while existing chat is active; zero chat but one private run still waits; timeout at 3600 monotonic seconds aborts before `stage_secrets`, `stage_configs` or `compose up`; disabled/no container skips; 401/403/503, invalid JSON, lease expiry, changed container ID, and rollback after staging fail closed. Assert old preferences, MiroFish status, prior tag and secret-file hashes unchanged on abort, and the old process undrained afterward.

```bash
snapshot_before="$(shasum -a 256 "$state_file" "$secrets_dir/vibe-trading.env")"
if wait_for_vibe_idle "$vibe_container_id" "$lease"; then
  fail "drain should time out while private committee remains active"
fi
[[ "$compose_up_calls" == 0 ]] || fail "timed-out drain replaced a container"
[[ "$(shasum -a 256 "$state_file" "$secrets_dir/vibe-trading.env")" == "$snapshot_before" ]] || fail "abort mutated live state"
```

  Use the existing fake-Docker/state scratch harness and a fake monotonic clock; never wait an actual hour in CI.
- [ ] **Step 2: Run RED.** `ai-trading/deploy/ci/test-deploy-firestore.sh`; expect new case failures at drain ordering.
- [ ] **Step 3: Wire runtime drain after lifecycle lock and before active mutations.** Gate only when persisted desired Vibe is on **and** the current Vibe container is running. `POST` to start, keep the returned token only in a shell variable, poll every 10 seconds against monotonic 3600-second deadline, renew its 600-second lease each iteration and immediately before `compose up`; recheck both counts plus the exact container ID at the switch. `docker exec` command arguments contain Python source and fixed endpoint only, never the API key or token. A transport/auth/JSON failure aborts, not zero. Use `trap` cleanup to release the old-process lease on any pre-switch exit and rollback. New process starts undrained. Existing image pull, disk guard, selected-service handling and health check remain the same; if pulls/staging take long, renew/check before switch rather than trusting an old idle response.

  Execution ruling: retain Caddy's owner-tagged marker on routine releases too, from post-idle through health and last-good-tag commit. Otherwise a newly started Vibe process could accept a chat and then be restarted by rollback. After commit, a failed marker finalization is **applied but gated**: report failure without reverting the committed tag or deleting a foreign marker. Test the pre-switch no-redeploy branch and post-switch marker lifetime with the offline process-level cases before any release.

```bash
start_reply="$(vibe_drain_request "$vibe_container_id" start)" || die "Vibe drain unavailable"
lease="$(python3 -c 'import json,sys; d=json.load(sys.stdin); v=d["lease"]; assert isinstance(v,str) and len(v)>16; print(v)' <<<"$start_reply")" || die "Vibe drain lease invalid"
deadline="$(python3 -c 'import time; print(time.monotonic() + 3600)')"
while :; do
  reply="$(vibe_drain_request "$vibe_container_id" status "$lease")" || die "Vibe drain status unavailable"
  counts="$(python3 -c 'import json,sys; d=json.load(sys.stdin); a=d["active_chat"]; b=d["active_private_committees"]; assert type(a) is int and type(b) is int and min(a,b)>=0; print(a,b)' <<<"$reply")" || die "Vibe drain status invalid"
  [[ "$counts" == '0 0' ]] && break
  python3 -c 'import sys,time; sys.exit(time.monotonic() >= float(sys.argv[1]))' "$deadline" || die "Vibe research still active after 60 minutes"
  vibe_drain_request "$vibe_container_id" renew "$lease" >/dev/null || die "Vibe drain lease lost"
  sleep 10
done
```

  `vibe_drain_request` feeds the lease on stdin to Python running **inside** the container and uses that process's `API_AUTH_KEY` for `Authorization`; no `docker exec -e KEY=value`, token in URL, or shell tracing. Check container ID and re-read counts/renew immediately before `apply_selected_services`. Release the lease on the old container in the EXIT handler if still present; distinguish a clean pre-switch abort from rollback after a container changed.

```bash
vibe_drain_request() {
  local container_id="$1" action="$2" lease="${3:-}"
  printf '%s' "$lease" | docker exec -i "$container_id" python -c '
import json, os, sys, urllib.request
action = sys.argv[1]
method, suffix = {"start": ("POST", ""), "status": ("GET", ""),
                  "renew": ("POST", "/renew"), "release": ("DELETE", "")}[action]
headers = {"Authorization": "Bearer " + os.environ["API_AUTH_KEY"]}
lease = sys.stdin.read()
if lease:
    headers["X-Deploy-Lease"] = lease
request = urllib.request.Request("http://127.0.0.1:8899/internal/deploy/drain" + suffix,
                                 headers=headers, method=method)
try:
    with urllib.request.urlopen(request, timeout=8) as response:
        print(response.read().decode("utf-8"))
except Exception:
    raise SystemExit(1) from None
' "$action"
}
```
- [ ] **Step 4: Run GREEN deploy tests and review the diff.** Run `ai-trading/deploy/ci/test-deploy-firestore.sh`, `bash -n ai-trading/deploy/production/deploy.sh`, ShellCheck 0.9 with `-x`, and compare the diff against the spec. Commit driver/tests/README/STATUS exact paths as `feat(ai-trading): wait for Vibe research before deploy`.
- [ ] **Step 5: Run full release-tree verification.** In fork: `/private/var/folders/_1/050mzm_167bd175pmv0rfhz40000gn/T/opencode/vibe-sp5-venv/bin/python -m pytest agent/tests -q -n 8`, venv Ruff on changed Python, `npx tsc -b && npx vitest run && npm run build` in `frontend/`. From repo root: `CLERK_PUBLISHABLE_KEY=pk_test_Y2ktZmFrZS5jbGVyay5hY2NvdW50cy5kZXYk docker buildx bake -f ai-trading/deploy/docker-bake.hcl --load`, `ai-trading/deploy/ci/smoke-test.sh all`, `ai-trading/deploy/ci/test-deploy-firestore.sh`. The Clerk key here is syntactically valid **fake public test data**; use no real key or live orders. Verify the fork ledger describes all changes, then push the `family-app` fork branch before committing the exact gitlink. Remove only test artifacts created by this run if they appear untracked in the fork; never discard others' changes.
- [ ] **Step 6: Deliver only after review/CI gates.** Merge `origin/dev` into `feature/vibe-sp5` (never rebase/reset `feature/toby`), open one meaningful `dev` PR after full tests, then a scoped release branch from `origin/main` carrying only SP5 paths. Run main-target CI on exact release head, merge, monitor image build/VPS apply and verify signed-out 401, signed-in Vibe health/history, four saved Running choices, gateway 503 when held, and old release preservation on a safe pre-switch abort. Do **not** force an active production run to restart for QA. First rollout has an old-image handoff that cannot be proved atomically from outside the process; if the guarded quiet-window preflight cannot establish acceptable safety, report the blocker and hold production release rather than bypassing it. Create `ai-trading/plans/subplans/01s-vibe-long-run-protection-results.md` with sanitized CI/deploy/live evidence and remaining Finnhub/quality limitations; no raw prompts, IDs or secrets.
