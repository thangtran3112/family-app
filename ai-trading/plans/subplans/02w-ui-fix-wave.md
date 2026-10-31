# 02w: UI fix wave (122-finding visual audit, streams F1 to F6)

Status: **planned 2026-11-01; audit done, no fix started.** STATUS row 6B. Source: `runs/frontend-modes-audit-20261031/consolidated-findings.md` in the Hermes run directory (outside the repo), with per-surface `findings-v-*.json` / `notes-v-*.md` and screenshots in the frontend `.screenshots/v-*` (git-ignored).

Audit: 7-surface browser pass (1440x900) found **122 findings (18 P1, 63 P2, 41 P3)**; 7 code-read audits added 136 more. Per-surface P1/P2/P3: Technicals 5/9/6, Screener 4/8/7, Today 3/6/5, Watchlists 3/11/5, Fundamental 2/8/6, Alerts 1/11/9, Strategies 0/10/3.

Scope: UI/UX only. No market-data, provider or data-source file (another session owns the centralization, [02u](02u-central-market-data-api.md)); stale data is shown honestly, not repaired here. The mode cutover ([02v](02v-global-modes-cutover.md)) is a separate track. Paths are under `ai-trading/packages/family-desk/frontend/`. Stream ids F1 to F6 use ids from the audit files (`V-<SURFACE>-nn`).

## Recurring root causes (fix as a class)

1. Contradicting freshness (feed-aged "45 min / 19 hr / just now" at once, prices that look live). 2. Left-rail table wider than its rail (~279 px). 3. Raw schema text shown to the user. 4. Scan/feed arithmetic inconsistencies. 5. Chart geometry. 6. State chips that over- or under-claim.

## Streams

| Stream | Findings | Files (starting points) |
|---|---|---|
| **F1 Freshness and market-status honesty** | Class 1 and the freshness half of 4: V-Today-01, V-Today-03, V-Watchlists-03, V-Technicals-02, V-SCR-01. One shared freshness/market-status component and honest copy; mark stale data as stale. | `components/shell/**` (shared chrome), `components/today/**`, `components/charts/MarketStrip*`, `lib/today/**` |
| **F2 Dense-table and rail geometry** | V-Today-02, V-Watchlists-02 (rail table wider than rail, CHG% clipped, TAG hidden), V-Watchlists-01 (strategy chips push row actions and "+ Alert" off-screen). | `components/shell/desktop/LeftRail.tsx`, `components/watchlists/**`, `lib/watchlists/**` |
| **F3 Screener scan truth and trader filters** | V-SCR-01..04 ("8 of 65" vs "Scanned 53", editor Live matches vs results, inert Regular/Extended toggle, "just now" on a stale feed) plus the owner's trader-standard-filter ask (A-Screener P1s). | `components/screener/**`, `lib/screener/**`, `e2e/desk/screener.spec.ts` |
| **F4 Technicals chart** | V-Technicals-01..05 (-6.72% on 1W vs -0.52% on 1D as "the stock's change", unknown symbol shown as "Quotes unavailable", 151 px price pane, "Chart data table" collapsing the chart to 23 px) plus the Webull/TradingView styles backlog. | `components/technicals/**`, `components/charts/**`, `lib/chart-data.ts` |
| **F5 Copy and errors** | V-ALERTS-01 (raw `List should have ... after validation` and JSON path; "Active" chip while paused), Strategies builder raw identifiers (`riskUsd`, `smoothK`), alert-only vs draft chip wording (P2). Plain-language error and label pass. | `components/alerts/**`, `components/strategies/**`, `components/builder/**` |
| **F6 Fundamental lane** | V-Fundamental-01 (Futures specs "Back to futures swing" dead-ends), V-Fundamental-02 (IBKR import hint is plain text, not a link), covered-calls risk-flag truncation. | `components/fundamental/**`, `e2e/desk/fundamental-*.spec.ts`, `e2e/desk/guards.spec.ts` |

F1 and F2 overlap `components/shell/**`; they share one PR or run in order. All other streams are independent and can run in parallel in separate worktrees.

## Rules

- **RED test first.** Every finding gets a failing unit or Playwright assertion that reproduces it before the fix (the screenshot is the evidence, the test is the guard); show it fails, then fix.
- Each fixed finding is logged in `DEFECTS.md` under a new id continuing the existing sequence; no renumbering of existing ids.
- Judge every change for the retail day-trader audience: clarity and honesty of state (ADR-0010).
- Desktop 1440 and 1180 only.

## Gates

Web typecheck and lint clean, unit tests, `test:export`, `check-static-export`, Playwright over the whole Desk suite at 1440 and 1180, and the dual-agent post-phase walkthrough (ADR-0009). One PR per meaningful batch (root `AGENTS.md`: conserve Actions minutes), not one per stream.
