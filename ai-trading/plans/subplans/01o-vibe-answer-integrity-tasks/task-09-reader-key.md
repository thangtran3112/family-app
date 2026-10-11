# Task 9: read_url sends an optional JINA_API_KEY and stops retries on a refusal

Part of [01o-vibe-answer-integrity-plan.md](../01o-vibe-answer-integrity-plan.md). Read its Global Constraints and Test Runner first; every command runs from the repository root of the worktree, with `vt_test` defined as in the Test Runner section.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When `JINA_API_KEY` is set, `read_url` sends it as a bearer token and redacts it even if a successful page, upstream error or raised exception echoes the key. A 401 or 403 from the reader tells the model to stop retrying that page and, without a key, that the reader refuses anonymous access. The reader answered anonymous callers with 401 ("bad network reputation") on 17 of 17 local calls and with 403 ("Anonymous access to domain … blocked") once in production. The code is inert until the owner stores a free key in `ai-trading/vibe-trading`.

**Files:**
- Modify (append tests and one line): `ai-trading/packages/vibe-trading/agent/tests/test_web_reader_security.py`
- Modify: `ai-trading/packages/vibe-trading/agent/src/tools/web_reader_tool.py` (`read_url`)
- Modify: `ai-trading/packages/vibe-trading/DIVERGENCE.md` (one Backend row)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `read_url` adds `Authorization: Bearer <key>` only when `JINA_API_KEY` is non-blank; its error text for HTTP 401 or 403 ends with `... do not retry this URL ...` (anonymous) or `... refused this URL even when authenticated; do not retry it ...` (with a key). Other statuses keep their plain error. The key never appears in a result or log line.

- [ ] **Step 1: Write the failing tests.** Append this to `agent/tests/test_web_reader_security.py` (it already imports `json`, `SimpleNamespace`, `pytest` and `web_reader_tool`):

