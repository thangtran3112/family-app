# Task 4: Committee threading through `SwarmTool` → `SwarmRuntime` → `run_worker`

Part of [01p-vibe-effort-picker-plan.md](../01p-vibe-effort-picker-plan.md). Read its Global Constraints and Review Focus first. Builds on [Task 3](task-03-request-validation-service-threading.md), which already landed `build_registry(..., reasoning_effort=None)` forwarding nothing further.

**Goal:** A `run_swarm` tool call started from a chat with a per-message `reasoning_effort` must use that level for every committee worker and record it in `run.json`, exactly matching the spec's success criterion: "A committee run (`run_swarm`) uses the chat's level for every agent and records it in its `run.json`."

All paths below are relative to `ai-trading/packages/vibe-trading/` unless noted.

**Files:**
- Modify: `agent/src/tools/__init__.py`, `agent/src/tools/swarm_tool.py`, `agent/src/swarm/runtime.py`, `agent/src/swarm/worker.py`
- Create/Test: `agent/tests/test_reasoning_effort_swarm_threading.py`
- Modify/Test: `agent/tests/test_swarm_status_hydration.py`, `agent/tests/test_swarm_m4_e2e.py`, `agent/tests/test_swarm_m5_trust_model.py`
- Modify: `DIVERGENCE.md` (backend rows in the same commit)

## Interfaces

- Consumes: `build_registry(..., reasoning_effort=None)` (Task 3, already calls `SwarmTool(...)` without forwarding it yet).
- Produces: `SwarmTool(include_shell_tools=False, event_callback=None, reasoning_effort=None)`; `SwarmRuntime.start_run(preset_name, user_vars, live_callback=None, include_shell_tools=False, resume_from=None, reasoning_effort=None)`; `run_worker(..., reasoning_effort=None)` (`src/swarm/worker.py`) → `ChatLLM(model_name=agent_spec.model_name, reasoning_effort=...)`.

---

### Step 1: Write the failing tests

Create `agent/tests/test_reasoning_effort_swarm_threading.py`:

```python
"""A chat's reasoning effort reaches every committee worker and run.json.

Mirrors test_swarm_run_metadata.py's pattern (stub _execute_run, start_run
synchronously captures run.* before the background thread would run) for the
run-level assertion, and directly exercises _execute_run with a stubbed
run_worker for the end-to-end worker-level assertion (01p section 7:
"swarm threading end to end -- a fake worker sees the level and run.json
records it").
"""

from __future__ import annotations

import threading

import pytest

import src.providers.llm as llm_mod
from src.config.accessor import reset_env_config
from src.swarm.presets import build_run_from_preset
from src.swarm.runtime import SwarmRuntime
from src.swarm.store import SwarmStore


@pytest.fixture(autouse=True)
def _pin_env(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    env_file = tmp_path / ".env"
    env_file.write_text("LANGCHAIN_MODEL_NAME=smoke-model\n", encoding="utf-8")
    monkeypatch.setenv("LANGCHAIN_PROVIDER", "openai")
    monkeypatch.setenv("LANGCHAIN_REASONING_EFFORT", "low")
    monkeypatch.setattr(llm_mod, "_ENV_CANDIDATES", [env_file])
    monkeypatch.setattr(llm_mod, "_dotenv_loaded", False)
    reset_env_config()


def test_run_reasoning_effort_uses_the_override_when_given(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    monkeypatch.setattr(SwarmRuntime, "_execute_run", lambda *_: None)
    store = SwarmStore(tmp_path / "runs")
    runtime = SwarmRuntime(store=store)

    run = runtime.start_run("risk_committee", {"goal": "smoke test"}, reasoning_effort="xhigh")

    assert run.reasoning_effort == "xhigh"
    assert store.load_run(run.id).reasoning_effort == "xhigh"


def test_run_reasoning_effort_falls_back_to_the_environment_when_no_override_is_given(
    monkeypatch: pytest.MonkeyPatch, tmp_path,
) -> None:
    monkeypatch.setattr(SwarmRuntime, "_execute_run", lambda *_: None)
    store = SwarmStore(tmp_path / "runs")
    runtime = SwarmRuntime(store=store)

    run = runtime.start_run("risk_committee", {"goal": "smoke test"})

    assert run.reasoning_effort == "low"


def test_execute_run_passes_the_override_to_every_worker(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    store = SwarmStore(tmp_path / "runs")
    runtime = SwarmRuntime(store=store)
    run = build_run_from_preset("risk_committee", {"goal": "smoke test"})
    run.reasoning_effort = "xhigh"
    store.create_run(run)

    seen_efforts: list[str | None] = []

    def _fake_run_worker(**kwargs):
        seen_efforts.append(kwargs.get("reasoning_effort"))
        from src.swarm.models import WorkerResult

        return WorkerResult(status="completed", summary="ok", input_tokens=0, output_tokens=0)

    monkeypatch.setattr("src.swarm.runtime.run_worker", _fake_run_worker)

    runtime._execute_run(run, threading.Event(), False, None, "xhigh")

    assert seen_efforts, "no worker ran"
    assert set(seen_efforts) == {"xhigh"}
    persisted = store.load_run(run.id)
    assert persisted.reasoning_effort == "xhigh"
    assert persisted.status.value == "completed"
```

