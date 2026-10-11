# Task 7: Live verification (no code changes)

Part of [01p-vibe-effort-picker-plan.md](../01p-vibe-effort-picker-plan.md). Read its Global Constraints first. Builds on Tasks 1–6 (all code must be committed before this task runs). This task writes only `packages/vibe-trading/DIVERGENCE.md`'s "Verification" section — real numbers from real runs, not estimates. The owner's sponsored `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` are free to use for this (`ai-trading/AGENTS.md`, "Sponsored LLM keys").

This task's commands are written for a human or agent executor to actually run; the implementation plan's author validated the *code* in a scratch copy but did not call live OpenAI or run a browser (see that constraint in the orchestrating prompt). Read every command before running it.

All paths below are relative to the repository root unless noted; `T=/private/var/folders/_1/050mzm_167bd175pmv0rfhz40000gn/T/opencode` matches the scratch convention used while writing this plan — substitute your own scratch directory.

**Files:**
- Modify: `ai-trading/packages/vibe-trading/DIVERGENCE.md` (Verification section, with live evidence)
- No product-code changes; test live OpenAI, committee, browser, backend/frontend suites.

**Interfaces:**
- Consumes: Task 1–6's committed fork code, the production Firestore profile via `common/config/family_config.py`, and the sponsored OpenAI key.
- Produces: recorded live probe/chat/committee/browser results in `DIVERGENCE.md` for Task 8's ship gate.

## Steps

- [ ] **Step 1: Confirm Tasks 1–6 are committed.**

```
git -C ai-trading/packages/vibe-trading log --oneline -8
```

Expected: six **new 01p** commits, one per task, in order (Tasks 1 → 6), on branch `family-app`, above the earlier 01o commits. Every changed file has a row in `DIVERGENCE.md` in the same commit.

- [ ] **Step 2: Probe matrix — twelve models, direct OpenAI, real network calls.**

