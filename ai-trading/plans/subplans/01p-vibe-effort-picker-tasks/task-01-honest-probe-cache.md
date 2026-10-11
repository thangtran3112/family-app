# Task 1: Honest probe + shared `validate_reasoning_effort` + 10-minute cache

Part of [01p-vibe-effort-picker-plan.md](../01p-vibe-effort-picker-plan.md). Read its Global Constraints and Review Focus first.

**Goal:** Make `_discover_reasoning_efforts` trust only a model-specific OpenAI error (the current code incorrectly trusts generic supported-value lists, so `o3` offers `xhigh` despite rejecting it on `/v1/responses`). Cache only definite answers for ten minutes so opening a chat and sending a message do not each call OpenAI; share the existing `PUT /settings/llm` rejection logic with message-send validation.

All paths below are relative to `ai-trading/packages/vibe-trading/` unless noted.

**Files:**
- Modify: `agent/src/api/settings_routes.py` (model-specific probe guard, cache, shared validators)
- Modify/Test: `agent/tests/test_settings_api.py`
- Modify: `DIVERGENCE.md` (backend rows in the same commit)

## Interfaces

- Consumes: `LLMProviderOption`, `ReasoningEffortsResponse`, `LLM_PROVIDER_BY_NAME`, `LLM_REASONING_EFFORTS`, `LLM_REASONING_EFFORT_ORDER`, `LLM_FALLBACK_REASONING_EFFORTS`, `_discover_reasoning_efforts`, `_saved_or_given_api_key`, `_read_settings_env_values` — all pre-existing in `agent/src/api/settings_routes.py`.
- Produces (consumed by Task 3): `async def validate_message_reasoning_effort(effort: str) -> None` in `agent/src/api/settings_routes.py` — raises `fastapi.HTTPException` (400) or returns `None`.
- Produces (consumed nowhere else, but documents the shared core): `async def validate_reasoning_effort(effort: str, provider: LLMProviderOption, *, model_name: str, base_url: str, api_key: str) -> None`.
- Produces (internal, used only inside this file): `_reasoning_efforts_cache: _ReasoningEffortsCache` module-level instance.

---

### Step 1: Write the failing tests

Open `agent/tests/test_settings_api.py`. Add `Optional` to its imports:

- [ ] Replace:

```python
import os
from pathlib import Path

import pytest
```

with:

```python
import os
from pathlib import Path
from typing import Optional

import pytest
```

- [ ] Add an autouse fixture right before the existing `client` fixture (so every test in this module starts with an empty cache — several tests reuse `gpt-6.1-sol` against different fake OpenAI responses, and without this a cache hit from an earlier test would silently return a stale answer):

Replace:

```python
@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    env_example = tmp_path / ".env.example"
```

with:

```python
@pytest.fixture(autouse=True)
def _clear_reasoning_efforts_cache() -> None:
    """Each test probes its own fake OpenAI; a cross-test cache hit would
    silently return a stale answer and hide a real regression."""
    settings_routes._reasoning_efforts_cache.clear()


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    env_example = tmp_path / ".env.example"
```

- [ ] Add the new tests. Find this line (the probe-matrix section already has `SOL_MESSAGE`, `_fake_openai`, `_discover` helpers above it — do not duplicate them):

```python
def test_qveris_routes_are_not_mounted() -> None:
```

Insert immediately before it:

```python
def test_reasoning_efforts_are_cached_for_ten_minutes(monkeypatch: pytest.MonkeyPatch) -> None:
    seen = _fake_openai(monkeypatch, 400, SOL_MESSAGE)

    first = _discover("openai", "gpt-6.1-sol")
    second = _discover("openai", "gpt-6.1-sol")

    assert len(seen) == 1  # the second call was served from the cache
    assert second == first


def test_reasoning_efforts_cache_expires_after_ten_minutes(monkeypatch: pytest.MonkeyPatch) -> None:
    seen = _fake_openai(monkeypatch, 400, SOL_MESSAGE)
    clock = {"now": 1_000_000.0}
    monkeypatch.setattr(settings_routes._reasoning_efforts_cache, "_clock", lambda: clock["now"])

    _discover("openai", "gpt-6.1-sol")
    clock["now"] += 600.0

    _discover("openai", "gpt-6.1-sol")

    assert len(seen) == 2


def test_reasoning_efforts_cache_is_keyed_by_model_and_base_url(monkeypatch: pytest.MonkeyPatch) -> None:
    seen = _fake_openai(monkeypatch, 400, SOL_MESSAGE)

    _discover("openai", "gpt-6.1-sol")
    _discover("openai", "gpt-5.5")  # different model: not a cache hit
    _discover("openai", "gpt-6.1-sol", base_url="https://api.openai.com/v1/")  # trailing slash only

    assert len(seen) == 2


def test_reasoning_efforts_cache_never_stores_an_inconclusive_answer(monkeypatch: pytest.MonkeyPatch) -> None:
    seen = _fake_openai(monkeypatch, 500, "boom")

    _discover("openai", "gpt-6.1-sol")
    _discover("openai", "gpt-6.1-sol")

    assert len(seen) == 2  # never cached: every call re-probed


def _validate(provider: str, model: str, effort: str, **kwargs) -> Optional[str]:
    """Call validate_reasoning_effort and return the 400 detail, or None."""
    import asyncio

    from fastapi import HTTPException

    kwargs.setdefault("base_url", "https://api.openai.com/v1")
    kwargs.setdefault("api_key", "sk-test")
    try:
        asyncio.run(
            settings_routes.validate_reasoning_effort(
                effort, settings_routes.LLM_PROVIDER_BY_NAME[provider], model_name=model, **kwargs
            )
        )
    except HTTPException as exc:
        return exc.detail
    return None


def test_validate_reasoning_effort_accepts_empty() -> None:
    assert _validate("openai", "gpt-6.1-sol", "") is None


def test_validate_reasoning_effort_rejects_unknown_value() -> None:
    detail = _validate("openai", "gpt-6.1-sol", "turbo")
    assert detail == "Reasoning effort must be one of none, minimal, low, medium, high, xhigh, max, or empty to leave it unset"


def test_validate_reasoning_effort_rejects_what_the_model_refuses(monkeypatch: pytest.MonkeyPatch) -> None:
    _fake_openai(monkeypatch, 400, SOL_MESSAGE)

    detail = _validate("openai", "gpt-6.1-sol", "max")

    assert detail == "gpt-6.1-sol does not support reasoning effort 'max'; supported: low, medium, high, xhigh"


def test_validate_reasoning_effort_accepts_what_the_model_allows(monkeypatch: pytest.MonkeyPatch) -> None:
    _fake_openai(monkeypatch, 400, SOL_MESSAGE)

    assert _validate("openai", "gpt-6.1-sol", "xhigh") is None


def test_validate_reasoning_effort_an_inconclusive_probe_never_refuses(monkeypatch: pytest.MonkeyPatch) -> None:
    _fake_openai(monkeypatch, 500, "boom")

    assert _validate("openai", "gpt-6.1-sol", "max") is None


def test_generic_supported_values_error_is_inconclusive_and_never_cached(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Verbatim form returned for o3; its claimed xhigh is rejected by /v1/responses.
    seen = _fake_openai(
        monkeypatch, 400,
        "Invalid value: '__probe__'. Supported values are: 'low', 'medium', 'high', and 'xhigh'.",
    )

    first = _discover("openai", "o3")
    second = _discover("openai", "o3")

    assert (first.efforts, first.source) == (["low", "medium", "high"], "default")
    assert second == first
    assert len(seen) == 2


def test_qveris_routes_are_not_mounted() -> None:
```

- [ ] **Step 2: Run it and watch it fail.**