```python
    monkeypatch.delenv("JINA_API_KEY", raising=False)


def _capture_get(monkeypatch: pytest.MonkeyPatch, *, status: int = 200, text: str = "Title: T\n\nbody") -> list[dict]:
    calls: list[dict] = []

    def fake_get(url: str, **kwargs: object) -> SimpleNamespace:
        calls.append({"url": url, **kwargs})
        return SimpleNamespace(status_code=status, text=text)

    monkeypatch.setattr(web_reader_tool.requests, "get", fake_get)
    return calls


def test_read_url_sends_the_jina_key_as_a_bearer_token_without_echoing_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("JINA_API_KEY", "jina_test_key_123")
    calls = _capture_get(monkeypatch)

    out = web_reader_tool.read_url("https://example.com/report")

    assert calls[0]["headers"]["Authorization"] == "Bearer jina_test_key_123"
    assert "jina_test_key_123" not in out


@pytest.mark.parametrize("value", [None, "", "   "])
def test_read_url_sends_no_authorization_without_a_key(
    monkeypatch: pytest.MonkeyPatch, value: str | None
) -> None:
    if value is None:
        monkeypatch.delenv("JINA_API_KEY", raising=False)
    else:
        monkeypatch.setenv("JINA_API_KEY", value)
    calls = _capture_get(monkeypatch)

    web_reader_tool.read_url("https://example.com/report")

    assert "Authorization" not in calls[0]["headers"]


@pytest.mark.parametrize("status", [401, 403])
def test_an_anonymous_refusal_tells_the_model_not_to_retry_the_page(
    monkeypatch: pytest.MonkeyPatch, status: int
) -> None:
    monkeypatch.delenv("JINA_API_KEY", raising=False)
    _capture_get(monkeypatch, status=status, text="AbuseAlleviationError: Anonymous access to domain blocked")

    result = json.loads(web_reader_tool.read_url("https://example.com/report"))

    assert result["status"] == "error"
    assert f"HTTP {status}" in result["error"]
    assert "refuses anonymous access; do not retry this URL" in result["error"]
    assert "get_stock_profile" in result["error"]


def test_a_refusal_with_a_key_says_the_key_did_not_help(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("JINA_API_KEY", "jina_test_key_123")
    _capture_get(monkeypatch, status=403, text="blocked by the target site")

    result = json.loads(web_reader_tool.read_url("https://example.com/report"))

    assert "refused this URL even when authenticated; do not retry it" in result["error"]
    assert "jina_test_key_123" not in result["error"]


def test_an_upstream_error_that_echoes_the_key_is_redacted_from_result_and_logs(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setenv("JINA_API_KEY", "jina_test_key_123")
    _capture_get(monkeypatch, status=401, text="anonymous rejected: jina_test_key_123")

    result = web_reader_tool.read_url("https://example.com/report")

    assert "jina_test_key_123" not in result
    assert "jina_test_key_123" not in caplog.text
    assert "[redacted]" in result


def test_an_exception_that_echoes_the_key_is_redacted_from_result_and_logs(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setenv("JINA_API_KEY", "jina_test_key_123")

    def fail_get(*_args: object, **_kwargs: object) -> None:
        raise RuntimeError("reader rejected jina_test_key_123")

    monkeypatch.setattr(web_reader_tool.requests, "get", fail_get)

    result = web_reader_tool.read_url("https://example.com/report")

    assert "jina_test_key_123" not in result
    assert "jina_test_key_123" not in caplog.text
    assert "[redacted]" in result


def test_a_successful_page_that_echoes_the_key_is_redacted(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("JINA_API_KEY", "jina_test_key_123")
    _capture_get(monkeypatch, text="Title: Example\n\nreflected jina_test_key_123")

    result = web_reader_tool.read_url("https://example.com/report")

    assert "jina_test_key_123" not in result
    assert "[redacted]" in result


def test_other_failures_keep_their_plain_error(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("JINA_API_KEY", raising=False)
    _capture_get(monkeypatch, status=500, text="upstream down")

    result = json.loads(web_reader_tool.read_url("https://example.com/report"))

    assert result["error"] == "remote reader returned HTTP 500: upstream down"
```

Then, in the existing `test_read_url_allows_public_http_targets`, add one line as its first statement so the test stays hermetic when a developer's environment has a key (it asserts the exact header dictionary):

```python
def test_read_url_allows_public_http_targets(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("JINA_API_KEY", raising=False)
    calls: list[dict[str, object]] = []
```

- [ ] **Step 2: Run the file and confirm the four key and refusal tests fail.**

```bash
vt_test tests/test_web_reader_security.py -q
```

Expected: `7 failed, 23 passed` (the key header, two anonymous refusals, the refusal-with-key case, and three key-echo redaction cases).

- [ ] **Step 3: Implement it.**

Save the diff to a file and apply it (or make the same edits by hand; the hunks are exact):

