# Task 3: Request field, 400-before-storage, and `SessionService` threading

Part of [01p-vibe-effort-picker-plan.md](../01p-vibe-effort-picker-plan.md). Read its Global Constraints and Review Focus first. Builds on [Task 1](task-01-honest-probe-cache.md) (`validate_message_reasoning_effort`) and [Task 2](task-02-build-llm-override.md) (`ChatLLM(reasoning_effort=...)`).

**Goal:** Add `SendMessageRequest.reasoning_effort`, validate it against the currently configured provider/model **before** the user message is stored or an attempt is created, and thread the (already-validated) override through `SessionService.send_message` → `_run_attempt` → `_run_with_agent` to `ChatLLM` and `build_registry` — exactly the way `include_shell_tools` already travels.

All paths below are relative to `ai-trading/packages/vibe-trading/` unless noted.

**Files:**
- Modify: `agent/src/api/sessions_routes.py`, `agent/src/session/service.py`, `agent/src/tools/__init__.py`
- Create/Test: `agent/tests/test_reasoning_effort_message_validation.py`, `agent/tests/test_reasoning_effort_service_threading.py`
- Modify/Test: `agent/tests/test_session_tool_trail.py`, `agent/tests/test_session_service_mcp.py`
- Modify: `DIVERGENCE.md` (backend rows in the same commit)

## Interfaces

