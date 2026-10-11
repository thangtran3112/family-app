# Vibe Per-Chat Reasoning Effort: Design

**Date:** 2026-10-10 · **Lane:** open-source (Trading Hub) · **Status:** draft for owner review

Related: [01n](01n-vibe-research-quality.md) (overview), [01o](01o-vibe-answer-integrity.md) (ships in the same batch), `packages/vibe-trading/DIVERGENCE.md`. Code paths are under `packages/vibe-trading/` at fork commit `d402c2df`.

## 1. Goal

- The reasoning effort is changeable from the chat bar. The choice applies from the next message: no Settings round trip, no restart.
- Success:
  - Selecting a level sends `reasoning_effort` with the next message, and that run's message metadata reports it.
  - A level the model rejects is refused with the accepted list before anything is stored.
  - A committee run (`run_swarm`) uses the chat's level for every agent and records it in its `run.json`.
  - Two concurrent chats with different levels do not affect each other or the server default.
  - The picker lists only levels the model accepts (for `o3`, not `xhigh`).

## 2. Owner Decisions

- 2026-10-10: reasoning effort must be modifiable in the chat UI, not only in Settings. `xhigh` is the assumed minimum, so the default stays the server's `xhigh`.
- Every fork change carries its row in `packages/vibe-trading/DIVERGENCE.md` in the same commit (section 8).

## 3. Current Behaviour

- One global value, `LANGCHAIN_REASONING_EFFORT`, is read from the process-wide `get_env_config()` in three provider branches of `providers/llm.py::build_llm` (OpenAI Codex, Anthropic, and the OpenAI-compatible default).
- `SendMessageRequest` has only `content`. `session/service.py::_run_with_agent` builds `ChatLLM()` with no arguments. The chat bar `ModelRuntimeBar` shows a read-only badge; the level is changed in Settings only.
- Committee workers build `ChatLLM(model_name=agent_spec.model_name)` in `swarm/worker.py`; `SwarmRun.reasoning_effort` records the environment value.
- The Settings probe `_discover_reasoning_efforts` posts an invalid effort to `/v1/chat/completions` and parses the 400. Measured on 2026-10-10: for `gpt-6.1-sol`, `gpt-5.5` and `gpt-5` the message is model-specific ("does not support 'bogus-level' with this model. Supported values are: …"). For `o3` it is the generic form ("Invalid value … Supported values are: 'low', 'medium', 'high', and 'xhigh'") and wrong, because the Responses route the runtime uses rejects `xhigh` for `o3`. `/v1/responses` answers the generic full list (`none … max`) for every model, so it cannot name a model's levels.

## 4. Approaches

1. **Mutate the global config per request.** Rejected: `get_env_config()` is a process-wide singleton read by concurrent runs and swarm threads.
2. **A per-session setting stored on the server.** Rejected: a new endpoint and storage for state the UI already holds. Startup recovery marks interrupted attempts and never re-runs them, so persistence buys nothing.
3. **An explicit per-message parameter threaded through the call chain (chosen).** The same pattern as `include_shell_tools`; no shared state.

## 5. Design

### 5.1 API

- `SendMessageRequest.reasoning_effort: Optional[str] = None` in `api/sessions_routes.py`. Omitted or empty means the server default, which is today's behaviour. Values are stripped and lowercased and must be one of `LLM_REASONING_EFFORT_ORDER` (`none, minimal, low, medium, high, xhigh, max`).
- Validation happens before the user message is stored or an attempt is created. When the probe gave a definite, model-specific list and the level is not in it, the route returns HTTP 400 with the wording `PUT /settings/llm` already uses: `<model> does not support reasoning effort 'x'; supported: low, medium, high, xhigh` (or `<model> has no reasoning-effort setting; omit it` when the list is empty). An inconclusive probe falls back to the allow-list alone, the rule Settings already follows.
- One helper `validate_reasoning_effort(...)` next to `_discover_reasoning_efforts` in `settings_routes.py`, used by `PUT /settings/llm` and by `send_message`.

### 5.2 Backend threading

