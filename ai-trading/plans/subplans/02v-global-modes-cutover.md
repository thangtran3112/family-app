# 02v: Global UI modes cutover (Fundamental / Technical / Backtest)

Status: **delivered 2026-11-01.** PR #240 (`5527734a`) to `dev` shipped S and M together, released to `main` in #249 (`a6bd28b6`). Decision of record: [ADR-0014](../../decisions/adr/ADR-0014-global-ui-modes.md). STATUS row 6A. Design (531 lines, approved as written by Hermes 2026-10-31 with all 12 open questions resolved to their stated defaults) lives in the Hermes run directory `runs/frontend-modes-audit-20261031/design-modes-cutover.md` with `rulings.md`; it was not promoted into the repo. What actually shipped differs from the plan in one place and matches it everywhere else: the DS-1 menu work (`ui/Menu`, `ui/Popover`, `lib/desk/useDismiss.ts`) folded in here as ruled, so `ModeMenu`, `AvatarMenu` and `AlertsBell` all landed on the primitives.

Scope: presentation only. The market-data centralization ([02u](02u-central-market-data-api.md)) and the deployment-only CI change ([ADR-0013](../../decisions/adr/ADR-0013-ci-deployment-only.md)) belong to other sessions. All paths below are under `ai-trading/packages/family-desk/frontend/`.

## Contract (from ADR-0014)

- Three global modes, declared by routes/tabs/sections only, never per widget.
- Seam = four declarative tables in `lib/lanes.ts`: route to modes, tabs per mode, shell sections per mode, left-rail tabs. Longest prefix wins; a route opens in the first-listed mode when the current mode is not listed.
- Shared by Fundamental and Technical: Today, Watchlists, Futures specs, market pill, symbol search, alerts bell, Ask (no tab). Settings, More, Feedback, the switcher and the avatar show in all three.
- Backtest owns all `/practice/*`, `/backtests` (when real) and `/paper`, and shows **no market-status pill** (a live pill beside a replay clock is audit finding A4-02).
- The wrong-lane interstitial is deleted. `desk.lane` stays and gains `backtest` (no migration); the backend `default_view` setting gains one enum value.
- Switcher = full mode-name button opening a three-item menu, Alt+1/2/3. No chips.
- The internal type stays `Lane` (a rename touches about 15 files and changes no behavior); only visible copy changes ("View" to "Mode", "Default view" to "Default mode").

## Phase S (about half a day): the seam, behavior kept

Still two modes; nothing visible moves except defect fixes.

- `lib/lanes.ts`: `ROUTE_LANES` values become mode lists (`"shared"` becomes `[T, F]`); add `lanesForPath`, `modeFor`, `shows`, `LEFT_RAIL_TABS`, `SYMBOL_HREF`. `DeskUiProvider` derives the lane from the path. Switcher clicks navigate to `LANE_HOME`.
- Delete the interstitial; `/feedback` becomes ALL; the four shared-surface symbol callers use `SYMBOL_HREF`; drop `setLane` from `FuturesReadScreen`.
- `components/shell/desktop/` `TopBar`, `LeftRail`, `StatusBar` read `shows(...)` and `LEFT_RAIL_TABS`. With two modes the output equals today's, which proves the seam.
- Tests: `lib/lanes.test.ts` invariants (every page in every table, no tab outside its mode, longest-prefix, first-listed landing). e2e: replace `shell.spec.ts` "a Fundamental route shows the wrong-lane screen" with "an owned route opens in its mode"; update `fundamental-shell.spec.ts` ("Technical-only routes keep it" becomes "open in Technical").

## Phase M (about 1.5 to 2 days): Backtest and the switcher

- `Lane` gains `backtest`; `/practice`, `/backtests`, `/paper` move to B; `/ask` becomes `[F, T]`. Add `PRIMARY_NAV.backtest`, longest-match highlight, `LANE_HOME`, `LANE_SUMMARY`, the `LaneVariant` backtest branch.
- `ModeMenu` replaces `LaneSwitch`. `SECTION_LANES` gains the B gaps: no search, pill, freshness, bell, quote line or alerts state; the left rail shows Watchlists only; the status bar falls back to "Practice · past market data".
- Settings shows "Default mode" with three radios; backend `default_view` enum gains `backtest`.
- Practice leaves the Technical nav in the same commit that adds the Backtest nav, so no route is stranded.
- e2e: `shell.spec.ts` View-chips test becomes a mode-menu test, nav list drops Practice, add a Backtest nav test; `fundamental-shell.spec.ts` radio clicks become menu picks asserting the button name "Mode: ..."; `settings.spec.ts` "Default mode" with a Backtest radio; `practice.spec.ts` unchanged.

## Phase 3 (polish, rides with the next practice PR; not part of the cutover PR)

`ThreadSidePanel` as the left rail on `/practice/thread` and `/practice/week`; cross-mode link labels and the mode-aware Futures specs back link; Alt+1/2/3; Backtest purity scan; unread alerts count on the menu's Technical item while in B. Later moves between modes are one table row plus one test each.

## Acceptance

- S and M ship as **ONE pull request** (separate commits; S is safe alone if M slips).
- Radiogroup/menu specs pass at 1440 and 1180; no wrong-lane interstitial anywhere; every route and deep link still reachable; Backtest shows no market pill.
- Gates: web typecheck and lint clean, unit tests incl. `lib/lanes.test.ts`, `test:export`, `check-static-export`, Playwright over the Desk suite at 1440 and 1180.
- Paper mocks already reflect the modes (TobyTest, 33 boards edited, 1 new `YQX-0` Fundamental Watchlists, 4 boards skipped as nonexistent).

## Sequencing

Starts before or after the fix wave ([02w](02w-ui-fix-wave.md)). Streams F1 and F2 touch shell chrome (`components/shell/**`); if both are open, land the cutover first or rebase F1/F2 onto it.