- Consumes: `validate_message_reasoning_effort(effort: str) -> None` (Task 1, `src/api/settings_routes.py`); `ChatLLM(model_name=None, reasoning_effort=None)` (Task 2, `src/providers/chat.py`).
- Produces (consumed by this task's own Step 5 and by Task 4): `build_registry(..., reasoning_effort: str | None = None)` in `src/tools/__init__.py` — this task adds the parameter itself (one signature line plus one forwarded call) so `_run_with_agent` has a real target to call; Task 4 picks up from `SwarmTool` already receiving it and threads it the rest of the way to `run_worker`.
- Produces (consumed by the route handler and by Task 4's tests): `SessionService.send_message(..., reasoning_effort: Optional[str] = None)`; `SessionService._run_attempt(..., reasoning_effort: Optional[str] = None)`; `SessionService._run_with_agent(..., reasoning_effort: Optional[str] = None)`.
- Produces (new request field): `SendMessageRequest.reasoning_effort: Optional[str] = None`.

---

### Step 1: Write the failing route-level test

Create `agent/tests/test_reasoning_effort_message_validation.py`:

```python
"""POST /sessions/{id}/messages validates reasoning_effort before anything is stored.

Mirrors the real-client pattern in test_session_tool_trail.py: a real
SessionService over a tmp_path store, wired onto api_server via
_get_session_service, with validate_message_reasoning_effort monkeypatched so
this test owns only the route's responsibility (validate-before-store), not
the probe logic already covered in test_settings_api.py.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import HTTPException, status
from fastapi.testclient import TestClient

import api_server
from src.session.events import EventBus
from src.session.service import SessionService
from src.session.store import SessionStore


class _DummyIndex:
    def index_session(self, session_id: str, title: str) -> None:
        del session_id, title

    def index_message(self, session_id: str, role: str, content: str) -> None:
        del session_id, role, content


@pytest.fixture
def service(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> SessionService:
    monkeypatch.setattr("src.session.service.get_shared_index", lambda: _DummyIndex())
    svc = SessionService(
        store=SessionStore(tmp_path / "sessions"),
        event_bus=EventBus(),
        runs_dir=tmp_path / "runs",
    )
    monkeypatch.setattr(api_server, "_get_session_service", lambda: svc)
    return svc


@pytest.fixture
def client() -> TestClient:
    return TestClient(api_server.app, client=("127.0.0.1", 50000))


def test_a_refused_effort_returns_400_and_stores_nothing(
    service: SessionService, client: TestClient, monkeypatch: pytest.MonkeyPatch,
) -> None:
    session = service.create_session(title="refused")

    async def _refuse(effort: str) -> None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="gpt-6.1-sol does not support reasoning effort 'max'; supported: low, medium, high, xhigh",
        )

    monkeypatch.setattr("src.api.sessions_routes.validate_message_reasoning_effort", _refuse)

    response = client.post(
        f"/sessions/{session.session_id}/messages",
        json={"content": "analyze AAPL", "reasoning_effort": "max"},
    )

    assert response.status_code == 400
    assert "does not support" in response.json()["detail"]
    assert service.store.get_messages(session.session_id) == []
    assert service.store.get_session(session.session_id).last_attempt_id is None


def test_an_accepted_effort_reaches_send_message(
    service: SessionService, client: TestClient, monkeypatch: pytest.MonkeyPatch,
) -> None:
    session = service.create_session(title="accepted")
    seen: list[str | None] = []

    async def _accept(effort: str) -> None:
        del effort

    async def _fake_run_with_agent(self, attempt, messages=None, **kwargs):
        del self, attempt, messages
        seen.append(kwargs.get("reasoning_effort"))
        return {"status": "success", "content": "ok"}

    monkeypatch.setattr("src.api.sessions_routes.validate_message_reasoning_effort", _accept)
    monkeypatch.setattr(SessionService, "_run_with_agent", _fake_run_with_agent)

    response = client.post(
        f"/sessions/{session.session_id}/messages",
        json={"content": "analyze AAPL", "reasoning_effort": "xhigh"},
    )

    assert response.status_code == 200
    for _ in range(100):
        if seen:
            break
        import time as _time

        _time.sleep(0.01)
    assert seen == ["xhigh"]


def test_an_omitted_effort_passes_none_through(
    service: SessionService, client: TestClient, monkeypatch: pytest.MonkeyPatch,
) -> None:
    session = service.create_session(title="omitted")
    seen: list[str | None] = []
    validated: list[str] = []

    async def _accept(effort: str) -> None:
        validated.append(effort)

    async def _fake_run_with_agent(self, attempt, messages=None, **kwargs):
        del self, attempt, messages
        seen.append(kwargs.get("reasoning_effort"))
        return {"status": "success", "content": "ok"}

    monkeypatch.setattr("src.api.sessions_routes.validate_message_reasoning_effort", _accept)
    monkeypatch.setattr(SessionService, "_run_with_agent", _fake_run_with_agent)

    response = client.post(f"/sessions/{session.session_id}/messages", json={"content": "analyze AAPL"})

    assert response.status_code == 200
    for _ in range(100):
        if seen:
            break
        import time as _time

        _time.sleep(0.01)
    assert validated == [""]  # the validator always sees the normalized (possibly empty) string
    assert seen == [None]  # but send_message receives None, not ""
```

- [ ] **Step 2: Run it and watch it fail.**

Run (in `agent/`): `python -m pytest tests/test_reasoning_effort_message_validation.py -q`
Expected: `TypeError: SendMessageRequest() got an unexpected keyword argument 'reasoning_effort'` (Pydantic ignores unknown fields by default unless `model_config` forbids extras, so this specific error may instead show as the route never calling `validate_message_reasoning_effort`, surfacing as `AttributeError: <module 'src.api.sessions_routes'> does not have the attribute 'validate_message_reasoning_effort'` when the monkeypatch target is applied — either way, assertions fail because the field and the call do not exist yet).

---

### Step 3: Implement the request field and route validation

In `agent/src/api/sessions_routes.py`:

- [ ] Add the import, right after the existing `from src.session.service import SessionBusyError` line:

```python
from src.api.settings_routes import validate_message_reasoning_effort
from src.session.events import SSEEvent
from src.session.service import SessionBusyError
```

(i.e. insert the new import line before `from src.session.events import SSEEvent`, preserving that line and the one after it.)

- [ ] Add the field to `SendMessageRequest`. Replace:

```python
class SendMessageRequest(BaseModel):
    """Send an interactive research prompt."""
    content: str = Field(..., description="Research prompt", min_length=1, max_length=MAX_MESSAGE_CHARS)
```

with:

```python
class SendMessageRequest(BaseModel):
    """Send an interactive research prompt."""
    content: str = Field(..., description="Research prompt", min_length=1, max_length=MAX_MESSAGE_CHARS)
    reasoning_effort: Optional[str] = Field(
        None,
        description=(
            "Per-message reasoning effort override. Omitted or empty means the "
            "server default. Must be one of LLM_REASONING_EFFORT_ORDER and "
            "accepted by the configured model (validated before anything is "
            "stored; family-app fork, DIVERGENCE.md)."
        ),
    )
```

- [ ] Validate before calling `svc.send_message`. Replace:

```python
        _host_validate_path_param(session_id, "session_id")
        svc = _host_get_session_service()
        if not svc:
            raise HTTPException(status_code=501, detail="Session runtime not enabled")
        try:
            result = await svc.send_message(
                session_id=session_id,
                content=payload.content,
                include_shell_tools=_host_shell_tools_enabled_for_request(http_request),
            )
            return result
```

with:

```python
        _host_validate_path_param(session_id, "session_id")
        svc = _host_get_session_service()
        if not svc:
            raise HTTPException(status_code=501, detail="Session runtime not enabled")
        reasoning_effort = (payload.reasoning_effort or "").strip().lower()
        # Validated before the user message is stored or an attempt is created
        # (01p section 5.1): a level the model refuses must never reach
        # send_message, let alone a failed run later.
        await validate_message_reasoning_effort(reasoning_effort)
        try:
            result = await svc.send_message(
                session_id=session_id,
                content=payload.content,
                include_shell_tools=_host_shell_tools_enabled_for_request(http_request),
                reasoning_effort=reasoning_effort or None,
            )
            return result
```

- [ ] **Step 4: Run it, expect a new failure.**

Run: `python -m pytest tests/test_reasoning_effort_message_validation.py -q`
Expected: `TypeError: send_message() got an unexpected keyword argument 'reasoning_effort'` — `SessionService` does not accept it yet.

---

### Step 5: Thread the override through `SessionService`

In `agent/src/session/service.py`:

- [ ] Replace the `send_message` signature and its docstring `Args`:

```python
    async def send_message(
        self,
        session_id: str,
        content: str,
        role: str = "user",
        *,
        include_shell_tools: bool = False,
    ) -> Dict[str, Any]:
        """Send a message to a session and trigger execution.

        Args:
            session_id: Session ID.
            content: Message content.
            role: Message role.
            include_shell_tools: Whether this attempt may use shell tools.

        Returns:
```

with:

```python
    async def send_message(
        self,
        session_id: str,
        content: str,
        role: str = "user",
        *,
        include_shell_tools: bool = False,
        reasoning_effort: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Send a message to a session and trigger execution.

        Args:
            session_id: Session ID.
            content: Message content.
            role: Message role.
            include_shell_tools: Whether this attempt may use shell tools.
            reasoning_effort: Per-message override, already validated by the
                caller against the configured model. ``None`` means the
                server default. Not stored on ``Attempt``: the reply metadata
                already records the effective level via ``ChatLLM``.

        Returns:
```

- [ ] Pass it to `_run_attempt`. Replace:

```python
            task = asyncio.create_task(
                self._run_attempt(session, attempt, include_shell_tools=include_shell_tools)
            )
```

with:

```python
            task = asyncio.create_task(
                self._run_attempt(
                    session,
                    attempt,
                    include_shell_tools=include_shell_tools,
                    reasoning_effort=reasoning_effort,
                )
            )
```

- [ ] Replace the `_run_attempt` signature:

```python
    async def _run_attempt(self, session: Session, attempt: Attempt, *, include_shell_tools: bool = False) -> None:
```

with:

```python
    async def _run_attempt(
        self,
        session: Session,
        attempt: Attempt,
        *,
        include_shell_tools: bool = False,
        reasoning_effort: Optional[str] = None,
    ) -> None:
```

- [ ] Pass it to `_run_with_agent`. Replace:

```python
            result = await self._run_with_agent(
                attempt,
                messages=messages,
                include_shell_tools=include_shell_tools,
                session_config=dict(session.config),
            )
```

with:

```python
            result = await self._run_with_agent(
                attempt,
                messages=messages,
                include_shell_tools=include_shell_tools,
                session_config=dict(session.config),
                reasoning_effort=reasoning_effort,
            )
```

- [ ] Replace the `_run_with_agent` signature, its `Args` docstring, and the `ChatLLM()` construction:

```python
    async def _run_with_agent(
        self,
        attempt: Attempt,
        messages: list = None,
        *,
        include_shell_tools: bool = False,
        session_config: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Execute an attempt with the V5 AgentLoop.

        Args:
            attempt: Current execution attempt.
            messages: Session message history.
            include_shell_tools: Whether the registry may include shell tools.
            session_config: Optional session-level config overrides. MCP server
                definitions under the ``mcpServers`` key are merged on top of
                the user config file via ``load_runtime_agent_config`` so each
                session can extend or override the global MCP server list.

        Returns:
            Result dictionary containing status, run_dir, run_id, metrics, and related fields.
        """
        from src.tools import build_registry
        from src.providers.chat import ChatLLM
        from src.agent.loop import AgentLoop
        from src.memory.persistent import PersistentMemory
        from src.config.loader import load_runtime_agent_config, sanitize_session_overrides

        llm = ChatLLM()
        pm = PersistentMemory()
```

with:

```python
    async def _run_with_agent(
        self,
        attempt: Attempt,
        messages: list = None,
        *,
        include_shell_tools: bool = False,
        session_config: Optional[Dict[str, Any]] = None,
        reasoning_effort: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Execute an attempt with the V5 AgentLoop.

        Args:
            attempt: Current execution attempt.
            messages: Session message history.
            include_shell_tools: Whether the registry may include shell tools.
            session_config: Optional session-level config overrides. MCP server
                definitions under the ``mcpServers`` key are merged on top of
                the user config file via ``load_runtime_agent_config`` so each
                session can extend or override the global MCP server list.
            reasoning_effort: Per-message override, already validated by the
                caller. Threaded to this attempt's ``ChatLLM`` and to every
                committee worker a ``run_swarm`` tool call starts.

        Returns:
            Result dictionary containing status, run_dir, run_id, metrics, and related fields.
        """
        from src.tools import build_registry
        from src.providers.chat import ChatLLM
        from src.agent.loop import AgentLoop
        from src.memory.persistent import PersistentMemory
        from src.config.loader import load_runtime_agent_config, sanitize_session_overrides

        llm = ChatLLM(reasoning_effort=reasoning_effort)
        pm = PersistentMemory()
```

- [ ] Thread it to `build_registry` too (this parameter does not exist on `build_registry` until Task 4 — add this call now so Task 4's signature change needs no further edit here):

```python
            lambda: build_registry(
                persistent_memory=pm,
                include_shell_tools=include_shell_tools,
                agent_config=agent_config,
                session_id=session_id,
                event_callback=event_callback,
                warn_callback=_mcp_collision_warn,
            ),
```

with:

```python
            lambda: build_registry(
                persistent_memory=pm,
                include_shell_tools=include_shell_tools,
                agent_config=agent_config,
                session_id=session_id,
                event_callback=event_callback,
                warn_callback=_mcp_collision_warn,
                reasoning_effort=reasoning_effort,
            ),
```

- [ ] **Step 6: Run and expect a new, expected failure.**

Run: `python -m pytest tests/test_reasoning_effort_message_validation.py -q`
Expected: `TypeError: build_registry() got an unexpected keyword argument 'reasoning_effort'`.

---

### Step 7: Give `build_registry` the parameter

In `agent/src/tools/__init__.py`:

- [ ] Replace the `build_registry` signature:

```python
def build_registry(
    *,
    persistent_memory: "PersistentMemory | None" = None,
    include_shell_tools: bool = False,
    agent_config: "AgentConfig | None" = None,
    session_id: str | None = None,
    event_callback: Callable[[str, dict], None] | None = None,
    warn_callback: Callable[[str], None] | None = None,
    interactive: bool | None = None,
    _mcp_server_tool_name_segments: Mapping[str, str] | None = None,
) -> ToolRegistry:
```

with:

```python
def build_registry(
    *,
    persistent_memory: "PersistentMemory | None" = None,
    include_shell_tools: bool = False,
    agent_config: "AgentConfig | None" = None,
    session_id: str | None = None,
    event_callback: Callable[[str, dict], None] | None = None,
    warn_callback: Callable[[str], None] | None = None,
    interactive: bool | None = None,
    reasoning_effort: str | None = None,
    _mcp_server_tool_name_segments: Mapping[str, str] | None = None,
) -> ToolRegistry:
```

- [ ] Document the new parameter. Replace:

```python
            non-interactive run (``serve`` / swarm) skips an unauthorized live
            channel rather than blocking on a browser that cannot open
            (SPEC Transport §4). ``None`` (default) auto-detects via
            ``sys.stdin.isatty()``.

    Returns:
```

with:

```python
            non-interactive run (``serve`` / swarm) skips an unauthorized live
            channel rather than blocking on a browser that cannot open
            (SPEC Transport §4). ``None`` (default) auto-detects via
            ``sys.stdin.isatty()``.
        reasoning_effort: Per-chat override forwarded to ``SwarmTool`` so a
            ``run_swarm`` call started from this registry uses the chat's
            level for every committee worker. ``None`` (default) preserves
            the environment-configured effort.

    Returns:
```

The parameter is accepted but not yet forwarded anywhere in this task — the one caller that needs it, `SwarmTool`, does not accept it until Task 4's Step 1. Forwarding it is Task 4's first step, applied to this exact line:

```python
            elif cls is SwarmTool:
                registry.register(cls(include_shell_tools=include_shell_tools, event_callback=event_callback))
```

- [ ] **Step 8: Run it, expect PASS.**

Run: `python -m pytest tests/test_reasoning_effort_message_validation.py -q`
Expected: `3 passed` — `_run_with_agent` now calls `build_registry(reasoning_effort=...)` successfully; the registry simply does not use the value yet (Task 4 wires that next).

---

### Step 9: Fix two pre-existing test doubles that break on the new `ChatLLM` keyword

Task 4 makes `build_registry`'s real signature accept `reasoning_effort`, but two existing tests replace `ChatLLM` with a zero-argument lambda that breaks once `_run_with_agent` calls it with a keyword argument.

- [ ] In `agent/tests/test_session_tool_trail.py`, replace:

```python
    monkeypatch.setattr("src.providers.chat.ChatLLM", lambda: object())
```

with:

```python
    monkeypatch.setattr("src.providers.chat.ChatLLM", lambda **kwargs: object())
```

- [ ] In `agent/tests/test_session_service_mcp.py`, apply the identical replacement:

```python
    monkeypatch.setattr("src.providers.chat.ChatLLM", lambda: object())
```

with:

```python
    monkeypatch.setattr("src.providers.chat.ChatLLM", lambda **kwargs: object())
```

- [ ] **Step 10: Run it, expect PASS.**

Run: `python -m pytest tests/test_reasoning_effort_message_validation.py tests/test_session_tool_trail.py tests/test_session_service_mcp.py -q`
Expected: `11 passed`.

- [ ] **Step 11: Write and run the service-threading test.**

Create `agent/tests/test_reasoning_effort_service_threading.py`:

```python
"""SessionService threads a per-message reasoning_effort to ChatLLM and build_registry.

Mirrors the mocking pattern in test_session_tool_trail.py's
test_run_with_agent_consolidates_tool_events_by_call_id: a fake ChatLLM and
build_registry record their keyword arguments instead of touching real
providers or tools.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

from src.session.events import EventBus
from src.session.models import Attempt
from src.session.service import SessionService
from src.session.store import SessionStore


class _DummyIndex:
    def index_session(self, session_id: str, title: str) -> None:
        del session_id, title

    def index_message(self, session_id: str, role: str, content: str) -> None:
        del session_id, role, content


def _service(tmp_path: Path, monkeypatch) -> SessionService:
    monkeypatch.setattr("src.session.service.get_shared_index", lambda: _DummyIndex())
    return SessionService(
        store=SessionStore(tmp_path / "sessions"),
        event_bus=EventBus(),
        runs_dir=tmp_path / "runs",
    )


class _DummyAgentLoop:
    def __init__(self, *, registry, llm, event_callback, max_iterations, persistent_memory) -> None:
        del registry, llm, max_iterations, persistent_memory
        self._event_callback = event_callback

    def run(self, *, user_message: str, history, session_id: str):
        del user_message, history, session_id
        return {"status": "success", "content": "done"}

    def cancel(self) -> None:
        pass


def _wire_fakes(monkeypatch, chat_llm_calls: list, build_registry_calls: list) -> None:
    def _fake_chat_llm(**kwargs):
        chat_llm_calls.append(kwargs)
        return object()

    def _fake_build_registry(**kwargs):
        build_registry_calls.append(kwargs)
        return object()

    monkeypatch.setattr("src.tools.build_registry", _fake_build_registry)
    monkeypatch.setattr("src.providers.chat.ChatLLM", _fake_chat_llm)
    monkeypatch.setattr("src.memory.persistent.PersistentMemory", lambda: object())
    monkeypatch.setattr("src.agent.loop.AgentLoop", _DummyAgentLoop)
    monkeypatch.setattr("src.config.loader.load_runtime_agent_config", lambda overrides=None: object())
    monkeypatch.setattr("src.config.loader.sanitize_session_overrides", lambda overrides: dict(overrides))


def test_run_with_agent_passes_the_override_to_chat_llm_and_build_registry(tmp_path, monkeypatch) -> None:
    chat_llm_calls: list = []
    build_registry_calls: list = []
    _wire_fakes(monkeypatch, chat_llm_calls, build_registry_calls)
    service = _service(tmp_path, monkeypatch)
    attempt = Attempt(session_id="abcdef012345", prompt="analyze")

    asyncio.run(
        service._run_with_agent(attempt, messages=[], session_config={}, reasoning_effort="xhigh")
    )

    assert chat_llm_calls == [{"reasoning_effort": "xhigh"}]
    assert build_registry_calls[0]["reasoning_effort"] == "xhigh"


def test_run_with_agent_passes_none_when_no_override_is_given(tmp_path, monkeypatch) -> None:
    chat_llm_calls: list = []
    build_registry_calls: list = []
    _wire_fakes(monkeypatch, chat_llm_calls, build_registry_calls)
    service = _service(tmp_path, monkeypatch)
    attempt = Attempt(session_id="abcdef012346", prompt="analyze")

    asyncio.run(service._run_with_agent(attempt, messages=[], session_config={}))

    assert chat_llm_calls == [{"reasoning_effort": None}]
    assert build_registry_calls[0]["reasoning_effort"] is None


def test_send_message_threads_reasoning_effort_through_run_attempt(tmp_path, monkeypatch) -> None:
    """Two concurrent-style sends (sequential here) each see only their own
    override: send_message -> _run_attempt -> _run_with_agent never shares
    mutable state between calls (Review Focus #2)."""
    chat_llm_calls: list = []
    build_registry_calls: list = []
    _wire_fakes(monkeypatch, chat_llm_calls, build_registry_calls)
    service = _service(tmp_path, monkeypatch)
    session = service.create_session(title="concurrent-style")

    async def scenario() -> None:
        await service.send_message(session.session_id, "one", reasoning_effort="low")
        for _ in range(100):
            await asyncio.sleep(0.01)
            if session.session_id not in service._inflight:
                break
        await service.send_message(session.session_id, "two", reasoning_effort="xhigh")
        for _ in range(100):
            await asyncio.sleep(0.01)
            if session.session_id not in service._inflight:
                break

    asyncio.run(scenario())

    assert [call["reasoning_effort"] for call in chat_llm_calls] == ["low", "xhigh"]
```

Run: `python -m pytest tests/test_reasoning_effort_service_threading.py -q`
Expected: `3 passed`.

- [ ] **Step 12: Run the neighboring suites, expect PASS.**

Run: `python -m pytest tests/test_session_service_lifecycle.py tests/test_interactive_message_limit.py tests/test_settings_api.py tests/test_reasoning_effort_override.py -q`
Expected: all green (`test_session_service_lifecycle.py`'s stubs for `_run_with_agent` already accept `**kwargs`, so the new parameter is invisible to them).

---

### Step 13: Update `packages/vibe-trading/DIVERGENCE.md`

Find the row Task 2 added:

```
| `tests/test_reasoning_effort_override.py` | New. | |
```

Replace it with itself plus three new rows directly after:

```
| `tests/test_reasoning_effort_override.py` | New. | |
| `src/api/sessions_routes.py` | `SendMessageRequest.reasoning_effort`, validated by `validate_message_reasoning_effort` before `svc.send_message` is called — before the user message is stored or an attempt is created. | Owner request: effort in the chat. |
| `src/session/service.py` | `send_message`, `_run_attempt`, `_run_with_agent` carry `reasoning_effort` to `ChatLLM` and `build_registry`. Not stored on `Attempt`. | Per-message effort without touching the process-wide config; startup recovery never re-runs an interrupted attempt, so persistence buys nothing. |
| `tests/test_reasoning_effort_message_validation.py`, `test_reasoning_effort_service_threading.py` | New. `test_session_tool_trail.py`, `test_session_service_mcp.py` updated (their `ChatLLM` test doubles accept `**kwargs`). | |
```

- [ ] **Step 14: Commit.**

```
git -C ai-trading/packages/vibe-trading add agent/src/api/sessions_routes.py agent/src/session/service.py agent/src/tools/__init__.py agent/tests/test_reasoning_effort_message_validation.py agent/tests/test_reasoning_effort_service_threading.py agent/tests/test_session_tool_trail.py agent/tests/test_session_service_mcp.py DIVERGENCE.md
git -C ai-trading/packages/vibe-trading commit -m "feat(family-app): validate and thread a per-message reasoning effort through SessionService"
```