- `session/service.py`: `send_message(..., reasoning_effort=None)` passes it through `_run_attempt` to `_run_with_agent`, exactly as `include_shell_tools` travels. `_run_with_agent` builds `ChatLLM(reasoning_effort=reasoning_effort)` and calls `build_registry(..., reasoning_effort=reasoning_effort)`. It is not stored on `Attempt`: the reply metadata already records the effective level.
- `providers/chat.py`: `ChatLLM(model_name=None, reasoning_effort=None)`. `providers/llm.py`: `build_llm(*, model_name=None, callbacks=None, reasoning_effort=None)`. Its three effort reads use one helper `_effective_effort(override)`: the override when it is not `None`, else the environment value, stripped and lowercased. `LLMRuntimeSnapshot.reasoning_effort` reports the effective level, so `result["reasoning_effort"]`, the message metadata and the `attempt.*` events show it with no further change.
- Committee runs: `tools/__init__.py::build_registry(..., reasoning_effort=None)` → `SwarmTool(reasoning_effort=…)` → `SwarmRuntime.start_run(..., reasoning_effort=None)` (sets `run.reasoning_effort`, already a field) → `_execute_run` → `run_worker(..., reasoning_effort=…)` → `ChatLLM(model_name=agent_spec.model_name, reasoning_effort=…)`. Explicit arguments rather than a context variable, because workers run in threads.
- No global state is read-modified. Concurrent chats with different levels are independent by construction. Image vision and title generation keep `ChatLLM()` and the server default.

### 5.3 An honest probe (`settings_routes.py`)

- Trust a probe's list only when the error text is the model-specific form ("does not support … with this model"). The generic "Invalid value … Supported values" form is inconclusive and yields the existing fallback (`low, medium, high`, source `default`). This fixes the `o3` list.
- Add a small in-process cache (10 minutes) keyed by provider, model and base URL, holding only definite provider answers, so opening a chat and sending a message do not each call OpenAI.
- Unchanged: the probe still queries `/v1/chat/completions`, the only endpoint that names a model's levels, and `max` is not offered (01n section 7).

### 5.4 Frontend

- `lib/api.ts`: `sendMessage(sid, content, opts?: { reasoningEffort?: string })` includes `reasoning_effort` in the body only when set. The three call sites in `pages/Agent.tsx` pass the chat's current choice.
- `components/chat/ModelRuntimeBar.tsx` keeps provider and model and replaces the read-only badge with a native `<select>` (new `ReasoningEffortSelect.tsx`), the platform control, so no custom popover and no new dependency. Options come from the existing `api.listReasoningEfforts({ provider, model_name })` (the saved key is used, none is sent), preceded by "Default (Extra high)", which means no override and shows the server's level from `settings.reasoning_effort`.

| State | Control |
|---|---|
| Idle | Shows the pending choice; enabled. Tooltip: "Applies from your next message". |
| A run is streaming | Shows the run's actual level (`runtimeReasoningEffort`); disabled. |
| Probe failed, or the model has no reasoning control | The read-only badge, as today. |

- Choice state is per chat, held in the Agent page keyed by `sessionId`. Its initial value is the last assistant message's `metadata.reasoning_effort` for that session when present, else Default; a new chat starts at Default. Nothing goes into `localStorage`.
- i18n: two new keys (`agent.reasoningEffortDefault` with a `{{level}}` placeholder, `agent.reasoningEffortHint`) in all nine locale files, because the locale parity test requires it.

## 6. What Does Not Change

- Settings still sets the server default. `start-vibe.py`'s boot guard still drops a default the model rejects. The picker never writes Settings.
- Other providers keep working: the override passes through their branches and is validated against the allow-list only.
- The Responses transport, the model default and the temperature handling are untouched.

## 7. Testing and Verification

- **Backend:** request validation (omitted, valid, mixed case, not in the allow-list, rejected by the model → 400 and nothing stored); `ChatLLM(reasoning_effort=…)` and `build_llm` precedence in all three branches and in the snapshot; service threading (a fake `ChatLLM` records its argument); swarm threading end to end (a fake worker sees the level and `run.json` records it); the probe (model-specific parsed, generic ignored, cache hit and expiry, non-OpenAI fallback); concurrency (two simultaneous sends with different levels each see their own).
- **Frontend (vitest):** options come from the API; selecting sends `reasoning_effort` in the POST body and Default sends none; the initial value comes from the last assistant metadata; disabled while streaming; a probe failure keeps the badge; locale parity.
- **Live, sponsored key:** real chats at `low` and `xhigh` on `gpt-6.1-sol` and at `none` on `gpt-5.5` report the level in their message metadata and complete; a refused level returns 400 with the list; a committee run's `run.json` shows the chosen level. A probe matrix over the twelve models already probed (01n section 3.2) compares the picker's list with real acceptance on the Responses route, including `o3`, whose offered `xhigh` fails today.
- **Real browser:** the picker follows the model, a change applies to the next message, a reload restores the last level, Chinese and Arabic render, no console errors or failed requests.
- Existing suites unchanged, then `ai-trading/deploy/ci/smoke-test.sh vibe-trading`.

