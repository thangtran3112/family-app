# Family Desk defect log

Bugs found in live Desk walkthroughs. The owner reviews this file; fixed bugs stay here with their fix commit.

| ID | Date | Area | Severity | Finding | Status | Fixed-in |
|---|---|---|---|---|---|---|

## Conventions

- **Severity:** P0 wrong money, data, or trading figure shown as true, or a secret or security leak. P1 a core flow is broken with no workaround. P2 wrong or confusing, with a workaround. P3 cosmetic or copy.
- **ID:** `D-001`, `D-002`, ... in the order found. Never reuse an ID.
- **Route and repro:** every finding names the route (for example `/practice/replay?id=`) and the steps to reproduce it.
- **Status:** Open, Fixed, or Won't fix. Fixed bugs keep their row and fill Fixed-in with the fix commit hash. Do not delete rows.
- **Dates:** `YYYY-MM-DD`.
- **Secrets:** never put secrets, email addresses, account numbers, or VPS addresses in this file.
