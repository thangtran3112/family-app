import http.client
import json
import os
import socket
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

import state
from runtime import RuntimeFailure
from server import ACTOR_HEADER, MAX_BODY_BYTES, UnixServer, create_server
from state import APP_IDS, APP_SERVICES, StateFailure, atomic_write, initial_state, read_state

LINUX_ONLY = "SO_PEERCRED peer-credential checks require Linux"


class FakeRuntime:
    """Duck-typed stand-in for runtime.Runtime's public interface. Tracks
    every call (used to assert "no Docker/Compose interaction happened" on
    rejected requests) and lets tests script status/failure/blocking
    behavior without a real subprocess or Docker daemon.
    """

    def __init__(self):
        self.calls = []
        self.lock = threading.Lock()
        self.running = set()
        self.needs_setup = set()
        self.unhealthy = set()
        self._start_blocked = False
        self._gate = threading.Event()
        self._gate.set()
        self.apply_failures = {}
        self.service_states_failure = None
        self.prepare_mirofish_result = True
        self.prepare_mirofish_lock_fds = []
        self.converged_override = {}

    @property
    def start_blocked(self):
        return self._start_blocked

    @start_blocked.setter
    def start_blocked(self, value):
        self._start_blocked = value
        if value:
            self._gate.clear()
        else:
            self._gate.set()

    def unblock(self):
        self._gate.set()

    def _running_services(self):
        services = set()
        for app_id in self.running:
            services.update(APP_SERVICES[app_id])
        return services

    def service_states(self, services):
        services = tuple(services)
        self.calls.append(("service_states", services))
        if self.service_states_failure is not None:
            raise self.service_states_failure
        running = self._running_services()
        return {
            service: {"status": "running", "health": "none"} if service in running
            else {"status": "exited", "health": None}
            for service in services
        }

    def group_status(self, app_id, enabled, observations=None):
        self.calls.append(("group_status", app_id, enabled))
        if app_id in self.needs_setup and enabled:
            return "Needs setup"
        if app_id in self.unhealthy:
            return "Unhealthy"
        is_running = app_id in self.running
        if enabled:
            return "Running" if is_running else "Unhealthy"
        return "Stopped" if not is_running else "Unhealthy"

    def converged(self, app_id, enabled):
        self.calls.append(("converged", app_id, enabled))
        if app_id in self.converged_override:
            return self.converged_override[app_id]
        return self.group_status(app_id, enabled) == ("Running" if enabled else "Stopped")

    def prepare_mirofish(self, lock_fd=None):
        self.calls.append(("prepare_mirofish", lock_fd))
        self.prepare_mirofish_lock_fds.append(lock_fd)
        return self.prepare_mirofish_result

    def apply(self, app_id, enabled):
        self.calls.append(("apply", app_id, enabled))
        if self.start_blocked:
            self._gate.wait(timeout=5)
        failure = self.apply_failures.pop(app_id, None)
        if failure is not None:
            raise failure
        with self.lock:
            if enabled:
                self.running.add(app_id)
            else:
                self.running.discard(app_id)


class UnixHTTPConnection(http.client.HTTPConnection):
    """http.client.HTTPConnection whose socket connects over AF_UNIX."""

    def __init__(self, socket_path, timeout=5):
        super().__init__("localhost", timeout=timeout)
        self._socket_path = str(socket_path)

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self._socket_path)


