"""Tests for ta_web.reports / ta_web.import_reports: real exporter, no mocks."""

import io
import os
import unittest
import zipfile
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from ta_web.domain import Inputs, NotFoundError, owner_key
from ta_web.import_reports import import_folder
from ta_web.reports import ReportError, download, publish
from ta_web.store import Store


def _inputs(**overrides):
    base = {
        "ticker": "SPY",
        "analysis_date": "2026-10-09",
        "asset_type": "stock",
        "analysts": ["market"],
        "research_depth": 1,
    }
    base.update(overrides)
    return Inputs(**base)


class ReportsTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.store = Store(self.root)
        self.owner = owner_key("report-owner")

    def _completed_run(self, *, partial=False, state=None):
        run = self.store.create(self.owner, _inputs())
        self.store.update(
            run["id"],
            status="completed",
            partial=partial,
            state=state
            if state is not None
            else {
                "trade_date": "2026-10-09",
                "market_report": "safe market text",
                "final_trade_decision": "Buy",
            },
        )
        return run

    # --- Step 1 verbatim scenario -----------------------------------------

    def test_download_and_hostile_html(self):
        run = self.store.create(self.owner, _inputs())
        self.store.update(
            run["id"],
            status="completed",
            partial=False,
            state={
                "trade_date": "2026-10-09",
                "market_report": "<script>window.bad=1</script>\n![x](https://invalid.test/x)",
                "final_trade_decision": "Buy",
            },
        )
        publish(self.store, run["id"])
        content, mime, name = download(self.store, run["id"], self.owner, "html")
        self.assertEqual(mime, "text/html; charset=utf-8")
        self.assertIn(run["id"], name)
        self.assertNotIn(b"<script>", content)
        self.assertNotIn(b"<img", content)
        archive, _, _ = download(self.store, run["id"], self.owner, "zip")
        with zipfile.ZipFile(io.BytesIO(archive)) as z:
            self.assertIn("complete_report.md", z.namelist())
            self.assertTrue(
                all(
                    n == "complete_report.md"
                    or n == "complete_report.html"
                    or (
                        n.endswith(".md")
                        and n.split("/")[0] in {"1_analysts", "2_research", "3_trading", "4_risk", "5_portfolio"}
                    )
                    for n in z.namelist()
                )
            )

    # --- private reader denial / readiness ---------------------------------

    def test_download_denied_to_non_owner(self):
        run = self._completed_run()
        publish(self.store, run["id"])
        other = owner_key("someone-else")
        with self.assertRaises(NotFoundError):
            download(self.store, run["id"], other, "md")

    def test_download_not_ready_while_running(self):
        run = self.store.create(self.owner, _inputs())
        with self.assertRaises(ReportError) as ctx:
            download(self.store, run["id"], self.owner, "md")
        self.assertEqual(ctx.exception.code, "REPORT_NOT_READY")
        self.assertEqual(ctx.exception.status, 409)

    def test_download_not_ready_before_publish(self):
        run = self._completed_run()
        with self.assertRaises(ReportError) as ctx:
            download(self.store, run["id"], self.owner, "md")
        self.assertEqual(ctx.exception.code, "REPORT_NOT_READY")

    # --- format validation / traversal --------------------------------------

    def test_invalid_format_rejected(self):
        run = self._completed_run()
        publish(self.store, run["id"])
        with self.assertRaises(ReportError) as ctx:
            download(self.store, run["id"], self.owner, "pdf")
        self.assertEqual(ctx.exception.code, "REPORT_INVALID_FORMAT")
        self.assertEqual(ctx.exception.status, 422)

    def test_malformed_id_denied_not_crash(self):
        with self.assertRaises(NotFoundError):
            download(self.store, "../etc/passwd", self.owner, "md")

    # --- symlink in exports is never followed/zipped ------------------------

    def test_symlink_in_exports_excluded(self):
        run = self._completed_run()
        publish(self.store, run["id"])
        exports_dir = self.store.research_dir / "runs" / run["id"] / "exports"
        secret = self.root / "secret.txt"
        secret.write_text("private", encoding="utf-8")
        evil = exports_dir / "1_analysts" / "evil.md"
        evil.parent.mkdir(parents=True, exist_ok=True)
        os.symlink(secret, evil)

        archive, _, _ = download(self.store, run["id"], self.owner, "zip")
        with zipfile.ZipFile(io.BytesIO(archive)) as z:
            self.assertNotIn("1_analysts/evil.md", z.namelist())

    # --- partial filename labeling ------------------------------------------

    def test_partial_run_download_filename_labeled(self):
        run = self._completed_run(partial=True)
        self.store.update(run["id"], status="interrupted")
        publish(self.store, run["id"])
        content, _, name = download(self.store, run["id"], self.owner, "md")
        self.assertIn("partial", name)
        self.assertIn(b"safe market text", content)

    # --- archive excludes injected non-report files -------------------------

    def test_archive_excludes_injected_config_log_files(self):
        run = self._completed_run()
        publish(self.store, run["id"])
        exports_dir = self.store.research_dir / "runs" / run["id"] / "exports"
        (exports_dir / "config.yaml").write_text("api_key: leak", encoding="utf-8")
        (exports_dir / "run.log").write_text("raw tool trace", encoding="utf-8")
        (exports_dir / "1_analysts" / "memory.ckpt").write_text("checkpoint", encoding="utf-8")

        archive, _, _ = download(self.store, run["id"], self.owner, "zip")
        with zipfile.ZipFile(io.BytesIO(archive)) as z:
            names = z.namelist()
            self.assertNotIn("config.yaml", names)
            self.assertNotIn("run.log", names)
            self.assertNotIn("1_analysts/memory.ckpt", names)

    # --- too-large guard ------------------------------------------------------

    def test_oversized_file_rejected_without_losing_state(self):
        run = self._completed_run()
        publish(self.store, run["id"])
        with mock.patch("ta_web.reports._MAX_BYTES", 10):
            with self.assertRaises(ReportError) as ctx:
                download(self.store, run["id"], self.owner, "md")
            self.assertEqual(ctx.exception.code, "REPORT_TOO_LARGE")
        # Saved state remains intact/available after the bounded read refuses.
        still = self.store.get_owned(run["id"], self.owner)
        self.assertEqual(still["state"]["market_report"], "safe market text")

    # --- publish is immutable / failure leaves no partial artifacts ---------

    def test_publish_failure_leaves_no_ready_metadata(self):
        run = self._completed_run()
        with mock.patch("ta_web.reports.write_report_tree", side_effect=OSError("disk full")):
            with self.assertRaises(ReportError) as ctx:
                publish(self.store, run["id"])
            self.assertEqual(ctx.exception.code, "EXPORT_FAILED")
        reloaded = self.store.worker_run(run["id"])
        self.assertFalse(reloaded["artifacts_ready"])
        self.assertEqual(reloaded["state"]["market_report"], "safe market text")
        exports_dir = self.store.research_dir / "runs" / run["id"] / "exports"
        self.assertFalse(exports_dir.exists())
        stage_dirs = list((self.store.research_dir / "runs" / run["id"]).glob(".exports-*"))
        self.assertEqual(stage_dirs, [])

    def test_publish_header_only_state_refused(self):
        run = self.store.create(self.owner, _inputs())
        self.store.update(run["id"], status="completed", state={"trade_date": "2026-10-09"})
        with self.assertRaises(ReportError) as ctx:
            publish(self.store, run["id"])
        self.assertEqual(ctx.exception.code, "EXPORT_FAILED")

    def test_publish_before_status_marked_completed(self):
        """Internal end-of-run publish may run before status flips to completed."""
        run = self.store.create(self.owner, _inputs())
        self.store.update(
            run["id"],
            state={"market_report": "early text", "final_trade_decision": "Hold"},
        )
        publish(self.store, run["id"])
        self.assertTrue(self.store.worker_run(run["id"])["artifacts_ready"])
        # External download still refuses while status is running.
        with self.assertRaises(ReportError) as ctx:
            download(self.store, run["id"], self.owner, "md")
        self.assertEqual(ctx.exception.code, "REPORT_NOT_READY")

    def test_publish_is_immutable_once_written(self):
        run = self._completed_run()
        publish(self.store, run["id"])
        exports_dir = self.store.research_dir / "runs" / run["id"] / "exports"
        marker = exports_dir / "complete_report.md"
        original = marker.read_bytes()
        marker.write_bytes(original + b"\ntampered")
        publish(self.store, run["id"])  # no-op: already published
        self.assertEqual(marker.read_bytes(), original + b"\ntampered")


class LegacyImportTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.store = Store(self.root)
        self.owner = owner_key("legacy-owner")

    def test_legacy_assignment_dedupe_and_source_preservation(self):
        source = self.root / "legacy-input"
        source.mkdir()
        md = source / "complete_report.md"
        md.write_text("# Imported research\n\nUnknown historical date.", encoding="utf-8")
        old_html = source / "complete_report.html"
        old_html.write_text("<script>bad()</script>", encoding="utf-8")

        first = import_folder(self.store, source, self.owner)
        self.assertEqual(import_folder(self.store, source, self.owner)["id"], first["id"])
        self.assertIsNone(first["inputs"]["analysis_date"])
        self.assertEqual(old_html.read_text(), "<script>bad()</script>")

        html, _, _ = download(self.store, first["id"], self.owner, "html")
        self.assertNotIn(b"<script>", html)

        with self.assertRaises(NotFoundError):
            self.store.get_visible(first["id"], owner_key("owner-two"))

        md.write_text("# Imported research\n\nChanged content.", encoding="utf-8")
        self.assertNotEqual(import_folder(self.store, source, self.owner)["id"], first["id"])

    def test_import_rejects_malformed_owner_key(self):
        source = self.root / "legacy-bad-owner"
        source.mkdir()
        (source / "complete_report.md").write_text("# x", encoding="utf-8")
        with self.assertRaises(ValueError):
            import_folder(self.store, source, "not-a-hex-owner-key")

    def test_import_rejects_folder_with_no_recognized_content(self):
        source = self.root / "legacy-empty"
        source.mkdir()
        (source / "notes.txt").write_text("nothing recognized", encoding="utf-8")
        with self.assertRaises(ReportError):
            import_folder(self.store, source, self.owner)

    def test_import_section_only_marked_partial(self):
        source = self.root / "legacy-sections"
        (source / "1_analysts").mkdir(parents=True)
        (source / "1_analysts" / "market.md").write_text("Section-only market text.", encoding="utf-8")

        run = import_folder(self.store, source, self.owner)
        self.assertTrue(run["partial"])
        md, _, name = download(self.store, run["id"], self.owner, "md")
        self.assertIn("partial", name)
        self.assertIn(b"Section-only market text.", md)

    def test_import_never_follows_symlink_source(self):
        real_dir = self.root / "real-legacy"
        real_dir.mkdir()
        (real_dir / "complete_report.md").write_text("# real", encoding="utf-8")
        linked = self.root / "legacy-link"
        os.symlink(real_dir, linked)
        with self.assertRaises(ReportError):
            import_folder(self.store, linked, self.owner)

    def test_discard_import_rolls_back_failed_export_write(self):
        source = self.root / "legacy-fail"
        source.mkdir()
        (source / "complete_report.md").write_text("# will fail", encoding="utf-8")
        before = self.store.list_owned(self.owner)
        with mock.patch("ta_web.import_reports._write_exports", side_effect=OSError("boom")), self.assertRaises(OSError):
            import_folder(self.store, source, self.owner)
        self.assertEqual(self.store.list_owned(self.owner), before)


if __name__ == "__main__":
    unittest.main()
