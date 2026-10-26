# 02r2: Practice hub redesign (landing table, New plan modal, thread page)

Status: built 2026-10-26 on `feature/desk-practice-redesign`. Desk lane, frontend only: no backend, contract or migration change; every endpoint the screens call already existed.

See also: [02o](02o-desk-replay-practice-plan.md) (the hub this replaces, §a2), [02r](02r-desk-practice-threads.md) (threads: balance, plan, one active thread per mode), [02p](02p-swing-practice.md) (swing threads).

## Mock boards

Paper, Family Desk file. The boards are the target; the deviations below are deliberate.

- `LEW-0` "R3 · Practice · Hub · desktop" (1440): header "Practice" with a primary "New plan" button, a table of threads (Thread, Balance with SIMULATED, Days, Skipped, Win rate, Last day, Action), the closed threads below, and four states under the table (loading, preparing data, no threads, error). No notable-days table, no session setup, no right rail.
- `X9Y-0` "New plan modal" (1440×1104, x 7804.999, y 47200): a centered modal over a dimmed landing. Starting balance and mode, a vertical list of filter checkboxes, the date controls, list time, window, arm strategies, the risk plan, and a primary "Populate data" button with a loading state.

## Routes

| Route | Screen | Notes |
|---|---|---|
| `/practice` | `PracticeLanding` | Only the header, New plan and the thread table. |
| `/practice/thread?id=` | `ThreadOverview` | New. Where she lands after New plan and returns to between days. |
| `/practice/day`, `/practice/replay`, `/practice/journal`, `/practice/week` | unchanged | |

**Route decision.** The thread page is a new static-export route with the id in the query string (like `/practice/day?id=5`), not a dynamic segment: the export has no server. It is added to the uploader allowlist (`deploy/ci/upload-hub-static.sh` and its fixture test), `export-layout.test.mjs` and the feedback screen labels (`Practice · Thread`).

## Landing table

One `<table>` (`ThreadTable`), the active threads first (day, then swing), the closed ones below.

| Column | Content |
|---|---|
| Thread | Name, mode chip, Active tag or Closed chip. A swing row carries its card line under the name ("Swing · 50 names · Week 2 of 4 · Day 7 of 20 · …"). |
| Balance | The balance with SIMULATED; a swing row adds "Equity $…". |
| Days, Skipped, Win rate | The thread's stats. |
| Last day | Today's line while a day is open, else the last ended day (`todayView`, D-030, D-048). Dropped at the 1180 band. |
| Action | `ThreadAction` plus Open journal and Overview links. |

`ThreadAction` is the old thread card's resume logic, shared with the thread page: a day thread opens today's open day (Continue link), or the plan's next day (a button that calls `POST /replay/daily/next` through `whenReady`), or reads "Preparing data · x of y" while the plan's data is prepared, or "New plan needed" (a button that opens the modal for that thread). A swing thread uses the existing `SwingContinue` and week-review link. A closed thread has the journal only. The page keeps the old loading, error and no-threads states (`PRACTICE_COPY`), polls every 4 s while a plan is preparing, and refetches when an action changes a thread.

## New plan modal

A native `<dialog>` (`showModal`): focus stays inside, the page behind is dimmed and inert, Escape, Close and a click on the backdrop close it, and focus returns to New plan. One form replaces `NewThreadForm` and `DailyPlanForm`:

1. Starting balance (USD, default 50,000, min 1,000, max 10,000,000, SIMULATED) and Mode (Day trading or Swing; the taken mode is disabled with its note, via `openModes`).
2. Filters from `GET /screener/filters`: one vertical column of checkboxes, each with its run time and session as muted text and a Preset or Yours chip, "Pick up to 3 filters" (`MAX_FILTERS`). Picking a filter arms it and moves the list time for a cadence filter, as before.
3. First day (with the recorded-day note from `GET /replay/universe-days`), Days (5, 10, 20, 30), Names a day (1 to 5), Hide dates.
4. List time (8:30, 10:00, 10:45) and list size (20 to 50, default 30).
5. Window (ET): From, To and the interval (1m, 5m, 15m).
6. Arm strategies, then the risk plan (stop on every entry, trade only on a signal, max loss, max trades, note), open, not collapsed: the thread cannot be created without it.
7. Footer: "Nothing reaches IBKR · All money is SIMULATED", a one-line note (why the button waits, or what the thread starts with) and the primary button.