Run (in `agent/`): `python -m pytest tests/test_settings_api.py -q`
Expected: `AttributeError: module 'src.api.settings_routes' has no attribute '_reasoning_efforts_cache'` (from the autouse fixture) and, once that's fixed in your head, `AttributeError: ... has no attribute 'validate_reasoning_effort'`.

---

### Step 3: Implement the cache and the shared validator

In `agent/src/api/settings_routes.py`:

- [ ] Add `import time` next to the existing stdlib imports:

```python
import json
import os
import re
import sys as _sys
import time
from pathlib import Path
```

- [ ] Add the cache class and instance right after `_INVALID_PROBE_EFFORT = "__probe__"`:

```python
_SUPPORTED_VALUES_RE = re.compile(r"Supported values are:(.*)", re.DOTALL)
_QUOTED_WORD_RE = re.compile(r"'([a-z]+)'")
_INVALID_PROBE_EFFORT = "__probe__"

_REASONING_EFFORTS_CACHE_TTL_SECONDS = 600.0


class _ReasoningEffortsCache:
    """A bounded, 10-minute cache of definite reasoning-effort probe answers.

    Keyed by (provider, model, base URL) so opening a chat and sending a
    message do not each call OpenAI. Only a definite provider answer
    (``source == "provider"``) is ever stored; an inconclusive probe (bad key,
    network error, unrecognized response) is never cached, so a transient
    failure cannot freeze a stale fallback in place.

    The ``_clock`` attribute is a callable returning ``time.time()`` and is
    monkeypatchable by tests for deterministic TTL assertions.
    """

    def __init__(self, ttl: float = _REASONING_EFFORTS_CACHE_TTL_SECONDS) -> None:
        self._ttl = ttl
        self._store: Dict[tuple[str, str, str], tuple[float, ReasoningEffortsResponse]] = {}
        self._clock = time.time

    @staticmethod
    def _key(provider: str, model_name: str, base_url: str) -> tuple[str, str, str]:
        return (provider, model_name, base_url.strip().rstrip("/"))

    def get(self, provider: str, model_name: str, base_url: str) -> Optional[ReasoningEffortsResponse]:
        """Return a cached definite answer if fresh, else ``None``."""
        entry = self._store.get(self._key(provider, model_name, base_url))
        if entry is None:
            return None
        cached_at, response = entry
        if self._clock() - cached_at >= self._ttl:
            self._store.pop(self._key(provider, model_name, base_url), None)
            return None
        return response

    def put(self, provider: str, model_name: str, base_url: str, response: ReasoningEffortsResponse) -> None:
        """Store a definite answer. Callers must not store ``source == "default"``."""
        self._store[self._key(provider, model_name, base_url)] = (self._clock(), response)

    def clear(self) -> None:
        """Drop all entries (used in test setup)."""
        self._store.clear()


_reasoning_efforts_cache = _ReasoningEffortsCache()
```

- [ ] In `_discover_reasoning_efforts`, check the cache right after the direct-OpenAI gate. Replace:

```python
    if (
        provider.name != "openai"
        or (urlsplit(base_url).hostname or "").lower() != "api.openai.com"
        or not api_key
    ):
        return fallback
    try:
```

with:

```python
    if (
        provider.name != "openai"
        or (urlsplit(base_url).hostname or "").lower() != "api.openai.com"
        or not api_key
    ):
        return fallback
    cached = _reasoning_efforts_cache.get(provider.name, model_name, base_url)
    if cached is not None:
        return cached
    try:
```

- [ ] Still inside `_discover_reasoning_efforts`, refuse generic supported-value lists. Immediately after `if listed:` add this guard, before parsing `efforts`:

```python
        # Generic "Invalid value ... Supported values" lists a shared superset,
        # not this model's options (o3 claims xhigh but /v1/responses rejects it).
        if f"does not support '{_INVALID_PROBE_EFFORT}' with this model" not in message:
            return fallback
```

- [ ] Then cache both definite outcomes. Replace:

```python
        if efforts:
            return fallback.model_copy(update={"efforts": efforts, "source": "provider"})
    elif "reasoning_effort" in message and (
        "unrecognized request argument" in message.lower()
        or "unsupported parameter" in message.lower()
    ):
        # A model without reasoning (gpt-4.1, ...) has no effort control at all.
        return fallback.model_copy(update={"efforts": [], "source": "provider"})
    return fallback
```

with:

```python
        if efforts:
            definite = fallback.model_copy(update={"efforts": efforts, "source": "provider"})
            _reasoning_efforts_cache.put(provider.name, model_name, base_url, definite)
            return definite
    elif "reasoning_effort" in message and (
        "unrecognized request argument" in message.lower()
        or "unsupported parameter" in message.lower()
    ):
        # A model without reasoning (gpt-4.1, ...) has no effort control at all.
        definite = fallback.model_copy(update={"efforts": [], "source": "provider"})
        _reasoning_efforts_cache.put(provider.name, model_name, base_url, definite)
        return definite
    return fallback
```

- [ ] Add the two shared validators right after `_discover_reasoning_efforts` (before the `# --- Response builders ---` section comment):

```python
async def validate_reasoning_effort(
    effort: str,
    provider: LLMProviderOption,
    *,
    model_name: str,
    base_url: str,
    api_key: str,
) -> None:
    """Raise HTTP 400 when ``effort`` is unknown or the model refuses it.

    ``effort`` must already be stripped and lowercased. An empty string is
    always accepted (it means "no override"). Shared by ``PUT /settings/llm``
    and ``POST /sessions/{id}/messages`` so both routes refuse the same way
    before anything is persisted or an attempt is created. An inconclusive
    probe (``source != "provider"``) never refuses: the allow-list check above
    is all the validation that applies.
    """
    if effort not in LLM_REASONING_EFFORTS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "Reasoning effort must be one of "
                f"{', '.join(LLM_REASONING_EFFORT_ORDER)}, "
                "or empty to leave it unset"
            ),
        )
    if not effort:
        return
    accepted = await _discover_reasoning_efforts(
        provider, model_name=model_name, base_url=base_url, api_key=api_key
    )
    if accepted.source == "provider" and effort not in accepted.efforts:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"{model_name} does not support reasoning effort "
                f"{effort!r}; supported: {', '.join(accepted.efforts)}"
                if accepted.efforts
                else f"{model_name} has no reasoning-effort setting; leave it empty"
            ),
        )


async def validate_message_reasoning_effort(effort: str) -> None:
    """Validate a chat message's ``reasoning_effort`` against the currently
    configured provider and model (``sessions_routes.py::send_message``).

    Resolves the same provider/model/base URL/API key
    :func:`_build_llm_settings_response` reads, then delegates to
    :func:`validate_reasoning_effort`. ``effort`` must already be stripped and
    lowercased; an empty string is always accepted.
    """
    current_values = _read_settings_env_values()
    provider_name = current_values.get("LANGCHAIN_PROVIDER", "openai").strip().lower()
    provider = LLM_PROVIDER_BY_NAME.get(provider_name, LLM_PROVIDER_BY_NAME["openai"])
    model_name = current_values.get("LANGCHAIN_MODEL_NAME", provider.default_model).strip()
    base_url = current_values.get(provider.base_url_env, provider.default_base_url).strip()
    api_key = _saved_or_given_api_key(provider, None, current_values)
    await validate_reasoning_effort(
        effort, provider, model_name=model_name, base_url=base_url, api_key=api_key
    )
```

- [ ] **Step 4: Run it; the new tests can pass, but one production path remains duplicated.** `python -m pytest tests/test_settings_api.py -q` — the cache, generic-error and helper tests now pass, but `update_llm_settings` still has its own inline validation. Step 5 switches it to the shared helper so Settings and message-send cannot diverge. Do not claim the task complete before Step 6's green run.

