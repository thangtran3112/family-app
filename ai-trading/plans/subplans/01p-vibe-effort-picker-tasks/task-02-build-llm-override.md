# Task 2: `build_llm`/`ChatLLM` per-call reasoning-effort override

Part of [01p-vibe-effort-picker-plan.md](../01p-vibe-effort-picker-plan.md). Read its Global Constraints and Review Focus first. Builds on [Task 1](task-01-honest-probe-cache.md) (same repo, no code dependency).

**Goal:** Give `build_llm` and `ChatLLM` an optional `reasoning_effort` that wins over the environment-configured value in all three provider branches (openai-codex, anthropic, openai-compatible default), and make `ChatLLM.runtime_snapshot.reasoning_effort` report the effective level — the one place every downstream consumer (`agent/run_outcome.py::build_result_dict`, which already does `"reasoning_effort": runtime.reasoning_effort`; `service.py`'s reply-metadata copy; `swarm/runtime.py`'s `run.reasoning_effort`) reads from. No change is needed in `agent/loop.py` or `agent/run_outcome.py` — they already forward `runtime_snapshot.reasoning_effort` verbatim.

All paths below are relative to `ai-trading/packages/vibe-trading/` unless noted.

**Files:**
- Modify: `agent/src/providers/llm.py`, `agent/src/providers/chat.py`
- Create/Test: `agent/tests/test_reasoning_effort_override.py`
- Modify: `DIVERGENCE.md` (backend rows in the same commit)

## Interfaces

- Consumes: `get_env_config()` (`src/config/accessor.py`), `LLMRuntimeSnapshot` (`src/providers/chat.py`, pre-existing dataclass with fields `provider`, `configured_model`, `reasoning_effort`).
- Produces (consumed by Task 3 and Task 4): `_effective_effort(override: Optional[str]) -> str` in `src/providers/llm.py`; `build_llm(*, model_name=None, callbacks=None, reasoning_effort=None)`; `ChatLLM(model_name=None, reasoning_effort=None)`.

---

### Step 1: Write the failing tests

Create `agent/tests/test_reasoning_effort_override.py`:

```python
"""Per-call ``reasoning_effort`` override: build_llm, ChatLLM, and the runtime snapshot.

Family-app fork (DIVERGENCE.md): a per-message effort must win over the
environment-configured default in every provider branch, and the effective
level must be visible on ``ChatLLM.runtime_snapshot`` so the reply metadata,
``attempt.*`` events, and ``run.json`` report it with no further plumbing.
"""

from __future__ import annotations

import os
from concurrent.futures import ThreadPoolExecutor
from typing import Any
from unittest.mock import patch

import pytest

import src.providers.llm as llm_mod
from src.providers.chat import ChatLLM
from src.providers.llm import _effective_effort, build_llm


@pytest.fixture(autouse=True)
def _pin_dotenv_guard(monkeypatch: pytest.MonkeyPatch) -> None:
    """Prevent build_llm() from loading a real ~/.vibe-trading/.env."""
    monkeypatch.setattr(llm_mod, "_dotenv_loaded", True)


def test_effective_effort_prefers_the_override() -> None:
    with patch.dict(os.environ, {}, clear=False):
        assert _effective_effort("XHIGH") == "xhigh"
        assert _effective_effort("  low  ") == "low"


def test_effective_effort_falls_back_to_the_environment() -> None:
    from src.config.accessor import reset_env_config

    with patch.dict(os.environ, {"LANGCHAIN_REASONING_EFFORT": "Medium"}, clear=False):
        reset_env_config()
        try:
            assert _effective_effort(None) == "medium"
        finally:
            reset_env_config()


def _capture_kwargs(env: dict[str, str], **build_kwargs: Any) -> dict[str, Any]:
    """Run build_llm in a replaced environment and return the adapter kwargs."""
    captured: dict[str, Any] = {}

    class _FakeChatOpenAI:
        def __init__(self, **kwargs: Any) -> None:
            captured.update(kwargs)

    with patch.dict(os.environ, env, clear=True):
        with patch.object(llm_mod, "ChatOpenAIWithReasoning", _FakeChatOpenAI):
            build_llm(**build_kwargs)
    return captured


class TestBuildLlmOverride:
    """The three provider branches ``build_llm`` documents in 01p section 5.2."""

    def test_openai_compatible_override_wins_over_the_environment(self) -> None:
        kwargs = _capture_kwargs(
            {
                "LANGCHAIN_PROVIDER": "openai",
                "OPENAI_API_KEY": "sk-test",
                "LANGCHAIN_MODEL_NAME": "gpt-6.1-sol",
                "LANGCHAIN_REASONING_EFFORT": "low",
                "LANGCHAIN_USE_RESPONSES_API": "false",
            },
            reasoning_effort="xhigh",
        )

        assert kwargs["reasoning_effort"] == "xhigh"

    def test_openai_compatible_override_none_disables_the_field(self) -> None:
        kwargs = _capture_kwargs(
            {
                "LANGCHAIN_PROVIDER": "openai",
                "OPENAI_API_KEY": "sk-test",
                "LANGCHAIN_MODEL_NAME": "gpt-6.1-sol",
                "LANGCHAIN_REASONING_EFFORT": "xhigh",
                "LANGCHAIN_USE_RESPONSES_API": "false",
            },
            reasoning_effort="",
        )

        assert kwargs["reasoning_effort"] is None

    def test_unset_override_keeps_the_environment_default(self) -> None:
        kwargs = _capture_kwargs(
            {
                "LANGCHAIN_PROVIDER": "openai",
                "OPENAI_API_KEY": "sk-test",
                "LANGCHAIN_MODEL_NAME": "gpt-6.1-sol",
                "LANGCHAIN_REASONING_EFFORT": "high",
                "LANGCHAIN_USE_RESPONSES_API": "false",
            },
        )

        assert kwargs["reasoning_effort"] == "high"

    def test_openai_codex_override_wins_over_the_environment(self) -> None:
        captured: dict[str, Any] = {}

        class _FakeOpenAICodexLLM:
            def __init__(self, **kwargs: Any) -> None:
                captured.update(kwargs)

        with patch.dict(
            os.environ,
            {
                "LANGCHAIN_PROVIDER": "openai-codex",
                "LANGCHAIN_MODEL_NAME": "gpt-5-codex",
                "LANGCHAIN_REASONING_EFFORT": "low",
            },
            clear=True,
        ):
            with patch("src.providers.openai_codex.OpenAICodexLLM", _FakeOpenAICodexLLM):
                build_llm(reasoning_effort="xhigh")

        assert captured["reasoning_effort"] == "xhigh"

    def test_anthropic_override_wins_over_the_environment(self) -> None:
        captured: dict[str, Any] = {}

        class _FakeChatAnthropic:
            model_fields = {"reasoning_effort": object()}

            def __init__(self, **kwargs: Any) -> None:
                captured.update(kwargs)

        class _FakeModule:
            ChatAnthropic = _FakeChatAnthropic

        with patch.dict(
            os.environ,
            {
                "LANGCHAIN_PROVIDER": "anthropic",
                "ANTHROPIC_API_KEY": "sk-ant-test",
                "LANGCHAIN_MODEL_NAME": "claude-opus-5",
                "LANGCHAIN_REASONING_EFFORT": "low",
            },
            clear=True,
        ):
            with patch.object(llm_mod, "import_module", lambda name: _FakeModule):
                llm_mod._TEMPERATURE_SAFE_ANTHROPIC_CACHE.clear()
                build_llm(reasoning_effort="high")

        assert captured["reasoning_effort"] == "high"


class TestChatLlmRuntimeSnapshot:
    """``ChatLLM.runtime_snapshot`` is the one place the effective level is read
    back from (service.py, loop.py, run_outcome.py all consume it verbatim)."""

    def test_snapshot_reports_the_override(self) -> None:
        with patch.dict(
            os.environ,
            {
                "LANGCHAIN_PROVIDER": "openai",
                "OPENAI_API_KEY": "sk-test",
                "LANGCHAIN_MODEL_NAME": "gpt-6.1-sol",
                "LANGCHAIN_REASONING_EFFORT": "low",
            },
            clear=True,
        ):
            llm = ChatLLM(reasoning_effort="xhigh")

        assert llm.runtime_snapshot.reasoning_effort == "xhigh"

    def test_snapshot_falls_back_to_the_environment_when_no_override_is_given(self) -> None:
        with patch.dict(
            os.environ,
            {
                "LANGCHAIN_PROVIDER": "openai",
                "OPENAI_API_KEY": "sk-test",
                "LANGCHAIN_MODEL_NAME": "gpt-6.1-sol",
                "LANGCHAIN_REASONING_EFFORT": "high",
            },
            clear=True,
        ):
            llm = ChatLLM()

        assert llm.runtime_snapshot.reasoning_effort == "high"

    def test_two_concurrent_chats_keep_their_own_effort(self) -> None:
        with patch.dict(
            os.environ,
            {
                "LANGCHAIN_PROVIDER": "openai",
                "OPENAI_API_KEY": "sk-test",
                "LANGCHAIN_MODEL_NAME": "gpt-6.1-sol",
                "LANGCHAIN_REASONING_EFFORT": "medium",
            },
            clear=True,
        ):
            with ThreadPoolExecutor(max_workers=2) as executor:
                levels = list(
                    executor.map(
                        lambda level: ChatLLM(reasoning_effort=level).runtime_snapshot.reasoning_effort,
                        ("low", "xhigh"),
                    )
                )

        assert levels == ["low", "xhigh"]
```