**Submit.** "Populate data" validates with `validateThreadDraft` and `validatePlanDraft` (field messages under their fields, the contract's max-loss rule included), then `POST /replay/threads`, then the plan through `savePlanPatiently` (`POST /replay/daily/next` with `threadId`, the gateway-cut retry from D-058), then goes to `/practice/thread?id=`. The button shows a spinner and "Populating data…"; a slow gateway shows "Still preparing your day". If the thread is created and the plan fails, the thread id is kept, so a retry saves the plan instead of creating a second thread (a second one would be a 409).

**Plan only.** Opened with a thread (from "New plan needed" or the thread page's Replace plan), the modal is titled "New plan for <thread>" and asks only for the plan: the balance, mode and risk plan stay with the thread. This keeps the old "replace the plan" feature, which the landing's New plan button alone could not offer.

**Swing.** With Swing picked the daily fields give way to the existing swing setup section (days, universe builder, swing plan) with the risk plan inside it, and the button reads "Start swing thread". The universe preview, which starts the data prepare, runs only while Swing is the mode, so opening the modal in Day mode asks for nothing.

## Thread page

`/practice/thread?id=` reads `GET /replay/threads/{id}` and `GET /replay/daily`. It shows the name, mode and status, the balance with SIMULATED, the stats (days practiced, skipped, win rate, adherence), a "Practice day" panel (today's day with Continue, or the last ended day with Next day, or "New plan needed"; a fresh thread says Day 1 is next; a swing thread shows its card line, equity, week and day, and the week-review link), the thread's plan card ("Day 2 of 5 · next: Mon", the filters, what is armed) with Replace plan, and the journal link. An unknown or missing id says so in plain words.

## Loading design

The mock puts the loading states on a side card; the app shows them where they happen: the table's loading and error blocks on the landing, the spinner and label on the Populate data button, "Preparing data · x of y" in a row's Action cell and the thread page's plan card, and the "still working" line when the gateway cuts a call short.

## Deliberate deviations from the mock

- Loading states are inline (button, row, plan card), not a separate card.
- The landing table has an Overview link beside Journal, and a plan-only modal, so a plan can be replaced and a thread without a plan can get one.
- The Last day column is dropped at 1180; closed threads share the table instead of a second block.
- Swing keeps its own submit label ("Start swing thread") and its universe section inside the modal.
- Removed from the Practice page, with no replacement: single-session setup, notable days and the Resume and Recent rail. Single sessions stay reachable by URL (`/practice/replay?id=`) and through day lists; the endpoints are unchanged.

## Removed and kept

Removed: `PracticeHub`, `SessionSetup`, `NotableDaysTable`, `ResumeCard`, `RecentSessionsTable`, `ThreadsSection`, `ThreadCard` and `ClosedThreadCard`, `SwingThreadCard`, `NewThreadForm`, `DailyPlanForm`, `DailyListCard`. Kept and reused: `ArmStrategiesField`, `SwingContinue`, `SymbolField` (the swing universe builder), `ThreadPlanFields`, the swing setup section, `SimulatedBadge`, the draft validators, `whenReady` and `savePlanPatiently`, and the shell's `RightRail` for the other screens.

## Tests

- `e2e/desk/practice-landing.spec.ts` (new) and `e2e/desk/hub-helpers.ts`: the landing, the modal (one-column filters, bounds, validation, three ways to close), Populate data to the thread page and Day 1, plan-only replace, and the unknown-thread message. The older Practice, switch and swing specs start threads through the modal or the API and sessions through the API.
- `pnpm test` (node): copy banned-word checks cover the new `PRACTICE_COPY` keys; `export-layout.test.mjs` and `upload-hub-static.test.sh` cover the new route.