## 8. DIVERGENCE.md Entries

| Path | Change | Why |
|---|---|---|
| `agent/src/api/sessions_routes.py` | `SendMessageRequest.reasoning_effort`, validated before anything is stored, passed to `send_message`. | Owner request: effort in the chat. |
| `agent/src/api/settings_routes.py` | `validate_reasoning_effort()` shared by `PUT /settings/llm` and `send_message`; the probe trusts only the model-specific error form and caches definite answers for 10 minutes. | `o3` listed `xhigh`, which the Responses route rejects; one probe per chat is wasteful. |
| `agent/src/session/service.py` | `send_message`, `_run_attempt`, `_run_with_agent` carry `reasoning_effort` to `ChatLLM` and `build_registry`. | Per-message effort without touching the process-wide config. |
| `agent/src/providers/chat.py`, `agent/src/providers/llm.py` | `ChatLLM` and `build_llm` take an optional `reasoning_effort` that wins over the environment value in the three provider branches; the runtime snapshot reports the effective level. | Same. |
| `agent/src/tools/__init__.py`, `tools/swarm_tool.py`, `swarm/runtime.py`, `swarm/worker.py` | The level reaches every committee worker and `run.json`. | The committee must use the chat's level. |
| `agent/tests/test_settings_api.py`, `test_chat_llm_lifecycle.py`, `test_session_service_lifecycle.py`, `test_swarm_tool_variables.py`; new `test_reasoning_effort_override.py` | Extended and new tests for sections 5.1 to 5.3. | |
| `frontend/src/components/chat/ModelRuntimeBar.tsx`, new `ReasoningEffortSelect.tsx` | The selector replaces the read-only badge. | |
| `frontend/src/pages/Agent.tsx`, `frontend/src/lib/api.ts` | Per-chat choice; `sendMessage` options. | |
| `frontend/src/i18n/locales/*.json` (9 files) | `agent.reasoningEffortDefault`, `agent.reasoningEffortHint`. | The locale parity test. |
| `frontend/src/components/chat/__tests__/ModelRuntimeBar.test.tsx`, `lib/__tests__/api.test.ts`, new `ReasoningEffortSelect.test.tsx` | Extended and new tests. | |

Behaviours to preserve through a sync (new items 6 and 7):

6. A message may carry an optional `reasoning_effort`. It is validated against the model before anything is stored, applies to that run and its committee workers only, and never changes a server default.
7. The effort lists in Settings and in the chat contain only levels the model's own error message names (the model-specific form), with the generic form treated as inconclusive.

"Reapplying after a sync" gains `Agent.tsx`, `api.ts`, `sessions_routes.py`, `service.py` and `llm.py` to the expected-conflict list.

## 9. Rollout

Ships in Batch 1 with 01o: one fork commit set, one pull request, one deploy. No Firestore change is needed (the server default stays `xhigh`). Rollback is reverting the fork commit and moving the gitlink back.

## 10. Risks

- **Probe versus the Responses route.** The picker stays conservative because the Responses route accepts a superset (it accepts `max` for Sol). The live probe matrix in section 7 confirms it for the twelve models before the pull request.
- **Frontend churn.** `Agent.tsx` is large and upstream edits it often (the last sync did). The change is limited to prop wiring and three call sites; conflicts are expected and listed in the ledger.

## 11. Out of Scope

- **A chat model picker (sub-project 2b, a deliberate change from the first approved table, which listed it beside the effort picker).** It rides on this plumbing: `ChatLLM` already accepts `model_name`, so the per-message parameter threads exactly like `reasoning_effort`. It was split out because it needs decisions the effort picker does not: which models the chat offers (the Settings list is the provider's whole `/v1/models` catalog, and `llm_providers.json` holds no curated list); how committee agents inherit the choice (no preset pins a model today); and re-probing the effort list when the model changes, resetting a level the new model rejects. A small shape would be a `VIBE_CHAT_MODELS` allow-list defaulting to the configured model, validated server-side. Until then `gpt-5.5` is chosen in Settings.
- The `max` level, automatic effort per question type, and remembering the choice across devices.
