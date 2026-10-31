#!/usr/bin/env python3
"""Validated desired state and atomic preferences for Trading Hub controls."""

import argparse
import contextlib
import fcntl
import json
import os
import re
import stat
import sys
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path
from types import MappingProxyType


STATE_PATH = Path("/var/lib/family-app/ai-trading/control.json")
LOCK_PATH = Path("/var/lib/family-app/ai-trading/.control.lock")
CATALOG_PATH = Path(__file__).with_name("catalog.json")
ERROR_CODES = frozenset({
    "needs_setup", "image_missing", "runtime_unavailable",
    "operation_failed", "operation_timeout", "interrupted",
})
ACTIVE_STATUSES = frozenset({"starting", "stopping"})
ACTOR_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


class StateFailure(RuntimeError):
    """State or filesystem data is invalid or unavailable."""


class Conflict(StateFailure):
    """The requested revision or operation no longer matches current state."""


class Busy(StateFailure):
    """Another lifecycle operation or lock holder is active."""


_REQUIRED_APP_IDS = frozenset({"tradingagents", "ai-hedge-fund", "vibe-trading", "mirofish"})
_REQUIRED_PROTECTED = ("web", "gateway", "auth", "cloudflared", "market-data", "api", "scheduler", "market-data-bridge")


def validate_catalog(value):
    """Validate catalog structure and the required app/protected-service boundary."""
    if (type(value) is not dict or set(value) != {"schemaVersion", "apps", "protected"}
            or type(value["schemaVersion"]) is not int or value["schemaVersion"] != 1
            or type(value["apps"]) is not dict or type(value["protected"]) is not list):
        raise ValueError("control catalog has invalid schema")
    apps = value["apps"]
    if (set(apps) != _REQUIRED_APP_IDS
            or any(type(app_id) is not str or not ACTOR_ID.fullmatch(app_id) for app_id in apps)):
        raise ValueError("control catalog has invalid app identifiers")
    if any(
        type(services) is not list or not services
        or any(type(service) is not str or not ACTOR_ID.fullmatch(service) for service in services)
        for services in apps.values()
    ):
        raise ValueError("control catalog has invalid service groups")
    protected = value["protected"]
    if (
        tuple(protected) != _REQUIRED_PROTECTED
        or any(type(service) is not str or not ACTOR_ID.fullmatch(service) for service in protected)
    ):
        raise ValueError("control catalog has invalid protected services")
    all_services = [service for services in apps.values() for service in services]
    if len(set(all_services)) != len(all_services) or set(all_services).intersection(protected):
        raise ValueError("control catalog contains duplicate services")
    return {
        "schemaVersion": 1,
        "apps": {app_id: list(services) for app_id, services in apps.items()},
        "protected": list(protected),
    }


def _load_catalog():
    try:
        value = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
        return validate_catalog(value)
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        raise RuntimeError("control catalog cannot be loaded") from exc


_CATALOG = _load_catalog()
APP_SERVICES = MappingProxyType({
    app_id: tuple(services) for app_id, services in _CATALOG["apps"].items()
})
APP_IDS = tuple(APP_SERVICES)
PROTECTED_SERVICES = tuple(_CATALOG["protected"])
CATALOG = MappingProxyType({
    "schemaVersion": _CATALOG["schemaVersion"],
    "apps": APP_SERVICES,
    "protected": PROTECTED_SERVICES,
})
ALL_SERVICES = frozenset(PROTECTED_SERVICES).union(
    service for services in APP_SERVICES.values() for service in services
)


def _utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _is_utc_timestamp(value):
    if type(value) is not str:
        return False
    try:
        parsed = datetime.fromisoformat(value[:-1] + "+00:00" if value.endswith("Z") else value)
    except ValueError:
        return False
    return parsed.tzinfo is not None and parsed.utcoffset().total_seconds() == 0


def _require_keys(value, keys, label):
    if type(value) is not dict or set(value) != set(keys):
        raise StateFailure(f"{label} has invalid keys")


