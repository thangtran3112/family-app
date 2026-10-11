#!/usr/bin/env python3
"""Peer-checked private Unix HTTP API for Trading Hub app controls.

Only a process whose kernel `SO_PEERCRED` UID matches `gateway_uid` (fixed
production value: the Caddy gateway UID 22001) may complete a connection at
all -- `UnixServer.verify_request` runs before any HTTP parsing or handler
construction. Routes are `GET /apps`, `PUT /apps/{id}`, `GET /gate/{id}`; the
first two also require a verified actor identity forwarded by Caddy in the
`X-Verified-Actor` header (see `ACTOR_HEADER`) -- Caddy is expected to strip
any client-supplied copy of this header and set its own from a verified Clerk
session before forwarding. Cookies/Authorization headers are never consulted
as identity here; they belong to the public-facing auth layer, not this
private helper.

Usage (production entrypoint, owned by a later deployment task):

    server = create_server(socket_path, state_path, lock_path, runtime)
    threading.Thread(target=server.reconcile, daemon=True).start()
    server.serve_forever()

`reconcile()` MUST run on its own thread, started only after `create_server`
returns (the socket is already bound+listening by then) -- never before
`serve_forever()`, and never on the thread that calls it. Reconciliation
shares the same lifecycle lock Compose/deploy operations use and may block on
it for a long time (e.g. behind a concurrent deploy); running it before the
socket is reachable would let a deploy that is itself waiting for this
helper's readiness deadlock against its own held lock.
"""

import fcntl
import http.server
import json
import logging
import os
import socket
import socketserver
import stat
import struct
import threading
import time
import uuid
from logging.handlers import RotatingFileHandler
from pathlib import Path

from runtime import Runtime, RuntimeFailure
from state import (
    ACTIVE_STATUSES,
    ACTOR_ID,
    APP_IDS,
    APP_SERVICES,
    Busy,
    Conflict,
    LOCK_PATH,
    STATE_PATH,
    StateFailure,
    atomic_write,
    begin_change,
    finish_change,
    read_state,
    restore_preferences,
    validate_inherited_lock,
)

ACTOR_HEADER = "X-Verified-Actor"
MAX_BODY_BYTES = 1024
AUDIT_LOG_PATH = Path("/var/log/family-app/ai-trading-control/audit.log")

# Fixed production entrypoint targets (systemd's ExecStart runs this module
# with no arguments: no caller-configurable command, path, or admin flag).
SOCKET_PATH = Path("/run/family-app/ai-trading-control/control.sock")
APP_DIR = Path("/opt/family-app/ai-trading")
SECRETS_DIR = Path("/etc/family-app/ai-trading")
RUNTIME_DIR = Path("/run/family-app/ai-trading")

GATE_UNAVAILABLE_BODY = {
    "error": "app_unavailable",
    "message": "Open Trading Hub Settings to start the app or check its status.",
}

_ALLOWED_METHODS = {
    "apps-list": frozenset({"GET"}),
    "apps-item": frozenset({"PUT"}),
    "gate-item": frozenset({"GET"}),
}


class ServerFailure(RuntimeError):
    """The helper's own socket/process state is unsafe or unavailable."""


def _build_audit_logger(path):
    """Root-only rotating audit log (1 MiB, three retained files). Each
    entry logs only fixed app/actor/time/result/exit-code fields -- never
    raw exception text, subprocess output, tokens or environment values.
    """
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(path.parent, 0o700)
    fd = os.open(path, os.O_CREAT | os.O_WRONLY, 0o600)
    os.close(fd)
    logger = logging.getLogger(f"ai-trading-control-audit.{uuid.uuid4()}")
    logger.setLevel(logging.INFO)
    logger.propagate = False
    handler = RotatingFileHandler(path, maxBytes=1024 * 1024, backupCount=3)
    handler.setFormatter(logging.Formatter("%(asctime)s %(message)s"))
    logger.handlers = [handler]
    return logger