---

### Step 5: Refactor `PUT /settings/llm` onto the shared helper

In `agent/src/api/settings_routes.py`'s `update_llm_settings` handler:

- [ ] Replace:

```python
        reasoning_effort = (payload.reasoning_effort or "").strip().lower()
        if reasoning_effort not in LLM_REASONING_EFFORTS:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    "Reasoning effort must be one of "
                    f"{', '.join(LLM_REASONING_EFFORT_ORDER)}, "
                    "or empty to leave it unset"
                ),
            )

        current_values = _read_settings_env_values()
        base_url = (
            payload.base_url if payload.base_url is not None else provider.default_base_url
        ).strip()
        if reasoning_effort:
            # Never persist an effort this model rejects (that is a failed run later).
            accepted = await _discover_reasoning_efforts(
                provider,
                model_name=model_name,
                base_url=base_url,
                api_key=_saved_or_given_api_key(provider, payload.api_key, current_values),
            )
            if accepted.source == "provider" and reasoning_effort not in accepted.efforts:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=(
                        f"{model_name} does not support reasoning effort "
                        f"{reasoning_effort!r}; supported: {', '.join(accepted.efforts)}"
                        if accepted.efforts
                        else f"{model_name} has no reasoning-effort setting; leave it empty"
                    ),
                )
        if provider.auth_type == "oauth":
```

with:

```python
        reasoning_effort = (payload.reasoning_effort or "").strip().lower()

        current_values = _read_settings_env_values()
        base_url = (
            payload.base_url if payload.base_url is not None else provider.default_base_url
        ).strip()
        # Never persist an effort this model rejects (that is a failed run later).
        await validate_reasoning_effort(
            reasoning_effort,
            provider,
            model_name=model_name,
            base_url=base_url,
            api_key=_saved_or_given_api_key(provider, payload.api_key, current_values),
        )
        if provider.auth_type == "oauth":
```

- [ ] **Step 6: Run and expect PASS.**

Run (in `agent/`): `python -m pytest tests/test_settings_api.py -q`
Expected: `55 passed` (45 pre-existing + 10 new).

- [ ] **Step 7: Run the neighboring suites that exercise the same module, expect PASS.**

Run: `python -m pytest tests/test_llm_reasoning_effort.py tests/test_llm.py -q`
Expected: all green (these do not touch `settings_routes.py` directly but import `src.providers.llm`, which Task 2 changes next; confirming green now gives a clean baseline).

- [ ] **Step 8: Update `packages/vibe-trading/DIVERGENCE.md` in the same commit.**

Open `packages/vibe-trading/DIVERGENCE.md`. Find the last row of the backend changes table:

```
| `tests/test_qveris_routes.py` | Module skipped (routes are not mounted). | |
```

Replace it with itself plus two new rows directly after:

```
| `tests/test_qveris_routes.py` | Module skipped (routes are not mounted). | |
| `src/api/settings_routes.py` | `_discover_reasoning_efforts` trusts only model-specific errors (generic supported-value lists incorrectly offer `xhigh` for `o3`) and gains a 10-minute, provider/model/base-URL-keyed cache (`_ReasoningEffortsCache`) that stores only definite (`source: "provider"`) answers; a new `validate_reasoning_effort()`/`validate_message_reasoning_effort()` pair is shared by `PUT /settings/llm` and the chat message route. | Opening a chat and sending a message must not each call OpenAI; the chat route needs the same refusal `PUT /settings/llm` already gives. |
| `tests/test_settings_api.py` | Cache-clearing autouse fixture; new cache and `validate_reasoning_effort` tests. | |
```

- [ ] **Step 9: Commit.**

```
git -C ai-trading/packages/vibe-trading add agent/src/api/settings_routes.py agent/tests/test_settings_api.py DIVERGENCE.md
git -C ai-trading/packages/vibe-trading commit -m "feat(family-app): cache the reasoning-effort probe and share its validation"
```
