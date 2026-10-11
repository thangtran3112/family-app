import json
import os
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

import runtime
from runtime import Runtime, RuntimeFailure

VALID_TAG = "a" * 40


class FakeDocker:
    """Stands in for the real `docker`/`docker compose` CLI, understanding
    only the exact argv shapes Runtime emits: `compose ps -q SERVICE...`,
    `docker inspect --format {{json .}} ID...`, `compose up ...`,
    `compose stop ...`, `compose config --images SERVICE...`,
    `docker image inspect REF...`, and the preparer script path. Mirrors the
    real CLI's own contracts (an absent service means empty `ps -q` output;
    `docker inspect` emits one JSON line per container) without a daemon.
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
            wanted = set(argv[argv.index("--format") + 2 :])
            lines = []
            for service, info in self.containers.items():
                if info["id"] not in wanted:
                    continue
                state = {"Status": info["status"]}
                if info.get("health") not in (None, "none"):
                    state["Health"] = {"Status": info["health"]}
                lines.append(json.dumps({
                    "State": state,
                    "Config": {"Labels": {"com.docker.compose.service": service}},
                }))
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
        # Production default owner_uid=0: a file this (non-root) test process
        # owns is never root, so the default must reject it rather than trust
        # metadata from an unexpected owner.
        runtime_obj = self.runtime(command=lambda argv, **kw: self.ok(), owner_uid=0)
        if os.getuid() == 0:
            self.skipTest("cannot exercise a non-root-owned rejection while running as root")
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


if __name__ == "__main__":
    unittest.main()
