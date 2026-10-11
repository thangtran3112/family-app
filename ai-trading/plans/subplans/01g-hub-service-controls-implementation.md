# Trading Hub App Start/Stop Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Authorized family users can start/stop four app groups from the Hub without deleting data or affecting shared infrastructure, with preferences surviving deploys and reboots.

**Architecture:** A Python-stdlib Linux host helper exposes HTTP only on a private Unix socket to Caddy UID/GID 22001. Caddy re-verifies a short-lived Clerk token for public control calls; the helper validates kernel peer credentials and invokes only fixed Compose service groups. One catalog and atomic state file are shared by helper, deploy and health checks under one lifecycle lock.

**Tech Stack:** Python 3.10+ stdlib, Linux systemd/`SO_PEERCRED`/`flock`, existing Docker Compose/Caddy, existing Node Clerk verifier, Next.js static export/React/Tailwind.

**Spec:** `ai-trading/plans/subplans/01g-hub-service-controls-design.md` (owner-approved 2026-10-11).

**Status:** owner selected subagent-driven execution on 2026-10-11; implementation
is starting in the isolated app-controls worktree. Rollout remains unperformed.

## Global Constraints

- Controlled groups: `tradingagents` → `ta-terminal`,`ta-research`; `ai-hedge-fund` → `ahf-terminal`; `vibe-trading` → `vibe-trading`; `mirofish` → `mirofish`.
- Always-on: `web`,`gateway`,`auth`,`cloudflared`,`market-data`. Never control Family Desk or expense services.
- Caddy UID/GID **22001**; socket **`/run/family-app/ai-trading-control/control.sock`**; state **`/var/lib/family-app/ai-trading/control.json`**; lifecycle lock **`/var/lib/family-app/ai-trading/.control.lock`**.
- Helper is Unix-socket-only; kernel peer UID check precedes HTTP parsing/dispatch. No Docker socket in web/gateway/app containers. No caller-supplied command, path, image, project or container identifier.
- Every public control GET/PUT requires a Clerk bearer token. Mutation Origin is checked first. Gateway cookie alone is insufficient; existing terminal-cookie behavior is unchanged.
- App switches never delete volumes/images and never call `compose down`. Save RAM, not disk. No upstream edits, backup system, migration execution, scheduled toggles or new paid service.
- MiroFish credentials remain Firestore-rendered on the host with mode 0600; reuse the existing checked staging/cleanup/self-heal logic.
- Rootful Docker/Linux/systemd only; reject unsupported rootless/user-namespace mapping rather than weakening the peer check.
- Work in the owner-approved worktree, never `feature/toby`. Exact paths staged. One phase PR to `dev`, scoped release to `main`; no docs-only PR.
- No live stop/start demonstration without a separately confirmed app/quiet window. Begin production verification with GET, rejected requests and a converged no-op.
- All command blocks run from the worktree repository root unless enclosed in an explicit package subshell. Run Linux-only control tests with the container command below, not macOS Python.

## Review Focus

1. A stale/corrupt state file or interrupted operation must not reset preferences or permit an old revision to overwrite a newer choice. Tests: Tasks 1, 3, 5.
2. Cookie-only, forged actor/forwarded-method headers and wrong Unix peers must never issue Docker commands. Tests: Tasks 3, 4, 7.
3. Gateway/Compose dependency startup must never revive intentionally off TradingAgents research. Tests: Tasks 2, 5, 7.
4. Missing `/run` MiroFish credentials after reboot must trigger the shared render path; a missing profile reports Needs setup without failing healthy core apps. Tests: Tasks 2, 5.
5. Helper/Docker/host installation failures must produce a bounded 503/error and preserve current apps, config and data rather than falsely reporting Stopped/success. Tests: Tasks 3, 5, 7.

---

## File and interface map

| File | Responsibility |
|---|---|
| `ai-trading/control/catalog.json` | Single checked-in app/service catalog |
| `ai-trading/control/state.py` | Strict state codec, atomic write, revision/operation transitions, CLI |
| `ai-trading/control/runtime.py` | Fixed Compose argument construction, actual-status query, group start/stop |
| `ai-trading/control/server.py` | Peer-checked Unix HTTP server, API dispatch, asynchronous operations |
| `ai-trading/control/test_state.py`,`test_runtime.py`,`test_server.py` | Stdlib tests with injected fake runtime/temporary state |
| `ai-trading/deploy/ci/test-app-controls-gateway.sh`,`test-app-controls-deploy.sh` | Isolated Linux/Caddy boundary and fake-deploy regressions |
| `ai-trading/deploy/production/mirofish-runtime.sh` | Extracted shared checked MiroFish staging/restore functions |
| `ai-trading/deploy/production/prepare-mirofish.sh` | Root-only environment-preparation entrypoint for helper/reboot |
| `infrastructure/vps/app-controls/install.sh` | Idempotent local-on-target installation, UID/mapping/path checks |
| `infrastructure/vps/app-controls/ai-trading-control.service` | Root helper supervision/reboot reconciliation |
| `ai-trading/auth/src/server.js` | New internal bearer control-auth check only |
| `ai-trading/deploy/production/Caddyfile`,`docker-compose.yml` | Dedicated gateway user, private socket mount, public auth/private availability wiring |
| `ai-trading/deploy/local/docker-compose.override.yml` | Keep the privileged production gateway out of the default macOS mock stack |
| `ai-trading/deploy/production/deploy.sh`,`health-check.sh` | Locked explicit service selection, snapshot/rollback and effective health |
| `ai-trading/frontend/lib/controls.ts`,`controls.test.ts` | Typed public DTO, fetch/error helpers and status interpretation |
| `ai-trading/frontend/components/app-controls-provider.tsx`,`app-controls-panel.tsx` | One shared polling context and Settings controls |
| `ai-trading/frontend/app/settings/page.tsx` | Static Settings route |
| `ai-trading/frontend/components/{page-shell,workspace-sidebar,header,apps-menu,app-card,terminal-frame}.tsx`,`ai-trading/frontend/app/apps/[slug]/page.tsx` | Settings links and truthful stopped/unknown launch state |
| `ai-trading/frontend/{package.json,export-layout.test.mjs}` | Runnable controls tests and exported Settings/auth-loading checks |
| `ai-trading/deploy/ci/upload-hub-static.sh`,`upload-hub-static.test.sh` | Exact Settings object/MIME allowlist |
| `.github/workflows/ai-trading-{ci,deploy}.yml` | Linux verification and helper/bootstrap staging |
| `ai-trading/deploy/production/README.md`,`ai-trading/AGENTS.md`,`ai-trading/plans/STATUS.md` | Operator procedure and completed-phase tracking |

### Stable contracts

State file (no secrets):

```json
{
  "schemaVersion": 1,
  "revision": 0,
  "desired": {"tradingagents": true, "ai-hedge-fund": true, "vibe-trading": true, "mirofish": false},
  "results": {"tradingagents": null, "ai-hedge-fund": null, "vibe-trading": null, "mirofish": null},
  "lastChange": null,
  "operation": null
}
```

`lastChange` is an ISO-8601 UTC timestamp or null. Each non-null `results` entry
is `{changedAt: ISO-8601 UTC timestamp, errorCode: ErrorCode | null}`. Retain
each app's last result when another app changes: one global operation slot alone
would erase a failed app's Error/Retry state.