Reproduces the probe `_discover_reasoning_efforts` makes (`agent/src/api/settings_routes.py`), one request per model, comparing the picker's resulting list against what the Responses route (the runtime's actual transport) accepts at the lowest and highest offered level. The twelve models are the ones already probed in 01n section 3.2 and DIVERGENCE.md's first-commit verification: `gpt-6.1-sol`, `gpt-6-sol`, `gpt-6-astra`, `gpt-6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.4`, `gpt-5.2`, `o3`, `gpt-4.1`. `o3` is the known case where the probe's generic form would have wrongly offered `xhigh` before Task 1 (confirm Task 1's model-specific-only trust avoids that).

```sh
export OPENAI_API_KEY="$(common/config/family_config.py get shared/llm OPENAI_API_KEY_1)"
for model in gpt-6.1-sol gpt-6-sol gpt-6-astra gpt-6-luna gpt-5.6-sol gpt-5.6-terra gpt-5.6-luna gpt-5.5 gpt-5.4 gpt-5.2 o3 gpt-4.1; do
  echo "== $model (probe) =="
  curl -s https://api.openai.com/v1/chat/completions \
    -H "Authorization: Bearer $OPENAI_API_KEY" -H "Content-Type: application/json" \
    -d "{\"model\":\"$model\",\"messages\":[{\"role\":\"user\",\"content\":\".\"}],\"reasoning_effort\":\"__probe__\"}" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin).get("error",{}).get("message",""))'
done
```

For each model, record the message and whether it is the model-specific form (`... does not support '__probe__' with this model. Supported values are: ...`, which Task 1's `validate_reasoning_effort`/`_discover_reasoning_efforts` trusts) or the generic form (`Invalid value: ... Supported values are: ...`, which falls back to `low, medium, high`). Expected per the measured facts already in this plan's "Facts already verified": `gpt-6.1-sol`, `gpt-5.5`, `gpt-5` give the model-specific form; `o3` gives the generic form (and genuinely rejects `xhigh` on the Responses route, confirmed next).

- [ ] **Step 3: Confirm `o3`'s real Responses-route acceptance at its lowest and highest offered level.**

```sh
for effort in low xhigh; do
  echo "== o3 effort=$effort =="
  curl -s https://api.openai.com/v1/responses \
    -H "Authorization: Bearer $OPENAI_API_KEY" -H "Content-Type: application/json" \
    -d "{\"model\":\"o3\",\"input\":\"Say OK.\",\"reasoning\":{\"effort\":\"$effort\"}}" \
    | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("error") or d.get("output_text") or d.get("status"))'
done
```

Expected: `low` succeeds; `xhigh` fails with a 400 naming `reasoning.effort`. Record both results. If `o3` unexpectedly accepts `xhigh`, that is new information — do not silently adjust the fallback list; stop and flag it (the spec's "Not Now" section and 01p section 10 explicitly rely on this failure to justify never hardcoding a hopeful superset).

- [ ] **Step 4: Start a local Vibe server against the sponsored key.**

```sh
T=/private/var/folders/_1/050mzm_167bd175pmv0rfhz40000gn/T/opencode
VENV="$T/vibe-venv2"
rm -rf "$T/vibe-home-01p" && mkdir -p "$T/vibe-home-01p"
PORT=18942
( cd ai-trading/packages/vibe-trading/agent \
  && python3 ../../../../common/config/family_config.py run ai-trading/vibe-trading -- \
     env -u API_AUTH_KEY HOME="$T/vibe-home-01p" VIBE_TRADING_HOME="$T/vibe-home-01p/.vibe-trading" \
      PATH="$VENV/bin:$PATH" PYTHONPATH="$PWD" \
     python ../../../deploy/upstream/vibe-trading/start-vibe.py vibe-trading serve --host 127.0.0.1 --port "$PORT" \
     > "$T/vibe-01p-server.log" 2>&1 ) &
for i in $(seq 1 60); do curl -sf -m 2 "http://127.0.0.1:$PORT/live" >/dev/null && break; sleep 2; done
curl -sf -m 5 "http://127.0.0.1:$PORT/live" >/dev/null || { echo "SERVER DID NOT START"; tail -40 "$T/vibe-01p-server.log"; exit 1; }
echo "server up on $PORT"
```

The `family_config.py run` invocation matches the local server recipe used for the 01o live baseline. Verify `/settings/llm` reports provider `openai`, model `gpt-6.1-sol`, effort `xhigh` before sending test messages.

Compare the **actual picker endpoint** against `/v1/responses` for all twelve models, not merely the raw error strings from Step 2. This sends real short requests at the lowest and highest *offered* levels (skip models whose list is empty). Any offered level that gets a 400 is a picker defect; stop before Task 8.

```sh
"$VENV/bin/python" - <<'PY'
import json, os, sys, urllib.error, urllib.request

models = "gpt-6.1-sol gpt-6-sol gpt-6-astra gpt-6-luna gpt-5.6-sol gpt-5.6-terra gpt-5.6-luna gpt-5.5 gpt-5.4 gpt-5.2 o3 gpt-4.1".split()
key = os.environ["OPENAI_API_KEY"]
failures = []

def post(url, payload, auth=False):
    headers = {"Content-Type": "application/json"}
    if auth:
        headers["Authorization"] = "Bearer " + key
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            return resp.status, json.load(resp)
    except urllib.error.HTTPError as exc:
        return exc.code, json.load(exc)

for model in models:
    status, picker = post("http://127.0.0.1:18942/settings/llm/reasoning-efforts", {"provider": "openai", "model_name": model})
    if status != 200:
        failures.append((model, "picker", status))
        continue
    efforts = picker["efforts"]
    print(model, picker["source"], efforts)
    for effort in dict.fromkeys((efforts[0], efforts[-1])) if efforts else ():
        status, response = post("https://api.openai.com/v1/responses", {"model": model, "input": "Say OK.", "reasoning": {"effort": effort}}, auth=True)
        print("  ", effort, status, (response.get("error") or {}).get("message", "accepted")[:120])
        if status != 200:
            failures.append((model, effort, status))
if failures:
    print("picker/Responses mismatches:", failures, file=sys.stderr)
    sys.exit(1)
PY
```

Expected: all levels the picker offers are accepted. `o3` offers only `low, medium, high` through the conservative fallback; `gpt-4.1` offers an empty list. Record results in DIVERGENCE.md's verification section.

- [ ] **Step 5: A real chat at `low` on `gpt-6.1-sol` reports the level in message metadata.**

```sh
BASE="http://127.0.0.1:$PORT"
SID=$(curl -s -X POST "$BASE/sessions" -H "Content-Type: application/json" -d '{"title":"01p low"}' | python3 -c 'import json,sys;print(json.load(sys.stdin)["session_id"])')
curl -s -X POST "$BASE/sessions/$SID/messages" -H "Content-Type: application/json" \
  -d '{"content":"Say OK and nothing else.","reasoning_effort":"low"}'
wait_for_effort() {
  sid=$1; expected=$2; base=$3
  for i in $(seq 1 720); do
    outcome=$(curl -sf "$base/sessions/$sid/messages" | python3 -c 'import json,sys; m=json.load(sys.stdin); a=[x for x in m if x["role"]=="assistant"]; print((a[-1].get("metadata") or {}).get("status", "missing") + ":" + (a[-1].get("metadata") or {}).get("reasoning_effort", "missing") if a else "pending")')
    [ "$outcome" = "completed:$expected" ] && { echo "$outcome"; return 0; }
    [ "$outcome" != pending ] && { echo "unexpected attempt outcome: $outcome" >&2; return 1; }
    sleep 5
  done
  echo "attempt did not complete within 60 minutes" >&2
  return 1
}
wait_for_effort "$SID" low "$BASE"
```

Expected: the attempt completes and the assistant message's `metadata.reasoning_effort == "low"`.

- [ ] **Step 6: A real chat at `xhigh` on `gpt-6.1-sol` reports the level.**

```sh
SID_XHIGH=$(curl -s -X POST "$BASE/sessions" -H "Content-Type: application/json" -d '{"title":"01p xhigh"}' | python3 -c 'import json,sys;print(json.load(sys.stdin)["session_id"])')
curl -s -X POST "$BASE/sessions/$SID_XHIGH/messages" -H "Content-Type: application/json" \
  -d '{"content":"Say OK and nothing else.","reasoning_effort":"xhigh"}'
wait_for_effort "$SID_XHIGH" xhigh "$BASE"
```

Expected: `completed:xhigh` in the terminal and in the stored assistant metadata.

- [ ] **Step 7: A real chat at `none` on `gpt-5.5` reports the level.**

Start a **second**, isolated local server for `gpt-5.5`. Override the model only in that process: never edit the Firestore production profile. Keep the Sol server from Step 4 running for Steps 8–10.

```sh
PORT_FAST=18943
mkdir -p "$T/vibe-home-01p-fast"
( cd ai-trading/packages/vibe-trading/agent \
  && python3 ../../../../common/config/family_config.py run ai-trading/vibe-trading -- \
     env -u API_AUTH_KEY HOME="$T/vibe-home-01p-fast" VIBE_TRADING_HOME="$T/vibe-home-01p-fast/.vibe-trading" \
     PATH="$VENV/bin:$PATH" PYTHONPATH="$PWD" LANGCHAIN_MODEL_NAME=gpt-5.5 \
     python ../../../deploy/upstream/vibe-trading/start-vibe.py vibe-trading serve --host 127.0.0.1 --port "$PORT_FAST" \
     > "$T/vibe-01p-fast-server.log" 2>&1 ) &
for i in $(seq 1 60); do curl -sf -m 2 "http://127.0.0.1:$PORT_FAST/live" >/dev/null && break; sleep 2; done
BASE_FAST="http://127.0.0.1:$PORT_FAST"
curl -sf "$BASE_FAST/settings/llm" | python3 -c 'import json,sys; assert json.load(sys.stdin)["model_name"] == "gpt-5.5"'
SID_FAST=$(curl -s -X POST "$BASE_FAST/sessions" -H "Content-Type: application/json" -d '{"title":"01p fast"}' | python3 -c 'import json,sys;print(json.load(sys.stdin)["session_id"])')
curl -s -X POST "$BASE_FAST/sessions/$SID_FAST/messages" -H "Content-Type: application/json" \
  -d '{"content":"Say OK and nothing else.","reasoning_effort":"none"}'
wait_for_effort "$SID_FAST" none "$BASE_FAST"
```

Expected: `completed:none` in the stored assistant metadata, with the Firestore profile unchanged.

- [ ] **Step 8: A refused level returns 400 with the list.**

Against the `gpt-6.1-sol` server from Step 4:

```sh
SID=$(curl -s -X POST "$BASE/sessions" -H "Content-Type: application/json" -d '{"title":"01p refused"}' | python3 -c 'import json,sys;print(json.load(sys.stdin)["session_id"])')
curl -si -X POST "$BASE/sessions/$SID/messages" -H "Content-Type: application/json" \
  -d '{"content":"Say OK.","reasoning_effort":"max"}'
```

Expected: HTTP 400 with `detail` containing `"gpt-6.1-sol does not support reasoning effort 'max'; supported: low, medium, high, xhigh"`, and a follow-up `GET $BASE/sessions/$SID/messages` shows **zero** messages (the refused send never reached `svc.send_message`).

- [ ] **Step 9: A committee run's `run.json` shows the chosen level.**

```sh
SID=$(curl -s -X POST "$BASE/sessions" -H "Content-Type: application/json" -d '{"title":"01p committee"}' | python3 -c 'import json,sys;print(json.load(sys.stdin)["session_id"])')
curl -s -X POST "$BASE/sessions/$SID/messages" -H "Content-Type: application/json" \
  -d '{"content":"Use run_swarm with preset risk_committee to do a 2-sentence smoke-test risk read on AAPL.","reasoning_effort":"xhigh"}'
wait_for_effort "$SID" xhigh "$BASE"
curl -sf "$BASE/sessions/$SID/messages" | python3 -c 'import json,sys; m=json.load(sys.stdin); a=[x for x in m if x["role"]=="assistant"]; assert a and any(t.get("tool")=="run_swarm" and t.get("status")=="ok" for t in a[-1].get("tool_trail",[])), "no successful run_swarm call"; print("run_swarm was called")'
```

The check above proves the chat actually called `run_swarm`; a completed answer without one does **not** prove committee threading. The run may take more than 10 minutes. Poll its status up to 60 minutes (the local home is fresh, so the latest `risk_committee` run belongs to this smoke test):

```sh
RUN_ID=$(curl -sf "$BASE/swarm/runs" | python3 -c 'import json,sys; r=json.load(sys.stdin); print(next((x["id"] for x in r if x.get("preset_name")=="risk_committee"),""))')
[ -n "$RUN_ID" ] || { echo "risk_committee run not found" >&2; exit 1; }
for i in $(seq 1 720); do
  STATE=$(curl -sf "$BASE/swarm/runs/$RUN_ID" | python3 -c 'import json,sys;print(json.load(sys.stdin)["status"])')
  [ "$STATE" = completed ] && break
  case "$STATE" in failed|cancelled|interrupted) echo "committee ended: $STATE" >&2; exit 1;; esac
  sleep 5
done
[ "$STATE" = completed ] || { echo "committee did not complete within 60 minutes" >&2; exit 1; }
curl -sf "$BASE/swarm/runs/$RUN_ID" | python3 -c 'import json,sys; assert json.load(sys.stdin)["status"]=="completed"; print("API run completed")'
python3 -c 'import json,sys; from pathlib import Path; p=Path(sys.argv[1])/"vibe-home-01p/.vibe-trading/swarm/runs"/sys.argv[2]/"run.json"; r=json.loads(p.read_text()); assert r["reasoning_effort"]=="xhigh"; print("persisted effort:",r["reasoning_effort"])' "$T" "$RUN_ID"
```

Expected: API run status `completed`; `run.json` contains `"reasoning_effort": "xhigh"`. The `/swarm/runs/{id}` API serializes status/tasks but does **not** expose reasoning_effort, so do not claim it does. If the model did not call `run_swarm`, this check is inconclusive; retry with an explicit preset rather than claiming success.

- [ ] **Step 10: Real-browser walkthrough.**

Read the global OpenCode `AGENTS.md` browser rule (`~/.config/opencode/AGENTS.md`), the `cdp` skill before driving Chrome via CDP, and `packages/vibe-trading/DIVERGENCE.md`'s first-commit walkthrough (`agent-browser` + `browser-harness-js`, sandboxed `HOME`). Never drive the owner's personal Chrome. Against the Step 4 server (or a fresh instance), check, in order:

1. Open the chat; the picker shows "Default (Extra high)" (the server default is `xhigh`).
2. Select "Low"; the tooltip reads "Applies from your next message".
3. Send a message; while streaming, the picker is disabled and shows the run's actual level.
4. After it completes, reload the page; the picker shows "Low" again (restored from the last assistant message's metadata).
5. Switch the page language to Chinese (`zh-CN`) and Arabic (`ar`); the picker's labels and the "Default (…)" text render correctly, including RTL layout in Arabic.
6. Open the browser devtools console and network tab for the whole walkthrough; confirm no console errors and no failed (4xx/5xx other than the deliberate Step 8 case) requests. **Owner-approved repair during Task 7:** ordinary chats previously emitted an expected `GET /sessions/{id}/goal` 404. The optional-goal API now returns 200 JSON null for an existing chat with no active goal; unknown sessions still return 404. Re-run the browser flow against the new server, not the earlier process that loaded the old route.

Record what you observed for each of the six checks.

- [ ] **Step 11: Stop the local server.**

```sh
for port in "$PORT" "$PORT_FAST"; do
  pid=$(lsof -tiTCP:$port -sTCP:LISTEN | head -1)
  [ -z "$pid" ] || kill "$pid"
done
```

- [ ] **Step 12: Run the existing suites once more against the final committed state (sanity check before writing Verification numbers).**

```sh
(cd ai-trading/packages/vibe-trading/agent && "$VENV/bin/python" -m pytest tests -q -n 8)
(cd ai-trading/packages/vibe-trading/frontend && npx tsc -b && npx vitest run && npm run build)
```

Record the real pass/skip/fail counts.

- [ ] **Step 13: Write `packages/vibe-trading/DIVERGENCE.md`'s "Verification" section.**

The file already has "Verification of the first fork commit". Add a second section titled `## Verification of the per-chat reasoning effort batch (01p)` after it. Write the date and one bullet per evidence source below, with the **actual** values from the named step:

| Bullet | Evidence to transcribe |
|---|---|
| Backend | Step 12's exact pass, skip and fail counts |
| Frontend | Step 12's TypeScript result, Vitest file/test counts and build result |
| Probe matrix | Step 2's twelve model names, each error form and offered list |
| `o3` Responses-route check | Step 3's low and xhigh statuses |
| Real chats | Steps 5–7: model, level, completed status and stored `metadata.reasoning_effort` |
| Rejected send | Step 8's HTTP 400 detail and zero stored messages |
| Committee | Step 9's successful `run_swarm` trail, API completed status and persisted `run.json` effort |
| Browser | All six Step 10 observations, including Chinese/Arabic and console/network |

Do not copy scratch validation counts (those covered *code*, not live models or a browser), and do not claim a live check passed unless its evidence exists. If one is inconclusive, record it as unverified and **stop before Task 8**.

- [ ] **Step 14: Commit.**

```
git -C ai-trading/packages/vibe-trading add DIVERGENCE.md
git -C ai-trading/packages/vibe-trading commit -m "docs(family-app): record live verification for the reasoning-effort picker batch"
```
