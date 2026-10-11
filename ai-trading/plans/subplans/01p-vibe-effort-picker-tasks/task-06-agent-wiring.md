# Task 6: `Agent.tsx` per-chat state and the three send call sites

Part of [01p-vibe-effort-picker-plan.md](../01p-vibe-effort-picker-plan.md). Read its Global Constraints and Review Focus first. Builds on [Task 5](task-05-frontend-selector.md) (`ModelRuntimeBar`'s new props, `api.sendMessage`'s third argument).

**Goal:** Hold the chat bar's pending reasoning-effort choice per session id, initialize it from the last assistant message's `metadata.reasoning_effort` (Default otherwise), pass it on all three `api.sendMessage` call sites, disable the picker while streaming, and wire `ModelRuntimeBar`.

All paths are relative to `ai-trading/packages/vibe-trading/frontend/` unless noted.

**Files:**
- Modify: `src/pages/Agent.tsx`
- Create/Test: `src/pages/__tests__/AgentReasoningEffortChoice.test.tsx`
- Modify/Test: `src/pages/__tests__/AgentGroundingStatus.test.tsx`, `src/pages/__tests__/AgentBackgroundStreamCompletion.test.tsx`
- Modify: `../DIVERGENCE.md` (frontend row in the same commit)

## Interfaces

- Consumes: `api.sendMessage(sid, content, opts?: { reasoningEffort? })` (Task 5); `<ModelRuntimeBar ... reasoningEffortValue? onReasoningEffortChange? reasoningEffortDisabled? />` (Task 5).
- Produces: nothing new is exported — this task only wires `src/pages/Agent.tsx`'s internal state.

---

### Step 1: Write the failing Agent-level tests

Create `src/pages/__tests__/AgentReasoningEffortChoice.test.tsx`:

```tsx
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { Agent } from "../Agent";
import { useAgentStore } from "@/stores/agent";

// Per-chat reasoning-effort picker: initial value from the last assistant
// message's metadata, Default for a new chat, and disabled while streaming
// (01p section 5.4).

const apiMock = vi.hoisted(() => ({
  getGoal: vi.fn(),
  getLLMSettings: vi.fn(),
  getRun: vi.fn(),
  getSessionMessages: vi.fn(),
  sseUrl: vi.fn((sid: string) => `/sessions/${sid}/events`),
}));

const sseMock = vi.hoisted(() => ({
  connect: vi.fn(),
  disconnect: vi.fn(),
  onStatusChange: vi.fn(),
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return { ...actual, api: apiMock };
});

vi.mock("@/hooks/useSSE", () => ({
  useSSE: () => sseMock,
}));

vi.mock("@/components/chat/ModelRuntimeBar", () => ({
  ModelRuntimeBar: ({
    reasoningEffortValue,
    reasoningEffortDisabled,
    onReasoningEffortChange,
  }: {
    reasoningEffortValue?: string;
    reasoningEffortDisabled?: boolean;
    onReasoningEffortChange?: (value: string) => void;
  }) => (
    <select
      data-testid="effort-picker"
      value={reasoningEffortValue ?? ""}
      disabled={reasoningEffortDisabled}
      onChange={(event) => onReasoningEffortChange?.(event.target.value)}
    >
      <option value="">Default</option>
      <option value="low">Low</option>
      <option value="high">High</option>
      <option value="xhigh">Extra high</option>
    </select>
  ),
}));

function storedReply(sessionId: string, reasoningEffort?: string) {
  return {
    message_id: `${sessionId}-reply`,
    session_id: sessionId,
    role: "assistant",
    content: "done",
    created_at: "2026-08-01T00:00:00Z",
    linked_attempt_id: `${sessionId}-attempt`,
    tool_trail: [],
    metadata: reasoningEffort ? { provider: "openai", model: "gpt-6.1-sol", reasoning_effort: reasoningEffort } : {},
  };
}

function mountAt(path: string) {
  const router = createMemoryRouter([{ path: "/", element: <Agent /> }], { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return router;
}

describe("Agent per-chat reasoning effort choice", () => {
  beforeEach(() => {
    useAgentStore.getState().reset();
    apiMock.getGoal.mockResolvedValue(null);
    apiMock.getLLMSettings.mockResolvedValue({
      provider: "openai",
      model_name: "gpt-6.1-sol",
      base_url: "https://api.openai.com/v1",
      api_key_configured: true,
      api_key_required: true,
      temperature: 0,
      timeout_seconds: 120,
      max_retries: 2,
      reasoning_effort: "xhigh",
      sse_timeout_seconds: 90,
      env_path: "agent/.env",
      providers: [],
    });
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    });
  });

  it("initializes from the last assistant message's metadata.reasoning_effort", async () => {
    apiMock.getSessionMessages.mockResolvedValue([storedReply("session-one", "low")]);

    mountAt("/?session=session-one");

    await waitFor(() => expect(screen.getByTestId("effort-picker")).toHaveValue("low"));
  });

  it("defaults a chat with no prior reasoning_effort metadata", async () => {
    apiMock.getSessionMessages.mockResolvedValue([storedReply("session-one")]);

    mountAt("/?session=session-one");

    await waitFor(() => expect(apiMock.getSessionMessages).toHaveBeenCalled());
    expect(screen.getByTestId("effort-picker")).toHaveValue("");
  });

  it("a brand new chat (no session) starts at Default", () => {
    mountAt("/");

    expect(screen.getByTestId("effort-picker")).toHaveValue("");
  });

  it("disables the picker while a run is streaming", async () => {
    apiMock.getSessionMessages.mockResolvedValue([]);
    mountAt("/?session=session-one");
    await waitFor(() => expect(sseMock.connect).toHaveBeenCalled());

    act(() => {
      useAgentStore.getState().setStatus("streaming");
    });

    await waitFor(() => expect(screen.getByTestId("effort-picker")).toBeDisabled());
  });

  it("keeps each chat's unsent choice when switching between sessions", async () => {
    apiMock.getSessionMessages.mockImplementation(async (sid: string) => [
      storedReply(sid, sid === "session-one" ? "low" : "high"),
    ]);
    const router = mountAt("/?session=session-one");
    await waitFor(() => expect(screen.getByTestId("effort-picker")).toHaveValue("low"));

    fireEvent.change(screen.getByTestId("effort-picker"), { target: { value: "xhigh" } });
    await act(async () => { await router.navigate("/?session=session-two"); });
    await waitFor(() => expect(screen.getByTestId("effort-picker")).toHaveValue("high"));

    fireEvent.change(screen.getByTestId("effort-picker"), { target: { value: "low" } });
    await act(async () => { await router.navigate("/?session=session-one"); });
    await waitFor(() => expect(screen.getByTestId("effort-picker")).toHaveValue("xhigh"));

    await act(async () => { await router.navigate("/?session=session-two"); });
    await waitFor(() => expect(screen.getByTestId("effort-picker")).toHaveValue("low"));
  });
});
```

- [ ] **Step 2: Run it and watch it fail.**

Run (in `frontend/`): `npx vitest run src/pages/__tests__/AgentReasoningEffortChoice.test.tsx`
Expected: `initializes from the last assistant message's metadata.reasoning_effort` fails (`effort-picker` shows `""` not `"low"`). The session-switch test fails later when the initial one-off choice state is wired (it restores `low` from history instead of the unsent `xhigh`). Keep all five in the suite.

---

### Step 3: Add the per-chat state

In `src/pages/Agent.tsx`:

- [ ] Replace the `RuntimeIdentity` interface:

```tsx
interface RuntimeIdentity {
  sessionId?: string;
  provider?: string;
  model?: string;
  reasoningEffort?: string;
}
```

with:

```tsx
interface RuntimeIdentity {
  sessionId?: string;
  provider?: string;
  model?: string;
  reasoningEffort?: string;
}

/** Choice made before a session exists. Session IDs are hex, so this cannot collide. */
const NEW_CHAT_EFFORT_KEY = "__new__";
```

- [ ] Replace:

```tsx
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [runtimeIdentity, setRuntimeIdentity] = useState<RuntimeIdentity>({});
```

with:

```tsx
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [runtimeIdentity, setRuntimeIdentity] = useState<RuntimeIdentity>({});
  const [reasoningEffortChoices, setReasoningEffortChoices] = useState<Record<string, string>>({});
```

