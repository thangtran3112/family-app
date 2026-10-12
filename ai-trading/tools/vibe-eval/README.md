# vibe-eval

Small developer tools for judging Vibe-Trading's US-stock research on a local server. They drive the
public session API only, so they work against any Vibe server, local or deployed.

| File | What it does |
|---|---|
| `serve_local.sh` | Starts a local Vibe-Trading server from this checkout with the production profile's environment (Firestore `ai-trading/vibe-trading`) in a sandboxed home directory. |
| `run_scenarios.py` | Sends the sample research prompts (`S01` to `S15`) to fresh sessions, waits for each answer (10 to 30 minutes is normal at `xhigh`) and saves the prompt, summary and stored messages as JSON. |
| `grounding_report.py` | Says how each run ended: clean, figures flagged `(unverified※)`, figures cut `(omitted※)`, or the canned stub; with drafts rejected, issues raised and `web_search` / `get_stock_profile` calls. |
| `golden_cases.json` / `golden_cases.py` | Versioned 18 fixed + 7 rolling US-stock cases; SEC/synthetic oracles and no-oracle reasons. |
| `score_golden.py` | Offline fact, source, committee and order-safety checks; optional blind Opus/Sonnet judges; separate fixed/rolling/tool reports. |

Typical use (from the repository root; `$VENV` is a virtualenv with the fork's lock installed):

```bash
ai-trading/tools/vibe-eval/serve_local.sh 18901 "$TMPDIR/vibe-home" "$VENV" &
"$VENV/bin/python" ai-trading/tools/vibe-eval/run_scenarios.py "$TMPDIR/run1" --base http://127.0.0.1:18901 --conc 7 --only S02,S03,S08
python3 ai-trading/tools/vibe-eval/grounding_report.py "$TMPDIR/run1" "$TMPDIR/vibe-home/.vibe-trading/runs"
kill $(lsof -tiTCP:18901 -sTCP:LISTEN)
```

Runs use the sponsored OpenAI key and take real model time. Single runs vary (one prompt lost 20 figures
in one run and 8 in the next on the same code), so compare outcomes, not exact counts. Sub-project 3 of
`ai-trading/plans/subplans/01n-vibe-research-quality.md` turns these prompts into a scored golden set.

## Golden evaluation (manual; no production deployment)

Casebook, scorer and tests are public. Raw answers, judge replies, tool trails and runtime homes stay in scratch **outside this repository**. Run with a venv containing the fork's locked dependencies and `httpx`; no new provider signup, Jina Reader or broker connection is needed. Never put an env file or a key in `ai-trading/`. `F18` asks a hypothetical question, **not** for an executable trade. Before starting, inspect `CLOUDSDK_ACTIVE_CONFIG_NAME=personal python3 common/config/family_config.py keys ai-trading/vibe-trading` (names only); stop if it contains any broker credentials. Do not run a live-order prompt.

From the repository root, start an isolated server per model. This override runs **after** Firestore injects the production profile and never writes Settings/Firestore. Use distinct `PORT` and `HOME_DIR` for `gpt-6.1-sol` and `gpt-5.5`; keep both servers running until their fixed and rolling batches finish.

```bash
ROOT=$(git rev-parse --show-toplevel)
SCRATCH=/private/var/folders/_1/050mzm_167bd175pmv0rfhz40000gn/T/opencode/vibe-golden
: "${VENV:?set VENV to an existing Vibe virtualenv}"
mkdir -p "$SCRATCH"
MODEL=gpt-6.1-sol
PORT=18911
HOME_DIR="$SCRATCH/home-$MODEL"
mkdir -p "$HOME_DIR"
(
  cd "$ROOT/ai-trading/packages/vibe-trading/agent"
  CLOUDSDK_ACTIVE_CONFIG_NAME=personal python3 "$ROOT/common/config/family_config.py" run ai-trading/vibe-trading -- \
    env -u API_AUTH_KEY HOME="$HOME_DIR" VIBE_TRADING_HOME="$HOME_DIR/.vibe-trading" \
    LANGCHAIN_MODEL_NAME="$MODEL" LANGCHAIN_REASONING_EFFORT=xhigh \
    PATH="$VENV/bin:$PATH" PYTHONPATH="$PWD" \
    python "$ROOT/ai-trading/deploy/upstream/vibe-trading/start-vibe.py" vibe-trading serve --host 127.0.0.1 --port "$PORT"
) >"$SCRATCH/server-$MODEL.log" 2>&1 &
SERVER_PID=$!
for attempt in $(seq 1 45); do
  curl -fsS "http://127.0.0.1:$PORT/settings/llm" >/dev/null && break
  sleep 2
done
curl -fsS "http://127.0.0.1:$PORT/settings/llm" >/dev/null
```

Run **both fixed cohorts first**, then each model's rolling cohort. Swap `MODEL`, `PORT` and `HOME_DIR` for the second server. Start rolling batches within two hours of each other in one US market session for a head-to-head comparison; if not, report them separately. Each case writes atomically as it finishes; a nonzero exit lists incomplete IDs, which remain on disk for inspection/reruns. Preserve a previous scratch result before reusing `--only ID`.

```bash
"$VENV/bin/python" "$ROOT/ai-trading/tools/vibe-eval/run_scenarios.py" "$SCRATCH/$MODEL" \
  --base "http://127.0.0.1:$PORT" --cases "$ROOT/ai-trading/tools/vibe-eval/golden_cases.json" \
  --expect-model "$MODEL" --expect-effort xhigh --timeout-min 90 \
  --only F01,F02,F03,F04,F05,F06,F07,F08,F09,F10,F11,F12,F13,F14,F15,F16,F17,F18

"$VENV/bin/python" "$ROOT/ai-trading/tools/vibe-eval/run_scenarios.py" "$SCRATCH/$MODEL" \
  --base "http://127.0.0.1:$PORT" --cases "$ROOT/ai-trading/tools/vibe-eval/golden_cases.json" \
  --expect-model "$MODEL" --expect-effort xhigh --timeout-min 90 \
  --only R01,R02,R03,R04,R05,R06,R07

"$VENV/bin/python" "$ROOT/ai-trading/tools/vibe-eval/score_golden.py" \
  "$ROOT/ai-trading/tools/vibe-eval/golden_cases.json" "$SCRATCH/$MODEL" \
  --runs-dir "$HOME_DIR/.vibe-trading/runs" --swarm-runs-dir "$HOME_DIR/.vibe-trading/swarm/runs" \
  --out "$SCRATCH/$MODEL-scored" --expect-model "$MODEL" --expect-effort xhigh --judge
```

Only hand-reviewed, non-sensitive **aggregate** findings may enter `plans/subplans/`; never commit `report.json`, saved sessions, raw judge replies or private tool arguments. Fixed leaderboard requires all 18 completed cases and both valid judges per case. Rolling single-source numbers remain `unknown`; tool call counts are observational, not proof that a tool caused a better answer. Offline check: `"$VENV/bin/python" -m pytest ai-trading/tools/vibe-eval -q -p no:cacheprovider`.