```bash
cat > "${TMPDIR:-/tmp}/task-09.patch" <<'PATCH'
diff --git a/agent/src/tools/web_reader_tool.py b/agent/src/tools/web_reader_tool.py
index 304049b..caa8179 100644
--- a/agent/src/tools/web_reader_tool.py
+++ b/agent/src/tools/web_reader_tool.py
@@ -5,6 +5,7 @@ from __future__ import annotations
 import ipaddress
 import json
 import logging
+import os
 from urllib.parse import urlsplit
 
 import requests
@@ -82,6 +83,12 @@ def read_url(url: str, no_cache: bool = False) -> str:
         headers = {"Accept": "text/markdown"}
         if no_cache:
             headers["x-no-cache"] = "true"
+        # The reader refuses anonymous callers it treats as abusive (HTTP 401/403); a key moves
+        # its rate limit from the IP to the account. Optional, and never logged or echoed
+        # (family-app fork).
+        api_key = os.environ.get("JINA_API_KEY", "").strip()
+        if api_key:
+            headers["Authorization"] = f"Bearer {api_key}"
         emit_progress(
             "fetching",
             message=f"GET {target_url[:60]}{'…' if len(target_url) > 60 else ''}",
@@ -93,13 +100,21 @@ def read_url(url: str, no_cache: bool = False) -> str:
         )
         emit_progress("parsing", message="extracting markdown")
         if resp.status_code != 200:
-            logger.warning("read_url upstream HTTP %s: %s", resp.status_code, resp.text[:500])
-            return json.dumps({
-                "status": "error",
-                "error": f"remote reader returned HTTP {resp.status_code}: {resp.text[:500]}",
-            }, ensure_ascii=False)
-
-        text = resp.text
+            detail = resp.text[:500].replace(api_key, "[redacted]") if api_key else resp.text[:500]
+            logger.warning("read_url upstream HTTP %s: %s", resp.status_code, detail)
+            error = f"remote reader returned HTTP {resp.status_code}: {detail}"
+            if resp.status_code in (401, 403):
+                error += (
+                    ". The reader refused this URL even when authenticated; do not retry it, "
+                    "use another source."
+                    if api_key
+                    else ". The reader refuses anonymous access; do not retry this URL, use "
+                    "get_stock_profile, get_financial_statements, get_sec_filings or "
+                    "web_search instead."
+                )
+            return json.dumps({"status": "error", "error": error}, ensure_ascii=False)
+
+        text = resp.text.replace(api_key, "[redacted]") if api_key else resp.text
         title = ""
         for line in text.split("\n"):
             if line.startswith("Title:"):
@@ -124,9 +139,10 @@ def read_url(url: str, no_cache: bool = False) -> str:
     except requests.Timeout:
         return json.dumps({"status": "error", "error": f"Request timed out ({_TIMEOUT}s)"}, ensure_ascii=False)
     except Exception as exc:
-        logger.warning("read_url request failed: %s", exc)
+        detail = str(exc).replace(api_key, "[redacted]") if api_key else str(exc)
+        logger.warning("read_url request failed: %s", detail)
         return json.dumps(
-            {"status": "error", "error": f"remote reader request failed: {exc}"},
+            {"status": "error", "error": f"remote reader request failed: {detail}"},
             ensure_ascii=False,
         )
 
PATCH
```

```bash
git -C ai-trading/packages/vibe-trading apply "${TMPDIR:-/tmp}/task-09.patch"
```

- [ ] **Step 4: Run the reader tests, once clean and once with an ambient key to prove they are hermetic.**

```bash
vt_test tests/test_web_reader_security.py tests/test_web_reader_privacy.py -q
JINA_API_KEY=ambient-key-for-hermeticity-check vt_test tests/test_web_reader_security.py tests/test_web_reader_privacy.py -q
```

Expected: `35 passed` both times.

- [ ] **Step 5: Add the ledger row.**

Insert the row below into the **Backend** table of `ai-trading/packages/vibe-trading/DIVERGENCE.md`, immediately above the row that starts with ``| `tests/test_settings_api.py` |`` (so rows stay in task order):

```markdown
| `agent/src/tools/web_reader_tool.py` | `read_url` sends `JINA_API_KEY`, when set, as a bearer token; it redacts the key even if a page, error body or exception echoes it, before logging or returning a result. A 401 or 403 from the reader tells the model to stop retrying that page, and without a key says the reader refuses anonymous access. Tests: `tests/test_web_reader_security.py` (new cases; `test_read_url_allows_public_http_targets` clears the variable so it stays hermetic). | The reader answered anonymous callers with 401 ("bad network reputation") on 17 of 17 local calls and with 403 ("Anonymous access to domain … blocked") once in production; the tool had no way to send a key. |
```

- [ ] **Step 6: Commit.**

```bash
git -C ai-trading/packages/vibe-trading add -A agent DIVERGENCE.md
git -C ai-trading/packages/vibe-trading commit -m "feat(family-app): read_url sends an optional JINA_API_KEY and stops retries on a refusal"
```