- [ ] Replace:

```tsx
  const urlSessionId = searchParams.get("session");
  const visibleRuntimeIdentity = runtimeIdentity.sessionId === urlSessionId
    ? runtimeIdentity
    : {};
```

with:

```tsx
  const urlSessionId = searchParams.get("session");
  const visibleRuntimeIdentity = runtimeIdentity.sessionId === urlSessionId
    ? runtimeIdentity
    : {};
  const reasoningEffortSessionKey = urlSessionId ?? NEW_CHAT_EFFORT_KEY;
  const pendingReasoningEffort = reasoningEffortChoices[reasoningEffortSessionKey] ?? "";
```

- [ ] **Step 4: Run the intermediate typecheck; finish the wiring before expecting green.**

Run: `npx tsc -b`
Expected at this intermediate step: TypeScript may flag `pendingReasoningEffort`/`reasoningEffortSessionKey` as unused; Step 8 wires them before the final typecheck. This is a deliberate intermediate red result, not completion.

---

### Step 5: Initialize the choice from history and keep it in sync across session switches

- [ ] Replace:

```tsx
      act().setSessionLoading(false);
      act().cacheSession(sid, agentMsgs);
      setRuntimeIdentity(latestRuntimeIdentity ?? {});
      scheduleHistoryScroll();
    } catch (error) {
      if (genRef.current !== gen) return;
      setRuntimeIdentity({});
      act().setSessionLoading(false);
      setHistoryError(error instanceof Error ? error.message : t("settings.unknownError"));
    }
```

with:

```tsx
      act().setSessionLoading(false);
      act().cacheSession(sid, agentMsgs);
      setRuntimeIdentity(latestRuntimeIdentity ?? {});
      // Seed this chat only once. Reloading its history must not overwrite an
      // unsent choice; a model-rejected level is reset by ReasoningEffortSelect.
      setReasoningEffortChoices((current) => sid in current
        ? current
        : { ...current, [sid]: latestRuntimeIdentity?.reasoningEffort ?? "" });
      scheduleHistoryScroll();
    } catch (error) {
      if (genRef.current !== gen) return;
      setRuntimeIdentity({});
      act().setSessionLoading(false);
      setHistoryError(error instanceof Error ? error.message : t("settings.unknownError"));
    }
```

- [ ] Session switches and same-session remounts leave `reasoningEffortChoices` untouched: pending, unsent choices for other chats must survive. Only the no-session branch resets the `__new__` entry. Replace the block identifiable by `setHistoryError(null);` immediately below:

```tsx
      doDisconnect();
      setRuntimeIdentity({});
      setGroundingRevision(null);
      setHistoryError(null);
```

with:

```tsx
      doDisconnect();
      setRuntimeIdentity({});
      setReasoningEffortChoices((current) => ({ ...current, [NEW_CHAT_EFFORT_KEY]: "" }));
      setGroundingRevision(null);
      setHistoryError(null);
```

---

### Step 6: Carry a choice made before a session exists over to the new session id

A chat can be started with the composer before any session is created; the picker's choice must survive the moment `?session=` appears in the URL rather than flashing back to Default.

- [ ] In `ensureGoalSession`, replace:

```tsx
    const session = await api.createSession(title.slice(0, 50));
    sid = session.session_id;
    pendingGoalSessionRef.current = sid;
    act().setSessionId(sid);
    setSearchParams({ session: sid }, { replace: true });
    setupSSE(sid);
    return sid;
  }, [setSearchParams, setupSSE]);
```

with:

```tsx
    const session = await api.createSession(title.slice(0, 50));
    sid = session.session_id;
    pendingGoalSessionRef.current = sid;
    act().setSessionId(sid);
    setSearchParams({ session: sid }, { replace: true });
    // Carry the choice made before this session existed under its new id, so
    // the picker (keyed by urlSessionId) does not flash back to Default the
    // instant the URL gains ?session=.
    setReasoningEffortChoices((current) => {
      const next = { ...current, [sid]: current[NEW_CHAT_EFFORT_KEY] ?? "" };
      delete next[NEW_CHAT_EFFORT_KEY];
      return next;
    });
    setupSSE(sid);
    return sid;
  }, [setSearchParams, setupSSE]);
```