- [ ] **Step 2: Run it and watch it fail.**

Run (in `agent/`): `python -m pytest tests/test_reasoning_effort_swarm_threading.py -q`
Expected: `TypeError: start_run() got an unexpected keyword argument 'reasoning_effort'`.

---

### Step 3: Thread it through `SwarmTool`

In `agent/src/tools/swarm_tool.py`, replace `SwarmTool.__init__`:

```python
    def __init__(
        self,
        *,
        include_shell_tools: bool = False,
        event_callback: Any | None = None,
    ) -> None:
        """Initialize the swarm launcher.

        Args:
            include_shell_tools: Whether worker registries may include shell
                execution tools requested by presets.
            event_callback: Optional session event bridge used by the web chat.
        """
        self.include_shell_tools = include_shell_tools
        self._event_callback = event_callback
```

with:

```python
    def __init__(
        self,
        *,
        include_shell_tools: bool = False,
        event_callback: Any | None = None,
        reasoning_effort: str | None = None,
    ) -> None:
        """Initialize the swarm launcher.

        Args:
            include_shell_tools: Whether worker registries may include shell
                execution tools requested by presets.
            event_callback: Optional session event bridge used by the web chat.
            reasoning_effort: Per-chat override; every committee worker this
                tool starts uses it instead of the environment-configured
                effort. ``None`` (default) preserves that behavior.
        """
        self.include_shell_tools = include_shell_tools
        self._event_callback = event_callback
        self.reasoning_effort = reasoning_effort
```

- [ ] Forward it in `execute`'s `runtime.start_run(...)` call. Replace:

```python
            run = runtime.start_run(
                preset,
                variables,
                live_callback=_live_callback if self._event_callback is not None else None,
                include_shell_tools=self.include_shell_tools,
            )
```

with:

```python
            run = runtime.start_run(
                preset,
                variables,
                live_callback=_live_callback if self._event_callback is not None else None,
                include_shell_tools=self.include_shell_tools,
                reasoning_effort=self.reasoning_effort,
            )
```

- [ ] Finally forward it from `build_registry` (Task 3 left this call unchanged — this is the one edit that connects the two tasks). In `agent/src/tools/__init__.py`, replace:

```python
            elif cls is SwarmTool:
                registry.register(cls(include_shell_tools=include_shell_tools, event_callback=event_callback))
```

with:

```python
            elif cls is SwarmTool:
                registry.register(
                    cls(
                        include_shell_tools=include_shell_tools,
                        event_callback=event_callback,
                        reasoning_effort=reasoning_effort,
                    )
                )
```

- [ ] **Step 4: Run it, expect a new failure.**

Run: `python -m pytest tests/test_reasoning_effort_swarm_threading.py -q`
Expected: `TypeError: start_run() got an unexpected keyword argument 'reasoning_effort'` persists (not yet on `SwarmRuntime`) — continue.

---

### Step 5: Thread it through `SwarmRuntime`

In `agent/src/swarm/runtime.py`:

- [ ] Replace the `start_run` signature and its docstring `Args`:

```python
    def start_run(
        self,
        preset_name: str,
        user_vars: dict[str, str],
        live_callback: Callable | None = None,
        include_shell_tools: bool = False,
        resume_from: SwarmRun | None = None,
    ) -> SwarmRun:
        """Start a swarm run. Returns immediately, execution happens in background.

        Args:
            preset_name: YAML preset name to execute.
            user_vars: User-provided variables for prompt templates.
            live_callback: Optional callback invoked for each event in real-time.
            include_shell_tools: Whether workers may register shell tools.
            resume_from: Optional prior ``failed`` / ``cancelled`` run to resume.
                Its completed tasks (and their artifacts) are carried into the
                new run as-is; every other task re-executes. ``None`` (default)
                starts a fully fresh run.
```

