"""Tests for ta_web.app: guarded HTTP API, ownership, downloads.

HTTPX 0.28.1 ASGITransport + stdlib IsolatedAsyncioTestCase; the transport
never triggers ASGI lifespan, so every test manually enters
``app.router.lifespan_context(app)``. Every client here uses the ASGITransport
*default* (``raise_app_exceptions=True``): an unexpected exception must never
propagate out of the app at all (``ta_web.app``'s outer guard sits outside
Starlette's ``ServerErrorMiddleware`` and never re-raises), so disabling that
default to hide the bug is never needed.
"""

import contextlib
import json
import unittest
import zipfile
from datetime import UTC, date, datetime
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory

import httpx
from ta_web import reports
from ta_web.app import create_app
from ta_web.domain import Inputs, owner_key
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
            self.assertEqual(listing["today"], datetime.now(UTC).date().isoformat())
            self.assertIsInstance(listing["defaults"], dict)
            self.assertNotIn("backend_url", listing["defaults"])

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


if __name__ == "__main__":
    unittest.main()
