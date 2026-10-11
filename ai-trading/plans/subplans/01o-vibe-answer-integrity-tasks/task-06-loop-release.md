# Task 6: Release the flagged draft from the loop

Part of [01o-vibe-answer-integrity-plan.md](../01o-vibe-answer-integrity-plan.md). Read its Global Constraints and Test Runner first; every command runs from the repository root of the worktree, with `vt_test` defined as in the Test Runner section.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the revision budget is spent, `AgentLoop` releases `flagged_release(...)` instead of `redacted_release(...)`. With a flagged figure it emits `answer_released_flagged` and the grounding status `released_flagged`; when nothing was flagged the legacy `answer_released_redacted` and `released_redacted` names, and their reason text, are unchanged, so upstream's loop tests stay valid. The frontend treats any stage but `revising` as "done", so it needs no change.

**Files:**
- Modify (append a test): `ai-trading/packages/vibe-trading/agent/tests/test_grounding_release.py` (it already holds the scripted-LLM loop scaffolding)
- Modify: `ai-trading/packages/vibe-trading/agent/src/agent/loop.py` (the out-of-revisions branch)
- Modify: `ai-trading/packages/vibe-trading/DIVERGENCE.md` (one Backend row)

**Interfaces:**
- Consumes: `GroundingLedger.flagged_release(content, validation) -> str | None` and `GroundingLedger.figures_flagged -> int` from Task 05.
- Produces: trace and react-trace event `answer_released_flagged` (or the legacy `answer_released_redacted`); `grounding_status` payload `{stage: "released_flagged" | "released_redacted", flagged: int, removed: int}`; `_released_fallback_reason` of the form `final answer released with N unverified figure(s) flagged after M rejected drafts`.

- [ ] **Step 1: Write the failing test.** Append this to `agent/tests/test_grounding_release.py`:

````python
FLAGGED_DRAFT = (
    "562500.SS（Yahoo，CNY）在 2026-06-23 的已观测收盘价为 1.137，均线空头排列。参考支撑位 1.00 元。"
    "\n\n```figures\n1.137 | observed | 收盘 2026-06-23 | prices\n1.00 | derived | 2 * 0.5 | prices\n```"
)


def test_loop_releases_a_declared_unverifiable_figure_flagged_not_cut(tmp_path: Path) -> None:
    """A figure the model declared but the gate cannot anchor stays in the answer, marked."""
    llm = _ScriptedLLM(_SCRIPT_HEAD + [_Response(content=FLAGGED_DRAFT)])

    result, events, agent = _run(tmp_path, llm, max_iterations=8)

    assert result["status"] == "success"
    assert result.get("degraded") is True
    content = result["content"]
    assert "1.137" in content and "均线空头排列" in content
    assert "1.00 元（未核验※）" in content
    assert "※ 有 1 处数值无法与本会话工具数据对上" in content
    assert "```figures" not in content and "已拒绝上一版答案" not in content
    assert _REDACTION_MARKER_ZH not in content
    streamed = "".join(data.get("delta", "") for event, data in events if event == "text_delta")
    assert "1.00 元（未核验※）" in streamed
    trace = TraceWriter.read(tmp_path / "run")
    assert [e for e in trace if e.get("type") == "answer_released_flagged"]
    assert not [e for e in trace if e.get("type") == "answer_released_redacted"]
    end = next(e for e in trace if e.get("type") == "end")
    assert "1 unverified figure(s) flagged after 2 rejected drafts" in end.get("reason", "")
    statuses = [data for event, data in events if event == "grounding_status"]
    assert [status["stage"] for status in statuses] == ["revising", "released_flagged"]
    assert statuses[1]["flagged"] == 1 and statuses[1]["removed"] == 0
    assert agent._grounding.figures_flagged == 1
````

- [ ] **Step 2: Run the file and confirm the new test fails because the loop still cuts the figure.**

```bash
vt_test tests/test_grounding_release.py -q
```

Expected: `1 failed, 108 passed`. The failure shows `参考支撑位（略※）` where `1.00 元（未核验※）` is expected.

- [ ] **Step 3: Implement it.**