with:

```python
    def start_run(
        self,
        preset_name: str,
        user_vars: dict[str, str],
        live_callback: Callable | None = None,
        include_shell_tools: bool = False,
        resume_from: SwarmRun | None = None,
        reasoning_effort: str | None = None,
    ) -> SwarmRun:
        """Start a swarm run. Returns immediately, execution happens in background.

        Args:
            preset_name: YAML preset name to execute.
            user_vars: User-provided variables for prompt templates.
            live_callback: Optional callback invoked for each event in real-time.
            include_shell_tools: Whether workers may register shell tools.
            resume_from: Optional prior ``failed`` / ``cancelled`` run to resume.
                Its completed tasks (and their artifacts) are carried into the
                new run as-is; every other task re-executes. ``None`` (default)
                starts a fully fresh run.
            reasoning_effort: Per-chat override; every worker this run starts
                uses it instead of the environment-configured effort. ``None``
                (default) preserves that behavior.
```

- [ ] `run.reasoning_effort` must use the override when given. Replace:

```python
        run.provider = public_provider_metadata(_cfg.llm.langchain_provider.lower())
        run.model = public_model_metadata(_cfg.llm.langchain_model_name)
        run.reasoning_effort = public_reasoning_effort(_cfg.llm.langchain_reasoning_effort)
        run.use_responses_api = uses_responses_api(
```

with:

```python
        run.provider = public_provider_metadata(_cfg.llm.langchain_provider.lower())
        run.model = public_model_metadata(_cfg.llm.langchain_model_name)
        run.reasoning_effort = public_reasoning_effort(
            reasoning_effort if reasoning_effort is not None else _cfg.llm.langchain_reasoning_effort
        )
        run.use_responses_api = uses_responses_api(
```

- [ ] Pass it to the background thread. Replace:

```python
        thread = threading.Thread(
            target=self._execute_run,
            args=(run, cancel_event, include_shell_tools, resume_from),
            name=f"swarm-{run.id}",
            daemon=True,
        )
```

with:

```python
        thread = threading.Thread(
            target=self._execute_run,
            args=(run, cancel_event, include_shell_tools, resume_from, reasoning_effort),
            name=f"swarm-{run.id}",
            daemon=True,
        )
```

- [ ] **Step 6: Run it, expect PASS for the first two tests.**

Run: `python -m pytest tests/test_reasoning_effort_swarm_threading.py -q`
Expected: `test_run_reasoning_effort_uses_the_override_when_given` and `..._falls_back_to_the_environment_when_no_override_is_given` pass; `test_execute_run_passes_the_override_to_every_worker` fails with `TypeError: _execute_run() takes from 3 to 5 positional arguments but 6 were given`.

---

### Step 7: Thread it through `_execute_run`, `_execute_layer`, `_run_worker_with_retries`

Still in `agent/src/swarm/runtime.py`:

- [ ] Replace the `_execute_run` signature and docstring `Args`:

```python
    def _execute_run(
        self,
        run: SwarmRun,
        cancel_event: threading.Event,
        include_shell_tools: bool = False,
        resume_from: SwarmRun | None = None,
    ) -> None:
        """Core orchestration loop (runs in background thread).

        Steps:
            1. Update run status to running
            2. Initialize TaskStore, save all tasks
            3. Compute topological layers
            4. For each layer:
               a. Check cancellation
               b. Submit all tasks to ThreadPoolExecutor
               c. Collect results, resolve dependencies, update store
            5. Update run status to completed/failed

        Args:
            run: SwarmRun to execute.
            cancel_event: Threading event for cancellation signalling.
            include_shell_tools: Whether workers may register shell tools.
            resume_from: Optional prior run whose completed tasks are kept
                (see :meth:`_apply_resume_overlay`). ``None`` executes fresh.
        """
```

with:

```python
    def _execute_run(
        self,
        run: SwarmRun,
        cancel_event: threading.Event,
        include_shell_tools: bool = False,
        resume_from: SwarmRun | None = None,
        reasoning_effort: str | None = None,
    ) -> None:
        """Core orchestration loop (runs in background thread).

        Steps:
            1. Update run status to running
            2. Initialize TaskStore, save all tasks
            3. Compute topological layers
            4. For each layer:
               a. Check cancellation
               b. Submit all tasks to ThreadPoolExecutor
               c. Collect results, resolve dependencies, update store
            5. Update run status to completed/failed

        Args:
            run: SwarmRun to execute.
            cancel_event: Threading event for cancellation signalling.
            include_shell_tools: Whether workers may register shell tools.
            resume_from: Optional prior run whose completed tasks are kept
                (see :meth:`_apply_resume_overlay`). ``None`` executes fresh.
            reasoning_effort: Per-chat override forwarded to every worker.
        """
```

- [ ] Pass it to `_execute_layer`. Replace:

```python
                layer_results = self._execute_layer(
                    run=run,
                    task_store=task_store,
                    agent_map=agent_map,
                    layer_task_ids=layer_task_ids,
                    task_summaries=task_summaries,
                    run_dir=run_dir,
                    cancel_event=cancel_event,
                    include_shell_tools=include_shell_tools,
                    grounding_block=grounding_block,
                )
```

with:

```python
                layer_results = self._execute_layer(
                    run=run,
                    task_store=task_store,
                    agent_map=agent_map,
                    layer_task_ids=layer_task_ids,
                    task_summaries=task_summaries,
                    run_dir=run_dir,
                    cancel_event=cancel_event,
                    include_shell_tools=include_shell_tools,
                    grounding_block=grounding_block,
                    reasoning_effort=reasoning_effort,
                )
```

- [ ] Replace the `_execute_layer` signature and docstring `Args`:

```python
        cancel_event: threading.Event,
        include_shell_tools: bool = False,
        grounding_block: str = "",
    ) -> dict[str, WorkerResult]:
        """Execute all tasks in a single layer in parallel, with retry on failure.

        Each task is retried up to agent_spec.max_retries times if the worker
        returns status="failed". A "task_retry" event is emitted before each retry.

        Args:
            run: The SwarmRun being executed.
            task_store: TaskStore for task persistence.
            agent_map: Agent specs keyed by agent_id.
            layer_task_ids: Task IDs in this layer.
            task_summaries: Accumulated task summaries from previous layers.
            run_dir: Run directory path.
            cancel_event: Cancellation event.
            include_shell_tools: Whether workers may register shell tools.
            grounding_block: Pre-rendered "Ground Truth" markdown for workers.

        Returns:
            Mapping of task_id -> WorkerResult for all tasks in this layer.
        """
```

with:

```python
        cancel_event: threading.Event,
        include_shell_tools: bool = False,
        grounding_block: str = "",
        reasoning_effort: str | None = None,
    ) -> dict[str, WorkerResult]:
        """Execute all tasks in a single layer in parallel, with retry on failure.

        Each task is retried up to agent_spec.max_retries times if the worker
        returns status="failed". A "task_retry" event is emitted before each retry.

        Args:
            run: The SwarmRun being executed.
            task_store: TaskStore for task persistence.
            agent_map: Agent specs keyed by agent_id.
            layer_task_ids: Task IDs in this layer.
            task_summaries: Accumulated task summaries from previous layers.
            run_dir: Run directory path.
            cancel_event: Cancellation event.
            include_shell_tools: Whether workers may register shell tools.
            grounding_block: Pre-rendered "Ground Truth" markdown for workers.
            reasoning_effort: Per-chat override forwarded to every worker.

        Returns:
            Mapping of task_id -> WorkerResult for all tasks in this layer.
        """
```

- [ ] Pass it to `_run_worker_with_retries`. Replace:

```python
                future = executor.submit(
                    self._run_worker_with_retries,
                    agent_spec=agent_spec,
                    task=task,
                    upstream_summaries=upstream,
                    user_vars=run.user_vars,
                    run_dir=run_dir,
                    event_callback=_event_callback,
                    run_id=run.id,
                    include_shell_tools=include_shell_tools,
                    grounding_block=grounding_block,
                    cancel_event=cancel_event,
                )
```

with:

```python
                future = executor.submit(
                    self._run_worker_with_retries,
                    agent_spec=agent_spec,
                    task=task,
                    upstream_summaries=upstream,
                    user_vars=run.user_vars,
                    run_dir=run_dir,
                    event_callback=_event_callback,
                    run_id=run.id,
                    include_shell_tools=include_shell_tools,
                    grounding_block=grounding_block,
                    cancel_event=cancel_event,
                    reasoning_effort=reasoning_effort,
                )
```

- [ ] Replace the `_run_worker_with_retries` signature and add the `Args` line (right after the `cancel_event` doc entry):

```python
        run_id: str,
        include_shell_tools: bool = False,
        grounding_block: str = "",
        cancel_event: threading.Event | None = None,
    ) -> WorkerResult:
        """Run a worker with automatic retry on failure.
```

with:

```python
        run_id: str,
        include_shell_tools: bool = False,
        grounding_block: str = "",
        cancel_event: threading.Event | None = None,
        reasoning_effort: str | None = None,
    ) -> WorkerResult:
        """Run a worker with automatic retry on failure.
```

- [ ] Add the docstring line for the new parameter. Replace:

```python
                an already-dispatched worker. A "cancelled" result is never
                retried (see the status check below).

        Returns:
```

with:

```python
                an already-dispatched worker. A "cancelled" result is never
                retried (see the status check below).
            reasoning_effort: Per-chat override forwarded to ``run_worker()``.

        Returns:
```

- [ ] Pass it to `run_worker`. Replace:

```python
            result = run_worker(
                agent_spec=agent_spec,
                task=task,
                upstream_summaries=upstream_summaries,
                user_vars=user_vars,
                run_dir=run_dir,
                event_callback=event_callback,
                include_shell_tools=include_shell_tools,
                grounding_block=grounding_block,
                agent_config=self._agent_config,
                cancel_event=cancel_event,
            )
```

with:

```python
            result = run_worker(
                agent_spec=agent_spec,
                task=task,
                upstream_summaries=upstream_summaries,
                user_vars=user_vars,
                run_dir=run_dir,
                event_callback=event_callback,
                include_shell_tools=include_shell_tools,
                grounding_block=grounding_block,
                agent_config=self._agent_config,
                cancel_event=cancel_event,
                reasoning_effort=reasoning_effort,
            )
```

- [ ] **Step 8: Run it, expect a new failure.**

Run: `python -m pytest tests/test_reasoning_effort_swarm_threading.py -q`
Expected: `TypeError: run_worker() got an unexpected keyword argument 'reasoning_effort'`.

---

### Step 9: Thread it through `run_worker`

In `agent/src/swarm/worker.py`, replace `run_worker`'s signature:

```python
def run_worker(
    agent_spec: SwarmAgentSpec,
    task: SwarmTask,
    upstream_summaries: dict[str, str],
    user_vars: dict[str, str],
    run_dir: Path,
    event_callback: Callable[[SwarmEvent], None] | None = None,
    include_shell_tools: bool = False,
    grounding_block: str = "",
    agent_config: AgentConfig | None = None,
    cancel_event: threading.Event | None = None,
) -> WorkerResult:
    """Run one worker task, releasing the per-task LLM client on exit.
```

with:

```python
def run_worker(
    agent_spec: SwarmAgentSpec,
    task: SwarmTask,
    upstream_summaries: dict[str, str],
    user_vars: dict[str, str],
    run_dir: Path,
    event_callback: Callable[[SwarmEvent], None] | None = None,
    include_shell_tools: bool = False,
    grounding_block: str = "",
    agent_config: AgentConfig | None = None,
    cancel_event: threading.Event | None = None,
    reasoning_effort: str | None = None,
) -> WorkerResult:
    """Run one worker task, releasing the per-task LLM client on exit.
```

- [ ] Add the docstring line and thread it to `ChatLLM`. Replace:

```python
            and that turn's tool calls are skipped; a tool call already
            executing is not interrupted.

    Returns:
        WorkerResult with status, summary, artifacts, and iteration count.
    """
    llm = ChatLLM(model_name=agent_spec.model_name)
```

with:

```python
            and that turn's tool calls are skipped; a tool call already
            executing is not interrupted.
        reasoning_effort: Per-chat override; wins over the environment's
            configured effort. ``None`` (default) preserves that behavior.

    Returns:
        WorkerResult with status, summary, artifacts, and iteration count.
    """
    llm = ChatLLM(model_name=agent_spec.model_name, reasoning_effort=reasoning_effort)
```

- [ ] **Step 10: Run it, expect PASS.**

