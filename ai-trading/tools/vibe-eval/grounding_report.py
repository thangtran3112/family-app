"""Say how each scenario run ended: clean, figures flagged, figures cut, or the canned stub.

usage: python grounding_report.py RESULTS_DIR RUNS_DIR
  RESULTS_DIR  the OUT_DIR that run_scenarios.py wrote (S*.json)
  RUNS_DIR     the server's run directory (VIBE_TRADING_HOME/runs), which holds each run's
               artifacts/grounding_evidence.json

Columns: drafts the gate rejected, issues it raised over them, figures marked `(unverified※)`,
figures cut to `(omitted※)`, the outcome, the answer's length, and how often the run called
`web_search` and `get_stock_profile`. A run whose artifact is missing reports 0 drafts and issues.
"""
import collections, glob, json, os, re, sys

STUBS = (
    "I rejected the previous draft",
    "My previous answer was rejected by the verification gate",
    "My answer did not pass the figure check",
    "I could not safely lock the instrument identity",
)


def classify(text: str) -> tuple[str, int, int]:
    body = re.split(r"(?m)^※\s", text, maxsplit=1)[0]
    flagged = body.count("(unverified※)") + body.count("（未核验※）")
    cut = len(re.findall(r"\(omitted※\)|（略※）", body))
    if any(stub in text for stub in STUBS):
        return "STUB", flagged, cut
    if flagged:
        return "FLAGGED", flagged, cut
    return ("CUT" if cut else "clean"), flagged, cut


def main(results_dir: str, runs_dir: str) -> None:
    print(f"{'run':18}{'drafts':>7}{'issues':>7}{'flagged':>8}{'cut':>5}  {'outcome':9}{'chars':>6}{'web_search':>11}{'profile':>8}")
    for path in sorted(glob.glob(os.path.join(results_dir, "S*.json"))):
        data = json.load(open(path))
        answers = [m for m in data["messages"] if m["role"] == "assistant"]
        if not answers:
            print(f"{data['scenario']['id']:18} no answer")
            continue
        answer = answers[-1]
        run_id = (answer.get("metadata") or {}).get("run_id")
        artifact = os.path.join(runs_dir, str(run_id), "artifacts", "grounding_evidence.json")
        validations = json.load(open(artifact)).get("validations", []) if os.path.exists(artifact) else []
        outcome, flagged, cut = classify(answer["content"])
        tools = collections.Counter(t["tool"] for t in answer.get("tool_trail") or [])
        issues = sum(len(v.get("issues", [])) for v in validations)
        print(
            f"{data['scenario']['id']:18}{len(validations):7}{issues:7}{flagged:8}{cut:5}  {outcome:9}"
            f"{len(answer['content']):6}{tools['web_search']:11}{tools['get_stock_profile']:8}"
        )


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
