# Family Desk defect log

Bugs found in live Desk walkthroughs. The owner reviews this file; fixed bugs stay here with their fix commit.

| ID | Date | Area | Severity | Finding | Status | Fixed-in |
|---|---|---|---|---|---|---|
| D-001 | 2026-10-25 | Practice / daily list | P2 | `/practice/day?id=1` (plan filters Abnormal volume + Gap up, list 08:30 premarket): universe shows Abnormal volume matches 0 of 17. Its arm rule is "At each 15-minute close during regular hours", which cannot exist at 08:30, so the filter cannot match on this list. Repro: open `/practice`, click Start Day 1, read the Practice universe line. Likely cause from code read of `core/evaluate.py` `_points` (not run). Checked later: the scan does run at 08:30, but on the previous session's last 15-minute bar ("Prev" columns), not on the morning. The server now answers 422 on `screen.listAt` (earliest 10:00 for a 15-minute regular filter), and the form moves the list time up and disables earlier ones. | Fixed | a871510f, 6f1aa0ff |
| D-002 | 2026-10-25 | Practice / arm rail | P2 | `/practice` "ARM STRATEGIES" reads "0 armed" while the daily-plan card reads "Abnormal volume · Gap up" and `/practice/day?id=1` lists those two filters. Repro: with plan 1 saved, open `/practice` and compare the card line with the arm rail count (plan `setup.armed` is empty). | Fixed | 6f1aa0ff |
| D-003 | 2026-10-25 | Practice / hub labels | P2 | `/practice` daily form: section header says "Start day" but submit says "Save plan", and the form warns "A new plan replaces this one". Days open from the card's "Start Day 1" (then "Continue"), next to the per-symbol "Start practice" form, so a first-time user cannot tell which control starts the daily list. Repro: click "New plan" (do not submit), read the form. | Fixed | 6f1aa0ff |
| D-004 | 2026-10-25 | Practice / day route | P2 | `/practice/day` with no id, while plan day 1 is open (status listed), shows "No practice day selected" with only "Open Practice". No link or redirect to the open day. Repro: load `/practice/day` with day 1 open. | Fixed | 6f1aa0ff |
| D-005 | 2026-10-25 | Practice / day list copy | P3 | `/practice/day?id=1` with 0 matches shows "Only 0 names matched · add a filter or lower its threshold". "Only 0" contradicts itself, and this screen has no threshold control. Repro: open `/practice/day?id=1` on a day with 0 matches. | Fixed | a871510f, 6f1aa0ff |
| D-006 | 2026-10-25 | Practice / universe | P1 | The first practice day scanned 17 of 17 symbols and matched none. Production `universe_symbols` held 0 rows (the weekday premarket pass had never run after a weekend deploy), so a new plan froze only the 17 seed symbols. The empty Gap up result itself was a real quiet morning (largest premarket gap -0.12% at 08:14 in the stored blobs). A new plan now builds the Desk universe first (245 plain tickers, 133 above the $5 and 500,000-share floor on 2026-10-25). Repro: save a plan on a fresh install and read the Practice universe line. | Fixed | a871510f |
| D-007 | 2026-10-25 | Practice hub | P2 | The PLAN/risk block (Shares, Stop on every entry, Trade only on a signal, Max loss, Max trades, Plan note) sits inside the daily-list filter setup - risk settings are thread-level, not per-day filter concerns (owner). Fixed by the 02r practice-threads phase, not patched in place. | Fixed (backend; the web form drops the block in the 02r web stream) | e43a0d05, 0003b38b |

## Conventions

- **Severity:** P0 wrong money, data, or trading figure shown as true, or a secret or security leak. P1 a core flow is broken with no workaround. P2 wrong or confusing, with a workaround. P3 cosmetic or copy.
- **ID:** `D-001`, `D-002`, ... in the order found. Never reuse an ID.
- **Route and repro:** every finding names the route (for example `/practice/replay?id=`) and the steps to reproduce it.
- **Status:** Open, Fixed, or Won't fix. Fixed bugs keep their row and fill Fixed-in with the fix commit hash. Do not delete rows.
- **Dates:** `YYYY-MM-DD`.
- **Secrets:** never put secrets, email addresses, account numbers, or VPS addresses in this file.