Run: `python -m pytest tests/test_reasoning_effort_swarm_threading.py -q`
Expected: `3 passed`.

---

### Step 11: Fix pre-existing test doubles with a strict `start_run`/`ChatLLM` signature

Three existing tests define fakes with a fixed parameter list that breaks once the real call sites pass `reasoning_effort`.

- [ ] In `agent/tests/test_swarm_status_hydration.py`, there are two occurrences of the same line (one per test, `test_swarm_tool_forwards_started_and_live_events` and `test_swarm_tool_without_session_callback_preserves_plain_runtime`). Replace **both** occurrences of:

```python
        def start_run(self, preset, variables, live_callback=None, include_shell_tools=False):
```

with:

```python
        def start_run(self, preset, variables, live_callback=None, include_shell_tools=False, reasoning_effort=None):
```

- [ ] In `agent/tests/test_swarm_m4_e2e.py`, inside `_stub_llm_factory`, replace:

```python
    def _factory(model_name=None):
        return stub
```

with:

```python
    def _factory(model_name=None, reasoning_effort=None):
        return stub
```

- [ ] In `agent/tests/test_swarm_m5_trust_model.py`, inside `_stub_llm_factory`, apply the identical replacement:

```python
    def _factory(model_name=None):
        return stub
```

with:

```python
    def _factory(model_name=None, reasoning_effort=None):
        return stub
```

- [ ] **Step 12: Run the full swarm suite, expect PASS.**

Run: `python -m pytest tests/test_swarm_*.py tests/test_cli_swarm_*.py -q -n 4`
Expected: `400 passed`.

- [ ] **Step 13: Run the full backend suite; require green before continuing.** The pre-existing `test_ibkr_local.py` xdist order dependency has already been fixed test-only on `family-app` in preflight commit `f9b8c2e` (with its own DIVERGENCE.md row). Do **not** repeat that change or stage its file in this task.

```sh
python -m pytest tests -q -n 8
```

Expected: zero failures. The old combined scratch tree had 17,531 passed / 77 skipped before Task 9 changed to no Jina; use the actual current result, not that stale count. If a test fails, investigate and require a full green rerun.

---

### Step 14: Update `packages/vibe-trading/DIVERGENCE.md`

Find the row Task 3 added:

```
| `tests/test_reasoning_effort_message_validation.py`, `test_reasoning_effort_service_threading.py` | New. `test_session_tool_trail.py`, `test_session_service_mcp.py` updated (their `ChatLLM` test doubles accept `**kwargs`). | |
```

Replace it with itself plus two new rows directly after:

```
| `tests/test_reasoning_effort_message_validation.py`, `test_reasoning_effort_service_threading.py` | New. `test_session_tool_trail.py`, `test_session_service_mcp.py` updated (their `ChatLLM` test doubles accept `**kwargs`). | |
| `src/tools/__init__.py`, `src/tools/swarm_tool.py`, `src/swarm/runtime.py`, `src/swarm/worker.py` | `reasoning_effort` threads from `build_registry` through `SwarmTool`, `SwarmRuntime.start_run`/`_execute_run`/`_execute_layer`/`_run_worker_with_retries`, to `run_worker`'s `ChatLLM`. `run.reasoning_effort` uses the override when given, else the environment value. | The committee must use the chat's level for every agent and record it in `run.json`. |
| `tests/test_reasoning_effort_swarm_threading.py` | New. `test_swarm_status_hydration.py`, `test_swarm_m4_e2e.py`, `test_swarm_m5_trust_model.py` updated (their `start_run`/`ChatLLM` test doubles accept the new keyword). | |
```

- [ ] **Step 15: Commit.**

```
git -C ai-trading/packages/vibe-trading add agent/src/tools/swarm_tool.py agent/src/tools/__init__.py agent/src/swarm/runtime.py agent/src/swarm/worker.py agent/tests/test_reasoning_effort_swarm_threading.py agent/tests/test_swarm_status_hydration.py agent/tests/test_swarm_m4_e2e.py agent/tests/test_swarm_m5_trust_model.py DIVERGENCE.md
git -C ai-trading/packages/vibe-trading commit -m "feat(family-app): thread the chat's reasoning effort to every committee worker"
```

This closes the backend half of the plan. Tasks 5–6 are frontend-only; Task 7 is live verification; Task 8 ships the batch.