def _parse_put_body(raw):
    """Parse a PUT body as JSON with exactly `{enabled, expectedRevision}`.
    Returns None for malformed JSON, a non-object body, an unexpected/
    missing field, or a literal duplicate JSON key -- callers never guess
    which value a duplicate key means.
    """
    def _no_duplicate_pairs(pairs):
        seen = set()
        result = {}
        for key, value in pairs:
            if key in seen:
                raise ValueError("duplicate field")
            seen.add(key)
            result[key] = value
        return result

    try:
        parsed = json.loads(raw.decode("utf-8"), object_pairs_hook=_no_duplicate_pairs)
    except (json.JSONDecodeError, UnicodeDecodeError, ValueError):
        return None
    if type(parsed) is not dict or set(parsed) != {"enabled", "expectedRevision"}:
        return None
    return parsed


class _Handler(http.server.BaseHTTPRequestHandler):
    timeout = 5  # 5s connection/body read timeout

    def log_message(self, format, *args):  # noqa: A002 - stdlib signature
        # Never let URL/header/body content reach any log stream.
        pass

    def _route(self):
        path = self.path
        if path == "/apps":
            return "apps-list", None
        if path.startswith("/apps/"):
            return "apps-item", path[len("/apps/"):]
        if path.startswith("/gate/"):
            return "gate-item", path[len("/gate/"):]
        return None, None

    def _dispatch(self, method):
        try:
            family, app_id = self._route()
            if family is None:
                return self._error(404, "not_found", "unknown path")
            if app_id is not None and app_id not in APP_IDS:
                return self._error(404, "not_found", "unknown app")
            if method not in _ALLOWED_METHODS[family]:
                return self._error(405, "method_not_allowed", "method not allowed")
            actor = None
            if family in ("apps-list", "apps-item"):
                actor = self._verified_actor()
                if actor is None:
                    return self._error(403, "forbidden", "actor identity required")
            if family == "apps-list":
                return self._handle_list_apps()
            if family == "apps-item":
                return self._handle_put_app(app_id, actor)
            return self._handle_gate(app_id)
        except Exception:
            return self._error(503, "unavailable", "service unavailable")

    def do_GET(self):
        self._dispatch("GET")

    def do_PUT(self):
        self._dispatch("PUT")

    def do_POST(self):
        self._dispatch("POST")

    def do_DELETE(self):
        self._dispatch("DELETE")

    def do_PATCH(self):
        self._dispatch("PATCH")

    def do_HEAD(self):
        self._dispatch("HEAD")

    def _verified_actor(self):
        values = self.headers.get_all(ACTOR_HEADER)
        if not values or len(values) != 1:
            return None
        value = values[0]
        if not ACTOR_ID.fullmatch(value):
            return None
        return value

    def _validated_content_length(self):
        if self.headers.get_all("Transfer-Encoding"):
            return None
        values = self.headers.get_all("Content-Length")
        if not values or len(values) != 1:
            return None
        try:
            length = int(values[0])
        except ValueError:
            return None
        return length if length >= 0 else None

    def _handle_list_apps(self):
        status, payload = self.server.process_get()
        self._respond_json(status, payload)

    def _handle_put_app(self, app_id, actor):
        length = self._validated_content_length()
        if length is None:
            return self._error(400, "bad_request", "invalid request framing")
        if length > MAX_BODY_BYTES:
            return self._error(413, "payload_too_large", "request body too large")
        raw = self.rfile.read(length) if length else b""
        if len(raw) != length:
            return self._error(400, "bad_request", "request body truncated")
        body = _parse_put_body(raw)
        if body is None:
            return self._error(400, "bad_request", "invalid request body")
        status, payload = self.server.process_put(
            app_id, actor, body["enabled"], body["expectedRevision"],
        )
        self._respond_json(status, payload)

    def _handle_gate(self, app_id):
        status = self.server.process_gate(app_id)
        if status == 204:
            self._respond_empty(204)
        else:
            # Fixed, generic, actionable body only -- never which app,
            # container, environment, or identity detail caused it.
            self._respond_json(status, GATE_UNAVAILABLE_BODY)

    def _respond_json(self, code, payload):
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)
        self.close_connection = True

    def _respond_empty(self, code):
        self.send_response(code)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", "0")
        self.end_headers()
        self.close_connection = True

    def _error(self, code, error_code, message):
        self._respond_json(code, {"error": error_code, "message": message})


class UnixServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    address_family = socket.AF_UNIX
    daemon_threads = True

    def __init__(self, socket_path, state_path, lock_path, runtime, gateway_uid, audit_log_path):
        self.socket_path = Path(socket_path)
        self.state_path = Path(state_path)
        self.lock_path = Path(lock_path)
        self.runtime = runtime
        self.gateway_uid = gateway_uid
        self._degraded = threading.Event()
        self._audit_logger = _build_audit_logger(audit_log_path)
        super().__init__(str(self.socket_path), _Handler)

    def verify_request(self, request, address):
        try:
            creds = request.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)
            _pid, uid, _gid = struct.unpack("3i", creds)
        except OSError:
            return False
        return uid == self.gateway_uid

    def server_bind(self):
        # HTTPServer.server_bind assumes an INET (host, port) address.
        self._prepare_socket_path()
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = "local", 0
        # bind() creates a fresh inode every time, subject to the current
        # process umask (systemd's UMask=0077 would otherwise leave the
        # socket mode 0700 -- unreachable by the gateway group -- on every
        # restart; an installer's one-time chmod can't survive that). Fix
        # ownership/mode explicitly on every bind, not just at install time.
        # UID and GID are the same fixed dedicated identity (22001).
        try:
            os.chown(self.socket_path, 0, self.gateway_uid)
            os.chmod(self.socket_path, 0o660)
        except OSError as exc:
            raise ServerFailure(
                f"could not set root:gateway 0660 ownership on {self.socket_path}",
            ) from exc

    # -- socket path safety -------------------------------------------------

    def _prepare_socket_path(self):
        directory = self.socket_path.parent
        before = self._stat_directory(directory)
        if self.socket_path.exists() or self.socket_path.is_symlink():
            info = self.socket_path.lstat()
            if not stat.S_ISSOCK(info.st_mode):
                raise ServerFailure(f"refusing to replace a non-socket path at {self.socket_path}")
            probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            try:
                probe.connect(str(self.socket_path))
            except ConnectionRefusedError:
                pass  # stale: no listener behind this inode
            except OSError as exc:
                raise ServerFailure(
                    f"existing socket at {self.socket_path} could not be verified safe",
                ) from exc
            else:
                raise ServerFailure(f"refusing to replace an active socket at {self.socket_path}")
            finally:
                probe.close()
            os.unlink(self.socket_path)
        after = self._stat_directory(directory)
        if (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino):
            raise ServerFailure("socket directory changed during startup")

    @staticmethod
    def _stat_directory(directory):
        try:
            info = directory.lstat()
        except OSError as exc:
            raise ServerFailure(f"socket directory {directory} is unavailable") from exc
        if (
            not stat.S_ISDIR(info.st_mode)
            or stat.S_ISLNK(info.st_mode)
            or info.st_uid != 0
            or info.st_mode & 0o022
        ):
            raise ServerFailure(f"socket directory {directory} is unsafe")
        return info

    # -- lifecycle lock -------------------------------------------------

    def _acquire_lock(self):
        """Nonblocking exclusive lock attempt. Returns an open fd if the
        lock was acquired now, None if it is busy, or raises StateFailure
        if the lock path/descriptor itself is unsafe or unavailable.
        """
        try:
            try:
                fd = os.open(
                    self.lock_path,
                    os.O_CREAT | os.O_EXCL | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0),
                    0o600,
                )
                os.fchmod(fd, 0o600)
            except FileExistsError:
                fd = os.open(self.lock_path, os.O_RDWR | getattr(os, "O_NOFOLLOW", 0))
        except OSError as exc:
            raise StateFailure("lifecycle lock is unavailable") from exc
        try:
            validate_inherited_lock(fd, self.lock_path)
        except Busy:
            os.close(fd)
            return None
        except StateFailure:
            os.close(fd)
            raise
        return fd

    def _acquire_lock_blocking(self):
        while True:
            fd = self._acquire_lock()
            if fd is not None:
                return fd
            time.sleep(0.2)

    @staticmethod
    def _release_lease(fd):
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)

    # -- response payload -------------------------------------------------

    def _build_payload(self, state):
        """Status precedence (common-context): an active matching operation
        overlays everything. Otherwise the ACTUAL group status -- from one
        shared batch, never a per-app re-query -- is authoritative: "Needs
        setup" and genuine convergence ("Running"/"Stopped") always win,
        even over a stale stored failure, so a successful external fix or
        reboot reconciliation is never hidden behind an old Error and
        "Needs setup" is never masked as a generic Error. A stored failure
        is shown as "Error" only when the group is ACTUALLY still
        non-converged ("Unhealthy") -- never permanently, never instead of
        a live recovery. With no stored failure, a non-converged group is
        plain "Unhealthy" drift.
        """
        operation = state["operation"]
        active_app_id = (
            operation["appId"]
            if operation is not None and operation["status"] in ACTIVE_STATUSES
            else None
        )
        needed = [app_id for app_id in APP_IDS if app_id != active_app_id]
        observations = None
        if needed:
            services = tuple(service for app_id in needed for service in APP_SERVICES[app_id])
            observations = self.runtime.service_states(services)
        apps = []
        for app_id in APP_IDS:
            desired = state["desired"][app_id]
            if app_id == active_app_id:
                apps.append({
                    "id": app_id,
                    "enabled": desired,
                    "status": "Starting" if operation["enabled"] else "Stopping",
                    "changedAt": state["lastChange"],
                    "operationId": operation["id"],
                    "errorCode": None,
                })
                continue
            result = state["results"][app_id]
            live = self.runtime.group_status(app_id, desired, observations=observations)
            if live in ("Needs setup", "Running", "Stopped"):
                status, error_code = live, None
            elif result is not None and result["errorCode"] is not None:
                status, error_code = "Error", result["errorCode"]
            else:
                status, error_code = "Unhealthy", None
            apps.append({
                "id": app_id,
                "enabled": desired,
                "status": status,
                "changedAt": result["changedAt"] if result is not None else None,
                "operationId": None,
                "errorCode": error_code,
            })
        return {"revision": state["revision"], "lastChangedAt": state["lastChange"], "apps": apps}

    def public_state(self):
        return self._build_payload(read_state(self.state_path))

    # -- GET /apps -------------------------------------------------

    def process_get(self):
        if self._degraded.is_set():
            return 503, {"error": "unavailable", "message": "service unavailable"}
        try:
            state = read_state(self.state_path)
            payload = self._build_payload(state)
        except (StateFailure, RuntimeFailure):
            return 503, {"error": "unavailable", "message": "service unavailable"}
        return 200, payload

    # -- GET /gate/{id} -------------------------------------------------

    def process_gate(self, app_id):
        if self._degraded.is_set():
            return 503
        try:
            state = read_state(self.state_path)
        except StateFailure:
            return 503
        operation = state["operation"]
        if (
            operation is not None
            and operation["appId"] == app_id
            and operation["status"] in ACTIVE_STATUSES
        ):
            return 503
        if not state["desired"][app_id]:
            return 503
        try:
            # Live convergence alone decides readiness -- a stale stored
            # failure never permanently hides a successful external fix or
            # reboot reconciliation.
            ready = self.runtime.converged(app_id, True)
        except RuntimeFailure:
            return 503
        return 204 if ready else 503

    # -- PUT /apps/{id} -------------------------------------------------

    def process_put(self, app_id, actor, enabled, expected_revision):
        if (
            type(enabled) is not bool
            or type(expected_revision) is not int
            or type(expected_revision) is bool
            or expected_revision < 0
        ):
            return 400, {"error": "bad_request", "message": "invalid request body"}
        if self._degraded.is_set():
            return 503, {"error": "unavailable", "message": "service unavailable"}

        try:
            lock_fd = self._acquire_lock()
        except StateFailure:
            return 503, {"error": "unavailable", "message": "service unavailable"}

        if lock_fd is None:
            # Busy: read the atomic snapshot without changing it. Never
            # runs Compose or writes state in this branch.
            try:
                state = read_state(self.state_path)
            except StateFailure:
                return 503, {"error": "unavailable", "message": "service unavailable"}
            return self._busy_response(state, app_id, enabled, expected_revision)

        try:
            state = read_state(self.state_path)
            if expected_revision != state["revision"]:
                raise Conflict("state revision changed")
            converged = self.runtime.converged(app_id, enabled)
            new_state, code = begin_change(
                state, app_id, enabled, expected_revision, converged, actor_id=actor,
            )
        except Conflict:
            self._release_lease(lock_fd)
            return 409, {"error": "conflict", "message": "revision conflict"}
        except (ValueError, StateFailure, RuntimeFailure):
            self._release_lease(lock_fd)
            return 503, {"error": "unavailable", "message": "service unavailable"}

        if code == 200:
            self._release_lease(lock_fd)
            return self._finalize_response(200, new_state)

        if new_state["revision"] == state["revision"]:
            # Defensive: an already-active duplicate of the same choice.
            # Should not occur with a freshly acquired lock (a prior
            # operation's lease and completion write always finish
            # together), kept for safety.
            self._release_lease(lock_fd)
            return self._finalize_response(202, new_state)

        try:
            atomic_write(self.state_path, new_state)
        except StateFailure:
            self._release_lease(lock_fd)
            return 503, {"error": "unavailable", "message": "service unavailable"}

        operation = dict(new_state["operation"])
        threading.Thread(target=self._run_worker, args=(lock_fd, operation), daemon=True).start()
        return self._finalize_response(202, new_state)

    def _finalize_response(self, code, state):
        try:
            return code, self._build_payload(state)
        except (StateFailure, RuntimeFailure):
            return 503, {"error": "unavailable", "message": "service unavailable"}

    def _busy_response(self, state, app_id, enabled, expected_revision):
        if expected_revision != state["revision"]:
            return 409, {"error": "conflict", "message": "revision conflict"}
        operation = state["operation"]
        if operation is not None and operation["status"] in ACTIVE_STATUSES:
            if operation["appId"] == app_id and operation["enabled"] is enabled:
                return self._finalize_response(202, state)
            return 409, {"error": "conflict", "message": "a different change is already active"}
        return 503, {"error": "unavailable", "message": "service unavailable"}

    # -- worker -------------------------------------------------

    def _run_worker(self, lock_fd, operation):
        app_id = operation["appId"]
        enabled = operation["enabled"]
        operation_id = operation["id"]
        actor_id = operation["actorId"]
        error_code = "operation_failed"
        exit_code = None
        try:
            if app_id == "mirofish" and enabled and not self.runtime.prepare_mirofish(lock_fd=lock_fd):
                error_code = "needs_setup"
            else:
                self.runtime.apply(app_id, enabled)
                error_code = None
                exit_code = 0
        except RuntimeFailure as exc:
            error_code = exc.code
            exit_code = exc.exit_code
        except Exception:
            error_code = "operation_failed"  # no raw exception/traceback in audit
            exit_code = None
        finally:
            try:
                try:
                    self._write_finished_matching_operation(operation_id, error_code)
                finally:
                    self._release_lease(lock_fd)
            finally:
                self._audit(app_id, actor_id, error_code, exit_code)

    def _write_finished_matching_operation(self, operation_id, error_code):
        try:
            current = read_state(self.state_path)
            finished = finish_change(current, operation_id, error_code)
            atomic_write(self.state_path, finished)
        except Conflict:
            return  # superseded ID: refuse to write, not our own failure
        except StateFailure:
            # Release still happens (caller's finally); never claim a
            # successful completion the state file doesn't reflect.
            self._degraded.set()

    def _audit(self, app_id, actor_id, result, exit_code):
        try:
            self._audit_logger.info(
                "app=%s actor=%s result=%s exitCode=%s",
                app_id, actor_id, result or "complete",
                exit_code if exit_code is not None else "none",
            )
        except Exception:
            pass

    # -- boot/restart reconciliation -------------------------------------------------

    def reconcile(self):
        """Bring every app's actual state in line with its persisted
        desired choice. Shares the lifecycle lock and runtime with normal
        operations; an already-converged group is a no-op. See the module
        docstring for the required threading contract.
        """
        try:
            lock_fd = self._acquire_lock_blocking()
        except StateFailure:
            self._degraded.set()
            return
        try:
            try:
                state = read_state(self.state_path)
            except StateFailure:
                self._degraded.set()
                return
            if state["operation"] is not None and state["operation"]["status"] in ACTIVE_STATUSES:
                state = restore_preferences(state, state)
                try:
                    atomic_write(self.state_path, state)
                except StateFailure:
                    self._degraded.set()
                    return
            for app_id in APP_IDS:
                state = self._reconcile_one(lock_fd, state, app_id)
                if state is None:
                    return
        finally:
            self._release_lease(lock_fd)

    def _reconcile_one(self, lock_fd, state, app_id):
        enabled = state["desired"][app_id]
        try:
            already = self.runtime.converged(app_id, enabled)
        except RuntimeFailure:
            already = False
        if already:
            return state
        try:
            new_state, _code = begin_change(state, app_id, enabled, state["revision"], False, actor_id="reconcile")
        except (Conflict, ValueError, StateFailure):
            return state
        try:
            atomic_write(self.state_path, new_state)
        except StateFailure:
            self._degraded.set()
            return None
        state = new_state
        operation_id = state["operation"]["id"]
        error_code = "operation_failed"
        exit_code = None
        try:
            if app_id == "mirofish" and enabled and not self.runtime.prepare_mirofish(lock_fd=lock_fd):
                error_code = "needs_setup"
            else:
                self.runtime.apply(app_id, enabled)
                error_code = None
                exit_code = 0
        except RuntimeFailure as exc:
            error_code = exc.code
            exit_code = exc.exit_code
        except Exception:
            error_code = "operation_failed"
        try:
            current = read_state(self.state_path)
            finished = finish_change(current, operation_id, error_code)
            atomic_write(self.state_path, finished)
            state = finished
        except Conflict:
            pass
        except StateFailure:
            self._degraded.set()
            return None
        self._audit(app_id, "reconcile", error_code, exit_code)
        return state


def create_server(socket_path, state_path, lock_path, runtime, gateway_uid=22001, audit_log_path=AUDIT_LOG_PATH):
    return UnixServer(socket_path, state_path, lock_path, runtime, gateway_uid, audit_log_path)


def main():
    """systemd's `ExecStart` runs this module directly with no arguments --
    there is no production command/path/admin flag a caller can set. Every
    path, the Compose project, and the owner UID are the fixed values
    established across Tasks 1-3; `gateway_uid`/`audit_log_path` keep their
    own fixed defaults too.
    """
    runtime_obj = Runtime(APP_DIR, SECRETS_DIR, RUNTIME_DIR)
    server = create_server(SOCKET_PATH, STATE_PATH, LOCK_PATH, runtime_obj)
    # Reconcile shares the lifecycle lock with deploy.sh and may block on it
    # for a long time; it must only ever start on its own thread, and only
    # after create_server() has already bound+listened (see module
    # docstring) -- never before serve_forever() is reachable.
    threading.Thread(target=server.reconcile, daemon=True).start()
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
