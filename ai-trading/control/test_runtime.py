import fcntl
import os
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import runtime
from runtime import Runtime, RuntimeFailure

VALID_TAG = "a" * 40
REPO_ROOT = Path(__file__).resolve().parent.parent


class FakeDocker:
    """Stands in for the real `docker`/`docker compose` CLI, understanding
    only the exact argv shapes Runtime emits: `compose ps -q SERVICE...`,
    `docker inspect --format <narrow id/service/status/health template>
    ID...`, `compose up ...`, `compose stop ...`, `compose config --images
    SERVICE...`, `docker image inspect REF...`, and the preparer script
    path. Mirrors the real CLI's own contracts (an absent service means
    empty `ps -q` output; `docker inspect` emits one line per container, in
    whatever format string was actually requested) without a daemon. Emits
    the SAME tab-joined id/service/status/health shape
    `runtime._INSPECT_FORMAT` requests -- never the full `{{json .}}` object
    (no Config.Env, no mounts, no raw container metadata).
    """

    def __init__(self):
        self.calls = []
        self.last_kwargs = None
        self.containers = {}  # service -> {"id", "status", "health"}
        self.ps_returncode = 0
        self.inspect_returncode = 0
        self.up_returncode = 0
        self.stop_returncode = 0
        self.images_present = True
        self.preparer_calls = 0
        self.preparer_returncode = 0
        self.preparer_side_effect = None

    def __call__(self, argv, **kwargs):
        self.calls.append(list(argv))
        self.last_kwargs = kwargs
        if argv and argv[0] == str(runtime.PREPARE_MIROFISH_SCRIPT):
            self.preparer_calls += 1
            if self.preparer_side_effect:
                self.preparer_side_effect()
            return subprocess.CompletedProcess(argv, self.preparer_returncode)
        if "ps" in argv and "-q" in argv:
            services = argv[argv.index("-q") + 1 :]
            ids = [self.containers[s]["id"] for s in services if s in self.containers]
            stdout = ("\n".join(ids) + "\n").encode() if ids else b""
            return subprocess.CompletedProcess(argv, self.ps_returncode, stdout=stdout)
        if argv[:2] == ["docker", "inspect"]:
            self.assert_narrow_inspect_format(argv)
            wanted = set(argv[argv.index("--format") + 2 :])
            lines = []
            for service, info in self.containers.items():
                if info["id"] not in wanted:
                    continue
                health = info.get("health") or "none"
                lines.append("\t".join([info["id"], service, info["status"], health]))
            stdout = ("\n".join(lines) + "\n").encode() if lines else b""
            return subprocess.CompletedProcess(argv, self.inspect_returncode, stdout=stdout)
        if "up" in argv:
            return subprocess.CompletedProcess(argv, self.up_returncode)
        if "stop" in argv:
            return subprocess.CompletedProcess(argv, self.stop_returncode)
        if "--images" in argv:
            # `compose config --images` only resolves image references from
            # the compose file; it never checks local presence (that's
            # `docker image inspect`'s job below), so it always returns one
            # ref per requested service regardless of self.images_present.
            services = argv[argv.index("--images") + 1 :]
            refs = [f"fake-registry/ai-trading-{s}:{VALID_TAG}" for s in services]
            stdout = ("\n".join(refs) + "\n").encode() if refs else b""
            return subprocess.CompletedProcess(argv, 0, stdout=stdout)
        if argv[:3] == ["docker", "image", "inspect"]:
            return subprocess.CompletedProcess(argv, 0 if self.images_present else 1)
        return subprocess.CompletedProcess(argv, 0)

    @staticmethod
    def assert_narrow_inspect_format(argv):
        """The boundary assertion for concern (1): `docker inspect` must
        never ask for the whole container object (which includes
        `Config.Env` -- every secret the container was started with -- and
        other raw metadata). It may only request the four fixed fields
        Runtime actually needs: container id, compose-service label, state
        status, health status.
        """
        fmt = argv[argv.index("--format") + 1]
        assert "json" not in fmt.lower(), f"inspect format must not request the full object: {fmt!r}"
        assert "Env" not in fmt, f"inspect format must never read Config.Env: {fmt!r}"
        assert ".Id" in fmt
        assert "com.docker.compose.service" in fmt
        assert ".State.Status" in fmt
        assert ".State.Health" in fmt


class RuntimeTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        root = Path(self._tmp.name)
        self.app_dir = root / "app"
        self.secrets_dir = root / "secrets"
        self.runtime_dir = root / "runtime"
        for directory in (self.app_dir, self.secrets_dir, self.runtime_dir):
            directory.mkdir()
        self.write_image_metadata(f"AI_TRADING_IMAGE_TAG={VALID_TAG}\n")
        self.runtime_env = self.runtime_dir / "mirofish.env"
        self.docker = FakeDocker()

    def write_image_metadata(self, body):
        path = self.app_dir / "images.env"
        path.write_text(f"AI_TRADING_REGISTRY=fake-registry\n{body}")
        os.chmod(path, 0o644)

    def write_mirofish_env(self):
        self.runtime_env.write_text("ZEP_API_KEY=fake\nLLM_API_KEY=fake\n")
        os.chmod(self.runtime_env, 0o600)

    def runtime(self, command=None, owner_uid=None):
        return Runtime(
            self.app_dir, self.secrets_dir, self.runtime_dir,
            command=command if command is not None else self.docker,
            owner_uid=os.getuid() if owner_uid is None else owner_uid,
        )

    @staticmethod
    def ok(stdout=b""):
        return subprocess.CompletedProcess([], 0, stdout=stdout)

    # -- apply(): fixed, grouped argv --------------------------------------

    def test_start_and_stop_are_fixed_and_grouped(self):
        calls = []
        runtime_obj = self.runtime(command=lambda argv, **kw: calls.append(argv) or self.ok())
        runtime_obj.apply("tradingagents", True)
        self.assertEqual(calls[-1][-2:], ["ta-terminal", "ta-research"])
        self.assertIn("--no-deps", calls[-1])
        self.assertIn("--no-build", calls[-1])
        self.assertIn("never", calls[-1])
        runtime_obj.apply("tradingagents", False)
        self.assertEqual(calls[-1][-5:], ["stop", "--timeout", "60", "ta-terminal", "ta-research"])
        for argv in calls:
            self.assertNotIn("down", argv)
            self.assertNotIn("rm", argv)
            self.assertNotIn("prune", argv)
            self.assertNotIn("expense", " ".join(argv))

    def test_unknown_id_and_bad_metadata_never_execute(self):
        calls = []
        runtime_obj = self.runtime(command=lambda argv, **kw: calls.append(argv) or self.ok())
        with self.assertRaises(ValueError):
            runtime_obj.apply("../gateway", False)
        self.assertEqual(calls, [])
        self.write_image_metadata("AI_TRADING_IMAGE_TAG=bad-tag\n")
        with self.assertRaises(RuntimeFailure):
            runtime_obj.apply("vibe-trading", True)
        self.assertEqual(calls, [])

    def test_apply_rejects_non_boolean_enabled(self):
        runtime_obj = self.runtime(command=lambda argv, **kw: self.ok())
        with self.assertRaises(ValueError):
            runtime_obj.apply("vibe-trading", "true")

    # -- deployed image metadata validation ---------------------------------

    def test_missing_images_env_is_runtime_unavailable(self):
        (self.app_dir / "images.env").unlink()
        runtime_obj = self.runtime(command=lambda argv, **kw: self.ok())
        with self.assertRaises(RuntimeFailure) as ctx:
            runtime_obj.apply("vibe-trading", True)
        self.assertEqual(ctx.exception.code, "runtime_unavailable")

    def test_wrong_owner_images_env_is_rejected_even_with_valid_content(self):
        # Production default owner_uid=0: a file not owned by root must be
        # rejected regardless of otherwise-valid content. Non-root: this
        # process's own uid is already never 0, so the default already
        # mismatches. Root (the prescribed Linux container runs as root):
        # chown the ephemeral fixture to a different numeric uid first, the
        # same technique test_state.py's own
        # test_unsafe_owner_permissions_and_parent_are_rejected uses, so the
        # rejection is exercised for real instead of being skipped.
        images_env = self.app_dir / "images.env"
        if os.getuid() == 0:
            os.chown(images_env, 65534, 65534)
        runtime_obj = self.runtime(command=lambda argv, **kw: self.ok(), owner_uid=0)
        with self.assertRaises(RuntimeFailure) as ctx:
            runtime_obj.apply("vibe-trading", True)
        self.assertEqual(ctx.exception.code, "runtime_unavailable")

    def test_world_writable_images_env_is_rejected(self):
        os.chmod(self.app_dir / "images.env", 0o646)
        runtime_obj = self.runtime(command=lambda argv, **kw: self.ok())
        with self.assertRaises(RuntimeFailure):
            runtime_obj.apply("vibe-trading", True)

    # -- command execution failures -----------------------------------------

    def test_docker_query_failure_raises_runtime_failure_not_empty_set(self):
        self.docker.ps_returncode = 1
        runtime_obj = self.runtime()
        with self.assertRaises(RuntimeFailure) as ctx:
            runtime_obj.service_states(("ta-terminal",))
        self.assertEqual(ctx.exception.code, "runtime_unavailable")

    def test_command_timeout_raises_operation_timeout(self):
        def timing_out(argv, **kw):
            raise subprocess.TimeoutExpired(argv, kw.get("timeout"))

        runtime_obj = self.runtime(command=timing_out)
        with self.assertRaises(RuntimeFailure) as ctx:
            runtime_obj.apply("vibe-trading", True)
        self.assertEqual(ctx.exception.code, "operation_timeout")

    def test_command_failure_without_missing_images_is_operation_failed(self):
        self.docker.up_returncode = 1
        runtime_obj = self.runtime()
        with self.assertRaises(RuntimeFailure) as ctx:
            runtime_obj.apply("vibe-trading", True)
        self.assertEqual(ctx.exception.code, "operation_failed")
        self.assertEqual(ctx.exception.exit_code, 1)

    def test_missing_local_images_after_failed_start_reports_image_missing(self):
        self.docker.up_returncode = 1
        self.docker.images_present = False
        runtime_obj = self.runtime()
        with self.assertRaises(RuntimeFailure) as ctx:
            runtime_obj.apply("vibe-trading", True)
        self.assertEqual(ctx.exception.code, "image_missing")

    # -- concern (1): docker inspect must use a narrow field list ------------

    def test_service_states_inspect_uses_narrow_format_not_full_object(self):
        self.docker.containers = {
            "vibe-trading": {"id": "c1", "status": "running", "health": "healthy"},
        }
        runtime_obj = self.runtime()
        runtime_obj.service_states(("vibe-trading",))
        inspect_call = next(c for c in self.docker.calls if c[:2] == ["docker", "inspect"])
        # FakeDocker.assert_narrow_inspect_format (called from __call__ while
        # producing the response) already enforces this on every call; this
        # assertion is the test's own independent, explicit check of the
        # exact production argv, not a check on the test double.
        fmt = inspect_call[inspect_call.index("--format") + 1]
        self.assertNotIn("json", fmt.lower())
        self.assertNotIn("Env", fmt)
        self.assertIn(".State.Status", fmt)
        self.assertIn(".State.Health", fmt)

    # -- concern (2): one aggregate 5s observation budget, not 5s+5s ---------

    def test_service_states_shrinks_second_call_timeout_by_elapsed_time(self):
        timeouts = []

        def recording(argv, **kw):
            timeouts.append(kw.get("timeout"))
            if argv[:2] == ["docker", "inspect"]:
                return self.ok(stdout=b"c1\tvibe-trading\trunning\thealthy\n")
            return self.ok(stdout=b"c1\n")

        runtime_obj = self.runtime(command=recording)
        # time.monotonic() is read once for the deadline, once to size the
        # "ps" call (no elapsed time yet: full 5s budget), and once more to
        # size the "inspect" call -- this third read simulates 4.5s of real
        # elapsed time having passed during/after the "ps" call, so the
        # second subprocess call must be sized to the remaining 0.5s, never
        # a second independent 5s.
        with mock.patch("runtime.time.monotonic", side_effect=[100.0, 100.0, 104.5]):
            runtime_obj.service_states(("vibe-trading",))
        self.assertEqual(len(timeouts), 2)
        self.assertAlmostEqual(timeouts[0], 5.0)
        self.assertAlmostEqual(timeouts[1], 0.5)

    def test_service_states_raises_before_a_second_call_once_budget_is_spent(self):
        calls = []

        def recording(argv, **kw):
            calls.append((list(argv), kw.get("timeout")))
            if argv[:2] == ["docker", "inspect"]:
                raise AssertionError("inspect must never be attempted once the budget is spent")
            return self.ok(stdout=b"c1\n")

        runtime_obj = self.runtime(command=recording)
        with mock.patch("runtime.time.monotonic", side_effect=[100.0, 100.0, 105.1]):
            with self.assertRaises(RuntimeFailure) as ctx:
                runtime_obj.service_states(("vibe-trading",))
        self.assertEqual(ctx.exception.code, "runtime_unavailable")
        self.assertEqual(len(calls), 1)

    def test_service_states_query_timeout_is_runtime_unavailable_not_operation_timeout(self):
        def timing_out(argv, **kw):
            raise subprocess.TimeoutExpired(argv, kw.get("timeout"))

        runtime_obj = self.runtime(command=timing_out)
        with self.assertRaises(RuntimeFailure) as ctx:
            runtime_obj.service_states(("vibe-trading",))
        self.assertEqual(ctx.exception.code, "runtime_unavailable")

    # -- group_status / converged --------------------------------------------

    def test_group_status_running_requires_every_mapped_service_healthy(self):
        self.docker.containers = {
            "ta-terminal": {"id": "c1", "status": "running", "health": "healthy"},
            "ta-research": {"id": "c2", "status": "running", "health": "healthy"},
        }
        runtime_obj = self.runtime()
        self.assertEqual(runtime_obj.group_status("tradingagents", True), "Running")
        self.assertTrue(runtime_obj.converged("tradingagents", True))

    def test_group_status_healthy_and_none_healthcheck_both_count_as_running(self):
        self.docker.containers = {
            "vibe-trading": {"id": "c1", "status": "running", "health": "none"},
        }
        runtime_obj = self.runtime()
        self.assertEqual(runtime_obj.group_status("vibe-trading", True), "Running")

    def test_group_status_partial_group_is_unhealthy(self):
        self.docker.containers = {
            "ta-terminal": {"id": "c1", "status": "running", "health": "healthy"},
            "ta-research": {"id": "c2", "status": "exited", "health": None},
        }
        runtime_obj = self.runtime()
        self.assertEqual(runtime_obj.group_status("tradingagents", True), "Unhealthy")
        self.assertFalse(runtime_obj.converged("tradingagents", True))

    def test_group_status_unhealthy_member_is_unhealthy(self):
        self.docker.containers = {
            "vibe-trading": {"id": "c1", "status": "running", "health": "unhealthy"},
        }
        runtime_obj = self.runtime()
        self.assertEqual(runtime_obj.group_status("vibe-trading", True), "Unhealthy")

    def test_group_status_stopped_requires_every_mapped_service_stopped(self):
        self.docker.containers = {
            "vibe-trading": {"id": "c1", "status": "exited", "health": None},
        }
        runtime_obj = self.runtime()
        self.assertEqual(runtime_obj.group_status("vibe-trading", False), "Stopped")
        self.assertTrue(runtime_obj.converged("vibe-trading", False))

    def test_group_status_absent_service_counts_as_stopped(self):
        # No fake container registered at all: `ps -q` reports nothing.
        runtime_obj = self.runtime()
        self.assertEqual(runtime_obj.group_status("vibe-trading", False), "Stopped")

    def test_group_status_still_running_when_desired_off_is_unhealthy_drift(self):
        self.docker.containers = {
            "vibe-trading": {"id": "c1", "status": "running", "health": "healthy"},
        }
        runtime_obj = self.runtime()
        self.assertEqual(runtime_obj.group_status("vibe-trading", False), "Unhealthy")
        self.assertFalse(runtime_obj.converged("vibe-trading", False))

    def test_group_status_needs_setup_for_desired_on_mirofish_without_config(self):
        runtime_obj = self.runtime()
        self.assertEqual(runtime_obj.group_status("mirofish", True), "Needs setup")
        # Needs-setup is resolved without even querying Docker.
        self.assertEqual(self.docker.calls, [])

    def test_group_status_mirofish_ready_queries_docker_normally(self):
        self.write_mirofish_env()
        self.docker.containers = {
            "mirofish": {"id": "c1", "status": "running", "health": "healthy"},
        }
        runtime_obj = self.runtime()
        self.assertEqual(runtime_obj.group_status("mirofish", True), "Running")

    def test_group_status_rejects_unknown_app_and_bad_enabled(self):
        runtime_obj = self.runtime()
        with self.assertRaises(ValueError):
            runtime_obj.group_status("expense", True)
        with self.assertRaises(ValueError):
            runtime_obj.group_status("vibe-trading", "on")

    # -- controller ruling: group_status(..., observations=...) reuse --------
    # observations shape, documented for the server consumer: the exact dict
    # service_states() returns -- {service_name: {"status": <docker status
    # string, "absent" if no container>, "health": "healthy"|"unhealthy"|
    # "starting"|"none"|None}}. A service_id missing from the map (a caller
    # that only collected a subset) is treated as absent, same as
    # service_states()'s own default.

    def test_group_status_with_observations_never_touches_docker(self):
        observations = {
            "ta-terminal": {"status": "running", "health": "healthy"},
            "ta-research": {"status": "running", "health": "healthy"},
        }
        runtime_obj = self.runtime()
        self.assertEqual(
            runtime_obj.group_status("tradingagents", True, observations=observations),
            "Running",
        )
        self.assertEqual(self.docker.calls, [])

    def test_group_status_reuses_one_observations_map_across_two_apps(self):
        # The exact "one batch classifies every group" reuse Task 3 needs:
        # the same dict, collected once, correctly classifies two different
        # apps without mutation or cross-talk.
        observations = {
            "ta-terminal": {"status": "running", "health": "healthy"},
            "ta-research": {"status": "running", "health": "healthy"},
            "vibe-trading": {"status": "exited", "health": None},
        }
        before = dict(observations)
        runtime_obj = self.runtime()
        self.assertEqual(
            runtime_obj.group_status("tradingagents", True, observations=observations), "Running",
        )
        self.assertEqual(
            runtime_obj.group_status("vibe-trading", False, observations=observations), "Stopped",
        )
        self.assertEqual(observations, before)
        self.assertEqual(self.docker.calls, [])

    def test_group_status_observations_missing_a_mapped_service_is_absent(self):
        runtime_obj = self.runtime()
        self.assertEqual(
            runtime_obj.group_status("vibe-trading", False, observations={}), "Stopped",
        )
        self.assertEqual(
            runtime_obj.group_status("vibe-trading", True, observations={}), "Unhealthy",
        )
        self.assertEqual(self.docker.calls, [])

    def test_group_status_without_observations_still_queries_docker(self):
        # Old two-argument calls keep working exactly as before.
        self.docker.containers = {
            "vibe-trading": {"id": "c1", "status": "running", "health": "healthy"},
        }
        runtime_obj = self.runtime()
        self.assertEqual(runtime_obj.group_status("vibe-trading", True), "Running")
        self.assertTrue(len(self.docker.calls) > 0)

    def test_group_status_rejects_non_dict_observations(self):
        runtime_obj = self.runtime()
        with self.assertRaises(ValueError):
            runtime_obj.group_status("vibe-trading", True, observations=["not", "a", "dict"])

    # -- prepare_mirofish() ---------------------------------------------------

    def test_missing_run_credentials_uses_shared_preparer(self):
        self.docker.preparer_returncode = 0
        self.docker.preparer_side_effect = self.write_mirofish_env
        runtime_obj = self.runtime()
        self.assertFalse(self.runtime_env.exists())
        self.assertTrue(runtime_obj.prepare_mirofish())
        self.assertEqual(self.docker.preparer_calls, 1)
        self.assertEqual(stat.S_IMODE(self.runtime_env.stat().st_mode), 0o600)

    def test_prepare_mirofish_failure_returns_false_not_raise(self):
        self.docker.preparer_returncode = 1
        runtime_obj = self.runtime()
        self.assertFalse(runtime_obj.prepare_mirofish())
        self.assertFalse(self.runtime_env.exists())

    def test_prepare_mirofish_timeout_returns_false_not_raise(self):
        def timing_out(argv, **kw):
            raise subprocess.TimeoutExpired(argv, kw.get("timeout"))

        runtime_obj = self.runtime(command=timing_out)
        self.assertFalse(runtime_obj.prepare_mirofish())

    def test_prepare_mirofish_argv_is_fixed_never_from_caller(self):
        runtime_obj = self.runtime()
        runtime_obj.prepare_mirofish()
        argv = self.docker.calls[0]
        self.assertEqual(argv[0], str(runtime.PREPARE_MIROFISH_SCRIPT))
        self.assertIn("--app-dir", argv)
        self.assertIn(str(self.app_dir), argv)
        self.assertNotIn("--lock-fd", argv)
        self.assertIsNone(self.docker.last_kwargs.get("pass_fds"))

    def test_prepare_mirofish_passes_inherited_lock_fd_through_pass_fds(self):
        runtime_obj = self.runtime()
        runtime_obj.prepare_mirofish(lock_fd=9)
        argv = self.docker.calls[0]
        self.assertIn("--lock-fd", argv)
        self.assertEqual(argv[argv.index("--lock-fd") + 1], "9")
        self.assertEqual(self.docker.last_kwargs.get("pass_fds"), (9,))

    def test_apply_mirofish_without_credentials_needs_setup_never_executes(self):
        runtime_obj = self.runtime()
        with self.assertRaises(RuntimeFailure) as ctx:
            runtime_obj.apply("mirofish", True)
        self.assertEqual(ctx.exception.code, "needs_setup")
        self.assertEqual(self.docker.calls, [])

    def test_apply_mirofish_with_credentials_starts_normally(self):
        self.write_mirofish_env()
        runtime_obj = self.runtime()
        runtime_obj.apply("mirofish", True)
        self.assertEqual(self.docker.calls[-1][-1], "mirofish")
        self.assertIn("up", self.docker.calls[-1])


