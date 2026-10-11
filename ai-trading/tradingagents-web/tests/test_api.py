"""Tests for ta_web.app: guarded HTTP API, ownership, downloads.

HTTPX 0.28.1 ASGITransport + stdlib IsolatedAsyncioTestCase; the transport
never triggers ASGI lifespan, so every test manually enters
``app.router.lifespan_context(app)``. Every client here uses the ASGITransport
*default* (``raise_app_exceptions=True``): an unexpected exception must never
propagate out of the app at all (``ta_web.app``'s outer guard sits outside
Starlette's ``ServerErrorMiddleware`` and never re-raises), so disabling that
default to hide the bug is never needed.
"""

import asyncio
import contextlib
import json
import os
import subprocess
import sys
import time
import unittest
import zipfile
from datetime import date, datetime
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

import httpx
from ta_web import reports
from ta_web.app import create_app
from ta_web.domain import Inputs, owner_key
from ta_web.runner import Runner
from ta_web.store import Store

_ORIGIN = "https://research.test"


def _inputs(**overrides):
    base = {
        "ticker": "SPY",
        "analysis_date": date.today().isoformat(),
        "asset_type": "stock",
        "analysts": ["market"],
        "research_depth": 1,
    }
    base.update(overrides)
    return base


class ApiTestCase(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.body = _inputs()
        self.owner_headers = {"Cf-Access-Authenticated-User-Email": "owner-one", "Origin": _ORIGIN}
        self.reader_headers = {"Cf-Access-Authenticated-User-Email": "owner-two", "Origin": _ORIGIN}

    @contextlib.asynccontextmanager
    async def _running(self, app):
        async with app.router.lifespan_context(app):
            # Default raise_app_exceptions=True: proves the app itself never
            # lets an exception escape, rather than hiding one via the transport.
            transport = httpx.ASGITransport(app=app)
            async with httpx.AsyncClient(transport=transport, base_url=_ORIGIN) as client:
                yield client

    def _app(self, start=None):
        return create_app(self.root, start=start or (lambda run_id: None))

    # --- Step 1 verbatim scenario -----------------------------------------

    async def test_explicit_read_only_share(self):
        app = self._app()
        async with self._running(app) as client:
            owner, reader = self.owner_headers, self.reader_headers
            made = await client.post("/api/research", headers=owner, json=self.body)
            self.assertEqual(made.status_code, 202)
            run_id = made.json()["id"]
            url = f"/api/research/{run_id}"
            self.assertEqual((await client.get(url, headers=reader)).status_code, 404)
            self.assertEqual(
                (await client.post(url + "/sharing", headers=owner, json={"enabled": True})).status_code, 200
            )
            self.assertEqual((await client.get(url, headers=reader)).status_code, 200)
            self.assertEqual(
                (await client.post(url + "/sharing", headers=reader, json={"enabled": False})).status_code, 404
            )
            await client.post(url + "/sharing", headers=owner, json={"enabled": False})
            self.assertEqual((await client.get(url, headers=reader)).status_code, 404)

    # --- identity / origin / prefix guard -----------------------------------

    async def test_missing_identity_rejected(self):
        app = self._app()
        async with self._running(app) as client:
            response = await client.get("/api/research", headers={"Origin": _ORIGIN})
            self.assertEqual(response.status_code, 401)
            self.assertEqual(response.json()["error"], "UNAUTHENTICATED")

    async def test_unauthenticated_static_and_api_requests_rejected(self):
        app = self._app()
        async with self._running(app) as client:
            for path in ("/research", "/api/research"):
                response = await client.get(path)
                self.assertEqual(response.status_code, 401, path)

    async def test_missing_or_cross_site_origin_rejected_for_unsafe_methods(self):
        app = self._app()
        async with self._running(app) as client:
            no_origin = await client.post(
                "/api/research", headers={"Cf-Access-Authenticated-User-Email": "owner-one"}, json=self.body
            )
            self.assertEqual(no_origin.status_code, 403)
            cross_site = await client.post(
                "/api/research",
                headers={"Cf-Access-Authenticated-User-Email": "owner-one", "Origin": "https://evil.test"},
                json=self.body,
            )
            self.assertEqual(cross_site.status_code, 403)
            malformed = await client.post(
                "/api/research",
                headers={"Cf-Access-Authenticated-User-Email": "owner-one", "Origin": "not-a-url"},
                json=self.body,
            )
            self.assertEqual(malformed.status_code, 403)

    async def test_untrusted_prefix_rejected(self):
        app = self._app()
        async with self._running(app) as client:
            response = await client.get(
                "/research", headers={**self.owner_headers, "X-Family-App-Prefix": "/u/evil"}
            )
            self.assertEqual(response.status_code, 400)

    async def test_prefix_urls_trusted(self):
        app = self._app()
        async with self._running(app) as client:
            headers = {**self.owner_headers, "X-Family-App-Prefix": "/u/tradingagents"}
            shell = await client.get("/research", headers=headers)
            self.assertEqual(shell.status_code, 200)
            self.assertIn('data-app-prefix="/u/tradingagents"', shell.text)
            self.assertIn('href="/u/tradingagents/research"', shell.text)
            started = await client.post("/api/research", headers=headers, json=self.body)
            self.assertEqual(started.status_code, 202)
            self.assertEqual(started.json()["detail_url"], f"/u/tradingagents/research/{started.json()['id']}")

    # --- body validation -----------------------------------------------------

    async def test_non_json_body_rejected(self):
        app = self._app()
        async with self._running(app) as client:
            response = await client.post(
                "/api/research",
                headers={**self.owner_headers, "content-type": "application/json"},
                content=b"not json",
            )
            self.assertEqual(response.status_code, 422)
            self.assertEqual(response.json()["error"], "INVALID_JSON")

    async def test_valid_json_wrong_media_type_rejected_before_admission(self):
        app = self._app()
        async with self._running(app) as client:
            response = await client.post(
                "/api/research",
                headers={**self.owner_headers, "content-type": "text/plain"},
                content=json.dumps(self.body).encode(),
            )
            self.assertEqual(response.status_code, 415)
            self.assertEqual(response.json()["error"], "UNSUPPORTED_MEDIA_TYPE")
            listing = await client.get("/api/research", headers=self.owner_headers)
            self.assertEqual(listing.json()["items"], [])  # no run was admitted

    async def test_missing_media_type_rejected(self):
        app = self._app()
        async with self._running(app) as client:
            response = await client.post(
                "/api/research", headers=self.owner_headers, content=json.dumps(self.body).encode()
            )
            self.assertEqual(response.status_code, 415)

    async def test_valid_json_with_charset_media_type_succeeds(self):
        app = self._app()
        async with self._running(app) as client:
            response = await client.post(
                "/api/research",
                headers={**self.owner_headers, "content-type": "application/json; charset=utf-8"},
                content=json.dumps(self.body).encode(),
            )
            self.assertEqual(response.status_code, 202)

    async def test_sharing_wrong_media_type_rejected_without_mutation(self):
        app = self._app()
        async with self._running(app) as client:
            made = await client.post("/api/research", headers=self.owner_headers, json=self.body)
            run_id = made.json()["id"]
            response = await client.post(
                f"/api/research/{run_id}/sharing",
                headers={**self.owner_headers, "content-type": "text/plain"},
                content=json.dumps({"enabled": True}).encode(),
            )
            self.assertEqual(response.status_code, 415)
            detail = await client.get(f"/api/research/{run_id}", headers=self.owner_headers)
            self.assertFalse(detail.json()["shared"])

    async def test_oversized_streamed_body_rejected_without_content_length(self):
        app = self._app()

        async def oversized():
            yield b'{"ticker": "' + b"A" * (17 * 1024) + b'"}'

        async with self._running(app) as client:
            response = await client.post(
                "/api/research",
                headers={**self.owner_headers, "content-type": "application/json"},
                content=oversized(),
            )
            self.assertEqual(response.status_code, 413)
            self.assertEqual(response.json()["error"], "BODY_TOO_LARGE")

    async def test_string_boolean_sharing_rejected(self):
        app = self._app()
        async with self._running(app) as client:
            made = await client.post("/api/research", headers=self.owner_headers, json=self.body)
            run_id = made.json()["id"]
            response = await client.post(
                f"/api/research/{run_id}/sharing", headers=self.owner_headers, json={"enabled": "true"}
            )
            self.assertEqual(response.status_code, 422)

    async def test_forged_body_fields_rejected(self):
        app = self._app()
        async with self._running(app) as client:
            forged = dict(self.body, owner_id="attacker", id="forced-id")
            response = await client.post("/api/research", headers=self.owner_headers, json=forged)
            self.assertEqual(response.status_code, 422)

            made = await client.post("/api/research", headers=self.owner_headers, json=self.body)
            run_id = made.json()["id"]
            response = await client.post(
                f"/api/research/{run_id}/sharing",
                headers=self.owner_headers,
                json={"enabled": True, "owner_id": "attacker"},
            )
            self.assertEqual(response.status_code, 422)

    # --- busy ------------------------------------------------------------------

    async def test_second_concurrent_start_is_busy(self):
        app = self._app()
        async with self._running(app) as client:
            first = await client.post("/api/research", headers=self.owner_headers, json=self.body)
            self.assertEqual(first.status_code, 202)
            second = await client.post(
                "/api/research", headers=self.owner_headers, json=_inputs(ticker="QQQ")
            )
            self.assertEqual(second.status_code, 409)
            self.assertEqual(second.json()["error"], "BUSY")

    # --- download / preview -----------------------------------------------------

    def _publish_completed(self, store, owner, *, partial=False):
        run = store.create(owner, Inputs(**_inputs()))
        store.update(
            run["id"],
            status="completed",
            partial=partial,
            state={"trade_date": "2026-10-09", "market_report": "safe text", "final_trade_decision": "Buy"},
        )
        reports.publish(store, run["id"])
        return run["id"]

    async def test_download_not_ready_then_ready_bytes(self):
        app = self._app()
        async with self._running(app) as client:
            made = await client.post("/api/research", headers=self.owner_headers, json=self.body)
            run_id = made.json()["id"]
            not_ready = await client.get(f"/api/research/{run_id}/download?format=md", headers=self.owner_headers)
            self.assertEqual(not_ready.status_code, 409)
            self.assertEqual(not_ready.json()["error"], "REPORT_NOT_READY")

            store = app.state.store
            store.update(
                run_id,
                status="completed",
                state={"trade_date": "2026-10-09", "market_report": "safe text", "final_trade_decision": "Buy"},
            )
            reports.publish(store, run_id)

            ready = await client.get(f"/api/research/{run_id}/download?format=md", headers=self.owner_headers)
            self.assertEqual(ready.status_code, 200)
            self.assertIn("attachment", ready.headers["content-disposition"])
            self.assertIn(run_id, ready.headers["content-disposition"])
            self.assertIn("safe text", ready.text)

            zip_response = await client.get(f"/api/research/{run_id}/download?format=zip", headers=self.owner_headers)
            self.assertEqual(zip_response.status_code, 200)
            with zipfile.ZipFile(BytesIO(zip_response.content)) as archive:
                self.assertIn("complete_report.md", archive.namelist())

    async def test_shared_reader_download_then_revoke_denies(self):
        app = self._app()
        async with self._running(app) as client:
            store = app.state.store
            owner = owner_key("owner-one")
            run_id = self._publish_completed(store, owner)
            store.set_shared(run_id, owner, True)

            as_reader = await client.get(
                f"/api/research/{run_id}/download?format=html", headers=self.reader_headers
            )
            self.assertEqual(as_reader.status_code, 200)

            await client.post(
                f"/api/research/{run_id}/sharing", headers=self.owner_headers, json={"enabled": False}
            )
            revoked = await client.get(
                f"/api/research/{run_id}/download?format=html", headers=self.reader_headers
            )
            self.assertEqual(revoked.status_code, 404)

    async def test_report_preview_safe_iframe_headers(self):
        app = self._app()
        async with self._running(app) as client:
            store = app.state.store
            owner = owner_key("owner-one")
            run_id = self._publish_completed(store, owner)
            response = await client.get(f"/api/research/{run_id}/report", headers=self.owner_headers)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.headers["x-frame-options"], "SAMEORIGIN")
            self.assertIn("frame-ancestors 'self'", response.headers["content-security-policy"])
            self.assertNotIn("<script", response.text)

    # --- public DTO shape --------------------------------------------------

    async def test_detail_omits_owner_id_and_list_shape(self):
        app = self._app()
        async with self._running(app) as client:
            made = await client.post("/api/research", headers=self.owner_headers, json=self.body)
            run_id = made.json()["id"]
            detail = await client.get(f"/api/research/{run_id}", headers=self.owner_headers)
            payload = detail.json()
            self.assertNotIn("owner_id", payload)
            self.assertNotIn("fingerprint", payload)
            self.assertTrue(payload["can_share"])

            listing = (await client.get("/api/research", headers=self.owner_headers)).json()
            for key in ("owner_id", "items", "limit", "offset", "today", "defaults"):
                self.assertIn(key, listing)
            self.assertEqual(listing["today"], date.today().isoformat())
            self.assertIsInstance(listing["defaults"], dict)
            self.assertNotIn("backend_url", listing["defaults"])

    # --- history filters (final-fix wave: spec §5 ticker/date/status apply
    # across the caller's whole history, forwarded to Store.list_owned, not
    # just the one page already returned) --------------------------------

    async def test_list_ticker_filter_matches_across_full_history_not_just_current_page(self):
        app = self._app()
        async with self._running(app) as client:
            store = app.state.store
            owner = owner_key("owner-one")
            target_id = None
            # 30 rows (> the default 25-row page) so a filter that only
            # looked at the already-returned page could never find the match.
            for i in range(30):
                ticker = "ZZZZ" if i == 0 else f"T{i:03d}"
                run = store.create(owner, Inputs(**_inputs(ticker=ticker)))
                if i == 0:
                    target_id = run["id"]
                store.update(run["id"], status="completed")

            response = await client.get("/api/research?ticker=ZZZZ", headers=self.owner_headers)
            self.assertEqual(response.status_code, 200)
            self.assertEqual([item["id"] for item in response.json()["items"]], [target_id])

    async def test_list_status_filter_matches_across_full_history(self):
        app = self._app()
        async with self._running(app) as client:
            store = app.state.store
            owner = owner_key("owner-one")
            interrupted_id = None
            for i in range(27):
                run = store.create(owner, Inputs(**_inputs(ticker=f"S{i:03d}")))
                if i == 5:
                    interrupted_id = run["id"]
                    store.update(run["id"], status="interrupted")
                else:
                    store.update(run["id"], status="completed")

            response = await client.get("/api/research?status=interrupted", headers=self.owner_headers)
            self.assertEqual(response.status_code, 200)
            self.assertEqual([item["id"] for item in response.json()["items"]], [interrupted_id])

    async def test_list_analysis_date_filter_matches_exact_date(self):
        app = self._app()
        async with self._running(app) as client:
            store = app.state.store
            owner = owner_key("owner-one")
            match_id = None
            for i in range(5):
                analysis_date = "2026-01-01" if i != 2 else date.today().isoformat()
                run = store.create(owner, Inputs(**_inputs(ticker=f"D{i:03d}", analysis_date=analysis_date)))
                if i == 2:
                    match_id = run["id"]
                store.update(run["id"], status="completed")

            response = await client.get(
                f"/api/research?analysis_date={date.today().isoformat()}", headers=self.owner_headers
            )
            self.assertEqual(response.status_code, 200)
            self.assertEqual([item["id"] for item in response.json()["items"]], [match_id])

    async def test_list_invalid_filter_value_returns_422_not_500(self):
        app = self._app()
        async with self._running(app) as client:
            bad_status = await client.get("/api/research?status=not-a-status", headers=self.owner_headers)
            self.assertEqual(bad_status.status_code, 422)
            self.assertEqual(bad_status.json(), {"error": "INVALID_INPUT"})

            bad_date = await client.get("/api/research?analysis_date=not-a-date", headers=self.owner_headers)
            self.assertEqual(bad_date.status_code, 422)
            self.assertEqual(bad_date.json(), {"error": "INVALID_INPUT"})

    async def test_list_filters_never_leak_another_owners_matching_record(self):
        app = self._app()
        async with self._running(app) as client:
            store = app.state.store
            other_owner = owner_key("owner-two")
            store.create(other_owner, Inputs(**_inputs(ticker="SHARED9")))

            response = await client.get("/api/research?ticker=SHARED9", headers=self.owner_headers)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()["items"], [])

    # --- coverage debt extensions (coverage-audit.md gaps 1/2/3; cheap,
    # existing fixtures only, no new seams) -----------------------------

    async def test_list_pagination_query_params_clamp_over_real_http(self):
        """Gap 1: ``Store.list_owned``'s clamp is proven at the Python-call
        level already (test_store.py); this drives it over real HTTP query
        params (malformed/over-cap/negative), the path an actual client uses."""
        app = self._app()
        async with self._running(app) as client:
            store = app.state.store
            owner = owner_key("owner-one")
            for i in range(5):
                run = store.create(owner, Inputs(**_inputs(ticker=f"P{i:03d}")))
                store.update(run["id"], status="completed")

            malformed = await client.get("/api/research?limit=abc&offset=xyz", headers=self.owner_headers)
            self.assertEqual(malformed.status_code, 200)
            payload = malformed.json()
            self.assertEqual(payload["limit"], 25)
            self.assertEqual(payload["offset"], 0)
            self.assertEqual(len(payload["items"]), 5)

            over_cap = await client.get("/api/research?limit=9999", headers=self.owner_headers)
            self.assertEqual(over_cap.json()["limit"], 100)

            negative_offset = await client.get("/api/research?offset=-5", headers=self.owner_headers)
            self.assertEqual(negative_offset.json()["offset"], 0)

    async def test_asset_route_serves_known_names_and_404s_unknown(self):
        """Gap 2: ``/research/assets/{name}`` -- no test in this file ever
        requested it before."""
        app = self._app()
        async with self._running(app) as client:
            headers = self.owner_headers
            app_mjs = await client.get("/research/assets/app.mjs", headers=headers)
            self.assertEqual(app_mjs.status_code, 200)
            self.assertEqual(app_mjs.headers["content-type"], "text/javascript; charset=utf-8")

            app_css = await client.get("/research/assets/app.css", headers=headers)
            self.assertEqual(app_css.status_code, 200)
            self.assertEqual(app_css.headers["content-type"], "text/css; charset=utf-8")

            unknown = await client.get("/research/assets/does-not-exist.js", headers=headers)
            self.assertEqual(unknown.status_code, 404)

            traversal = await client.get("/research/assets/..%2Fapp.py", headers=headers)
            self.assertEqual(traversal.status_code, 404)

    async def test_owner_can_rerun_false_for_own_unrunnable_legacy_inputs(self):
        """Gap 3: existing tests vary the *viewer* (owner vs. reader); none
        gives the owner their own record with invalid/legacy inputs (e.g. a
        legacy import's null analysis_date) that can never round-trip
        through Inputs(**...)."""
        app = self._app()
        async with self._running(app) as client:
            store = app.state.store
            owner = owner_key("owner-one")
            run, _created = store.add_import(
                owner,
                fingerprint="legacy-fp-1",
                inputs={"ticker": "LEGACY", "analysis_date": None, "asset_type": "stock", "analysts": ["market"]},
                state={},
                settings={},
                partial=False,
            )
            detail = await client.get(f"/api/research/{run['id']}", headers=self.owner_headers)
            self.assertEqual(detail.status_code, 200)
            payload = detail.json()
            self.assertTrue(payload["can_share"])  # confirms this is the owner's own view
            self.assertFalse(payload["can_rerun"])

    async def test_list_today_matches_local_validator_across_utc_local_boundary(self):
        """UI-001: ``research_list``'s ``today`` must be the same server-local
        date ``Inputs._check_analysis_date`` validates against, even in the
        hour where UTC has already rolled to the next calendar day but local
        (server) time has not. Pin a fixed local "today" so the boundary is
        exercised deterministically regardless of when this test runs."""
        local_today = date(2026, 1, 1)
        local_tomorrow = date(2026, 1, 2)

        class _FixedDate(date):
            @classmethod
            def today(cls):
                return local_today

        # Final-fix wave (browser-date-fix-review.md, LOW test-determinism
        # note): the pre-fix code path computed "today" from
        # ``datetime.now(UTC).date()``, not ``date.today()`` — pin that clock
        # too (one day ahead of the local date, the exact boundary browser QA
        # observed) so a reintroduced bug fails deterministically on that
        # boundary, not merely whenever the real wall-clock UTC happens to
        # differ from ``local_today``. Inert against the current, correct
        # code: ``ta_web.app`` no longer imports ``datetime`` at all.
        class _FixedDatetime(datetime):
            @classmethod
            def now(cls, tz=None):
                return cls(local_tomorrow.year, local_tomorrow.month, local_tomorrow.day, tzinfo=tz)

        calls = []
        app = self._app(start=lambda run_id: calls.append(run_id))
        with (
            # create=True: pre-fix ``ta_web.app`` has no ``date``/``datetime``
            # name at all (it computes "today" from ``datetime.now(UTC)``),
            # so this must tolerate the attribute's absence rather than
            # erroring on it — the real bug is the mismatch below, not a
            # missing patch target.
            mock.patch("ta_web.app.date", _FixedDate, create=True),
            mock.patch("ta_web.app.datetime", _FixedDatetime, create=True),
            mock.patch("ta_web.domain.date", _FixedDate),
        ):
            async with self._running(app) as client:
                listing = await client.get("/api/research", headers=self.owner_headers)
                self.assertEqual(listing.json()["today"], local_today.isoformat())

                unchanged_default = await client.post(
                    "/api/research",
                    headers=self.owner_headers,
                    json=_inputs(analysis_date=listing.json()["today"]),
                )
                self.assertEqual(unchanged_default.status_code, 202)
                self.assertEqual(len(calls), 1)

                future = await client.post(
                    "/api/research",
                    headers=self.owner_headers,
                    json=_inputs(analysis_date=local_tomorrow.isoformat()),
                )
                self.assertEqual(future.status_code, 422)
                self.assertEqual(future.json(), {"error": "INVALID_INPUT"})
                self.assertEqual(len(calls), 1)  # no extra admission from the rejected POST

    # --- security headers --------------------------------------------------

    async def test_security_headers_on_success_and_error(self):
        app = self._app()
        async with self._running(app) as client:
            ok = await client.get("/api/research", headers=self.owner_headers)
            self.assertEqual(ok.headers["cache-control"], "no-store")
            self.assertEqual(ok.headers["referrer-policy"], "no-referrer")
            self.assertEqual(ok.headers["x-content-type-options"], "nosniff")

            denied = await client.get("/api/research")
            self.assertEqual(denied.headers["cache-control"], "no-store")
            self.assertEqual(denied.headers["referrer-policy"], "no-referrer")

    # --- unexpected storage error never escapes the app -----------------------

    async def test_unexpected_storage_error_never_escapes_or_leaks(self):
        app = self._app()
        async with self._running(app) as client:
            secret = "provider-secret-sentinel"
            leak_path = "/home/appuser/.tradingagents"

            def boom(*args, **kwargs):
                raise OSError(f"disk failure near {leak_path}: {secret}")

            app.state.store.list_owned = boom

            # Default ASGITransport (raise_app_exceptions=True): if the app let
            # Starlette's documented re-raise through, this await would itself
            # raise OSError here instead of returning a response.
            with self.assertLogs("ta_web.app", level="ERROR") as captured:
                response = await client.get("/api/research", headers=self.owner_headers)

            self.assertEqual(response.status_code, 500)
            self.assertEqual(response.json(), {"error": "INTERNAL_ERROR"})
            self.assertNotIn(secret, response.text)
            self.assertNotIn(leak_path, response.text)
            # Something was logged (not silently swallowed), but never the
            # original exception text/traceback.
            for record in captured.records:
                message = record.getMessage()
                self.assertNotIn(secret, message)
                self.assertNotIn(leak_path, message)
                self.assertIsNone(record.exc_info)

    async def test_unexpected_handler_error_logs_no_path_or_exception_sentinel(self):
        """Rereview round 1: the outer guard's own log line must carry zero
        request-derived data — a request *path* can itself be a secret-bearing
        identifier, distinct from whatever the exception text contains."""
        app = self._app()
        async with self._running(app) as client:
            path_sentinel = "path-secret-ABCDEF123456"
            exc_sentinel = "exception-secret-ZYXWVU987654"

            def boom(*args, **kwargs):
                raise RuntimeError(f"boom near {exc_sentinel}")

            app.state.store.get_visible = boom

            with self.assertLogs("ta_web.app", level="ERROR") as captured:
                response = await client.get(f"/api/research/{path_sentinel}", headers=self.owner_headers)

            self.assertEqual(response.status_code, 500)
            self.assertEqual(response.json(), {"error": "INTERNAL_ERROR"})
            self.assertNotIn(exc_sentinel, response.text)
            self.assertNotIn(path_sentinel, response.text)
            # Media/security headers still present on this sanitized path.
            self.assertEqual(response.headers["cache-control"], "no-store")
            self.assertEqual(response.headers["x-content-type-options"], "nosniff")
            self.assertEqual(response.headers["content-type"], "application/json")

            for record in captured.records:
                message = record.getMessage()
                self.assertNotIn(exc_sentinel, message)
                self.assertNotIn(path_sentinel, message)
                self.assertNotIn(exc_sentinel, repr(record.args))
                self.assertNotIn(path_sentinel, repr(record.args))
                self.assertIsNone(record.exc_info)

    # --- lifespan: service lock / restart recovery --------------------------

    async def test_lifespan_service_lock_prevents_second_process(self):
        app_a = self._app()
        app_b = self._app()
        async with app_a.router.lifespan_context(app_a):
            with self.assertRaises(RuntimeError):
                async with app_b.router.lifespan_context(app_b):
                    pass  # pragma: no cover - must not be reached

    async def test_restart_recovery_marks_interrupted_without_research_factory(self):
        pre_store = Store(self.root)
        owner = owner_key("owner-one")
        run = pre_store.create(owner, Inputs(**self.body))
        self.assertEqual(run["status"], "running")

        calls = []
        app = self._app(start=lambda run_id: calls.append(run_id))
        async with app.router.lifespan_context(app):
            recovered = app.state.store.worker_run(run["id"])
            self.assertEqual(recovered["status"], "interrupted")
            self.assertEqual(calls, [])  # recovery never launches research


