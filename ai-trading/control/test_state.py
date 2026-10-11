import contextlib
import fcntl
import io
import json
import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from state import (
    CATALOG,
    APP_SERVICES,
    APP_IDS,
    PROTECTED_SERVICES,
    Busy,
    Conflict,
    StateFailure,
    atomic_write,
    begin_change,
    finish_change,
    initial_state,
    main,
    read_state,
    refuse_unsafe_existing_path,
    restore_preferences,
    selected_services,
    validate_inherited_lock,
    validate_catalog,
    validate_state,
)


class StateTest(unittest.TestCase):
    def test_catalog_is_fixed_and_protected_services_are_not_controlled(self):
        self.assertEqual(
            APP_SERVICES,
            {
                "tradingagents": ("ta-terminal", "ta-research"),
                "ai-hedge-fund": ("ahf-terminal",),
                "vibe-trading": ("vibe-trading",),
                "mirofish": ("mirofish",),
            },
        )
        self.assertEqual(APP_IDS, ("tradingagents", "ai-hedge-fund", "vibe-trading", "mirofish"))
        self.assertEqual(
            PROTECTED_SERVICES,
            ("web", "gateway", "auth", "cloudflared", "market-data"),
        )
        self.assertEqual(CATALOG["schemaVersion"], 1)
        self.assertEqual(dict(CATALOG["apps"]), APP_SERVICES)
        catalog = json.loads((Path(__file__).with_name("catalog.json")).read_text())
        self.assertEqual(catalog["apps"], {
            "tradingagents": ["ta-terminal", "ta-research"],
            "ai-hedge-fund": ["ahf-terminal"],
            "vibe-trading": ["vibe-trading"],
            "mirofish": ["mirofish"],
        })
        self.assertEqual(
            catalog["protected"],
            ["web", "gateway", "auth", "cloudflared", "market-data"],
        )
        with self.assertRaises(ValueError):
            validate_catalog({**catalog, "extra": True})
        with self.assertRaises(ValueError):
            validate_catalog({key: value for key, value in catalog.items() if key != "protected"})
        self.assertFalse(set(PROTECTED_SERVICES).intersection(*APP_SERVICES.values()))

    def test_defaults_and_existing_app_adoption(self):
        self.assertEqual(initial_state(None)["desired"], {
            "tradingagents": True, "ai-hedge-fund": True,
            "vibe-trading": True, "mirofish": False})
        self.assertTrue(initial_state({"ta-research", "mirofish"})["desired"]["tradingagents"])
        self.assertTrue(initial_state({"mirofish"})["desired"]["mirofish"])
        self.assertFalse(any(initial_state(set())["desired"].values()))

    def test_selected_services_keeps_protected_and_gates_mirofish(self):
        state = initial_state(None)
        self.assertEqual(selected_services(state, False), (
            "web", "gateway", "auth", "cloudflared", "market-data",
            "ta-terminal", "ta-research", "ahf-terminal", "vibe-trading",
        ))
        state["desired"]["mirofish"] = True
        self.assertNotIn("mirofish", selected_services(state, False))
        self.assertIn("mirofish", selected_services(state, True))

    def test_stale_and_invalid_mutations_do_not_change_state(self):
        state = initial_state(None)
        before = json.loads(json.dumps(state))
        with self.assertRaises(Conflict):
            begin_change(state, "mirofish", True, 9, False)
        for bad_id in ("expense", "../mirofish", "market-data"):
            with self.subTest(app_id=bad_id), self.assertRaises(ValueError):
                begin_change(state, bad_id, True, 0, False)
        for bad in (1, "true", None):
            with self.subTest(enabled=bad), self.assertRaises(ValueError):
                begin_change(state, "mirofish", bad, 0, False)
        for bad_revision in (True, -1, "0"):
            with self.subTest(revision=bad_revision), self.assertRaises(ValueError):
                begin_change(state, "mirofish", True, bad_revision, False)
        self.assertEqual(state, before)

    def test_operation_idempotency_and_rollback_revision(self):
        state = initial_state(None)
        active, code = begin_change(state, "mirofish", True, 0, False)
        self.assertEqual(code, 202)
        same, code = begin_change(active, "mirofish", True, 1, False)
        self.assertEqual((code, same["operation"]["id"]), (202, active["operation"]["id"]))
        with self.assertRaises(Busy):
            begin_change(active, "vibe-trading", False, 1, False)
        done = finish_change(active, active["operation"]["id"], None)
        unchanged, code = begin_change(done, "mirofish", True, done["revision"], True)
        self.assertEqual((code, unchanged), (200, done))
        restored = restore_preferences(done, state)
        self.assertGreater(restored["revision"], done["revision"])
        self.assertEqual(restored["desired"], state["desired"])

    def test_actor_and_operation_validation(self):
        state = initial_state(None)
        for bad_actor in ("", "bad actor", "x" * 129):
            with self.subTest(actor=bad_actor), self.assertRaises(ValueError):
                begin_change(state, "mirofish", True, 0, False, actor_id=bad_actor)
        changed, _ = begin_change(state, "mirofish", True, 0, False, actor_id="user_123")
        with self.assertRaises(ValueError):
            finish_change(changed, "not-a-uuid", None)
        with self.assertRaises(ValueError):
            finish_change(changed, changed["operation"]["id"], "raw exception")
        with self.assertRaises(Conflict):
            finish_change(changed, "00000000-0000-4000-8000-000000000000", None)

    def test_other_app_change_does_not_erase_start_failure(self):
        state, _ = begin_change(initial_state(None), "mirofish", True, 0, False)
        state = finish_change(state, state["operation"]["id"], "operation_timeout")
        changed, _ = begin_change(state, "vibe-trading", False, state["revision"], False)
        self.assertEqual(changed["results"]["mirofish"]["errorCode"], "operation_timeout")

    def test_validation_rejects_unknown_keys_bad_revision_and_bad_operation(self):
        valid = initial_state(None)
        for mutation in (
            lambda value: value.update(extra=True),
            lambda value: value.update(schemaVersion=True),
            lambda value: value.update(revision=True),
            lambda value: value.update(revision=-1),
            lambda value: value["desired"].update(extra=True),
            lambda value: value["desired"].pop("mirofish"),
            lambda value: value["desired"].update(mirofish=1),
            lambda value: value["results"].update(extra=None),
            lambda value: value.update(operation={"id": "bad", "status": "unknown"}),
        ):
            bad = json.loads(json.dumps(valid))
            mutation(bad)
            with self.subTest(bad=bad), self.assertRaises(StateFailure):
                validate_state(bad)

    def test_atomic_file_and_corrupt_or_unsafe_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "control.json"
            atomic_write(path, initial_state(None), owner_uid=os.getuid())
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertEqual(validate_state(json.loads(path.read_text()))["revision"], 0)
            path.write_text("broken json")
            with self.assertRaises(StateFailure):
                read_state(path, owner_uid=os.getuid())
            path.unlink()
            path.symlink_to(Path(directory) / "outside")
            with self.assertRaises(StateFailure):
                atomic_write(path, initial_state(None), owner_uid=os.getuid())

    def test_atomic_write_preserves_previous_file_on_pre_replace_failures(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "control.json"
            original = initial_state(None)
            atomic_write(path, original, owner_uid=os.getuid())
            updated = initial_state(set())
            for failing_call in ("dump", "file_fsync", "replace"):
                with self.subTest(failing_call=failing_call):
                    def partial_write(*_args, **_kwargs):
                        _args[1].write('{"partial":')
                        raise OSError("write failed")

                    with contextlib.ExitStack() as stack:
                        if failing_call == "dump":
                            stack.enter_context(mock.patch(
                                "state.json.dump", side_effect=partial_write,
                            ))
                        elif failing_call == "file_fsync":
                            stack.enter_context(mock.patch(
                                "state.os.fsync", side_effect=OSError("sync failed"),
                            ))
                        else:
                            stack.enter_context(mock.patch(
                                "state.os.replace", side_effect=OSError("replace failed"),
                            ))
                        with self.assertRaises(StateFailure):
                            atomic_write(path, updated, owner_uid=os.getuid())
                    self.assertEqual(read_state(path, owner_uid=os.getuid()), original)

    def test_directory_fsync_failure_reports_uncertain_commit(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "control.json"
            old = initial_state(None)
            new = initial_state(set())
            atomic_write(path, old, owner_uid=os.getuid())
            real_fsync = os.fsync
            calls = 0

            def fail_directory_sync(fd):
                nonlocal calls
                calls += 1
                if calls == 2:
                    raise OSError("directory sync failed")
                return real_fsync(fd)

            with mock.patch("state.os.fsync", side_effect=fail_directory_sync):
                with self.assertRaises(StateFailure):
                    atomic_write(path, new, owner_uid=os.getuid())

    def test_unsafe_owner_permissions_and_parent_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "control.json"
            path.write_text("{}")
            os.chmod(path, 0o666)
            with self.assertRaises(StateFailure):
                refuse_unsafe_existing_path(path, owner_uid=os.getuid())
            os.chmod(path, 0o600)
            if os.getuid() != 0:
                with self.assertRaises(StateFailure):
                    refuse_unsafe_existing_path(path)
            else:
                os.chown(path, 65534, 65534)
                with self.assertRaises(StateFailure):
                    refuse_unsafe_existing_path(path)
                os.chown(path, os.getuid(), os.getgid())
            os.chmod(root, 0o777)
            with self.assertRaises(StateFailure):
                refuse_unsafe_existing_path(path, owner_uid=os.getuid())

    def test_inherited_lock_requires_same_root_owned_regular_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / ".control.lock"
            path.touch(mode=0o600)
            fd = os.open(path, os.O_RDWR)
            other_path = Path(directory) / "other.lock"
            other_path.touch(mode=0o600)
            other_fd = os.open(other_path, os.O_RDWR)
            try:
                if os.getuid() != 0:
                    with self.assertRaises(StateFailure):
                        validate_inherited_lock(fd, path)
                else:
                    os.chown(path, 65534, 65534)
                    with self.assertRaises(StateFailure):
                        validate_inherited_lock(fd, path)
                    os.chown(path, os.getuid(), os.getgid())
                with self.assertRaises(StateFailure):
                    validate_inherited_lock(other_fd, path, owner_uid=os.getuid())
                validate_inherited_lock(fd, path, owner_uid=os.getuid())
                second_fd = os.open(path, os.O_RDWR)
                try:
                    with self.assertRaises(BlockingIOError):
                        fcntl.flock(second_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                finally:
                    os.close(second_fd)
                path.unlink()
                path.symlink_to(Path(directory) / "other")
                with self.assertRaises(StateFailure):
                    validate_inherited_lock(fd, path, owner_uid=os.getuid())
            finally:
                os.close(other_fd)
                os.close(fd)

    def test_cli_init_snapshot_restore_and_keep_preserve_preferences(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state_path = root / "control.json"
            lock_path = root / ".control.lock"
            snapshot = root / "snapshot.json"
            args = [
                "--state", str(state_path), "--lock", str(lock_path),
                "--owner-uid", str(os.getuid()),
            ]
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(main([
                    "init", "--running-services-json", '["mirofish"]', *args,
                ]), 0)
                self.assertEqual(main(["init", "--running-services-json", "[]", *args]), 0)
                self.assertTrue(
                    read_state(state_path, owner_uid=os.getuid())["desired"]["mirofish"]
                )
                self.assertEqual(main(["snapshot", "--output", str(snapshot), *args]), 0)
                self.assertEqual(main(["set-mirofish", "--mode", "0", *args]), 0)
                self.assertFalse(
                    read_state(state_path, owner_uid=os.getuid())["desired"]["mirofish"]
                )
                self.assertEqual(main(["set-mirofish", "--mode", "keep", *args]), 0)
                self.assertFalse(
                    read_state(state_path, owner_uid=os.getuid())["desired"]["mirofish"]
                )
                self.assertEqual(main(["restore", "--snapshot", str(snapshot), *args]), 0)
            restored = read_state(state_path, owner_uid=os.getuid())
            self.assertTrue(restored["desired"]["mirofish"])
            self.assertEqual(restored["revision"], 2)

    def test_cli_services_emits_one_service_per_line(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state_path = root / "control.json"
            lock_path = root / ".control.lock"
            args = [
                "--state", str(state_path), "--lock", str(lock_path),
                "--owner-uid", str(os.getuid()),
            ]
            atomic_write(state_path, initial_state(None), owner_uid=os.getuid())
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                self.assertEqual(main(["services", "--mirofish-ready", "false", *args]), 0)
            self.assertEqual(output.getvalue().splitlines(), [
                "web", "gateway", "auth", "cloudflared", "market-data",
                "ta-terminal", "ta-research", "ahf-terminal", "vibe-trading",
            ])

    def test_cli_inherited_lock_is_not_unlocked(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state_path = root / "control.json"
            lock_path = root / ".control.lock"
            atomic_write(state_path, initial_state(None), owner_uid=os.getuid())
            lock_path.touch(mode=0o600)
            lock_fd = os.open(lock_path, os.O_RDWR)
            second_fd = None
            try:
                fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                self.assertEqual(main([
                    "set-mirofish", "--mode", "1", "--state", str(state_path),
                    "--lock", str(lock_path), "--owner-uid", str(os.getuid()),
                    "--lock-fd", str(lock_fd),
                ]), 0)
                second_fd = os.open(lock_path, os.O_RDWR)
                with self.assertRaises(BlockingIOError):
                    fcntl.flock(second_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                self.assertTrue(
                    read_state(state_path, owner_uid=os.getuid())["desired"]["mirofish"]
                )
            finally:
                if second_fd is not None:
                    os.close(second_fd)
                os.close(lock_fd)


if __name__ == "__main__":
    unittest.main()