An operation has `id` (server-generated UUID4), `appId`, `actorId`, `enabled`, `status`
(`starting`,`stopping`,`complete`,`error`), `startedAt`, `finishedAt`, and
`errorCode` (generic enum, never raw stderr). Accepted operations increment the
global revision. Concurrent same-choice requests return the active operation;
converged same-choice requests do not change revision or invoke Compose.

Public response:

```ts
type AppId = "tradingagents" | "ai-hedge-fund" | "vibe-trading" | "mirofish";
type AppStatus = "Running" | "Starting" | "Stopping" | "Stopped" | "Needs setup" | "Unhealthy" | "Error";
type ErrorCode = "needs_setup" | "image_missing" | "runtime_unavailable" | "operation_failed" | "operation_timeout" | "interrupted";
type AppState = { id: AppId; enabled: boolean; status: AppStatus; changedAt: string | null; operationId: string | null; errorCode: ErrorCode | null };
type ControlsState = { revision: number; lastChangedAt: string | null; apps: AppState[] };
```

Helper private routes: `GET /apps`, `PUT /apps/{id}`, and fixed availability
probes `GET /gate/{id}` (204 ready, 503 otherwise). Public Caddy maps only
`/__control/apps` and `…/apps/{id}`; it must not expose `/gate/*`.

Every 200/202 contains a complete `ControlsState` with exactly four distinct app
IDs. 202 sets the affected app's `operationId`; 200 converged no-op does not
create an operation. Errors use `{error: string, message: string}` with bounded
fixed messages: 400 malformed input, 401 invalid/missing token, 403 Origin/actor,
404 unknown route/app, 405 method, 409 stale revision or different active change,
413 body too large, 503 unavailable/busy. All responses use `Cache-Control:
no-store`. Socket/HTTP/Docker uncertainty never becomes Running or Stopped.

Linux unit-test command (no Docker socket or provider keys mounted):

```bash
docker run --rm --network none \
  -v "$PWD/ai-trading:/app:ro" -w /app/control \
  python:3.12-slim python -m unittest discover -s . -v
```

Use `-p test_server.py` for Task 3 RED. State/runtime-only tests also run directly
with macOS Python; the full suite and peer test must execute on Linux.

State Python interfaces:

```python
validate_state(value: object) -> dict
read_state(path: Path, owner_uid: int = 0) -> dict
refuse_unsafe_existing_path(path: Path, owner_uid: int = 0) -> None
initial_state(running: set[str] | None) -> dict  # None: genuinely fresh host
atomic_write(path: Path, value: dict, owner_uid: int = 0) -> None
begin_change(state: dict, app_id: str, enabled: bool, expected_revision: int,
             converged: bool, actor_id: str = "operator") -> tuple[dict, int]
finish_change(state: dict, operation_id: str, error_code: str | None) -> dict
restore_preferences(current: dict, saved: dict) -> dict  # monotone revision
selected_services(state: dict, mirofish_ready: bool) -> tuple[str, ...]
```

Runtime Python interfaces:

```python
Runtime(app_dir: Path, secrets_dir: Path, runtime_dir: Path,
        project: str = "ai-trading", command=subprocess.run, owner_uid: int = 0)
Runtime.service_states(services: tuple[str, ...]) -> dict[str, dict]
Runtime.group_status(app_id: str, enabled: bool,
                     observations: dict[str, dict] | None = None) -> str
Runtime.converged(app_id: str, enabled: bool) -> bool
Runtime.prepare_mirofish(lock_fd: int | None = None) -> bool
Runtime.apply(app_id: str, enabled: bool) -> None  # fixed commands, raises RuntimeFailure
```

Constructor injection exists for tests/operator bootstrap only. HTTP cannot
change any constructor setting or pass environment variables.

`server.py` produces `create_server(socket_path: Path, state_path: Path,
lock_path: Path, runtime: Runtime, gateway_uid: int = 22001) -> UnixServer` for
tests and the fixed production entrypoint. `UnixServer.public_state() -> dict`
builds the exact DTO above; `reconcile() -> None` owns boot/restart work. No HTTP
route accepts constructor arguments. `RuntimeFailure(code: ErrorCode,
exit_code: int | None = None)` carries only safe metadata.

---

## Task 1: Catalog and atomic preference transitions

**Files:** create `ai-trading/control/catalog.json`,`state.py`,`test_state.py`.
Produces the state interfaces above and a root/operator CLI:
`state.py init|services|snapshot|restore|set-mirofish`, with fixed production
defaults and test-only path arguments. CLI mutations either acquire the lock or
validate inherited lock FD 9; they must not unlock the parent's inherited FD.

CLI flags are explicit: `init --running-services-json JSON` (`null` for a genuinely
fresh host; `[]` for existing managed containers all stopped), `services
--mirofish-ready true|false` (one selected service per stdout line), `snapshot
--output FILE`, `restore --snapshot FILE`, and `set-mirofish --mode keep|1|0`.
Root/test callers may provide `--state FILE`, `--lock FILE`, `--owner-uid UID`,
and `--lock-fd FD`; HTTP cannot. Define `validate_inherited_lock(fd: int,
lock_path: Path) -> None` in state.py: check matching device/inode, regular-file
type and root ownership, then `flock(fd, LOCK_EX | LOCK_NB)` to validate/retain
the inherited exclusive lease. Closing a child descriptor is fine; explicitly
unlocking this shared open-file description is not. `keep` never derives desired
MiroFish state from running containers after initial adoption.

- [ ] **1. Write these failing tests.**

```python
class StateTest(unittest.TestCase):
    def test_defaults_and_existing_app_adoption(self):
        self.assertEqual(initial_state(None)["desired"], {
            "tradingagents": True, "ai-hedge-fund": True,
            "vibe-trading": True, "mirofish": False})
        self.assertTrue(initial_state({"ta-research", "mirofish"})["desired"]["tradingagents"])
        self.assertTrue(initial_state({"mirofish"})["desired"]["mirofish"])
        self.assertFalse(any(initial_state(set())["desired"].values()))

    def test_stale_and_invalid_mutations_do_not_change_state(self):
        s = initial_state(None)
        with self.assertRaises(Conflict):
            begin_change(s, "mirofish", True, 9, False)
        for bad_id in ("expense", "../mirofish", "market-data"):
            with self.assertRaises(ValueError):
                begin_change(s, bad_id, True, 0, False)
        for bad in (1, "true", None):
            with self.assertRaises(ValueError):
                begin_change(s, "mirofish", bad, 0, False)
        self.assertEqual(s, initial_state(None))

    def test_operation_idempotency_and_rollback_revision(self):
        s = initial_state(None)
        active, code = begin_change(s, "mirofish", True, 0, False)
        self.assertEqual(code, 202)
        same, code = begin_change(active, "mirofish", True, 1, False)
        self.assertEqual(same["operation"]["id"], active["operation"]["id"])
        done = finish_change(active, active["operation"]["id"], None)
        unchanged, code = begin_change(done, "mirofish", True, done["revision"], True)
        self.assertEqual((code, unchanged), (200, done))
        restored = restore_preferences(done, s)
        self.assertGreater(restored["revision"], done["revision"])
        self.assertEqual(restored["desired"], s["desired"])

    def test_other_app_change_does_not_erase_start_failure(self):
        s, _ = begin_change(initial_state(None), "mirofish", True, 0, False)
        s = finish_change(s, s["operation"]["id"], "operation_timeout")
        changed, _ = begin_change(s, "vibe-trading", False, s["revision"], False)
        self.assertEqual(changed["results"]["mirofish"]["errorCode"], "operation_timeout")

    def test_atomic_file_and_corrupt_or_unsafe_paths(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "control.json"
            atomic_write(p, initial_state(None), owner_uid=os.getuid())
            self.assertEqual(stat.S_IMODE(p.stat().st_mode), 0o600)
            self.assertEqual(validate_state(json.loads(p.read_text()))["revision"], 0)
            p.write_text("broken json")
            with self.assertRaises(StateFailure):
                read_state(p, owner_uid=os.getuid())
            p.unlink()
            p.symlink_to(Path(d) / "outside")
            with self.assertRaises(StateFailure):
                atomic_write(p, initial_state(None), owner_uid=os.getuid())
```

