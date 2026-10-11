# Vibe Per-Chat Reasoning Effort Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the chat bar pick a reasoning effort per message — validated against what the configured model actually accepts, applied to that run and its committee workers, with no global state touched.

**Architecture:** An optional `reasoning_effort` travels as an explicit parameter through the same call chain `include_shell_tools` already uses — `SendMessageRequest` → `SessionService.send_message` → `_run_attempt` → `_run_with_agent` → `ChatLLM`/`build_registry` → `SwarmTool` → `SwarmRuntime.start_run` → `run_worker` → `ChatLLM` — so two concurrent chats with different levels never share mutable state. The Settings probe (`_discover_reasoning_efforts`) is tightened to trust only the model-specific OpenAI error form and gains a 10-minute cache; a new `validate_reasoning_effort` helper is shared by `PUT /settings/llm` and the new message-send validation. The frontend replaces `ModelRuntimeBar`'s read-only effort badge with a native `<select>` (`ReasoningEffortSelect`) fed by the existing `listReasoningEfforts` probe, with per-chat state held in `Agent.tsx` keyed by `sessionId`.

**Tech Stack:** Python/FastAPI (`agent/src`), React/TypeScript/Vite (`frontend/src`), pytest + vitest, native `<select>` (no new dependency).

**Spec:** [01p-vibe-effort-picker.md](01p-vibe-effort-picker.md)

## Global Constraints

