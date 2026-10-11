"""Heartbeat must prove liveness, never manufacture research progress."""

import json
import sqlite3
import threading
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from ta_web import worker as worker_module
from ta_web.domain import BusyError, Inputs, owner_key, public_view
from ta_web.store import Store
from ta_web.worker import run_research
from test_runner import FakeGraph


class ProgressTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.store = Store(self.root)
        self.owner = owner_key("progress-owner")
        self.inputs = Inputs(
            ticker="SPY", analysis_date="2026-10-09", asset_type="stock", analysts=["market"], research_depth=1
        )

    def test_heartbeat_and_sharing_do_not_advance_research_progress(self):
        with patch("ta_web.store._utc_now_iso", return_value="2026-10-11T10:00:00.000000Z"):
            run = self.store.create(self.owner, self.inputs)
        self.assertEqual(run.get("last_progress_at"), "2026-10-11T10:00:00.000000Z")
        self.assertIsNone(run.get("heartbeat_at"))
        with patch("ta_web.store._utc_now_iso", return_value="2026-10-11T10:00:05.000000Z"):
            self.assertTrue(self.store.heartbeat(run["id"]))
        beat = self.store.worker_run(run["id"])
        self.assertEqual(beat["heartbeat_at"], "2026-10-11T10:00:05.000000Z")
        self.assertEqual(beat["last_progress_at"], run["last_progress_at"])
        self.assertEqual(beat["updated_at"], run["updated_at"])
        with patch("ta_web.store._utc_now_iso", return_value="2026-10-11T10:00:10.000000Z"):
            self.store.update(run["id"], state={"market_report": "research output"}, stage="analyst", progress=True)
        with patch("ta_web.store._utc_now_iso", return_value="2026-10-11T10:00:15.000000Z"):
            self.store.set_shared(run["id"], self.owner, True)
        view = public_view(self.store.worker_run(run["id"]), owner_key("progress-reader"))
        self.assertEqual(view["last_progress_at"], "2026-10-11T10:00:10.000000Z")
        self.assertEqual(view["heartbeat_at"], "2026-10-11T10:00:05.000000Z")
        self.assertNotIn("owner_id", view)
        self.assertNotIn(self.owner, json.dumps(view))

    def test_heartbeat_cannot_modify_or_revive_a_terminal_run(self):
        for status in ("completed", "failed", "interrupted"):
            with self.subTest(status=status):
                run = self.store.create(self.owner, self.inputs)
                self.store.update(run["id"], status=status)
                before = self.store.worker_run(run["id"])
                self.assertFalse(self.store.heartbeat(run["id"]))
                self.assertEqual(self.store.worker_run(run["id"]), before)

    def test_old_database_upgrades_concurrently_without_losing_reports(self):
        legacy = self.root / "legacy" / "research"
        legacy.mkdir(parents=True)
        run_id = str(uuid.uuid4())
        with closing(sqlite3.connect(legacy / "index.db")) as conn:
            conn.execute("""CREATE TABLE runs (
                id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, inputs TEXT NOT NULL,
                origin TEXT NOT NULL, status TEXT NOT NULL, stage TEXT,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL, shared INTEGER NOT NULL,
                state TEXT NOT NULL, settings TEXT NOT NULL, artifacts_ready INTEGER NOT NULL,
                partial INTEGER NOT NULL, fingerprint TEXT, error_code TEXT
            )""")
            conn.execute(
                "INSERT INTO runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (run_id, self.owner, json.dumps(self.inputs.model_dump()), "web", "completed", "finished",
                 "2026-10-10T10:00:00Z", "2026-10-10T10:01:00Z", 1,
                 '{"market_report":"existing report"}', "{}", 1, 0, None, None),
            )
            conn.commit()
        barrier = threading.Barrier(2)

        def reopen(_):
            barrier.wait(timeout=5)
            return Store(legacy.parent).get_owned(run_id, self.owner)

        with ThreadPoolExecutor(max_workers=2) as pool:
            rows = list(pool.map(reopen, range(2)))
        for row in rows:
            self.assertEqual(row["state"]["market_report"], "existing report")
            self.assertTrue(row["shared"])
            self.assertTrue(row["artifacts_ready"])
            self.assertIn("heartbeat_at", row)
            self.assertIn("last_progress_at", row)
            self.assertIsNone(row["heartbeat_at"])
            self.assertIsNone(row["last_progress_at"])

    def test_worker_heartbeats_while_graph_waits_and_stops_after_completion(self):
        run = self.store.create(self.owner, self.inputs)
        waiting, observed, release = threading.Event(), threading.Event(), threading.Event()
        baseline = {}
        store = self.store
        real_heartbeat = getattr(Store, "heartbeat", None)

        def observe_heartbeat(instance, run_id):
            result = real_heartbeat(instance, run_id)
            if waiting.is_set():
                observed.set()
            return result

        class WaitingGraph(FakeGraph):
            def stream_run(self, *args, **kwargs):
                yield [], {"market_report": "first analysis"}
                baseline.update(store.worker_run(run["id"]))
                waiting.set()
                if not release.wait(timeout=5):
                    raise RuntimeError("test graph was not released")
                yield [], {"final_trade_decision": "HOLD"}

        with patch("ta_web.worker._HEARTBEAT_INTERVAL_SECONDS", 0.02, create=True), patch.object(
            Store, "heartbeat", observe_heartbeat, create=True
        ):
            worker = threading.Thread(target=run_research, args=(self.root, run["id"], WaitingGraph))
            worker.start()
            try:
                self.assertTrue(waiting.wait(timeout=2), "graph never reached its waiting phase")
                self.assertTrue(observed.wait(timeout=2), "worker stopped heartbeating while waiting for research")
                live = store.worker_run(run["id"])
                self.assertEqual(live["status"], "running")
                self.assertNotEqual(live.get("heartbeat_at"), baseline.get("heartbeat_at"))
                self.assertEqual(live.get("last_progress_at"), baseline.get("last_progress_at"))
                self.assertEqual(live["updated_at"], baseline["updated_at"])
            finally:
                release.set()
                worker.join(timeout=5)
        self.assertFalse(worker.is_alive())
        self.assertEqual(store.worker_run(run["id"])["status"], "completed")
        self.assertFalse(any(t.name == "research-heartbeat" and t.is_alive() for t in threading.enumerate()))

    def test_completed_message_only_steps_advance_activity_without_saving_messages(self):
        run = self.store.create(self.owner, self.inputs)
        seen = []
        store = self.store

        class MessageGraph(FakeGraph):
            def stream_run(self, *args, **kwargs):
                with patch("ta_web.store._utc_now_iso", return_value="2026-10-11T10:00:30.000000Z"):
                    yield ["private-tool-message-sentinel"], None
                    seen.append(store.worker_run(run["id"]))
                yield [], {"market_report": "analysis", "final_trade_decision": "HOLD"}

        with patch("ta_web.store._utc_now_iso", return_value="2026-10-11T10:00:00.000000Z"):
            run_research(self.root, run["id"], MessageGraph)
        self.assertEqual(seen[0]["last_progress_at"], "2026-10-11T10:00:30.000000Z")
        self.assertNotIn("private-tool-message-sentinel", json.dumps(store.worker_run(run["id"])))

    def test_transient_database_failure_does_not_permanently_stop_heartbeats(self):
        run = self.store.create(self.owner, self.inputs)
        retried, release = threading.Event(), threading.Event()
        real_heartbeat = Store.heartbeat
        attempts = []

        def fail_once(instance, run_id):
            if not attempts:
                attempts.append("failed")
                raise sqlite3.OperationalError("temporary database contention")
            result = real_heartbeat(instance, run_id)
            retried.set()
            return result

        class WaitingGraph(FakeGraph):
            def stream_run(self, *args, **kwargs):
                if not release.wait(timeout=5):
                    raise RuntimeError("test graph was not released")
                yield [], {"market_report": "analysis", "final_trade_decision": "HOLD"}

        with patch("ta_web.worker._HEARTBEAT_INTERVAL_SECONDS", 0.02), patch.object(Store, "heartbeat", fail_once):
            worker = threading.Thread(target=run_research, args=(self.root, run["id"], WaitingGraph))
            worker.start()
            try:
                self.assertTrue(retried.wait(timeout=2), "temporary storage failure permanently stopped monitoring")
                self.assertIsNotNone(self.store.worker_run(run["id"])["heartbeat_at"])
            finally:
                release.set()
                worker.join(timeout=5)
        self.assertFalse(worker.is_alive())
        self.assertEqual(self.store.worker_run(run["id"])["status"], "completed")

    def test_database_open_recovers_from_transient_wal_contention(self):
        real_connect = sqlite3.connect
        failures = []
        connections = []

        class BusyOnceConnection(sqlite3.Connection):
            def execute(self, sql, *args):
                if sql == "PRAGMA journal_mode=WAL" and not failures:
                    failures.append(True)
                    error = sqlite3.OperationalError("database is locked")
                    error.sqlite_errorcode = sqlite3.SQLITE_BUSY
                    raise error
                return super().execute(sql, *args)

        def connect(*args, **kwargs):
            conn = real_connect(*args, **kwargs, factory=BusyOnceConnection)
            connections.append(conn)
            return conn

        root = self.root / "retry-open"
        try:
            with patch("ta_web.store.sqlite3.connect", connect):
                recovered = Store(root)
                run = recovered.create(self.owner, self.inputs)
            self.assertEqual(Store(root).get_owned(run["id"], self.owner)["inputs"]["ticker"], "SPY")
        finally:
            for conn in connections:
                conn.close()

    def test_database_open_closes_connection_after_nontransient_failure(self):
        real_connect = sqlite3.connect
        connections = []

        class FailedConnection(sqlite3.Connection):
            def execute(self, sql, *args):
                if sql == "PRAGMA journal_mode=WAL":
                    error = sqlite3.OperationalError("storage failed")
                    error.sqlite_errorcode = sqlite3.SQLITE_IOERR
                    raise error
                return super().execute(sql, *args)

        def connect(*args, **kwargs):
            conn = real_connect(*args, **kwargs, factory=FailedConnection)
            connections.append(conn)
            return conn

        try:
            with patch("ta_web.store.sqlite3.connect", connect), self.assertRaises(sqlite3.OperationalError):
                Store(self.root / "failed-open")
            with self.assertRaises(sqlite3.ProgrammingError):
                connections[0].execute("SELECT 1")
        finally:
            for conn in connections:
                conn.close()

    def test_end_time_survives_sharing_and_restart_recovery(self):
        run = self.store.create(self.owner, self.inputs)
        with patch("ta_web.store._utc_now_iso", return_value="2026-10-11T10:02:00.000000Z"):
            self.store.update(run["id"], status="failed", error_code="RESEARCH_FAILED")
        with patch("ta_web.store._utc_now_iso", return_value="2026-10-11T10:05:00.000000Z"):
            self.store.set_shared(run["id"], self.owner, True)
        self.assertEqual(self.store.worker_run(run["id"]).get("ended_at"), "2026-10-11T10:02:00.000000Z")
        active = self.store.create(self.owner, self.inputs)
        with patch("ta_web.store._utc_now_iso", return_value="2026-10-11T10:06:00.000000Z"):
            self.store.mark_interrupted()
        self.assertEqual(self.store.worker_run(active["id"]).get("ended_at"), "2026-10-11T10:06:00.000000Z")

    def test_failed_research_stays_processing_until_partial_reports_finish(self):
        run = self.store.create(self.owner, self.inputs)
        publishing, release = threading.Event(), threading.Event()
        real_publish = worker_module.publish

        class FailingGraph(FakeGraph):
            def stream_run(self, *args, **kwargs):
                yield [], {"market_report": "saved analysis"}
                raise RuntimeError("synthetic research failure")

        def paused_publish(store, run_id):
            publishing.set()
            if not release.wait(timeout=5):
                raise RuntimeError("test publisher was not released")
            return real_publish(store, run_id)

        with patch("ta_web.worker.publish", paused_publish):
            thread = threading.Thread(target=run_research, args=(self.root, run["id"], FailingGraph))
            thread.start()
            try:
                self.assertTrue(publishing.wait(timeout=2))
                pending = self.store.worker_run(run["id"])
                self.assertEqual(pending["status"], "running", "UI would stop polling before exports finish")
                self.assertEqual(pending["stage"], "exporting")
                self.assertEqual(pending["error_code"], "RESEARCH_FAILED")
                self.assertTrue(pending["partial"])
                self.assertFalse(pending["artifacts_ready"])
                with self.assertRaises(BusyError):
                    self.store.create(self.owner, self.inputs)
            finally:
                release.set()
                thread.join(timeout=5)
        self.assertFalse(thread.is_alive())
        saved = self.store.worker_run(run["id"])
        self.assertEqual(saved["status"], "failed")
        self.assertTrue(saved["artifacts_ready"])
        self.assertIsNotNone(saved["ended_at"])