Add bool-as-int revision rejection, unknown/missing catalog/state keys, negative
revision, invalid operation ID/status, and failed replace/fsync tests using the
same real temporary-file APIs; old file content must remain readable after a
failed pre-replacement write/file-fsync/replace. A failure syncing the directory
after replacement means commit durability is uncertain: do not assert that old
content survived; raise StateFailure and expose unavailable state until validated
by reconciliation. Catalog tests assert exact mappings and protected services.

- [ ] **2. Run RED.**
`python3 -m unittest discover -s ai-trading/control -p test_state.py -v`.
Expected: import/undefined-interface failure before implementation.

- [ ] **3. Implement the catalog and state transitions.**

```json
{"schemaVersion":1,"apps":{"tradingagents":["ta-terminal","ta-research"],"ai-hedge-fund":["ahf-terminal"],"vibe-trading":["vibe-trading"],"mirofish":["mirofish"]},"protected":["web","gateway","auth","cloudflared","market-data"]}
```

The write primitive must validate existing path type/ownership (root in
production; injected expected UID for non-root tests), reject symlinks, and use
same-directory replacement:

```python
def atomic_write(path, value, owner_uid=0):
    validate_state(value)
    refuse_unsafe_existing_path(path, owner_uid=owner_uid)
    fd, temp = tempfile.mkstemp(prefix=".control-", dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w") as stream:
            json.dump(value, stream, separators=(",", ":"))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)
```

Define `StateFailure`, `Conflict`, `Busy` exceptions in `state.py`;
`refuse_unsafe_existing_path(path)` rejects existing non-regular/symlink/wrong
owner or group/world-writable files; check the root-owned non-symlink parent too.
Missing file is initialized only by explicit
bootstrap/init, never by GET. `read_state(path)` wraps IO/JSON/validation failures
as StateFailure without returning defaults.

`begin_change` performs exact-type checks (`type(enabled) is bool`,
`type(expected_revision) is int`), exact app-ID membership and revision equality
before mutation. A different active operation raises Busy. Otherwise create a
UUID4, increment revision, copy desired flags and set starting/stopping. Record
the trusted actor and timestamp, reset only that app's result error and update
`lastChange`. Validate actor IDs with `^[A-Za-z0-9_-]{1,128}$`. A
finished Error with the same desired choice can retry; a converged choice is a
200 no-op. `finish_change` only completes the matching active UUID and records
that app's safe error code without touching other apps' results. A snapshot
restore copies prior **preferences**, not a lower revision; increment current
revision and clear an interrupted operation.

`selected_services` returns protected services plus desired app groups;
MiroFish joins only when desired and configuration is ready. Unknown catalog or
state never silently omits a required app.

- [ ] **4. Run GREEN and commit.**

```bash
python3 -m unittest discover -s ai-trading/control -p test_state.py -v
git add ai-trading/control/catalog.json ai-trading/control/state.py ai-trading/control/test_state.py
git commit -m "feat(ai-trading): app control catalog and atomic preferences"
```

## Task 2: Fixed runtime operations and shared MiroFish preparation

**Files:** create `control/runtime.py`,`test_runtime.py`,
`deploy/production/mirofish-runtime.sh`,`prepare-mirofish.sh`; modify existing
`deploy.sh` and `test-deploy-firestore.sh` only for the shared extraction.
Consumes Task 1 catalog; produces Runtime methods above and a root-only preparer
that returns 0 on validated installation, nonzero on failure, never key values.

- [ ] **1. Write failing runtime tests with an injected command runner.**

```python
def test_start_and_stop_are_fixed_and_grouped(self):
    calls = []
    runtime = self.runtime(command=lambda argv, **kw: calls.append(argv) or self.ok())
    runtime.apply("tradingagents", True)
    self.assertEqual(calls[-1][-2:], ["ta-terminal", "ta-research"])
    self.assertIn("--no-deps", calls[-1])
    self.assertIn("--no-build", calls[-1])
    self.assertIn("never", calls[-1])
    runtime.apply("tradingagents", False)
    self.assertEqual(calls[-1][-5:], ["stop", "--timeout", "60", "ta-terminal", "ta-research"])
    for argv in calls:
        self.assertNotIn("down", argv)
        self.assertNotIn("rm", argv)
        self.assertNotIn("prune", argv)
        self.assertNotIn("expense", " ".join(argv))

def test_unknown_id_and_bad_metadata_never_execute(self):
    calls = []
    runtime = self.runtime(command=lambda argv, **kw: calls.append(argv) or self.ok())
    with self.assertRaises(ValueError): runtime.apply("../gateway", False)
    self.assertEqual(calls, [])
    self.write_image_metadata("AI_TRADING_IMAGE_TAG=bad-tag\n")
    with self.assertRaises(RuntimeFailure): runtime.apply("vibe-trading", True)
    self.assertEqual(calls, [])

def test_missing_run_credentials_uses_shared_preparer(self):
    runtime = self.runtime()
    self.assertFalse(self.runtime_env.exists())
    self.assertTrue(runtime.prepare_mirofish())
    self.assertEqual(self.preparer_calls, 1)
    self.assertEqual(stat.S_IMODE(self.runtime_env.stat().st_mode), 0o600)
```

Fixture helpers create actual fake image/config/env metadata under one external
temporary root and return `subprocess.CompletedProcess(argv, 0, stdout="")`;
no real service command runs. Add Docker-query failure, command timeout/failure,
partial group/unhealthy member, healthy/none-healthcheck and stopped convergence
tests. Empty Docker output can mean absent; a nonzero command is an error.

- [ ] **2. Run RED.**
`python3 -m unittest discover -s ai-trading/control -p test_runtime.py -v`.
Expected: missing Runtime/import failures.

- [ ] **3. Implement only fixed subprocess lists.**

```python
base = ["docker", "compose", "--project-name", "ai-trading",
        "--env-file", str(app_dir / "images.env"),
        "-f", str(app_dir / "docker-compose.yml"),
        "-f", str(app_dir / "docker-compose.mirofish.yml")]
start = base + ["up", "-d", "--no-deps", "--no-build", "--pull", "never",
                "--wait", "--wait-timeout", "300", *services]
stop = base + ["stop", "--timeout", "60", *services]
```

