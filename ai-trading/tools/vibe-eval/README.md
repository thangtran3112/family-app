# vibe-eval

Small developer tools for judging Vibe-Trading's US-stock research on a local server. They drive the
public session API only, so they work against any Vibe server, local or deployed.

| File | What it does |
|---|---|
| `serve_local.sh` | Starts a local Vibe-Trading server from this checkout with the production profile's environment (Firestore `ai-trading/vibe-trading`) in a sandboxed home directory. |
| `run_scenarios.py` | Sends the sample research prompts (`S01` to `S15`) to fresh sessions, waits for each answer (10 to 30 minutes is normal at `xhigh`) and saves the prompt, summary and stored messages as JSON. |
| `grounding_report.py` | Says how each run ended: clean, figures flagged `(unverified※)`, figures cut `(omitted※)`, or the canned stub; with drafts rejected, issues raised and `web_search` / `get_stock_profile` calls. |

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