- [ ] **Step 2: Run it and watch it fail.**

Run (in `agent/`): `python -m pytest tests/test_reasoning_effort_override.py -q`
Expected: `TypeError: build_llm() got an unexpected keyword argument 'reasoning_effort'` (and similarly for `_effective_effort` not existing).

---

### Step 3: Implement `_effective_effort` and thread it through `build_llm`

In `agent/src/providers/llm.py`:

- [ ] Replace the `build_llm` signature and docstring header:

```python
def build_llm(*, model_name: Optional[str] = None, callbacks: Any = None) -> Any:
    """Construct the configured LangChain chat model.

    Args:
        model_name: Model name; defaults to LANGCHAIN_MODEL_NAME.
        callbacks: Optional LangChain callbacks.

    Returns:
```

with:

```python
def _effective_effort(override: Optional[str]) -> str:
    """Return the reasoning effort to send: ``override`` when given, else the
    environment value. Both are stripped and lowercased so a per-message
    override behaves exactly like the configured default it replaces
    (family-app fork: per-chat reasoning effort, DIVERGENCE.md).
    """
    if override is not None:
        return override.strip().lower()
    return get_env_config().llm.langchain_reasoning_effort.strip().lower()


def build_llm(
    *,
    model_name: Optional[str] = None,
    callbacks: Any = None,
    reasoning_effort: Optional[str] = None,
) -> Any:
    """Construct the configured LangChain chat model.

    Args:
        model_name: Model name; defaults to LANGCHAIN_MODEL_NAME.
        callbacks: Optional LangChain callbacks.
        reasoning_effort: Per-call override; wins over the environment value
            in every provider branch below. ``None`` (default) preserves the
            environment-configured effort.

    Returns:
```

- [ ] In the `openai-codex` branch, replace:

```python
        effort = get_env_config().llm.langchain_reasoning_effort.strip().lower()
        return OpenAICodexLLM(
            model=name,
            temperature=temperature,
            timeout=get_env_config().llm.timeout_seconds,
            reasoning_effort=effort or None,
        )
```

with:

```python
        effort = _effective_effort(reasoning_effort)
        return OpenAICodexLLM(
            model=name,
            temperature=temperature,
            timeout=get_env_config().llm.timeout_seconds,
            reasoning_effort=effort or None,
        )
```

- [ ] In the `anthropic` branch, replace:

```python
    if provider == "anthropic":
        return _build_anthropic(
            model=name,
            temperature=temperature,
            callbacks=callbacks,
            effort=get_env_config().llm.langchain_reasoning_effort.strip().lower(),
        )
```

with:

```python
    if provider == "anthropic":
        return _build_anthropic(
            model=name,
            temperature=temperature,
            callbacks=callbacks,
            effort=_effective_effort(reasoning_effort),
        )
```

- [ ] In the openai-compatible default branch (near the bottom of the function, right before `configured_responses_api`), replace:

```python
        logger.info("Forcing temperature=1.0 for %s (provider requirement)", name)
        temperature = 1.0
    effort = get_env_config().llm.langchain_reasoning_effort.strip().lower()
    # Moonshot/DeepSeek official APIs emit reasoning by default and ignore this field.
```

with:

```python
        logger.info("Forcing temperature=1.0 for %s (provider requirement)", name)
        temperature = 1.0
    effort = _effective_effort(reasoning_effort)
    # Moonshot/DeepSeek official APIs emit reasoning by default and ignore this field.
```

- [ ] **Step 4: Run it, expect `build_llm` tests to pass and `ChatLLM` tests to fail.**

