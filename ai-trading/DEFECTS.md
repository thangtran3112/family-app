# Family Desk defect log

Bugs found in live Desk walkthroughs. The owner reviews this file; fixed bugs stay here with their fix commit.

| ID | Date | Area | Severity | Finding | Status | Fixed-in |
|---|---|---|---|---|---|---|
| D-001 | 2026-10-25 | Practice / daily list | P2 | `/practice/day?id=1` (plan filters Abnormal volume + Gap up, list 08:30 premarket): universe shows Abnormal volume matches 0 of 17. Its arm rule is "At each 15-minute close during regular hours", which cannot exist at 08:30, so the filter cannot match on this list. Repro: open `/practice`, click Start Day 1, read the Practice universe line. Likely cause from code read of `core/evaluate.py` `_points` (not run). | Open | - |
| D-002 | 2026-10-25 | Practice / arm rail | P2 | `/practice` "ARM STRATEGIES" reads "0 armed" while the daily-plan card reads "Abnormal volume · Gap up" and `/practice/day?id=1` lists those two filters. Repro: with plan 1 saved, open `/practice` and compare the card line with the arm rail count (plan `setup.armed` is empty). | Open | - |
| D-003 | 2026-10-25 | Practice / hub labels | P2 | `/practice` daily form: section header says "Start day" but submit says "Save plan", and the form warns "A new plan replaces this one". Days open from the card's "Start Day 1" (then "Continue"), next to the per-symbol "Start practice" form, so a first-time user cannot tell which control starts the daily list. Repro: click "New plan" (do not submit), read the form. | Open | - |
| D-004 | 2026-10-25 | Practice / day route | P2 | `/practice/day` with no id, while plan day 1 is open (status listed), shows "No practice day selected" with only "Open Practice". No link or redirect to the open day. Repro: load `/practice/day` with day 1 open. | Open | - |
| D-005 | 2026-10-25 | Practice / day list copy | P3 | `/practice/day?id=1` with 0 matches shows "Only 0 names matched · add a filter or lower its threshold". "Only 0" contradicts itself, and this screen has no threshold control. Repro: open `/practice/day?id=1` on a day with 0 matches. | Open | - |

## Conventions

- **Severity:** P0 wrong money, data, or trading figure shown as true, or a secret or security leak. P1 a core flow is broken with no workaround. P2 wrong or confusing, with a workaround. P3 cosmetic or copy.
- **ID:** `D-001`, `D-002`, ... in the order found. Never reuse an ID.
- **Route and repro:** every finding names the route (for example `/practice/replay?id=`) and the steps to reproduce it.
- **Status:** Open, Fixed, or Won't fix. Fixed bugs keep their row and fill Fixed-in with the fix commit hash. Do not delete rows.
- **Dates:** `YYYY-MM-DD`.
- **Secrets:** never put secrets, email addresses, account numbers, or VPS addresses in this file.