- [ ] In `runPrompt`'s non-goal branch, replace:

```tsx
        sid = session.session_id;
        act().setSessionId(sid);
        setSearchParams({ session: sid }, { replace: true });
      }
      setupSSE(sid);
      const sent = await api.sendMessage(sid, finalPrompt);
```

with:

```tsx
        sid = session.session_id;
        act().setSessionId(sid);
        setSearchParams({ session: sid }, { replace: true });
        // Carry the choice made before this session existed under its new id
        // (see the matching comment in ensureGoalSession).
        setReasoningEffortChoices((current) => {
          const next = { ...current, [sid as string]: current[NEW_CHAT_EFFORT_KEY] ?? "" };
          delete next[NEW_CHAT_EFFORT_KEY];
          return next;
        });
      }
      setupSSE(sid);
      const sent = await api.sendMessage(sid, finalPrompt, { reasoningEffort: pendingReasoningEffort || undefined });
```

---

### Step 7: Pass the choice on the other two `sendMessage` call sites

- [ ] In `runPrompt`'s goal branch, replace:

```tsx
        setupSSE(sid);
        const sent = await api.sendMessage(sid, kickoff);
```

with:

```tsx
        setupSSE(sid);
        const sent = await api.sendMessage(sid, kickoff, { reasoningEffort: pendingReasoningEffort || undefined });
```

- [ ] `runPrompt` reads `pendingReasoningEffort` in its closure, so add it to the `useCallback` dependency array. Replace:

```tsx
  }, [
    archiveActivity,
    clearStreamingView,
    ensureGoalSession,
    forceScrollToBottom,
    goalComposerActive,
    setSearchParams,
    setupSSE,
    status,
    swarmPreset,
    syncCompletedAttempt,
    t,
  ]);
```

with:

```tsx
  }, [
    archiveActivity,
    clearStreamingView,
    ensureGoalSession,
    forceScrollToBottom,
    goalComposerActive,
    pendingReasoningEffort,
    setSearchParams,
    setupSSE,
    status,
    swarmPreset,
    syncCompletedAttempt,
    t,
  ]);
```

- [ ] In `handleContinueGoal`, replace:

```tsx
    try {
      setupSSE(sessionId);
      const sent = await api.sendMessage(sessionId, prompt);
      if (act().activity?.attemptId.startsWith("pending-")) {
        act().setActivityAttemptId(sent.attempt_id);
      }
      void syncCompletedAttempt(sessionId, sent.attempt_id);
    } catch (error) {
      archiveActivity("failed");
      act().setStatus("error");
      const message = isAuthRequiredError(error) ? AUTH_REQUIRED_MESSAGE : t('agent.failedToContinue');
      toast.error(message);
      act().addMessage({ id: "", type: "error", content: message, timestamp: Date.now() });
    }
  }, [archiveActivity, forceScrollToBottom, goalSnapshot, sessionId, setupSSE, status, syncCompletedAttempt, t]);
```

with:

```tsx
    try {
      setupSSE(sessionId);
      const sent = await api.sendMessage(sessionId, prompt, { reasoningEffort: pendingReasoningEffort || undefined });
      if (act().activity?.attemptId.startsWith("pending-")) {
        act().setActivityAttemptId(sent.attempt_id);
      }
      void syncCompletedAttempt(sessionId, sent.attempt_id);
    } catch (error) {
      archiveActivity("failed");
      act().setStatus("error");
      const message = isAuthRequiredError(error) ? AUTH_REQUIRED_MESSAGE : t('agent.failedToContinue');
      toast.error(message);
      act().addMessage({ id: "", type: "error", content: message, timestamp: Date.now() });
    }
  }, [archiveActivity, forceScrollToBottom, goalSnapshot, pendingReasoningEffort, sessionId, setupSSE, status, syncCompletedAttempt, t]);
```

---

### Step 8: Wire `ModelRuntimeBar`

- [ ] Replace:

```tsx
      <ModelRuntimeBar
        settings={llmSettings}
        runtimeProvider={visibleRuntimeIdentity.provider}
        runtimeModel={visibleRuntimeIdentity.model}
        runtimeReasoningEffort={visibleRuntimeIdentity.reasoningEffort}
      />
```

