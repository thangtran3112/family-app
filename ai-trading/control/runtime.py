#!/usr/bin/env python3
"""Fixed Docker Compose runtime operations for Trading Hub app controls.

Every subprocess argv is a fixed list built from validated, deployed
metadata -- never from caller-supplied strings (app IDs/booleans only ever
reach this module through the catalog-checked HTTP layer). No `down`,
volume/image deletion, arbitrary exec, or Docker API pass-through exists
here; start/stop only ever target the catalog's own mapped services on the
one fixed Compose project.
"""

import hashlib
import os
import re
import stat
import subprocess
import time
from pathlib import Path

from state import APP_SERVICES

QUERY_TIMEOUT = 5
STOP_TIMEOUT = 60
START_WAIT_TIMEOUT = 300
# Subprocess-level timeouts wrap the compose-level ones above with headroom
# for process startup/teardown, never less than the compose timeout itself.
STOP_COMMAND_TIMEOUT = 75
START_COMMAND_TIMEOUT = 330

_SHA40 = re.compile(r"^[0-9a-fA-F]{40}$")
_REGISTRY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$")
_ENV_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_HEALTHY_STATES = frozenset({"healthy", "none"})
_STOPPED_STATUSES = frozenset({"exited", "absent", "created", "dead"})
_MIROFISH_REQUIRED_KEYS = ("ZEP_API_KEY", "LLM_API_KEY")

# Narrow `docker inspect` field list: container id (to map a response line
# back to the id that was asked for), the compose-service label (`index`
# looks a map key up by exact string, so the dotted label name is never
# misparsed as a nested field path), state status, and health status only.
# Deliberately never `{{json .}}` (or any other whole-object format), which
# would also return `Config.Env` -- every secret the container was started
# with -- plus mounts, networks and other metadata this module never needs
# and must never read, log, or return.
_INSPECT_FORMAT = (
    '{{.Id}}\t{{index .Config.Labels "com.docker.compose.service"}}'
    "\t{{.State.Status}}\t{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}"
)

PREPARE_MIROFISH_SCRIPT = (
    Path(__file__).resolve().parent.parent / "deploy" / "production" / "prepare-mirofish.sh"
)


class RuntimeFailure(RuntimeError):
    """A runtime operation could not be completed safely.

    `code` is one of the fixed, caller-safe ErrorCode values; the exception
    text and any logging around it must never include raw subprocess output.
    """

    def __init__(self, code, exit_code=None):
        super().__init__(f"runtime failure: {code}")
        self.code = code
        self.exit_code = exit_code


def _decode(value):
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")
    return value or ""


def _validate_plain_owned_file(path, owner_uid):
    try:
        info = path.lstat()
    except OSError as exc:
        raise RuntimeFailure("runtime_unavailable") from exc
    if not stat.S_ISREG(info.st_mode) or info.st_uid != owner_uid or info.st_mode & 0o022:
        raise RuntimeFailure("runtime_unavailable")


def _parse_env_file(path):
    try:
        raw = path.read_bytes()
    except OSError as exc:
        raise RuntimeFailure("runtime_unavailable") from exc
    if b"\x00" in raw or b"\r" in raw:
        raise RuntimeFailure("runtime_unavailable")
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise RuntimeFailure("runtime_unavailable") from exc
    values = {}
    for line in text.splitlines():
        if not line or line.startswith("#"):
            continue
        key, sep, value = line.partition("=")
        if not sep or not value or not _ENV_KEY_RE.fullmatch(key):
            raise RuntimeFailure("runtime_unavailable")
        values[key] = value
    return values


