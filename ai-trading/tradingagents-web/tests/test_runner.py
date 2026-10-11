"""Tests for ta_web.worker / ta_web.runner: isolated execution and process
supervision. ``FakeGraph`` stands in for TradingAgentsGraph with the real
public method signatures observed on upstream 0.6.0; the real
``ta_web.reports.publish`` runs end-to-end everywhere below — no fake
runtime, provider, or publisher module is used anywhere here."""

import json
import stat
import sys
import textwrap
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from ta_web.domain import Inputs, owner_key
from ta_web.reports import run_directory
from ta_web.runner import Runner
from ta_web.store import Store
from ta_web.worker import EXPORT_FAILED, RESEARCH_FAILED, research_stage, run_research

_SECRET = "provider-secret-sentinel"


def _inputs(**overrides):
    base = {
        "ticker": "SPY",
        "analysis_date": "2026-10-09",
        "asset_type": "stock",
        "analysts": ["market"],
        "research_depth": 2,
    }
    base.update(overrides)
    return Inputs(**base)


class _FakePropagator:
    def __init__(self, args):
        self._args = args

    def get_graph_args(self):
        return dict(self._args)


class FakeGraph:
    """Implements the upstream public surface run_research drives, with the
    real signatures from tradingagents.graph.trading_graph.TradingAgentsGraph."""

    def __init__(
        self, selected_analysts, config=None, stream=(), thread_id=None, on_record_decision=None, graph_args=None
    ):
        self.selected_analysts = list(selected_analysts)
        self.config = config or {}
        self.propagator = _FakePropagator(graph_args or {"stream_mode": "values", "config": {}})
        self._stream = list(stream)
        self._thread_id = thread_id
        self._on_record_decision = on_record_decision
        self.ended = False

    def run_settings(self):
        return {
            "version": "0.0.0-fake",
            "llm_provider": "openai",
            "deep_think_provider": "openai",
            "deep_think_llm": "fake-deep",
            "quick_think_provider": "openai",
            "quick_think_llm": "fake-quick",
            "analysts": self.selected_analysts,
            "max_debate_rounds": self.config.get("max_debate_rounds"),
            "max_risk_discuss_rounds": self.config.get("max_risk_discuss_rounds"),
            "output_language": "English",
            # Never in the public allowlist; proves safe_settings actually filters.
            "backend_url": f"https://example.invalid/{_SECRET}",
        }

    def create_run_state(self, ticker, trade_date, asset_type):
        return {"company_of_interest": ticker, "trade_date": trade_date, "asset_type": asset_type}

    def begin_checkpoint(self, ticker, trade_date, asset_type):
        return self._thread_id

    def checkpoint_input(self, initial):
        return initial

    def stream_run(self, graph_input, **args):
        yield from self._stream

    def record_decision(self, ticker, trade_date, state):
        if self._on_record_decision is not None:
            self._on_record_decision(state)

    def clear_checkpoint_on_success(self, ticker, trade_date, asset_type):
        pass

    def end_checkpoint(self):
        self.ended = True


class WorkerTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.store = Store(self.root)
        self.owner = owner_key("worker-owner")

    # --- Step 1 brief scenario: isolation + a real, end-to-end publish -------

    def test_worker_isolates_paths_and_publishes(self):
        run = self.store.create(self.owner, _inputs())
        seen = []

        def factory(*args, **kwargs):
            seen.append(kwargs["config"])
            return FakeGraph(
                *args,
                **kwargs,
                stream=[
                    ([], {"market_report": "market info"}),
                    ([], {"sentiment_report": "sentiment info", "final_trade_decision": "BUY"}),
                ],
            )

        run_research(self.root, run["id"], graph_factory=factory)
        saved = self.store.worker_run(run["id"])
        self.assertEqual(saved["status"], "completed")
        self.assertTrue(saved["artifacts_ready"])
        self.assertIn(run["id"], seen[0]["results_dir"])
        self.assertIn(run["id"], seen[0]["data_cache_dir"])
        self.assertIn(self.owner, seen[0]["memory_log_path"])
        self.assertNotIn(_SECRET, json.dumps(saved))

        # The real ta_web.reports.publish actually ran: a genuine export tree
        # exists on disk, anchored under reports.run_directory, with the
        # real report content in it — not a pretend/empty export.
        exports_dir = run_directory(self.store, run["owner_id"], run["id"]) / "exports"
        complete = (exports_dir / "complete_report.md").read_text()
        self.assertIn("market info", complete)
        self.assertIn("sentiment info", complete)
        self.assertTrue((exports_dir / "1_analysts" / "market.md").exists())

    # --- Path isolation, without needing the publish step --------------------

    def test_worker_builds_per_run_and_per_owner_paths(self):
        run = self.store.create(self.owner, _inputs())
        seen = []

        def factory(*args, **kwargs):
            seen.append(kwargs["config"])
            return FakeGraph(
                *args,
                **kwargs,
                stream=[([], {"market_report": "m"})],
                on_record_decision=lambda state: (_ for _ in ()).throw(RuntimeError("stop")),
            )

        run_research(self.root, run["id"], graph_factory=factory)
        self.assertIn(run["id"], seen[0]["results_dir"])
        self.assertIn(run["id"], seen[0]["data_cache_dir"])
        self.assertIn(self.owner, seen[0]["memory_log_path"])
        self.assertNotIn("data_cache_dir", seen[0]["memory_log_path"])

    def test_worker_applies_explicit_depth_to_both_rounds(self):
        run = self.store.create(self.owner, _inputs(research_depth=4))
        seen = []

        def factory(*args, **kwargs):
            seen.append(kwargs["config"])
            return FakeGraph(
                *args, **kwargs, on_record_decision=lambda state: (_ for _ in ()).throw(RuntimeError("stop"))
            )

        run_research(self.root, run["id"], graph_factory=factory)
        self.assertEqual(seen[0]["max_debate_rounds"], 4)
        self.assertEqual(seen[0]["max_risk_discuss_rounds"], 4)

    def test_worker_keeps_environment_defaults_when_depth_omitted(self):
        from tradingagents.default_config import DEFAULT_CONFIG

        run = self.store.create(self.owner, _inputs(research_depth=None))
        seen = []

        def factory(*args, **kwargs):
            seen.append(kwargs["config"])
            return FakeGraph(
                *args, **kwargs, on_record_decision=lambda state: (_ for _ in ()).throw(RuntimeError("stop"))
            )

        run_research(self.root, run["id"], graph_factory=factory)
        self.assertEqual(seen[0]["max_debate_rounds"], DEFAULT_CONFIG["max_debate_rounds"])
        self.assertEqual(seen[0]["max_risk_discuss_rounds"], DEFAULT_CONFIG["max_risk_discuss_rounds"])

    # --- Merge across stream chunks, and partial preservation on failure -----

    def test_worker_merges_chunks_without_discarding_earlier_reports(self):
        run = self.store.create(self.owner, _inputs())

        def factory(*args, **kwargs):
            return FakeGraph(
                *args,
                **kwargs,
                stream=[
                    ([], {"market_report": "market info"}),  # nested-analyst-style report
                    (
                        [],
                        {"sentiment_report": "sentiment info", "final_trade_decision": "BUY"},
                    ),  # later full top-level state
                ],
                on_record_decision=lambda state: (_ for _ in ()).throw(RuntimeError(_SECRET)),
            )

        run_research(self.root, run["id"], graph_factory=factory)
        saved = self.store.worker_run(run["id"])
        self.assertEqual(saved["status"], "failed")
        self.assertEqual(saved["error_code"], RESEARCH_FAILED)
        self.assertTrue(saved["partial"])
        # Both chunks' fields survived the merge; the first was not discarded
        # by the second's update().
        self.assertEqual(saved["state"]["market_report"], "market info")
        self.assertEqual(saved["state"]["sentiment_report"], "sentiment info")
        self.assertNotIn(_SECRET, json.dumps(saved))

        # Real report text existed, so the real publisher still exported a
        # partial terminal output — a failed research run is not a reason to
        # withhold whatever analysis did complete.
        self.assertTrue(saved["artifacts_ready"])
        exports_dir = run_directory(self.store, run["owner_id"], run["id"]) / "exports"
        self.assertIn("market info", (exports_dir / "complete_report.md").read_text())

    # --- Failure handling: fixed codes, no leaked secrets ---------------------

    def test_worker_records_research_failed_on_constructor_error(self):
        run = self.store.create(self.owner, _inputs())

        def factory(*args, **kwargs):
            raise RuntimeError(f"auth rejected: {_SECRET}")

        run_research(self.root, run["id"], graph_factory=factory)
        saved = self.store.worker_run(run["id"])
        self.assertEqual(saved["status"], "failed")
        self.assertEqual(saved["error_code"], RESEARCH_FAILED)
        self.assertFalse(saved["partial"])
        self.assertFalse(saved["artifacts_ready"])  # nothing ever ran; no publish attempt either
        self.assertNotIn(_SECRET, json.dumps(saved))

    def test_worker_records_research_failed_on_stream_error(self):
        run = self.store.create(self.owner, _inputs())

        def bad_stream():
            yield ([], {"market_report": "partial report"})
            raise RuntimeError(f"provider blew up: {_SECRET}")

        def factory(*args, **kwargs):
            graph = FakeGraph(*args, **kwargs)
            graph.stream_run = lambda *a, **k: bad_stream()
            return graph

        run_research(self.root, run["id"], graph_factory=factory)
        saved = self.store.worker_run(run["id"])
        self.assertEqual(saved["status"], "failed")
        self.assertEqual(saved["error_code"], RESEARCH_FAILED)
        self.assertTrue(saved["partial"])
        self.assertEqual(saved["state"]["market_report"], "partial report")
        self.assertEqual(saved["stage"], "analyst")
        self.assertNotIn(_SECRET, json.dumps(saved))

        # One real analyst report is enough for the real publisher to export
        # a genuine (if partial) terminal output.
        self.assertTrue(saved["artifacts_ready"])
        exports_dir = run_directory(self.store, run["owner_id"], run["id"]) / "exports"
        self.assertIn("partial report", (exports_dir / "complete_report.md").read_text())

    def test_worker_ends_checkpoint_even_on_failure(self):
        run = self.store.create(self.owner, _inputs())
        holder = {}

        def factory(*args, **kwargs):
            graph = FakeGraph(
                *args, **kwargs, on_record_decision=lambda state: (_ for _ in ()).throw(RuntimeError("boom"))
            )
            holder["graph"] = graph
            return graph

        run_research(self.root, run["id"], graph_factory=factory)
        self.assertTrue(holder["graph"].ended)

    def test_worker_records_export_failed_when_nothing_real_to_publish(self):
        """A run that produced no analyst/debate text and no decision — only
        the header fields create_run_state seeds — is a genuine case the
        real ta_web.reports.publish refuses ("no header-only pretend
        analysis"). No stream chunk, no exception: research "succeeds" with
        nothing in it, and the real publisher is the one that says no."""
        run = self.store.create(self.owner, _inputs())

        def factory(*args, **kwargs):
            return FakeGraph(*args, **kwargs)  # empty stream; never raises

        run_research(self.root, run["id"], graph_factory=factory)
        saved = self.store.worker_run(run["id"])
        self.assertEqual(saved["status"], "failed")
        self.assertEqual(saved["error_code"], EXPORT_FAILED)
        self.assertTrue(saved["partial"])
        self.assertFalse(saved["artifacts_ready"])
        exports_dir = run_directory(self.store, run["owner_id"], run["id"]) / "exports"
        self.assertFalse(exports_dir.exists())  # refused, not written half-done

    def test_worker_persists_safe_settings_allowlist_only(self):
        run = self.store.create(self.owner, _inputs())

        def factory(*args, **kwargs):
            return FakeGraph(
                *args, **kwargs, on_record_decision=lambda state: (_ for _ in ()).throw(RuntimeError("stop"))
            )

        run_research(self.root, run["id"], graph_factory=factory)
        saved = self.store.worker_run(run["id"])
        self.assertEqual(saved["settings"]["llm_provider"], "openai")
        self.assertNotIn("backend_url", saved["settings"])
        self.assertNotIn(_SECRET, json.dumps(saved))