def _require_uuid4(value):
    if type(value) is not str:
        return False
    try:
        parsed = uuid.UUID(value)
    except (ValueError, AttributeError):
        return False
    return parsed.version == 4 and str(parsed) == value


def validate_state(value):
    """Validate and return one complete version-1 control state."""
    try:
        _require_keys(
            value,
            ("schemaVersion", "revision", "desired", "results", "lastChange", "operation"),
            "state",
        )
        if type(value["schemaVersion"]) is not int or value["schemaVersion"] != 1:
            raise StateFailure("unsupported state schema")
        if type(value["revision"]) is not int or value["revision"] < 0:
            raise StateFailure("invalid state revision")
        _require_keys(value["desired"], APP_IDS, "desired")
        if any(type(value["desired"][app_id]) is not bool for app_id in APP_IDS):
            raise StateFailure("invalid desired preferences")
        _require_keys(value["results"], APP_IDS, "results")
        for result in value["results"].values():
            if result is None:
                continue
            _require_keys(result, ("changedAt", "errorCode"), "result")
            if not _is_utc_timestamp(result["changedAt"]):
                raise StateFailure("invalid result timestamp")
            if result["errorCode"] is not None and result["errorCode"] not in ERROR_CODES:
                raise StateFailure("invalid result error code")
        if value["lastChange"] is not None and not _is_utc_timestamp(value["lastChange"]):
            raise StateFailure("invalid last-change timestamp")
        operation = value["operation"]
        if operation is not None:
            _require_keys(operation, (
                "id", "appId", "actorId", "enabled", "status", "startedAt",
                "finishedAt", "errorCode",
            ), "operation")
            if not _require_uuid4(operation["id"]):
                raise StateFailure("invalid operation identifier")
            if operation["appId"] not in APP_SERVICES:
                raise StateFailure("invalid operation app")
            if (type(operation["actorId"]) is not str
                    or not ACTOR_ID.fullmatch(operation["actorId"])):
                raise StateFailure("invalid operation actor")
            if type(operation["enabled"]) is not bool:
                raise StateFailure("invalid operation choice")
            if operation["status"] not in {"starting", "stopping", "complete", "error"}:
                raise StateFailure("invalid operation status")
            if not _is_utc_timestamp(operation["startedAt"]):
                raise StateFailure("invalid operation start time")
            if operation["status"] in ACTIVE_STATUSES:
                expected_status = "starting" if operation["enabled"] else "stopping"
                if operation["status"] != expected_status or operation["finishedAt"] is not None:
                    raise StateFailure("invalid active operation")
                if operation["errorCode"] is not None:
                    raise StateFailure("active operation has an error")
            else:
                if not _is_utc_timestamp(operation["finishedAt"]):
                    raise StateFailure("invalid operation finish time")
                if operation["status"] == "complete" and operation["errorCode"] is not None:
                    raise StateFailure("completed operation has an error")
                if operation["status"] == "error" and operation["errorCode"] not in ERROR_CODES:
                    raise StateFailure("failed operation has invalid error")
        return value
    except (KeyError, TypeError, AttributeError) as exc:
        raise StateFailure("state has invalid structure") from exc


def _validate_owner_uid(owner_uid):
    if type(owner_uid) is not int or owner_uid < 0:
        raise StateFailure("invalid expected owner")


def _validate_parent(path, owner_uid):
    _validate_owner_uid(owner_uid)
    try:
        parent = path.parent.lstat()
    except OSError as exc:
        raise StateFailure("state directory is unavailable") from exc
    if (not stat.S_ISDIR(parent.st_mode) or stat.S_ISLNK(parent.st_mode)
            or parent.st_uid != owner_uid or parent.st_mode & 0o022):
        raise StateFailure("state directory is unsafe")


def _validate_file_stat(file_stat, owner_uid):
    if (not stat.S_ISREG(file_stat.st_mode) or file_stat.st_uid != owner_uid
            or file_stat.st_mode & 0o022):
        raise StateFailure("state file is unsafe")