- Allow-list is exactly `LLM_REASONING_EFFORT_ORDER = ("none", "minimal", "low", "medium", "high", "xhigh", "max")`; `LLM_REASONING_EFFORTS = {"", *order}`. Omitted or empty `reasoning_effort` means the server default (today's behavior) — never store or forward an empty string as if it were a real level.
- 400 wording is exact and reused verbatim from the existing `PUT /settings/llm` handler: `"{model} does not support reasoning effort {effort!r}; supported: {list}"` when the model has a non-empty accepted list, else `"{model} has no reasoning-effort setting; leave it empty"`. The generic allow-list violation uses `"Reasoning effort must be one of {order}, or empty to leave it unset"`.
- Validation happens **before** the user message is stored or an attempt is created (sessions_routes.py's route handler, before `svc.send_message(...)` is ever called).
- The probe trusts only the model-specific error form (`"... does not support '<value>' with this model. Supported values are: ..."`) or the "no reasoning control" form (`"reasoning_effort"` + `"unrecognized request argument"`/`"unsupported parameter"`). The generic `"Invalid value: ... Supported values are: ..."` form (what `o3` returns) is inconclusive and falls back to `LLM_FALLBACK_REASONING_EFFORTS = ["low", "medium", "high"]`, `source="default"`.
- A 10-minute (600s) in-process cache, keyed by `(provider, model, base_url)`, holds **only** definite (`source == "provider"`) answers. An inconclusive probe is never cached — every call re-probes until a real answer is seen.
- No global/process-wide **configuration** is read-modified per request. The 10-minute probe cache is shared process state; it stores provider capabilities, never a chat's effort. `get_env_config()` is never mutated per request; the override is an explicit parameter at every hop, exactly like `include_shell_tools`.
- `reasoning_effort` is **not** stored on `Attempt` (startup recovery never re-runs an interrupted attempt — spec 5.2). The effective level is recovered entirely from `ChatLLM.runtime_snapshot.reasoning_effort`, which `agent/run_outcome.py::build_result_dict` already copies into `result["reasoning_effort"]`, which `service.py::_run_attempt` already copies into the reply's `metadata.reasoning_effort`. No change needed in `loop.py` or `run_outcome.py`.
- Frontend: native `<select>`, no new npm dependency. Nothing is written to `localStorage`. All nine locale files (`en`, `zh-CN`, `ja`, `ko`, `ar`, `es`, `de`, `pt-BR`, `id`) get the same two new keys, `agent.reasoningEffortDefault` (with a `{{level}}` placeholder) and `agent.reasoningEffortHint`, because `src/i18n/__tests__/i18n.test.ts` enforces exact key and `{{variable}}` parity across every locale file found on disk.
- Fork rule (owner, `ai-trading/AGENTS.md` "Upstream Apps"): every commit under `ai-trading/packages/vibe-trading/` that changes behavior carries its `DIVERGENCE.md` rows in the **same commit**, committed on branch `family-app` with `git -C ai-trading/packages/vibe-trading`.
- Delivery exception (owner, 2026-10-10): this batch opens its PR from the isolated worktree's `feature/vibe-evals` branch directly to `dev`, not from busy `feature/toby`, which has unmerged Desk commits and unrelated working changes. This one-off exception avoids mixing lanes; it does not change the standing branch rule for other batches.
- Never touch `agent/backtest/`, `agent/src/tools/` business logic beyond `build_registry`/`swarm_tool.py`, or any file DIVERGENCE.md does not list — the fork stays minimal by design (DIVERGENCE.md "Changes" preamble).

## Review Focus

Five input classes the spec implies but no obvious existing test covers. Each line names the input, the behavior a reasonable person expects, and the task/test that pins it.

1. **A model with no reasoning control (probe returns `efforts: []`, `source: "provider"`) is given an effort.** Expected: `validate_reasoning_effort` refuses with the same "has no reasoning-effort setting; leave it empty" wording Settings already uses. Pinned by `test_update_llm_settings_explains_models_without_a_reasoning_setting` in Task 1's existing suite (refactored to the shared validator), plus the frontend's "falls back to badge" test in Task 5.
2. **Two concurrent sends with different levels.** Expected: each run's `ChatLLM.runtime_snapshot.reasoning_effort` reflects only its own override; no cross-talk through `get_env_config()`. Pinned by `test_two_concurrent_chats_keep_their_own_effort` in Task 2 and the service-threading test in Task 3.
3. **The reasoning-efforts probe is unreachable, returns a 5xx, or returns a generic list that is not model-specific.** Expected: `_discover_reasoning_efforts` falls back to `LLM_FALLBACK_REASONING_EFFORTS` with `source="default"` — never a 500, never cached. Pinned by `test_reasoning_efforts_fall_back_when_the_probe_is_inconclusive`, `test_reasoning_efforts_cache_never_stores_an_inconclusive_answer`, and `test_generic_supported_values_error_is_inconclusive_and_never_cached` in Task 1.
4. **A reloaded chat whose last assistant message's metadata holds a level the current model no longer accepts.** Expected: the picker shows that level only until its own probe resolves, then resets to Default — it must never silently send a value the model will reject. Pinned by `ReasoningEffortSelect`'s `test_resets_a_level_the_current_model_no_longer_accepts_instead_of_sending_it` in Task 5.
5. **The user changes the model in Settings while a chat is open, or the probe has not completed.** Expected: the picker re-fetches and re-renders options for the new model; it does not keep showing the old model's list, and the native control stays disabled until its new list arrives. Pinned by `test_re_fetches_when_the_model_changes` and `test_stays_disabled_while_the_models_accepted_levels_are_still_loading` in Task 5.

Two more worth a line even though they are mostly "nothing special happens" (fold their assertions into the task that already covers the mechanism, no separate test needed beyond what's listed): effort sent with different letter case/whitespace (`"  XHIGH  "`) is normalized by `.strip().lower()` both server-side (`validate_reasoning_effort`'s caller) and the allow-list check (`LLM_REASONING_EFFORTS` membership is checked only after normalization) — pinned by the existing `_effective_effort` test in Task 2 (`"XHIGH"` → `"xhigh"`); an empty string is always accepted regardless of model (`validate_reasoning_effort` returns early on `not effort`) — pinned in Task 1.

All paths below are relative to `ai-trading/packages/vibe-trading/` unless they start with `ai-trading/`.

## File Map

| File | Change | Task |
|---|---|---|
| `agent/src/api/settings_routes.py` | `_ReasoningEffortsCache` (600s TTL), cache wired into `_discover_reasoning_efforts`, new `validate_reasoning_effort()` and `validate_message_reasoning_effort()`, `PUT /settings/llm` refactored to call the shared helper | 1 |
| `agent/tests/test_settings_api.py` | Cache-clearing autouse fixture; new cache tests; new `validate_reasoning_effort`/`validate_message_reasoning_effort` tests | 1 |
| `agent/src/providers/llm.py` | New `_effective_effort(override)`; `build_llm(..., reasoning_effort=None)`; the three provider branches (openai-codex, anthropic, openai-compatible) use the helper | 2 |
| `agent/src/providers/chat.py` | `ChatLLM(model_name=None, reasoning_effort=None)`; `runtime_snapshot.reasoning_effort` reports the effective level | 2 |
| `agent/tests/test_reasoning_effort_override.py` | New: `_effective_effort`, the three `build_llm` branches, `ChatLLM.runtime_snapshot` | 2 |
| `agent/src/api/sessions_routes.py` | `SendMessageRequest.reasoning_effort`; route validates before `svc.send_message` | 3 |
| `agent/src/session/service.py` | `send_message`, `_run_attempt`, `_run_with_agent` carry `reasoning_effort` to `ChatLLM` and `build_registry` | 3 |
| `agent/tests/test_session_tool_trail.py`, `test_session_service_mcp.py` | `ChatLLM` test doubles accept `**kwargs` (pre-existing fakes broke on the new keyword) | 3 |
| `agent/tests/test_session_service_lifecycle.py` | Unaffected in behavior (stubs `_run_with_agent` directly with `**kwargs`); verified green, no edit needed | 3 |
| `agent/src/tools/__init__.py` | `build_registry(..., reasoning_effort=None)` forwarded to `SwarmTool(...)` | 4 |
| `agent/src/tools/swarm_tool.py` | `SwarmTool(..., reasoning_effort=None)` forwarded to `runtime.start_run(...)` | 4 |
| `agent/src/swarm/runtime.py` | `start_run`, `_execute_run`, `_execute_layer`, `_run_worker_with_retries` thread `reasoning_effort`; `run.reasoning_effort` uses the override when given | 4 |
| `agent/src/swarm/worker.py` | `run_worker(..., reasoning_effort=None)` → `ChatLLM(model_name=..., reasoning_effort=...)` | 4 |
| `agent/tests/test_swarm_status_hydration.py`, `test_swarm_m4_e2e.py`, `test_swarm_m5_trust_model.py` | Pre-existing `FakeRuntime.start_run` / `_stub_llm_factory` test doubles accept the new keyword | 4 |
| `agent/tests/test_ibkr_local.py` | Test-only: initialize the fake broker's `threading.local` attributes even when xdist runs the test first; required for the combined SP1+SP2 `-n 8` gate | 4 |
| `frontend/src/lib/api.ts` | `sendMessage(sid, content, opts?: { reasoningEffort?: string })` | 5 |
| `frontend/src/lib/__tests__/api.test.ts` | New: body omits/includes `reasoning_effort` | 5 |
| `frontend/src/components/chat/ReasoningEffortSelect.tsx` | New: the `<select>`, badge fallback, re-probe-and-reset logic | 5 |
| `frontend/src/components/chat/__tests__/ReasoningEffortSelect.test.tsx` | New | 5 |
| `frontend/src/components/chat/ModelRuntimeBar.tsx` | Replaces the always-badge with `ReasoningEffortSelect` when a change handler is given; badge kept as the no-handler fallback | 5 |
| `frontend/src/components/chat/__tests__/ModelRuntimeBar.test.tsx` | Extended: selector rendering, disabled-while-streaming | 5 |
| `frontend/src/i18n/locales/*.json` (9 files) | `agent.reasoningEffortDefault`, `agent.reasoningEffortHint` | 5 |
| `frontend/src/pages/Agent.tsx` | Per-chat `reasoningEffortChoices` map keyed by session id; an unsent choice survives switching away and back; three `api.sendMessage` call sites pass it; `ModelRuntimeBar` wired to it | 6 |
| `frontend/src/pages/__tests__/AgentGroundingStatus.test.tsx`, `AgentBackgroundStreamCompletion.test.tsx` | Add `listReasoningEfforts` to their `apiMock` (ModelRuntimeBar now calls it) | 6 |
| `frontend/src/pages/__tests__/AgentReasoningEffortChoice.test.tsx` | New | 6 |
| `packages/vibe-trading/DIVERGENCE.md` | New rows, "Behaviours to preserve" items 6–7, expected-conflict additions, Verification section | 1–6, 8 |

## Task Index

1. [task-01-honest-probe-cache.md](01p-vibe-effort-picker-tasks/task-01-honest-probe-cache.md) — `validate_reasoning_effort` helper + 10-minute probe cache
2. [task-02-build-llm-override.md](01p-vibe-effort-picker-tasks/task-02-build-llm-override.md) — `build_llm`/`ChatLLM` per-call override
3. [task-03-request-validation-service-threading.md](01p-vibe-effort-picker-tasks/task-03-request-validation-service-threading.md) — request field, 400-before-storage, service threading
4. [task-04-swarm-threading.md](01p-vibe-effort-picker-tasks/task-04-swarm-threading.md) — committee threading through `SwarmTool`/`SwarmRuntime`/`run_worker`
5. [task-05-frontend-selector.md](01p-vibe-effort-picker-tasks/task-05-frontend-selector.md) — `ReasoningEffortSelect`, `ModelRuntimeBar`, `api.ts`, i18n
6. [task-06-agent-wiring.md](01p-vibe-effort-picker-tasks/task-06-agent-wiring.md) — `Agent.tsx` per-chat state and the three send call sites
7. [task-07-live-verification.md](01p-vibe-effort-picker-tasks/task-07-live-verification.md) — live probe matrix, real chats, browser walkthrough, DIVERGENCE.md Verification section
8. [task-08-ship.md](01p-vibe-effort-picker-tasks/task-08-ship.md) — Batch 1 ship (shared with sub-project 1): full suites, image build, PR, release, deploy