@unittest.skipUnless(sys.platform == "linux", LINUX_ONLY)
class ServerTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        root = Path(self._tmp.name)
        self.socket_dir = root / "sock"
        self.socket_dir.mkdir()
        self.socket_path = self.socket_dir / "control.sock"
        self.state_path = root / "control.json"
        self.lock_path = root / ".control.lock"
        self.audit_log_path = root / "audit.log"
        atomic_write(self.state_path, initial_state(None))
        self.runtime = FakeRuntime()
        self.servers = []

    def tearDown(self):
        for server in self.servers:
            server.shutdown()
            server.server_close()

    # -- test harness -------------------------------------------------

    def start_server(self, allowed_uid=None, socket_path=None, runtime=None, state_path=None, lock_path=None):
        server = create_server(
            socket_path if socket_path is not None else self.socket_path,
            state_path if state_path is not None else self.state_path,
            lock_path if lock_path is not None else self.lock_path,
            runtime if runtime is not None else self.runtime,
            gateway_uid=allowed_uid if allowed_uid is not None else os.getuid(),
            audit_log_path=self.audit_log_path,
        )
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.servers.append(server)
        return server

    def request(self, method, path, body=None, actor=None, extra_headers=None, socket_path=None):
        conn = UnixHTTPConnection(socket_path if socket_path is not None else self.socket_path)
        headers = dict(extra_headers or {})
        if actor is not None:
            headers[ACTOR_HEADER] = actor
        payload = None
        if body is not None:
            payload = json.dumps(body).encode("utf-8")
            headers["Content-Length"] = str(len(payload))
        try:
            conn.connect()
            conn.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
            for name, value in headers.items():
                conn.putheader(name, value)
            try:
                conn.endheaders(payload)
            except (BrokenPipeError, ConnectionResetError):
                # The server may reject the request (e.g. wrong method/path)
                # before the client finishes writing a small body, and
                # close its side first -- its response is still readable.
                pass
            resp = conn.getresponse()
            raw = resp.read()
            parsed = json.loads(raw) if raw else None
            return resp.status, parsed
        finally:
            conn.close()

    def get(self, path, actor=None, extra_headers=None, socket_path=None):
        return self.request("GET", path, actor=actor, extra_headers=extra_headers, socket_path=socket_path)

    def put(self, path, body, actor=None, extra_headers=None, socket_path=None):
        return self.request("PUT", path, body=body, actor=actor, extra_headers=extra_headers, socket_path=socket_path)

    def assert_connection_rejected(self, server, path):
        conn = UnixHTTPConnection(server.socket_path)
        with self.assertRaises((http.client.RemoteDisconnected, ConnectionResetError, BrokenPipeError, OSError)):
            conn.request("GET", path, headers={ACTOR_HEADER: "user_fixture"})
            conn.getresponse()
        conn.close()

    @staticmethod
    def app(state_payload, app_id):
        return next(a for a in state_payload["apps"] if a["id"] == app_id)

    def wait_until(self, predicate, timeout=5):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate():
                return
            time.sleep(0.01)
        self.fail("condition was never satisfied")

    def wait_for_operation_to_clear(self, timeout=5):
        def _finished():
            operation = read_state(self.state_path)["operation"]
            return operation is None or operation["status"] not in state.ACTIVE_STATUSES

        self.wait_until(_finished, timeout=timeout)

    # -- peer credential gate -------------------------------------------------

    def test_wrong_peer_is_rejected_before_dispatch(self):
        server = self.start_server(allowed_uid=os.getuid() + 1)
        self.assert_connection_rejected(server, "/apps")
        self.assertEqual(self.runtime.calls, [])

    def test_correct_peer_is_accepted(self):
        self.start_server(allowed_uid=os.getuid())
        code, _body = self.get("/apps", actor="user_fixture")
        self.assertEqual(code, 200)

    # -- actor / body schema / revision -------------------------------------------------

    def test_actor_schema_and_revision_fail_without_commands(self):
        self.start_server()
        for path, body, actor, expected in [
            ("/apps/mirofish", {"enabled": True, "expectedRevision": 0}, "", 403),
            ("/apps/gateway", {"enabled": False, "expectedRevision": 0}, "user_fixture", 404),
            ("/apps/mirofish", {"enabled": 1, "expectedRevision": 0}, "user_fixture", 400),
            ("/apps/mirofish", {"enabled": True, "expectedRevision": True}, "user_fixture", 400),
            ("/apps/mirofish", {"enabled": True, "expectedRevision": 0, "command": "evil"}, "user_fixture", 400),
            ("/apps/mirofish", {"enabled": True, "expectedRevision": 99}, "user_fixture", 409),
        ]:
            with self.subTest(path=path, body=body, actor=actor):
                self.assertEqual(self.put(path, body, actor)[0], expected)
        self.assertEqual(self.runtime.calls, [])

    def test_cookie_or_raw_authorization_is_not_a_helper_identity(self):
        self.start_server()
        code, _body = self.get(
            "/apps", actor="", extra_headers={"Cookie": "fixture", "Authorization": "Bearer fixture"},
        )
        self.assertEqual(code, 403)
        self.assertEqual(self.runtime.calls, [])

    def test_unexpected_method_and_path_are_rejected(self):
        self.start_server()
        code, _body = self.request("DELETE", "/apps", actor="user_fixture")
        self.assertEqual(code, 405)
        code, _body = self.request("PUT", "/apps", body={"enabled": True, "expectedRevision": 0}, actor="user_fixture")
        self.assertEqual(code, 405)
        code, _body = self.request("GET", "/apps/mirofish", actor="user_fixture")
        self.assertEqual(code, 405)
        code, _body = self.request("PUT", "/gate/mirofish", body={}, actor="user_fixture")
        self.assertEqual(code, 405)
        code, _body = self.get("/does-not-exist", actor="user_fixture")
        self.assertEqual(code, 404)
        code, _body = self.put("/apps/../mirofish", {"enabled": True, "expectedRevision": 0}, "user_fixture")
        self.assertEqual(code, 404)
        self.assertEqual(self.runtime.calls, [])

    # -- concurrency: GET stays responsive while a PUT owns the worker lease --------------

    def test_get_remains_responsive_while_worker_owns_lock(self):
        self.start_server()
        self.runtime.start_blocked = True
        code, body = self.put("/apps/mirofish", {"enabled": True, "expectedRevision": 0}, "user_fixture")
        self.assertEqual(code, 202)
        self.assertIsNotNone(self.app(body, "mirofish")["operationId"])
        started = time.monotonic()
        code, state_payload = self.get("/apps", "user_fixture")
        self.assertLess(time.monotonic() - started, 1)
        self.assertEqual(code, 200)
        self.assertEqual(self.app(state_payload, "mirofish")["status"], "Starting")
        self.runtime.unblock()
        self.wait_for_operation_to_clear()

    def test_same_operation_retry_returns_same_operation_while_worker_runs(self):
        self.start_server()
        self.runtime.start_blocked = True
        code, started_body = self.put("/apps/mirofish", {"enabled": True, "expectedRevision": 0}, "user_fixture")
        self.assertEqual(code, 202)
        operation_id = self.app(started_body, "mirofish")["operationId"]

        # Same choice, current revision: 202 with the SAME operation id.
        code, retry_body = self.put("/apps/mirofish", {"enabled": True, "expectedRevision": 1}, "user_fixture")
        self.assertEqual(code, 202)
        self.assertEqual(self.app(retry_body, "mirofish")["operationId"], operation_id)

        # Stale revision while busy: 409.
        code, _body = self.put("/apps/mirofish", {"enabled": True, "expectedRevision": 0}, "user_fixture")
        self.assertEqual(code, 409)

        # Different concurrent choice (different app) while busy: 409.
        code, _body = self.put("/apps/vibe-trading", {"enabled": False, "expectedRevision": 1}, "user_fixture")
        self.assertEqual(code, 409)

        self.runtime.unblock()
        self.wait_for_operation_to_clear()
        self.assertEqual(
            [call for call in self.runtime.calls if call[0] == "apply"],
            [("apply", "mirofish", True)],
        )

    def test_deploy_held_lock_without_matching_operation_is_503(self):
        self.start_server()
        external_fd = os.open(self.lock_path, os.O_CREAT | os.O_RDWR, 0o600)
        import fcntl
        fcntl.flock(external_fd, fcntl.LOCK_EX)
        try:
            code, _body = self.put("/apps/mirofish", {"enabled": True, "expectedRevision": 0}, "user_fixture")
            self.assertEqual(code, 503)
        finally:
            fcntl.flock(external_fd, fcntl.LOCK_UN)
            os.close(external_fd)
        self.assertEqual(self.runtime.calls, [])

    # -- converged no-op -------------------------------------------------

    def test_converged_choice_is_a_no_op(self):
        self.start_server()
        # mirofish starts desired False; already-stopped group -> no-op.
        code, body = self.put("/apps/mirofish", {"enabled": False, "expectedRevision": 0}, "user_fixture")
        self.assertEqual(code, 200)
        self.assertEqual(self.app(body, "mirofish")["status"], "Stopped")
        self.assertEqual([call for call in self.runtime.calls if call[0] == "apply"], [])
        self.assertIsNone(read_state(self.state_path)["operation"])

    # -- 503 on internal failure / corrupt state -------------------------------------------------

    def test_corrupt_state_file_is_a_bounded_503(self):
        self.start_server()
        self.state_path.write_text("{not valid json")
        code, body = self.get("/apps", "user_fixture")
        self.assertEqual(code, 503)
        self.assertEqual(set(body), {"error", "message"})
        code, _body = self.put("/apps/mirofish", {"enabled": True, "expectedRevision": 0}, "user_fixture")
        self.assertEqual(code, 503)

    def test_runtime_query_failure_on_get_is_bounded_503_never_running_or_stopped(self):
        self.start_server()
        self.runtime.service_states_failure = RuntimeFailure("runtime_unavailable")
        code, body = self.get("/apps", "user_fixture")
        self.assertEqual(code, 503)
        self.assertEqual(body, {"error": "unavailable", "message": "service unavailable"})

    def test_completion_write_failure_marks_server_degraded_until_restart(self):
        server = self.start_server()
        real_atomic_write = state.atomic_write
        call_count = {"n": 0}

        def flaky_write(path, value, owner_uid=0):
            call_count["n"] += 1
            if call_count["n"] == 2:
                raise StateFailure("forced failure")
            return real_atomic_write(path, value, owner_uid=owner_uid)

        with mock.patch("server.atomic_write", side_effect=flaky_write):
            code, body = self.put("/apps/mirofish", {"enabled": True, "expectedRevision": 0}, "user_fixture")
            self.assertEqual(code, 202)
            self.wait_until(lambda: server._degraded.is_set())

        code, body = self.get("/apps", "user_fixture")
        self.assertEqual(code, 503)
        code, _body = self.put("/apps/vibe-trading", {"enabled": False, "expectedRevision": 1}, "user_fixture")
        self.assertEqual(code, 503)

    # -- oversized / malformed body -------------------------------------------------

    def test_oversized_body_is_rejected_without_running_compose(self):
        self.start_server()
        huge = {"enabled": True, "expectedRevision": 0, "padding": "x" * (MAX_BODY_BYTES + 200)}
        code, _body = self.put("/apps/mirofish", huge, "user_fixture")
        self.assertEqual(code, 413)
        self.assertEqual(self.runtime.calls, [])

    def test_malformed_json_body_is_400(self):
        self.start_server()
        conn = UnixHTTPConnection(self.socket_path)
        try:
            conn.request(
                "PUT", "/apps/mirofish", body=b"not json",
                headers={ACTOR_HEADER: "user_fixture", "Content-Type": "application/json"},
            )
            resp = conn.getresponse()
            self.assertEqual(resp.status, 400)
            resp.read()
        finally:
            conn.close()

    def _assert_rejected_before_body_accepted(self, build_request):
        """The server may reject bad framing either with an explicit 400
        (if it read the headers before the client finished writing) or by
        closing the connection out from under the client's write (if the
        server responded and closed first) -- both prove the malformed
        framing was never used to read a body or dispatch a command.
        """
        conn = UnixHTTPConnection(self.socket_path)
        try:
            conn.connect()
            try:
                build_request(conn)
                resp = conn.getresponse()
            except (BrokenPipeError, ConnectionResetError, http.client.RemoteDisconnected):
                return
            self.assertEqual(resp.status, 400)
            resp.read()
        finally:
            conn.close()

    def test_duplicate_content_length_is_rejected(self):
        self.start_server()

        def build(conn):
            conn.putrequest("PUT", "/apps/mirofish", skip_host=True, skip_accept_encoding=True)
            conn.putheader(ACTOR_HEADER, "user_fixture")
            conn.putheader("Content-Length", "2")
            conn.putheader("Content-Length", "2")
            conn.endheaders(b"{}")

        self._assert_rejected_before_body_accepted(build)
        self.assertEqual(self.runtime.calls, [])

    def test_transfer_encoding_is_rejected_rather_than_guessing_framing(self):
        self.start_server()

        def build(conn):
            conn.putrequest("PUT", "/apps/mirofish", skip_host=True, skip_accept_encoding=True)
            conn.putheader(ACTOR_HEADER, "user_fixture")
            conn.putheader("Transfer-Encoding", "chunked")
            conn.putheader("Content-Length", "2")
            conn.endheaders(b"{}")

        self._assert_rejected_before_body_accepted(build)
        self.assertEqual(self.runtime.calls, [])

    def test_duplicate_json_field_is_rejected(self):
        self.start_server()
        conn = UnixHTTPConnection(self.socket_path)
        raw_body = b'{"enabled": true, "expectedRevision": 0, "enabled": false}'
        try:
            conn.connect()
            conn.putrequest("PUT", "/apps/mirofish", skip_host=True, skip_accept_encoding=True)
            conn.putheader(ACTOR_HEADER, "user_fixture")
            conn.putheader("Content-Length", str(len(raw_body)))
            conn.endheaders(raw_body)
            resp = conn.getresponse()
            self.assertEqual(resp.status, 400)
            resp.read()
        finally:
            conn.close()
        self.assertEqual(self.runtime.calls, [])

    # -- internal /gate/{id} -------------------------------------------------

    def test_gate_requires_peer_but_not_actor_and_is_get_only(self):
        self.start_server()
        code, _body = self.get("/gate/tradingagents")  # no actor header at all
        self.assertIn(code, (204, 503))
        code, _body = self.request("PUT", "/gate/tradingagents", actor="user_fixture")
        self.assertEqual(code, 405)
        code, _body = self.get("/gate/does-not-exist")
        self.assertEqual(code, 404)

    def test_gate_reports_ready_only_when_desired_on_and_converged(self):
        self.start_server()
        # Desired off by default -> unavailable.
        code, _body = self.get("/gate/mirofish")
        self.assertEqual(code, 503)
        self.put("/apps/tradingagents", {"enabled": True, "expectedRevision": 0}, "user_fixture")
        self.wait_for_operation_to_clear()
        code, _body = self.get("/gate/tradingagents")
        self.assertEqual(code, 204)

    def test_gate_server_degraded_and_corrupt_state_are_503(self):
        server = self.start_server()
        server._degraded.set()
        code, _body = self.get("/gate/mirofish")
        self.assertEqual(code, 503)

    # -- audit log -------------------------------------------------

    def test_audit_log_contains_only_fixed_safe_fields(self):
        self.start_server()
        secret_text = "s3cr3t-token-value-should-never-leak"
        self.runtime.apply_failures["mirofish"] = RuntimeFailure("operation_failed", 7)
        self.runtime.apply_failures["mirofish"].args = (secret_text,)
        self.put("/apps/mirofish", {"enabled": True, "expectedRevision": 0}, "user_fixture")
        self.wait_for_operation_to_clear()
        content = self.audit_log_path.read_text()
        self.assertIn("app=mirofish", content)
        self.assertIn("actor=user_fixture", content)
        self.assertIn("result=operation_failed", content)
        self.assertIn("exitCode=7", content)
        self.assertNotIn(secret_text, content)
        self.assertNotIn("Traceback", content)
        # Root-only rotating log: owner-writable only.
        self.assertEqual(self.audit_log_path.stat().st_mode & 0o077, 0)

    # -- needs_setup worker path -------------------------------------------------

    def test_mirofish_enable_prepares_before_apply_using_same_lease(self):
        self.start_server()
        self.runtime.prepare_mirofish_result = False
        code, body = self.put("/apps/mirofish", {"enabled": True, "expectedRevision": 0}, "user_fixture")
        self.assertEqual(code, 202)
        self.wait_for_operation_to_clear()
        state_after = read_state(self.state_path)
        self.assertEqual(state_after["results"]["mirofish"]["errorCode"], "needs_setup")
        self.assertEqual([c for c in self.runtime.calls if c[0] == "apply"], [])
        self.assertEqual(len(self.runtime.prepare_mirofish_lock_fds), 1)
        self.assertIsInstance(self.runtime.prepare_mirofish_lock_fds[0], int)

    # -- boot/interrupted-operation reconciliation -------------------------------------------------

    def test_reconcile_clears_interrupted_operation_already_converged(self):
        stuck = initial_state(None)
        # Every app already matches the fake runtime's (empty) running set,
        # so only the interrupted mirofish operation needs normalizing --
        # nothing else triggers a fresh reconcile-driven operation.
        for app_id in APP_IDS:
            stuck["desired"][app_id] = False
        stuck["revision"] = 1
        stuck["operation"] = {
            "id": "11111111-1111-4111-8111-111111111111",
            "appId": "mirofish",
            "actorId": "user_fixture",
            "enabled": False,
            "status": "stopping",
            "startedAt": "2026-01-01T00:00:00Z",
            "finishedAt": None,
            "errorCode": None,
        }
        atomic_write(self.state_path, stuck)
        self.runtime.running = set()  # mirofish already converged (stopped)
        runtime = self.runtime
        server = create_server(
            self.socket_path, self.state_path, self.lock_path, runtime,
            gateway_uid=os.getuid(), audit_log_path=self.audit_log_path,
        )
        self.addCleanup(server.server_close)  # reconcile() runs synchronously here: never serve_forever()'d, so shutdown() would hang
        server.reconcile()
        final = read_state(self.state_path)
        self.assertIsNone(final["operation"])
        self.assertEqual(final["results"]["mirofish"]["errorCode"], "interrupted")
        self.assertEqual([c for c in runtime.calls if c[0] == "apply"], [])

    def test_reconcile_retries_a_non_converged_app_after_crash(self):
        stuck = initial_state(None)
        # Only vibe-trading is desired on; the others already match the
        # fake runtime's (empty) running set and need no action.
        for app_id in APP_IDS:
            stuck["desired"][app_id] = app_id == "vibe-trading"
        stuck["revision"] = 1
        stuck["operation"] = {
            "id": "22222222-2222-4222-8222-222222222222",
            "appId": "vibe-trading",
            "actorId": "user_fixture",
            "enabled": True,
            "status": "starting",
            "startedAt": "2026-01-01T00:00:00Z",
            "finishedAt": None,
            "errorCode": None,
        }
        atomic_write(self.state_path, stuck)
        runtime = self.runtime  # vibe-trading not in runtime.running -> not converged
        server = create_server(
            self.socket_path, self.state_path, self.lock_path, runtime,
            gateway_uid=os.getuid(), audit_log_path=self.audit_log_path,
        )
        self.addCleanup(server.server_close)  # reconcile() runs synchronously here: never serve_forever()'d, so shutdown() would hang
        server.reconcile()
        final = read_state(self.state_path)
        self.assertEqual(final["operation"]["status"], "complete")
        self.assertIsNone(final["results"]["vibe-trading"]["errorCode"])
        self.assertEqual([c for c in runtime.calls if c[0] == "apply"], [("apply", "vibe-trading", True)])

    def test_reconcile_runs_after_socket_already_listening(self):
        server = self.start_server()
        reconciled = threading.Event()
        real_reconcile = UnixServer.reconcile

        def tracking_reconcile(self):
            reconciled.set()
            return real_reconcile(self)

        with mock.patch.object(UnixServer, "reconcile", tracking_reconcile):
            thread = threading.Thread(target=server.reconcile, daemon=True)
            thread.start()
            # The socket must already accept connections before/while
            # reconcile is still running -- readiness never waits on it.
            code, _body = self.get("/apps", "user_fixture")
            self.assertEqual(code, 200)
            thread.join(timeout=5)
        self.assertTrue(reconciled.is_set())

    # -- stale socket handling -------------------------------------------------

    def test_stale_socket_file_is_replaced_on_restart(self):
        throwaway = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        throwaway.bind(str(self.socket_path))
        throwaway.close()  # leaves a dead socket inode: no listener behind it
        self.assertTrue(self.socket_path.exists())
        server = self.start_server()
        code, _body = self.get("/apps", "user_fixture")
        self.assertEqual(code, 200)
        self.assertEqual(server.socket_path, self.socket_path)

    def test_active_socket_is_never_replaced(self):
        server_a = self.start_server()
        code, _body = self.get("/apps", "user_fixture")
        self.assertEqual(code, 200)
        with self.assertRaises(Exception):
            create_server(
                self.socket_path, self.state_path, self.lock_path, FakeRuntime(),
                gateway_uid=os.getuid(), audit_log_path=self.audit_log_path,
            )
        # Server A must still be fully functional afterward.
        code, _body = self.get("/apps", "user_fixture")
        self.assertEqual(code, 200)
        self.assertIs(self.servers[-1], server_a)

    def test_non_socket_path_is_never_replaced(self):
        self.socket_path.write_text("not a socket")
        with self.assertRaises(Exception):
            self.start_server()
        self.assertEqual(self.socket_path.read_text(), "not a socket")


if __name__ == "__main__":
    unittest.main()