Save the diff to a file and apply it (or make the same edits by hand; the hunks are exact):

```bash
cat > "${TMPDIR:-/tmp}/task-06.patch" <<'PATCH'
diff --git a/agent/src/agent/loop.py b/agent/src/agent/loop.py
index f79d434..1b196be 100644
--- a/agent/src/agent/loop.py
+++ b/agent/src/agent/loop.py
@@ -1112,26 +1112,29 @@ class AgentLoop:
                                 continue
                             # Out of revisions. The last draft is still the
                             # analysis the user waited minutes for; release it
-                            # with the rejected figures cut out and re-checked
-                            # by the same gate. The canned refusal is only for
-                            # what cannot be cut: an identity finding, a run
-                            # that never observed a price, or a cut that still
-                            # fails validation.
+                            # with the figures the gate could not verify kept
+                            # and marked, and only the invented or misattributed
+                            # ones cut out (family-app fork). The canned refusal
+                            # is only for what cannot be released: an identity
+                            # finding, a run that never observed a price, or a
+                            # figure that cannot be located.
                             rejected_drafts = self._grounding.validation_count
-                            released = self._grounding.redacted_release(
+                            released = self._grounding.flagged_release(
                                 rejected_draft, validation
                             )
                             if released is not None:
+                                flagged = self._grounding.figures_flagged
+                                kind = "flagged" if flagged else "redacted"
                                 trace.write(
                                     {
-                                        "type": "answer_released_redacted",
+                                        "type": f"answer_released_{kind}",
                                         "iter": current_iter,
                                         "issues": validation.issues,
                                     }
                                 )
                                 react_trace.append(
                                     {
-                                        "type": "answer_released_redacted",
+                                        "type": f"answer_released_{kind}",
                                         "issues": validation.issues,
                                     }
                                 )
@@ -1139,12 +1142,16 @@ class AgentLoop:
                                 self._emit(
                                     "grounding_status",
                                     {
-                                        "stage": "released_redacted",
+                                        "stage": f"released_{kind}",
+                                        "flagged": flagged,
                                         "removed": self._grounding.figures_removed,
                                     },
                                 )
                                 self._released_fallback_reason = (
-                                    "final answer released with unverified figures "
+                                    f"final answer released with {flagged} unverified "
+                                    f"figure(s) flagged after {rejected_drafts} rejected drafts"
+                                    if flagged
+                                    else "final answer released with unverified figures "
                                     f"redacted after {rejected_drafts} rejected drafts"
                                 )
                             else:
PATCH
```

```bash
git -C ai-trading/packages/vibe-trading apply "${TMPDIR:-/tmp}/task-06.patch"
```

- [ ] **Step 4: Run the file, which holds upstream's own loop-level redaction tests, then every grounding-related test.**

```bash
vt_test tests/test_grounding_release.py -q
vt_test tests -q -n 8 -k "grounding or figures or policies or evidence or release or loop or agent_loop"
```

Expected: `109 passed`, then no failures.

- [ ] **Step 5: Add the ledger row.**

Insert the row below into the **Backend** table of `ai-trading/packages/vibe-trading/DIVERGENCE.md`, immediately above the row that starts with ``| `tests/test_settings_api.py` |`` (so rows stay in task order):

```markdown
| `agent/src/agent/loop.py` | The out-of-revisions branch calls `flagged_release` instead of `redacted_release`. When a figure was flagged it emits the trace event `answer_released_flagged` and the grounding status `released_flagged` (with `flagged` and `removed` counts) and its `_released_fallback_reason` names the count; when none was flagged the legacy `answer_released_redacted`, `released_redacted` and reason are unchanged. Tests: `tests/test_grounding_release.py` (one loop-level test appended). | Same as `release.py`: the analysis the user waited for is released, not cut or replaced. |
```

- [ ] **Step 6: Commit.**

```bash
git -C ai-trading/packages/vibe-trading add -A agent DIVERGENCE.md
git -C ai-trading/packages/vibe-trading commit -m "feat(family-app): release the flagged draft from the loop instead of the redacted one"
```