class ResearchStageTestCase(unittest.TestCase):
    def test_stage_progression(self):
        self.assertEqual(research_stage({}), "analyst")
        self.assertEqual(research_stage({"market_report": "x"}), "analyst")
        self.assertEqual(research_stage({"investment_plan": "x"}), "research")
        self.assertEqual(research_stage({"investment_debate_state": {"bull_history": "x"}}), "research")
        self.assertEqual(research_stage({"trader_investment_plan": "x"}), "trading")
        self.assertEqual(research_stage({"risk_debate_state": {"aggressive_history": "x"}}), "risk")
        self.assertEqual(research_stage({"final_trade_decision": "BUY"}), "finished")
        # Finished outranks everything else once the decision lands.
        self.assertEqual(
            research_stage({"market_report": "x", "risk_debate_state": {}, "final_trade_decision": "BUY"}),
            "finished",
        )


def _write_script(path: Path, body: str) -> None:
    path.write_text(f"#!/usr/bin/env python3\n{textwrap.dedent(body)}")
    path.chmod(path.stat().st_mode | stat.S_IEXEC)


class RunnerTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.store = Store(self.root)
        self.owner = owner_key("runner-owner")

    def _running_record(self):
        return self.store.create(self.owner, _inputs())

    # --- argv contract: no shell, exact child command -------------------------

    def test_start_launches_exact_argv_without_shell(self):
        runner = Runner(self.root)
        # This test only checks the Popen call contract; stub out the reap
        # thread so it never races the fake, immediately-"exited" process
        # against this test's own store/tmpdir teardown.
        runner._reap = lambda id, proc: None
        run = self._running_record()
        captured = {}
        import subprocess as subprocess_module

        real_popen = subprocess_module.Popen

        class _FakeProc:
            pid = 999999999

            def wait(self, timeout=None):
                return 0

            def poll(self):
                return 0

        def fake_popen(argv, **kwargs):
            captured["argv"] = argv
            captured["kwargs"] = kwargs
            return _FakeProc()

        subprocess_module.Popen = fake_popen
        try:
            runner.start(run["id"])
        finally:
            subprocess_module.Popen = real_popen

        self.assertEqual(
            captured["argv"],
            [sys.executable, "-m", "ta_web.worker", "--root", str(self.root), "--run-id", run["id"]],
        )
        self.assertEqual(captured["kwargs"]["stdout"], subprocess_module.DEVNULL)
        self.assertEqual(captured["kwargs"]["stderr"], subprocess_module.DEVNULL)
        self.assertTrue(captured["kwargs"]["start_new_session"])
        self.assertNotIn("shell", captured["kwargs"])

    def test_start_launch_failure_marks_failed_without_leaving_busy(self):
        runner = Runner(self.root)
        run = self._running_record()
        import subprocess as subprocess_module

        real_popen = subprocess_module.Popen

        def fake_popen(*args, **kwargs):
            raise OSError("no such executable")

        subprocess_module.Popen = fake_popen
        try:
            runner.start(run["id"])
        finally:
            subprocess_module.Popen = real_popen

        saved = self.store.worker_run(run["id"])
        self.assertEqual(saved["status"], "failed")
        self.assertEqual(saved["error_code"], "LAUNCH_FAILED")

    # --- real tiny child processes: abnormal exit, termination, shutdown -----

    def test_abnormal_exit_while_running_becomes_failed(self):
        script = Path(self.tmp.name) / "crash.py"
        _write_script(
            script,
            """
            import sys
            sys.exit(7)
        """,
        )

        class _ScriptRunner(Runner):
            def _argv(self, id):
                return [sys.executable, str(script)]

        runner = _ScriptRunner(self.root)
        run = self._running_record()
        runner.start(run["id"])

        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            saved = self.store.worker_run(run["id"])
            if saved["status"] != "running":
                break
            time.sleep(0.02)

        saved = self.store.worker_run(run["id"])
        self.assertEqual(saved["status"], "failed")
        self.assertEqual(saved["error_code"], RESEARCH_FAILED)

    def test_close_terminates_children_and_marks_interrupted_not_failed(self):
        script = Path(self.tmp.name) / "sleep.py"
        _write_script(
            script,
            """
            import time
            time.sleep(30)
        """,
        )

        class _ScriptRunner(Runner):
            def _argv(self, id):
                return [sys.executable, str(script)]

        runner = _ScriptRunner(self.root)
        run = self._running_record()
        runner.start(run["id"])
        time.sleep(0.1)  # let the child actually start before terminating it

        runner.close()

        saved = self.store.worker_run(run["id"])
        self.assertEqual(saved["status"], "interrupted")
        self.assertNotEqual(saved["status"], "failed")
        self.assertEqual(runner._children, {})

    def test_close_kills_after_grace_period_when_sigterm_is_ignored(self):
        script = Path(self.tmp.name) / "ignore_term.py"
        _write_script(
            script,
            """
            import signal
            import time
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
            time.sleep(30)
        """,
        )

        class _ScriptRunner(Runner):
            def _argv(self, id):
                return [sys.executable, str(script)]

        runner = _ScriptRunner(self.root)
        runner._grace_seconds = 0.3
        run = self._running_record()
        runner.start(run["id"])
        time.sleep(0.2)

        start = time.monotonic()
        runner.close()
        elapsed = time.monotonic() - start

        saved = self.store.worker_run(run["id"])
        self.assertEqual(saved["status"], "interrupted")
        self.assertLess(elapsed, 5)  # proves SIGKILL fired, not the full 5s default
        self.assertEqual(runner._children, {})

    def test_close_is_a_noop_with_no_children(self):
        runner = Runner(self.root)
        runner.close()  # must not raise


if __name__ == "__main__":
    unittest.main()