def refuse_unsafe_existing_path(path, owner_uid=0):
    path = Path(path)
    _validate_parent(path, owner_uid)
    try:
        existing = path.lstat()
    except FileNotFoundError:
        return
    except OSError as exc:
        raise StateFailure("state path cannot be inspected") from exc
    _validate_file_stat(existing, owner_uid)


def read_state(path, owner_uid=0):
    path = Path(path)
    try:
        refuse_unsafe_existing_path(path, owner_uid=owner_uid)
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(path, flags)
        with os.fdopen(fd, "r", encoding="utf-8") as stream:
            _validate_file_stat(os.fstat(stream.fileno()), owner_uid)
            return validate_state(json.load(stream))
    except StateFailure:
        raise
    except (OSError, json.JSONDecodeError, ValueError, TypeError) as exc:
        raise StateFailure("state is unavailable or invalid") from exc


def atomic_write(path, value, owner_uid=0):
    """Write a validated state with same-directory replace and durable directory sync."""
    path = Path(path)
    validate_state(value)
    refuse_unsafe_existing_path(path, owner_uid=owner_uid)
    fd = None
    temp_path = None
    try:
        fd, temp_path = tempfile.mkstemp(prefix=".control-", dir=path.parent)
        os.fchmod(fd, 0o600)
        stream = os.fdopen(fd, "w", encoding="utf-8")
        fd = None
        with stream:
            json.dump(value, stream, separators=(",", ":"))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp_path, path)
        temp_path = None
        directory_fd = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    except StateFailure:
        raise
    except (OSError, TypeError, ValueError) as exc:
        raise StateFailure("state write failed; durability may be uncertain") from exc
    finally:
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass
        if temp_path is not None:
            try:
                os.unlink(temp_path)
            except OSError:
                pass


def initial_state(running):
    if running is None:
        desired = {
            "tradingagents": True,
            "ai-hedge-fund": True,
            "vibe-trading": True,
            "mirofish": False,
        }
    else:
        if isinstance(running, (str, bytes)):
            raise ValueError("running services must be a collection of service IDs")
        try:
            running = set(running)
        except TypeError as exc:
            raise ValueError("running services must be a collection of service IDs") from exc
        if any(type(service) is not str or service not in ALL_SERVICES for service in running):
            raise ValueError("running services contain unknown service IDs")
        desired = {
            app_id: bool(running.intersection(services))
            for app_id, services in APP_SERVICES.items()
        }
    return {
        "schemaVersion": 1,
        "revision": 0,
        "desired": desired,
        "results": {app_id: None for app_id in APP_IDS},
        "lastChange": None,
        "operation": None,
    }


# A "dark" deploy (DEPLOY_DARK=1: staging or a pre-cutover warm-up on a host that must not serve
# traffic or place orders) brings the stack up without the Cloudflare tunnel and without the Desk
# scheduler. Every other protected service stays required, and a normal deploy requires all of them.
DARK_EXCLUDED_SERVICES = ("cloudflared", "scheduler")


def selected_services(state, mirofish_ready, dark=False):
    validate_state(state)
    if type(mirofish_ready) is not bool:
        raise ValueError("MiroFish readiness must be a boolean")
    if type(dark) is not bool:
        raise ValueError("dark must be a boolean")
    selected = [service for service in PROTECTED_SERVICES if not (dark and service in DARK_EXCLUDED_SERVICES)]
    for app_id, services in APP_SERVICES.items():
        if state["desired"][app_id] and (app_id != "mirofish" or mirofish_ready):
            selected.extend(services)
    return tuple(selected)