class Runtime:
    """Fixed, catalog-scoped Docker Compose operations for one deployment.

    `app_dir`/`secrets_dir`/`runtime_dir`/`project`/`owner_uid` are fixed at
    construction by the deployment itself (never from an HTTP request).
    `command` defaults to `subprocess.run` and is overridden only by tests.
    """

    def __init__(
        self,
        app_dir,
        secrets_dir,
        runtime_dir,
        project="ai-trading",
        command=subprocess.run,
        owner_uid=0,
    ):
        self.app_dir = Path(app_dir)
        self.secrets_dir = Path(secrets_dir)
        self.runtime_dir = Path(runtime_dir)
        self.project = project
        self.command = command
        self.owner_uid = owner_uid

    def _compose_base(self):
        return [
            "docker", "compose", "--project-name", self.project,
            "--env-file", str(self.app_dir / "images.env"),
            "-f", str(self.app_dir / "docker-compose.yml"),
            "-f", str(self.app_dir / "docker-compose.mirofish.yml"),
        ]

    def _deployed_env(self):
        images_env = self.app_dir / "images.env"
        _validate_plain_owned_file(images_env, self.owner_uid)
        values = _parse_env_file(images_env)
        tag = values.get("AI_TRADING_IMAGE_TAG", "")
        registry = values.get("AI_TRADING_REGISTRY", "")
        if not _SHA40.fullmatch(tag) or not _REGISTRY_RE.fullmatch(registry):
            raise RuntimeFailure("runtime_unavailable")
        caddyfile = self.app_dir / "Caddyfile"
        caddyfile_sha = "unset"
        if caddyfile.is_file():
            caddyfile_sha = hashlib.sha256(caddyfile.read_bytes()).hexdigest()
        return {
            "PATH": os.defpath,
            "AI_TRADING_REGISTRY": registry,
            "AI_TRADING_IMAGE_TAG": tag,
            "AI_TRADING_SECRETS_DIR": str(self.secrets_dir),
            "AI_TRADING_RUNTIME_ENV_DIR": str(self.runtime_dir),
            "AI_TRADING_CADDYFILE_SHA256": caddyfile_sha,
        }

    def _run(self, argv, timeout, env):
        try:
            return self.command(
                argv, capture_output=True, timeout=timeout, env=env, shell=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise RuntimeFailure("operation_timeout") from exc
        except OSError as exc:
            raise RuntimeFailure("runtime_unavailable") from exc

    def _run_within_budget(self, argv, deadline, env):
        """Runs one subprocess call sized to whatever remains of a shared
        monotonic deadline -- never a fresh, independent QUERY_TIMEOUT per
        call. Raises RuntimeFailure("runtime_unavailable") immediately,
        without even attempting the call, once the budget is already spent;
        the same code covers an actual subprocess timeout or any other
        failure to run the command -- an observation query never surfaces
        `operation_timeout` (that code is reserved for an apply() start/stop
        actually timing out).
        """
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise RuntimeFailure("runtime_unavailable")
        try:
            return self.command(
                argv, capture_output=True, timeout=remaining, env=env, shell=False,
            )
        except (subprocess.TimeoutExpired, OSError) as exc:
            raise RuntimeFailure("runtime_unavailable") from exc

    def service_states(self, services):
        """Batch status+health for every service under one aggregate,
        monotonic QUERY_TIMEOUT (5s) budget -- not QUERY_TIMEOUT per
        subprocess call. Returns `{service: {"status": <docker status
        string, or "absent" with no container>, "health": "healthy" |
        "unhealthy" | "starting" | "none" | None}}`; this exact shape is
        also the `observations` argument `group_status()` accepts below, so
        a caller (the server GET handler) can collect every mapped service
        once and classify every app's group from the same dict.
        """
        services = tuple(services)
        states = {service: {"status": "absent", "health": None} for service in services}
        if not services:
            return states
        env = self._deployed_env()
        deadline = time.monotonic() + QUERY_TIMEOUT
        listed = self._run_within_budget(self._compose_base() + ["ps", "-q", *services], deadline, env)
        if listed.returncode != 0:
            raise RuntimeFailure("runtime_unavailable")
        ids = [line for line in _decode(listed.stdout).split() if line]
        if not ids:
            return states
        inspected = self._run_within_budget(
            ["docker", "inspect", "--format", _INSPECT_FORMAT, *ids], deadline, env,
        )
        if inspected.returncode != 0:
            raise RuntimeFailure("runtime_unavailable")
        for line in _decode(inspected.stdout).splitlines():
            if not line.strip():
                continue
            parts = line.split("\t")
            if len(parts) != 4:
                raise RuntimeFailure("runtime_unavailable")
            _container_id, service, status, health = parts
            if service not in states:
                continue
            states[service] = {"status": status, "health": health}
        return states

    def _mirofish_env_path(self):
        return self.runtime_dir / "mirofish.env"

    def _mirofish_ready(self):
        path = self._mirofish_env_path()
        try:
            info = path.lstat()
        except OSError:
            return False
        if not stat.S_ISREG(info.st_mode) or info.st_uid != self.owner_uid or info.st_mode & 0o077:
            return False
        try:
            values = _parse_env_file(path)
        except RuntimeFailure:
            return False
        return all(key in values for key in _MIROFISH_REQUIRED_KEYS)

    def group_status(self, app_id, enabled, observations=None):
        """`observations`, when given, must be a dict in the exact shape
        `service_states()` returns (`{service: {"status": ..., "health":
        ...}}`); a mapped service absent from it is treated as absent, the
        same default `service_states()` itself uses. This lets a caller
        collect one batch of observations (e.g. `service_states(ALL_SERVICES)`)
        and classify every app's group from it, without this method
        re-querying Docker or this class keeping any mutable cache.
        Omitting it (or passing None) re-queries Docker directly, exactly as
        before -- existing two-argument calls are unaffected.
        """
        if app_id not in APP_SERVICES:
            raise ValueError("unknown app ID")
        if type(enabled) is not bool:
            raise ValueError("enabled must be a boolean")
        if observations is not None and type(observations) is not dict:
            raise ValueError("observations must be a dict or None")
        if app_id == "mirofish" and enabled and not self._mirofish_ready():
            return "Needs setup"
        mapped_services = APP_SERVICES[app_id]
        if observations is None:
            states = self.service_states(mapped_services)
        else:
            states = {
                service: observations.get(service, {"status": "absent", "health": None})
                for service in mapped_services
            }
        if enabled:
            running_healthy = all(
                state["status"] == "running" and state["health"] in _HEALTHY_STATES
                for state in states.values()
            )
            return "Running" if running_healthy else "Unhealthy"
        all_stopped = all(state["status"] in _STOPPED_STATUSES for state in states.values())
        return "Stopped" if all_stopped else "Unhealthy"

    def converged(self, app_id, enabled):
        return self.group_status(app_id, enabled) == ("Running" if enabled else "Stopped")

    def prepare_mirofish(self, lock_fd=None):
        """Render/validate/install MiroFish credentials via the standalone
        root-only preparer script, never duplicating its secret handling
        here. Returns False (never raises) on any failure -- a missing or
        invalid profile means MiroFish stays in "Needs setup", not a hard
        runtime error.
        """
        argv = [
            str(PREPARE_MIROFISH_SCRIPT),
            "--app-dir", str(self.app_dir),
            "--secrets-dir", str(self.secrets_dir),
            "--runtime-dir", str(self.runtime_dir),
            "--project", self.project,
            "--owner-uid", str(self.owner_uid),
        ]
        kwargs = {}
        if lock_fd is not None:
            argv += ["--lock-fd", str(lock_fd)]
            kwargs["pass_fds"] = (lock_fd,)
        try:
            result = self.command(
                argv, capture_output=True, timeout=START_COMMAND_TIMEOUT,
                env={"PATH": os.defpath}, shell=False, **kwargs,
            )
        except (subprocess.TimeoutExpired, OSError):
            return False
        return result.returncode == 0

    def _images_missing(self, services, env):
        listed = self._run(self._compose_base() + ["config", "--images", *services], QUERY_TIMEOUT, env)
        if listed.returncode != 0:
            return False
        refs = [line for line in _decode(listed.stdout).split() if line]
        if not refs:
            return False
        inspected = self._run(["docker", "image", "inspect", *refs], QUERY_TIMEOUT, env)
        return inspected.returncode != 0

    def apply(self, app_id, enabled):
        if app_id not in APP_SERVICES:
            raise ValueError("unknown app ID")
        if type(enabled) is not bool:
            raise ValueError("enabled must be a boolean")
        env = self._deployed_env()
        if enabled and app_id == "mirofish" and not self._mirofish_ready():
            raise RuntimeFailure("needs_setup")
        services = APP_SERVICES[app_id]
        base = self._compose_base()
        if enabled:
            argv = base + [
                "up", "-d", "--no-deps", "--no-build", "--pull", "never",
                "--wait", "--wait-timeout", str(START_WAIT_TIMEOUT), *services,
            ]
            timeout = START_COMMAND_TIMEOUT
        else:
            argv = base + ["stop", "--timeout", str(STOP_TIMEOUT), *services]
            timeout = STOP_COMMAND_TIMEOUT
        result = self._run(argv, timeout, env)
        if result.returncode != 0:
            if enabled and self._images_missing(services, env):
                raise RuntimeFailure("image_missing", result.returncode)
            raise RuntimeFailure("operation_failed", result.returncode)