Validate image metadata full 40-character hexadecimal SHA, plain-file/root
ownership and fixed registry/paths;
do not source an env file as shell code. Query actual container IDs by exact
Compose project/service labels, then inspect **only** status/health metadata.
Use command timeouts (query 5s, stop 75s, start 330s), `shell=False`, and capture
stdout/stderr without returning/logging raw output. Missing local images returns
`image_missing`; helper never logs into GHCR or pulls a caller-selected image.
Use a sanitized subprocess environment containing only fixed PATH, validated
deployed metadata and the fixed secrets/runtime directories; never inherit
`COMPOSE_PROFILES`, `COMPOSE_FILE`, `DOCKER_HOST` or caller-controlled image/env
overrides. Include the existing Caddyfile hash convention when parsing Compose.

`group_status` reports Running only when every mapped service runs and is healthy
(or has no configured healthcheck), Stopped only for desired-Off with every
mapped service stopped/absent, and Needs setup for desired-On MiroFish lacking
validated config. `public_state` overlays matching active Starting/Stopping, then
uses saved Error for a non-converged group with a failed result; otherwise drift
is Unhealthy. Docker-query failure raises RuntimeFailure, not an empty container
set. A GET batches all mapped service observations under one 5s query budget;
operation polling never acquires the lifecycle lock.

Extract the existing MiroFish function definitions unchanged into
`mirofish-runtime.sh`: `mirofish_env_valid`,`file_mode_octal`,
`cleanup_mirofish_scratch`,`restore_or_remove_mirofish`,`activate_mirofish`.
Declare their existing tracking globals once there. `deploy.sh` sources the
library before its main-flow marker and retains its deployment policy wrapper.
Standalone `prepare-mirofish.sh` sets `MIROFISH_ACTIVATE=1`, validates the deployed
image metadata, defines the fixed `compose` wrapper, sources that same library,
then calls `activate_mirofish`. Its recovery callback uses mapped `compose stop`
only (not container removal); file backup/self-heal remains shared. Preserve
every checked cleanup/install and test fault-injection contract; don't replace
them with unchecked `set -e` behavior inside `|| true`.
The preparer must participate in the same lifecycle lease. A helper worker passes
its descriptor through `pass_fds` and a fixed internal `--lock-fd` argument;
the script validates it with `validate_inherited_lock`. A root operator invocation
without a descriptor acquires the lock itself with a bounded wait. The deploy
already owns FD 9 when it calls the extracted library directly. Never try to
acquire a second independent lock inside a worker which already owns one.

Update source-library fake fixtures to copy/source the new library before the
deploy functions. Run the **entire** existing Firestore/rollback suite, including
real-Compose first-bootstrap and permission-failure cases. If extraction breaks
a safety assertion, fix the extraction rather than delete/relax the test.

- [ ] **4. Run GREEN and commit.**

```bash
python3 -m unittest discover -s ai-trading/control -p test_runtime.py -v
ai-trading/deploy/ci/test-deploy-firestore.sh
shellcheck ai-trading/deploy/production/{deploy,mirofish-runtime,prepare-mirofish}.sh
git add ai-trading/control/runtime.py ai-trading/control/test_runtime.py ai-trading/deploy/production/mirofish-runtime.sh ai-trading/deploy/production/prepare-mirofish.sh ai-trading/deploy/production/deploy.sh ai-trading/deploy/ci/test-deploy-firestore.sh
git commit -m "feat(ai-trading): fixed app runtime and shared MiroFish preparation"
```

## Task 3: Peer-checked Unix API, transitions and bounded errors

**Files:** create `control/server.py`,`test_server.py`. Consumes state/runtime;
produces Unix HTTP API, operation worker and boot reconciliation entrypoint.

- [ ] **1. Write failing tests against a real temporary Unix socket.**

```python
def test_wrong_peer_is_rejected_before_dispatch(self):
    server = self.start_server(allowed_uid=os.getuid() + 1)
    self.assert_connection_rejected(server, "/apps")
    self.assertEqual(self.runtime.calls, [])

def test_actor_schema_and_revision_fail_without_commands(self):
    for path, body, actor, expected in [
        ("/apps/mirofish", {"enabled": True, "expectedRevision": 0}, "", 403),
        ("/apps/gateway", {"enabled": False, "expectedRevision": 0}, "user_fixture", 404),
        ("/apps/mirofish", {"enabled": 1, "expectedRevision": 0}, "user_fixture", 400),
        ("/apps/mirofish", {"enabled": True, "expectedRevision": True}, "user_fixture", 400),
        ("/apps/mirofish", {"enabled": True, "expectedRevision": 0, "command": "evil"}, "user_fixture", 400),
        ("/apps/mirofish", {"enabled": True, "expectedRevision": 99}, "user_fixture", 409),
    ]:
        self.assertEqual(self.put(path, body, actor)[0], expected)
    self.assertEqual(self.runtime.calls, [])

def test_get_remains_responsive_while_worker_owns_lock(self):
    self.runtime.start_blocked = True
    code, body = self.put("/apps/mirofish", {"enabled": True, "expectedRevision": 0}, "user_fixture")
    self.assertEqual(code, 202)
    started = time.monotonic()
    code, state = self.get("/apps", "user_fixture")
    self.assertLess(time.monotonic() - started, 1)
    self.assertEqual(code, 200)
    self.assertEqual(self.app(state, "mirofish")["status"], "Starting")
    self.runtime.unblock()

def test_cookie_or_raw_authorization_is_not_a_helper_identity(self):
    self.assertEqual(self.get("/apps", actor="", extra_headers={"Cookie": "fixture", "Authorization": "Bearer fixture"})[0], 403)
```

Add same-operation retry, different concurrent request, converged no-op,
503 JSON response on internal failure, oversized/malformed body, socket
restart after stale inode, interrupted operation reconciliation, corrupt state
and safe audit-content tests. Helpers in `test_server.py` start the real server
with a fake Runtime and use `http.client.HTTPConnection` whose socket connects
with `AF_UNIX`; always shutdown/server_close in cleanup. Peer-credential tests
requiring `SO_PEERCRED` run inside Linux, never pass silently on unsupported OS.
Pin a stale same-operation retry to 409 and a retry with the current revision to
202/same UUID even while the worker owns the lock. Pin an unrelated change to
409, and a deployment-held lock without a matching operation to 503.

- [ ] **2. Run RED.**
`python3 -m unittest discover -s ai-trading/control -p test_server.py -v` on Linux;
expected missing server/API failure.

- [ ] **3. Implement this dispatch/security order.**

```python
class UnixServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    address_family = socket.AF_UNIX
    daemon_threads = True
    def server_bind(self):
        # HTTPServer.server_bind assumes an INET (host, port) address.
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = "local", 0
    def verify_request(self, request, address):
        pid, uid, gid = struct.unpack("3i", request.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        return uid == self.gateway_uid
```

Validate peer before constructing the HTTP handler. Public helper `/apps` routes
also require a nonempty, HTTP-safe verified actor ID (ASCII ID characters,
bounded length); authorization headers/cookies are not identity. Reject methods
other than GET/PUT, duplicate/extra payload fields, body >1024 bytes, unexpected
paths and encoded/path-like app IDs. Reject duplicate Content-Length and
Transfer-Encoding rather than guessing body framing; require JSON for PUT and
use a 5s connection/body read timeout. Override request logging so URL/header/body
content never enters logs. Internal `/gate/{id}` needs the same peer
check but no actor and supports GET only; its only data is availability.