def begin_change(state, app_id, enabled, expected_revision, converged, actor_id="operator"):
    validate_state(state)
    if type(app_id) is not str or app_id not in APP_SERVICES:
        raise ValueError("unknown app ID")
    if type(enabled) is not bool:
        raise ValueError("enabled must be a boolean")
    if type(expected_revision) is not int or expected_revision < 0:
        raise ValueError("expected revision must be a nonnegative integer")
    if type(converged) is not bool:
        raise ValueError("converged must be a boolean")
    if type(actor_id) is not str or not ACTOR_ID.fullmatch(actor_id):
        raise ValueError("invalid actor ID")
    if expected_revision != state["revision"]:
        raise Conflict("state revision changed")

    operation = state["operation"]
    if operation is not None and operation["status"] in ACTIVE_STATUSES:
        if operation["appId"] == app_id and operation["enabled"] is enabled:
            return json.loads(json.dumps(state)), 202
        raise Busy("another app operation is active")

    if state["desired"][app_id] is enabled and converged:
        result = state["results"][app_id]
        if result is None or result["errorCode"] is None:
            return json.loads(json.dumps(state)), 200

    changed = json.loads(json.dumps(state))
    changed["revision"] += 1
    changed["desired"][app_id] = enabled
    old_result = changed["results"][app_id]
    if old_result is not None:
        old_result["errorCode"] = None
    changed["lastChange"] = _utc_now()
    changed["operation"] = {
        "id": str(uuid.uuid4()),
        "appId": app_id,
        "actorId": actor_id,
        "enabled": enabled,
        "status": "starting" if enabled else "stopping",
        "startedAt": changed["lastChange"],
        "finishedAt": None,
        "errorCode": None,
    }
    validate_state(changed)
    return changed, 202


def finish_change(state, operation_id, error_code):
    validate_state(state)
    if not _require_uuid4(operation_id):
        raise ValueError("invalid operation ID")
    if error_code is not None and (type(error_code) is not str or error_code not in ERROR_CODES):
        raise ValueError("invalid operation error code")
    operation = state["operation"]
    if (operation is None or operation["status"] not in ACTIVE_STATUSES
            or operation["id"] != operation_id):
        raise Conflict("operation is no longer active")
    changed = json.loads(json.dumps(state))
    finished_at = _utc_now()
    changed["operation"].update({
        "status": "error" if error_code is not None else "complete",
        "finishedAt": finished_at,
        "errorCode": error_code,
    })
    changed["results"][operation["appId"]] = {
        "changedAt": finished_at,
        "errorCode": error_code,
    }
    validate_state(changed)
    return changed


def restore_preferences(current, saved):
    validate_state(current)
    validate_state(saved)
    restored = json.loads(json.dumps(current))
    interrupted = restored["operation"]
    if interrupted is not None and interrupted["status"] in ACTIVE_STATUSES:
        restored["results"][interrupted["appId"]] = {
            "changedAt": _utc_now(),
            "errorCode": "interrupted",
        }
    restored["desired"] = dict(saved["desired"])
    restored["revision"] += 1
    restored["lastChange"] = _utc_now()
    restored["operation"] = None
    validate_state(restored)
    return restored


def validate_inherited_lock(fd, lock_path, owner_uid=0):
    """Validate and retain an inherited exclusive flock without unlocking it."""
    lock_path = Path(lock_path)
    try:
        _validate_parent(lock_path, owner_uid)
        descriptor_stat = os.fstat(fd)
        path_stat = lock_path.lstat()
        _validate_file_stat(descriptor_stat, owner_uid)
        _validate_file_stat(path_stat, owner_uid)
        if (descriptor_stat.st_dev, descriptor_stat.st_ino) != (path_stat.st_dev, path_stat.st_ino):
            raise StateFailure("inherited lock descriptor does not match lock path")
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except StateFailure:
        raise
    except BlockingIOError as exc:
        raise Busy("lifecycle lock is held elsewhere") from exc
    except OSError as exc:
        raise StateFailure("inherited lifecycle lock is invalid") from exc