class PrepareMirofishScriptTest(unittest.TestCase):
    """Concern (4): durable automated regression coverage for the REAL
    `production/prepare-mirofish.sh` entrypoint -- not `FakeDocker`, not a
    manual-only claim. Runs the actual script as a subprocess against a fake
    `docker` on PATH and a fake `family_config.py`, entirely under one
    `tempfile.TemporaryDirectory()` outside the repository. No real Docker
    socket (a plain shell-script shim on PATH, never `/var/run/docker.sock`),
    no real Firestore/provider call, no `.env`/key file inside `ai-trading/`.
    """

    SCRIPT = REPO_ROOT / "deploy" / "production" / "prepare-mirofish.sh"
    MIROFISH_LIB = REPO_ROOT / "deploy" / "production" / "mirofish-runtime.sh"
    CONTROL_SRC_DIR = REPO_ROOT / "control"
    # The two fixed-constant lines a staged copy may substitute -- always
    # matched verbatim and asserted unique, so a future reformat/rename of
    # either fails the relevant staging helper loudly instead of silently
    # leaving a Docker invocation unfaked or un-probed.
    DOCKER_BIN_TARGET = 'DOCKER_BIN="docker"'
    DOCKER_PATH_TARGET = 'DOCKER_PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"'
    # Resolved once from the TEST process's own full PATH, not the
    # restricted one `run_script()` gives the script itself: macOS ships a
    # bash 3.2 at /bin/bash (no `exec {fd}>file` auto-allocation support,
    # required by this script's self-acquire branch) -- production and the
    # prescribed Linux CI container both have a modern bash as `/bin/bash`.
    BASH = shutil.which("bash") or "/bin/bash"

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        root = Path(self._tmp.name)
        self.app_dir = root / "app"
        self.secrets_dir = root / "secrets"
        self.runtime_dir = root / "runtime"
        self.bin_dir = root / "bin"
        self.lock_path = root / "varlib" / ".control.lock"
        for directory in (
            self.app_dir, self.secrets_dir, self.runtime_dir,
            self.bin_dir, self.lock_path.parent,
        ):
            directory.mkdir(parents=True)
        self.docker_log = root / "docker.log"
        self.docker_env_log = root / "docker-env.log"
        self.mirofish_env = self.runtime_dir / "mirofish.env"
        self.write_image_metadata()
        self.write_fake_family_config(succeed=True)
        (self.app_dir / "docker-compose.yml").write_text("name: fixture\nservices: {}\n")
        (self.app_dir / "docker-compose.mirofish.yml").write_text(
            'name: fixture\nservices:\n  mirofish:\n    image: busybox\n    profiles: ["mirofish"]\n'
        )
        self.write_fake_docker()
        self.staged_script = self._stage_real_script_with_fake_docker()

    def _stage_real_script(self, target, replacement, name):
        """Copies the REAL prepare-mirofish.sh into this test's own writable
        tempdir (the prescribed Linux suite mounts the actual ai-trading
        tree read-only, so nothing can be staged in place), replacing
        exactly one occurrence of `target` with `replacement` -- asserted
        unique first, so a future reformat/rename of that constant fails
        this staging helper loudly instead of silently leaving a Docker
        invocation unfaked or un-probed. Mirrors the real
        deploy/production/control relative layout with symlinks to the
        REAL, unmodified mirofish-runtime.sh and control/state.py, so every
        other code path -- lease validation, metadata checks, render,
        recovery -- still runs exactly the real, reviewed source; only the
        one targeted line is substituted.
        """
        original = self.SCRIPT.read_text()
        occurrences = original.count(target)
        if occurrences != 1:
            raise AssertionError(
                f"expected exactly one {target!r} constant to replace in "
                f"{self.SCRIPT}, found {occurrences} -- update this staging "
                "helper to match the current script"
            )
        patched = original.replace(target, replacement)

        stage_root = Path(self._tmp.name) / f"stage-{name}"
        staged_production_dir = stage_root / "deploy" / "production"
        staged_production_dir.mkdir(parents=True)
        (staged_production_dir / "mirofish-runtime.sh").symlink_to(self.MIROFISH_LIB)
        (stage_root / "control").symlink_to(self.CONTROL_SRC_DIR)
        staged_script = staged_production_dir / "prepare-mirofish.sh"
        staged_script.write_text(patched)
        staged_script.chmod(0o755)
        return staged_script

    def _stage_real_script_with_fake_docker(self):
        """Substitutes ONLY the external command-boundary constant
        (`DOCKER_BIN="docker"`) with an absolute path to this test's fake
        docker shim -- never a production env-var override (removed
        entirely after a prior review round). Used by the tests that need
        compose() to run against a fake docker while otherwise exercising
        the real script body.
        """
        fake_docker = self.bin_dir / "docker"
        return self._stage_real_script(
            self.DOCKER_BIN_TARGET,
            f"DOCKER_BIN={shlex.quote(str(fake_docker))}",
            "fake-docker-bin",
        )

    def _stage_real_script_with_docker_path_literal(self, path_expr, name):
        """Substitutes ONLY the fixed `DOCKER_PATH` default literal with
        `path_expr` (a raw bash assignment right-hand side) -- `DOCKER_BIN`
        stays exactly `"docker"`, untouched, so bash's own ordinary PATH
        search still runs, just scoped to whatever directory `path_expr`
        names instead of real system directories. Used by the Docker-path
        regression below: `path_expr` must always be a fixture directory
        this test itself creates, never a real system directory, so this
        never reaches a real Docker socket no matter what happens to be
        installed on the machine running the suite.
        """
        return self._stage_real_script(
            self.DOCKER_PATH_TARGET, f"DOCKER_PATH={path_expr}", name,
        )

    def _write_signal_docker(self, directory, signal_path):
        # A minimal docker stand-in that only ever proves it ran, by
        # creating `signal_path` -- `#!/bin/sh` (an absolute, kernel-resolved
        # shebang) and the `:` builtin with a bare redirect (no external
        # `touch`), so this is fully self-contained and cannot itself fail
        # to run merely because the PATH scoping it onto is narrow.
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / "docker"
        path.write_text(f"#!/bin/sh\n: > {shlex.quote(str(signal_path))}\nexit 0\n")
        path.chmod(0o755)

    def write_image_metadata(self, tag=VALID_TAG):
        path = self.app_dir / "images.env"
        path.write_text(f"AI_TRADING_REGISTRY=fake-registry\nAI_TRADING_IMAGE_TAG={tag}\n")
        os.chmod(path, 0o644)

    def write_fake_family_config(self, succeed):
        path = self.app_dir / "family_config.py"
        if succeed:
            body = (
                "#!/usr/bin/env bash\nset -e\nshift\nout=\"\"\n"
                "while [ \"$#\" -gt 0 ]; do case \"$1\" in "
                "--out-dir) out=\"$2\"; shift 2;; *) shift;; esac; done\n"
                "printf 'ZEP_API_KEY=fake-zep\\nLLM_API_KEY=fake-llm\\n' > \"$out/mirofish.env\"\n"
            )
        else:
            body = (
                "#!/usr/bin/env bash\n"
                "echo 'family-config: profile not found: ai-trading/mirofish' >&2\n"
                "exit 1\n"
            )
        path.write_text(body)
        path.chmod(0o755)

    def write_fake_docker(self):
        # Never the real Docker socket: a plain PATH shim, logging every
        # call to the (literal, baked-in -- compose()'s own sanitized
        # `env -i` never passes a test's private $DOCKER_LOG/$DOCKER_ENV_LOG
        # through, by design) log paths so a test can assert exactly which
        # compose subcommands ran (and which never did). Also snapshots the
        # handful of environment variables concern (2) requires stay fixed
        # (DOCKER_HOST/DOCKER_CONTEXT) or absent (COMPOSE_PROFILES/
        # COMPOSE_FILE/HTTP_PROXY) regardless of whatever this PROCESS's own
        # ambient environment held when the script was invoked -- that
        # snapshot is `compose()`'s actual `env -i ...` argument, not this
        # test's own environment.
        path = self.bin_dir / "docker"
        docker_log = str(self.docker_log)
        docker_env_log = str(self.docker_env_log)
        path.write_text(
            "#!/usr/bin/env bash\n"
            f'echo "fake docker $*" >> {shlex.quote(docker_log)}\n'
            "printf 'DOCKER_HOST=%s\\nDOCKER_CONTEXT=%s\\nCOMPOSE_PROFILES=%s\\n"
            "COMPOSE_FILE=%s\\nHTTP_PROXY=%s\\n' "
            '"${DOCKER_HOST-<unset>}" "${DOCKER_CONTEXT-<unset>}" "${COMPOSE_PROFILES-<unset>}" '
            f'"${{COMPOSE_FILE-<unset>}}" "${{HTTP_PROXY-<unset>}}" >> {shlex.quote(docker_env_log)}\n'
            'case "${1:-}" in compose) exit 0;; esac\n'
            "exit 0\n"
        )
        path.chmod(0o755)

    def run_script(self, extra_args=(), env_overrides=None, pass_fds=(), script=None):
        # The script's own internal validate_inherited_lock_fd shells out to
        # `python3` (never duplicating state.py's lock logic) -- include
        # wherever *this* interpreter actually lives (python:3.12-slim's
        # python3 is under /usr/local/bin, not /usr/bin). self.bin_dir holds
        # this test's own PATH-resolved shims (e.g. a forced-failure `rm`),
        # resolved the ordinary way since those calls happen outside
        # compose()'s sandbox. This PATH is irrelevant to Docker command
        # selection either way: compose()'s own `env -i PATH="$DOCKER_PATH"`
        # replaces PATH entirely for that one child process with a fixed
        # production constant the script never reads from the environment,
        # regardless of what's on PATH out here or sitting in self.bin_dir.
        python_dir = str(Path(sys.executable).parent)
        env = {
            "PATH": f"{self.bin_dir}:{python_dir}:/usr/bin:/bin",
            "FAMILY_CONFIG_CREDENTIALS": str(Path(self._tmp.name) / "fake-reader-key.json"),
            "DEPLOY_SH_SKIP_CHOWN": "1",
            "PREPARE_MIROFISH_LOCK_PATH": str(self.lock_path),
        }
        if env_overrides:
            env.update(env_overrides)
        argv = [
            self.BASH, str(script or self.SCRIPT),
            "--app-dir", str(self.app_dir),
            "--secrets-dir", str(self.secrets_dir),
            "--runtime-dir", str(self.runtime_dir),
            "--owner-uid", str(os.getuid()),
            *extra_args,
        ]
        return subprocess.run(
            argv, env=env, capture_output=True, text=True, timeout=20, pass_fds=pass_fds,
        )

    def acquire_real_lock(self):
        self.lock_path.touch(mode=0o600)
        fd = os.open(self.lock_path, os.O_RDWR)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.addCleanup(os.close, fd)
        return fd

    def write_failing_rm(self):
        # Forces activate_mirofish's post-install scratch cleanup to fail
        # for real by shadowing `rm` on PATH for exactly the render-scratch
        # directory pattern -- works identically at any privilege level,
        # unlike a chmod-based injection (root bypasses DAC permission
        # checks entirely, so this suite running as root -- the prescribed
        # Linux container -- would otherwise never see the failure).
        failing_rm = self.bin_dir / "rm"
        failing_rm.write_text(
            "#!/usr/bin/env bash\n"
            'for arg in "$@"; do\n'
            '  case "$arg" in\n'
            "    *.mirofish-render-*) echo \"rm: $arg: Permission denied (simulated)\" >&2; exit 1 ;;\n"
            "  esac\n"
            "done\n"
            'exec /bin/rm "$@"\n'
        )
        failing_rm.chmod(0o755)

    # -- happy path / inherited lease -----------------------------------------

    def test_happy_path_with_inherited_lock_validates_and_installs(self):
        fd = self.acquire_real_lock()
        result = self.run_script(extra_args=["--lock-fd", str(fd)], pass_fds=(fd,))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(self.mirofish_env.exists())
        self.assertEqual(stat.S_IMODE(self.mirofish_env.stat().st_mode), 0o600)
        content = self.mirofish_env.read_text()
        self.assertIn("ZEP_API_KEY=fake-zep", content)
        self.assertIn("LLM_API_KEY=fake-llm", content)
        # The happy path only renders/installs a file -- it never needs to
        # call compose/docker at all (starting the container is apply()'s
        # separate job).
        self.assertFalse(self.docker_log.exists())

    # -- bad metadata / bad fd -------------------------------------------------

    def test_bad_image_metadata_fails_before_touching_lock_or_files(self):
        self.write_image_metadata(tag="not-a-sha")
        result = self.run_script()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("images.env", result.stderr)
        self.assertFalse(self.mirofish_env.exists())
        self.assertFalse(self.lock_path.exists())

    def test_rejects_64_character_hex_tag_not_a_valid_40_char_sha(self):
        # Review round 1, issue 1: the old SHA_RE made an extra 24 hex
        # characters optional (`^[0-9a-fA-F]{40}([0-9a-fA-F]{24})?$`), so a
        # 64-character value -- never a valid full commit SHA, and never
        # what control/runtime.py's Runtime._deployed_env() (exactly
        # `^[0-9a-fA-F]{40}$`) would accept -- slipped through here. A
        # direct standalone invocation must reject anything that validator
        # would reject, never accept a longer value it never would.
        self.write_image_metadata(tag="a" * 64)
        result = self.run_script()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("images.env", result.stderr)
        self.assertFalse(self.mirofish_env.exists())
        self.assertFalse(self.lock_path.exists())

    def test_bogus_lock_fd_is_rejected_without_leaking_secrets(self):
        result = self.run_script(extra_args=["--lock-fd", "123"])
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("inherited lifecycle lock is invalid", result.stderr)
        self.assertFalse(self.mirofish_env.exists())
        self.assertNotIn("fake-zep", result.stderr)
        self.assertNotIn("fake-llm", result.stderr)

    # -- missing profile / cleanup failure uses stop-only recovery -----------

    def test_missing_profile_fails_cleanly_writing_nothing(self):
        self.write_fake_family_config(succeed=False)
        result = self.run_script()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.mirofish_env.exists())
        self.assertNotIn("fake-zep", result.stderr)
        self.assertNotIn("fake-llm", result.stderr)

    def test_cleanup_failure_self_heals_via_stop_only_recovery_never_rm(self):
        # Forces activate_mirofish's post-install scratch cleanup to fail
        # for real, exercising this script's OWN stop_remove_mirofish_container
        # override: a bounded `compose stop`, never `rm`/`down`. Runs the
        # STAGED copy (real script body, only the external docker command
        # substituted -- see _stage_real_script_with_fake_docker) because
        # this path reaches compose(). Uses the inherited-lock path (not
        # self-acquire) so this test never depends on `flock(1)` being
        # installed -- that binary is exercised separately by
        # test_standalone_busy_lock_times_out_without_writing_anything.
        self.write_failing_rm()
        fd = self.acquire_real_lock()
        result = self.run_script(
            extra_args=["--lock-fd", str(fd)], pass_fds=(fd,), script=self.staged_script,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.mirofish_env.exists())
        self.assertIn("post-install cleanup failed", result.stderr)
        self.assertTrue(self.docker_log.exists())
        log = self.docker_log.read_text()
        self.assertIn("stop --timeout 60 mirofish", log)
        self.assertNotIn("rm -s -f mirofish", log)
        self.assertNotIn("down", log)
        self.assertNotIn("fake-zep", result.stderr)
        self.assertNotIn("fake-llm", result.stderr)

    # -- lock directory creation fails closed ----------------------------------

    def test_lock_parent_directory_failure_fails_closed_before_any_action(self):
        # Review round 1, issue 3: a failure to create/validate the lock
        # directory used to be swallowed with `|| true`, letting the script
        # fall through to `exec {fd}>"$LOCK_PATH"` and fail there instead
        # with a confusing redirect error -- or, worse, succeed against some
        # other pre-existing directory. Block the lock path's own parent
        # with a plain FILE (not a directory) so `install -d` must fail for
        # real, and assert this happens BEFORE any lock is opened/acquired
        # and before any activation is even attempted.
        blocker = Path(self._tmp.name) / "blocker-not-a-directory"
        blocker.write_text("not a directory\n")
        hostile_lock_path = blocker / "sub" / ".control.lock"
        result = self.run_script(env_overrides={"PREPARE_MIROFISH_LOCK_PATH": str(hostile_lock_path)})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("cannot create or validate the lifecycle lock directory", result.stderr)
        self.assertFalse(self.mirofish_env.exists())
        self.assertFalse(hostile_lock_path.exists())
        # The blocker file itself must be left exactly as it was -- this is
        # a fail-closed rejection, never an attempt to "fix" the obstruction.
        self.assertEqual(blocker.read_text(), "not a directory\n")

    # -- sanitized Docker environment ------------------------------------------

    def test_compose_invocation_sanitizes_hostile_ambient_docker_environment(self):
        # Review round 1, issue 2: compose() used to only ever PREPEND its
        # own variables onto whatever environment this process inherited --
        # a direct root-operator invocation could silently honor a hostile
        # or merely stale DOCKER_HOST (pointed at a remote daemon/context),
        # COMPOSE_PROFILES/COMPOSE_FILE (overriding which services/files
        # Compose resolves), or a proxy affecting registry/image resolution.
        # Simulates exactly that: these hostile values sit in the SCRIPT's
        # own process environment (as if set in a root operator's shell),
        # and must never reach the fake `docker` compose() actually invokes
        # -- verified by the fake docker's own env-log, not by this test's
        # assumptions about what `env -i` does. Runs the STAGED copy (real
        # script body, only the external docker command substituted) since
        # this path reaches compose().
        self.write_failing_rm()
        fd = self.acquire_real_lock()
        result = self.run_script(
            extra_args=["--lock-fd", str(fd)], pass_fds=(fd,), script=self.staged_script,
            env_overrides={
                "DOCKER_HOST": "ssh://attacker@remote-host",
                "COMPOSE_PROFILES": "every-profile",
                "COMPOSE_FILE": "/tmp/hostile-compose.yml",
                "HTTP_PROXY": "http://attacker.invalid:8080",
            },
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("post-install cleanup failed", result.stderr)
        self.assertTrue(self.docker_env_log.exists(), "compose() must have actually been invoked")
        snapshot = self.docker_env_log.read_text()
        self.assertIn("DOCKER_HOST=unix:///var/run/docker.sock", snapshot)
        self.assertIn("DOCKER_CONTEXT=default", snapshot)
        self.assertIn("COMPOSE_PROFILES=<unset>", snapshot)
        self.assertIn("COMPOSE_FILE=<unset>", snapshot)
        self.assertIn("HTTP_PROXY=<unset>", snapshot)
        self.assertNotIn("attacker", snapshot)

    def test_compose_docker_path_resolution_is_fixed_never_env_overridable(self):
        # Re-review round 2: the prior version of this regression ran the
        # REAL, UNSTAGED script -- whose compose() reaches the real local
        # Docker socket once DOCKER_PATH/DOCKER_BIN resolve normally -- and
        # forced recovery through write_failing_rm(), so on a developer host
        # with Docker and a real `ai-trading` MiroFish container, this test
        # could have issued a REAL `docker compose stop` against it. Never
        # acceptable, regardless of how unlikely in practice.
        #
        # This version instead stages a copy of the real script with ONLY
        # its fixed DOCKER_PATH *default* literal substituted for a SAFE
        # fixture directory -- DOCKER_BIN stays exactly "docker", untouched,
        # so bash's own ordinary PATH search still runs, just scoped to this
        # fixture. Setting the (removed) PREPARE_MIROFISH_DOCKER_PATH env var
        # to a SEPARATE, genuinely malicious shim must have zero effect: the
        # staged copy's DOCKER_PATH is a fixed string literal, never an
        # environment read, exactly matching the real production file's own
        # pattern. Neither directory here is ever a real system directory,
        # so no step in this test can reach a real Docker socket, regardless
        # of whether Docker happens to be installed on the host running it.
        safe_dir = Path(self._tmp.name) / "safe-docker-bin"
        safe_signal = Path(self._tmp.name) / "safe-docker-ran"
        self._write_signal_docker(safe_dir, safe_signal)
        malicious_dir = Path(self._tmp.name) / "malicious-docker-bin"
        malicious_signal = Path(self._tmp.name) / "malicious-docker-ran"
        self._write_signal_docker(malicious_dir, malicious_signal)

        staged = self._stage_real_script_with_docker_path_literal(
            shlex.quote(str(safe_dir)), "safe-fixed-path",
        )
        self.write_failing_rm()
        fd = self.acquire_real_lock()
        result = self.run_script(
            extra_args=["--lock-fd", str(fd)], pass_fds=(fd,), script=staged,
            env_overrides={"PREPARE_MIROFISH_DOCKER_PATH": str(malicious_dir)},
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("post-install cleanup failed", result.stderr)
        self.assertTrue(
            safe_signal.exists(),
            "compose() should have run against the fixed/safe fixture PATH",
        )
        self.assertFalse(
            malicious_signal.exists(),
            "a hostile PREPARE_MIROFISH_DOCKER_PATH must never select the Docker command",
        )
        self.assertNotIn("fake-zep", result.stderr)
        self.assertNotIn("fake-llm", result.stderr)

    def test_regression_would_catch_a_reintroduced_docker_path_override(self):
        # Sensitivity probe, entirely offline: if the historical vulnerable
        # `DOCKER_PATH="${PREPARE_MIROFISH_DOCKER_PATH:-...}"` pattern were
        # ever reintroduced, prove the SAME staged-copy technique above would
        # catch it -- a synthetic mutation of the staged copy used only for
        # this probe, never the committed production file (which has no such
        # pattern; see test_compose_docker_path_resolution_is_fixed_never_env_overridable
        # above for the real file's own behavior). Still never touches a
        # real system directory or Docker socket: both the trusted default
        # and the hostile override here are fixture directories this test
        # creates.
        safe_dir = Path(self._tmp.name) / "safe-docker-bin-2"
        safe_signal = Path(self._tmp.name) / "safe-docker-ran-2"
        self._write_signal_docker(safe_dir, safe_signal)
        malicious_dir = Path(self._tmp.name) / "malicious-docker-bin-2"
        malicious_signal = Path(self._tmp.name) / "malicious-docker-ran-2"
        self._write_signal_docker(malicious_dir, malicious_signal)

        vulnerable_path_expr = f'"${{PREPARE_MIROFISH_DOCKER_PATH:-{safe_dir}}}"'
        staged = self._stage_real_script_with_docker_path_literal(
            vulnerable_path_expr, "vulnerable-reintroduced-path",
        )
        self.write_failing_rm()
        fd = self.acquire_real_lock()
        result = self.run_script(
            extra_args=["--lock-fd", str(fd)], pass_fds=(fd,), script=staged,
            env_overrides={"PREPARE_MIROFISH_DOCKER_PATH": str(malicious_dir)},
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(
            malicious_signal.exists(),
            "this synthetic reintroduction of the historical bug should have been caught",
        )

    # -- standalone busy lock --------------------------------------------------

    def test_standalone_busy_lock_times_out_without_writing_anything(self):
        if not shutil.which("flock"):
            self.skipTest("flock(1) is not installed in this environment")
        self.lock_path.touch(mode=0o600)
        holder = subprocess.Popen(
            [
                sys.executable, "-c",
                "import fcntl,sys,time\n"
                "fd = open(sys.argv[1], 'r+')\n"
                "fcntl.flock(fd.fileno(), fcntl.LOCK_EX)\n"
                "print('locked', flush=True)\n"
                "time.sleep(float(sys.argv[2]))\n",
                str(self.lock_path), "3",
            ],
            stdout=subprocess.PIPE, text=True,
        )
        try:
            self.assertEqual(holder.stdout.readline().strip(), "locked")
            result = self.run_script(env_overrides={"PREPARE_MIROFISH_LOCK_WAIT_SECONDS": "1"})
        finally:
            holder.wait(timeout=10)
            holder.stdout.close()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("could not acquire the lifecycle lock", result.stderr)
        self.assertFalse(self.mirofish_env.exists())


if __name__ == "__main__":
    unittest.main()
