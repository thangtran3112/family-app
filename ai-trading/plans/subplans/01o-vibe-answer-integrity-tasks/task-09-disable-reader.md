# Task 9: Disable Jina-backed `read_url` everywhere

Part of [01o-vibe-answer-integrity-plan.md](../01o-vibe-answer-integrity-plan.md). Read its Global Constraints and Test Runner first. **Owner revision, 2026-10-11:** no Jina Reader, no Jina key, and no direct-fetch replacement in this batch.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans and superpowers:test-driven-development. This task supersedes the old optional-key task; its outcome must be verified against the current fork rather than trusting the old scratch replay.

**Goal:** A local agent and any MCP client cannot invoke Jina. `read_url` stays an inert compatibility function for existing imports, returning a clear unavailable result without making an HTTP request. Structured US tools and `web_search` remain available; full-page reading is deferred for a separate design.

**Files:**
- Modify: `ai-trading/packages/vibe-trading/agent/src/tools/web_reader_tool.py` (remove Jina request code; `WebReaderTool.check_available()` returns false; keep `read_url(url, no_cache=False)` inert and `_url_allowed` validation)
- Modify: `ai-trading/packages/vibe-trading/agent/mcp_server.py` (remove the `@mcp.tool` registration of `read_url`; keep import compatibility if needed)
- Modify: `ai-trading/packages/vibe-trading/agent/src/tools/web_search_tool.py` (stop suggesting `read_url` in descriptions)
- Modify: `ai-trading/packages/vibe-trading/agent/src/agent/context.py` (remove its older document/web instruction to call `read_url`)
- Delete: `ai-trading/packages/vibe-trading/agent/src/skills/web-reader/SKILL.md`; update its references in the bundled skill docs (including `commodity-analysis`) and 17 swarm presets (grants and prompts), so they do not request a nonexistent tool or invent missing data.
- Modify: `ai-trading/packages/vibe-trading/agent/SKILL.md` and seven `README*.md` inventories, and their count tests (75 MCP, 108 keyless agent, 89 bundled skills).
- Create/Test: `ai-trading/packages/vibe-trading/agent/tests/test_reader_disabled.py`
- Modify/Test: existing `test_web_reader_security.py`, `test_web_reader_privacy.py`, `test_security_scanner.py` and any MCP tool-catalog tests whose old expectations depend on Jina-backed page reading.
- Modify/Test: old reader-replay, web-search failure, preset-honesty and README count tests whose expectations depend on exposing the retired reader. Keep security checks for `web_search` snippets and other untrusted tool results.
- Modify: `ai-trading/packages/vibe-trading/DIVERGENCE.md` in the same commit.

**Interfaces:**
- Consumes: `build_registry()` auto-discovery and `BaseTool.check_available()` in `agent/src/tools/__init__.py`; FastMCP's `mcp.list_tools()` in `agent/mcp_server.py`.
- Produces: `WebReaderTool.check_available() == False`; `read_url(url: str, no_cache: bool = False) -> str` returns an error envelope for an allowed public URL without network; neither local nor MCP catalogs offer `read_url`.
- Produces: no bundled `web-reader` skill and no active system prompt or swarm preset granting `read_url`; published inventories match the live catalogs.

- [ ] **Step 1: Add tests for the user-visible contract.** Create `agent/tests/test_reader_disabled.py`:

```python
"""No Jina Reader traffic or exposed read_url tool in the family-app fork."""
from __future__ import annotations

import asyncio
import json

import requests

import mcp_server
from src.tools import build_registry
from src.tools.web_reader_tool import WebReaderTool, read_url


def test_direct_read_url_is_inert_even_if_called_by_old_code(monkeypatch):
    def fail_get(*args, **kwargs):
        raise AssertionError("No network request is allowed")

    monkeypatch.setattr(requests, "get", fail_get)
    result = json.loads(read_url("https://example.com/earnings"))
    assert result["status"] == "error"
    assert "unavailable" in result["error"]


def test_local_agent_never_offers_read_url():
    assert WebReaderTool.check_available() is False
    assert build_registry().get("read_url") is None


def test_mcp_catalog_never_offers_read_url():
    names = {tool.name for tool in asyncio.run(mcp_server.mcp.list_tools())}
    assert "read_url" not in names
```

- [ ] **Step 2: Run the tests and watch them fail** for the actual missing behavior (network attempt, available registry entry, and MCP registration), not a missing dependency:

```bash
vt_test tests/test_reader_disabled.py -q
```

- [ ] **Step 3: Implement the smallest no-network path.** Remove the Jina URL/request/response code from `web_reader_tool.py` but keep its existing `read_url` signature and URL validation. For allowed URLs return `{"status": "error", "error": "read_url is unavailable; use get_stock_profile, get_sec_filings, get_stock_news or web_search"}` without calling `requests`; for blocked URLs keep `{"status":"error","error":"target URL is not allowed"}`. Add `WebReaderTool.check_available() -> False`. Remove the `@mcp.tool` decorator from the MCP wrapper, or remove that wrapper entirely if no direct caller depends on it. Remove stale `read_url` recommendations from `web_search_tool.py`; leave all other tools unchanged.

- [ ] **Step 4: Run the focused tests and then the whole backend suite.** Update only tests that assert the old Jina-backed success/caching contract; keep private-URL rejection and prompt-injection scanner tests on the tools that still return untrusted content. Test both direct call and tool catalogs, then:

```bash
vt_test tests/test_reader_disabled.py tests/test_web_reader_security.py tests/test_web_reader_privacy.py tests/test_security_scanner.py tests/test_mcp_regression.py tests/test_distribution_skill_manifest.py -q
vt_test tests -q -n 8
```

Expected: no Jina network path, no exposed reader tool or skill, no stale system prompt/preset grants, and full backend suite green. Record any upstream test whose contract must change, with its observed reason, in the plan ledger. Implementation first showed 47 dependent failures, then 52 after deleting the obsolete skill: stale preset grants, public inventories, old reader/replay tests, and one web-search error assertion. All are addressed in the same fork commit.

- [ ] **Step 5: Add the fork ledger row and commit exact paths.** `DIVERGENCE.md` must state that `read_url` is unavailable, the local and MCP catalogs omit it, arbitrary full-page reading is deferred, and which original reader tests changed. Do not commit an optional `JINA_API_KEY` path.

```bash
git -C ai-trading/packages/vibe-trading add agent/src/tools/web_reader_tool.py agent/mcp_server.py agent/src/tools/web_search_tool.py agent/tests/test_reader_disabled.py agent/tests/test_web_reader_security.py agent/tests/test_web_reader_privacy.py agent/tests/test_security_scanner.py agent/tests/test_mcp_regression.py agent/tests/test_distribution_skill_manifest.py DIVERGENCE.md
git -C ai-trading/packages/vibe-trading commit -m "feat(family-app): disable Jina-backed page reading"
```

Stage **all actual Task 9 paths** by exact name, including the published inventories and presets, along with `DIVERGENCE.md`. If a named test file did not change, omit it. Preserve upstream tests for unrelated MCP tools. Stop if disabling the reader breaks a US structured-data tool; do not reintroduce Jina to make a test green.