@contextlib.contextmanager
def _cli_lock(lock_path, owner_uid, inherited_fd):
    if inherited_fd is not None:
        validate_inherited_lock(inherited_fd, lock_path, owner_uid=owner_uid)
        yield
        return
    lock_path = Path(lock_path)
    _validate_parent(lock_path, owner_uid)
    try:
        try:
            fd = os.open(
                lock_path,
                os.O_CREAT | os.O_EXCL | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0),
                0o600,
            )
            os.fchmod(fd, 0o600)
        except FileExistsError:
            fd = os.open(lock_path, os.O_RDWR | getattr(os, "O_NOFOLLOW", 0))
        validate_inherited_lock(fd, lock_path, owner_uid=owner_uid)
    except (OSError, StateFailure):
        if "fd" in locals():
            os.close(fd)
        raise
    try:
        yield
    finally:
        os.close(fd)


def _parser():
    parser = argparse.ArgumentParser(description="Manage Trading Hub control preferences")
    commands = parser.add_subparsers(dest="command", required=True)

    def options(command):
        command.add_argument("--state", type=Path, default=STATE_PATH)
        command.add_argument("--lock", type=Path, default=LOCK_PATH)
        command.add_argument("--owner-uid", type=int, default=0)
        command.add_argument("--lock-fd", type=int)

    init = commands.add_parser("init")
    options(init)
    init.add_argument("--running-services-json", required=True)

    services = commands.add_parser("services")
    options(services)
    services.add_argument("--mirofish-ready", choices=("true", "false"), required=True)
    services.add_argument("--dark", action="store_true")

    snapshot = commands.add_parser("snapshot")
    options(snapshot)
    snapshot.add_argument("--output", type=Path, required=True)

    restore = commands.add_parser("restore")
    options(restore)
    restore.add_argument("--snapshot", type=Path, required=True)

    set_mirofish = commands.add_parser("set-mirofish")
    options(set_mirofish)
    set_mirofish.add_argument("--mode", choices=("keep", "1", "0"), required=True)
    return parser


def _parse_running_services(raw):
    try:
        running = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError("running services JSON is invalid") from exc
    if running is None:
        return None
    if type(running) is not list or any(type(service) is not str for service in running):
        raise ValueError("running services must be a JSON array or null")
    if len(set(running)) != len(running):
        raise ValueError("running services contains duplicates")
    return set(running)


def _set_mirofish(state, mode):
    if mode == "keep":
        return state
    if state["operation"] is not None and state["operation"]["status"] in ACTIVE_STATUSES:
        raise Busy("an app operation is active")
    enabled = mode == "1"
    if state["desired"]["mirofish"] is enabled:
        return state
    changed = json.loads(json.dumps(state))
    changed["desired"]["mirofish"] = enabled
    changed["revision"] += 1
    changed["lastChange"] = _utc_now()
    result = changed["results"]["mirofish"]
    if result is not None:
        result["errorCode"] = None
    validate_state(changed)
    return changed


def main(argv=None):
    args = _parser().parse_args(argv)
    try:
        if args.command == "services":
            state = read_state(args.state, owner_uid=args.owner_uid)
            ready = args.mirofish_ready == "true"
            print("\n".join(selected_services(state, ready, dark=args.dark)))
            return 0
        with _cli_lock(args.lock, args.owner_uid, args.lock_fd):
            if args.command == "snapshot":
                snapshot = read_state(args.state, owner_uid=args.owner_uid)
                atomic_write(args.output, snapshot, owner_uid=args.owner_uid)
            elif args.command == "init":
                if args.state.exists() or args.state.is_symlink():
                    read_state(args.state, owner_uid=args.owner_uid)
                else:
                    running = _parse_running_services(args.running_services_json)
                    atomic_write(args.state, initial_state(running), owner_uid=args.owner_uid)
            elif args.command == "restore":
                current = read_state(args.state, owner_uid=args.owner_uid)
                saved = read_state(args.snapshot, owner_uid=args.owner_uid)
                restored = restore_preferences(current, saved)
                atomic_write(args.state, restored, owner_uid=args.owner_uid)
            elif args.command == "set-mirofish":
                current = read_state(args.state, owner_uid=args.owner_uid)
                changed = _set_mirofish(current, args.mode)
                if changed != current:
                    atomic_write(args.state, changed, owner_uid=args.owner_uid)
        return 0
    except (StateFailure, ValueError) as exc:
        print(f"state operation failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