For a PUT, open the lifecycle lock and attempt nonblocking exclusive flock.
If the lease is busy, read the atomic snapshot without changing it: stale
revision returns 409; current revision plus the same active choice returns that
operation's 202 snapshot; a different active choice returns 409; no matching
active operation returns 503. This branch never runs Compose or writes state.
Under an acquired lease: re-read/validate state, check revision,
apply `begin_change`, atomic-write, and transfer the lease to the operation
worker before returning 202. Same active choice returns its existing operation;
different/busy changes return a bounded conflict/busy response. Never release
the lease before the worker's Docker action and completion state write finish.
GET reads the atomic state and bounded actual-status query without acquiring the
exclusive operation lock. The worker always releases its own lease in `finally`.

Worker flow:

```python
error_code = "operation_failed"
try:
    if app_id == "mirofish" and enabled and not runtime.prepare_mirofish(lock_fd=lease.fileno()):
        error_code = "needs_setup"
    else:
        runtime.apply(app_id, enabled)
        error_code = None
except RuntimeFailure as error:
    error_code = error.code  # enum only, never raw command output
except Exception:
    error_code = "operation_failed"  # no raw exception/traceback in audit
finally:
    try:
        write_finished_matching_operation(operation_id, error_code)
    finally:
        release_owned_lease()
```

`write_finished_matching_operation` is server-owned glue using Task 1
`finish_change` and `atomic_write`; it refuses a superseded ID. Audit only fixed
app/actor/time/result/exit-code fields with a root-only rotating log (1 MiB,
three retained files). On server/worker failure return/log generic error types,
not tokens, environments or subprocess output. Reboot reconciliation uses the
same lease/runtime and desired snapshot; an already converged group is no-op.
If a completion-state write fails, release the lease but mark the helper's state
uncertain/503 until restart reconciliation; do not claim successful completion.
Boot reconciliation runs in a worker after the socket starts listening so it
cannot deadlock a deploy which waits for helper readiness while owning the lock.

- [ ] **4. Run all control tests GREEN and commit.**

```bash
docker run --rm --network none -v "$PWD/ai-trading:/app:ro" -w /app/control python:3.12-slim python -m unittest discover -s . -v
git add ai-trading/control/server.py ai-trading/control/test_server.py
git commit -m "feat(ai-trading): private peer-checked app control helper"
```

## Task 4: Fresh Clerk control auth and real-Caddy availability boundary

**Files:** modify `auth/src/server.js`,`server.test.js`, `production/Caddyfile`,
`docker-compose.yml`; add control cases to `deploy/ci/smoke-test.sh` or a separate
`test-app-controls-gateway.sh` invoked by it. Consumes helper private routes.
Also modify `deploy/local/docker-compose.override.yml` so its `gateway` has
`profiles: ["production-only"]`, matching its existing cloudflared exclusion.
The default local mock router must not mount the real host's control socket or
pretend to authorize controls. Linux control fixtures explicitly supply their
isolated socket mount and dummy services; local UI-only tests intercept API
requests rather than call a production helper.

- [ ] **1. Add RED auth tests using existing `withAuthServer/fullClaims`.**

