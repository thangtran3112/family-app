# ADR-0014: Global UI modes — Fundamental / Technical / Backtest

Status: accepted 2026-11-01 (owner directive + Hermes review of `design-modes-cutover.md`). Source: the mode-cutover
design in `runs/frontend-modes-audit-20261031/design-modes-cutover.md` (to be promoted into `plans/subplans/` with
the S/M cutover phase).

Decision: the Family Desk frontend is split into **three global UI modes — Fundamental, Technical, Backtest** — scoped
by a **declarative route/tab/section seam**, deliberately tabs/sections/routes only, not a per-widget registry.
Backtest owns Practice plus the future backtesting surface. Some segments stay shared across Fundamental and
Technical rather than being a strict partition.

Key rulings that hold:

- **Seam** = four declarative tables in `lib/lanes.ts` (route→modes, tabs-per-mode, shell-sections-per-mode,
  left-rail tabs). Shell parts look these up instead of hardcoding the mode. A link to another mode's route opens it
  in its first-listed mode, so the **wrong-lane interstitial is deleted**. CI fails if a page is missing from a table
  or a tab points outside its mode.
- **Shared (Fundamental + Technical):** Today, Watchlists, Futures specs, the market-status pill, symbol search, the
  alerts bell. **Ask** is shared with no tab. Settings / More / Feedback and the mode switcher are in all three.
- **Backtest** shows **no market-status pill** — a live pill next to a replay clock is the two-clocks confusion
  measured in audit finding A4-02.
- **Switcher** = button with the full mode name → three-item menu, Alt+1/2/3 (full words, not chips).
- **Storage:** the `desk.lane` key stays and gains `backtest` (no migration). The backend `default_view` setting gains
  one value.
- **Cutover:** S (seam in, two modes, zero visible change) + M (Backtest + switcher + per-mode shell) ship in ONE PR;
  S-size polish only. Each later move between modes is one table-row edit.

Consequences: rework of `lib/lanes.ts`, `components/shell/desktop/` (LaneSwitch→mode switcher, PrimaryNav, rails),
and the route map; 38 Paper mock boards edited + 1 new (Watchlists in Fundamental, `YQX-0`) on 2026-10-31;
Backtest-mode labels replace the old Technical-lane labels on Practice routes.