class ProductionLifespanTestCase(unittest.IsolatedAsyncioTestCase):
    """create_app(root, start=None): the real production path, now that
    Task 3's Runner/worker are merged. No test here invokes real research
    (no POST that reaches the real ``ta_web.worker`` module/LLM); the one
    test that does exercise ``Runner.start`` patches ``Runner._argv`` to a
    tiny real child script (the existing test_runner.py seam), never the
    real worker module, so no provider/network/keys are touched.
    """

    async def asyncSetUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.owner_headers = {"Cf-Access-Authenticated-User-Email": "owner-one", "Origin": _ORIGIN}

    async def test_production_lifespan_real_runner_lock_health_read_close(self):
        # A running record left behind by a simulated crashed prior process,
        # seeded before the production app ever starts.
        pre_store = Store(self.root)
        owner = owner_key("owner-one")
        stuck = pre_store.create(owner, Inputs(**_inputs()))
        self.assertEqual(stuck["status"], "running")

        app = create_app(self.root)  # start=None: production path, real Runner

        real_popen = subprocess.Popen

        def guard_popen(*args, **kwargs):
            raise AssertionError("recovery must never spawn a worker subprocess")

        subprocess.Popen = guard_popen
        try:
            async with app.router.lifespan_context(app):
                # Recovery ran using only Store/reports (store.mark_interrupted +
                # best-effort reports.publish) — never Runner.start/subprocess.Popen,
                # which would have raised via guard_popen above.
                recovered = app.state.store.worker_run(stuck["id"])
                self.assertEqual(recovered["status"], "interrupted")

                # A real Runner was constructed (not a stub/fake): app.state.start
                # is its real bound .start method.
                runner = app.state.start.__self__
                self.assertIsInstance(runner, Runner)
                self.assertFalse(runner._closing)

                # The service lock is held for this whole lifespan: a second
                # process sharing the root cannot start concurrently.
                second = create_app(self.root)
                with self.assertRaises(RuntimeError):
                    async with second.router.lifespan_context(second):
                        pass  # pragma: no cover - must not be reached

                # Health and an authenticated read both work against the real,
                # fully production-constructed app.
                transport = httpx.ASGITransport(app=app)
                async with httpx.AsyncClient(transport=transport, base_url=_ORIGIN) as client:
                    health_response = await client.get("/__healthz")
                    self.assertEqual(health_response.status_code, 200)
                    self.assertEqual(health_response.json(), {"ok": True})

                    listing = await client.get("/api/research", headers=self.owner_headers)
                    self.assertEqual(listing.status_code, 200)
                    ids = [item["id"] for item in listing.json()["items"]]
                    self.assertIn(stuck["id"], ids)
        finally:
            subprocess.Popen = real_popen

        # close(): the real Runner.close() body actually ran (it is the only
        # code that sets `_closing`), and the service lock was released — a
        # fresh lifespan on the same root succeeds immediately afterward.
        self.assertTrue(runner._closing)
        third = create_app(self.root)
        async with third.router.lifespan_context(third):
            pass

    async def _start_run(self, client) -> str:
        """POST a new run, assert 202, and return its id — kept separate from
        the marker wait so a negative control can prove the *marker*
        assertion failed, not merely that this earlier 202 check failed."""
        made = await client.post("/api/research", headers=self.owner_headers, json=_inputs())
        self.assertEqual(made.status_code, 202)
        return made.json()["id"]

    async def _wait_for_marker(self, marker: Path, expected: str, timeout: float) -> None:
        """Poll until ``marker`` exists *and* contains exactly ``expected``.

        Waiting only for ``run_id`` to disappear from ``runner._children``
        proves a child was reaped, not that one ever launched — the
        production path still returns 202 even when ``Runner.start()``'s
        ``subprocess.Popen`` fails (caught internally as ``LAUNCH_FAILED``,
        never raised; `ta_web/runner.py`). The marker is written by the real
        child process itself, so reaching its exact expected content is the
        actual launch proof. Polling the *content*, not re-reading once after
        a bare existence check, avoids a transient empty read racing the
        child's create-then-write.
        """
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if marker.exists() and marker.read_text() == expected:
                return
            await asyncio.sleep(0.02)
        self.fail(f"child marker {marker.name} never reached expected content {expected!r}")

    async def test_production_lifespan_start_launches_real_child_without_llm(self):
        # The existing Runner._argv test seam (test_runner.py): a tiny real
        # child script, never the real ta_web.worker module, so Runner.start's
        # actual subprocess plumbing is exercised without any provider/network/
        # key dependency. The script writes a known-content marker file under
        # this test's own TMP dir — proof the child actually ran, not just
        # that the Popen call was attempted.
        script = Path(self.tmp.name) / "noop_worker.py"
        script.write_text(
            "import sys\nfrom pathlib import Path\nPath(sys.argv[1]).write_text('child-ran-ok')\n"
        )
        marker_dir = Path(self.tmp.name) / "markers"
        marker_dir.mkdir()

        def fake_argv(runner_self, id):
            return [sys.executable, str(script), str(marker_dir / f"{id}.marker")]

        app = create_app(self.root)
        with mock.patch.object(Runner, "_argv", fake_argv):
            async with app.router.lifespan_context(app):
                runner = app.state.start.__self__
                self.assertIsInstance(runner, Runner)

                transport = httpx.ASGITransport(app=app)
                async with httpx.AsyncClient(transport=transport, base_url=_ORIGIN) as client:
                    run_id = await self._start_run(client)
                    marker = marker_dir / f"{run_id}.marker"
                    # Exact, known content reached: the child really executed
                    # this script, not some other process incidentally
                    # touching the path, and not a transiently empty file.
                    await self._wait_for_marker(marker, "child-ran-ok", timeout=5)

                # Only now check the (weaker, separate) reaping claim.
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline and run_id in runner._children:
                    await asyncio.sleep(0.02)
                self.assertNotIn(run_id, runner._children)

    async def test_marker_wait_proof_fails_when_child_never_launches(self):
        """Negative control for the fix above: force Runner.start's Popen to
        fail (its own documented, swallowed-OSError path — ``LAUNCH_FAILED``,
        202 still returned, no child registered). ``_wait_for_marker`` must
        then itself raise with its own marker-specific message — proving
        *that* assertion failed, not merely that the (separately-checked,
        still-succeeding) 202 response failed."""
        marker_dir = Path(self.tmp.name) / "markers-negative"
        marker_dir.mkdir()
        app = create_app(self.root)

        real_popen = subprocess.Popen

        def failing_popen(*args, **kwargs):
            raise OSError("simulated launch failure — no child ever starts")

        async with app.router.lifespan_context(app):
            subprocess.Popen = failing_popen
            try:
                transport = httpx.ASGITransport(app=app)
                async with httpx.AsyncClient(transport=transport, base_url=_ORIGIN) as client:
                    # Established separately, outside assertRaises: the POST
                    # itself still succeeds even though Popen always fails.
                    run_id = await self._start_run(client)
                    marker = marker_dir / f"{run_id}.marker"
                    with self.assertRaisesRegex(
                        AssertionError, r"child marker .* never reached expected content"
                    ):
                        await self._wait_for_marker(marker, "child-ran-ok", timeout=0.3)
            finally:
                subprocess.Popen = real_popen  # no real child was ever spawned; nothing else to clean up

    def test_module_import_has_no_filesystem_or_db_side_effect(self):
        with TemporaryDirectory() as fake_home:
            env = dict(os.environ)
            env["HOME"] = fake_home
            env["PYTHONDONTWRITEBYTECODE"] = "1"
            result = subprocess.run(
                [sys.executable, "-c", "import ta_web.app as m\nassert m.application is not None\n"],
                env=env,
                capture_output=True,
                text=True,
                timeout=30,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse((Path(fake_home) / ".tradingagents").exists())


if __name__ == "__main__":
    unittest.main()
