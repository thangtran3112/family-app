"""Tests for ta_web.domain / ta_web.store: ownership, persistence, races, inputs."""

import json
import threading
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from pathlib import Path
from tempfile import TemporaryDirectory

from pydantic import ValidationError
from ta_web.domain import (
    BusyError,
    Inputs,
    NotFoundError,
    owner_key,
    public_view,
    safe_settings,
)
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


class StoreTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.store = Store(self.root)

    # --- Step 1 verbatim scenario -----------------------------------------

    def test_private_persistent_unique_and_shared(self):
        owner, reader = owner_key("owner-one"), owner_key("owner-two")
        inputs = Inputs(
            ticker="SPY",
            analysis_date="2026-10-09",
            asset_type="stock",
            analysts=["market"],
            research_depth=1,
        )
        first = self.store.create(owner, inputs)
        with self.assertRaises(NotFoundError):
            self.store.get_visible(first["id"], reader)
        self.store.update(first["id"], status="completed")
        second = self.store.create(owner, inputs)
        self.assertNotEqual(first["id"], second["id"])
        self.assertEqual(Store(self.root).get_owned(first["id"], owner)["id"], first["id"])
        self.store.set_shared(first["id"], owner, True)
        self.assertEqual(self.store.get_visible(first["id"], reader)["id"], first["id"])
        self.assertEqual(self.store.list_owned(reader), [])
        with self.assertRaises(NotFoundError):
            self.store.set_shared(first["id"], reader, False)
        self.store.set_shared(first["id"], owner, False)
        with self.assertRaises(NotFoundError):
            self.store.get_visible(first["id"], reader)

    # --- Race on the single-active-run admission lock -----------------------

    def test_admission_race(self):
        owner = owner_key("racer")
        inputs = _inputs()
        barrier = threading.Barrier(2)
        stores = [Store(self.root), Store(self.root)]

        def attempt(store):
            barrier.wait(timeout=5)
            try:
                store.create(owner, inputs)
                return "ok"
            except BusyError:
                return "busy"

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(attempt, stores))

        self.assertEqual(sorted(results), ["busy", "ok"])

    # --- Inputs validation: dates -------------------------------------------

    def test_future_date_rejected(self):
        future = (date.today() + timedelta(days=1)).isoformat()
        with self.assertRaises(ValidationError):
            _inputs(analysis_date=future)

    def test_noncanonical_date_rejected(self):
        for bad in ("2026-1-9", "09-10-2026", "2026/10/09", "not-a-date", "2026-02-30"):
            with self.assertRaises(ValidationError):
                _inputs(analysis_date=bad)

    # --- Inputs validation: analysts -----------------------------------------

    def test_empty_analysts_rejected(self):
        with self.assertRaises(ValidationError):
            _inputs(analysts=[])

    def test_unknown_analyst_rejected(self):
        with self.assertRaises(ValidationError):
            _inputs(analysts=["astrology"])

    def test_crypto_fundamentals_rejected(self):
        with self.assertRaises(ValidationError):
            _inputs(ticker="BTC-USD", asset_type="crypto", analysts=["fundamentals"])

    def test_analysts_dedupe_and_canonical_order(self):
        inputs = _inputs(analysts=["news", "market", "news", "sentiment"])
        self.assertEqual(inputs.analysts, ["market", "social", "news"])

    # --- Inputs validation: research_depth -----------------------------------

    def test_bool_depth_rejected(self):
        with self.assertRaises(ValidationError):
            _inputs(research_depth=True)

    def test_string_depth_rejected(self):
        with self.assertRaises(ValidationError):
            _inputs(research_depth="3")

    def test_depth_out_of_range_rejected(self):
        for depth in (0, 6):
            with self.assertRaises(ValidationError):
                _inputs(research_depth=depth)

    def test_depth_none_allowed(self):
        inputs = _inputs(research_depth=None)
        self.assertIsNone(inputs.research_depth)

    # --- Inputs validation: ticker --------------------------------------------

    def test_overlong_canonical_ticker_rejected(self):
        with self.assertRaises(ValidationError):
            _inputs(ticker="A" * 33)

    def test_overlong_raw_ticker_with_whitespace_rejected_before_trim(self):
        # Final-fix wave: the request-boundary check happens BEFORE
        # value.strip(), so a raw value this api accepted would otherwise
        # trim down to a trivially-short, easily-valid canonical ticker and
        # silently bypass the spec's 64-char request boundary.
        with self.assertRaises(ValidationError):
            _inputs(ticker="SPY" + " " * 62)  # 65 raw chars, 3 after trim

    def test_raw_ticker_at_64_char_boundary_accepted(self):
        inputs = _inputs(ticker="SPY" + " " * 61)  # exactly 64 raw chars
        self.assertEqual(inputs.ticker, "SPY")

    def test_dot_only_or_path_ticker_rejected(self):
        for bad in (".", "..", "../etc", "a/b"):
            with self.assertRaises(ValidationError):
                _inputs(ticker=bad)

    def test_canonical_special_symbols_accepted(self):
        for ticker in ("GC=F", "^GSPC", "0700.HK"):
            inputs = _inputs(ticker=ticker)
            self.assertEqual(inputs.ticker, ticker)

    def test_normalized_crypto_symbol_accepted(self):
        inputs = _inputs(ticker="btcusd", asset_type="crypto", analysts=["market"])
        self.assertEqual(inputs.ticker, "BTC-USD")

    def test_extra_fields_forbidden(self):
        with self.assertRaises(ValidationError):
            _inputs(unexpected="nope")

    def test_invalid_inputs_allocate_no_row(self):
        owner = owner_key("no-rows")
        self.assertEqual(self.store.list_owned(owner), [])
        with self.assertRaises(ValidationError):
            _inputs(ticker="")
        with self.assertRaises(ValidationError):
            _inputs(research_depth=0)
        with self.assertRaises(ValidationError):
            _inputs(analysts=[])
        self.assertEqual(self.store.list_owned(owner), [])

    # --- owner_key --------------------------------------------------------

    def test_owner_key_rejects_empty_and_oversized_identity(self):
        with self.assertRaises(ValueError):
            owner_key("")
        huge = "x" * 1025
        with self.assertRaises(ValueError) as ctx:
            owner_key(huge)
        self.assertNotIn(huge, str(ctx.exception))

    def test_owner_key_normalizes_case_and_whitespace(self):
        self.assertEqual(owner_key(" Family@Example "), owner_key("family@example"))

    # --- public_view --------------------------------------------------------

    def test_public_view_hides_private_fields_and_sets_capabilities(self):
        owner = owner_key("pv-owner")
        reader = owner_key("pv-reader")
        run = self.store.create(owner, _inputs())

        owner_view = public_view(run, owner)
        self.assertTrue(owner_view["can_share"])
        self.assertTrue(owner_view["can_rerun"])
        self.assertNotIn("owner_id", owner_view)
        self.assertNotIn("fingerprint", owner_view)

        self.store.set_shared(run["id"], owner, True)
        shared_run = self.store.get_visible(run["id"], reader)
        reader_view = public_view(shared_run, reader)
        self.assertFalse(reader_view["can_share"])
        self.assertFalse(reader_view["can_rerun"])
        self.assertNotIn("owner_id", reader_view)
        self.assertNotIn("fingerprint", reader_view)

    def test_public_view_strips_credentials_and_paths_from_shared_state(self):
        """Regression for review High: a shared reader must never receive raw
        worker/import content — only the text/round allowlist survives."""
        owner = owner_key("pv-leak-owner")
        reader = owner_key("pv-leak-reader")
        run = self.store.create(owner, _inputs())

        secret = "sk-super-secret-leaked-token"
        path = "/etc/passwd"
        self.store.update(
            run["id"],
            status="completed",
            state={
                "market_report": "a safe report",
                "api_key": secret,
                "trace": "raw tool output dump",
                "checkpoint_path": path,
                "investment_debate_state": {
                    "bull_history": "safe bull text",
                    "history": "raw transcript with " + secret,
                    "count": 3,
                },
            },
            settings={
                "version": "1.2.3",
                "llm_provider": "openai",
                "deep_think_provider": "openai",
                "deep_think_llm": "gpt-5",
                "quick_think_provider": "openai",
                "quick_think_llm": "gpt-5-mini",
                "analysts": ["market"],
                "max_debate_rounds": 2,
                "max_risk_discuss_rounds": 1,
                "output_language": "en",
                "api_key": secret,
                "base_url": "https://internal.example/" + secret,
            },
        )
        self.store.set_shared(run["id"], owner, True)

        visible = self.store.get_visible(run["id"], reader)
        view = public_view(visible, reader)
        blob = json.dumps(view)

        self.assertNotIn(secret, blob)
        self.assertNotIn(path, blob)
        self.assertNotIn("api_key", blob)
        self.assertNotIn("trace", blob)
        self.assertNotIn("checkpoint_path", blob)
        self.assertNotIn("base_url", blob)
        self.assertNotIn("count", blob)
        # The legitimate allowlisted content is preserved, not censored away.
        self.assertEqual(view["state"]["market_report"], "a safe report")
        self.assertEqual(view["state"]["investment_debate_state"], {"bull_history": "safe bull text"})
        self.assertEqual(
            view["settings"],
            {
                "version": "1.2.3",
                "llm_provider": "openai",
                "deep_think_provider": "openai",
                "deep_think_llm": "gpt-5",
                "quick_think_provider": "openai",
                "quick_think_llm": "gpt-5-mini",
                "analysts": ["market"],
                "max_debate_rounds": 2,
                "max_risk_discuss_rounds": 1,
                "output_language": "en",
            },
        )

        # Same assertion straight off the owner's own view: the sanitizer is
        # unconditional, not merely a reader-side filter.
        owner_view = public_view(self.store.get_owned(run["id"], owner), owner)
        owner_blob = json.dumps(owner_view)
        self.assertNotIn(secret, owner_blob)
        self.assertNotIn(path, owner_blob)

    def test_public_view_strips_extra_keys_from_imported_inputs(self):
        """A malformed/hostile import's ``inputs`` dict is allowlisted too."""
        owner = owner_key("pv-import-owner")
        run, _ = self.store.add_import(
            owner,
            "fp-leak",
            {
                "ticker": "AAPL",
                "analysis_date": None,
                "asset_type": "stock",
                "analysts": ["market"],
                "research_depth": None,
                "config_path": "/srv/secret-config.yaml",
            },
            {},
            {},
            True,
        )
        view = public_view(run, owner)
        blob = json.dumps(view)
        self.assertNotIn("config_path", blob)
        self.assertNotIn("secret-config", blob)
        self.assertEqual(
            view["inputs"],
            {
                "ticker": "AAPL",
                "analysis_date": None,
                "asset_type": "stock",
                "analysts": ["market"],
                "research_depth": None,
            },
        )

    def test_safe_settings_matches_producer_schema(self):
        """Fixture test against the exact upstream ``run_settings()`` shape
        (tradingagents/graph/trading_graph.py): legitimate metadata survives,
        vendor maps/credentials/paths/unknown nested extras never do."""
        producer_settings = {
            # Exact upstream TradingAgentsGraph.run_settings() fields.
            "version": "1.9.0",
            "llm_provider": "openai",
            "deep_think_provider": "openai",
            "deep_think_llm": "gpt-5",
            "quick_think_provider": "openai",
            "quick_think_llm": "gpt-5-mini",
            "analysts": ["market", "social", "news", "fundamentals"],
            "max_debate_rounds": 2,
            "max_risk_discuss_rounds": 1,
            "output_language": "en",
            "data_vendors": {"core_stock_apis": "yfinance", "macro_data": "fred"},
            "tool_vendors": {"get_stock_data": "alpha_vantage"},
            # What a producer must never leak publicly.
            "api_key": "sk-leak",
            "backend_url": "https://internal.example/sk-leak",
            "base_url": "https://internal.example/sk-leak",
            "checkpoint_path": "/var/data/checkpoints/run-1",
            "nested_extra": {"anything": "goes", "credentials": {"token": "sk-leak"}},
        }

        cleaned = safe_settings(producer_settings)

        self.assertEqual(
            cleaned,
            {
                "version": "1.9.0",
                "llm_provider": "openai",
                "deep_think_provider": "openai",
                "deep_think_llm": "gpt-5",
                "quick_think_provider": "openai",
                "quick_think_llm": "gpt-5-mini",
                "analysts": ["market", "social", "news", "fundamentals"],
                "max_debate_rounds": 2,
                "max_risk_discuss_rounds": 1,
                "output_language": "en",
            },
        )
        blob = json.dumps(cleaned)
        for leaked in ("sk-leak", "/var/data/checkpoints", "api_key", "backend_url",
                       "base_url", "checkpoint_path", "nested_extra",
                       "data_vendors", "tool_vendors", "alpha_vantage"):
            self.assertNotIn(leaked, blob)

    def test_safe_settings_non_dict_input_is_empty(self):
        self.assertEqual(safe_settings(None), {})
        self.assertEqual(safe_settings("not-a-dict"), {})

    # --- update / mark_interrupted ------------------------------------------

    def test_update_only_touches_allowed_columns(self):
        owner = owner_key("updater")
        run = self.store.create(owner, _inputs())
        self.store.update(
            run["id"],
            status="failed",
            stage="risk_debate",
            state={"a": 1},
            settings={"depth": 2},
            artifacts_ready=True,
            partial=True,
            error_code="PROVIDER_ERROR",
        )
        updated = self.store.get_owned(run["id"], owner)
        self.assertEqual(updated["status"], "failed")
        self.assertEqual(updated["stage"], "risk_debate")
        self.assertEqual(updated["state"], {"a": 1})
        self.assertEqual(updated["settings"], {"depth": 2})
        self.assertTrue(updated["artifacts_ready"])
        self.assertTrue(updated["partial"])
        self.assertEqual(updated["error_code"], "PROVIDER_ERROR")
        self.assertNotEqual(updated["updated_at"], updated["created_at"])

    def test_update_unknown_id_raises_not_found(self):
        with self.assertRaises(NotFoundError):
            self.store.update("not-a-real-id", status="completed")

    def test_mark_interrupted_flags_running_rows(self):
        owner = owner_key("recovery")
        run = self.store.create(owner, _inputs())
        ids = self.store.mark_interrupted()
        self.assertEqual(ids, [run["id"]])
        self.assertEqual(self.store.get_owned(run["id"], owner)["status"], "interrupted")
        # idempotent: nothing left running to interrupt
        self.assertEqual(self.store.mark_interrupted(), [])

    # --- add_import / discard_import ----------------------------------------

    def test_add_import_dedupes_per_owner_and_fingerprint(self):
        owner = owner_key("importer")
        run, created = self.store.add_import(
            owner, "fp-1", {"ticker": "AAPL"}, {"s": 1}, {"opt": True}, False
        )
        self.assertTrue(created)
        self.assertEqual(run["origin"], "import")
        self.assertEqual(run["status"], "completed")

        again, created_again = self.store.add_import(
            owner, "fp-1", {"ticker": "AAPL"}, {"s": 1}, {"opt": True}, False
        )
        self.assertFalse(created_again)
        self.assertEqual(again["id"], run["id"])

    def test_discard_import_restricted_to_unpublished_own_import(self):
        owner = owner_key("importer-2")
        other = owner_key("importer-3")
        run, _ = self.store.add_import(
            owner, "fp-2", {"ticker": "MSFT"}, {}, {}, True
        )

        with self.assertRaises(NotFoundError):
            self.store.discard_import(run["id"], other)

        self.store.update(run["id"], artifacts_ready=True)
        with self.assertRaises(NotFoundError):
            self.store.discard_import(run["id"], owner)

        ordinary = self.store.create(owner, _inputs())
        with self.assertRaises(NotFoundError):
            self.store.discard_import(ordinary["id"], owner)

        run2, _ = self.store.add_import(
            owner, "fp-3", {"ticker": "MSFT"}, {}, {}, True
        )
        self.store.discard_import(run2["id"], owner)
        with self.assertRaises(NotFoundError):
            self.store.worker_run(run2["id"])

    # --- malformed ids / worker_run ------------------------------------------

    def test_malformed_id_raises_not_found_not_crash(self):
        owner = owner_key("owner-malformed")
        for bad_id in ("../etc/passwd", "not-a-uuid", "", "1234"):
            with self.assertRaises(NotFoundError):
                self.store.get_visible(bad_id, owner)
            with self.assertRaises(NotFoundError):
                self.store.get_owned(bad_id, owner)
            with self.assertRaises(NotFoundError):
                self.store.worker_run(bad_id)

    def test_noncanonical_uuid4_spellings_denied(self):
        """Regression for review Low: only the exact canonical spelling of an
        existing UUID4 may fetch its row; equivalent re-spellings must not."""
        owner = owner_key("owner-canonical")
        run = self.store.create(owner, _inputs())
        canonical = run["id"]
        parsed = uuid.UUID(canonical)
        variants = (
            canonical.upper(),
            canonical.replace("-", ""),
            canonical.upper().replace("-", ""),
            f"{{{canonical}}}",
            f"urn:uuid:{canonical}",
        )
        for variant in variants:
            with self.subTest(variant=variant):
                with self.assertRaises(NotFoundError):
                    self.store.get_visible(variant, owner)
                with self.assertRaises(NotFoundError):
                    self.store.get_owned(variant, owner)
                with self.assertRaises(NotFoundError):
                    self.store.worker_run(variant)
        # Sanity: the actual canonical spelling still works.
        self.assertEqual(self.store.worker_run(canonical)["id"], canonical)
        self.assertEqual(str(parsed), canonical)

    def test_worker_run_bypasses_owner_visibility(self):
        owner = owner_key("worker-owner")
        other = owner_key("worker-other")
        run = self.store.create(owner, _inputs())
        self.assertEqual(self.store.worker_run(run["id"])["id"], run["id"])
        with self.assertRaises(NotFoundError):
            self.store.get_visible(run["id"], other)

    # --- list_owned filters/limits -------------------------------------------

    def test_list_owned_filters_and_clamps_limit(self):
        owner = owner_key("lister")
        first = self.store.create(owner, _inputs(ticker="AAPL"))
        self.store.update(first["id"], status="completed")
        self.store.create(owner, _inputs(ticker="MSFT"))

        by_ticker = self.store.list_owned(owner, ticker="AAPL")
        self.assertEqual([r["id"] for r in by_ticker], [first["id"]])

        by_status = self.store.list_owned(owner, status="completed")
        self.assertEqual([r["id"] for r in by_status], [first["id"]])

        clamped = self.store.list_owned(owner, limit=10_000)
        self.assertLessEqual(len(clamped), 100)

        with self.assertRaises(ValueError):
            self.store.list_owned(owner, status="not-a-status")


if __name__ == "__main__":
    unittest.main()