```js
test("control auth never accepts a gateway cookie alone", async () => {
  await withAuthServer(ENV, async (port) => {
    const r = await fetch(`http://127.0.0.1:${port}/__auth/control-check`, {
      headers: {cookie: validCookie(), "x-forwarded-method": "GET"}
    });
    assert.equal(r.status, 401);
  });
});
test("control mutation rejects Origin before invoking verification", async () => {
  let called = false;
  await withAuthServer({...ENV, verifyToken: async () => { called = true; return {data: fullClaims()}; }}, async (port) => {
    const r = await fetch(`http://127.0.0.1:${port}/__auth/control-check`, {
      headers: {authorization: "Bearer fixture", "x-forwarded-method": "PUT", origin: "https://wrong.example.test"}
    });
    assert.equal(r.status, 403);
    assert.equal(called, false);
  });
});
test("valid control token returns its verified subject", async () => {
  await withAuthServer({...ENV, verifyToken: async () => ({data: fullClaims()})}, async (port) => {
    const r = await fetch(`http://127.0.0.1:${port}/__auth/control-check`, {
      headers: {authorization: "Bearer fixture", "x-forwarded-method": "PUT", origin: ALLOWED_ORIGIN}
    });
    assert.equal(r.status, 204);
    assert.equal(r.headers.get("x-verified-actor"), "user_123");
  });
});
```

Add missing/expired/bad-signature SDK refusal, wrong issuer/audience/party/email,
unsupported forwarded method, absent Origin, unsafe `sub`, and forged actor
header tests. Expiry/signature refusal must be exercised by verifier failure,
not an injected fake that ignores expiry.

- [ ] **2. Run RED.** `cd ai-trading/auth && npm ci && npm test`;
new endpoint tests fail with old 404 behavior.

- [ ] **3. Add the internal endpoint and Caddy literal route.**
`handleControlCheck` is GET-only (Caddy forward_auth uses GET), accepts original
method GET/PUT only, Origin-gates PUT first, parses Bearer, calls existing
`verifyClerkToken`, email-allowlists, rejects unsafe subject/header characters,
and returns 204 + `X-Verified-Actor`. It never falls back to cookies. Register
only `/__auth/control-check`; existing handlers remain unchanged.

```caddy
@controls path /__control/apps /__control/apps/*
handle @controls {
    route {
        request_header -X-Verified-Actor
        forward_auth auth:8181 {
            uri /__auth/control-check
            copy_headers X-Verified-Actor
        }
        uri strip_prefix /__control
        reverse_proxy unix//run/family-app/ai-trading-control/control.sock {
            header_up -Authorization
            header_up -Cookie
            transport http {
                dial_timeout 1s
                response_header_timeout 7s
            }
        }
    }
}
```

Availability insert after existing app auth, before each proxy/rewrite:

```caddy
forward_auth unix//run/family-app/ai-trading-control/control.sock {
    uri /gate/tradingagents
    header_up -Authorization
    header_up -Cookie
    transport http {
        dial_timeout 1s
        response_header_timeout 7s
    }
}
```

Use the fixed relevant ID for **every** app path: both TA terminal/research
paths and dedicated host; AHF host/hub route; whole Vibe host; MiroFish `/api/*`.
Do not accidentally gate `/__auth/*`, `/__control/*`, static Hub or health route
on an upstream app. Preserve research prefix/header stripping and redirects.
The helper's 503 availability body is actionable fixed JSON:
`{"error":"app_unavailable","message":"Open Trading Hub Settings to start the app or check its status."}`.
Socket connection/timeout failures are Caddy errors (normally 502), not this
body; install this site-level error block in each relevant HTTP site:

```caddy
handle_errors 502 503 {
    header Content-Type application/json
    header Cache-Control no-store
    respond `{"error":"service_unavailable","message":"Trading service unavailable. Open Trading Hub Settings or try again."}` 503
}
```

Do not convert explicit 401/403 or login redirects. The internal auth-check
must not be reachable through the existing broad `/__auth/*` forwarding block:
replace that block with an exact public auth-path matcher for session/check/
logout, leaving `/__auth/control-check` externally 404. Add those route assertions.

Gateway Compose uses `user: "22001:22001"`, read-only host socket-directory bind,
private writable `/config` and `/data` tmpfs owned by 22001 as needed, existing
networks unchanged, and no `depends_on` that starts ta-research. Its image remains
the existing Caddy image; no Docker socket/network to host helper is introduced.

Real-Caddy tests must prove: valid token copies **verified** actor to helper;
client actor spoof overwritten; missing token/cookie-only denied; original PUT
Origin checked; request body preserved by forward_auth; helper sees neither
Authorization nor Cookie; private gate isn't public; stopped app yields 503
after normal authentication; unauthenticated request stays 401/redirect; wrong
Unix UID rejected; no peer gains access to research via its old terminal network.

- [ ] **4. Run GREEN and commit.**

```bash
(cd ai-trading/auth && npm test)
ai-trading/deploy/ci/test-app-controls-gateway.sh
git add ai-trading/auth/src/server.js ai-trading/auth/src/server.test.js ai-trading/deploy/production/Caddyfile ai-trading/deploy/production/docker-compose.yml ai-trading/deploy/local/docker-compose.override.yml ai-trading/deploy/ci/test-app-controls-gateway.sh ai-trading/deploy/ci/smoke-test.sh
git commit -m "feat(ai-trading): fresh Clerk auth and gateway app availability checks"
```

## Task 5: Linux installation and transaction-safe deployment/reboot

**Files:** create `infrastructure/vps/app-controls/install.sh`,
`ai-trading-control.service`; modify `deploy.sh`,`health-check.sh`,
`test-deploy-firestore.sh`, `.github/workflows/ai-trading-deploy.yml`.
Consumes catalog, state CLI, helper/runtime and MiroFish preparation artifacts.

- [ ] **1. Add failing fake-command tests before wiring.**
Extend existing deployment fixtures with valid preferences and control artifacts.
Assert exact selected-service lists, not a blanket up. Tests include:

```python
def test_service_selection_omits_both_ta_members_when_off(self):
    s = initial_state(None)
    s["desired"]["tradingagents"] = False
    selected = selected_services(s, mirofish_ready=False)
    self.assertNotIn("ta-terminal", selected)
    self.assertNotIn("ta-research", selected)
    self.assertTrue(set(PROTECTED).issubset(selected))

def test_rollback_restores_preferences_without_lowering_revision(self):
    saved = initial_state(None)
    current, _ = begin_change(saved, "mirofish", True, 0, False)
    restored = restore_preferences(current, saved)
    self.assertEqual(restored["desired"], saved["desired"])
    self.assertGreater(restored["revision"], current["revision"])
```

Shell cases: main process waits on the same real lock while helper operation is
active; inherited FD CLI does not release it; GET doesn't block; config/secret
staging failure restores saved choices and old tag/config; disabled groups never
start on forward/recovery paths; missing/corrupt state aborts before mutation;
genuine first install adopts existing MiroFish, fresh host defaults are explicit.
Linux install fakes reject occupied UID, rootless/userns Docker, symlinked state
or socket directories and incomplete artifacts before installing/restarting.

- [ ] **2. Run RED.** Existing deploy suite plus
`ai-trading/deploy/ci/test-app-controls-deploy.sh` (new focused fake-Compose and
bootstrap cases) should fail the new selection/lock expectations.

- [ ] **3. Implement installation and coordinated deploy.**

```ini
[Unit]
Description=Family Trading Hub app controls
After=docker.service
Requires=docker.service
[Service]
Type=simple
User=root
Group=ai-trading-gateway
RuntimeDirectory=family-app/ai-trading-control
RuntimeDirectoryMode=0710
RuntimeDirectoryPreserve=yes
ExecStart=/usr/bin/python3 /opt/family-app/ai-trading/control/server.py
Restart=on-failure
RestartSec=2
KillMode=control-group
UMask=0077
NoNewPrivileges=true
[Install]
WantedBy=multi-user.target
```

Installer runs locally on the target from versioned code (workflow stages it
over strict-known-host SSH). Validate Linux/systemd/Python/rootful Docker and the
fixed UID/GID first; create the non-login `ai-trading-gateway` identity without
Docker-group membership; create state dir root 0700 and socket dir root:22001
0710; socket mode 0660. Install root-owned helper/catalog/preparer/unit artifacts
atomically, initialize state explicitly, daemon-reload and enable service only
after validation. Re-run is idempotent and never resets an existing file.
Never delete/recreate the socket **directory** on helper restart: the gateway's
bind mount must keep the same directory inode. Replace only the verified stale
socket inode. systemd recreates the runtime directory after boot; the unit's
preserve setting keeps it stable during stop/restart. Validate this in Linux.
Keep reconciliation asynchronous while a deploy holds the lease; helper startup
must still serve authenticated read-only GET/status. Deployment success includes
`systemctl is-active ai-trading-control` and a private `/apps` GET from the
dedicated gateway identity, not just gateway `/__healthz`.

Workflow stages control/bootstrap artifacts (no provider keys) beside the
current config staging. Add owned helper/catalog/runtime artifacts to the same
validate/snapshot/atomic-config transaction; old deploy rollback must restore
the matching helper/runtime version as well as Compose/Caddy/health files. The
first activation cannot accept PUT while deployment owns the lock, so rollback
to the pre-controls baseline restores adopted preferences (including any app
already stopped at installation)
and the old gateway configuration without having accepted a new Off choice.
The new coordinator still performs explicit service selection on this rollback;
do not call the pre-controls blanket-up implementation or depend on its old
health script to preserve Off choices. If there was no old helper/unit, roll back
its activation as well; retain the adopted preference file for a safe retry.

Hold lifecycle lock FD 9 from before preference/config mutation through health
and commit/rollback; use bounded wait. Preserve disk guard/pruning before pulls.
Snapshot choices/tag under the lock; map MiroFish operator flags into the same
state. Stage/read configuration using existing root-only checked functions.
Pull known app images, then:

```bash
selected_text="$(python3 "$APP_DIR/control/state.py" services --mirofish-ready "$mirofish_ready")" || return 1
[[ -n "$selected_text" ]] || return 1
mapfile -t selected <<< "$selected_text"
compose up -d --no-deps --wait --wait-timeout 300 "${selected[@]}"
```

Stop explicitly disabled group services with fixed 60s timeout; don't remove
their volumes or let dependency up revive them. `health-check.sh` obtains the
same effective selected list and still checks the always-on tunnel readiness.
Do not use process substitution for fallible service selection: `mapfile < <(...)`
hides the Python exit status. Do not retain `--remove-orphans`: this phase has no
removed service definitions and stopped/profiled app containers must remain.
MiroFish known setup failure is excluded with Needs setup; a configured enabled
MiroFish that exits remains a failing health obligation. Restore snapshots with
a **new monotone revision**, old tag, credentials and config on failure.
Keep a run-owned copy of the new coordinator/state CLI in root-only deployment
scratch until commit/rollback finishes: a rollback to a pre-controls artifact set
must not delete the very driver still needed to restore/select saved choices.
Compile staged Python source without executing it, validate catalog JSON against
its exact schema, validate scripts with `bash -n`, and validate the installed
unit with `systemd-analyze verify` before activating it. Add
`infrastructure/vps/app-controls/**` to this app's CI/deploy path filters so an
installer-only fix still runs the relevant checks and deploys through code.

Boot/helper restart reconciles preferences using the same runtime and lock;
interrupted operation is resolved from actual state or reported interrupted,
never overwritten with fresh defaults. `/run` MiroFish env regeneration is shared.

- [ ] **4. Run GREEN and commit.**

```bash
ai-trading/deploy/ci/test-deploy-firestore.sh
ai-trading/deploy/ci/test-app-controls-deploy.sh
shellcheck infrastructure/vps/app-controls/install.sh ai-trading/deploy/production/{deploy,health-check}.sh
actionlint .github/workflows/ai-trading-deploy.yml
git add infrastructure/vps/app-controls ai-trading/deploy/production/deploy.sh ai-trading/deploy/production/health-check.sh ai-trading/deploy/ci/test-deploy-firestore.sh ai-trading/deploy/ci/test-app-controls-deploy.sh .github/workflows/ai-trading-deploy.yml
git commit -m "feat(ai-trading): persistent app choices through deploy and reboot"
```

## Task 6: Settings UI, shared polling and stopped launchers

**Files:** create `frontend/lib/controls.ts`,`controls.test.ts`,
`components/app-controls-provider.tsx`,`app-controls-panel.tsx`,
`app/settings/page.tsx`; modify `page-shell.tsx`,`workspace-sidebar.tsx`,
`header.tsx`/mobile menu, `app-card.tsx`/detail guidance, test scripts and
`deploy/ci/upload-hub-static.sh`/`.test.sh` allowlist.
Consumes exact public DTO/API; no Docker/host details in the browser.

- [ ] **1. Add failing Node tests.**

```ts
function controlsFixture(revision = 0): ControlsState {
  return {
    revision, lastChangedAt: null,
    apps: (["tradingagents", "ai-hedge-fund", "vibe-trading", "mirofish"] as AppId[]).map((id) => ({
      id, enabled: id !== "mirofish", status: id === "mirofish" ? "Stopped" : "Running",
      changedAt: null, operationId: null, errorCode: null,
    })),
  };
}
test("mutation sends bearer, revision and boolean, never actor/command", async () => {
  let call: {url: string; init: RequestInit} | undefined;
  await changeApp("mirofish", false, 7, async () => "fixture-token", async (url, init) => {
    call = {url: String(url), init: init!};
    const state = controlsFixture(8);
    Object.assign(state.apps[3], {status: "Stopping", operationId: "00000000-0000-4000-8000-000000000000"});
    return new Response(JSON.stringify(state), {status: 202});
  });
  assert.equal(call!.url, "/__control/apps/mirofish");
  assert.equal(new Headers(call!.init.headers).get("authorization"), "Bearer fixture-token");
  assert.deepEqual(JSON.parse(String(call!.init.body)), {enabled: false, expectedRevision: 7});
});
test("missing token makes no request and stale state is explicit", async () => {
  let called = false;
  await assert.rejects(changeApp("mirofish", true, 0, async () => null,
    async () => {called = true; return new Response();}), /sign in/i);
  assert.equal(called, false);
  await assert.rejects(changeApp("mirofish", true, 0, async () => "fixture",
    async () => new Response("{}", {status: 409})), /changed|refresh/i);
});
```

`changeApp(id, enabled, revision, getToken, fetchImpl=fetch):
Promise<ControlsState>` and `fetchApps(getToken, fetchImpl=fetch):
Promise<ControlsState>` are the exact lib exports. GET accepts 200 only; PUT
accepts 200/202 only, both with the full JSON snapshot (204 is invalid).
Validate responses/known IDs,
revision and status before updating UI. Test 401/403/503/network/invalid JSON,
unknown/duplicate/missing app IDs, unknown status/error codes, negative/bool-like
revision, cancellation and unsupported response codes. Cancellation uses an
optional `signal?: AbortSignal` final argument on both helpers, passed to fetch;
provider cancels the previous read before issuing a new one and ignores aborted
results instead of letting stale responses overwrite newer snapshots.

- [ ] **2. Run RED.** Add `lib/controls.test.ts` to existing `pnpm test`, run it
and observe missing module/helper failures.

- [ ] **3. Build UI from the existing theme and semantics.**
One `AppControlsProvider` inside the authenticated PageShell owns fetching,
refresh and timers (30s idle, 2s during transition, also focus refresh); it clears
timers/in-flight work on unmount/session switch. Don't fetch separately per card.
Use `useAuth().getToken` for every call; don't cache bearer tokens in storage.
Provider exposes `{state, loading, error, refresh, change}`. Unknown/unavailable
state never displays Running or silently rewrites a previous valid preference.

Settings page header “App controls”, explanatory shared-impact note, Refresh,
and four rows from the validated state. Each switch has accessible name and
checked state, 44px minimum hit area and text status; use normal focus rings and
reduced-motion behavior. A stop uses a confirmation dialog with app-specific
interruption text and Cancel/Stop; close restores trigger focus. Retry reconciles
the existing desired choice for a failed operation, never an opposite toggle.
A retry of desired-Off uses the same Stop confirmation because a failed stop
may have left work running. Handle 409 by refreshing and explaining the
other change; never overwrite using an unconditionally newer revision.

```tsx
<button type="button" role="switch" aria-checked={app.enabled}
  aria-label={`${app.enabled ? "Stop" : "Start"} ${label}`}
  disabled={busy}
  onClick={() => app.enabled ? confirmStop(app.id) : change(app.id, true)}>
  <span aria-hidden>{app.enabled ? "On" : "Off"}</span>
</button>
```

`confirmStop` is panel-owned state opening the labeled confirmation dialog, not
an immediate request. A canceled confirmation makes no mutation. For stopped
apps, card/detail replaces launch CTA with `/settings` guidance while keeping
capability/description and read-only data visible. Settings/navigation does not
make planned Desk launchable or expose helper/peer metadata.

Add exact static-export paths `settings.html`,`settings.txt`, and
`settings/__next._tree.txt`,`__next._full.txt`,`__next._index.txt`,
`__next.settings.__PAGE__.txt` to uploader/checks. No wildcard for unknown routes.
Update synthetic uploader fixtures and export tests to cover known Settings and
unknown settings-like file rejection with component MIME/no-store.
Inspect the actual `pnpm build` output before finalizing those exact objects:
Next's segment filenames are build output, not a guessed routing API. Extend
`export-layout.test.mjs` for Settings while retaining its Clerk loading-shell
expectation. Keep `/settings` in the existing dynamic Worker/static-object
resolver model: `hub-router.js` already maps it to `settings.html` and forwards
`/__control/*`; no Worker rewrite or duplicate backend route is needed.

- [ ] **4. Run GREEN and commit.**

```bash
(cd ai-trading/frontend && pnpm test && pnpm typecheck && pnpm lint && pnpm build && pnpm test:export)
ai-trading/deploy/ci/upload-hub-static.test.sh
git add ai-trading/frontend/lib/controls.ts ai-trading/frontend/lib/controls.test.ts ai-trading/frontend/components/app-controls-provider.tsx ai-trading/frontend/components/app-controls-panel.tsx ai-trading/frontend/app/settings/page.tsx ai-trading/frontend/components/page-shell.tsx ai-trading/frontend/components/workspace-sidebar.tsx ai-trading/frontend/components/header.tsx ai-trading/frontend/components/apps-menu.tsx ai-trading/frontend/components/app-card.tsx ai-trading/frontend/components/terminal-frame.tsx 'ai-trading/frontend/app/apps/[slug]/page.tsx' ai-trading/frontend/package.json ai-trading/frontend/export-layout.test.mjs ai-trading/deploy/ci/upload-hub-static.sh ai-trading/deploy/ci/upload-hub-static.test.sh
git commit -m "feat(ai-trading): authenticated settings switches and stopped launchers"
```

Use a syntactically valid fake publishable key for offline CI builds and the
Firestore-provided public key for local authenticated QA; never an env file in
the repo. Browser checks cover confirmation/cancel, starting/error/retry,
409/refresh, dual-user changes, mobile 375/390/768/1440, keyboard/focus and
unavailable helper. Use fake isolated services for stop/start, not production.

## Task 7: Full integration, security review and docs

**Files:** new CI shell tests from Tasks 3–5; modify `ai-trading-ci.yml`,
`deploy/ci/smoke-test.sh`, production runbook and small/additive AGENTS/STATUS.

- [ ] **1. Add Linux CI execution.** Run state/runtime tests directly; peer tests
and real-Caddy tests in an isolated Linux fixture with unique project/socket/data
volumes and dummy services. No production socket, real Docker daemon mount into
the fixture helper, provider keys or expense resources.

```yaml
- name: Test private app controls
  run: python3 -m unittest discover -s ai-trading/control -v
- name: Test app controls through real Caddy and deploy fakes
  run: |
    ai-trading/deploy/ci/test-app-controls-gateway.sh
    ai-trading/deploy/ci/test-app-controls-deploy.sh
```

Keep these steps in the relevant existing Ubuntu scripts/Hub jobs; do not create
an unrelated workflow or paid runner. Fixture scripts trap cleanup of their own
project only and never invoke global pruning. Continue running the full smoke
suite after image builds as required by project rules.
- [ ] **2. Prove the external boundary.** A Linux non-gateway UID client (same
socket group, so it can connect) is rejected by `SO_PEERCRED`; real Caddy UID
22001 succeeds; malformed body/header/Origin/cookie-only/expired SDK verifier
response cannot invoke fake Compose; only exact allowed IDs execute; helper-down
requests return 503; auth-before-availability remains true; private gate paths
stay unreachable externally. Count/compare volumes and unaffected dummy service
IDs before/after each operation.
- [ ] **3. Prove deploy/reboot.** Simulate helper restart and transient MiroFish
`/run` loss; state choices persist, shared services stay required, stopped TA
research never starts through gateway dependencies, and a failed new tag/config
restores prior choices/tag/config using an increased revision. The child state
CLI cannot accidentally unlock inherited deploy FD 9.
- [ ] **4. Full verification:**

```bash
docker buildx bake -f ai-trading/deploy/docker-bake.hcl --load
ai-trading/deploy/ci/smoke-test.sh all
ai-trading/deploy/ci/test-deploy-firestore.sh
ai-trading/deploy/ci/test-app-controls-deploy.sh
ai-trading/deploy/ci/test-app-controls-gateway.sh
docker run --rm --network none -v "$PWD/ai-trading:/app:ro" -w /app/control python:3.12-slim python -m unittest discover -s . -v
(cd ai-trading/auth && npm test)
(cd ai-trading/frontend && pnpm test && pnpm typecheck && pnpm lint && pnpm build && pnpm test:export)
ai-trading/deploy/ci/upload-hub-static.test.sh
actionlint .github/workflows/ai-trading-ci.yml .github/workflows/ai-trading-deploy.yml
```

Build/export prerequisites and app submodule pins follow AGENTS.md. Run shared
local Docker fixtures only when they cannot collide with another session's
containers; use unique fixture names or the isolated CI runner for full smoke.

- [ ] **5. Document** Settings behavior/shared cancellation, target bootstrap,
helper unavailable/drift recovery, state migration file, operator MiroFish flags,
temporary-host/no-backup scope, and no Docker-socket exposure. Update project
rules to reflect configurable upstream state rather than three always-on apps.
- [ ] **6. Fresh independent whole-branch review, especially privileged boundary
and rollback.** Fix Critical/Important findings with RED→GREEN. No unresolved
privilege, secret, state or deployment failure can be waived as a cosmetic issue.
Commit verified fixes/docs; no PR until the meaningful phase is complete.

## Task 8: Ship, bootstrap and verify production without interrupting work

- [ ] **1. Integrate and PR.** Merge current `origin/dev` in this worktree, repeat
affected checks, push feature branch, one PR to `dev`. Wait for the required and
phase-relevant checks (including full image/smoke) and merge with head SHA guard.
- [ ] **2. Scoped release.** Carry only this phase's app-specific paths and
`infrastructure/vps/app-controls`/workflow wiring from the verified dev commit
onto `origin/main`. Never merge all of dev or release Family Desk/expense code.
- [ ] **3. Bootstrap/deploy.** Use the scripted strict-known-host workflow through
the existing Firestore/deploy profile. Preserve current MiroFish state. The
helper installation and Caddy UID/config transition are coordinated under the
same lock/rollback transaction. Verify disk guard after normal scoped image
pruning; don't lower 30 GiB to force a release or delete app/expense data.
- [ ] **4. Static upload after backend is ready.** Publish the Hub export with
`upload_hub_static=true`. No controls UI before helper/auth/gateway readiness.
- [ ] **5. Non-disruptive live checks:** authenticated GET returns four truthful
groups; cookie-only/wrong-origin/forged actor calls reject; a converged same-state
PUT performs no Docker action; preferences match the adopted current state;
healthy shared/app services and all volume IDs are unchanged; real terminal and
research routes still work. Account/sign-out remains functional.
- [ ] **6. Stop/start test needs its own confirmation.** Ask the owner for the app
and quiet window, explaining active work ends for both users. If none is approved,
report production GET/no-op verification and isolated stop/start evidence without
pretending a production toggle was tested. Never reboot the shared VPS as a demo.
- [ ] **7. Record** merged/release/deploy references and current state in the
handoff/STATUS (docs ride next batch if needed), preserve secrets outside the
repo, remove only own merged worktrees/branches. Main checkout remains reserved.

## Execution handoff

### Plan self-review

- [x] Spec coverage: design sections 1–2 → Tasks 1–5; section 3 → Task 6;
  sections 4–5 → Tasks 3–4/7; section 6 → Tasks 1–3/5/7; section 7 → Task 5/8
  and Global Constraints; section 8 → Tasks 7–8.
- [x] Placeholder scan: no TBD/TODO/deferred code steps; fixed contracts, files,
  code examples, RED/GREEN commands and rollout gates are specified.
- [x] Type/response consistency: four-app snapshots, safe error enum, operation
  IDs, per-app failure retention, revision and owner/lock interfaces align.
- [x] Review Focus: each of the five failure classes has explicit test cases in
  its owning tasks, including busy-lock idempotency, first-activation rollback,
  helper outages, corrupted state and reboot-time MiroFish rendering.

Review this written plan before implementation. **Subagent-driven execution is
recommended** because the private root helper, bearer authorization, deployment
rollback and UI state cross multiple trust/lifecycle boundaries. Each task gets
its own fresh implementation/review gate; all work stays isolated, and one PR
carries the completed phase. Native execution is also available with inline TDD
and a fresh whole-branch security review at the end.
If subagents are chosen, integrate their isolated branches into this approved
app-controls feature branch, not the reserved main checkout/`feature/toby`.
