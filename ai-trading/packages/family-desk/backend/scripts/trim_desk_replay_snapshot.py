"""Trim the R0 replay snapshot (`temp/desk-replay-mvp/`, gitignored) to the committed fixtures in
`tests/fixtures/desk-replay/` (02o §f step 3c): one replay day (TSLA, Fri 2026-09-25), the first
15 minutes of its consolidated prints, and the spoiler-free notable-days table.

    uv run python scripts/trim_desk_replay_snapshot.py <path-to-desk-replay-mvp-folder>

Real market data, no provider payload and no secret. The day file keeps the extended-session
1-minute bars of the day, the 10 prior sessions of 1-minute bars (indicator warm-up), and 300 daily
bars, all raw (unadjusted). The prints file keeps rows `[t_us, price, size, exchange, conditions]`.
"""

import gzip
import json
import sys
from pathlib import Path

DAY_ID = "tsla-1"
PRINTS_FILE = "prints-TSLA-2026-09-25.json.gz"
PRINTS_END_US = 10 * 60 * 1_000_000  # first 15 minutes after the 09:30 ET open
OUT = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "desk-replay"


def write_gz(path: Path, data: object) -> None:
    path.write_bytes(gzip.compress(json.dumps(data, separators=(",", ":")).encode(), mtime=0))


def main(folder: Path) -> None:
    snapshot = json.loads((folder / "snapshot-practice-2026-10-23.json").read_text())
    day = next(entry for entry in snapshot["replay_days"] if entry["id"] == DAY_ID)
    kept = {
        key: day[key]
        for key in ("symbol", "day", "weekday", "window", "prior_close", "bars_1m", "prior_bars_1m", "daily_300")
    }
    write_gz(OUT / "day-tsla-2026-09-25.json.gz", kept)

    prints = json.loads(gzip.decompress((folder / PRINTS_FILE).read_bytes()))
    first = prints["rows"][0][0]
    rows = [[r[0], r[1], r[2], r[3], r[4]] for r in prints["rows"] if r[0] - first < PRINTS_END_US]
    write_gz(OUT / "prints-tsla-2026-09-25.json.gz", {"feed": prints["feed"], "rows": rows})

    notable = snapshot["notable_days"]
    kept_notable = {
        "lookback_sessions": notable["lookback_sessions"],
        "symbols": notable["symbols"],
        "days": {
            symbol: [
                {k: entry[k] for k in ("symbol", "day", "weekday", "rank", "rv", "rv_pct_rank", "gap_pct", "tags")}
                for entry in entries
            ]
            for symbol, entries in notable["days"].items()
        },
    }
    (OUT / "notable_days.json").write_text(json.dumps(kept_notable, indent=1) + "\n")


if __name__ == "__main__":
    main(Path(sys.argv[1]))