Run: `python -m pytest tests/test_reasoning_effort_override.py -q`
Expected: `TestBuildLlmOverride` (5 tests) pass; `TestChatLlmRuntimeSnapshot` (2 tests) fail with `TypeError: ChatLLM() got an unexpected keyword argument 'reasoning_effort'`.

---

### Step 5: Implement `ChatLLM`'s override

In `agent/src/providers/chat.py`, replace `ChatLLM.__init__`:

```python
    def __init__(self, model_name: Optional[str] = None) -> None:
        """Initialize ChatLLM.

        Args:
            model_name: Model name; defaults to the environment variable value.
        """
        self._llm = build_llm(model_name=model_name)
        runtime_cfg = get_env_config().llm
        configured_model = (
            model_name or runtime_cfg.langchain_model_name
        ).strip()
        self.model_name = configured_model
        self.runtime_snapshot = LLMRuntimeSnapshot(
            provider=runtime_cfg.langchain_provider.strip().lower() or "openai",
            configured_model=configured_model,
            reasoning_effort=runtime_cfg.langchain_reasoning_effort.strip().lower(),
        )
```

with:

```python
    def __init__(
        self,
        model_name: Optional[str] = None,
        reasoning_effort: Optional[str] = None,
    ) -> None:
        """Initialize ChatLLM.

        Args:
            model_name: Model name; defaults to the environment variable value.
            reasoning_effort: Per-call override; wins over the environment's
                configured effort (family-app fork: per-chat reasoning effort,
                DIVERGENCE.md). ``None`` (default) keeps the environment value.
        """
        self._llm = build_llm(model_name=model_name, reasoning_effort=reasoning_effort)
        runtime_cfg = get_env_config().llm
        configured_model = (
            model_name or runtime_cfg.langchain_model_name
        ).strip()
        self.model_name = configured_model
        effective_effort = (
            reasoning_effort
            if reasoning_effort is not None
            else runtime_cfg.langchain_reasoning_effort
        )
        self.runtime_snapshot = LLMRuntimeSnapshot(
            provider=runtime_cfg.langchain_provider.strip().lower() or "openai",
            configured_model=configured_model,
            reasoning_effort=effective_effort.strip().lower(),
        )
```

- [ ] **Step 6: Run and expect PASS.**

Run: `python -m pytest tests/test_reasoning_effort_override.py -q`
Expected: `10 passed`.

- [ ] **Step 7: Run the neighboring suites, expect PASS.**

Run: `python -m pytest tests/test_chat_llm_lifecycle.py tests/test_llm_reasoning_effort.py tests/test_llm.py tests/test_openai_codex.py tests/test_provider_diagnostics.py tests/test_provider_header_isolation.py tests/test_chat_response_metadata.py -q`
Expected: `163 passed` — these cover `ChatOpenAIWithReasoning`'s header isolation, the `uses_responses_api` routing, and the existing `LANGCHAIN_REASONING_EFFORT` delivery paths, none of which this task's signature-only change should perturb.

---

### Step 8: Update `packages/vibe-trading/DIVERGENCE.md`

Find the row Task 1 added (now present in the file):

```
| `tests/test_settings_api.py` | Cache-clearing autouse fixture; new cache and `validate_reasoning_effort` tests. | |
```

Replace it with itself plus two new rows directly after:

```
| `tests/test_settings_api.py` | Cache-clearing autouse fixture; new cache and `validate_reasoning_effort` tests. | |
| `src/providers/llm.py`, `src/providers/chat.py` | `build_llm`/`ChatLLM` take an optional `reasoning_effort` that wins over the environment value in all three provider branches (openai-codex, anthropic, openai-compatible); `_effective_effort()` is the one place that resolves override-vs-environment. `ChatLLM.runtime_snapshot.reasoning_effort` reports the effective level. | Per-message effort without touching the process-wide config; `runtime_snapshot` is what every downstream consumer (reply metadata, `run.json`) already reads. |
| `tests/test_reasoning_effort_override.py` | New. | |
```

- [ ] **Step 9: Commit.**

```
git -C ai-trading/packages/vibe-trading add agent/src/providers/llm.py agent/src/providers/chat.py agent/tests/test_reasoning_effort_override.py DIVERGENCE.md
git -C ai-trading/packages/vibe-trading commit -m "feat(family-app): build_llm/ChatLLM accept a per-call reasoning-effort override"
```
