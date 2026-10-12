"""Legacy and golden manifest execution contracts."""

import asyncio
import json
import sys
from pathlib import Path

import httpx
import pytest
import run_scenarios
from run_scenarios import SCENARIOS, runtime_matches, select_scenarios


def test_legacy_scenarios_still_load():
    assert len(select_scenarios(None)) == len(SCENARIOS)
    assert select_scenarios(None)[0] == SCENARIOS[0]


def test_manifest_cases_can_replace_the_legacy_list():
    rows = select_scenarios(Path(__file__).with_name("golden_cases.json"))
    assert len(rows) == 25
    assert rows[0][0] == "F01" and rows[-1][0] == "R07"


@pytest.mark.parametrize("actual,model,effort,want", [
    ({"status": "completed", "model": "gpt-5.5-2026-04-23", "effort": "xhigh"}, "gpt-5.5", "xhigh", True),
    ({"status": "completed", "model": "gpt-6.1-sol", "effort": "low"}, "gpt-6.1-sol", "xhigh", False),
    ({"status": "failed", "model": "gpt-6.1-sol", "effort": "xhigh"}, "gpt-6.1-sol", "xhigh", False),
    ({"status": "completed", "model": "gpt-5.5", "configured_model": "gpt-6.1-sol", "effort": "xhigh"}, "gpt-5.5", "xhigh", False),
])
def test_runtime_metadata_mismatch_is_recorded(actual, model, effort, want):
    assert runtime_matches(actual, model, effort) is want


def test_golden_batch_persists_mismatched_reply_and_returns_failure(tmp_path, monkeypatch):
    calls = []

    def handler(request):
        calls.append(request.url.path)
        if request.url.path == "/settings/llm":
            return httpx.Response(200, json={"provider": "openai", "model_name": "gpt-6.1-sol", "reasoning_effort": "xhigh"})
        if request.url.path == "/sessions":
            return httpx.Response(200, json={"session_id": "test-session"})
        if request.url.path.endswith("/messages") and request.method == "POST":
            return httpx.Response(200, json={"id": "test-message"})
        return httpx.Response(200, json=[{"role": "assistant", "content": "Answer", "tool_trail": [],
                                         "metadata": {"status": "completed", "model": "gpt-6.1-sol",
                                                      "configured_model": "gpt-6.1-sol", "model_source": "provider_response",
                                                      "reasoning_effort": "low"}}])

    original_client = httpx.AsyncClient
    monkeypatch.setattr(run_scenarios.httpx, "AsyncClient", lambda **kw: original_client(transport=httpx.MockTransport(handler), **kw))

    async def no_wait(_):
        return None

    monkeypatch.setattr(run_scenarios.asyncio, "sleep", no_wait)
    monkeypatch.setattr(sys, "argv", ["run_scenarios.py", str(tmp_path), "--cases",
                                  str(Path(__file__).with_name("golden_cases.json")), "--only", "F01",
                                  "--expect-model", "gpt-6.1-sol", "--expect-effort", "xhigh"])
    with pytest.raises(RuntimeError, match="golden batch incomplete"):
        asyncio.run(run_scenarios.main())
    saved = json.loads((tmp_path / "F01.json").read_text())
    assert saved["summary"]["status"] == "METADATA_MISMATCH"
    assert saved["case_set_sha"] and saved["fork_commit"]
    assert saved["started_utc"] and saved["finished_utc"]
    assert calls[0] == "/settings/llm" and "/sessions" in calls