with:

```tsx
      <ModelRuntimeBar
        settings={llmSettings}
        runtimeProvider={visibleRuntimeIdentity.provider}
        runtimeModel={visibleRuntimeIdentity.model}
        runtimeReasoningEffort={visibleRuntimeIdentity.reasoningEffort}
        reasoningEffortValue={
          status === "streaming" && visibleRuntimeIdentity.reasoningEffort !== undefined
            ? visibleRuntimeIdentity.reasoningEffort
            : pendingReasoningEffort
        }
        onReasoningEffortChange={(value) => setReasoningEffortChoices((current) => ({
          ...current,
          [reasoningEffortSessionKey]: value,
        }))}
        reasoningEffortDisabled={status === "streaming"}
      />
```

- [ ] **Step 9: Run it, expect PASS.**

Run: `npx tsc -b && npx vitest run src/pages/__tests__/AgentReasoningEffortChoice.test.tsx`
Expected: `tsc -b` clean; `5 passed`, including the unsent-choice session-switch case.

- [ ] **Step 10: Run the full frontend suite and build.**

Run: `npx tsc -b && npx vitest run && npm run build`
Expected: `tsc -b` clean; `79 files / 765 passed` (78/760 from Task 5, plus this task's five new tests); build succeeds.

---

### Step 11: Update `packages/vibe-trading/DIVERGENCE.md`

Find the row Task 5 added:

```
| `lib/__tests__/api.test.ts`, `components/chat/__tests__/ModelRuntimeBar.test.tsx`, new `ReasoningEffortSelect.test.tsx`, `pages/__tests__/AgentGroundingStatus.test.tsx`, `AgentBackgroundStreamCompletion.test.tsx` | Extended / mocks updated. | |
```

Replace it with itself plus one new row directly after:

```
| `lib/__tests__/api.test.ts`, `components/chat/__tests__/ModelRuntimeBar.test.tsx`, new `ReasoningEffortSelect.test.tsx`, `pages/__tests__/AgentGroundingStatus.test.tsx`, `AgentBackgroundStreamCompletion.test.tsx` | Extended / mocks updated. | |
| `pages/Agent.tsx`, new `pages/__tests__/AgentReasoningEffortChoice.test.tsx` | Per-chat `reasoningEffortChoices` map keyed by session id, seeded from the last assistant message's metadata without overwriting an unsent choice on a session switch; all three `api.sendMessage` call sites pass it; the picker is disabled while streaming. | Per-chat choice (01p section 5.4). |
```

Also add two bullets to "Behaviours to preserve through a sync" (after the existing three items):

```
6. A message may carry an optional `reasoning_effort`. It is validated against the model before anything is stored, applies to that run and its committee workers only, and never changes a server default.
7. The effort lists in Settings and in the chat contain only levels the model's own error message names (the model-specific form), with the generic form treated as inconclusive.
```

(If sub-project 1's plan already added items 4 and 5 by the time you reach this step, these become items 6 and 7 as written above; if it has not yet, renumber to continue from whatever the last item is and note the gap in your final report — do not silently skip numbers or guess at sub-project 1's wording.)

Finally, add to "Reapplying after a sync"'s expected-conflict list. Find:

```
Expect conflicts in `Settings.tsx`, `settings_routes.py`, `api.ts` and the locale
JSON files. Resolve in favour of upstream's structure, then restore the three
behaviours above. Then:
```

Replace with:

```
Expect conflicts in `Settings.tsx`, `settings_routes.py`, `api.ts`, `Agent.tsx`,
`service.py`, `llm.py` and the locale JSON files. Resolve in favour of
upstream's structure, then restore the behaviours above. Then:
```

- [ ] **Step 12: Commit.**

```
git -C ai-trading/packages/vibe-trading add frontend/src/pages/Agent.tsx frontend/src/pages/__tests__/AgentReasoningEffortChoice.test.tsx DIVERGENCE.md
git -C ai-trading/packages/vibe-trading commit -m "feat(family-app): wire the per-chat reasoning effort choice into Agent.tsx"
```

This closes the frontend half of the plan. Task 7 is live verification (no code changes beyond writing DIVERGENCE.md's Verification section); Task 8 ships the batch.
