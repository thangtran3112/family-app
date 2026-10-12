# Phase 3: Runtime and Alerts

Part of [02c-desk-v1-implementation-plan.md](../02c-desk-v1-implementation-plan.md). Read its Global
Constraints, Review Focus, and Shared Interfaces first. Builds on
[Phase 2a](phase-2a-data-without-ibkr.md) (`ai_trading.db`, `ai_trading.data`, `ai_trading_common`)
and Phase 1's evaluator (`ai_trading.core.evaluate`). **This is the first Desk code that reaches
`main`/production.**

This plan's code blocks are the files of a finished, integrated, fully-tested prototype tree
(`ai-trading/temp/p3-proto/final/`, not committed), built lane-by-lane from
`ai-trading/temp/p3-proto/PROTO-BRIEF.md` and integrated per
`ai-trading/temp/p3-proto/final/INTEGRATION-REPORT.md`. Every ruling in
`ai-trading/temp/plan-writing-ledger-2a.md`'s Phase 3 entries is already applied in the code below.
One more fix was applied on top of that integrated tree before this plan was written: `/healthz`
is now a real readiness probe (INTEGRATION-REPORT.md §6, open question 3) — see Task 3.7.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use
> checkbox (`- [ ]`) syntax for tracking. Subagents work in a `.worktrees/` worktree on their own
> `feature/*` branch; the main session merges that branch into `feature/toby` (root `AGENTS.md`).

**Goal:** give the Desk a running `api` and `scheduler`, live-enough strategy evaluation, alert
delivery (inbox, Telegram, Slack), and a first production deploy — all on top of Phase 2a's data
foundation. No IBKR in this phase (D-c): every `bar_close_*` cadence on a stock runs against
Alpaca's delayed bars and is always degraded; on a future it never fires at all (`unavailable`);
`premarket_0830`/`daily_close`/`weekly` run on daily/hourly bars and are never degraded by the lack
of a streaming slot. There is no true per-minute "bar close" event in this phase — the engine
re-evaluates on a 60-second wall-clock tick over whatever is already in Postgres, and catch-up
safety falls entirely out of `evaluate()`'s own "report every candidate closed by `as_of`" design
plus `signals`' unique constraint, not out of any streaming machinery.

**Architecture:**
- **`ai_trading.db`** gains 8 new tables (Alembic `0002`): `users`, `watchlists`,
  `watchlist_items`, `strategies`, `strategy_versions`, `signals`, `alerts`, `deliveries`. No
  `iv_daily`/`consensus_snapshots`/`order_intents`/`fills` yet (Phase 2a's own D3 ruling: "a table
  arrives with the phase that first needs it" — those move to Phases 5 and 6).
- **`ai_trading.notify`** (new package): one `Channel` Protocol, `TelegramChannel`/`SlackChannel`
  implementations, secret redaction, cooldown dedupe (system alerts only — strategy signals dedupe
  through the database), quiet hours, and `dispatch_pending`.
- **`ai_trading.engine`** (new package): data-quality labelling (`degraded.py`), the signal outbox
  (`outbox.py` — one transaction per signal: `signals` row + `alerts` row + one `deliveries` row
  per channel), the 60-second tick (`tick.py`), and the pure watchlist card-back function
  (`cardback.py`, no new table).
- **`ai_trading.jobs`** (new package): the scheduler's named jobs (`premarket`, `daily_close`,
  `weekly`, `refresh_15m`, `backfill_watchlist`, `watchdog`, `relogin_reminder`) and the
  `scheduler` process entrypoint.
- **`ai_trading.api`** (new package): FastAPI, gateway-verified identity, REST under
  `/api/desk/*`, SSE quotes, two background loops (`tick` every 60s, `dispatch_pending` every
  10s), and the one served entrypoint `ai_trading.api.main:app`.
- **Deploy:** a new Dockerfile (one image, two entrypoints — `api`/`scheduler` pick their command),
  a `desk` bake target, two new compose services joining the **shared** VPS Postgres cluster (owner
  decision 2026-10-12, D-e — no `desk-postgres` container), a Caddy route for `/api/desk/*`, the
  Desk's own Postgres role/schema onboarding script, and a startup-retrying, heartbeat-checked
  `scheduler` process. Registering `api`/`scheduler` with the Trading Hub's app-controls catalog so
  they actually get started — a finding from writing this plan, not anticipated by the brief — is
  **APPROVED 2026-10-12** (Decision 5): it edits the open-source lane's shared control files, so it
  ships as a separate follow-up PR (`feature/ai-trading-desk-decision5`), not inside the Phase 3 PR.

**Tech Stack:** adds to Phase 2a's stack: FastAPI, `uvicorn[standard]`, `sse-starlette`,
`requests` (direct dependency now — Phase 2a only reached it transitively through
`ai-trading-common`). No new frontend dependency (Phase 4 builds the UI).

**Spec:**
- [02c](../02c-desk-v1-implementation-plan.md): Global Constraints, Review Focus, Shared
  Interfaces, Phase 3 outline
- [02-release-2-desk-design.md](../02-release-2-desk-design.md) §4.3, §7, §8, §11, §12
- [02a-desk-v1-strategies-design.md](../02a-desk-v1-strategies-design.md) §4, §5, §7, §9, §10, §13
- [02b-desk-market-data-options.md](../02b-desk-market-data-options.md) §5
- [02j-common-data-providers-design.md](../02j-common-data-providers-design.md)
- `ai-trading/AGENTS.md`: hostnames, secrets, Firestore, "Our Code", release rules

Source material (not committed; the prototype trail behind this plan):
`ai-trading/temp/p3-proto/PROTO-BRIEF.md`, `ai-trading/temp/p3-proto/lanes/L1..L6/REPORT-L*.md`,
`ai-trading/temp/p3-proto/final/INTEGRATION-REPORT.md`, and
`ai-trading/temp/plan-writing-ledger-2a.md`'s Phase 3 entries.

## Global Constraints

Everything in 02c's Global Constraints applies. Scoped to Phase 3:

- **Closed bars only.** No rule ever evaluates a forming bar (already enforced by Phase 2a's
  `bars.upsert_bars`/`read_bars` and `core.evaluate.evaluate`; this phase adds no new bar-reading
  path around them).
- **Signal dedupe key:** `(strategy_version_id, symbol, bar_time)`, unique in `signals`. A restart
  re-evaluating an already-signaled bar is a no-op, not an error and not a duplicate alert.
- **Unknown data neither fires nor resets** (already in `evaluate()`; unchanged here).
- **Degraded strategies alert but place no paper orders.** There is no paper-order code in this
  phase, so the constraint is honored by recording the right `data_quality` on every signal, for
  Phase 6 to read later — not by any gate this phase itself enforces.
- **Data-quality labels on every number:** `realtime`, `delayed-15m`, `eod`, `fallback`,
  `unavailable`.
- **Stages:** `draft`, `alert_only`, `paper`. No `live_confirm`/`live_auto` code path anywhere.
- **Schedules:** America/New_York, on exchange trading days (XNYS calendar via
  `ai_trading.core.calendar`). Timestamps stored in UTC.
- **Secrets:** read only via `family_config.py`; a channel's token/webhook URL is never logged, put
  in an exception message, or written to `deliveries.error` unredacted. `/healthz`'s error path
  never returns a real error string or the database URL (Task 3.7).
- **Public repository:** no balances, account numbers, emails, or VPS addresses in any file.
- **Python:** 3.12, uv, ruff (line length 120, `E, F, I, B, UP`), pytest. Tests never touch the
  network: `TelegramChannel`/`SlackChannel` take an injectable `post`; provider-backed jobs take an
  injectable `DataSources`/`BarsSource` fake.
- Commits are one line, with no trailer. Do not push until a task's own commit step says to.

## Decisions for Owner Review

Most consequential first. Each names the alternative considered and the reason for the choice
actually shipped. Items 1–4 and 15–16 are owner-level (money, data correctness, production
trust-boundary, release-scoping); Item 5 is also owner-level and was **APPROVED on 2026-10-12**; it
edits the open-source lane's shared app-controls files and ships in its own follow-up PR; the rest are
lane-level implementation choices the integration carried forward, surfaced here because nothing
earlier in the plan chain pinned them.

1. **The Desk's database joins the shared VPS Postgres cluster — no `desk-postgres` container
   (D-e, APPROVED 2026-10-12).** Alternative: a Desk-private Postgres container, like Phase 2a's
   own first draft assumed. Reason: `infrastructure/vps/steps/30-postgres.sh` is the house design
   — one shared `family-app-postgres` cluster per VPS, each app onboarding its own database/role
   via an idempotent init script, to save VPS RAM. The Desk onboards the same way: database
   `ai_trading_desk_db`, roles `desk_migrator`/`desk_runtime`, `api`/`scheduler` join the cluster's
   own `postgres_default` network instead of a Desk-private one (Task 3.1, 3.6).

2. **Delete rules for the 8 new tables: RESTRICT for `signals → strategy_versions` and
   `strategy_versions → strategies`; CASCADE for `watchlist_items → watchlists`,
   `watchlists → users`, and `deliveries → alerts`; every other FK left at Postgres's default
   `NO ACTION`.** Alternative: CASCADE everywhere (simpler, but would silently delete a strategy's
   entire signal history the moment someone deleted the strategy itself), or RESTRICT everywhere
   (would block deleting a user's own watchlist just because it has items). Reason: a version or
   strategy with recorded signals/versions is audit history that must not vanish by accident
   (RESTRICT); a watchlist's items and a user's watchlists are pure ownership hierarchies with no
   independent value once their parent is gone (CASCADE). `strategies.owner_user_id`,
   `strategy_versions.created_by`, `alerts.user_id`, `alerts.signal_id` have no rule named in any
   source material, so they stay at the database default rather than guessing one (Task 3.1).

3. **`daily_close` fires at a fixed 16:30 ET on every XNYS trading day, including half days —
   not at the session's own regular close.** Alternative (L3's original implementation): fire at
   `now >= session.regular_close`, which would mean 13:00 ET on a half day. Reason: `watchdog`'s
   own dead-man schedule already names `daily_close`'s slot as a fixed 16:30 ET; a session-relative
   `due_now` would silently disagree with watchdog's schedule on every half day (false "overdue"
   alerts), and 02's Review Focus 4 ("daylight-saving and half-day schedules") is pinned to this
   exact slot. By 16:30 ET a half day's 13:00 ET close has long passed, so the day's bar is already
   closed and available to store (Task 3.4, integration fix #2).

4. **`/healthz` is a real readiness probe, not a static `{"status": "ok"}`.** It runs `SELECT 1`
   against the Desk database through a dedicated engine with a 1-second connect timeout; 200
   `{"status": "ok"}` on success, 503 `{"status": "unavailable"}` on any failure — the real
   exception text and the database URL are never in the response body. Alternative (what the
   integrated prototype actually shipped, flagged in INTEGRATION-REPORT.md §6 item 3): a static
   `{"status": "ok"}` that never touches the database, which made the `docker-compose.yml`
   healthcheck's own comment ("api.py is responsible for making `/healthz` actually retry
   internally") describe behavior that didn't exist. Reason: `api` has no `depends_on` on the
   shared Postgres cluster (Compose can't condition across projects, Decision 1) — the Docker
   healthcheck's interval/retries/start_period are what give a cold cluster time to become
   reachable, but only if the probe they poll actually tells them whether the database answers
   (Task 3.7).

5. **APPROVED 2026-10-12 — registering `api`/`scheduler` as "protected" (always-on) services in the
   Trading Hub's app-controls catalog (`control/catalog.json`, `control/state.py`), with their tests and
   the operator README sentence, ships in its own follow-up PR.**
   This is a finding from writing this plan, not anticipated by the brief or any lane report: the
   app-controls system (`control/state.py`, `deploy.sh`'s `apply_selected_services`/
   `stop_disabled_groups`) was built after `PROTO-BRIEF.md`, and it changes `compose up` from a
   blanket command to one that starts **only** the services named in the catalog's `protected` list
   or an enabled `apps` group — a service absent from both is never started by a real deploy,
   regardless of its own compose block. `control/catalog.json` and `control/state.py` are shared
   files owned by the open-source lane (ai-trading/AGENTS.md), not Desk-private — editing them is
   held pending the owner's explicit approval rather than bundled into this phase's own release
   (Task 3.6 ships `api`/`scheduler`'s compose services unregistered; without this registration a
   real deploy will not start them). Alternative considered (not chosen): either register them as
   `protected` (the original proposal below) or add a new toggleable `apps["desk"] = ["api",
   "scheduler"]` entry, giving the Desk its own on/off switch in the hub's `/settings` page. Reason
   for preferring `protected`: Phase 3 ships no Settings-page toggle for the Desk (that UI doesn't
   exist until Phase 4 at the earliest, and no plan has asked for the Desk to be user-disablable
   the way TradingAgents/ai-hedge-fund/Vibe-Trading/MiroFish are) — `api`/`scheduler` should simply
   always run once deployed, the same as `market-data`/`auth`/`gateway`, which are also
   `protected`. Revisit once the owner approves, and again if a later phase wants a Desk on/off
   switch (Task 3.6, Task 3.8).

6. **Slack and Telegram send a JSON body with a 10-second timeout — not `requests.post(url,
   payload)`.** Alternative (L1's original implementation): the bare, uncalled-out default
   `post: Callable[..., Response] = requests.post`, which sends `payload` as **form data** via
   `requests`' own positional `data=` parameter and has no timeout at all. Reason: Slack's
   incoming-webhook endpoint expects `Content-Type: application/json`; a form-encoded body would
   silently fail against the real endpoint the first time either channel is actually wired in
   (D-a). The injectable `post` parameter's signature is unchanged (`Callable[[str, dict],
   Response]`), so no existing fake-`post` test needed a change (Task 3.2, integration fix #1).

7. **Telegram/Slack credentials are not in Firestore yet (D-a, APPROVED 2026-10-12).** Both
   `Channel` implementations are built and fully tested; only the `inbox` channel is actually
   wired into `dispatch_pending`'s `channels` map at `api/main.py`'s startup.
   `TELEGRAM_BOT_TOKEN`/`SLACK_WEBHOOK_URL_OWNER`/`SLACK_WEBHOOK_URL_SPOUSE` stay unset in
   `ai-trading/desk`'s Firestore profile. A strategy naming `"telegram"`/`"slack"` in
   `then.alert.channels` still creates a `deliveries` row for it; `dispatch_pending` leaves it
   `"pending"` forever until the owner sets the keys — never a crash, never a silently dropped
   alert (Task 3.2, 3.5).

8. **`should_alert`'s cooldown boundary is exclusive** (`created_at > cutoff`, so a row created
   exactly `cooldown` ago no longer blocks a new alert) — L1's real function, which the
   integration adopted over L3's own lane-local stub, which was inclusive (`created_at >= cutoff`,
   blocking at exactly the boundary). Alternative: keep the inclusive boundary L3's job code was
   originally built and reasoned about. Reason: no behavior in the shipped suite actually depends
   on the exact boundary (confirmed: the full suite passes unchanged either way), and the brief's
   own written contract for `should_alert` is exclusive — L3's stub was a necessary placeholder
   built before L1's module existed in that lane's sandbox, not an intentional divergence. Flagged
   because it is a genuine, if currently untested, behavioral difference (INTEGRATION-REPORT.md §6
   item 1) — worth a dedicated boundary test if the watchdog/re-login cadence ever tightens enough
   for the exact boundary to matter (Task 3.2, 3.4).

9. **`watchdog`/`relogin_reminder` write only an `alerts` row — no `deliveries` row, for any
   channel.** Alternative: fan out a `deliveries` row per configured channel, the way
   `engine.outbox.record_signal` does for strategy signals. Reason: the brief's own text for both
   jobs says "writes one `alerts` row," not the explicit per-channel fan-out language
   `record_signal`'s brief used — L3 followed the more literal instruction. Consequence worth
   confirming: once Telegram/Slack are wired in (Decision 7), a job-overdue or re-login alert can
   **never** reach anything but the inbox, even though both are system-severity alerts a family
   member would plausibly want pushed to their phone. If that's wrong, extending `watchdog.run`/
   `relogin_reminder.run` to also insert `deliveries` rows is a small, additive change — not done
   here because the brief didn't ask for it (Task 3.4).

10. **`relogin_reminder` uses `severity="system"`, matching `watchdog`'s own alert — not the
    brief's literal `severity="info"`.** `notify.quiet_hours.in_quiet_hours` only ever bypasses
    quiet hours for literal severities `"system"`/`"risk"`, and `"info"` is neither; `"system"` is
    what makes `relogin_reminder`'s alert a system alert, so quiet hours do not suppress it
    (review fix F3, matching Decision 9's own framing of both `watchdog` and `relogin_reminder` as
    "system-severity alerts"). Alternative: keep the brief's literal `severity="info"`. Reason: a
    standing, once-a-week operator reminder to re-login to IBKR must actually reach the owner —
    the brief's own code sample for `relogin_reminder` was explicit (`"info"`), so it was initially
    kept literal while `watchdog`'s was inferred as `"system"` from `notify.quiet_hours`'s own doc
    (which already grouped "gateway/job-overdue/re-login-reminder" under the `"system"/"risk"`
    bypass set) — a user with a wide quiet window would otherwise have had this reminder silently
    suppressed while a job-overdue alert never was, for no reason either alert's own intent
    supports. `relogin_reminder` now matches `watchdog` exactly, closing the gap this decision
    originally flagged (Task 3.2, 3.4).

11. **A strategy version save auto-promotes `strategies.current_version_id` — there is no separate
    "activate version" endpoint.** `POST /api/desk/strategies/{id}/versions` sets
    `strategy.current_version_id = row.id` in the same transaction that creates the version.
    Alternative: leave the old version live (still evaluated by `tick`) until a separate
    activation call switches over, so an operator could prepare and review a new version before it
    goes live. Reason: no source document names a separate activation step, and the simpler
    "newest version is always current" behavior matches how every other Phase-3 write (a
    watchlist, a settings PUT) takes effect immediately. Revisit if staged review-before-activate
    ever becomes a real requirement (Task 3.5).

12. **`GET /api/desk/quotes/{symbol}` (SSE) requires the same gateway identity as every other
    route** (`Depends(get_current_user)`), even though the brief's own literal `quotes.py`
    signature (`stream_quotes(symbol, request, data_sources)`) didn't name it. Alternative: leave
    quotes unauthenticated, matching the brief's literal signature. Reason: every other `/api/desk/*`
    route requires identity, and an unauthenticated SSE stream would be the one hole in an
    otherwise fully gated API — almost certainly an omission in the brief's shorthand code sample
    rather than an intentional exception. Confirm before Phase 4's UI starts depending on this
    route's auth behavior (Task 3.5).

13. **The watchlist card back's one bias gauge shows the Desk Technical Bias's "summary" score
    (the mean of the oscillator and moving-average groups), and its pivots are always the Classic
    method.** Alternative for the bias score: show the oscillator or moving-average score alone.
    Alternative for pivots: expose all three methods (Classic/Fibonacci/Camarilla) the way the
    separate Technicals page (Phase 4, out of scope here) will. Reason: 02f's own mockup names one
    bias gauge and one levels block for the compact watchlist card back — "summary" is the only
    score 02f's running prose calls "the bias," and Classic is the default every retail platform
    and this repo's own strategy-block library already treat as the baseline; a card back wanting
    more detail can already get it from `ai_trading.core.pivots`/`bias` directly. Confirm this
    reading is what the Phase 4 UI actually wants before it's hard-coded into a shipped layout
    (Task 3.3).

14. **`TickResult.evaluated_strategies` counts each (strategy, symbol) pair that reached
    evaluation — not each distinct `strategies` row, and not pairs skipped at the
    `degraded.quality_for` step (an `"unavailable"` future, for example, never increments it).**
    Alternative: count each `strategies` row once per tick, regardless of how many symbols its
    universe resolves to. Reason: the brief's own 5-step per-symbol loop increments inside the
    per-symbol iteration, and the field's literal name ("strategies") doesn't pin which the brief
    intended — this reading is internally consistent with where the brief places the increment.
    Confirm the intended granularity before any dashboard or alert ever reports this number to an
    operator as "strategies evaluated" (Task 3.3).

15. **Approved by the owner, 2026-10-12: the Desk database rides in the existing combined backup
    archive (`backup.sh` dumps every cluster database into one archive per host). No separate
    prefix. No confirmation pending.** The backup "Desk-specific prefix" promised in an earlier
    owner decision could not be satisfied literally once the Desk joins the shared cluster (D-d),
    and this phase adds zero new backup code to work around it:
    `infrastructure/backup/backup.sh`'s `discover_databases()` already sweeps every database on the
    pointed-at cluster into **one** combined, encrypted archive per run, under one `BACKUP_GCS_URI`
    prefix per host per run — there is no per-database path segment, and `restore.sh` has no flag
    to restore a single app's database out of that archive. The existing
    `family-app-backup.service`/`.timer` already covers `ai_trading_desk_db` automatically the
    moment it exists on the cluster, naming its dump individually inside `manifest.json` as
    `dumps/ai_trading_desk_db.dump` — that is the owner-approved substitute for the original
    "Desk-specific GCS prefix" intent. A literal per-app prefix would require a second, independent
    backup run against the same cluster (effectively a second `BACKUP_HOST_ID`), which nobody has
    asked for and this phase does not build (Task 3.8).

16. **`ai_trading.api.main:app` is the one name both the Dockerfile's comment and
    `docker-compose.yml`'s `api` service `command:` use — not `ai_trading.api.app:app`.** The two
    names resolve to the exact same FastAPI object (`main.py` does `from ai_trading.api.app import
    app`), so this is cosmetic, not a behavioral choice — but it matters because 02c's Shared
    Interfaces and some lane code referred to the app by the other name, and only one name can
    appear in a real `command:` line. Reason: `main.py` already existed as the "local-dev
    convenience" entrypoint per the brief's own L6 file list (`api/main.py` "the process
    entrypoint: builds the engine") — using it as the one served name keeps the compose file and
    the brief's own file-list language consistent (Task 3.5, 3.6).

## Review Focus

Pinned to named tests, carried from the brief's own table (§3), plus the readiness-probe tests this
plan adds.

| # | Focus | Test |
|---|---|---|
| 1 | A restart sends no duplicate alert | `tests/engine/test_tick.py::test_restart_replaying_an_already_signaled_bar_creates_no_second_alert` |
| 2 | A missed tick catches up exactly once | `tests/engine/test_tick.py::test_a_gap_in_ticks_evaluates_every_closed_bar_once_on_the_next_tick` |
| 3 | The degraded alert | `tests/engine/test_tick.py::test_a_bar_close_1m_stock_strategy_alerts_degraded_with_delayed_15m_quality` and `::test_a_bar_close_1m_future_strategy_never_fires_quality_unavailable` |
| 4 | Daylight-saving and half-day schedules | `tests/jobs/test_premarket.py::test_due_now_premarket_0830_shifts_correctly_across_the_dst_change` and `tests/jobs/test_daily_close.py::test_due_now_daily_close_fires_at_the_half_days_1300_et_close` |
| 5 | No secret in error text | `tests/notify/test_dispatch.py::test_delivery_error_text_never_contains_the_bot_token_or_webhook_url` |
| 6 | `/healthz` is a real readiness check, never a secret in its body | `tests/api/test_healthz.py` (all four tests) |

## Parallel execution lanes

Real dependency order, from `PROTO-BRIEF.md` §8 and the integration report's own stub-replacement
section (§4):

| Task | Owns | Depends on | Appends to |
|---|---|---|---|
| **3.1 Database** | `db/models.py`, migration `0002`, `docker/postgres/zz-20-desk-roles.sh`, `infrastructure/vps/apps/ai-trading-desk.conf`, `tests/conftest.py`'s `_TABLES` | nothing in this phase (Phase 2a's `db`/`data` already merged) | `tests/conftest.py` (one `_TABLES` append — L1–L5's tests then rely on it) |
| **3.2 Notify** | `ai_trading.notify` (all 8 files + tests) | 3.1 (`alerts`/`deliveries`/`users.settings` models) | `pyproject.toml` (`requests` as a direct dependency) |
| **3.3 Engine** | `ai_trading.engine` (all 5 files + tests) | 3.1 (`signals`/`alerts`/`deliveries`/`strategies`/`strategy_versions`); Phase 1's `evaluate`, Phase 2a's `data.bars` (already merged) | — |
| **3.4 Jobs** | `ai_trading.jobs` (all 10 files + tests) | 3.1 (`strategies`/`strategy_versions`/`watchlists`/`watchlist_items`); 3.3's `engine.tick.tick` (stub it if 3.3 isn't finished yet); 3.2's `notify.dedupe.should_alert` | — |
| **3.5 API** | `ai_trading.api` (all 10 files + tests) | 3.2's `dispatch_pending`, 3.3's `tick`/`compute_card_back`, 3.4's `backfill_on_join`, 3.1 | `pyproject.toml` (`fastapi`, `uvicorn[standard]`, `sse-starlette`, dev `httpx`, the `api/*.py` `B008` per-file-ignore) |
| **3.6 Deploy** | Dockerfile, `deploy/ci/test-l6-desk.sh`, `docker-bake.hcl`, `docker-compose.yml`, `Caddyfile`, `deploy.sh` | 3.5's `api/app.py`/`api/main.py` and 3.4's `jobs/scheduler.py`/`jobs/healthcheck.py` only for its `command:`/`healthcheck:` lines — otherwise no code dependency, can be drafted in parallel with everything | none of 3.1–3.5's files |
| **3.7 Integration and readiness** | `/healthz` fix, the real `pyproject.toml` path, `.github/workflows/ai-trading-ci.yml` confirmation | 3.1–3.6 all merged | — |
| **3.8 Release and operator checklist** | no code | 3.1–3.7 complete and verified | — |

3.2 and 3.3 start in parallel once 3.1 merges. 3.4 depends on both 3.1 and 3.3 (stub `tick` if 3.3
isn't finished). 3.5 is last among the code lanes — it depends on 3.2, 3.3, 3.4, and 3.1. 3.6 has no
code dependency on 3.1–3.5 and can be drafted the whole time, finalized once 3.4's
`jobs/scheduler.py` and 3.5's `api/app.py`/`api/main.py` exist for its `command:` lines. 3.7 and 3.8
are strictly last.

---

## Task 3.1: Database — roles, Alembic `0002`, onboarding files

**Files:**
- Modify: `packages/family-desk/backend/src/ai_trading/db/models.py` (append 8 classes)
- Create: `packages/family-desk/backend/src/ai_trading/db/migrations/versions/0002_strategy_and_alert_tables.py`
- Create: `packages/family-desk/backend/docker/postgres/zz-20-desk-roles.sh`
- Create: `infrastructure/vps/apps/ai-trading-desk.conf` (repository-root-relative, not under `ai-trading/`)
- Modify: `packages/family-desk/backend/tests/conftest.py` (extend `_TABLES`)
- Create: `packages/family-desk/backend/tests/test_db_phase3_tables.py`
- Create: `packages/family-desk/backend/tests/test_db_roles.py`
- Modify: `packages/family-desk/backend/tests/test_db_migrations.py` (Review Focus 4 of 02c's own
  Phase 2a plan carried forward: the downgrade test needs to know about the 8 new tables)

**Interfaces:**
- Produces: `ai_trading.db.models.{User, Watchlist, WatchlistItem, Strategy, StrategyVersion,
  Signal, Alert, Delivery}` — every later task in this phase imports these.
- Consumes: nothing new (Phase 2a's `Base`, `Bar1d`/`Bar1h`/`Bar1m`/`FuturesRoll` are unchanged).

Circular-reference note: `strategies.current_version_id` points at a row in `strategy_versions`,
which itself FKs back to `strategies.id`. Create `strategies` before `strategy_versions`, with
`current_version_id` as a plain indexed `Integer` — **no** `ForeignKeyConstraint` (avoids the
cycle; application code enforces the reference, proven by
`test_strategies_current_version_id_round_trips_with_no_fk_error` below).

- [ ] **Step 1: Append the 8 Phase 3 classes to `db/models.py`.** The file in full (Phase 2a's
  four bar-table classes are unchanged; everything from `# -- Phase 3 ...` on is new):

```python
"""Typed SQLAlchemy 2 models for the Desk's Postgres store: 02b §5's bar tables, 02a §9's roll map
(`bars_1d`, `bars_1h`, `bars_1m`, `futures_rolls`, Phase 2a), and Phase 3's strategy/alert tables
(02 §7, 02a §9: `users`, `watchlists`, `watchlist_items`, `strategies`, `strategy_versions`,
`signals`, `alerts`, `deliveries` -- Alembic `0002`). Still out of scope: `iv_daily`,
`consensus_snapshots`, `order_intents`/`fills` and the rest of 02a §9's later-phase tables (Phase
2a's own D3 ruling -- "a table arrives with the phase that first needs it").

Every bar table's primary key matches how `ai_trading.data.bars`/`rolls` upsert into it (`symbol`
plus the bar's own time column; `product` plus `contract_month`), so `INSERT ... ON CONFLICT DO
UPDATE` needs no separate unique index.

No model below sets an explicit `schema=`: in production the Desk's `desk_migrator`/`desk_runtime`
roles each carry a `search_path` that resolves every unqualified table to the `desk` schema
(`docker/postgres/zz-20-desk-roles.sh`); local/test runs connect as a superuser with no search_path
narrowing, so the same unqualified names land in `public`. Same convention
`expense-tax-management/docker/postgres/zz-20-expense-tax-roles.sh` already uses for its own
app/foundry schemas.
"""

from datetime import date, datetime
from typing import Any

from sqlalchemy import Date, DateTime, Float, ForeignKey, Integer, String, UniqueConstraint, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


# Each bar table repeats its OHLCV + `source` columns rather than sharing them through a mixin:
# splitting a composite primary key across a mixin and its subclass (symbol here, the time column
# there) makes SQLAlchemy's declarative mapper build the primary key in two steps and emit a
# spurious warning, even though the result is correct. Three short, explicit classes avoid it.


class Bar1d(Base):
    __tablename__ = "bars_1d"
    symbol: Mapped[str] = mapped_column(String, primary_key=True)
    day: Mapped[date] = mapped_column(Date, primary_key=True)
    open: Mapped[float] = mapped_column(Float)
    high: Mapped[float] = mapped_column(Float)
    low: Mapped[float] = mapped_column(Float)
    close: Mapped[float] = mapped_column(Float)
    volume: Mapped[float] = mapped_column(Float)
    source: Mapped[str] = mapped_column(String)


class Bar1h(Base):
    __tablename__ = "bars_1h"
    symbol: Mapped[str] = mapped_column(String, primary_key=True)
    bar_start: Mapped[datetime] = mapped_column(DateTime(timezone=True), primary_key=True)
    open: Mapped[float] = mapped_column(Float)
    high: Mapped[float] = mapped_column(Float)
    low: Mapped[float] = mapped_column(Float)
    close: Mapped[float] = mapped_column(Float)
    volume: Mapped[float] = mapped_column(Float)
    source: Mapped[str] = mapped_column(String)


class Bar1m(Base):
    __tablename__ = "bars_1m"
    symbol: Mapped[str] = mapped_column(String, primary_key=True)
    bar_start: Mapped[datetime] = mapped_column(DateTime(timezone=True), primary_key=True)
    open: Mapped[float] = mapped_column(Float)
    high: Mapped[float] = mapped_column(Float)
    low: Mapped[float] = mapped_column(Float)
    close: Mapped[float] = mapped_column(Float)
    volume: Mapped[float] = mapped_column(Float)
    source: Mapped[str] = mapped_column(String)


class FuturesRoll(Base):
    """One contiguous front-month window from `ai_trading.data.rolls.roll_windows`."""

    __tablename__ = "futures_rolls"
    product: Mapped[str] = mapped_column(String, primary_key=True)
    contract_month: Mapped[date] = mapped_column(Date, primary_key=True)
    contract_symbol: Mapped[str] = mapped_column(String)
    active_from: Mapped[date] = mapped_column(Date)
    active_until: Mapped[date] = mapped_column(Date)


# -- Phase 3 (Alembic 0002): strategies, signals, and alert delivery -----------------------------
# Created in FK-dependency order: users -> watchlists -> watchlist_items -> strategies ->
# strategy_versions -> signals -> alerts -> deliveries (the same order the migration uses).


class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    display_name: Mapped[str | None] = mapped_column(String)
    telegram_chat_id: Mapped[str | None] = mapped_column(String)
    settings: Mapped[dict[str, Any]] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )


class Watchlist(Base):
    __tablename__ = "watchlists"
    id: Mapped[int] = mapped_column(primary_key=True)
    # CASCADE (integration fix, PROTO-BRIEF.md ruling): deleting a user deletes their watchlists.
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    name: Mapped[str] = mapped_column(String, nullable=False)
    horizon: Mapped[str] = mapped_column(String, nullable=False)  # "intraday" | "swing" | "long_term"


class WatchlistItem(Base):
    __tablename__ = "watchlist_items"
    # CASCADE (integration fix): deleting a watchlist deletes its items.
    watchlist_id: Mapped[int] = mapped_column(ForeignKey("watchlists.id", ondelete="CASCADE"), primary_key=True)
    symbol: Mapped[str] = mapped_column(String, primary_key=True)
    asset_type: Mapped[str] = mapped_column(String, nullable=False)  # "stock" | "future"


class Strategy(Base):
    __tablename__ = "strategies"
    id: Mapped[int] = mapped_column(primary_key=True)
    owner_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    name: Mapped[str] = mapped_column(String, nullable=False)
    stage: Mapped[str] = mapped_column(String, nullable=False, default="draft", server_default=text("'draft'"))
    # No ForeignKey: strategy_versions.strategy_id FKs back to this table, so a FK here would be
    # circular. Application code enforces the reference; indexed for tick.py's every-60s lookup.
    current_version_id: Mapped[int | None] = mapped_column(Integer, index=True)
    paused_reason: Mapped[str | None] = mapped_column(String)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class StrategyVersion(Base):
    __tablename__ = "strategy_versions"
    __table_args__ = (UniqueConstraint("strategy_id", "version", name="uq_strategy_versions_strategy_id_version"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    # RESTRICT (integration fix): a strategy with any version can't be deleted out from under it.
    strategy_id: Mapped[int] = mapped_column(ForeignKey("strategies.id", ondelete="RESTRICT"), nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    schema_version: Mapped[int] = mapped_column(Integer, nullable=False)
    spec: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    change_note: Mapped[str | None] = mapped_column(String)
    created_by: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class Signal(Base):
    __tablename__ = "signals"
    __table_args__ = (
        UniqueConstraint(
            "strategy_version_id", "symbol", "bar_time", name="uq_signals_strategy_version_id_symbol_bar_time"
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    # RESTRICT (integration fix): a strategy version with any recorded signal can't be deleted.
    strategy_version_id: Mapped[int] = mapped_column(
        ForeignKey("strategy_versions.id", ondelete="RESTRICT"), nullable=False
    )
    symbol: Mapped[str] = mapped_column(String, nullable=False)
    bar_time: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    evidence: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    data_quality: Mapped[str] = mapped_column(String, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class Alert(Base):
    __tablename__ = "alerts"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    signal_id: Mapped[int | None] = mapped_column(ForeignKey("signals.id"))
    kind: Mapped[str] = mapped_column(String, nullable=False)
    severity: Mapped[str] = mapped_column(String, nullable=False)
    dedupe_key: Mapped[str | None] = mapped_column(String, index=True)
    title: Mapped[str] = mapped_column(String, nullable=False)
    body: Mapped[str] = mapped_column(String, nullable=False)
    payload: Mapped[dict[str, Any]] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Delivery(Base):
    __tablename__ = "deliveries"
    id: Mapped[int] = mapped_column(primary_key=True)
    # CASCADE (integration fix): deleting an alert deletes its per-channel delivery rows.
    alert_id: Mapped[int] = mapped_column(ForeignKey("alerts.id", ondelete="CASCADE"), nullable=False)
    channel: Mapped[str] = mapped_column(String, nullable=False)  # "inbox" | "telegram" | "slack"
    status: Mapped[str] = mapped_column(String, nullable=False, default="pending", server_default=text("'pending'"))
    attempted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    error: Mapped[str | None] = mapped_column(String)
```

- [ ] **Step 2: Create migration `0002`.**

```python
"""users, watchlists, watchlist_items, strategies, strategy_versions, signals, alerts, deliveries

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-12
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("email", sa.String(), nullable=False),
        sa.Column("display_name", sa.String(), nullable=True),
        sa.Column("telegram_chat_id", sa.String(), nullable=True),
        sa.Column("settings", postgresql.JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.UniqueConstraint("email", name="uq_users_email"),
    )

    op.create_table(
        "watchlists",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("horizon", sa.String(), nullable=False),
        # CASCADE (integration fix, PROTO-BRIEF.md ruling): deleting a user deletes their watchlists.
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], name="fk_watchlists_user_id_users", ondelete="CASCADE"),
    )

    op.create_table(
        "watchlist_items",
        sa.Column("watchlist_id", sa.Integer(), nullable=False),
        sa.Column("symbol", sa.String(), nullable=False),
        sa.Column("asset_type", sa.String(), nullable=False),
        sa.PrimaryKeyConstraint("watchlist_id", "symbol"),
        # CASCADE (integration fix): deleting a watchlist deletes its items.
        sa.ForeignKeyConstraint(
            ["watchlist_id"],
            ["watchlists.id"],
            name="fk_watchlist_items_watchlist_id_watchlists",
            ondelete="CASCADE",
        ),
    )

    op.create_table(
        "strategies",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("owner_user_id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("stage", sa.String(), nullable=False, server_default=sa.text("'draft'")),
        # No FK: strategy_versions.strategy_id FKs back to this table, so a FK here would be
        # circular. Application code enforces the reference (db/models.py's own note).
        sa.Column("current_version_id", sa.Integer(), nullable=True),
        sa.Column("paused_reason", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["owner_user_id"], ["users.id"], name="fk_strategies_owner_user_id_users"),
    )
    op.create_index("ix_strategies_current_version_id", "strategies", ["current_version_id"])

    op.create_table(
        "strategy_versions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("strategy_id", sa.Integer(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("schema_version", sa.Integer(), nullable=False),
        sa.Column("spec", postgresql.JSONB(), nullable=False),
        sa.Column("change_note", sa.String(), nullable=True),
        sa.Column("created_by", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        # RESTRICT (integration fix): a strategy with any version can't be deleted out from under it.
        sa.ForeignKeyConstraint(
            ["strategy_id"],
            ["strategies.id"],
            name="fk_strategy_versions_strategy_id_strategies",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"], name="fk_strategy_versions_created_by_users"),
        sa.UniqueConstraint("strategy_id", "version", name="uq_strategy_versions_strategy_id_version"),
    )

    op.create_table(
        "signals",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("strategy_version_id", sa.Integer(), nullable=False),
        sa.Column("symbol", sa.String(), nullable=False),
        sa.Column("bar_time", sa.DateTime(timezone=True), nullable=False),
        sa.Column("evidence", postgresql.JSONB(), nullable=False),
        sa.Column("data_quality", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        # RESTRICT (integration fix): a strategy version with any recorded signal can't be deleted.
        sa.ForeignKeyConstraint(
            ["strategy_version_id"],
            ["strategy_versions.id"],
            name="fk_signals_strategy_version_id_strategy_versions",
            ondelete="RESTRICT",
        ),
        sa.UniqueConstraint(
            "strategy_version_id", "symbol", "bar_time", name="uq_signals_strategy_version_id_symbol_bar_time"
        ),
    )

    op.create_table(
        "alerts",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("signal_id", sa.Integer(), nullable=True),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("severity", sa.String(), nullable=False),
        sa.Column("dedupe_key", sa.String(), nullable=True),
        sa.Column("title", sa.String(), nullable=False),
        sa.Column("body", sa.String(), nullable=False),
        sa.Column("payload", postgresql.JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("read_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], name="fk_alerts_user_id_users"),
        sa.ForeignKeyConstraint(["signal_id"], ["signals.id"], name="fk_alerts_signal_id_signals"),
    )
    op.create_index("ix_alerts_dedupe_key", "alerts", ["dedupe_key"])

    op.create_table(
        "deliveries",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("alert_id", sa.Integer(), nullable=False),
        sa.Column("channel", sa.String(), nullable=False),
        sa.Column("status", sa.String(), nullable=False, server_default=sa.text("'pending'")),
        sa.Column("attempted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("error", sa.String(), nullable=True),
        # CASCADE (integration fix): deleting an alert deletes its per-channel delivery rows.
        sa.ForeignKeyConstraint(["alert_id"], ["alerts.id"], name="fk_deliveries_alert_id_alerts", ondelete="CASCADE"),
    )


def downgrade() -> None:
    op.drop_table("deliveries")
    op.drop_index("ix_alerts_dedupe_key", table_name="alerts")
    op.drop_table("alerts")
    op.drop_table("signals")
    op.drop_table("strategy_versions")
    op.drop_index("ix_strategies_current_version_id", table_name="strategies")
    op.drop_table("strategies")
    op.drop_table("watchlist_items")
    op.drop_table("watchlists")
    op.drop_table("users")
```

- [ ] **Step 3: Create the role/schema init script.**

```bash
#!/usr/bin/env bash
# Idempotent Desk role/schema init script for the shared VPS Postgres cluster
# (infrastructure/vps/steps/30-postgres.sh, owner decision 2026-10-12, D-e --
# no desk-postgres container). Same shape as
# expense-tax-management/docker/postgres/zz-20-expense-tax-roles.sh (migrator/
# runtime split, CREATE ROLE/SCHEMA IF NOT EXISTS), scaled down to the Desk's
# one app instead of expense-tax's app+foundry pair.
#
# Safe to re-run: every CREATE is guarded, every GRANT/REVOKE is idempotent by
# nature. 30-postgres.sh invokes this with POSTGRES_DB already set to
# ai_trading_desk_db and DESK_MIGRATOR_DB_PASSWORD/DESK_RUNTIME_DB_PASSWORD
# passed transiently via `docker compose exec -e ...` -- never baked into the
# postgres container's permanent environment.
set -euo pipefail

required_variables=(
  DESK_MIGRATOR_DB_PASSWORD
  DESK_RUNTIME_DB_PASSWORD
)

for variable_name in "${required_variables[@]}"; do
  if [[ -z "${!variable_name:-}" ]]; then
    echo "Missing required PostgreSQL role variable: $variable_name" >&2
    exit 1
  fi
done

psql \
  -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  -v database_name="$POSTGRES_DB" \
  -v desk_migrator_password="$DESK_MIGRATOR_DB_PASSWORD" \
  -v desk_runtime_password="$DESK_RUNTIME_DB_PASSWORD" <<'EOSQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'desk_migrator') THEN
    CREATE ROLE desk_migrator NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'desk_runtime') THEN
    CREATE ROLE desk_runtime NOLOGIN;
  END IF;
END
$$;

ALTER ROLE desk_migrator
  WITH LOGIN PASSWORD :'desk_migrator_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE desk_runtime
  WITH LOGIN PASSWORD :'desk_runtime_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;

CREATE SCHEMA IF NOT EXISTS desk AUTHORIZATION desk_migrator;
CREATE SCHEMA IF NOT EXISTS desk_migrations AUTHORIZATION desk_migrator;

ALTER SCHEMA desk OWNER TO desk_migrator;
ALTER SCHEMA desk_migrations OWNER TO desk_migrator;

GRANT CONNECT ON DATABASE :"database_name" TO desk_migrator, desk_runtime;
REVOKE CREATE, TEMPORARY ON DATABASE :"database_name" FROM desk_migrator, desk_runtime;

REVOKE ALL ON SCHEMA desk, desk_migrations FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM desk_migrator, desk_runtime;

-- desk_runtime (api/scheduler) never touches the migrations bookkeeping schema.
REVOKE ALL ON SCHEMA desk_migrations FROM desk_runtime;

GRANT USAGE ON SCHEMA desk TO desk_runtime;

REVOKE ALL ON ALL TABLES IN SCHEMA desk FROM desk_runtime;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA desk FROM desk_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA desk
  TO desk_runtime;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA desk
  TO desk_runtime;

-- No CREATE/DROP for desk_runtime on its own tables' schema -- Alembic
-- (desk_migrator) owns schema changes, never the api/scheduler connection.
REVOKE CREATE ON SCHEMA desk FROM desk_runtime;

ALTER DEFAULT PRIVILEGES FOR ROLE desk_migrator IN SCHEMA desk
  REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE desk_migrator IN SCHEMA desk
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO desk_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE desk_migrator IN SCHEMA desk
  REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE desk_migrator IN SCHEMA desk
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO desk_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE desk_migrator IN SCHEMA desk_migrations
  REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE desk_migrator IN SCHEMA desk_migrations
  REVOKE ALL ON SEQUENCES FROM PUBLIC;

ALTER ROLE desk_runtime IN DATABASE :"database_name"
  SET search_path TO desk, pg_catalog;
ALTER ROLE desk_migrator IN DATABASE :"database_name"
  SET search_path TO desk, desk_migrations, pg_catalog;
EOSQL
```

Run `chmod 0755 packages/family-desk/backend/docker/postgres/zz-20-desk-roles.sh` after creating it.

- [ ] **Step 4: Create the app config file.**

```bash
# App config for family-app/infrastructure/vps/bootstrap.sh --app <this file>
# Sourced as bash. Paths are relative to the repo root (the directory
# containing both infrastructure/ and this app's own directory).

APP_NAME="ai-trading-desk"
POSTGRES_DB_NAME="ai_trading_desk_db"
# Matches the shared cluster's pinned image (infrastructure/vps/steps/
# 30-postgres.sh is invoked once per host with one POSTGRES_IMAGE for the
# whole cluster; this value must agree with whatever the cluster was already
# bootstrapped with -- expense-tax-management.conf's own value as of this
# writing -- never a second, different Postgres image on the same cluster).
POSTGRES_IMAGE="pgvector/pgvector:pg17"

# Repo-root-relative path to this app's own Postgres role/schema init
# script. It must be idempotent (safe to re-run) -- see
# ai-trading/packages/family-desk/backend/docker/postgres/zz-20-desk-roles.sh
# for the pattern (CREATE ROLE/SCHEMA IF NOT EXISTS, etc.).
ROLE_INIT_SCRIPT_REPO_RELATIVE_PATH="ai-trading/packages/family-desk/backend/docker/postgres/zz-20-desk-roles.sh"

# Space-separated env var NAMES the role script requires (see its own
# `required_variables` array). Values are generated on the VPS if not
# already present in the shared postgres .env -- never invented here.
REQUIRED_PASSWORD_VARS="DESK_MIGRATOR_DB_PASSWORD DESK_RUNTIME_DB_PASSWORD"
```

**Before verifying `POSTGRES_IMAGE`'s exact value against the real cluster**, confirm it against
`infrastructure/vps/apps/expense-tax-management.conf`'s own current value and, if the operator has
since re-bootstrapped the shared cluster with a different tag/digest, use that live value instead
(Task 3.8's operator checklist repeats this check before it's ever applied for real).

- [ ] **Step 5: Extend `tests/conftest.py`'s `_TABLES` tuple.** Find:

```python
_TABLES = (
    "bars_1d",
    "bars_1h",
    "bars_1m",
    "futures_rolls",
)
```

Replace with:

```python
_TABLES = (
    "bars_1d",
    "bars_1h",
    "bars_1m",
    "futures_rolls",
    "users",
    "watchlists",
    "watchlist_items",
    "strategies",
    "strategy_versions",
    "signals",
    "alerts",
    "deliveries",
)
```

And in `db_session`'s truncation loop, change the comment to explain the CASCADE requirement (the
loop itself — `for table in _TABLES: conn.execute(text(f'TRUNCATE TABLE "{table}" CASCADE'))` —
needs no code change, only the comment, since several of `_TABLES` now FK each other):

```python
@pytest.fixture
def db_session(db_engine: Engine) -> Iterator[Session]:
    """A session on a freshly truncated database, so tests can't see each other's rows."""
    with db_engine.begin() as conn:
        # CASCADE: several of `_TABLES` FK each other (users -> ... -> deliveries); plain TRUNCATE
        # on a table another listed table still references raises regardless of row content or
        # loop order, since Postgres checks the constraint's existence, not current row counts.
        for table in _TABLES:
            conn.execute(text(f'TRUNCATE TABLE "{table}" CASCADE'))
    factory = sessionmaker(db_engine, expire_on_commit=False)
    with factory() as session:
        yield session
        session.rollback()
```

- [ ] **Step 6: Create `tests/test_db_phase3_tables.py`** (14 tests: the 3 unique constraints, the
  composite PK, the no-FK round trip, 3 named-FK rejections, and the 5 delete-rule tests from
  Decision 2):

```python
"""Phase 3 (Alembic `0002`) table constraints: the three named unique constraints, the
`watchlist_items` composite primary key, the `strategies.current_version_id` <-> `strategy_versions`
round trip with no FK (db/models.py's own note), and the named foreign keys. Needs a real Postgres
(`scripts/test-db.sh`)."""

from datetime import UTC, datetime

import pytest
from sqlalchemy import delete, insert, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ai_trading.db.models import Alert, Delivery, Signal, Strategy, StrategyVersion, User, Watchlist, WatchlistItem

NOW = datetime(2026, 10, 12, 20, 0, tzinfo=UTC)


def _make_user(session: Session, email: str = "owner@example.test") -> int:
    user_id = session.execute(insert(User).values(email=email).returning(User.id)).scalar_one()
    session.commit()
    return user_id


def _make_strategy_version(session: Session, user_id: int, *, version: int = 1) -> tuple[int, int]:
    strategy_id = session.execute(
        insert(Strategy).values(owner_user_id=user_id, name="gap-and-go", created_at=NOW).returning(Strategy.id)
    ).scalar_one()
    version_id = session.execute(
        insert(StrategyVersion)
        .values(
            strategy_id=strategy_id,
            version=version,
            schema_version=1,
            spec={"template": "gap_and_go"},
            created_by=user_id,
            created_at=NOW,
        )
        .returning(StrategyVersion.id)
    ).scalar_one()
    session.commit()
    return strategy_id, version_id


# --- unique constraints ----------------------------------------------------------------------------


def test_users_email_unique_rejects_a_duplicate(db_session: Session) -> None:
    _make_user(db_session, "dup@example.test")
    with pytest.raises(IntegrityError):
        db_session.execute(insert(User).values(email="dup@example.test"))
        db_session.commit()
    db_session.rollback()


def test_strategy_versions_unique_strategy_id_version_rejects_a_duplicate(db_session: Session) -> None:
    user_id = _make_user(db_session)
    strategy_id, _ = _make_strategy_version(db_session, user_id, version=1)
    with pytest.raises(IntegrityError):
        db_session.execute(
            insert(StrategyVersion).values(
                strategy_id=strategy_id,
                version=1,
                schema_version=1,
                spec={"template": "gap_and_go"},
                created_by=user_id,
                created_at=NOW,
            )
        )
        db_session.commit()
    db_session.rollback()


def test_signals_unique_dedupe_key_rejects_a_duplicate(db_session: Session) -> None:
    user_id = _make_user(db_session)
    _, version_id = _make_strategy_version(db_session, user_id)
    db_session.execute(
        insert(Signal).values(
            strategy_version_id=version_id,
            symbol="AAPL",
            bar_time=NOW,
            evidence={},
            data_quality="delayed-15m",
            created_at=NOW,
        )
    )
    db_session.commit()
    with pytest.raises(IntegrityError):
        db_session.execute(
            insert(Signal).values(
                strategy_version_id=version_id,
                symbol="AAPL",
                bar_time=NOW,
                evidence={"different": True},
                data_quality="delayed-15m",
                created_at=NOW,
            )
        )
        db_session.commit()
    db_session.rollback()


# --- watchlist_items composite primary key ----------------------------------------------------------


def test_watchlist_items_composite_primary_key_rejects_a_duplicate(db_session: Session) -> None:
    user_id = _make_user(db_session)
    watchlist_id = db_session.execute(
        insert(Watchlist).values(user_id=user_id, name="core", horizon="swing").returning(Watchlist.id)
    ).scalar_one()
    db_session.execute(insert(WatchlistItem).values(watchlist_id=watchlist_id, symbol="AAPL", asset_type="stock"))
    db_session.commit()
    with pytest.raises(IntegrityError):
        db_session.execute(insert(WatchlistItem).values(watchlist_id=watchlist_id, symbol="AAPL", asset_type="stock"))
        db_session.commit()
    db_session.rollback()


def test_watchlist_items_allows_the_same_symbol_on_a_different_watchlist(db_session: Session) -> None:
    user_id = _make_user(db_session)
    first_id = db_session.execute(
        insert(Watchlist).values(user_id=user_id, name="core", horizon="swing").returning(Watchlist.id)
    ).scalar_one()
    second_id = db_session.execute(
        insert(Watchlist).values(user_id=user_id, name="intraday", horizon="intraday").returning(Watchlist.id)
    ).scalar_one()
    db_session.execute(insert(WatchlistItem).values(watchlist_id=first_id, symbol="AAPL", asset_type="stock"))
    db_session.execute(insert(WatchlistItem).values(watchlist_id=second_id, symbol="AAPL", asset_type="stock"))
    db_session.commit()  # no IntegrityError: the pair (watchlist_id, symbol) differs each time


# --- strategies.current_version_id: no FK, round trip allowed ---------------------------------------


def test_strategies_current_version_id_round_trips_with_no_fk_error(db_session: Session) -> None:
    user_id = _make_user(db_session)
    strategy_id, version_id = _make_strategy_version(db_session, user_id)
    db_session.execute(update(Strategy).where(Strategy.id == strategy_id).values(current_version_id=version_id))
    db_session.commit()  # would raise IntegrityError here if a FK existed and were ever violated

    row = db_session.execute(select(Strategy).where(Strategy.id == strategy_id)).scalar_one()
    assert row.current_version_id == version_id


# --- named foreign keys ------------------------------------------------------------------------------


def test_watchlists_user_id_foreign_key_rejects_an_unknown_user(db_session: Session) -> None:
    with pytest.raises(IntegrityError):
        db_session.execute(insert(Watchlist).values(user_id=999_999, name="ghost", horizon="swing"))
        db_session.commit()
    db_session.rollback()


def test_signals_strategy_version_id_foreign_key_rejects_an_unknown_version(db_session: Session) -> None:
    with pytest.raises(IntegrityError):
        db_session.execute(
            insert(Signal).values(
                strategy_version_id=999_999,
                symbol="AAPL",
                bar_time=NOW,
                evidence={},
                data_quality="eod",
                created_at=NOW,
            )
        )
        db_session.commit()
    db_session.rollback()


def test_deliveries_alert_id_foreign_key_rejects_an_unknown_alert(db_session: Session) -> None:
    with pytest.raises(IntegrityError):
        db_session.execute(insert(Delivery).values(alert_id=999_999, channel="inbox"))
        db_session.commit()
    db_session.rollback()


# --- delete rules (integration fix, PROTO-BRIEF.md ruling): RESTRICT for signals ->
# strategy_versions and strategy_versions -> strategies; CASCADE for watchlist_items ->
# watchlists, watchlists -> users, and deliveries -> alerts. ---------------------------------------


def test_deleting_a_watchlist_cascades_to_its_items(db_session: Session) -> None:
    user_id = _make_user(db_session)
    watchlist_id = db_session.execute(
        insert(Watchlist).values(user_id=user_id, name="core", horizon="swing").returning(Watchlist.id)
    ).scalar_one()
    db_session.execute(insert(WatchlistItem).values(watchlist_id=watchlist_id, symbol="AAPL", asset_type="stock"))
    db_session.commit()

    db_session.execute(delete(Watchlist).where(Watchlist.id == watchlist_id))
    db_session.commit()

    remaining = (
        db_session.execute(select(WatchlistItem).where(WatchlistItem.watchlist_id == watchlist_id)).scalars().all()
    )
    assert remaining == []


def test_deleting_a_user_cascades_to_their_watchlists(db_session: Session) -> None:
    user_id = _make_user(db_session)
    watchlist_id = db_session.execute(
        insert(Watchlist).values(user_id=user_id, name="core", horizon="swing").returning(Watchlist.id)
    ).scalar_one()
    db_session.commit()

    db_session.execute(delete(User).where(User.id == user_id))
    db_session.commit()

    remaining = db_session.execute(select(Watchlist).where(Watchlist.id == watchlist_id)).scalars().all()
    assert remaining == []


def test_deleting_an_alert_cascades_to_its_deliveries(db_session: Session) -> None:
    user_id = _make_user(db_session)
    alert_id = db_session.execute(
        insert(Alert)
        .values(user_id=user_id, kind="system", severity="info", title="t", body="b", created_at=NOW)
        .returning(Alert.id)
    ).scalar_one()
    delivery_id = db_session.execute(
        insert(Delivery).values(alert_id=alert_id, channel="inbox").returning(Delivery.id)
    ).scalar_one()
    db_session.commit()

    db_session.execute(delete(Alert).where(Alert.id == alert_id))
    db_session.commit()

    remaining = db_session.execute(select(Delivery).where(Delivery.id == delivery_id)).scalars().all()
    assert remaining == []


def test_deleting_a_strategy_is_restricted_by_an_existing_version(db_session: Session) -> None:
    user_id = _make_user(db_session)
    strategy_id, _ = _make_strategy_version(db_session, user_id)

    with pytest.raises(IntegrityError):
        db_session.execute(delete(Strategy).where(Strategy.id == strategy_id))
        db_session.commit()
    db_session.rollback()


def test_deleting_a_strategy_version_is_restricted_by_an_existing_signal(db_session: Session) -> None:
    user_id = _make_user(db_session)
    _, version_id = _make_strategy_version(db_session, user_id)
    db_session.execute(
        insert(Signal).values(
            strategy_version_id=version_id,
            symbol="AAPL",
            bar_time=NOW,
            evidence={},
            data_quality="delayed-15m",
            created_at=NOW,
        )
    )
    db_session.commit()

    with pytest.raises(IntegrityError):
        db_session.execute(delete(StrategyVersion).where(StrategyVersion.id == version_id))
        db_session.commit()
    db_session.rollback()
```

- [ ] **Step 7: Create `tests/test_db_roles.py`** (4 tests: the migration under `desk_migrator`,
  `desk_runtime`'s CRUD, and its inability to CREATE/DROP):

```python
"""Shared-cluster role split (owner decision 2026-10-12, D-e): `zz-20-desk-roles.sh` creates
`desk_migrator` (owns the schema, runs Alembic) and `desk_runtime` (CRUD only, no CREATE/DROP) the
same way `infrastructure/vps/steps/30-postgres.sh` applies it on the real shared cluster. This
proves the migration and the runtime grants work under the cluster's real role split, not just the
test superuser `db_engine` otherwise connects as. Needs a real Postgres (`scripts/test-db.sh`).

Test passwords below are throwaway fixtures for a disposable container, never a real secret
(AGENTS.md).
"""

import os
import subprocess
import uuid
from collections.abc import Iterator
from pathlib import Path
from typing import NamedTuple

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import ProgrammingError

_URL_VAR = "DESK_TEST_DATABASE_URL"
_REQUIRE_VAR = "DESK_REQUIRE_DB"
_ALEMBIC_INI = Path(__file__).resolve().parents[1] / "alembic.ini"
_ROLE_SCRIPT = Path(__file__).resolve().parents[1] / "docker" / "postgres" / "zz-20-desk-roles.sh"

_MIGRATOR_PASSWORD = "desk-migrator-test-fixture-pw"  # pragma: allowlist secret -- test-only, throwaway
_RUNTIME_PASSWORD = "desk-runtime-test-fixture-pw"  # pragma: allowlist secret -- test-only, throwaway


def _alembic_config(url: str) -> Config:
    cfg = Config(str(_ALEMBIC_INI))
    cfg.set_main_option("sqlalchemy.url", url)
    return cfg


class RoleSplitUrls(NamedTuple):
    migrator_url: str
    runtime_url: str


@pytest.fixture(scope="module")
def role_split_urls() -> Iterator[RoleSplitUrls]:
    server_url = os.environ.get(_URL_VAR)
    if not server_url:
        if os.environ.get(_REQUIRE_VAR) == "1":
            pytest.fail(f"{_URL_VAR} is unset and {_REQUIRE_VAR}=1")
        pytest.skip(f"{_URL_VAR} is not set")

    admin = make_url(server_url)
    db_name = f"desk_roles_{uuid.uuid4().hex[:12]}"

    admin_engine = create_engine(server_url, isolation_level="AUTOCOMMIT")
    with admin_engine.connect() as conn:
        conn.execute(text(f'CREATE DATABASE "{db_name}"'))
    admin_engine.dispose()

    env = os.environ.copy()
    env.update(
        {
            "POSTGRES_USER": admin.username or "postgres",
            "POSTGRES_DB": db_name,
            "DESK_MIGRATOR_DB_PASSWORD": _MIGRATOR_PASSWORD,
            "DESK_RUNTIME_DB_PASSWORD": _RUNTIME_PASSWORD,
            "PGPASSWORD": admin.password or "",
            "PGHOST": admin.host or "127.0.0.1",
            "PGPORT": str(admin.port or 5432),
        }
    )
    subprocess.run(["bash", str(_ROLE_SCRIPT)], env=env, check=True, capture_output=True, text=True)

    migrator_url = admin.set(username="desk_migrator", password=_MIGRATOR_PASSWORD, database=db_name).render_as_string(
        hide_password=False
    )
    runtime_url = admin.set(username="desk_runtime", password=_RUNTIME_PASSWORD, database=db_name).render_as_string(
        hide_password=False
    )

    # Run exactly as the cluster would: connected as desk_migrator, not the test superuser.
    command.upgrade(_alembic_config(migrator_url), "head")

    try:
        yield RoleSplitUrls(migrator_url=migrator_url, runtime_url=runtime_url)
    finally:
        admin_engine = create_engine(server_url, isolation_level="AUTOCOMMIT")
        with admin_engine.connect() as conn:
            conn.execute(text(f'DROP DATABASE "{db_name}" WITH (FORCE)'))
        admin_engine.dispose()


def test_desk_migrator_migration_leaves_all_twelve_tables_reachable_by_desk_runtime(
    role_split_urls: RoleSplitUrls,
) -> None:
    runtime_engine = create_engine(role_split_urls.runtime_url)
    try:
        with runtime_engine.connect() as conn:
            tables = {row[0] for row in conn.execute(text("SELECT tablename FROM pg_tables WHERE schemaname = 'desk'"))}
    finally:
        runtime_engine.dispose()
    assert tables == {
        "alembic_version",
        "bars_1d",
        "bars_1h",
        "bars_1m",
        "futures_rolls",
        "users",
        "watchlists",
        "watchlist_items",
        "strategies",
        "strategy_versions",
        "signals",
        "alerts",
        "deliveries",
    }


def test_desk_runtime_can_select_insert_update_delete(role_split_urls: RoleSplitUrls) -> None:
    runtime_engine = create_engine(role_split_urls.runtime_url)
    try:
        with runtime_engine.begin() as conn:
            user_id = conn.execute(
                text("INSERT INTO users (email) VALUES (:email) RETURNING id"), {"email": "runtime@example.test"}
            ).scalar_one()
            conn.execute(
                text("UPDATE users SET display_name = :name WHERE id = :id"), {"name": "Runtime", "id": user_id}
            )
            fetched = conn.execute(text("SELECT display_name FROM users WHERE id = :id"), {"id": user_id}).scalar_one()
            assert fetched == "Runtime"
            conn.execute(text("DELETE FROM users WHERE id = :id"), {"id": user_id})
            remaining = conn.execute(text("SELECT COUNT(*) FROM users WHERE id = :id"), {"id": user_id}).scalar_one()
            assert remaining == 0
    finally:
        runtime_engine.dispose()


def test_desk_runtime_cannot_create_a_table(role_split_urls: RoleSplitUrls) -> None:
    runtime_engine = create_engine(role_split_urls.runtime_url)
    try:
        with pytest.raises(ProgrammingError, match="permission denied"):
            with runtime_engine.begin() as conn:
                conn.execute(text("CREATE TABLE sneaky (id int)"))
    finally:
        runtime_engine.dispose()


def test_desk_runtime_cannot_drop_a_table(role_split_urls: RoleSplitUrls) -> None:
    runtime_engine = create_engine(role_split_urls.runtime_url)
    try:
        with pytest.raises(ProgrammingError, match="permission denied|must be owner"):
            with runtime_engine.begin() as conn:
                conn.execute(text("DROP TABLE users"))
    finally:
        runtime_engine.dispose()
```

- [ ] **Step 8: Extend `tests/test_db_migrations.py`** so `downgrade -1` is proven to drop exactly
  the 8 new tables and leave Phase 2a's 4 intact — the existing file only checked Phase 2a's own 4
  tables and never exercised a downgrade at all. Replace the whole file with:

```python
"""Alembic head against an empty database, and that it agrees with the models (no autogenerate
drift) -- a migration and a model quietly diverging is a real failure mode once more revisions
exist, so a single run of alembic's own `compare_metadata` catches it before that happens.
"""

from pathlib import Path

from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.config import Config
from alembic.migration import MigrationContext
from sqlalchemy import inspect, text
from sqlalchemy.engine import Engine

from ai_trading.db.models import Base

PHASE_2A_TABLES = {"bars_1d", "bars_1h", "bars_1m", "futures_rolls"}
PHASE_3_TABLES = {
    "users",
    "watchlists",
    "watchlist_items",
    "strategies",
    "strategy_versions",
    "signals",
    "alerts",
    "deliveries",
}

_ALEMBIC_INI = Path(__file__).resolve().parents[1] / "alembic.ini"


def _alembic_config(url: str) -> Config:
    cfg = Config(str(_ALEMBIC_INI))
    cfg.set_main_option("sqlalchemy.url", url)
    return cfg


def test_head_matches_models(db_engine: Engine) -> None:
    with db_engine.connect() as conn:
        context = MigrationContext.configure(conn)
        diff = compare_metadata(context, Base.metadata)
    assert diff == []


def test_tables_exist(db_engine: Engine) -> None:
    tables = set(inspect(db_engine).get_table_names())
    assert (PHASE_2A_TABLES | PHASE_3_TABLES) <= tables


def test_downgrade_drops_exactly_the_phase_3_tables_and_keeps_phase_2a(db_engine: Engine) -> None:
    url = db_engine.url.render_as_string(hide_password=False)
    try:
        command.downgrade(_alembic_config(url), "-1")
        with db_engine.connect() as conn:
            tables = set(inspect(db_engine).get_table_names())
            assert tables.isdisjoint(PHASE_3_TABLES)
            assert PHASE_2A_TABLES <= tables
            # Confirm the server is still the same database, not a reconnect artifact.
            conn.execute(text("SELECT 1"))
    finally:
        # Every other test in this module/package expects `db_engine` at head.
        command.upgrade(_alembic_config(url), "head")
```

- [ ] **Step 9: Run it.**

Run (in `packages/family-desk/backend/`): `./scripts/test-db.sh tests/test_db_phase3_tables.py
tests/test_db_roles.py tests/test_db_migrations.py -v`
Expected: `21 passed` (14 + 4 + 3 migration tests — confirms `alembic upgrade head`/
`downgrade -1` still behaves correctly with `0002` on top of `0001`, and that a downgrade leaves
exactly Phase 2a's own 4 tables behind).

- [ ] **Step 10: Commit.**

```
git add packages/family-desk/backend/src/ai_trading/db/models.py packages/family-desk/backend/src/ai_trading/db/migrations/versions/0002_strategy_and_alert_tables.py packages/family-desk/backend/docker/postgres/zz-20-desk-roles.sh infrastructure/vps/apps/ai-trading-desk.conf packages/family-desk/backend/tests/conftest.py packages/family-desk/backend/tests/test_db_phase3_tables.py packages/family-desk/backend/tests/test_db_roles.py packages/family-desk/backend/tests/test_db_migrations.py
git commit -m "Desk: Alembic 0002 (strategies/alerts) and shared-cluster role onboarding"
```

---

## Task 3.2: Notify — channels, redaction, dedupe, quiet hours, dispatch

**Files:** `src/ai_trading/notify/{__init__.py,channel.py,telegram.py,slack.py,redact.py,dedupe.py,quiet_hours.py,dispatch.py}`;
`tests/notify/{test_channel_protocol.py,test_telegram.py,test_slack.py,test_redact.py,test_dedupe.py,test_quiet_hours.py,test_dispatch.py}`.

**Interfaces:**
- Consumes: `ai_trading.db.models.{Alert, Delivery, User}` (Task 3.1).
- Produces: `notify.channel.{Channel, ChannelError, DEFAULT_POST_TIMEOUT_SECONDS}`,
  `notify.telegram.TelegramChannel`, `notify.slack.SlackChannel`, `notify.redact.redact`,
  `notify.dedupe.should_alert`, `notify.quiet_hours.in_quiet_hours`,
  `notify.dispatch.{RETRY_DELAYS_SECONDS, DeliveryOutcome, dispatch_pending}` — Tasks 3.4 and 3.5
  import these.

- [ ] **Step 1: Add `requests` as a direct dependency.** In `pyproject.toml`'s `dependencies`
  list, add `"requests>=2.32",` (it already reaches the Desk transitively through
  `ai-trading-common`; the 02j §7 import-boundary rule restricts `ai_trading_common` imports, not
  `requests` itself). Run `uv lock` in `packages/family-desk/backend/`.

- [ ] **Step 2: Create `notify/__init__.py`** (empty).

- [ ] **Step 3: Create `notify/channel.py`.**

```python
"""The one shape every alert-delivery channel implements (02a §5, 02c Shared Interfaces)."""

from typing import Protocol, runtime_checkable

#: Integration fix: the default HTTP call every `Channel` implementation makes is
#: `requests.post(url, json=payload, timeout=DEFAULT_POST_TIMEOUT_SECONDS)`, never a bare
#: `post(url, payload)` (which sends `payload` as form data via `requests`' own `data=` default
#: positional parameter, and has no timeout at all). Shared by `telegram.py`/`slack.py`.
DEFAULT_POST_TIMEOUT_SECONDS = 10.0


class ChannelError(Exception):
    """Raised by a Channel.send failure. __str__ must never contain a secret (redact.py)."""


@runtime_checkable
class Channel(Protocol):
    name: str  # "telegram" | "slack"

    def send(self, *, title: str, body: str, severity: str) -> None: ...
```

- [ ] **Step 4: Create `notify/redact.py`.**

```python
"""Secret redaction for anything that might reach a log line or an exception message.

Adapted from Vibe-Trading `agent/src/channels/manager.py`/`channels/bus/queue.py` (retry/dedupe
pattern) and deer-flow's notification-delivery redaction (02a §11): a channel's own token/webhook
URL is always passed explicitly, and a defense-in-depth pass catches the shapes a secret takes in
the wild even when a call site forgot to name it -- a Telegram bot-token URL segment, and any
`token=`/`key=`/`webhook=`/`secret=`/`password=`-looking parameter in free text or a query string.
"""

import re

_PLACEHOLDER = "[redacted]"

# Telegram's bot API URL shape: https://api.telegram.org/bot<token>/<method>. The token itself
# (`<digits>:<hash>`) is also passed explicitly by `telegram.py`, but this catches it even if a
# caller didn't.
_BOT_SEGMENT_RE = re.compile(r"/bot\d+:[\w-]+/")

# Any `key=value` pair whose key name looks secret-shaped, with or without a leading `?`/`&` --
# covers both a query string and a secret mentioned in free-form exception text.
_SECRET_PARAM_RE = re.compile(r"(?i)\b([\w.-]*(?:token|key|webhook|secret|password)[\w.-]*=)[^&\s'\"]+")


def redact(text: str, *secrets: str) -> str:
    """Replaces every non-empty secret's exact text with "[redacted]"; safe to call with an empty
    secrets tuple. Also strips a bot-token-shaped Telegram URL segment (`/bot<token>/`) and any
    `token=`/`key=`/`webhook`-looking query parameter, defense in depth for a secret this call
    site didn't know to pass explicitly (adapt deer-flow's redaction, 02a §11).
    """
    out = text
    for secret in secrets:
        if secret:
            out = out.replace(secret, _PLACEHOLDER)
    out = _BOT_SEGMENT_RE.sub(f"/bot{_PLACEHOLDER}/", out)
    out = _SECRET_PARAM_RE.sub(lambda m: f"{m.group(1)}{_PLACEHOLDER}", out)
    return out
```

- [ ] **Step 5: Create `notify/telegram.py`.**

```python
"""A Telegram bot message channel (02a §5: "Telegram bot message or Slack incoming webhook")."""

from collections.abc import Callable

import requests

from ai_trading.notify.channel import DEFAULT_POST_TIMEOUT_SECONDS, ChannelError
from ai_trading.notify.redact import redact

_API_BASE = "https://api.telegram.org"


def _default_post(url: str, payload: dict) -> requests.Response:
    """Integration fix: JSON body, with a timeout -- not `requests.post(url, payload)` (form
    data, no timeout)."""
    return requests.post(url, json=payload, timeout=DEFAULT_POST_TIMEOUT_SECONDS)


class TelegramChannel:
    name = "telegram"

    def __init__(
        self,
        bot_token: str,
        chat_id: str,
        *,
        post: Callable[[str, dict], requests.Response] = _default_post,
    ) -> None:
        self._bot_token = bot_token
        self._chat_id = chat_id
        self._post = post

    def send(self, *, title: str, body: str, severity: str) -> None:
        url = f"{_API_BASE}/bot{self._bot_token}/sendMessage"
        payload = {"chat_id": self._chat_id, "text": f"[{severity.upper()}] {title}\n\n{body}"}
        try:
            response = self._post(url, payload)
        except requests.RequestException as exc:
            raise ChannelError(redact(str(exc), self._bot_token, self._chat_id)) from exc
        if not 200 <= response.status_code < 300:
            message = f"telegram responded {response.status_code}: {response.text}"
            raise ChannelError(redact(message, self._bot_token, self._chat_id))
```

- [ ] **Step 6: Create `notify/slack.py`.**

```python
"""A Slack incoming-webhook channel (02a §5: "Telegram bot message or Slack incoming webhook")."""

from collections.abc import Callable

import requests

from ai_trading.notify.channel import DEFAULT_POST_TIMEOUT_SECONDS, ChannelError
from ai_trading.notify.redact import redact


def _default_post(url: str, payload: dict) -> requests.Response:
    """Integration fix: JSON body, with a timeout -- not `requests.post(url, payload)` (form
    data, no timeout). Slack's real incoming-webhook endpoint expects `Content-Type:
    application/json`."""
    return requests.post(url, json=payload, timeout=DEFAULT_POST_TIMEOUT_SECONDS)


class SlackChannel:
    name = "slack"

    def __init__(
        self,
        webhook_url: str,
        *,
        post: Callable[[str, dict], requests.Response] = _default_post,
    ) -> None:
        self._webhook_url = webhook_url
        self._post = post

    def send(self, *, title: str, body: str, severity: str) -> None:
        payload = {"text": f"*[{severity.upper()}] {title}*\n{body}"}
        try:
            response = self._post(self._webhook_url, payload)
        except requests.RequestException as exc:
            raise ChannelError(redact(str(exc), self._webhook_url)) from exc
        if not 200 <= response.status_code < 300:
            message = f"slack responded {response.status_code}: {response.text}"
            raise ChannelError(redact(message, self._webhook_url))
```

- [ ] **Step 7: Create `notify/dedupe.py`.**

```python
"""Cooldown-based dedupe for system alerts (watchdog, re-login reminder) that a periodic check
could otherwise re-raise every tick. Strategy signals never use this -- `signals`' own unique
constraint (`strategy_version_id`, `symbol`, `bar_time`) dedupes those at the database level.
"""

from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from ai_trading.db.models import Alert


def should_alert(session: Session, dedupe_key: str, *, cooldown: timedelta, now: datetime) -> bool:
    """False iff an `alerts` row with this `dedupe_key` was created within `cooldown` of `now`.
    Used only for system alerts (gateway/job-overdue/re-login-reminder), which a periodic check
    could otherwise re-raise every tick; strategy signals are deduped by `signals`' own unique
    constraint instead, never by this function.

    "Within `cooldown`" is exclusive of the boundary: a row created exactly `cooldown` ago has
    fully served its cooldown and no longer blocks a new alert.
    """
    cutoff = now - cooldown
    recent = session.execute(
        select(Alert.id).where(Alert.dedupe_key == dedupe_key, Alert.created_at > cutoff).limit(1)
    ).scalar_one_or_none()
    return recent is None
```

- [ ] **Step 8: Create `notify/quiet_hours.py`.**

```python
"""Whether an alert currently falls inside a user's quiet hours (02a §5: "Quiet hours apply. Risk
and system alerts ignore them.").
"""

from datetime import datetime, time

from ai_trading.core.calendar import ET


def in_quiet_hours(now: datetime, *, start: time, end: time, severity: str) -> bool:
    """`start`/`end` are America/New_York wall-clock times from `users.settings["quiet_hours"]`
    (`{"start": "22:00", "end": "07:00"}`); handles a window that wraps midnight. Always False for
    severity in ("system", "risk") -- 02a §5: "Risk and system alerts ignore them." `now` is a
    UTC-aware datetime; converted to ET internally.
    """
    if severity in ("system", "risk"):
        return False
    local = now.astimezone(ET).time()
    if start <= end:
        return start <= local < end
    return local >= start or local < end
```

- [ ] **Step 9: Create `notify/dispatch.py`.**

```python
"""Sends `deliveries` rows whose channel is wired (02a §5 "action pipeline": "The notifier sends
the alerts."). Only `inbox` is wired at startup in Phase 3 (D-a) -- a `telegram`/`slack` delivery
with no entry in `channels` is left exactly as it is ("pending"), never crashed on and never
dropped, until the owner sets its keys and `api/main.py` wires it in.
"""

import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from datetime import time as _time

from sqlalchemy import select
from sqlalchemy.orm import Session

from ai_trading.db.models import Alert, Delivery, User
from ai_trading.notify.channel import Channel, ChannelError
from ai_trading.notify.quiet_hours import in_quiet_hours
from ai_trading.notify.redact import redact

RETRY_DELAYS_SECONDS: tuple[float, ...] = (1.0, 5.0, 15.0)  # 02 §11: "retried three times"

_DEFAULT_QUIET_HOURS = {"start": "22:00", "end": "07:00"}


@dataclass(frozen=True)
class DeliveryOutcome:
    delivery_id: int
    status: str  # "sent" | "failed" | "skipped_quiet_hours"


def _quiet_hours_window(user: User) -> tuple[_time, _time]:
    quiet = user.settings.get("quiet_hours") or _DEFAULT_QUIET_HOURS
    return _time.fromisoformat(quiet.get("start", "22:00")), _time.fromisoformat(quiet.get("end", "07:00"))


def dispatch_pending(
    session: Session,
    *,
    channels: dict[str, Channel],  # keyed by deliveries.channel ("inbox" needs no Channel)
    now: datetime,
    sleep: Callable[[float], None] = time.sleep,
) -> list[DeliveryOutcome]:
    """Every `deliveries` row with status="pending". `inbox` rows -> "sent" immediately (the
    inbox IS the `alerts` table). A channel row is skipped (left "pending") when
    `in_quiet_hours` is True for its alert's severity. Otherwise calls `channels[row.channel]
    .send(...)`, retrying up to `len(RETRY_DELAYS_SECONDS)` times with `sleep` between attempts
    on `ChannelError`; final failure -> `status="failed"`, `error=redact.redact(str(exc))`,
    `attempted_at=now`; success -> `status="sent"`, `attempted_at=now`. One UPDATE per row;
    caller commits.
    """
    rows = session.execute(
        select(Delivery, Alert, User)
        .join(Alert, Delivery.alert_id == Alert.id)
        .join(User, Alert.user_id == User.id)
        .where(Delivery.status == "pending")
        .order_by(Delivery.id)
    ).all()

    outcomes: list[DeliveryOutcome] = []
    for delivery, alert, user in rows:
        if delivery.channel == "inbox":
            delivery.status = "sent"
            delivery.attempted_at = now
            outcomes.append(DeliveryOutcome(delivery.id, "sent"))
            continue

        channel = channels.get(delivery.channel)
        if channel is None:
            continue  # not wired yet (D-a); row stays "pending" untouched

        start, end = _quiet_hours_window(user)
        if in_quiet_hours(now, start=start, end=end, severity=alert.severity):
            outcomes.append(DeliveryOutcome(delivery.id, "skipped_quiet_hours"))
            continue

        last_error: ChannelError | None = None
        for attempt in range(len(RETRY_DELAYS_SECONDS) + 1):
            try:
                channel.send(title=alert.title, body=alert.body, severity=alert.severity)
            except ChannelError as exc:
                last_error = exc
                if attempt < len(RETRY_DELAYS_SECONDS):
                    sleep(RETRY_DELAYS_SECONDS[attempt])
                continue
            delivery.status = "sent"
            delivery.attempted_at = now
            outcomes.append(DeliveryOutcome(delivery.id, "sent"))
            break
        else:
            delivery.status = "failed"
            delivery.attempted_at = now
            delivery.error = redact(str(last_error))
            outcomes.append(DeliveryOutcome(delivery.id, "failed"))

    return outcomes
```

- [ ] **Step 10: Create the 7 test files.** Each exactly as below.

`tests/notify/test_channel_protocol.py`:

```python
from ai_trading.notify.channel import Channel
from ai_trading.notify.slack import SlackChannel
from ai_trading.notify.telegram import TelegramChannel


class _OkResponse:
    status_code = 200
    text = "ok"


def _ok_post(url: str, payload: dict) -> _OkResponse:
    return _OkResponse()


def test_telegram_channel_satisfies_the_channel_protocol():
    channel = TelegramChannel("123456789:fake-bot-token", "chat-1", post=_ok_post)
    assert isinstance(channel, Channel)
    assert channel.name == "telegram"
    channel.send(title="t", body="b", severity="info")  # must not raise


def test_slack_channel_satisfies_the_channel_protocol():
    channel = SlackChannel("https://example.test/webhook/FAKE-SECRET-2", post=_ok_post)
    assert isinstance(channel, Channel)
    assert channel.name == "slack"
    channel.send(title="t", body="b", severity="info")  # must not raise


def test_a_bare_object_with_name_and_send_satisfies_the_protocol():
    class Custom:
        name = "custom"

        def send(self, *, title: str, body: str, severity: str) -> None:
            pass

    assert isinstance(Custom(), Channel)


def test_an_object_missing_send_does_not_satisfy_the_protocol():
    class NotAChannel:
        name = "nope"

    assert not isinstance(NotAChannel(), Channel)
```

`tests/notify/test_telegram.py`:

```python
import requests

from ai_trading.notify.channel import DEFAULT_POST_TIMEOUT_SECONDS, ChannelError
from ai_trading.notify.telegram import TelegramChannel

_BOT_TOKEN = "123456789:FAKEtestTOKENnotreal00000000000"
_CHAT_ID = "-100555"


class _Response:
    def __init__(self, status_code: int, text: str = "") -> None:
        self.status_code = status_code
        self.text = text


def test_send_posts_to_the_bot_api_and_succeeds_on_2xx():
    calls = []

    def post(url: str, payload: dict):
        calls.append((url, payload))
        return _Response(200)

    TelegramChannel(_BOT_TOKEN, _CHAT_ID, post=post).send(title="Breakout", body="AAPL crossed VWAP", severity="info")

    [(url, payload)] = calls
    assert url == f"https://api.telegram.org/bot{_BOT_TOKEN}/sendMessage"
    assert payload["chat_id"] == _CHAT_ID
    assert "Breakout" in payload["text"]


def test_send_raises_channel_error_on_non_2xx_response():
    def post(url: str, payload: dict):
        return _Response(400, "Bad Request: chat not found")

    try:
        TelegramChannel(_BOT_TOKEN, _CHAT_ID, post=post).send(title="t", body="b", severity="info")
        raise AssertionError("expected ChannelError")
    except ChannelError as exc:
        assert "400" in str(exc)


def test_send_raises_channel_error_on_a_request_exception():
    def post(url: str, payload: dict):
        raise requests.ConnectionError("connection refused")

    try:
        TelegramChannel(_BOT_TOKEN, _CHAT_ID, post=post).send(title="t", body="b", severity="info")
        raise AssertionError("expected ChannelError")
    except ChannelError:
        pass


def test_send_never_leaks_the_bot_token_on_a_non_2xx_response():
    def post(url: str, payload: dict):
        # Some APIs echo the request URL (with its credential-shaped path segment) in an error body.
        return _Response(403, f"Forbidden: bad token in {url}")

    try:
        TelegramChannel(_BOT_TOKEN, _CHAT_ID, post=post).send(title="t", body="b", severity="info")
        raise AssertionError("expected ChannelError")
    except ChannelError as exc:
        assert _BOT_TOKEN not in str(exc)
        assert "/bot[redacted]/" in str(exc) or "[redacted]" in str(exc)


def test_default_post_sends_json_body_with_a_10_second_timeout(monkeypatch):
    # Integration fix: the default `post` must call `requests.post(url, json=payload,
    # timeout=...)`, never `requests.post(url, payload)` (form data, no timeout).
    calls = []

    def fake_requests_post(url, **kwargs):
        calls.append((url, kwargs))
        return _Response(200)

    monkeypatch.setattr("ai_trading.notify.telegram.requests.post", fake_requests_post)

    TelegramChannel(_BOT_TOKEN, _CHAT_ID).send(title="t", body="b", severity="info")

    [(url, kwargs)] = calls
    assert url == f"https://api.telegram.org/bot{_BOT_TOKEN}/sendMessage"
    assert "data" not in kwargs
    assert kwargs["json"]["chat_id"] == _CHAT_ID
    assert kwargs["timeout"] == DEFAULT_POST_TIMEOUT_SECONDS == 10.0


def test_send_never_leaks_the_bot_token_on_a_request_exception():
    def post(url: str, payload: dict):
        raise requests.ConnectionError(f"Failed to establish a new connection: {url}")

    try:
        TelegramChannel(_BOT_TOKEN, _CHAT_ID, post=post).send(title="t", body="b", severity="info")
        raise AssertionError("expected ChannelError")
    except ChannelError as exc:
        assert _BOT_TOKEN not in str(exc)
        assert _CHAT_ID not in str(exc)
```

`tests/notify/test_slack.py`:

```python
import requests

from ai_trading.notify.channel import DEFAULT_POST_TIMEOUT_SECONDS, ChannelError
from ai_trading.notify.slack import SlackChannel

_WEBHOOK_URL = "https://example.test/webhook/FAKE-SECRET-4"


class _Response:
    def __init__(self, status_code: int, text: str = "") -> None:
        self.status_code = status_code
        self.text = text


def test_send_posts_to_the_webhook_and_succeeds_on_2xx():
    calls = []

    def post(url: str, payload: dict):
        calls.append((url, payload))
        return _Response(200, "ok")

    SlackChannel(_WEBHOOK_URL, post=post).send(title="ORB breakout", body="MES broke overnight high", severity="info")

    [(url, payload)] = calls
    assert url == _WEBHOOK_URL
    assert "ORB breakout" in payload["text"]


def test_send_raises_channel_error_on_non_2xx_response():
    def post(url: str, payload: dict):
        return _Response(404, "no_service")

    try:
        SlackChannel(_WEBHOOK_URL, post=post).send(title="t", body="b", severity="info")
        raise AssertionError("expected ChannelError")
    except ChannelError as exc:
        assert "404" in str(exc)


def test_send_raises_channel_error_on_a_request_exception():
    def post(url: str, payload: dict):
        raise requests.Timeout("timed out")

    try:
        SlackChannel(_WEBHOOK_URL, post=post).send(title="t", body="b", severity="info")
        raise AssertionError("expected ChannelError")
    except ChannelError:
        pass


def test_send_never_leaks_the_webhook_url_on_a_non_2xx_response():
    def post(url: str, payload: dict):
        return _Response(400, f"invalid_payload for {url}")

    try:
        SlackChannel(_WEBHOOK_URL, post=post).send(title="t", body="b", severity="info")
        raise AssertionError("expected ChannelError")
    except ChannelError as exc:
        assert _WEBHOOK_URL not in str(exc)
        assert "[redacted]" in str(exc)


def test_default_post_sends_json_body_with_a_10_second_timeout(monkeypatch):
    # Integration fix: the default `post` must call `requests.post(url, json=payload,
    # timeout=...)`, never `requests.post(url, payload)` (form data, no timeout).
    calls = []

    def fake_requests_post(url, **kwargs):
        calls.append((url, kwargs))
        return _Response(200, "ok")

    monkeypatch.setattr("ai_trading.notify.slack.requests.post", fake_requests_post)

    SlackChannel(_WEBHOOK_URL).send(title="t", body="b", severity="info")

    [(url, kwargs)] = calls
    assert url == _WEBHOOK_URL
    assert "data" not in kwargs
    assert "text" in kwargs["json"]
    assert kwargs["timeout"] == DEFAULT_POST_TIMEOUT_SECONDS == 10.0


def test_send_never_leaks_the_webhook_url_on_a_connection_error():
    def post(url: str, payload: dict):
        raise requests.exceptions.ConnectionError(
            f"HTTPSConnectionPool(host='hooks.slack.com', port=443): Max retries exceeded "
            f"with url: {url} (Caused by NewConnectionError('...'))"
        )

    try:
        SlackChannel(_WEBHOOK_URL, post=post).send(title="t", body="b", severity="info")
        raise AssertionError("expected ChannelError")
    except ChannelError as exc:
        assert _WEBHOOK_URL not in str(exc)
```

`tests/notify/test_redact.py`:

```python
from ai_trading.notify.redact import redact


def test_redact_replaces_an_explicit_secret():
    out = redact("error talking to https://example.com/x?a=hunter2hunter2", "hunter2hunter2")
    assert "hunter2hunter2" not in out
    assert "[redacted]" in out


def test_redact_is_safe_with_no_secrets():
    assert redact("plain text, nothing to hide") == "plain text, nothing to hide"


def test_redact_ignores_empty_secret_strings():
    assert redact("hello world", "", "") == "hello world"


def test_redact_strips_a_bot_token_shaped_telegram_url_segment_even_unnamed():
    text = "POST https://api.telegram.org/bot123456789:AAFakeTokenValueNotReal00000/sendMessage failed"
    out = redact(text)
    assert "123456789:AAFakeTokenValueNotReal00000" not in out
    assert "/bot[redacted]/" in out


def test_redact_strips_a_token_query_parameter_even_unnamed():
    out = redact("GET https://example.com/webhook?token=abc123SECRET&chat_id=5 timed out")
    assert "abc123SECRET" not in out
    assert "token=[redacted]" in out


def test_redact_strips_a_webhook_looking_parameter_even_unnamed():
    out = redact("bad request: webhook_url=https://example.test/webhook/FAKE-SECRET-1")
    assert "SECRETSECRET" not in out
    assert "webhook_url=[redacted]" in out


def test_redact_strips_a_key_parameter_case_insensitively():
    out = redact("401 Unauthorized: API_KEY=supersecretvalue rejected")
    assert "supersecretvalue" not in out
    assert "[redacted]" in out


def test_redact_combines_explicit_secret_with_defense_in_depth_pass():
    text = "https://api.telegram.org/botMYSECRETTOKEN/sendMessage?token=MYSECRETTOKEN failed"
    out = redact(text, "MYSECRETTOKEN")
    assert "MYSECRETTOKEN" not in out
```

`tests/notify/test_dedupe.py`:

```python
from datetime import UTC, datetime, timedelta

from ai_trading.db.models import Alert, User
from ai_trading.notify.dedupe import should_alert

_NOW = datetime(2026, 10, 12, 18, 0, tzinfo=UTC)
_COOLDOWN = timedelta(hours=1)


def _make_user(db_session) -> User:
    user = User(email="owner@example.com")
    db_session.add(user)
    db_session.flush()
    return user


def _make_alert(db_session, user: User, *, dedupe_key: str, created_at: datetime) -> Alert:
    alert = Alert(
        user_id=user.id,
        kind="system",
        severity="system",
        dedupe_key=dedupe_key,
        title="Job overdue",
        body="daily_close has not run",
        created_at=created_at,
    )
    db_session.add(alert)
    db_session.flush()
    return alert


def test_should_alert_false_when_a_row_was_created_inside_the_cooldown(db_session):
    user = _make_user(db_session)
    _make_alert(
        db_session, user, dedupe_key="job-overdue:daily_close", created_at=_NOW - _COOLDOWN + timedelta(seconds=1)
    )

    assert should_alert(db_session, "job-overdue:daily_close", cooldown=_COOLDOWN, now=_NOW) is False


def test_should_alert_true_exactly_at_the_cooldown_boundary(db_session):
    user = _make_user(db_session)
    _make_alert(db_session, user, dedupe_key="job-overdue:daily_close", created_at=_NOW - _COOLDOWN)

    assert should_alert(db_session, "job-overdue:daily_close", cooldown=_COOLDOWN, now=_NOW) is True


def test_should_alert_true_when_the_existing_row_is_older_than_the_cooldown(db_session):
    user = _make_user(db_session)
    _make_alert(
        db_session, user, dedupe_key="job-overdue:daily_close", created_at=_NOW - _COOLDOWN - timedelta(seconds=1)
    )

    assert should_alert(db_session, "job-overdue:daily_close", cooldown=_COOLDOWN, now=_NOW) is True


def test_should_alert_true_when_no_row_with_that_dedupe_key_exists(db_session):
    _make_user(db_session)

    assert should_alert(db_session, "job-overdue:weekly", cooldown=_COOLDOWN, now=_NOW) is True


def test_should_alert_ignores_a_row_with_a_different_dedupe_key(db_session):
    user = _make_user(db_session)
    _make_alert(db_session, user, dedupe_key="job-overdue:premarket_0830", created_at=_NOW)

    assert should_alert(db_session, "job-overdue:daily_close", cooldown=_COOLDOWN, now=_NOW) is True
```

`tests/notify/test_quiet_hours.py`:

```python
from datetime import UTC, datetime, time

from ai_trading.notify.quiet_hours import in_quiet_hours

_START = time(22, 0)
_END = time(7, 0)


def _et(hhmm: str) -> datetime:
    """A UTC instant whose America/New_York wall-clock time is `hhmm`, on a fixed EDT date
    (America/New_York is UTC-4 on 2026-07-15)."""
    hour, minute = (int(part) for part in hhmm.split(":"))
    return datetime(2026, 7, 15, (hour + 4) % 24, minute, tzinfo=UTC)


def test_in_quiet_hours_true_inside_a_non_wrapping_window():
    assert in_quiet_hours(_et("10:30"), start=time(9, 0), end=time(17, 0), severity="info") is True


def test_in_quiet_hours_false_outside_a_non_wrapping_window():
    assert in_quiet_hours(_et("20:00"), start=time(9, 0), end=time(17, 0), severity="info") is False


def test_in_quiet_hours_true_just_after_a_wrapping_window_starts():
    assert in_quiet_hours(_et("23:30"), start=_START, end=_END, severity="info") is True


def test_in_quiet_hours_true_just_before_a_wrapping_window_ends():
    assert in_quiet_hours(_et("06:30"), start=_START, end=_END, severity="info") is True


def test_in_quiet_hours_false_at_the_wrapping_windows_end_boundary():
    assert in_quiet_hours(_et("07:00"), start=_START, end=_END, severity="info") is False


def test_in_quiet_hours_false_at_midday_with_a_wrapping_window():
    assert in_quiet_hours(_et("13:00"), start=_START, end=_END, severity="info") is False


def test_in_quiet_hours_system_severity_always_bypasses():
    assert in_quiet_hours(_et("23:30"), start=_START, end=_END, severity="system") is False


def test_in_quiet_hours_risk_severity_always_bypasses():
    assert in_quiet_hours(_et("02:00"), start=_START, end=_END, severity="risk") is False
```

`tests/notify/test_dispatch.py`:

```python
from datetime import UTC, datetime

import requests

from ai_trading.db.models import Alert, Delivery, User
from ai_trading.notify.channel import ChannelError
from ai_trading.notify.dispatch import RETRY_DELAYS_SECONDS, DeliveryOutcome, dispatch_pending
from ai_trading.notify.slack import SlackChannel
from ai_trading.notify.telegram import TelegramChannel

_NOW = datetime(2026, 7, 15, 16, 0, tzinfo=UTC)  # 12:00 ET on a fixed EDT day -- outside default quiet hours


def _no_sleep(seconds: float) -> None:
    return None


class _FakeChannel:
    name = "telegram"

    def __init__(self, *, fail_times: int = 0, error: str = "boom") -> None:
        self.fail_times = fail_times
        self.error = error
        self.calls = 0

    def send(self, *, title: str, body: str, severity: str) -> None:
        self.calls += 1
        if self.calls <= self.fail_times:
            raise ChannelError(self.error)


def _make_user(db_session, *, settings: dict | None = None) -> User:
    user = User(email="owner@example.com", settings=settings or {})
    db_session.add(user)
    db_session.flush()
    return user


def _make_alert(db_session, user: User, *, severity: str = "info") -> Alert:
    alert = Alert(
        user_id=user.id,
        kind="signal",
        severity=severity,
        title="ORB breakout",
        body="AAPL crossed the opening range high",
        created_at=_NOW,
    )
    db_session.add(alert)
    db_session.flush()
    return alert


def _make_delivery(db_session, alert: Alert, *, channel: str) -> Delivery:
    delivery = Delivery(alert_id=alert.id, channel=channel)
    db_session.add(delivery)
    db_session.flush()
    return delivery


def test_dispatch_pending_sends_an_inbox_delivery_immediately(db_session):
    user = _make_user(db_session)
    alert = _make_alert(db_session, user)
    delivery = _make_delivery(db_session, alert, channel="inbox")

    outcomes = dispatch_pending(db_session, channels={}, now=_NOW)

    assert len(outcomes) == 1
    assert outcomes[0].delivery_id == delivery.id
    assert outcomes[0].status == "sent"
    assert delivery.status == "sent"
    assert delivery.attempted_at == _NOW


def test_dispatch_pending_sends_via_a_wired_channel_on_the_first_attempt(db_session):
    user = _make_user(db_session)
    alert = _make_alert(db_session, user)
    delivery = _make_delivery(db_session, alert, channel="telegram")
    channel = _FakeChannel()

    outcomes = dispatch_pending(db_session, channels={"telegram": channel}, now=_NOW)

    assert channel.calls == 1
    assert outcomes == [DeliveryOutcome(delivery.id, "sent")]
    assert delivery.status == "sent"
    assert delivery.attempted_at == _NOW


def test_dispatch_pending_retries_then_succeeds(db_session):
    user = _make_user(db_session)
    alert = _make_alert(db_session, user)
    delivery = _make_delivery(db_session, alert, channel="telegram")
    channel = _FakeChannel(fail_times=2)
    sleeps = []

    outcomes = dispatch_pending(db_session, channels={"telegram": channel}, now=_NOW, sleep=sleeps.append)

    assert channel.calls == 3
    assert sleeps == [RETRY_DELAYS_SECONDS[0], RETRY_DELAYS_SECONDS[1]]
    assert outcomes[0].status == "sent"
    assert delivery.status == "sent"


def test_dispatch_pending_exhausts_retries_and_marks_failed(db_session):
    user = _make_user(db_session)
    alert = _make_alert(db_session, user)
    delivery = _make_delivery(db_session, alert, channel="telegram")
    channel = _FakeChannel(fail_times=99, error="telegram responded 500: internal error")
    sleeps = []

    outcomes = dispatch_pending(db_session, channels={"telegram": channel}, now=_NOW, sleep=sleeps.append)

    assert channel.calls == len(RETRY_DELAYS_SECONDS) + 1
    assert sleeps == list(RETRY_DELAYS_SECONDS)
    assert outcomes[0].status == "failed"
    assert delivery.status == "failed"
    assert delivery.attempted_at == _NOW
    assert delivery.error == "telegram responded 500: internal error"


def test_dispatch_pending_skips_a_channel_delivery_during_quiet_hours_leaving_it_pending(db_session):
    user = _make_user(db_session, settings={"quiet_hours": {"start": "00:00", "end": "23:59"}})
    alert = _make_alert(db_session, user, severity="info")
    delivery = _make_delivery(db_session, alert, channel="telegram")
    channel = _FakeChannel()

    outcomes = dispatch_pending(db_session, channels={"telegram": channel}, now=_NOW)

    assert channel.calls == 0
    assert outcomes == [DeliveryOutcome(delivery.id, "skipped_quiet_hours")]
    assert delivery.status == "pending"
    assert delivery.attempted_at is None


def test_dispatch_pending_still_sends_a_system_alert_during_quiet_hours(db_session):
    user = _make_user(db_session, settings={"quiet_hours": {"start": "00:00", "end": "23:59"}})
    alert = _make_alert(db_session, user, severity="system")
    delivery = _make_delivery(db_session, alert, channel="telegram")
    channel = _FakeChannel()

    outcomes = dispatch_pending(db_session, channels={"telegram": channel}, now=_NOW)

    assert channel.calls == 1
    assert outcomes[0].status == "sent"
    assert delivery.status == "sent"


def test_dispatch_pending_leaves_an_unwired_channel_delivery_pending_forever(db_session):
    user = _make_user(db_session)
    alert = _make_alert(db_session, user)
    delivery = _make_delivery(db_session, alert, channel="slack")

    outcomes = dispatch_pending(db_session, channels={}, now=_NOW)  # neither telegram nor slack wired (D-a)

    assert outcomes == []
    assert delivery.status == "pending"
    assert delivery.attempted_at is None


def test_dispatch_pending_is_a_no_op_on_a_second_call_for_already_handled_rows(db_session):
    user = _make_user(db_session)
    alert = _make_alert(db_session, user)
    _make_delivery(db_session, alert, channel="inbox")

    dispatch_pending(db_session, channels={}, now=_NOW)
    second = dispatch_pending(db_session, channels={}, now=_NOW)

    assert second == []


def test_dispatch_pending_updates_several_rows_independently(db_session):
    user = _make_user(db_session)
    alert = _make_alert(db_session, user)
    inbox_delivery = _make_delivery(db_session, alert, channel="inbox")
    telegram_delivery = _make_delivery(db_session, alert, channel="telegram")
    channel = _FakeChannel()

    outcomes = dispatch_pending(db_session, channels={"telegram": channel}, now=_NOW)

    by_id = {outcome.delivery_id: outcome.status for outcome in outcomes}
    assert by_id == {inbox_delivery.id: "sent", telegram_delivery.id: "sent"}


def test_delivery_error_text_never_contains_the_bot_token_or_webhook_url(db_session):
    """Review Focus 5: a fake `requests` connection error whose own `str()` embeds a real-looking
    webhook URL with a credential-shaped path segment must never leak into `ChannelError.__str__`
    or the `deliveries.error` column written from it.
    """
    bot_token = "123456789:AAFakeBotTokenValueNotReal0000"
    chat_id = "-100999"
    webhook_url = "https://example.test/webhook/FAKE-SECRET-3"

    def telegram_post(url: str, payload: dict):
        raise requests.exceptions.ConnectionError(
            f"HTTPSConnectionPool(host='api.telegram.org', port=443): Max retries exceeded with "
            f"url: /bot{bot_token}/sendMessage (Caused by NewConnectionError(...))"
        )

    def slack_post(url: str, payload: dict):
        raise requests.exceptions.ConnectionError(
            f"HTTPSConnectionPool(host='hooks.slack.com', port=443): Max retries exceeded with url: {webhook_url}"
        )

    user = _make_user(db_session)
    telegram_alert = _make_alert(db_session, user)
    telegram_delivery = _make_delivery(db_session, telegram_alert, channel="telegram")
    slack_alert = _make_alert(db_session, user)
    slack_delivery = _make_delivery(db_session, slack_alert, channel="slack")

    channels = {
        "telegram": TelegramChannel(bot_token, chat_id, post=telegram_post),
        "slack": SlackChannel(webhook_url, post=slack_post),
    }

    dispatch_pending(db_session, channels=channels, now=_NOW, sleep=_no_sleep)

    assert telegram_delivery.status == "failed"
    assert bot_token not in telegram_delivery.error
    assert f"/bot{bot_token}/" not in telegram_delivery.error

    assert slack_delivery.status == "failed"
    assert webhook_url not in slack_delivery.error
```

- [ ] **Step 11: Run it.**

Run (in `packages/family-desk/backend/`): `uv sync && uv run pytest -q tests/notify/`
Expected: `32 passed` (offline: `test_channel_protocol.py` 4, `test_telegram.py` 6, `test_slack.py`
6, `test_redact.py` 8, `test_quiet_hours.py` 8). Then `./scripts/test-db.sh tests/notify/`
Expected: `47 passed` (adds `test_dedupe.py` 5 and `test_dispatch.py` 10, both DB-dependent).

- [ ] **Step 12: Commit.**

```
git add packages/family-desk/backend/pyproject.toml packages/family-desk/backend/uv.lock packages/family-desk/backend/src/ai_trading/notify packages/family-desk/backend/tests/notify
git commit -m "Desk: ai_trading.notify (channels, redaction, dedupe, quiet hours, dispatch)"
```

---

## Task 3.3: Engine — degraded quality, outbox, tick, card back

**Files:** `src/ai_trading/engine/{__init__.py,degraded.py,outbox.py,tick.py,cardback.py}`;
`tests/engine/{conftest.py,strategies.py,test_degraded.py,test_outbox.py,test_tick.py,test_cardback.py}`.

**Interfaces:**
- Consumes: Task 3.1's `Alert`/`Delivery`/`Signal`/`Strategy`/`StrategyVersion`/`Watchlist`/
  `WatchlistItem`; Phase 1's `ai_trading.core.evaluate.{evaluate, SignalCandidate,
  INTRADAY_CADENCES}`; Phase 2a's `ai_trading.data.bars.read_bars`,
  `ai_trading.data.backfill.ALPACA_FREE_HISTORY_START`; `ai_trading.core.{bias, indicators,
  pivots}`, `ai_trading.core.calendar.{Asset, annotate, session}`.
- Produces: `engine.degraded.{DataQuality, quality_for, is_degraded}`,
  `engine.outbox.{AlertSpec, record_signal}`, `engine.tick.{TickResult, tick}`,
  `engine.cardback.{CardBack, compute_card_back}` — Tasks 3.4 and 3.5 import `tick` and
  `compute_card_back`.

- [ ] **Step 1: Create `engine/__init__.py`.**

```python
"""Phase 3 runtime (02c): tick-driven live evaluation over stored bars, the outbox (a signal's
`signals` row and its `alerts`/`deliveries` rows in one transaction), degraded-data detection, and
the card-back read model (02f section 3). No IBKR in this phase (D-c, PROTO-BRIEF.md section 5):
every bar_close_* cadence runs against Alpaca's delayed bars for stocks and never fires for
futures; `degraded.quality_for` is the one function 2b changes.
"""
```

- [ ] **Step 2: Create `engine/degraded.py`.**

```python
"""Data-quality labelling for a strategy's cadence (PROTO-BRIEF.md section 4 L2; 02a section 5).

Phase 3 has no IBKR (D-c): there is no live gateway, so no `bar_close_*` cadence can ever reach
"realtime". A stock runs against Alpaca's delayed bars; a future has no data source at all. The
daily/weekly cadences run on end-of-day bars and are never degraded by the lack of a streaming
slot -- 2b changes only this module's body, not its callers.
"""

from typing import Literal

from ai_trading.core.calendar import Asset

DataQuality = Literal["realtime", "delayed-15m", "eod", "fallback", "unavailable"]

#: `premarket_0830`/`daily_close`/`weekly` read daily/hourly bars, never a live streaming slot.
_EOD_CADENCES = frozenset({"premarket_0830", "daily_close", "weekly"})


def quality_for(asset: Asset, run_on: str) -> DataQuality:
    """Phase 3 has no IBKR (D-c): a `bar_close_*` cadence on `stock` is "delayed-15m"; on `future`
    is "unavailable". `premarket_0830`/`daily_close`/`weekly` are "eod" regardless of asset (daily
    bars are never degraded by lack of a streaming slot). 2b changes only this function's body."""
    if run_on in _EOD_CADENCES:
        return "eod"
    return "unavailable" if asset == "future" else "delayed-15m"


def is_degraded(quality: DataQuality) -> bool:
    """True for every quality except "realtime" and "eod" -- 02a section 5: "bar_close_1m ... has
    no live streaming slot is marked degraded"."""
    return quality not in ("realtime", "eod")
```

- [ ] **Step 3: Create `engine/outbox.py`.**

```python
"""The signal outbox (PROTO-BRIEF.md section 4 L2; 02a section 5): a signal's `signals` row and
its `alerts`/`deliveries` rows land in one transaction, and the `signals` unique constraint
`(strategy_version_id, symbol, bar_time)` -- not any engine-side bookkeeping -- is what makes a
restart replaying an already-signaled bar a no-op instead of a duplicate alert (Review Focus 1).

Degraded strategies alert but place no paper orders (the global constraint): there is no
`order_intents` table in Phase 3, so this module simply never writes one. `data_quality` is still
recorded on every signal so Phase 6 can read it back and gate paper orders on it then.
"""

from dataclasses import dataclass
from datetime import datetime

from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from ai_trading.core.evaluate import SignalCandidate
from ai_trading.db.models import Alert, Delivery, Signal
from ai_trading.engine.degraded import DataQuality


@dataclass(frozen=True)
class AlertSpec:
    """From a strategy version's `spec.then.alert` block."""

    channels: list[str]  # always at least one (the schema enforces min_length=1)
    severity: str = "info"  # spec.then.alert.severity, defaulted by the caller when None


def record_signal(
    session: Session,
    *,
    strategy_version_id: int,
    owner_user_id: int,
    symbol: str,
    candidate: SignalCandidate,
    data_quality: DataQuality,
    alert: AlertSpec,
    now: datetime,
) -> bool:
    """`INSERT INTO signals ... ON CONFLICT (strategy_version_id, symbol, bar_time) DO NOTHING
    RETURNING id`. No row returned (already recorded -- a restart or catch-up re-run) -> returns
    False and writes nothing else: this IS Review Focus 1, enforced by the database, not by
    engine-side bookkeeping.

    Row inserted -> in the SAME transaction (no commit here; the caller commits once per tick),
    inserts one `alerts` row and one `deliveries` row per `alert.channels` entry (status
    defaults to "pending"). Returns True.
    """
    insert_signal = (
        pg_insert(Signal)
        .values(
            strategy_version_id=strategy_version_id,
            symbol=symbol,
            bar_time=candidate.bar_time,
            evidence=candidate.evidence,
            data_quality=data_quality,
            created_at=now,
        )
        .on_conflict_do_nothing(index_elements=["strategy_version_id", "symbol", "bar_time"])
        .returning(Signal.id)
    )
    signal_id = session.execute(insert_signal).scalar_one_or_none()
    if signal_id is None:
        return False

    title, body = _render(symbol, candidate)
    alert_row = Alert(
        user_id=owner_user_id,
        signal_id=signal_id,
        kind="signal",
        severity=alert.severity,
        title=title,
        body=body,
        created_at=now,
    )
    session.add(alert_row)
    session.flush()  # assigns alert_row.id for the deliveries below; still the same transaction
    for channel in alert.channels:
        session.add(Delivery(alert_id=alert_row.id, channel=channel))
    return True


def _render(symbol: str, candidate: SignalCandidate) -> tuple[str, str]:
    title = f"{symbol} signal at {candidate.bar_time.isoformat()}"
    evidence = ", ".join(f"{key}={value}" for key, value in candidate.evidence.items())
    body = f"{symbol} at {candidate.bar_time.isoformat()}: {evidence}" if evidence else title
    return title, body
```

- [ ] **Step 4: Create `engine/tick.py`.**

```python
"""The scheduler's and `api`'s own tick (PROTO-BRIEF.md section 4 L2; 02a section 5): re-evaluates
every live strategy over whatever is already in Postgres. There is no true per-minute "bar close"
event to subscribe to in Phase 3 (no IBKR, D-c) -- `evaluate()` itself reports every candidate
closed by `as_of` on every call, so catch-up safety falls out of calling `evaluate()` again plus
the outbox's unique-constraint dedupe, not out of any streaming machinery or tick-side bookkeeping.
"""

from dataclasses import dataclass, field
from datetime import datetime

import pandas as pd
from sqlalchemy import select
from sqlalchemy.orm import Session

from ai_trading.contracts.strategy_spec_v1 import StrategySpecV1
from ai_trading.core.calendar import Asset
from ai_trading.core.evaluate import INTRADAY_CADENCES, SignalCandidate, evaluate
from ai_trading.data.backfill import ALPACA_FREE_HISTORY_START
from ai_trading.data.bars import read_bars
from ai_trading.db.models import Strategy, StrategyVersion, Watchlist, WatchlistItem
from ai_trading.engine import degraded
from ai_trading.engine.outbox import AlertSpec, record_signal

_LIVE_CADENCES = frozenset({"bar_close_1m", "bar_close_5m", "bar_close_15m", "bar_close_1h"})

#: How far back `tick` reads `bars_1m` on every call. `bars_1m`'s own retention is 90 days
#: (`ai_trading.data.bars._RETENTION_1M`); this stays comfortably inside it so every spec's own
#: rolling window (the widest is `rvol`'s 60-day lookback) always has enough history, at the cost
#: of reading more rows than most specs actually need each tick.
#: ponytail: a fixed 70-day window, not sized per spec; narrow it to each spec's own widest lookback
#: if reading this much `bars_1m` every 60s ever shows up as a real bottleneck.
_BARS_1M_LOOKBACK_DAYS = 70

#: `bars_1d` is read from the earliest day Alpaca's free plan can ever have supplied, every tick --
#: simpler than computing each spec's actual window (n-day levels up to 260 days, pivots up to a
#: month, support/resistance up to 260 days), and daily bars are cheap enough that over-reading
#: them is not worth avoiding.
_BARS_1D_START = ALPACA_FREE_HISTORY_START


@dataclass(frozen=True)
class TickResult:
    evaluated_strategies: int
    new_signals: int
    errors: list[str] = field(default_factory=list)  # one strategy's evaluation failure never aborts the others


def tick(
    session: Session,
    *,
    now: datetime,
    live_cadences: frozenset[str] = _LIVE_CADENCES,
) -> TickResult:
    """Called every ~60s from `api`'s own background loop (bar_close_* cadences, the default
    `live_cadences`) or once per job slot from `jobs.scheduler` (`live_cadences={"premarket_0830"}`
    etc.). For every `strategies` row with stage in ("alert_only", "paper") whose current version's
    `spec.watch.runOn` is in `live_cadences`, resolves its universe's symbols and evaluates each:

      1. asset = "future" if the symbol's watchlist item/inline prefix marks it a future, else "stock"
      2. quality = degraded.quality_for(asset, spec.watch.runOn); "unavailable" -> skip, no bars read
      3. bars_1m/bars_1d = ai_trading.data.bars.read_bars(...) as needed by spec.watch.runOn
      4. candidates = ai_trading.core.evaluate.evaluate(spec, symbol, asset, ..., as_of=now)
      5. for each candidate: outbox.record_signal(...); counted as a new signal only when it returns True

    A symbol's `evaluate()` raising `ValueError` (e.g. missing 1-minute bars) is caught, appended to
    `errors`, and does not stop the rest of the tick -- this IS Review Focus 2: calling `tick` twice
    with the same `now` is idempotent (the second call's `new_signals` is 0, enforced by the outbox's
    own unique constraint), and calling it once after several missed intervals evaluates every bar
    `evaluate()` reports closed by `now` exactly once each. Commits once at the end.
    """
    as_of = _as_of(now)
    evaluated_strategies = 0
    new_signals = 0
    errors: list[str] = []

    strategies = session.execute(select(Strategy).where(Strategy.stage.in_(("alert_only", "paper")))).scalars().all()
    for strategy in strategies:
        version = _current_version(session, strategy)
        if version is None:
            continue
        spec = StrategySpecV1.model_validate(version.spec)
        if spec.watch.runOn not in live_cadences:
            continue
        alert = AlertSpec(channels=list(spec.then.alert.channels), severity=spec.then.alert.severity or "info")

        for symbol, asset in _universe(session, strategy, spec):
            quality = degraded.quality_for(asset, spec.watch.runOn)
            if quality == "unavailable":
                continue  # no data source at all for a future in Phase 3 (D-c): never fires
            evaluated_strategies += 1
            try:
                candidates = _evaluate_symbol(session, spec, symbol, asset, as_of)
            except ValueError as exc:
                errors.append(f"{strategy.name} {symbol}: {exc}")
                continue
            for candidate in candidates:
                wrote = record_signal(
                    session,
                    strategy_version_id=version.id,
                    owner_user_id=strategy.owner_user_id,
                    symbol=symbol,
                    candidate=candidate,
                    data_quality=quality,
                    alert=alert,
                    now=now,
                )
                if wrote:
                    new_signals += 1

    session.commit()
    return TickResult(evaluated_strategies=evaluated_strategies, new_signals=new_signals, errors=errors)


def _as_of(now: datetime) -> pd.Timestamp:
    ts = pd.Timestamp(now)
    return ts.tz_localize("UTC") if ts.tzinfo is None else ts.tz_convert("UTC")


def _current_version(session: Session, strategy: Strategy) -> StrategyVersion | None:
    if strategy.current_version_id is None:
        return None
    return session.get(StrategyVersion, strategy.current_version_id)


def _universe(session: Session, strategy: Strategy, spec: StrategySpecV1) -> list[tuple[str, Asset]]:
    """`spec.watch.universe`: an inline symbol list, or a watchlist name resolved against the
    strategy owner's own `watchlist_items` (joined through `watchlists` by name and owner).

    An inline symbol has no `asset_type` field in the schema (`Universe1.symbols` is a bare string
    list) -- a leading "/" is the Desk's own futures marker (the schema's own `Symbol` pattern,
    `^\\/?[A-Z][A-Z0-9.]{0,9}$`, already allows one for exactly this reason; `/ES` names the same
    underlying product `ai_trading.core.futures` calls "ES"), stripped before use as a bar symbol.
    """
    universe = spec.watch.universe
    if hasattr(universe, "symbols"):
        return [_inline_symbol(item.root) for item in universe.symbols]
    rows = session.execute(
        select(WatchlistItem.symbol, WatchlistItem.asset_type)
        .join(Watchlist, Watchlist.id == WatchlistItem.watchlist_id)
        .where(Watchlist.user_id == strategy.owner_user_id, Watchlist.name == universe.watchlist)
    ).all()
    return [(symbol, "future" if asset_type == "future" else "stock") for symbol, asset_type in rows]


def _inline_symbol(root: str) -> tuple[str, Asset]:
    return (root[1:], "future") if root.startswith("/") else (root, "stock")


def _evaluate_symbol(
    session: Session, spec: StrategySpecV1, symbol: str, asset: Asset, as_of: pd.Timestamp
) -> list[SignalCandidate]:
    bars_1d = read_bars(session, symbol, "1d", _BARS_1D_START, as_of.date(), asset, as_of=as_of)
    bars_1m = None
    if spec.watch.runOn in INTRADAY_CADENCES:
        start = (as_of - pd.Timedelta(days=_BARS_1M_LOOKBACK_DAYS)).date()
        bars_1m = read_bars(session, symbol, "1m", start, as_of.date(), asset, as_of=as_of)
    return evaluate(spec, symbol, asset, bars_1m=bars_1m, bars_1d=bars_1d, as_of=as_of)
```

- [ ] **Step 5: Create `engine/cardback.py`** (Decision 13's choice: "summary" bias, Classic-only
  pivots):

```python
"""The watchlist card back (PROTO-BRIEF.md section 4 L2; 02f section 3): a pure read model over
bars already read by the caller. No new table -- D7 in Phase 2a already deferred "read models and
typed evidence snapshots" to the phase that consumes them (Phase 4's UI), so this ships only the
function, proven correct here, for that phase to call straight from the API.

Pure: no I/O, recomputed on every call (bias/indicator math is already fast pure code, so caching
is unneeded until it measurably isn't -- ponytail: add an LRU keyed by (symbol, timeframe,
bar_time) only if a real request measurement needs it).
"""

import math
from dataclasses import dataclass
from datetime import date, timedelta

import pandas as pd

from ai_trading.core import bias, indicators, pivots
from ai_trading.core.calendar import Asset, annotate, session

Timeframe = str  # "5m" | "15m" | "1h" | "1D" | "1W"

#: 02f section 3: intraday timeframes' pivots come from the prior session, "1D"'s from the prior
#: week, "1W"'s from the prior month.
_PIVOT_PERIOD: dict[str, pivots.Period] = {
    "5m": "session",
    "15m": "session",
    "1h": "session",
    "1D": "week",
    "1W": "month",
}

#: TradingView's own -1/0/+1 vote scoring (`ai_trading.core.bias._SCORE`), duplicated here rather
#: than imported since it is that module's private detail: the card back shows each named
#: indicator's own vote as a number, not the bias group's mean.
_VOTE_SCORE = {"Sell": -1.0, "Neutral": 0.0, "Buy": 1.0}


@dataclass(frozen=True)
class CardBack:
    symbol: str
    timeframe: Timeframe
    bias_label: str | None  # None below 250 bars ("warming up", 02f section 3)
    bias_score: float | None
    oscillators: dict[str, float]  # name -> vote score (-1/0/+1); an unknown vote is omitted
    moving_averages: dict[str, float]
    atr_pct_label: str  # "low" | "normal" | "high"
    pivots: dict[str, float]  # classic pivots from the prior completed period; {} until known


def compute_card_back(symbol: str, timeframe: Timeframe, bars: pd.DataFrame, asset: Asset) -> CardBack:
    """`bars` is closed-bar OHLCV at `timeframe`'s own granularity (already read from bars_1h/
    bars_1d via `ai_trading.data.bars` by the caller), oldest first, matching every
    `ai_trading.core` convention. `bias_label`/`bias_score` are the Desk Technical Bias's single
    "summary" score (02f section 3's one bias gauge on the watchlist card back; the Technicals
    page shows the oscillator and moving-average gauges separately, a Phase 4 UI concern)."""
    result = bias.bias(bars)
    if result == "warming up":
        bias_label: str | None = None
        bias_score: float | None = None
        oscillators: dict[str, float] = {}
        moving_averages: dict[str, float] = {}
        atr_pct_label = _fallback_atr_label(bars)
    else:
        bias_label = result.summary_label
        bias_score = result.summary_score
        oscillators = _vote_scores(result.oscillators)
        moving_averages = _vote_scores(result.moving_averages)
        # Guaranteed known: bias.MIN_BARS (250) exceeds atr_percent's own 113-bar warm-up, so
        # result.volatility_label is never None whenever `result` itself is not "warming up".
        atr_pct_label = result.volatility_label or "normal"

    return CardBack(
        symbol=symbol,
        timeframe=timeframe,
        bias_label=bias_label,
        bias_score=bias_score,
        oscillators=oscillators,
        moving_averages=moving_averages,
        atr_pct_label=atr_pct_label,
        pivots=_pivots_for(bars, timeframe, asset),
    )


def _vote_scores(votes: dict[str, bias.Vote]) -> dict[str, float]:
    return {name: _VOTE_SCORE[vote.action] for name, vote in votes.items() if vote.action is not None}


def _fallback_atr_label(bars: pd.DataFrame) -> str:
    """Before 250 bars, the bias itself is unknown, but ATR%'s own 113-bar warm-up may already
    have passed -- show it then; "normal" otherwise, since `atr_pct_label` is not optional."""
    if len(bars) == 0:
        return "normal"
    label = indicators.atr_percent(bars, 14, 100).label
    last = label.iloc[-1] if len(label) else None
    return last if last is not None else "normal"


def _daily_hlc(bars: pd.DataFrame, timeframe: Timeframe, asset: Asset) -> pd.DataFrame:
    """A date-indexed high/low/close frame `pivots.prior_period_hlc` can read: `bars` themselves
    for "1D"/"1W" (already date-indexed, one row per day or week -- `evaluate()`'s own convention
    is regular-session-only daily bars, so these are assumed regular-session too), or one row per
    trading day's regular session aggregated from intraday bars otherwise. A "1W" bar back
    approximates its prior month from its own weekly rows -- there is no finer-grained daily frame
    in scope for a pure, single-frame function (see REPORT-L2.md)."""
    if len(bars) == 0:
        return pd.DataFrame(columns=["high", "low", "close"])
    if timeframe in ("1D", "1W"):
        return bars
    ann = annotate(bars, asset)
    regular = ann[ann["phase"] == "regular"]
    if regular.empty:
        return pd.DataFrame(columns=["high", "low", "close"])
    grouped = regular.groupby("day")
    return pd.DataFrame({"high": grouped["high"].max(), "low": grouped["low"].min(), "close": grouped["close"].last()})


def _next_trading_day(asset: Asset, day: date) -> date:
    """The trading day after `day` (which itself need not be one): the mirror of
    `ai_trading.core.calendar.previous_session`, which this module has no public equivalent of."""
    candidate = day + timedelta(days=1)
    while session(asset, candidate) is None:
        candidate += timedelta(days=1)
    return candidate


def _pivots_for(bars: pd.DataFrame, timeframe: Timeframe, asset: Asset) -> dict[str, float]:
    daily = _daily_hlc(bars, timeframe, asset)
    if daily.empty:
        return {}
    last_day = daily.index.max()
    # Daily/weekly bars are closed-bar only, so the most recent row is the last *completed*
    # period, not "today" -- the day pivots are actually shown for (and whose prior
    # week/month they need) is the next trading day after it. Intraday bars include today's own
    # still-forming session, so `last_day` itself is already the right reference there; computing
    # a next trading day from it would just return tomorrow and shift the lookup a day late.
    reference = _next_trading_day(asset, last_day) if timeframe in ("1D", "1W") else last_day
    high, low, close = pivots.prior_period_hlc(daily, pd.Index([reference]), asset, _PIVOT_PERIOD[timeframe])
    h, lo, c = float(high.iloc[0]), float(low.iloc[0]), float(close.iloc[0])
    if math.isnan(h) or math.isnan(lo) or math.isnan(c):
        return {}
    return pivots.classic_pivots(h, lo, c)
```

- [ ] **Step 6: Create `tests/engine/conftest.py`** (lets `tests/engine/*` import `tests/bars.py`
  and `tests/engine/strategies.py` — the first subdirectory under `tests/` in this backend):

```python
"""Lets `tests/engine/*` import `tests/bars.py` the same way every other test file in this suite
does. pytest already applies the parent `tests/conftest.py`'s fixtures (`db_session`/`db_engine`)
here automatically, since conftest collection walks every directory from `rootdir` down to the
test file regardless of `__init__.py`; that mechanism doesn't cover plain `import` statements,
though, and `tests/` has no `__init__.py` (consistent with every existing suite here), so pytest's
default "prepend" import mode would otherwise insert only `tests/engine/` into `sys.path`. This
re-adds the parent `tests/` directory so `from bars import ...` resolves. The first new
subdirectory under `tests/` in this backend -- see REPORT-L2.md."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
```

- [ ] **Step 7: Create `tests/engine/strategies.py`** (shared fixture builders for 3.3's tests,
  and reused by 3.4):

```python
"""Shared strategy/watchlist builders for `tests/engine/*.py`, following
`tests/test_db_phase3_tables.py`'s own `_make_user`/`_make_strategy_version` pattern."""

from datetime import UTC, datetime
from typing import Any

from sqlalchemy import insert, update
from sqlalchemy.orm import Session

from ai_trading.db.models import Strategy, StrategyVersion, User, Watchlist, WatchlistItem

NOW = datetime(2026, 10, 12, 20, 0, tzinfo=UTC)


def make_user(session: Session, email: str = "owner@example.test") -> int:
    return session.execute(insert(User).values(email=email).returning(User.id)).scalar_one()


def make_strategy(
    session: Session,
    user_id: int,
    spec: dict[str, Any],
    *,
    name: str = "test-strategy",
    stage: str = "alert_only",
    version: int = 1,
) -> tuple[int, int]:
    """Inserts a `strategies` row at `stage` and one `strategy_versions` row holding `spec`,
    points `current_version_id` at it, and returns `(strategy_id, version_id)`."""
    strategy_id = session.execute(
        insert(Strategy).values(owner_user_id=user_id, name=name, stage=stage, created_at=NOW).returning(Strategy.id)
    ).scalar_one()
    version_id = session.execute(
        insert(StrategyVersion)
        .values(
            strategy_id=strategy_id,
            version=version,
            schema_version=1,
            spec=spec,
            created_by=user_id,
            created_at=NOW,
        )
        .returning(StrategyVersion.id)
    ).scalar_one()
    session.execute(update(Strategy).where(Strategy.id == strategy_id).values(current_version_id=version_id))
    return strategy_id, version_id


def make_watchlist(session: Session, user_id: int, name: str, items: list[tuple[str, str]]) -> int:
    """`items`: a list of `(symbol, asset_type)` pairs."""
    watchlist_id = session.execute(
        insert(Watchlist).values(user_id=user_id, name=name, horizon="swing").returning(Watchlist.id)
    ).scalar_one()
    for symbol, asset_type in items:
        session.execute(insert(WatchlistItem).values(watchlist_id=watchlist_id, symbol=symbol, asset_type=asset_type))
    return watchlist_id


def make_spec(
    *,
    when: dict[str, Any],
    run_on: str = "bar_close_1m",
    universe: dict[str, Any] | None = None,
    session_name: str = "regular",
    channels: list[str] | None = None,
    severity: str | None = None,
    paper_order: dict[str, Any] | None = None,
) -> dict[str, Any]:
    then: dict[str, Any] = {"alert": {"channels": channels or ["inbox"]}}
    if severity is not None:
        then["alert"]["severity"] = severity
    if paper_order is not None:
        then["paperOrder"] = paper_order
    return {
        "schemaVersion": 1,
        "name": "Test strategy",
        "watch": {"universe": universe or {"symbols": ["TEST"]}, "session": session_name, "runOn": run_on},
        "when": when,
        "then": then,
    }
```

- [ ] **Step 8: Create `tests/engine/test_degraded.py`** (19 cases — a 14-row and a 5-row
  parametrize table):

```python
"""`degraded.quality_for`/`is_degraded` (PROTO-BRIEF.md section 4 L2): no IBKR in Phase 3 (D-c)
means a `bar_close_*` cadence can never reach "realtime"."""

import pytest

from ai_trading.engine.degraded import is_degraded, quality_for


@pytest.mark.parametrize(
    "asset,run_on,expected",
    [
        ("stock", "bar_close_1m", "delayed-15m"),
        ("stock", "bar_close_5m", "delayed-15m"),
        ("stock", "bar_close_15m", "delayed-15m"),
        ("stock", "bar_close_1h", "delayed-15m"),
        ("future", "bar_close_1m", "unavailable"),
        ("future", "bar_close_5m", "unavailable"),
        ("future", "bar_close_15m", "unavailable"),
        ("future", "bar_close_1h", "unavailable"),
        ("stock", "premarket_0830", "eod"),
        ("future", "premarket_0830", "eod"),
        ("stock", "daily_close", "eod"),
        ("future", "daily_close", "eod"),
        ("stock", "weekly", "eod"),
        ("future", "weekly", "eod"),
    ],
)
def test_quality_for_boundary_table(asset, run_on, expected):
    assert quality_for(asset, run_on) == expected


@pytest.mark.parametrize(
    "quality,expected",
    [
        ("realtime", False),
        ("eod", False),
        ("delayed-15m", True),
        ("fallback", True),
        ("unavailable", True),
    ],
)
def test_is_degraded_boundary_table(quality, expected):
    assert is_degraded(quality) == expected
```

- [ ] **Step 9: Create `tests/engine/test_outbox.py`** (5 cases — 4 DB + 1 offline):

```python
"""`engine.outbox.record_signal` (PROTO-BRIEF.md section 4 L2): the dedupe key lives in the
`signals` unique constraint, not in this module -- the restart/catch-up test with this exact
behavior end to end is `tests/engine/test_tick.py`'s Review Focus 1."""

import pandas as pd
from sqlalchemy import select
from sqlalchemy.orm import Session
from strategies import NOW, make_spec, make_strategy, make_user

from ai_trading.core.evaluate import SignalCandidate
from ai_trading.db import models
from ai_trading.db.models import Alert, Delivery, Signal
from ai_trading.engine.outbox import AlertSpec, record_signal

BAR_TIME = pd.Timestamp("2026-10-12T14:30:00", tz="UTC")
WHEN = {"op": "gt", "left": {"series": "close"}, "right": {"value": 100.0}}


def _candidate(bar_time: pd.Timestamp = BAR_TIME, **evidence: float) -> SignalCandidate:
    return SignalCandidate(symbol="AAPL", bar_time=bar_time, evidence=evidence or {"close": 101.5})


def _setup(db_session: Session) -> tuple[int, int]:
    user_id = make_user(db_session)
    _, version_id = make_strategy(db_session, user_id, make_spec(when=WHEN))
    db_session.commit()
    return user_id, version_id


def test_first_insert_writes_a_signal_an_alert_and_a_pending_delivery(db_session: Session):
    user_id, version_id = _setup(db_session)
    wrote = record_signal(
        db_session,
        strategy_version_id=version_id,
        owner_user_id=user_id,
        symbol="AAPL",
        candidate=_candidate(),
        data_quality="delayed-15m",
        alert=AlertSpec(channels=["inbox"], severity="info"),
        now=NOW,
    )
    db_session.commit()

    assert wrote is True
    signal = db_session.execute(select(Signal)).scalar_one()
    assert signal.symbol == "AAPL"
    assert signal.data_quality == "delayed-15m"
    assert signal.evidence == {"close": 101.5}
    alert = db_session.execute(select(Alert)).scalar_one()
    assert alert.signal_id == signal.id
    assert alert.user_id == user_id
    assert alert.kind == "signal"
    assert alert.severity == "info"
    delivery = db_session.execute(select(Delivery)).scalar_one()
    assert delivery.alert_id == alert.id
    assert delivery.channel == "inbox"
    assert delivery.status == "pending"


def test_second_insert_of_the_same_key_writes_nothing_and_returns_false(db_session: Session):
    user_id, version_id = _setup(db_session)
    alert_spec = AlertSpec(channels=["inbox"])
    first = record_signal(
        db_session,
        strategy_version_id=version_id,
        owner_user_id=user_id,
        symbol="AAPL",
        candidate=_candidate(),
        data_quality="delayed-15m",
        alert=alert_spec,
        now=NOW,
    )
    db_session.commit()
    second = record_signal(
        db_session,
        strategy_version_id=version_id,
        owner_user_id=user_id,
        symbol="AAPL",
        candidate=_candidate(close=999.0),  # different evidence, same dedupe key: still a no-op
        data_quality="delayed-15m",
        alert=alert_spec,
        now=NOW,
    )
    db_session.commit()

    assert first is True
    assert second is False
    assert len(db_session.execute(select(Signal)).scalars().all()) == 1
    assert len(db_session.execute(select(Alert)).scalars().all()) == 1
    assert len(db_session.execute(select(Delivery)).scalars().all()) == 1


def test_a_different_bar_time_is_a_different_dedupe_key(db_session: Session):
    user_id, version_id = _setup(db_session)
    alert_spec = AlertSpec(channels=["inbox"])
    for bar_time in (BAR_TIME, BAR_TIME + pd.Timedelta(minutes=1)):
        wrote = record_signal(
            db_session,
            strategy_version_id=version_id,
            owner_user_id=user_id,
            symbol="AAPL",
            candidate=_candidate(bar_time=bar_time),
            data_quality="delayed-15m",
            alert=alert_spec,
            now=NOW,
        )
        assert wrote is True
    db_session.commit()
    assert len(db_session.execute(select(Signal)).scalars().all()) == 2


def test_multiple_channels_each_get_their_own_pending_delivery_row(db_session: Session):
    user_id, version_id = _setup(db_session)
    record_signal(
        db_session,
        strategy_version_id=version_id,
        owner_user_id=user_id,
        symbol="AAPL",
        candidate=_candidate(),
        data_quality="eod",
        alert=AlertSpec(channels=["inbox", "telegram", "slack"], severity="risk"),
        now=NOW,
    )
    db_session.commit()

    deliveries = db_session.execute(select(Delivery)).scalars().all()
    assert sorted(d.channel for d in deliveries) == ["inbox", "slack", "telegram"]
    assert all(d.status == "pending" for d in deliveries)


def test_no_order_intents_table_exists_for_a_paper_order_spec():
    # Phase 3 ships no order_intents/fills code at all (Phase 6 scope). record_signal never takes
    # a paperOrder block in the first place -- a spec naming one simply has nowhere to write it.
    assert "order_intents" not in models.Base.metadata.tables
    assert not hasattr(models, "OrderIntent")
```

- [ ] **Step 10: Create `tests/engine/test_tick.py`** (9 cases, all DB-dependent; Review Focus 1,
  2, 3 are in here):

```python
"""`engine.tick.tick` (PROTO-BRIEF.md section 4 L2, section 3 Review Focus, section 7 Acceptance).

No IBKR in Phase 3 (D-c): there is no true per-minute "bar close" event to subscribe to, so
catch-up safety comes from `evaluate()` reporting every candidate closed by `as_of` on every call
plus the outbox's own unique-constraint dedupe -- not from any tick-side bookkeeping. These tests
exercise exactly that: a restart (the same `now` ticked twice) and a gap (several missed intervals
caught up in one call)."""

from datetime import date

import pandas as pd
from bars import minute_bars, set_bar
from sqlalchemy import select
from sqlalchemy.orm import Session
from strategies import make_spec, make_strategy, make_user, make_watchlist

from ai_trading.core.calendar import et
from ai_trading.data.bars import upsert_bars
from ai_trading.db.models import Alert, Delivery, Signal
from ai_trading.engine.tick import tick

DAY = date(2026, 10, 6)  # a Tuesday, same fixture day test_evaluate.py uses
CLOSE_ABOVE_100 = {"op": "crosses_above", "left": {"series": "close"}, "right": {"value": 100.0}}


def _store_minute_bars(db_session: Session, symbol: str, asset: str, bars: pd.DataFrame, *, now: pd.Timestamp) -> None:
    upsert_bars(db_session, symbol, "1m", bars, "test-fixture", asset, now=now)


def _watchlist_strategy(
    db_session: Session,
    *,
    symbol: str = "AAPL",
    asset_type: str = "stock",
    when: dict = CLOSE_ABOVE_100,
    run_on: str = "bar_close_1m",
    stage: str = "alert_only",
    channels: list[str] | None = None,
) -> tuple[int, int]:
    user_id = make_user(db_session)
    make_watchlist(db_session, user_id, "core", [(symbol, asset_type)])
    _, version_id = make_strategy(
        db_session,
        user_id,
        make_spec(when=when, run_on=run_on, universe={"watchlist": "core"}, channels=channels),
        stage=stage,
    )
    db_session.commit()
    return user_id, version_id


# --- Acceptance: an alert_only template alerts from live data -----------------------------------


def test_an_alert_only_template_creates_a_signal_and_a_pending_inbox_delivery(db_session: Session):
    _watchlist_strategy(db_session)
    bars = minute_bars("stock", DAY)
    set_bar(bars, DAY, "10:00", close=101.0)  # crosses above 100 on this bar
    _store_minute_bars(db_session, "AAPL", "stock", bars, now=et(DAY, "20:00"))
    db_session.commit()

    result = tick(db_session, now=et(DAY, "20:00"))

    assert result.new_signals == 1
    assert result.errors == []
    signal = db_session.execute(select(Signal)).scalar_one()
    assert signal.symbol == "AAPL"
    assert signal.data_quality == "delayed-15m"
    delivery = db_session.execute(select(Delivery)).scalar_one()
    assert delivery.channel == "inbox"
    assert delivery.status == "pending"


# --- Review Focus 1: a restart sends no duplicate alert ------------------------------------------


def test_restart_replaying_an_already_signaled_bar_creates_no_second_alert(db_session: Session):
    _watchlist_strategy(db_session)
    bars = minute_bars("stock", DAY)
    set_bar(bars, DAY, "10:00", close=101.0)
    _store_minute_bars(db_session, "AAPL", "stock", bars, now=et(DAY, "20:00"))
    db_session.commit()

    first = tick(db_session, now=et(DAY, "20:00"))
    # A restart re-runs the same tick (the process has no memory of what it already evaluated).
    second = tick(db_session, now=et(DAY, "20:00"))

    assert first.new_signals == 1
    assert second.new_signals == 0
    assert len(db_session.execute(select(Signal)).scalars().all()) == 1
    assert len(db_session.execute(select(Alert)).scalars().all()) == 1


# --- Review Focus 2: a missed tick catches up exactly once ----------------------------------------


def test_a_gap_in_ticks_evaluates_every_closed_bar_once_on_the_next_tick(db_session: Session):
    _watchlist_strategy(db_session)
    bars = minute_bars("stock", DAY)
    # Two separate rising edges, as if several 60s ticks were missed while both happened.
    set_bar(bars, DAY, "10:00", close=101.0)
    set_bar(bars, DAY, "10:05", close=99.0)
    set_bar(bars, DAY, "10:10", close=101.5)
    _store_minute_bars(db_session, "AAPL", "stock", bars, now=et(DAY, "20:00"))
    db_session.commit()

    caught_up = tick(db_session, now=et(DAY, "20:00"))
    replayed = tick(db_session, now=et(DAY, "20:00"))

    assert caught_up.new_signals == 2  # both edges, caught up in the single next tick
    assert replayed.new_signals == 0  # each is a no-op on a later replay, never duplicated
    assert len(db_session.execute(select(Signal)).scalars().all()) == 2


# --- Review Focus 3: the degraded alert ------------------------------------------------------------


def test_a_bar_close_1m_stock_strategy_alerts_degraded_with_delayed_15m_quality(db_session: Session):
    _watchlist_strategy(db_session, symbol="AAPL", asset_type="stock")
    bars = minute_bars("stock", DAY)
    set_bar(bars, DAY, "10:00", close=101.0)
    _store_minute_bars(db_session, "AAPL", "stock", bars, now=et(DAY, "20:00"))
    db_session.commit()

    result = tick(db_session, now=et(DAY, "20:00"))

    assert result.new_signals == 1
    signal = db_session.execute(select(Signal)).scalar_one()
    assert signal.data_quality == "delayed-15m"  # degraded: no live streaming slot in Phase 3 (D-c)


def test_a_bar_close_1m_future_strategy_never_fires_quality_unavailable(db_session: Session):
    _watchlist_strategy(db_session, symbol="ES", asset_type="future")
    # Deliberately no bars stored at all for ES: an "unavailable" future is skipped before any
    # bar is even read, so a missing bars table for it must never surface as an error either.
    result = tick(db_session, now=et(DAY, "20:00"))

    assert result.new_signals == 0
    assert result.evaluated_strategies == 0  # skipped before evaluate() was ever attempted
    assert result.errors == []
    assert db_session.execute(select(Signal)).first() is None


# --- robustness: one bad strategy never aborts the others ------------------------------------------


def test_one_strategys_evaluation_error_does_not_abort_the_rest_of_the_tick(db_session: Session):
    # A daily_close strategy using an intraday-only operand fails ai_trading.core.evaluate.check()
    # on every tick -- evaluate() raises ValueError for it, every time, regardless of its bars.
    bad_user = make_user(db_session, "bad@example.test")
    make_watchlist(db_session, bad_user, "core", [("MSFT", "stock")])
    make_strategy(
        db_session,
        bad_user,
        make_spec(
            when={"op": "gt", "left": {"series": "vwap"}, "right": {"value": 1.0}},
            run_on="daily_close",
            universe={"watchlist": "core"},
        ),
        name="bad-strategy",
    )
    # A perfectly good strategy for a different symbol in the same tick.
    _watchlist_strategy(db_session, symbol="AAPL", asset_type="stock")
    bars = minute_bars("stock", DAY)
    set_bar(bars, DAY, "10:00", close=101.0)
    _store_minute_bars(db_session, "AAPL", "stock", bars, now=et(DAY, "20:00"))
    db_session.commit()

    result = tick(
        db_session,
        now=et(DAY, "20:00"),
        live_cadences=frozenset({"bar_close_1m", "daily_close"}),
    )

    assert result.new_signals == 1  # AAPL's signal still gets written
    assert len(result.errors) == 1
    assert "bad-strategy" in result.errors[0]


# --- universe resolution: inline futures symbols use the "/" prefix convention ---------------------


def test_an_inline_future_symbol_with_a_leading_slash_is_never_evaluated(db_session: Session):
    user_id = make_user(db_session)
    make_strategy(
        db_session,
        user_id,
        make_spec(when=CLOSE_ABOVE_100, run_on="bar_close_1m", universe={"symbols": ["/ES"]}),
    )
    db_session.commit()

    result = tick(db_session, now=et(DAY, "20:00"))

    assert result.new_signals == 0
    assert result.evaluated_strategies == 0


# --- stage filter: only alert_only/paper strategies are ever ticked --------------------------------


def test_a_draft_strategy_is_never_evaluated(db_session: Session):
    _watchlist_strategy(db_session, stage="draft")
    bars = minute_bars("stock", DAY)
    set_bar(bars, DAY, "10:00", close=101.0)
    _store_minute_bars(db_session, "AAPL", "stock", bars, now=et(DAY, "20:00"))
    db_session.commit()

    result = tick(db_session, now=et(DAY, "20:00"))

    assert result.new_signals == 0
    assert result.evaluated_strategies == 0


def test_a_cadence_not_in_live_cadences_is_skipped(db_session: Session):
    _watchlist_strategy(db_session, run_on="bar_close_5m")
    result = tick(db_session, now=et(DAY, "20:00"), live_cadences=frozenset({"bar_close_1m"}))

    assert result.new_signals == 0
    assert result.evaluated_strategies == 0
```

- [ ] **Step 11: Create `tests/engine/test_cardback.py`** (11 cases, offline):

```python
"""`engine.cardback.compute_card_back` (PROTO-BRIEF.md section 4 L2; 02f section 3): pure, no I/O.

`bias_label`/`bias_score` are the Desk Technical Bias's "summary" score -- 02f section 3's one
bias gauge on a watchlist card back (the Technicals page's separate oscillator/moving-average
gauges are a Phase 4 UI concern, out of scope here)."""

from datetime import date

import numpy as np
import pandas as pd
from bars import daily_bars, minute_bars, set_bar, trading_days

from ai_trading.core import indicators, pivots
from ai_trading.core.bias import MIN_BARS
from ai_trading.engine.cardback import compute_card_back

DAY = date(2026, 10, 6)


def _random_walk_bars(n: int, *, seed: int = 1) -> pd.DataFrame:
    """`n` bars ending within `DAY`'s own extended session, so `annotate()` (used by the pivot
    calculation every `compute_card_back` call makes, regardless of timeframe) has a real,
    tz-aware index to work with -- not just the bare `RangeIndex` `tests/test_bias.py`'s own
    fixtures use, since `bias.bias()` alone never looks at the index but `cardback` also computes
    pivots from it."""
    rng = np.random.default_rng(seed)
    close = 100 + np.cumsum(rng.normal(0, 0.1, n))
    high = close + np.abs(rng.normal(0.2, 0.05, n))
    low = close - np.abs(rng.normal(0.2, 0.05, n))
    volume = rng.integers(500, 1500, n).astype(float)
    index = pd.date_range(end=minute_bars("stock", DAY).index[-1], periods=n, freq="1min")
    return pd.DataFrame({"open": close, "high": high, "low": low, "close": close, "volume": volume}, index=index)


# --- warming up / known bias (02f section 3's 250-bar threshold) --------------------------------


def test_warming_up_below_250_bars_has_no_bias():
    card = compute_card_back("AAPL", "1h", _random_walk_bars(MIN_BARS - 1), "stock")

    assert card.bias_label is None
    assert card.bias_score is None
    assert card.oscillators == {}
    assert card.moving_averages == {}
    assert card.atr_pct_label in ("low", "normal", "high")  # 249 bars is past ATR's 113-bar warm-up


def test_warming_up_with_too_few_bars_for_atr_defaults_to_normal():
    card = compute_card_back("AAPL", "1h", _random_walk_bars(10), "stock")

    assert card.bias_label is None
    assert card.atr_pct_label == "normal"


def test_bias_is_known_at_exactly_250_bars():
    bars = _random_walk_bars(MIN_BARS)
    card = compute_card_back("AAPL", "1h", bars, "stock")

    assert card.bias_label is not None
    assert card.bias_score is not None
    assert card.oscillators
    assert card.moving_averages
    assert all(value in (-1.0, 0.0, 1.0) for value in card.oscillators.values())
    assert all(value in (-1.0, 0.0, 1.0) for value in card.moving_averages.values())


def test_atr_pct_label_matches_indicators_atr_percent_directly():
    bars = _random_walk_bars(MIN_BARS)
    card = compute_card_back("AAPL", "1h", bars, "stock")

    expected = indicators.atr_percent(bars, 14, 100).label.iloc[-1]
    assert card.atr_pct_label == expected


def test_oscillators_and_moving_averages_omit_an_unknown_vote():
    bars = _random_walk_bars(MIN_BARS)
    bars["volume"] = 0.0  # VWMA's own 0/0 -> NaN convention (indicators.vwma): never votes
    card = compute_card_back("AAPL", "1h", bars, "stock")

    assert "vwma_20" not in card.moving_averages


# --- pivots: prior session (intraday), prior week (1D), prior month (1W) ------------------------


def test_pivots_for_an_intraday_timeframe_use_the_prior_regular_session():
    prior, today = trading_days("stock", DAY, 2)
    bars = pd.concat([minute_bars("stock", prior, price=100.0), minute_bars("stock", today, price=110.0)])
    set_bar(bars, prior, "10:00", high=105.0, low=95.0, close=102.0)
    card = compute_card_back("AAPL", "15m", bars, "stock")

    # The regular session's last bar (15:59) is untouched, so the prior day's close is the
    # baseline 100.0, not the 10:00 bar's own 102.0.
    assert card.pivots == pivots.classic_pivots(105.0, 95.0, 100.0)


def test_pivots_for_1d_use_the_prior_week():
    days = trading_days("stock", date(2026, 10, 30), 15)  # Oct 12 .. Oct 30, 2026
    daily = daily_bars(days, [float(n) for n in range(1, 16)])
    card = compute_card_back("AAPL", "1D", daily, "stock")

    # The prior week (Mon Oct 26 .. Fri Oct 30) has closes 11..15 (matches test_pivots.py).
    assert card.pivots == pivots.classic_pivots(15.0, 11.0, 15.0)


def test_pivots_for_1w_use_the_prior_month():
    weeks = [date(2026, 9, 7), date(2026, 9, 14), date(2026, 9, 21), date(2026, 9, 28), date(2026, 10, 5)]
    weekly = daily_bars(weeks, [10.0, 12.0, 8.0, 14.0, 20.0])
    card = compute_card_back("AAPL", "1W", weekly, "stock")

    # September's four weekly rows (closes 10, 12, 8, 14): high 14, low 8, last-in-month close 14.
    assert card.pivots == pivots.classic_pivots(14.0, 8.0, 14.0)


def test_pivots_are_empty_without_a_prior_completed_period():
    card = compute_card_back("AAPL", "1D", daily_bars([DAY], [100.0]), "stock")

    assert card.pivots == {}


def test_pivots_are_empty_with_no_bars_at_all():
    card = compute_card_back("AAPL", "1D", daily_bars([], []), "stock")

    assert card.pivots == {}


# --- identity ------------------------------------------------------------------------------------


def test_card_back_carries_its_own_symbol_and_timeframe():
    card = compute_card_back("MSFT", "5m", _random_walk_bars(10), "stock")

    assert card.symbol == "MSFT"
    assert card.timeframe == "5m"
```

- [ ] **Step 12: Run it.**

Run (in `packages/family-desk/backend/`): `uv run pytest -q tests/engine/test_degraded.py
tests/engine/test_cardback.py`
Expected: `30 passed` (19 + 11, both offline).
Run: `./scripts/test-db.sh tests/engine/`
Expected: `44 passed` (adds `test_outbox.py` 5, `test_tick.py` 9).

- [ ] **Step 13: Commit.**

```
git add packages/family-desk/backend/src/ai_trading/engine packages/family-desk/backend/tests/engine
git commit -m "Desk: ai_trading.engine (degraded quality, outbox, tick, card back)"
```

---

## Task 3.4: Jobs — scheduler and its named jobs

**Files:** `src/ai_trading/jobs/{__init__.py,clock.py,premarket.py,daily_close.py,weekly.py,refresh_15m.py,backfill_watchlist.py,watchdog.py,relogin_reminder.py,healthcheck.py,scheduler.py}`;
`tests/jobs/{conftest.py,test_clock.py,test_premarket.py,test_daily_close.py,test_weekly.py,test_refresh_15m.py,test_backfill_watchlist.py,test_watchdog.py,test_relogin_reminder.py,test_scheduler.py}`.

**Interfaces:**
- Consumes: Task 3.1's `Strategy`/`StrategyVersion`/`Watchlist`/`WatchlistItem`/`Alert`/`User`;
  Task 3.3's `engine.tick.tick` (imported as `from ai_trading.engine.tick import tick`, **not**
  re-exported from `engine/__init__.py`); Task 3.2's `notify.dedupe.should_alert`; Phase 2a's
  `ai_trading_common.registry.DataSources`, `ai_trading.data.backfill.{backfill,
  ALPACA_FREE_HISTORY_START, BackfillResult}`, `ai_trading.data.bars.upsert_bars`,
  `ai_trading.core.calendar.{ET, session}`.
- Produces: `jobs.JobResult`, `jobs.clock.JobClock`, each job's `due_now`/`run`,
  `jobs.scheduler.{due_now, run_due, main}` — Task 3.6's compose `command:` runs
  `python -m ai_trading.jobs.scheduler`. Also `jobs.healthcheck.{heartbeat_path, touch, is_healthy,
  main}` — `scheduler.main`'s loop calls `touch` every iteration, and Task 3.6's compose
  `healthcheck:` for the `scheduler` service runs `python -m ai_trading.jobs.healthcheck` (review
  fix F4: the scheduler had no health check and no startup retry).

- [ ] **Step 1: Create `jobs/__init__.py`.**

```python
"""`ai_trading.jobs`: the scheduler and its named jobs (02c Phase 3, Lane L3).

`JobResult` lives here rather than in a dedicated module, since the brief's own file list
(PROTO-BRIEF §4 L3) names no shared-helper file for it: it is the return type every job's own
`run()` (and `scheduler.run_due`) uses.

`watchdog.py`/`relogin_reminder.py` use `ai_trading.notify.dedupe.should_alert` directly
(integration fix: Lane L3's own prototype could not import Lane L1's `ai_trading.notify`, since it
did not exist in L3's sandbox copy, so L3 shipped a lane-local `_should_alert` stand-in with the
same contract; that stub is removed now that the real module is present).
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class JobResult:
    """What one job's `run()` call did. `ran=False` marks a call that found nothing to do (a
    job already run today, or -- `scheduler.run_due`'s wrapping of `watchdog.run` -- no job was
    overdue); it is still `ok=True`. `ok=False` only for a raised exception."""

    name: str
    ok: bool
    ran: bool = True
    error: str | None = None


__all__ = ("JobResult",)
```

- [ ] **Step 2: Create `jobs/clock.py`.**

```python
"""In-process, per-`scheduler`-run bookkeeping of each job's last successful run (Lane L3)."""

from dataclasses import dataclass, field
from datetime import date, datetime


@dataclass
class JobClock:
    """In-process, per-`scheduler`-run state: the last UTC date each job name last SUCCEEDED on.

    Not persisted (ponytail: a `scheduler` restart forgets today's completions until that job's
    next due slot re-runs it -- acceptable because every job here is itself idempotent/catch-up-
    safe per 02c's own "halting on failure" wording; upgrade to a `job_runs` table if the
    watchdog's false-positive rate after a restart ever matters).
    """

    last_success: dict[str, date] = field(default_factory=dict)

    def mark(self, job: str, day: date) -> None:
        self.last_success[job] = day

    def succeeded_today(self, job: str, now: datetime) -> bool:
        return self.last_success.get(job) == now.date()


__all__ = ("JobClock",)
```

- [ ] **Step 3: Create `jobs/premarket.py`.**

```python
"""`premarket_0830`: the engine's single evaluation point per trading day, 08:30 ET (Lane L3).

No prep of its own: `premarket_0830` strategies evaluate whatever bars are already stored (02a
§5's gap-and-go template reads prior-day/overnight levels and premarket bars, not anything this
job needs to fetch itself).
"""

from datetime import datetime, time

from sqlalchemy.orm import Session

from ai_trading.core.calendar import ET, session
from ai_trading.engine.tick import tick
from ai_trading.jobs import JobResult
from ai_trading.jobs.clock import JobClock

NAME = "premarket_0830"
_SCHEDULED_ET = time(8, 30)


def due_now(now: datetime) -> bool:
    """True from 08:30 ET onward on an XNYS stock trading day.

    An open window, not a single exact minute: a scheduler that wakes up late still sees today's
    slot as due, and re-running for the rest of the day is a safe no-op -- `evaluate()` reports
    the same `premarket_0830` evaluation point every time, and `signals`' own unique constraint
    (`strategy_version_id`, `symbol`, `bar_time`) makes a repeat `record_signal` a no-op, not a
    second alert (02c Review Focus 1/2).
    """
    et_now = now.astimezone(ET)
    if session("stock", et_now.date()) is None:
        return False
    return et_now.time() >= _SCHEDULED_ET


def run(session_: Session, clock: JobClock, *, now: datetime) -> JobResult:
    tick(session_, now=now, live_cadences=frozenset({NAME}))
    clock.mark(NAME, now.date())
    return JobResult(NAME, ok=True)


__all__ = ("NAME", "due_now", "run")
```

- [ ] **Step 4: Create `jobs/daily_close.py`** (Decision 3's fixed-16:30-ET schedule):

```python
"""`daily_close`: appends every watchlist symbol's closed daily bar, then evaluates `daily_close`
strategies (Lane L3). Only the day's bars and the daily evaluation -- IV and consensus-snapshot
collection are Phase 5's job, which actually consumes them (PROTO-BRIEF §5/§9, following the
brief's explicit L5 table over 02c's own older one-liner, per the brief's §9 ruling)."""

from datetime import datetime, time

from ai_trading_common.registry import DataSources
from sqlalchemy import select
from sqlalchemy.orm import Session

from ai_trading.core.calendar import ET, session
from ai_trading.data.backfill import backfill
from ai_trading.db.models import WatchlistItem
from ai_trading.engine.tick import tick
from ai_trading.jobs import JobResult
from ai_trading.jobs.clock import JobClock

NAME = "daily_close"
_SCHEDULED_ET = time(16, 30)


def due_now(now: datetime) -> bool:
    """True from a fixed 16:30 ET onward, on any XNYS trading day -- half days included.

    Integration fix (PROTO-BRIEF.md integration rulings): this is a fixed wall-clock slot, not
    the stock session's own regular close. A half day's own regular close is 13:00 ET, well
    before this slot, so by 16:30 ET its bars are already closed and available to store/evaluate
    (`test_due_now_daily_close_fires_at_the_half_days_1300_et_close`, 02c Review Focus 4) --
    `daily_close` still runs once per day, just always at the same time, matching
    `watchdog.JOB_SCHEDULE`'s own 16:30 entry exactly (no longer two separate values that happen
    not to conflict).
    """
    et_now = now.astimezone(ET)
    if session("stock", et_now.date()) is None:
        return False
    return et_now.time() >= _SCHEDULED_ET


def run(session_: Session, data_sources: DataSources, clock: JobClock, *, now: datetime) -> JobResult:
    """Backfills today's session for every distinct watchlist symbol (`start=end=today`), then
    evaluates `daily_close` strategies. Never touches `iv_daily`/`consensus_snapshots` (§1
    non-goals).

    Stocks only (02a §5/D-c): `data_sources.bars` has no futures source at all until 2b ships the
    IBKR client -- there is no Alpaca futures endpoint to call -- so a future symbol is skipped
    here rather than attempted and failed; `evaluate()` still runs for it against whatever daily
    bars happen to exist (none, today), producing zero candidates rather than an error.
    """
    today = now.astimezone(ET).date()
    symbols = session_.execute(select(WatchlistItem.symbol, WatchlistItem.asset_type).distinct()).all()
    for symbol, asset_type in symbols:
        if asset_type != "stock":
            continue
        backfill(session_, symbol, "1d", asset_type, today, today, bars_source=data_sources.bars, now=now)

    tick(session_, now=now, live_cadences=frozenset({NAME}))
    clock.mark(NAME, now.date())
    return JobResult(NAME, ok=True)


__all__ = ("NAME", "due_now", "run")
```

- [ ] **Step 5: Create `jobs/weekly.py`.**

```python
"""`weekly`: evaluates `weekly` strategies once, on the first trading day of each ISO week, 07:00
ET (Lane L3). The brief's table (PROTO-BRIEF §4 L3) overrides 02a §5's fixed "Monday 07:00 ET" to
handle a Monday holiday (e.g. MLK Day) correctly -- the week's evaluation runs on its first
trading day instead of being silently skipped that week."""

from datetime import date, datetime, time

import pandas as pd
from sqlalchemy.orm import Session

from ai_trading.core.calendar import ET, Asset, session
from ai_trading.engine.tick import tick
from ai_trading.jobs import JobResult
from ai_trading.jobs.clock import JobClock

NAME = "weekly"
_SCHEDULED_ET = time(7, 0)


def _first_of_week(asset: Asset, day: date) -> bool:
    """True when no earlier trading day falls in the same ISO week -- the inverse of
    `ai_trading.core.evaluate._last_of_week`."""
    for offset in range(1, day.weekday() + 1):
        earlier = pd.Timestamp(day) - pd.Timedelta(days=offset)
        if session(asset, earlier.date()) is not None:
            return False
    return True


def due_now(now: datetime) -> bool:
    """True from 07:00 ET onward on the first XNYS stock trading day of the ISO week (open
    window, same catch-up reasoning as `premarket.due_now`)."""
    et_now = now.astimezone(ET)
    today = et_now.date()
    if session("stock", today) is None or not _first_of_week("stock", today):
        return False
    return et_now.time() >= _SCHEDULED_ET


def run(session_: Session, clock: JobClock, *, now: datetime) -> JobResult:
    tick(session_, now=now, live_cadences=frozenset({NAME}))
    clock.mark(NAME, now.date())
    return JobResult(NAME, ok=True)


__all__ = ("NAME", "due_now", "run", "_first_of_week")
```

- [ ] **Step 6: Create `jobs/refresh_15m.py`** (integration fix #3 — fetches directly, not through
  `backfill()`):

```python
"""The 15-minute in-session refresh (02 §8): backfills the day's forming session for every
distinct stock watchlist symbol, then evaluates the live (`bar_close_*`) cadences against the
freshly delayed bars. Stocks only -- futures stay `unavailable` without IBKR (D-c)."""

from datetime import datetime, time

from ai_trading_common.registry import DataSources
from sqlalchemy import select
from sqlalchemy.orm import Session

from ai_trading.core.calendar import ET, session
from ai_trading.data.bars import upsert_bars
from ai_trading.db.models import WatchlistItem
from ai_trading.engine.tick import tick
from ai_trading.jobs import JobResult

NAME = "refresh_15m"
_WINDOW_START = time(7, 0)
_WINDOW_END = time(17, 0)
_LIVE_CADENCES = frozenset({"bar_close_1m", "bar_close_5m", "bar_close_15m", "bar_close_1h"})


def due_now(now: datetime) -> bool:
    """Every 15 minutes, 07:00-17:00 ET, on an XNYS stock trading day."""
    et_now = now.astimezone(ET)
    if session("stock", et_now.date()) is None:
        return False
    if not (_WINDOW_START <= et_now.time() <= _WINDOW_END):
        return False
    return et_now.minute % 15 == 0


def run(session_: Session, data_sources: DataSources, *, now: datetime) -> JobResult:
    """Fetches today's 1-minute bars for every distinct stock watchlist symbol directly from
    `data_sources.bars` and `upsert_bars`s them, then runs `engine.tick.tick` for the live
    cadences (quality stays `delayed-15m`: this job supplies fresher delayed bars, never realtime
    ones).

    Integration fix: no longer routed through `ai_trading.data.backfill.backfill`.
    `backfill()`'s own `missing_sessions` check only ever reports a whole day as "missing" when
    *no* bar at all is stored for it yet (Phase 2a's own contract, built for filling
    session-level gaps, not for continuously extending an already-started day) -- so once today's
    first 1-minute bar landed, a later same-day `backfill()` call found nothing new to fetch
    (REPORT-L3.md's own flagged limitation). Calling `data_sources.bars.bars()` directly every
    time and letting `upsert_bars` (idempotent, closed-bars-only) do the merge means a later
    same-day call always stores whatever new minutes have closed since the previous call.
    """
    today = now.astimezone(ET).date()
    found = session("stock", today)
    if found is None:
        tick(session_, now=now, live_cadences=_LIVE_CADENCES)
        return JobResult(NAME, ok=True)

    symbols = (
        session_.execute(select(WatchlistItem.symbol).where(WatchlistItem.asset_type == "stock").distinct())
        .scalars()
        .all()
    )
    for symbol in symbols:
        bars = data_sources.bars.bars(symbol, "1m", found.extended_open, found.extended_close, now=now)
        upsert_bars(session_, symbol, "1m", bars.frame, bars.source, "stock", now=now)

    tick(session_, now=now, live_cadences=_LIVE_CADENCES)
    return JobResult(NAME, ok=True)


__all__ = ("NAME", "due_now", "run")
```

- [ ] **Step 7: Create `jobs/backfill_watchlist.py`.**

```python
"""Backfill on watchlist join (Lane L3): called synchronously from the API's watchlist-item-
create endpoint (L4), not on a cadence."""

from dataclasses import dataclass, field
from datetime import datetime

from ai_trading_common.registry import DataSources
from sqlalchemy.orm import Session

from ai_trading.core.calendar import ET, Asset
from ai_trading.data.backfill import ALPACA_FREE_HISTORY_START
from ai_trading.data.backfill import BackfillResult as TimeframeResult
from ai_trading.data.backfill import backfill as backfill_timeframe

#: Stocks only (D-c): a future has no data source at all until 2b's IBKR client ships.
_STOCK_TIMEFRAMES = ("1d", "1h")


@dataclass(frozen=True)
class BackfillResult:
    """What one `backfill_on_join` call covered: one `ai_trading.data.backfill.BackfillResult`
    per timeframe it touched. Empty for a future symbol -- it backfills nothing and the API still
    creates the `watchlist_items` row (02c §4 L3/L4)."""

    symbol: str
    by_timeframe: dict[str, TimeframeResult] = field(default_factory=dict)


def backfill_on_join(
    session: Session, data_sources: DataSources, *, symbol: str, asset: Asset, now: datetime
) -> BackfillResult:
    """Backfills `bars_1d` (and `bars_1h` for a stock) from `ALPACA_FREE_HISTORY_START` to today."""
    if asset != "stock":
        return BackfillResult(symbol)
    today = now.astimezone(ET).date()
    by_timeframe = {
        timeframe: backfill_timeframe(
            session, symbol, timeframe, asset, ALPACA_FREE_HISTORY_START, today, bars_source=data_sources.bars, now=now
        )
        for timeframe in _STOCK_TIMEFRAMES
    }
    return BackfillResult(symbol, by_timeframe)


__all__ = ("BackfillResult", "backfill_on_join")
```

- [ ] **Step 8: Create `jobs/watchdog.py`.**

```python
"""The dead-man check (02 §11): alerts once when a scheduled job has not completed within
`OVERDUE_AFTER` of its usual slot. No "gateway down" half in Phase 3 -- there is no gateway; that
half of 02 §11's dead-man check starts in 2b, where `engine.degraded.quality_for`'s inputs
change."""

from datetime import datetime, time, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from ai_trading.core.calendar import ET, session
from ai_trading.db.models import Alert, User
from ai_trading.jobs.clock import JobClock
from ai_trading.jobs.weekly import _first_of_week
from ai_trading.notify.dedupe import should_alert

#: Each job's usual slot (ET), matching 02/02a's schedule table. `daily_close`'s own `due_now` is
#: this same fixed 16:30 ET slot (integration fix: a FIXED time on every trading day, half days
#: included -- see `daily_close.py`'s docstring) -- not a separate value that happens to agree.
JOB_SCHEDULE = {"premarket_0830": time(8, 30), "daily_close": time(16, 30), "weekly": time(7, 0)}
OVERDUE_AFTER = timedelta(minutes=20)  # 02 §11 dead-man check


def due_now(now: datetime) -> bool:
    """True on every tick on an XNYS stock trading day -- cheap (DB-only) and re-run-safe;
    `should_alert`'s cooldown is what prevents repeat alerts, not this function."""
    return session("stock", now.astimezone(ET).date()) is not None


def run(session_: Session, clock: JobClock, *, now: datetime) -> list[str]:
    """For each `JOB_SCHEDULE` entry due today whose slot time + `OVERDUE_AFTER` has passed and
    `clock.succeeded_today(name, now)` is False: raises a system alert, gated by `should_alert`.
    Returns the job names alerted this call."""
    today = now.astimezone(ET).date()
    if session("stock", today) is None:
        return []

    alerted: list[str] = []
    for name, slot in JOB_SCHEDULE.items():
        if name == "weekly" and not _first_of_week("stock", today):
            continue  # weekly's own slot only exists on the week's first trading day
        deadline = datetime.combine(today, slot, tzinfo=ET) + OVERDUE_AFTER
        if now < deadline or clock.succeeded_today(name, now):
            continue
        dedupe_key = f"job-overdue:{name}:{today}"
        if not should_alert(session_, dedupe_key=dedupe_key, cooldown=timedelta(hours=1), now=now):
            continue
        for user in session_.execute(select(User)).scalars():
            session_.add(
                Alert(
                    user_id=user.id,
                    kind="system",
                    severity="system",
                    dedupe_key=dedupe_key,
                    title=f"{name} is overdue",
                    body=f"{name} has not completed today ({today}); its usual slot is {slot.isoformat()} ET.",
                    created_at=now,
                )
            )
        alerted.append(name)
    return alerted


__all__ = ("JOB_SCHEDULE", "OVERDUE_AFTER", "due_now", "run")
```

- [ ] **Step 9: Create `jobs/relogin_reminder.py`.**

```python
"""Sunday 18:00 ET: a standing reminder to re-login to IBKR's weekly 2FA session (02a §5) -- not
a liveness check, so it fires every week regardless of IBKR connectivity."""

from datetime import datetime, time, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from ai_trading.core.calendar import ET
from ai_trading.db.models import Alert, User
from ai_trading.jobs import JobResult
from ai_trading.jobs.clock import JobClock
from ai_trading.notify.dedupe import should_alert

NAME = "relogin_reminder"
_SCHEDULED_ET = time(18, 0)
_SUNDAY = 6


def due_now(now: datetime) -> bool:
    """Every Sunday at 18:00 ET, regardless of IBKR connectivity."""
    et_now = now.astimezone(ET)
    return et_now.weekday() == _SUNDAY and et_now.time() >= _SCHEDULED_ET


def run(session_: Session, clock: JobClock, *, now: datetime) -> JobResult:
    """Writes one `alerts` row per user (kind="system", severity="system" -- F3/review fix:
    `notify.quiet_hours.in_quiet_hours` only bypasses "system"/"risk" severities, and this is a
    standing operator reminder that must still reach the owner inside their quiet hours, not a
    routine "info" notice), gated by `should_alert` so a same-week re-fire is a no-op.

    Marks `clock` on success (whether or not a new alert was actually written -- a dedupe-
    suppressed call is still a successful run of this slot) so `scheduler.run_due` does not call
    this again for the rest of today's open `due_now()` window (F1/F2)."""
    dedupe_key = f"relogin-reminder:{now.date()}"
    if should_alert(session_, dedupe_key=dedupe_key, cooldown=timedelta(days=6), now=now):
        for user in session_.execute(select(User)).scalars():
            session_.add(
                Alert(
                    user_id=user.id,
                    kind="system",
                    severity="system",
                    dedupe_key=dedupe_key,
                    title="Re-login to IBKR",
                    body="IBKR's weekly session needs a fresh 2FA login before the market opens.",
                    created_at=now,
                )
            )
    clock.mark(NAME, now.date())
    return JobResult(NAME, ok=True)


__all__ = ("NAME", "due_now", "run")
```

- [ ] **Step 10: Create `jobs/healthcheck.py`** (review fix F4c -- the scheduler's own Docker
  healthcheck, Task 3.6's compose `healthcheck:` for the `scheduler` service runs this as
  `python -m ai_trading.jobs.healthcheck`):

```python
"""`python -m ai_trading.jobs.healthcheck`: the `scheduler` compose service's Docker healthcheck
(F4c). `scheduler` has no HTTP endpoint for Docker to poll (unlike `api`'s `/healthz`), so instead
its own main loop touches a heartbeat file once per iteration (`scheduler.main`), and this process
exits 0 only while that file is still fresh -- a stuck or crashed loop stops touching it and this
starts failing within one `FRESH_SECONDS` window.
"""

import os
import sys
import time
from pathlib import Path

HEARTBEAT_PATH_VAR = "DESK_SCHEDULER_HEARTBEAT"
DEFAULT_HEARTBEAT_PATH = "/tmp/desk-scheduler.heartbeat"
FRESH_SECONDS = 180.0


def heartbeat_path() -> Path:
    return Path(os.environ.get(HEARTBEAT_PATH_VAR, DEFAULT_HEARTBEAT_PATH))


def touch(path: Path) -> None:
    """Creates (or updates the mtime of) `path`, creating its parent directory if needed."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.touch()


def is_healthy(path: Path, *, now: float | None = None) -> bool:
    """True iff `path` exists and was touched less than `FRESH_SECONDS` ago."""
    try:
        age = (time.time() if now is None else now) - path.stat().st_mtime
    except FileNotFoundError:
        return False
    return age < FRESH_SECONDS


def main() -> int:
    return 0 if is_healthy(heartbeat_path()) else 1


if __name__ == "__main__":
    sys.exit(main())


__all__ = (
    "DEFAULT_HEARTBEAT_PATH",
    "FRESH_SECONDS",
    "HEARTBEAT_PATH_VAR",
    "heartbeat_path",
    "is_healthy",
    "main",
    "touch",
)
```

- [ ] **Step 11: Create `jobs/scheduler.py`** (review fixes F1/F2/F4a/F4b: a `_SLOTTED` job that
  already succeeded today is skipped rather than re-run every minute for the rest of its
  `due_now()` window; `relogin_reminder` is wired into `_ORDER`/`_DUE_NOW`/the dispatch branches, so
  it actually runs; `main()` retries the database connection on startup and touches a heartbeat
  file every loop):

```python
"""The process entrypoint for the `scheduler` compose service (02c Phase 3)."""

import logging
import os
import sys
import time as _time
from collections.abc import Callable
from datetime import UTC, datetime

from ai_trading_common.registry import DataSources
from sqlalchemy import text
from sqlalchemy.orm import Session

from ai_trading.jobs import (
    JobResult,
    daily_close,
    healthcheck,
    premarket,
    refresh_15m,
    relogin_reminder,
    watchdog,
    weekly,
)
from ai_trading.jobs.clock import JobClock

logger = logging.getLogger(__name__)

#: `watchdog` last, so it sees this tick's own completions.
_ORDER = ("premarket_0830", "daily_close", "weekly", "relogin_reminder", "refresh_15m", "watchdog")

#: These jobs each fire once per day (or once per week) but their own `due_now()` is an open
#: window (true for the rest of the day/week once their slot starts), not a single exact minute --
#: without this gate, a successful run reran every minute for the rest of its window (F1/F2 review
#: fix). `JobClock.succeeded_today` is what stops that: each of these jobs' own `run()` marks the
#: clock only on success, so a failed run is still retried on the next tick. `refresh_15m` is
#: meant to re-run every 15 minutes (not slotted this way) and `watchdog`'s own dedupe cooldown
#: already gates its alerts, so neither belongs here.
_SLOTTED = ("premarket_0830", "daily_close", "weekly", "relogin_reminder")

_DUE_NOW = {
    "premarket_0830": premarket.due_now,
    "daily_close": daily_close.due_now,
    "weekly": weekly.due_now,
    "relogin_reminder": relogin_reminder.due_now,
    "refresh_15m": refresh_15m.due_now,
    "watchdog": watchdog.due_now,
}

#: F4a: bounded startup retry against the shared Postgres cluster, which may still be cold when
#: `scheduler` starts (same reasoning as `api`'s `/healthz`, but `scheduler` has no HTTP endpoint
#: for Docker to poll, so the retry lives in-process instead).
_STARTUP_RETRY_ATTEMPTS = 30
_STARTUP_RETRY_DELAY_SECONDS = 2.0


def due_now(now: datetime) -> list[str]:
    """Every job name whose own `due_now(now)` is True right now, in `_ORDER`."""
    return [name for name in _ORDER if _DUE_NOW[name](now)]


def run_due(session: Session, data_sources: DataSources, clock: JobClock, *, now: datetime) -> list[JobResult]:
    """Runs every due job in order (`_ORDER`). A `_SLOTTED` job that already succeeded today is
    skipped without being called again -- see `_SLOTTED`'s own comment (F1/F2). A job raising
    halts only that job (02c: "halting on failure") -- caught here, logged as a
    `JobResult(ok=False, error=...)`, and does not stop the remaining due jobs or crash the
    process."""
    due = set(due_now(now))
    results: list[JobResult] = []
    for name in _ORDER:
        if name not in due:
            continue
        if name in _SLOTTED and clock.succeeded_today(name, now):
            results.append(JobResult(name, ok=True, ran=False))
            continue
        try:
            if name == "premarket_0830":
                results.append(premarket.run(session, clock, now=now))
            elif name == "daily_close":
                results.append(daily_close.run(session, data_sources, clock, now=now))
            elif name == "weekly":
                results.append(weekly.run(session, clock, now=now))
            elif name == "relogin_reminder":
                results.append(relogin_reminder.run(session, clock, now=now))
            elif name == "refresh_15m":
                results.append(refresh_15m.run(session, data_sources, now=now))
            else:  # watchdog
                alerted = watchdog.run(session, clock, now=now)
                results.append(JobResult("watchdog", ok=True, ran=bool(alerted)))
        except Exception as exc:  # noqa: BLE001 -- "halting on failure": one job never stops the rest
            results.append(JobResult(name, ok=False, error=str(exc)))
    return results


def _wait_for_database(
    engine,
    *,
    attempts: int = _STARTUP_RETRY_ATTEMPTS,
    delay: float = _STARTUP_RETRY_DELAY_SECONDS,
    sleep: Callable[[float], None] = _time.sleep,
) -> None:
    """F4a: tries `SELECT 1` against `engine` up to `attempts` times, `delay` seconds apart.
    Returns as soon as one attempt succeeds. Exits the process non-zero (`sys.exit(1)`) once
    `attempts` is exhausted -- `restart: unless-stopped` then retries the whole process."""
    for attempt in range(1, attempts + 1):
        try:
            with engine.connect() as conn:
                conn.execute(text("SELECT 1"))
            return
        except Exception:
            logger.warning("database not reachable yet (attempt %d/%d)", attempt, attempts)
            sleep(delay)
    logger.error("database never became reachable after %d attempts; exiting", attempts)
    sys.exit(1)


def main() -> None:  # pragma: no cover -- the real loop; exercised through `run_due`'s own tests
    from ai_trading.db.engine import make_engine, make_session_factory

    engine = make_engine(os.environ["DESK_RUNTIME_DATABASE_URL"])
    _wait_for_database(engine)
    factory = make_session_factory(engine)
    sources = DataSources.from_env()
    clock = JobClock()
    heartbeat = healthcheck.heartbeat_path()
    while True:
        with factory() as session:
            run_due(session, sources, clock, now=datetime.now(UTC))
            session.commit()
        healthcheck.touch(heartbeat)  # F4b: proves this loop iteration to ai_trading.jobs.healthcheck
        _time.sleep(60)


if __name__ == "__main__":
    main()


__all__ = ("due_now", "run_due", "main")
```

- [ ] **Step 12: Create `tests/jobs/conftest.py`** (network-free `BarsSource` double and shared
  `owner`/`watchlist_with_items` fixtures, reused by `test_daily_close.py`,
  `test_refresh_15m.py`, `test_backfill_watchlist.py`, `test_watchdog.py`,
  `test_relogin_reminder.py`):

```python
"""Shared, network-free test support for the `ai_trading.jobs` suite (Lane L3)."""

from __future__ import annotations

import sys
from datetime import date, timedelta
from pathlib import Path

import pandas as pd
import pytest
from ai_trading_common.bars import Bars
from sqlalchemy import insert
from sqlalchemy.orm import Session

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # tests/bars.py's flat-bar helpers
from bars import daily_bars, minute_bars  # noqa: E402

from ai_trading.core.calendar import session as _session
from ai_trading.data.bars import bar_close
from ai_trading.db.models import User, Watchlist, WatchlistItem


class FakeBarsSource:
    """A `BarsSource` double: never touches the network. Serves flat, already-closed-as-of-`now`
    bars built from `tests/bars.py`'s helpers, and records every call it answered."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, str, pd.Timestamp, pd.Timestamp]] = []

    def bars(self, symbol: str, timeframe: str, start: pd.Timestamp, end: pd.Timestamp, *, now: pd.Timestamp) -> Bars:
        self.calls.append((symbol, timeframe, start, end))
        quality = "eod" if timeframe == "1d" else "delayed-15m"
        return Bars(frame=_frame(timeframe, start, end, now), source="fake", quality=quality)


def _days_between(start: pd.Timestamp, end: pd.Timestamp) -> list[date]:
    start_day = pd.Timestamp(start).tz_convert("America/New_York").date()
    end_day = pd.Timestamp(end).tz_convert("America/New_York").date()
    days, cursor = [], start_day
    while cursor <= end_day:
        days.append(cursor)
        cursor += timedelta(days=1)
    return days


def _frame(timeframe: str, start: pd.Timestamp, end: pd.Timestamp, now: pd.Timestamp) -> pd.DataFrame:
    days = [d for d in _days_between(start, end) if _session("stock", d) is not None]

    if timeframe == "1d":
        closed = [d for d in days if bar_close("stock", "1d", d) <= now]
        return daily_bars(closed, [100.0] * len(closed))

    if (end.tz_convert("America/New_York").date() - start.tz_convert("America/New_York").date()).days == 0:
        # A single-day request (refresh_15m's own `start=end=today`): the whole session's worth
        # of minute bars, same shape `test_templates.py` already relies on.
        full = minute_bars("stock", days[0]) if days else minute_bars("stock", start.date())
        mask = [bar_close("stock", timeframe, pd.Timestamp(idx)) <= now for idx in full.index]
        return full[mask]

    # A multi-day request (`backfill_on_join`'s whole-history span): one bar per trading day, at
    # that day's open -- cheap (no minute-by-minute blowup over a decade) and still enough to
    # mark every day in range as "present" to `ai_trading.data.bars.missing_sessions`.
    index = [_session("stock", d).extended_open for d in days]
    index = [point for point in index if bar_close("stock", timeframe, point) <= now]
    return pd.DataFrame(
        {"open": 100.0, "high": 100.0, "low": 100.0, "close": 100.0, "volume": 1_000.0},
        index=pd.DatetimeIndex(index),
    )


@pytest.fixture
def owner(db_session: Session) -> int:
    return db_session.execute(insert(User).values(email="owner@example.test").returning(User.id)).scalar_one()


@pytest.fixture
def watchlist_with_items(db_session: Session, owner: int) -> int:
    """One watchlist with one stock (`AAPL`) and one future (`ES`) item."""
    watchlist_id = db_session.execute(
        insert(Watchlist).values(user_id=owner, name="core", horizon="swing").returning(Watchlist.id)
    ).scalar_one()
    db_session.execute(insert(WatchlistItem).values(watchlist_id=watchlist_id, symbol="AAPL", asset_type="stock"))
    db_session.execute(insert(WatchlistItem).values(watchlist_id=watchlist_id, symbol="ES", asset_type="future"))
    db_session.commit()
    return watchlist_id
```

- [ ] **Step 13: Create the 9 test files.**

`tests/jobs/test_clock.py`:

```python
from datetime import UTC, date, datetime

from ai_trading.jobs.clock import JobClock


def test_succeeded_today_is_false_before_any_mark():
    clock = JobClock()
    assert clock.succeeded_today("premarket_0830", datetime(2026, 10, 6, 13, 0, tzinfo=UTC)) is False


def test_mark_then_succeeded_today_is_true_for_that_utc_date():
    clock = JobClock()
    clock.mark("daily_close", date(2026, 10, 6))
    assert clock.succeeded_today("daily_close", datetime(2026, 10, 6, 23, 0, tzinfo=UTC)) is True


def test_succeeded_today_is_false_on_a_different_utc_date():
    clock = JobClock()
    clock.mark("weekly", date(2026, 10, 6))
    assert clock.succeeded_today("weekly", datetime(2026, 10, 7, 12, 0, tzinfo=UTC)) is False


def test_mark_is_per_job_name():
    clock = JobClock()
    clock.mark("premarket_0830", date(2026, 10, 6))
    assert clock.succeeded_today("daily_close", datetime(2026, 10, 6, 23, 0, tzinfo=UTC)) is False
```

`tests/jobs/test_premarket.py` (Review Focus 4's DST test lives here):

```python
from datetime import UTC, datetime

from ai_trading.jobs import premarket
from ai_trading.jobs.clock import JobClock


def test_due_now_is_false_before_0830_et():
    # 2026-10-06 12:29 UTC == 08:29 ET (EDT, UTC-4) -- one minute before the slot.
    assert premarket.due_now(datetime(2026, 10, 6, 12, 29, tzinfo=UTC)) is False


def test_due_now_is_true_at_and_after_0830_et_on_a_trading_day():
    assert premarket.due_now(datetime(2026, 10, 6, 12, 30, tzinfo=UTC)) is True
    assert premarket.due_now(datetime(2026, 10, 6, 20, 0, tzinfo=UTC)) is True  # open window: still due later


def test_due_now_is_false_on_a_non_trading_day():
    # 2026-11-26 is Thanksgiving, an XNYS holiday.
    assert premarket.due_now(datetime(2026, 11, 26, 13, 30, tzinfo=UTC)) is False


def test_due_now_premarket_0830_shifts_correctly_across_the_dst_change():
    # 2026-03-06 (EST, UTC-5): 08:30 ET == 13:30 UTC. 2026-03-09 (EDT, UTC-4, after the spring
    # DST change): 08:30 ET == 12:30 UTC. Both must read as "due" at their own 08:30 ET instant.
    assert premarket.due_now(datetime(2026, 3, 6, 13, 30, tzinfo=UTC)) is True
    assert premarket.due_now(datetime(2026, 3, 6, 13, 29, tzinfo=UTC)) is False
    assert premarket.due_now(datetime(2026, 3, 9, 12, 30, tzinfo=UTC)) is True
    assert premarket.due_now(datetime(2026, 3, 9, 12, 29, tzinfo=UTC)) is False


def test_run_calls_tick_with_its_own_cadence_and_marks_the_clock(monkeypatch):
    calls = []
    monkeypatch.setattr(premarket, "tick", lambda session, *, now, live_cadences: calls.append((now, live_cadences)))
    clock = JobClock()
    now = datetime(2026, 10, 6, 13, 30, tzinfo=UTC)

    result = premarket.run(session_=object(), clock=clock, now=now)

    assert result.name == "premarket_0830"
    assert result.ok is True
    assert calls == [(now, frozenset({"premarket_0830"}))]
    assert clock.succeeded_today("premarket_0830", now) is True
```

`tests/jobs/test_daily_close.py` (Review Focus 4's half-day test lives here, Decision 3):

```python
from datetime import UTC, datetime

from conftest import FakeBarsSource

from ai_trading.data.bars import read_bars
from ai_trading.jobs import daily_close
from ai_trading.jobs.clock import JobClock


class _FakeSources:
    def __init__(self, bars: FakeBarsSource) -> None:
        self.bars = bars


def test_due_now_is_false_before_1630_et():
    # 2026-10-06 is a regular session (EDT, UTC-4): 16:30 ET == 20:30 UTC.
    assert daily_close.due_now(datetime(2026, 10, 6, 20, 29, tzinfo=UTC)) is False


def test_due_now_is_true_at_and_after_1630_et():
    assert daily_close.due_now(datetime(2026, 10, 6, 20, 30, tzinfo=UTC)) is True
    assert daily_close.due_now(datetime(2026, 10, 6, 23, 59, tzinfo=UTC)) is True


def test_due_now_is_false_on_a_non_trading_day():
    assert daily_close.due_now(datetime(2026, 11, 26, 21, 30, tzinfo=UTC)) is False  # Thanksgiving


def test_due_now_daily_close_fires_at_the_half_days_1300_et_close(db_session, watchlist_with_items, monkeypatch):
    # 2026-11-27 is a half day: its own regular close is 13:00 ET (18:00 UTC, EST) -- but
    # `daily_close` fires at a FIXED 16:30 ET (21:30 UTC) on every XNYS trading day, half days
    # included, not at the session's own early close (integration fix).
    assert daily_close.due_now(datetime(2026, 11, 27, 21, 29, tzinfo=UTC)) is False
    assert daily_close.due_now(datetime(2026, 11, 27, 21, 30, tzinfo=UTC)) is True

    # By 16:30 ET the half day's own 13:00 ET close has long passed, so when the job actually
    # runs at its fixed slot, the half-day bar is already closed and gets stored.
    fake_bars = FakeBarsSource()
    sources = _FakeSources(fake_bars)
    clock = JobClock()
    now = datetime(2026, 11, 27, 21, 30, tzinfo=UTC)

    result = daily_close.run(db_session, sources, clock, now=now)
    db_session.commit()

    assert result == daily_close.JobResult("daily_close", ok=True)
    bars = read_bars(db_session, "AAPL", "1d", now.date(), now.date(), "stock", as_of=now)
    assert list(bars["close"]) == [100.0]


def test_run_backfills_every_distinct_stock_symbol_then_ticks(db_session, watchlist_with_items, monkeypatch):
    fake_bars = FakeBarsSource()
    sources = _FakeSources(fake_bars)
    ticked = []
    monkeypatch.setattr(daily_close, "tick", lambda session, *, now, live_cadences: ticked.append(live_cadences))
    clock = JobClock()
    now = datetime(2026, 10, 6, 20, 30, tzinfo=UTC)

    result = daily_close.run(db_session, sources, clock, now=now)
    db_session.commit()

    assert result == daily_close.JobResult("daily_close", ok=True)
    # Only AAPL (stock) is backfilled -- ES (future) has no data source in Phase 3 (D-c).
    assert [call[0] for call in fake_bars.calls] == ["AAPL"]
    assert ticked == [frozenset({"daily_close"})]
    assert clock.succeeded_today("daily_close", now) is True


def test_run_writes_the_days_bar(db_session, watchlist_with_items):
    fake_bars = FakeBarsSource()
    sources = _FakeSources(fake_bars)
    clock = JobClock()
    now = datetime(2026, 10, 6, 20, 30, tzinfo=UTC)

    daily_close.run(db_session, sources, clock, now=now)
    db_session.commit()

    bars = read_bars(db_session, "AAPL", "1d", now.date(), now.date(), "stock", as_of=now)
    assert list(bars["close"]) == [100.0]
```

`tests/jobs/test_weekly.py`:

```python
from datetime import UTC, date, datetime

from ai_trading.jobs import weekly
from ai_trading.jobs.clock import JobClock


def test_first_of_week_is_true_for_monday_when_monday_trades():
    assert weekly._first_of_week("stock", date(2026, 10, 5)) is True  # a Monday


def test_first_of_week_is_false_for_a_later_trading_day():
    assert weekly._first_of_week("stock", date(2026, 10, 6)) is False  # Tuesday, same week


def test_first_of_week_shifts_to_tuesday_when_monday_is_a_holiday():
    # 2026-01-19 is MLK Day (a Monday XNYS holiday); the week's first trading day is Tuesday.
    assert weekly._first_of_week("stock", date(2026, 1, 20)) is True


def test_due_now_is_false_before_0700_et_on_the_first_trading_day():
    assert weekly.due_now(datetime(2026, 10, 5, 10, 59, tzinfo=UTC)) is False  # 06:59 ET


def test_due_now_is_true_at_and_after_0700_et_on_the_first_trading_day():
    assert weekly.due_now(datetime(2026, 10, 5, 11, 0, tzinfo=UTC)) is True  # 07:00 ET, Monday


def test_due_now_is_false_on_a_later_trading_day_of_the_same_week():
    assert weekly.due_now(datetime(2026, 10, 6, 11, 0, tzinfo=UTC)) is False  # Tuesday


def test_due_now_shifts_to_tuesday_when_monday_is_a_holiday():
    assert weekly.due_now(datetime(2026, 1, 19, 12, 0, tzinfo=UTC)) is False  # MLK Day itself
    assert weekly.due_now(datetime(2026, 1, 20, 12, 0, tzinfo=UTC)) is True  # Tuesday, 07:00 ET


def test_run_calls_tick_with_its_own_cadence_and_marks_the_clock(monkeypatch):
    calls = []
    monkeypatch.setattr(weekly, "tick", lambda session, *, now, live_cadences: calls.append(live_cadences))
    clock = JobClock()
    now = datetime(2026, 10, 5, 11, 0, tzinfo=UTC)

    result = weekly.run(session_=object(), clock=clock, now=now)

    assert result.ok is True
    assert calls == [frozenset({"weekly"})]
    assert clock.succeeded_today("weekly", now) is True
```

`tests/jobs/test_refresh_15m.py` (integration fix #3's new test is the last one here):

```python
from datetime import UTC, datetime

from conftest import FakeBarsSource

from ai_trading.data.bars import read_bars
from ai_trading.jobs import refresh_15m


class _FakeSources:
    def __init__(self, bars: FakeBarsSource) -> None:
        self.bars = bars


def test_due_now_is_true_only_on_15_minute_marks_within_the_window():
    assert refresh_15m.due_now(datetime(2026, 10, 6, 14, 0, tzinfo=UTC)) is True  # 10:00 ET
    assert refresh_15m.due_now(datetime(2026, 10, 6, 14, 15, tzinfo=UTC)) is True
    assert refresh_15m.due_now(datetime(2026, 10, 6, 14, 5, tzinfo=UTC)) is False


def test_due_now_is_false_outside_the_window():
    assert refresh_15m.due_now(datetime(2026, 10, 6, 10, 45, tzinfo=UTC)) is False  # 06:45 ET
    assert refresh_15m.due_now(datetime(2026, 10, 6, 21, 15, tzinfo=UTC)) is False  # 17:15 ET


def test_due_now_is_false_on_a_non_trading_day():
    assert refresh_15m.due_now(datetime(2026, 11, 26, 14, 0, tzinfo=UTC)) is False  # Thanksgiving


def test_run_backfills_stock_symbols_only_and_ticks(db_session, watchlist_with_items, monkeypatch):
    fake_bars = FakeBarsSource()
    sources = _FakeSources(fake_bars)
    ticked = []
    monkeypatch.setattr(refresh_15m, "tick", lambda session, *, now, live_cadences: ticked.append(live_cadences))
    now = datetime(2026, 10, 6, 14, 0, tzinfo=UTC)

    result = refresh_15m.run(db_session, sources, now=now)
    db_session.commit()

    assert result.ok is True
    assert [call[0] for call in fake_bars.calls] == ["AAPL"]  # ES (future) is excluded, D-c
    assert ticked == [refresh_15m._LIVE_CADENCES]


def test_a_second_same_day_call_stores_the_minutes_that_appeared_since_the_first_call(db_session, watchlist_with_items):
    # Integration fix: `run` now fetches `data_sources.bars` directly and `upsert_bars`s the
    # result instead of routing through `ai_trading.data.backfill.backfill`, whose
    # `missing_sessions` check only ever treats a whole day as "missing" -- a later same-day call
    # used to find today's first bar already present and fetch nothing new (REPORT-L3.md's own
    # flagged limitation). Two same-day calls at different `now`s must store progressively more
    # minutes.
    from ai_trading.core.calendar import session as calendar_session

    fake_bars = FakeBarsSource()
    sources = _FakeSources(fake_bars)
    first_now = datetime(2026, 10, 6, 14, 0, tzinfo=UTC)  # 10:00 ET
    second_now = datetime(2026, 10, 6, 14, 30, tzinfo=UTC)  # 10:30 ET, same trading day
    found = calendar_session("stock", first_now.date())

    refresh_15m.run(db_session, sources, now=first_now)
    db_session.commit()
    first_bars = read_bars(
        db_session, "AAPL", "1m", found.extended_open, found.extended_close, "stock", as_of=second_now
    )

    refresh_15m.run(db_session, sources, now=second_now)
    db_session.commit()
    second_bars = read_bars(
        db_session, "AAPL", "1m", found.extended_open, found.extended_close, "stock", as_of=second_now
    )

    assert len(second_bars) > len(first_bars) > 0
```

`tests/jobs/test_backfill_watchlist.py`:

```python
from datetime import UTC, datetime

from conftest import FakeBarsSource

from ai_trading.data.backfill import ALPACA_FREE_HISTORY_START
from ai_trading.jobs.backfill_watchlist import backfill_on_join


class _FakeSources:
    def __init__(self, bars: FakeBarsSource) -> None:
        self.bars = bars


NOW = datetime(2026, 10, 6, 21, 0, tzinfo=UTC)


def test_a_stock_symbol_backfills_1d_and_1h_from_the_free_history_start(db_session):
    fake_bars = FakeBarsSource()
    sources = _FakeSources(fake_bars)

    result = backfill_on_join(db_session, sources, symbol="AAPL", asset="stock", now=NOW)
    db_session.commit()

    assert result.symbol == "AAPL"
    assert set(result.by_timeframe) == {"1d", "1h"}
    timeframes_requested = {call[1] for call in fake_bars.calls}
    assert timeframes_requested == {"1d", "1h"}
    for call in fake_bars.calls:
        assert call[2].tz_convert("America/New_York").date() >= ALPACA_FREE_HISTORY_START


def test_a_future_symbol_backfills_nothing_and_returns_an_empty_result(db_session):
    fake_bars = FakeBarsSource()
    sources = _FakeSources(fake_bars)

    result = backfill_on_join(db_session, sources, symbol="ES", asset="future", now=NOW)

    assert result.symbol == "ES"
    assert result.by_timeframe == {}
    assert fake_bars.calls == []


def test_calling_it_twice_is_idempotent(db_session):
    fake_bars = FakeBarsSource()
    sources = _FakeSources(fake_bars)

    backfill_on_join(db_session, sources, symbol="AAPL", asset="stock", now=NOW)
    db_session.commit()
    first_call_count = len(fake_bars.calls)

    result = backfill_on_join(db_session, sources, symbol="AAPL", asset="stock", now=NOW)
    db_session.commit()

    # Every session in range is already stored, so the second call's own `backfill()` finds
    # nothing missing -- no new provider call, and `written` is empty for both timeframes.
    assert len(fake_bars.calls) == first_call_count
    assert all(tf_result.written == [] for tf_result in result.by_timeframe.values())
```

`tests/jobs/test_watchdog.py`:

```python
from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from ai_trading.db.models import Alert
from ai_trading.jobs import watchdog
from ai_trading.jobs.clock import JobClock


def test_due_now_is_true_on_any_trading_day():
    assert watchdog.due_now(datetime(2026, 10, 6, 15, 0, tzinfo=UTC)) is True


def test_due_now_is_false_on_a_non_trading_day():
    assert watchdog.due_now(datetime(2026, 11, 26, 15, 0, tzinfo=UTC)) is False  # Thanksgiving


def test_overdue_job_alerts_once(db_session, owner):
    # premarket_0830's slot is 08:30 ET; 08:30 + 20 minutes = 08:50 ET == 12:50 UTC on 2026-10-06.
    now = datetime(2026, 10, 6, 12, 51, tzinfo=UTC)
    clock = JobClock()

    alerted = watchdog.run(db_session, clock, now=now)

    assert alerted == ["premarket_0830"]
    rows = db_session.execute(select(Alert).where(Alert.user_id == owner)).scalars().all()
    assert len(rows) == 1
    assert rows[0].kind == "system"
    assert rows[0].dedupe_key == "job-overdue:premarket_0830:2026-10-06"


def test_not_yet_overdue_does_not_alert(db_session, owner):
    now = datetime(2026, 10, 6, 12, 49, tzinfo=UTC)  # one minute before the deadline
    alerted = watchdog.run(db_session, JobClock(), now=now)
    assert alerted == []


def test_no_alert_when_the_job_already_succeeded_today(db_session, owner):
    now = datetime(2026, 10, 6, 12, 51, tzinfo=UTC)
    clock = JobClock()
    clock.mark("premarket_0830", now.date())

    alerted = watchdog.run(db_session, clock, now=now)

    assert alerted == []


def test_dedupe_suppresses_a_second_call_within_the_cooldown(db_session, owner):
    now = datetime(2026, 10, 6, 12, 51, tzinfo=UTC)
    clock = JobClock()

    first = watchdog.run(db_session, clock, now=now)
    second = watchdog.run(db_session, clock, now=now + timedelta(minutes=1))

    assert first == ["premarket_0830"]
    assert second == []  # same dedupe key, within the 1-hour cooldown
    rows = db_session.execute(select(Alert).where(Alert.user_id == owner)).scalars().all()
    assert len(rows) == 1


def test_weekly_is_only_checked_on_the_first_trading_day_of_the_week(db_session, owner):
    # 2026-10-06 is a Tuesday (2026-10-05, Monday, trades) -- not the week's first trading day,
    # so `weekly`'s overdue check never runs that day, however late `now` is or however long the
    # clock has gone unmarked.
    now = datetime(2026, 10, 6, 11, 21, tzinfo=UTC)  # 07:21 ET: past weekly's 07:00+20min deadline

    alerted = watchdog.run(db_session, JobClock(), now=now)

    assert "weekly" not in alerted
```

`tests/jobs/test_relogin_reminder.py` (review fixes F3/F1: `severity="system"`, and the clock-mark
test/quiet-hours-delivery test this fix added):

```python
from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from ai_trading.db.models import Alert, Delivery, User
from ai_trading.jobs import JobResult, relogin_reminder
from ai_trading.jobs.clock import JobClock
from ai_trading.notify.dispatch import DeliveryOutcome, dispatch_pending


def test_due_now_is_false_before_1800_on_sunday():
    # 2026-10-11 is a Sunday; 17:59 ET (EDT, UTC-4) == 21:59 UTC.
    assert relogin_reminder.due_now(datetime(2026, 10, 11, 21, 59, tzinfo=UTC)) is False


def test_due_now_fires_at_1800_et_on_sunday():
    assert relogin_reminder.due_now(datetime(2026, 10, 11, 22, 0, tzinfo=UTC)) is True
    assert relogin_reminder.due_now(datetime(2026, 10, 11, 23, 30, tzinfo=UTC)) is True  # open window


def test_due_now_is_false_on_a_weekday():
    assert relogin_reminder.due_now(datetime(2026, 10, 12, 22, 0, tzinfo=UTC)) is False  # Monday


def test_writes_one_alert_per_user(db_session, owner):
    now = datetime(2026, 10, 11, 22, 0, tzinfo=UTC)

    result = relogin_reminder.run(db_session, JobClock(), now=now)

    assert result == JobResult(relogin_reminder.NAME, ok=True)
    rows = db_session.execute(select(Alert).where(Alert.user_id == owner)).scalars().all()
    assert len(rows) == 1
    assert rows[0].kind == "system"
    # F3: "system" severity, not "info" -- `notify.quiet_hours.in_quiet_hours` only bypasses
    # "system"/"risk" severities, and this reminder must still reach the owner inside quiet hours.
    assert rows[0].severity == "system"
    assert rows[0].dedupe_key == f"relogin-reminder:{now.date()}"


def test_dedupe_suppresses_a_same_week_refire(db_session, owner):
    first_sunday = datetime(2026, 10, 11, 22, 0, tzinfo=UTC)
    relogin_reminder.run(db_session, JobClock(), now=first_sunday)

    relogin_reminder.run(db_session, JobClock(), now=first_sunday + timedelta(minutes=5))
    rows = db_session.execute(select(Alert).where(Alert.user_id == owner)).scalars().all()
    assert len(rows) == 1  # the second call, same day, is a no-op

    next_sunday = first_sunday + timedelta(days=7)
    relogin_reminder.run(db_session, JobClock(), now=next_sunday)
    rows = db_session.execute(select(Alert).where(Alert.user_id == owner)).scalars().all()
    assert len(rows) == 2  # a week later (past the 6-day cooldown), it fires again


def test_run_marks_the_clock_on_success_so_the_scheduler_does_not_rerun_it(db_session, owner):
    clock = JobClock()
    now = datetime(2026, 10, 11, 22, 0, tzinfo=UTC)

    relogin_reminder.run(db_session, clock, now=now)

    assert clock.succeeded_today(relogin_reminder.NAME, now) is True


def test_the_reminder_alert_still_delivers_during_quiet_hours(db_session, owner):
    """F3: a `system`-severity alert's delivery must not be suppressed by quiet hours, even when
    the user's quiet hours cover the whole day -- the regression this review fix closed (the
    reminder previously used severity="info", which `in_quiet_hours` does NOT bypass)."""
    now = datetime(2026, 10, 11, 22, 0, tzinfo=UTC)
    db_session.execute(
        User.__table__.update()
        .where(User.id == owner)
        .values(settings={"quiet_hours": {"start": "00:00", "end": "23:59"}})
    )

    relogin_reminder.run(db_session, JobClock(), now=now)
    alert = db_session.execute(select(Alert).where(Alert.user_id == owner)).scalar_one()
    delivery = Delivery(alert_id=alert.id, channel="telegram")
    db_session.add(delivery)
    db_session.flush()

    class _FakeChannel:
        name = "telegram"

        def send(self, *, title: str, body: str, severity: str) -> None:
            return None

    outcomes = dispatch_pending(db_session, channels={"telegram": _FakeChannel()}, now=now)

    assert outcomes == [DeliveryOutcome(delivery.id, "sent")]
    assert delivery.status == "sent"
```

`tests/jobs/test_scheduler.py` (review fixes F1/F2/F4a/F4b/F4c: slotted-job gating, `relogin_reminder`
wiring, the startup-retry helper, and the heartbeat/healthcheck module):

```python
from datetime import UTC, datetime, timedelta

import pytest

from ai_trading.jobs import (
    JobResult,
    daily_close,
    healthcheck,
    premarket,
    refresh_15m,
    relogin_reminder,
    scheduler,
    watchdog,
    weekly,
)
from ai_trading.jobs.clock import JobClock


class _FakeSources:
    bars = object()


def test_due_now_lists_only_jobs_that_are_due(monkeypatch):
    # `scheduler._DUE_NOW` binds each submodule's `due_now` once at import time, so patching it
    # directly (not the submodule's own attribute) is what actually takes effect here.
    due = {
        "premarket_0830": True,
        "daily_close": False,
        "weekly": False,
        "relogin_reminder": False,
        "refresh_15m": True,
        "watchdog": False,
    }
    monkeypatch.setattr(scheduler, "_DUE_NOW", {name: (lambda now, v=v: v) for name, v in due.items()})

    assert scheduler.due_now(datetime(2026, 10, 6, 13, 30, tzinfo=UTC)) == ["premarket_0830", "refresh_15m"]


def test_due_now_includes_relogin_reminder_on_sunday_at_1800_et():
    # F2: relogin_reminder was missing from _DUE_NOW entirely, so it never ran.
    assert "relogin_reminder" in scheduler.due_now(datetime(2026, 10, 11, 22, 0, tzinfo=UTC))


def test_run_due_skips_jobs_that_are_not_due(monkeypatch):
    monkeypatch.setattr(scheduler, "_DUE_NOW", dict.fromkeys(scheduler._ORDER, lambda now: False))
    results = scheduler.run_due(object(), _FakeSources(), JobClock(), now=datetime(2026, 10, 6, 13, 30, tzinfo=UTC))
    assert results == []


def test_run_due_runs_jobs_in_order_with_watchdog_last(monkeypatch):
    calls = []
    monkeypatch.setattr(scheduler, "_DUE_NOW", dict.fromkeys(scheduler._ORDER, lambda now: True))
    monkeypatch.setattr(premarket, "run", lambda s, c, *, now: calls.append("premarket_0830") or JobResult("x", True))
    monkeypatch.setattr(daily_close, "run", lambda s, d, c, *, now: calls.append("daily_close") or JobResult("x", True))
    monkeypatch.setattr(weekly, "run", lambda s, c, *, now: calls.append("weekly") or JobResult("x", True))
    monkeypatch.setattr(
        relogin_reminder, "run", lambda s, c, *, now: calls.append("relogin_reminder") or JobResult("x", True)
    )
    monkeypatch.setattr(refresh_15m, "run", lambda s, d, *, now: calls.append("refresh_15m") or JobResult("x", True))
    monkeypatch.setattr(watchdog, "run", lambda s, c, *, now: calls.append("watchdog") or [])

    scheduler.run_due(object(), _FakeSources(), JobClock(), now=datetime(2026, 10, 6, 13, 30, tzinfo=UTC))

    assert calls == ["premarket_0830", "daily_close", "weekly", "relogin_reminder", "refresh_15m", "watchdog"]


def test_run_due_a_failing_job_does_not_stop_the_others(monkeypatch):
    monkeypatch.setattr(scheduler, "_DUE_NOW", dict.fromkeys(scheduler._ORDER, lambda now: True))

    def _boom(*args, **kwargs):
        raise ValueError("boom")

    monkeypatch.setattr(premarket, "run", _boom)
    monkeypatch.setattr(daily_close, "run", lambda s, d, c, *, now: JobResult("daily_close", True))
    monkeypatch.setattr(weekly, "run", lambda s, c, *, now: JobResult("weekly", True))
    monkeypatch.setattr(relogin_reminder, "run", lambda s, c, *, now: JobResult("relogin_reminder", True))
    monkeypatch.setattr(refresh_15m, "run", lambda s, d, *, now: JobResult("refresh_15m", True))
    monkeypatch.setattr(watchdog, "run", lambda s, c, *, now: [])

    results = scheduler.run_due(object(), _FakeSources(), JobClock(), now=datetime(2026, 10, 6, 13, 30, tzinfo=UTC))

    by_name = {r.name: r for r in results}
    assert by_name["premarket_0830"].ok is False
    assert "boom" in by_name["premarket_0830"].error
    assert by_name["daily_close"].ok is True
    assert by_name["weekly"].ok is True
    assert by_name["relogin_reminder"].ok is True
    assert by_name["refresh_15m"].ok is True
    assert by_name["watchdog"].ok is True


def test_run_due_returns_a_job_result_for_each_due_job(monkeypatch):
    monkeypatch.setattr(scheduler, "_DUE_NOW", {**dict.fromkeys(scheduler._ORDER, lambda now: False)})
    monkeypatch.setitem(scheduler._DUE_NOW, "daily_close", lambda now: True)
    monkeypatch.setattr(daily_close, "run", lambda s, d, c, *, now: JobResult("daily_close", True))

    results = scheduler.run_due(object(), _FakeSources(), JobClock(), now=datetime(2026, 10, 6, 20, 0, tzinfo=UTC))

    assert [r.name for r in results] == ["daily_close"]


def test_a_late_wakeup_still_catches_up_premarket_exactly_once_this_call(monkeypatch):
    """The scheduler was "down" through premarket's whole slot; on resuming, calling `run_due`
    once sees `premarket_0830` due and runs it exactly once -- not once per missed minute."""
    calls = []
    monkeypatch.setattr(scheduler, "_DUE_NOW", {**dict.fromkeys(scheduler._ORDER, lambda now: False)})
    monkeypatch.setitem(scheduler._DUE_NOW, "premarket_0830", lambda now: True)
    monkeypatch.setattr(premarket, "run", lambda s, c, *, now: calls.append(now) or JobResult("premarket_0830", True))

    late_now = datetime(2026, 10, 6, 15, 0, tzinfo=UTC)  # long after the 08:30 ET slot
    results = scheduler.run_due(object(), _FakeSources(), JobClock(), now=late_now)

    assert calls == [late_now]
    assert results == [JobResult("premarket_0830", True)]


# -- F1/F2: a successful slotted job is gated by JobClock, a failed one is retried --------------


def test_run_due_does_not_rerun_a_successful_slotted_job_the_next_minute(monkeypatch):
    monkeypatch.setattr(scheduler, "_DUE_NOW", {**dict.fromkeys(scheduler._ORDER, lambda now: False)})
    monkeypatch.setitem(scheduler._DUE_NOW, "daily_close", lambda now: True)
    calls = []

    def _succeed(s, d, c, *, now):
        calls.append(now)
        c.mark("daily_close", now.date())
        return JobResult("daily_close", True)

    monkeypatch.setattr(daily_close, "run", _succeed)
    clock = JobClock()
    now = datetime(2026, 10, 6, 20, 30, tzinfo=UTC)

    first = scheduler.run_due(object(), _FakeSources(), clock, now=now)
    second = scheduler.run_due(object(), _FakeSources(), clock, now=now + timedelta(minutes=1))

    assert calls == [now]  # daily_close.run was never called the second time
    assert first == [JobResult("daily_close", True)]
    assert second == [JobResult("daily_close", ok=True, ran=False)]


def test_run_due_retries_a_failed_slotted_job_on_the_next_tick(monkeypatch):
    monkeypatch.setattr(scheduler, "_DUE_NOW", {**dict.fromkeys(scheduler._ORDER, lambda now: False)})
    monkeypatch.setitem(scheduler._DUE_NOW, "daily_close", lambda now: True)
    calls = []

    def _boom(*args, **kwargs):
        calls.append(1)
        raise ValueError("boom")

    monkeypatch.setattr(daily_close, "run", _boom)
    clock = JobClock()
    now = datetime(2026, 10, 6, 20, 30, tzinfo=UTC)

    first = scheduler.run_due(object(), _FakeSources(), clock, now=now)
    second = scheduler.run_due(object(), _FakeSources(), clock, now=now + timedelta(minutes=1))

    assert len(calls) == 2  # a failed run never marks the clock, so the next tick retries it
    assert first[0].ok is False
    assert second[0].ok is False


def test_run_due_fires_a_slotted_job_once_per_slot_across_many_ticks(monkeypatch):
    monkeypatch.setattr(scheduler, "_DUE_NOW", {**dict.fromkeys(scheduler._ORDER, lambda now: False)})
    monkeypatch.setitem(scheduler._DUE_NOW, "weekly", lambda now: True)
    calls = []

    def _succeed(s, c, *, now):
        calls.append(now)
        c.mark("weekly", now.date())
        return JobResult("weekly", True)

    monkeypatch.setattr(weekly, "run", _succeed)
    clock = JobClock()
    start = datetime(2026, 10, 6, 11, 0, tzinfo=UTC)

    for minute in range(10):
        scheduler.run_due(object(), _FakeSources(), clock, now=start + timedelta(minutes=minute))

    assert calls == [start]  # fired exactly once across the whole 10-minute window


# -- F4a: bounded startup retry -------------------------------------------------------------------


class _FlakyEngine:
    def __init__(self, fail_times: int) -> None:
        self.fail_times = fail_times
        self.calls = 0

    def connect(self):
        self.calls += 1
        if self.calls <= self.fail_times:
            raise OSError("database not reachable yet")
        return _FakeConnection()


class _FakeConnection:
    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        return False

    def execute(self, _stmt):
        return None


def test_wait_for_database_returns_once_a_later_attempt_succeeds():
    engine = _FlakyEngine(fail_times=2)
    sleeps = []

    scheduler._wait_for_database(engine, attempts=5, delay=0, sleep=sleeps.append)

    assert engine.calls == 3
    assert sleeps == [0, 0]


def test_wait_for_database_exits_non_zero_after_exhausting_the_retry_limit():
    engine = _FlakyEngine(fail_times=999)
    sleeps = []

    with pytest.raises(SystemExit) as exc_info:
        scheduler._wait_for_database(engine, attempts=3, delay=0, sleep=sleeps.append)

    assert exc_info.value.code == 1
    assert engine.calls == 3
    assert len(sleeps) == 3


def test_wait_for_database_default_retry_limit_is_30_attempts_2s_apart():
    assert scheduler._STARTUP_RETRY_ATTEMPTS == 30
    assert scheduler._STARTUP_RETRY_DELAY_SECONDS == 2.0


# -- F4b/F4c: heartbeat file + the healthcheck module ----------------------------------------------


def test_touch_heartbeat_creates_the_file_and_its_parent_directory(tmp_path):
    path = tmp_path / "sub" / "heartbeat"

    healthcheck.touch(path)

    assert path.exists()


def test_healthcheck_is_healthy_fresh_vs_stale(tmp_path):
    path = tmp_path / "heartbeat"
    healthcheck.touch(path)
    mtime = path.stat().st_mtime

    assert healthcheck.is_healthy(path, now=mtime + 1) is True
    assert healthcheck.is_healthy(path, now=mtime + healthcheck.FRESH_SECONDS + 1) is False


def test_healthcheck_is_healthy_false_when_the_file_does_not_exist(tmp_path):
    assert healthcheck.is_healthy(tmp_path / "missing") is False


def test_healthcheck_main_exit_code_follows_heartbeat_freshness(tmp_path, monkeypatch):
    path = tmp_path / "heartbeat"
    monkeypatch.setenv(healthcheck.HEARTBEAT_PATH_VAR, str(path))

    assert healthcheck.main() == 1  # no heartbeat written yet

    healthcheck.touch(path)
    assert healthcheck.main() == 0
```

- [ ] **Step 14: Run it.**

Run: `uv run pytest -q tests/jobs/test_clock.py tests/jobs/test_premarket.py
tests/jobs/test_weekly.py tests/jobs/test_scheduler.py`
Expected: `34 passed` (4 + 5 + 8 + 17, all offline — `test_scheduler.py` grew from 6 to 17 tests with
the F1/F2/F4a/F4b/F4c review fixes above).
Run: `./scripts/test-db.sh tests/jobs/`
Expected: `62 passed` (adds `test_daily_close.py` 6, `test_refresh_15m.py` 5,
`test_backfill_watchlist.py` 3, `test_watchdog.py` 7, `test_relogin_reminder.py` 7 — `
test_relogin_reminder.py` grew from 5 to 7 tests with the F1/F3 review fixes above; the
full-directory run is the one to trust).

- [ ] **Step 15: Commit.**

```
git add packages/family-desk/backend/src/ai_trading/jobs packages/family-desk/backend/tests/jobs
git commit -m "Desk: ai_trading.jobs (scheduler and its named jobs)"
```

---

## Task 3.5: API — FastAPI, identity, REST, SSE quotes

**Files:** `src/ai_trading/api/{__init__.py,auth.py,watchlists.py,strategies.py,signals.py,alerts.py,settings.py,quotes.py,app.py,main.py}`;
`tests/api/{conftest.py,fakes.py,test_auth.py,test_watchlists.py,test_strategies.py,test_signals.py,test_alerts.py,test_settings.py,test_quotes_sse.py,test_app_background_loops.py,test_main_entrypoint.py}`.

**Interfaces:**
- Consumes: Task 3.1's models; Task 3.2's `dispatch_pending`/`Channel`/`SlackChannel`/
  `TelegramChannel`; Task 3.3's `tick`/`compute_card_back`; Task 3.4's `backfill_on_join`; Phase
  1's `StrategySpecV1`/`check`; Phase 2a's `DataSources`/`make_engine`/`make_session_factory`/
  `session_scope`.
- Produces: `ai_trading.api.app.app` (the FastAPI instance, routers included), `api.main.app` (the
  same object, re-exported) — Task 3.6's `docker-compose.yml` runs `uvicorn
  ai_trading.api.main:app`.

Note: this task's `app.py`/`main.py` are written here with the Step-0 `/healthz` already fixed
(Task 3.7 documents the fix as its own change set over the *integrated* prototype — writing it once,
correctly, here avoids a second edit pass).

- [ ] **Step 1: Add FastAPI's dependencies.** In `pyproject.toml`'s `dependencies`, add
  `"fastapi>=0.118",` and `"sse-starlette>=2.1",` and `"uvicorn[standard]>=0.34",`; in
  `[dependency-groups] dev`, add `"httpx>=0.27",  # fastapi.testclient.TestClient's transport`;
  add a new table:

```toml
# B008 ("function call in a default argument") is FastAPI's own documented `Depends(...)` idiom
# (https://fastapi.tiangolo.com/tutorial/dependencies/), not a real bug -- FastAPI calls each
# default exactly once per request, not once at import time. Narrowed to `api/`, the only lane-L4
# code using it, rather than disabled repo-wide.
[tool.ruff.lint.per-file-ignores]
"src/ai_trading/api/*.py" = ["B008"]
```

Run `uv lock` in `packages/family-desk/backend/`.

- [ ] **Step 2: Create `api/__init__.py`** (empty).

- [ ] **Step 3: Create `api/auth.py`.**

```python
"""Gateway-verified identity (PROTO-BRIEF.md §4 L4).

`IDENTITY_HEADER` is the header Caddy's `forward_auth` sets from Clerk's verified email
(`deploy/production/Caddyfile`: every protected route strips any caller-supplied
`Cf-Access-Authenticated-User-Email` first, then `copy_headers X-Verified-Email>
Cf-Access-Authenticated-User-Email` writes the gateway's own verified value). This module only
ever trusts that one header name -- never a query param, a cookie, or any other header -- so a
request that reaches this process without going through Caddy's `forward_auth` (or carrying a
forged value Caddy didn't strip) is Caddy's trust boundary to hold, not this function's: proven by
the production Caddyfile's own integration test, not re-proven here.
"""

from collections.abc import Iterator
from dataclasses import dataclass

from ai_trading_common.registry import DataSources
from fastapi import Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from ai_trading.db.engine import session_scope
from ai_trading.db.models import User

IDENTITY_HEADER = "Cf-Access-Authenticated-User-Email"  # set by Caddy's forward_auth copy_headers


@dataclass(frozen=True)
class AuthedUser:
    id: int
    email: str


def get_session(request: Request) -> Iterator[Session]:
    """One fresh `Session` per request, committed on a clean response and rolled back on an
    exception (`ai_trading.db.engine.session_scope`) -- never one long-lived session for the
    process's lifetime. `request.app.state.session_factory` is built once at startup
    (`api/app.py`'s lifespan) from `DESK_RUNTIME_DATABASE_URL`; tests override this dependency
    directly with `tests/conftest.py`'s real-Postgres `db_session` fixture instead of touching
    `app.state`."""
    factory: sessionmaker[Session] = request.app.state.session_factory
    with session_scope(factory) as session:
        yield session


def get_data_sources(request: Request) -> DataSources:
    """The process-wide `DataSources` built once at startup (`api/app.py`'s lifespan) from
    `DataSources.from_env()`; tests override this dependency with a fake instead of touching
    `app.state`."""
    return request.app.state.data_sources


def get_current_user(request: Request, session: Session = Depends(get_session)) -> AuthedUser:
    """401 if `IDENTITY_HEADER` is missing or empty -- never trusts any other header, and never
    falls back to a query param or cookie. On a known email, looks up (and lazily creates, since
    only two users ever exist) the `users` row. A request whose header carries a forged identity
    is never distinguishable from a legitimate one at this layer -- that trust boundary is Caddy's
    forward_auth, proven by the existing production integration test; this function only trusts
    whatever header name reaches it, by design."""
    email = request.headers.get(IDENTITY_HEADER)
    if not email:
        raise HTTPException(status_code=401, detail="missing verified identity header")

    user = session.execute(select(User).where(User.email == email)).scalar_one_or_none()
    if user is None:
        user = User(email=email, settings={})
        session.add(user)
        session.flush()  # assign user.id without ending the request's transaction early
    return AuthedUser(id=user.id, email=user.email)
```

- [ ] **Step 4: Create `api/watchlists.py`.**

```python
"""`/api/desk/watchlists*` (PROTO-BRIEF.md §4 L4)."""

from datetime import UTC, datetime
from typing import Literal

from ai_trading_common.registry import DataSources
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ai_trading.api.auth import AuthedUser, get_current_user, get_data_sources, get_session
from ai_trading.db.models import Watchlist, WatchlistItem
from ai_trading.jobs.backfill_watchlist import backfill_on_join

router = APIRouter(prefix="/api/desk/watchlists", tags=["watchlists"])


class WatchlistCreate(BaseModel):
    name: str
    horizon: Literal["intraday", "swing", "long_term"]


class WatchlistOut(BaseModel):
    id: int
    name: str
    horizon: str


class WatchlistItemCreate(BaseModel):
    symbol: str
    asset_type: Literal["stock", "future"]


class WatchlistItemOut(BaseModel):
    watchlist_id: int
    symbol: str
    asset_type: str


def _owned_watchlist(session: Session, watchlist_id: int, user: AuthedUser) -> Watchlist:
    row = session.get(Watchlist, watchlist_id)
    if row is None or row.user_id != user.id:
        # Never confirm existence to a non-owner (PROTO-BRIEF.md §4 L4): same 404 either way.
        raise HTTPException(status_code=404, detail="watchlist not found")
    return row


@router.get("", response_model=list[WatchlistOut])
def list_watchlists(
    user: AuthedUser = Depends(get_current_user), session: Session = Depends(get_session)
) -> list[WatchlistOut]:
    rows = session.execute(select(Watchlist).where(Watchlist.user_id == user.id).order_by(Watchlist.id)).scalars()
    return [WatchlistOut(id=row.id, name=row.name, horizon=row.horizon) for row in rows]


@router.post("", status_code=201, response_model=WatchlistOut)
def create_watchlist(
    body: WatchlistCreate, user: AuthedUser = Depends(get_current_user), session: Session = Depends(get_session)
) -> WatchlistOut:
    row = Watchlist(user_id=user.id, name=body.name, horizon=body.horizon)
    session.add(row)
    session.flush()
    session.commit()
    return WatchlistOut(id=row.id, name=row.name, horizon=row.horizon)


@router.post("/{watchlist_id}/items", status_code=201, response_model=WatchlistItemOut)
def add_watchlist_item(
    watchlist_id: int,
    body: WatchlistItemCreate,
    user: AuthedUser = Depends(get_current_user),
    session: Session = Depends(get_session),
    data_sources: DataSources = Depends(get_data_sources),
) -> WatchlistItemOut:
    _owned_watchlist(session, watchlist_id, user)
    item = WatchlistItem(watchlist_id=watchlist_id, symbol=body.symbol, asset_type=body.asset_type)
    session.add(item)
    session.flush()
    # Blocks the request (acceptable at Phase 3's data volumes, per the brief); a future symbol's
    # stub/real backfill writes nothing, but the watchlist_items row is still created either way.
    backfill_on_join(session, data_sources, symbol=body.symbol, asset=body.asset_type, now=datetime.now(UTC))
    session.commit()
    return WatchlistItemOut(watchlist_id=watchlist_id, symbol=item.symbol, asset_type=item.asset_type)


@router.delete("/{watchlist_id}/items/{symbol}", status_code=204)
def remove_watchlist_item(
    watchlist_id: int,
    symbol: str,
    user: AuthedUser = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> None:
    _owned_watchlist(session, watchlist_id, user)
    item = session.get(WatchlistItem, (watchlist_id, symbol))
    if item is not None:
        session.delete(item)
    session.commit()
```

- [ ] **Step 5: Create `api/strategies.py`** (Decision 11's auto-promote, the stage machine):

```python
"""`/api/desk/strategies*` (PROTO-BRIEF.md §4 L4).

Stage machine: `draft -> alert_only -> paper` only -- one step forward at a time, never a skip
(`draft -> paper`) and never backward; `paper` additionally requires an explicit
`{"confirm": true}` body field (02a §4.2). There is no `live_confirm`/`live_auto` stage in this
schema at all (Global Constraints, §2), so naming one is rejected the same way an out-of-order
move is: 400, not FastAPI's own 422, so every stage-machine violation reports through the same
error shape.
"""

from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from ai_trading.api.auth import AuthedUser, get_current_user, get_session
from ai_trading.contracts.strategy_spec_v1 import StrategySpecV1
from ai_trading.core.evaluate import check
from ai_trading.db.models import Strategy, StrategyVersion

router = APIRouter(prefix="/api/desk/strategies", tags=["strategies"])

_STAGE_ORDER = ("draft", "alert_only", "paper")


class StrategyCreate(BaseModel):
    name: str


class StrategyOut(BaseModel):
    id: int
    name: str
    stage: str
    current_version_id: int | None


class StrategyVersionCreate(BaseModel):
    spec: dict[str, Any]
    change_note: str | None = None


class StrategyVersionOut(BaseModel):
    id: int
    strategy_id: int
    version: int
    schema_version: int
    spec: dict[str, Any]
    change_note: str | None


class StageUpdate(BaseModel):
    stage: str
    confirm: bool = False


def _owned_strategy(session: Session, strategy_id: int, user: AuthedUser) -> Strategy:
    row = session.get(Strategy, strategy_id)
    if row is None or row.owner_user_id != user.id:
        raise HTTPException(status_code=404, detail="strategy not found")
    return row


def _strategy_out(row: Strategy) -> StrategyOut:
    return StrategyOut(id=row.id, name=row.name, stage=row.stage, current_version_id=row.current_version_id)


def _version_out(row: StrategyVersion) -> StrategyVersionOut:
    return StrategyVersionOut(
        id=row.id,
        strategy_id=row.strategy_id,
        version=row.version,
        schema_version=row.schema_version,
        spec=row.spec,
        change_note=row.change_note,
    )


@router.get("", response_model=list[StrategyOut])
def list_strategies(
    user: AuthedUser = Depends(get_current_user), session: Session = Depends(get_session)
) -> list[StrategyOut]:
    rows = session.execute(select(Strategy).where(Strategy.owner_user_id == user.id).order_by(Strategy.id)).scalars()
    return [_strategy_out(row) for row in rows]


@router.post("", status_code=201, response_model=StrategyOut)
def create_strategy(
    body: StrategyCreate, user: AuthedUser = Depends(get_current_user), session: Session = Depends(get_session)
) -> StrategyOut:
    row = Strategy(owner_user_id=user.id, name=body.name, stage="draft", created_at=datetime.now(UTC))
    session.add(row)
    session.flush()
    session.commit()
    return _strategy_out(row)


@router.get("/{strategy_id}/versions", response_model=list[StrategyVersionOut])
def list_versions(
    strategy_id: int, user: AuthedUser = Depends(get_current_user), session: Session = Depends(get_session)
) -> list[StrategyVersionOut]:
    strategy = _owned_strategy(session, strategy_id, user)
    rows = session.execute(
        select(StrategyVersion).where(StrategyVersion.strategy_id == strategy.id).order_by(StrategyVersion.version)
    ).scalars()
    return [_version_out(row) for row in rows]


@router.post("/{strategy_id}/versions", status_code=201, response_model=StrategyVersionOut)
def create_version(
    strategy_id: int,
    body: StrategyVersionCreate,
    user: AuthedUser = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> StrategyVersionOut:
    strategy = _owned_strategy(session, strategy_id, user)
    try:
        spec = StrategySpecV1.model_validate(body.spec)
    except ValidationError as exc:
        raise HTTPException(status_code=400, detail=f"invalid strategy spec: {exc}") from exc
    problems = check(spec)
    if problems:
        raise HTTPException(status_code=400, detail="; ".join(problems))

    latest_version = session.execute(
        select(StrategyVersion.version)
        .where(StrategyVersion.strategy_id == strategy.id)
        .order_by(StrategyVersion.version.desc())
        .limit(1)
    ).scalar_one_or_none()
    row = StrategyVersion(
        strategy_id=strategy.id,
        version=(latest_version or 0) + 1,
        schema_version=spec.schemaVersion,
        spec=body.spec,
        change_note=body.change_note,
        created_by=user.id,
        created_at=datetime.now(UTC),
    )
    session.add(row)
    session.flush()
    # No separate "activate version" endpoint exists in this schema: the newest immutable version
    # becomes the one `engine.tick.tick` evaluates (decision; see REPORT-L4.md).
    strategy.current_version_id = row.id
    session.commit()
    return _version_out(row)


@router.put("/{strategy_id}/stage", response_model=StrategyOut)
def update_stage(
    strategy_id: int,
    body: StageUpdate,
    user: AuthedUser = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> StrategyOut:
    strategy = _owned_strategy(session, strategy_id, user)
    try:
        current_index = _STAGE_ORDER.index(strategy.stage)
        target_index = _STAGE_ORDER.index(body.stage)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"unknown stage {body.stage!r}") from None
    if target_index != current_index + 1:
        raise HTTPException(
            status_code=400, detail=f"cannot move {strategy.stage!r} -> {body.stage!r}: only the next stage is allowed"
        )
    if body.stage == "paper" and not body.confirm:
        raise HTTPException(status_code=400, detail='moving to paper requires {"confirm": true}')
    strategy.stage = body.stage
    session.commit()
    return _strategy_out(strategy)
```

- [ ] **Step 6: Create `api/signals.py`.**

```python
"""`GET /api/desk/signals` (PROTO-BRIEF.md §4 L4): paginated, owner-scoped via the strategy's
`owner_user_id` -- a `signals` row has no `user_id` of its own, so ownership is a join, not a
column filter."""

from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ai_trading.api.auth import AuthedUser, get_current_user, get_session
from ai_trading.db.models import Signal, Strategy, StrategyVersion

router = APIRouter(prefix="/api/desk/signals", tags=["signals"])

_DEFAULT_LIMIT = 50
_MAX_LIMIT = 200


class SignalOut(BaseModel):
    id: int
    strategy_version_id: int
    symbol: str
    bar_time: datetime
    evidence: dict[str, Any]
    data_quality: str
    created_at: datetime


@router.get("", response_model=list[SignalOut])
def list_signals(
    symbol: str | None = None,
    since: datetime | None = None,
    limit: Annotated[int, Query(ge=1, le=_MAX_LIMIT)] = _DEFAULT_LIMIT,
    offset: Annotated[int, Query(ge=0)] = 0,
    user: AuthedUser = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> list[SignalOut]:
    query = (
        select(Signal)
        .join(StrategyVersion, Signal.strategy_version_id == StrategyVersion.id)
        .join(Strategy, StrategyVersion.strategy_id == Strategy.id)
        .where(Strategy.owner_user_id == user.id)
    )
    if symbol is not None:
        query = query.where(Signal.symbol == symbol)
    if since is not None:
        query = query.where(Signal.created_at >= since)
    query = query.order_by(Signal.created_at.desc(), Signal.id.desc()).limit(limit).offset(offset)
    rows = session.execute(query).scalars()
    return [
        SignalOut(
            id=row.id,
            strategy_version_id=row.strategy_version_id,
            symbol=row.symbol,
            bar_time=row.bar_time,
            evidence=row.evidence,
            data_quality=row.data_quality,
            created_at=row.created_at,
        )
        for row in rows
    ]
```

- [ ] **Step 7: Create `api/alerts.py`.**

```python
"""`/api/desk/alerts*` (PROTO-BRIEF.md §4 L4): the inbox IS the `alerts` table (`notify.dispatch`'s
own docstring) -- reading it is just a plain owner-scoped query, no separate "inbox" table."""

from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ai_trading.api.auth import AuthedUser, get_current_user, get_session
from ai_trading.db.models import Alert

router = APIRouter(prefix="/api/desk/alerts", tags=["alerts"])


class AlertOut(BaseModel):
    id: int
    kind: str
    severity: str
    title: str
    body: str
    payload: dict[str, Any]
    created_at: datetime
    read_at: datetime | None


def _to_out(row: Alert) -> AlertOut:
    return AlertOut(
        id=row.id,
        kind=row.kind,
        severity=row.severity,
        title=row.title,
        body=row.body,
        payload=row.payload,
        created_at=row.created_at,
        read_at=row.read_at,
    )


@router.get("", response_model=list[AlertOut])
def list_alerts(
    unread: bool | None = None,
    user: AuthedUser = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> list[AlertOut]:
    query = select(Alert).where(Alert.user_id == user.id)
    if unread is True:
        query = query.where(Alert.read_at.is_(None))
    elif unread is False:
        query = query.where(Alert.read_at.is_not(None))
    rows = session.execute(query.order_by(Alert.created_at.desc())).scalars()
    return [_to_out(row) for row in rows]


@router.post("/{alert_id}/read", response_model=AlertOut)
def mark_read(
    alert_id: int, user: AuthedUser = Depends(get_current_user), session: Session = Depends(get_session)
) -> AlertOut:
    row = session.get(Alert, alert_id)
    if row is None or row.user_id != user.id:
        raise HTTPException(status_code=404, detail="alert not found")
    if row.read_at is None:
        row.read_at = datetime.now(UTC)
    session.commit()
    return _to_out(row)
```

- [ ] **Step 8: Create `api/settings.py`.**

```python
"""`GET/PUT /api/desk/settings` (PROTO-BRIEF.md §4 L4): the current user's own `users.settings`
jsonb -- channel preferences, quiet hours (`notify.quiet_hours`/`notify.dispatch` read this same
column). A PUT is a full replace, matching the column's own "one blob" shape; there is no partial-
patch endpoint."""

from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ai_trading.api.auth import AuthedUser, get_current_user, get_session
from ai_trading.db.models import User

router = APIRouter(prefix="/api/desk/settings", tags=["settings"])


class SettingsBody(BaseModel):
    settings: dict[str, Any]


@router.get("", response_model=SettingsBody)
def get_settings(user: AuthedUser = Depends(get_current_user), session: Session = Depends(get_session)) -> SettingsBody:
    row = session.get(User, user.id)
    assert row is not None  # get_current_user already created it this request
    return SettingsBody(settings=row.settings)


@router.put("", response_model=SettingsBody)
def put_settings(
    body: SettingsBody, user: AuthedUser = Depends(get_current_user), session: Session = Depends(get_session)
) -> SettingsBody:
    row = session.get(User, user.id)
    assert row is not None
    row.settings = body.settings
    session.commit()
    return SettingsBody(settings=row.settings)
```

- [ ] **Step 9: Create `api/quotes.py`** (Decision 12's identity-required choice):

```python
"""SSE quotes (PROTO-BRIEF.md §4 L4): at most ~4 updates per second per connection (02a §7).

`quote_events` is the testable core: a plain async generator taking an injectable `sleep` so a
test can prove the send cadence never exceeds `MIN_INTERVAL_SECONDS` without a real 0.25s wait,
and an injectable `is_disconnected` so a test can prove the stream stops on disconnect without a
real socket. `stream_quotes` is the thin FastAPI/sse-starlette wiring around it.
"""

import asyncio
import json
from collections.abc import AsyncIterator, Awaitable, Callable

import pandas as pd
from ai_trading_common.errors import ProviderError
from ai_trading_common.registry import DataSources
from fastapi import APIRouter, Depends, Request
from sse_starlette.sse import EventSourceResponse

from ai_trading.api.auth import AuthedUser, get_current_user, get_data_sources

router = APIRouter(prefix="/api/desk/quotes", tags=["quotes"])

#: 02a §7: "SSE fan-out to browsers (at most about 4 updates per second)".
MIN_INTERVAL_SECONDS = 0.25


async def _latest_quote(symbol: str, data_sources: DataSources) -> dict[str, float | str] | None:
    """One best-effort quote read; `None` when the provider has nothing right now (a `ProviderError`
    -- unconfigured, unavailable, or genuinely no data -- is never surfaced to the stream as an
    error, since a quiet tick is routine, not a failure)."""
    now = pd.Timestamp.now(tz="UTC")
    try:
        bars = data_sources.bars.bars(symbol, "1m", now - pd.Timedelta(minutes=5), now, now=now)
    except ProviderError:
        return None
    if bars.frame.empty:
        return None
    last = bars.frame.iloc[-1]
    return {"symbol": symbol, "close": float(last["close"]), "quality": bars.quality, "as_of": now.isoformat()}


async def quote_events(
    symbol: str,
    data_sources: DataSources,
    is_disconnected: Callable[[], Awaitable[bool]],
    *,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
) -> AsyncIterator[dict[str, str]]:
    """Yields one SSE event per tick, stopping once `is_disconnected()` is True. The
    `MIN_INTERVAL_SECONDS` sleep is unconditional -- not "whatever's left after the read" -- so the
    cap is mechanically enforced even when the read is effectively instant (a fake `DataSources` in
    tests; in Phase 3 the real value only actually changes every 15 minutes anyway, Alpaca's delay)."""
    while not await is_disconnected():
        quote = await _latest_quote(symbol, data_sources)
        if quote is not None:
            yield {"event": "quote", "data": json.dumps(quote)}
        await sleep(MIN_INTERVAL_SECONDS)


@router.get("/{symbol}")
async def stream_quotes(
    symbol: str,
    request: Request,
    user: AuthedUser = Depends(get_current_user),
    data_sources: DataSources = Depends(get_data_sources),
) -> EventSourceResponse:
    return EventSourceResponse(quote_events(symbol, data_sources, request.is_disconnected))
```

- [ ] **Step 10: Create `api/app.py`** (the `/healthz` route here is already the fixed, readiness
  version — Task 3.7 is where this fix is reviewed against the un-fixed prototype):

```python
"""FastAPI app wiring (PROTO-BRIEF.md §4 L4): identity (`api/auth.py`), the `/api/desk/*` REST
routers, SSE quotes, the `/healthz` route `health-check.sh` polls, and two background loops --
`engine.tick.tick` every 60s and `notify.dispatch.dispatch_pending` every 10s, each against a
fresh `Session` (never one long-lived session for the process's lifetime).

Run by the `api` compose service via `ai_trading.api.main:app` (`main.py` re-exports this exact
`app` object -- there is exactly one served ASGI app; integration fix, PROTO-BRIEF.md). Every
resource below (the DB engine,
`DataSources`, the notify channel map) is built from the environment at *lifespan* startup, not at
import time, so importing this module -- e.g. from a test -- never requires a live database or
network. Without `DESK_RUNTIME_DATABASE_URL` set, the background loops simply don't start (logged,
never a crash); tests instead override `api.auth.get_session`/`get_data_sources` directly and
never rely on `app.state`.
"""

import asyncio
import logging
import os
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from datetime import UTC, datetime

from ai_trading_common.registry import DataSources
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.orm import Session, sessionmaker

from ai_trading.api import alerts, quotes, settings, signals, strategies, watchlists
from ai_trading.db.engine import make_engine, make_health_check_engine, make_session_factory, session_scope
from ai_trading.engine.tick import tick
from ai_trading.notify.channel import Channel
from ai_trading.notify.dispatch import dispatch_pending
from ai_trading.notify.slack import SlackChannel
from ai_trading.notify.telegram import TelegramChannel

logger = logging.getLogger(__name__)

TICK_INTERVAL_SECONDS = 60.0
DISPATCH_INTERVAL_SECONDS = 10.0

_DATABASE_URL_VAR = "DESK_RUNTIME_DATABASE_URL"


def _build_channels(env: dict[str, str]) -> dict[str, Channel]:
    """Only a channel with real credentials present gets wired (D-a) -- `inbox` needs none
    (`dispatch_pending` handles it directly). A `telegram`/`slack` delivery with no entry here
    stays "pending" forever, never a crash, until the owner sets these keys."""
    channels: dict[str, Channel] = {}
    bot_token, chat_id = env.get("TELEGRAM_BOT_TOKEN"), env.get("TELEGRAM_CHAT_ID")
    if bot_token and chat_id:
        channels["telegram"] = TelegramChannel(bot_token, chat_id)
    webhook_url = env.get("SLACK_WEBHOOK_URL_OWNER")
    if webhook_url:
        channels["slack"] = SlackChannel(webhook_url)
    return channels


async def _background_loop(
    work: Callable[[Session, datetime], None],
    session_factory: sessionmaker[Session],
    *,
    interval: float,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    clock: Callable[[], datetime] = lambda: datetime.now(UTC),
) -> None:
    """Runs `work` against a fresh `Session` every `interval` seconds, forever, until the task is
    cancelled. One exception from `work` is logged and never kills the loop -- a single bad
    tick/dispatch cycle must not take the whole background loop down."""
    while True:
        try:
            with session_scope(session_factory) as session:
                work(session, clock())
        except Exception:
            logger.exception("background loop iteration failed")
        await sleep(interval)


@asynccontextmanager
async def _lifespan(app: FastAPI) -> AsyncIterator[None]:
    tasks: list[asyncio.Task[None]] = []
    database_url = os.environ.get(_DATABASE_URL_VAR)
    if database_url:
        app.state.session_factory = make_session_factory(make_engine(database_url))
        app.state.health_engine = make_health_check_engine(database_url)
        app.state.data_sources = DataSources.from_env()
        channels = _build_channels(dict(os.environ))
        tasks.append(
            asyncio.create_task(
                _background_loop(
                    lambda session, now: tick(session, now=now),
                    app.state.session_factory,
                    interval=TICK_INTERVAL_SECONDS,
                )
            )
        )
        tasks.append(
            asyncio.create_task(
                _background_loop(
                    lambda session, now: dispatch_pending(session, channels=channels, now=now),
                    app.state.session_factory,
                    interval=DISPATCH_INTERVAL_SECONDS,
                )
            )
        )
    else:
        # No database configured, e.g. a test TestClient that overrides get_session/
        # get_data_sources directly. Never crash the app over it; just skip the background work.
        logger.warning("%s is not set; background tick/dispatch loops are not running", _DATABASE_URL_VAR)
    try:
        yield
    finally:
        for task in tasks:
            task.cancel()


app = FastAPI(title="ai-trading-desk", lifespan=_lifespan)

for _router_module in (watchlists, strategies, signals, alerts, settings, quotes):
    app.include_router(_router_module.router)


#: Step 0 integration fix: `/healthz` is a READINESS check, not a static "ok". `health-check.sh`'s
#: Docker-level healthcheck (docker-compose.yml) polls this with its own interval/retries/
#: start_period -- that is what gives a cold/slow shared Postgres cluster time to become reachable
#: (`api` has no `depends_on` across Compose projects, D-e); this route itself makes exactly one
#: bounded attempt per call, never its own internal retry loop.
@app.get("/healthz")
def healthz(request: Request) -> JSONResponse:
    engine = getattr(request.app.state, "health_engine", None)
    if engine is None:
        return JSONResponse({"status": "unavailable"}, status_code=503)
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
    except Exception:
        # Never the real exception text or the database URL in the response body (AGENTS.md: no
        # VPS address or credential in anything this process returns) -- a fixed, generic body.
        return JSONResponse({"status": "unavailable"}, status_code=503)
    return JSONResponse({"status": "ok"}, status_code=200)
```

- [ ] **Step 11: Create `api/main.py`.**

```python
"""The one served ASGI app (integration fix, PROTO-BRIEF.md): `deploy/production/docker-compose.yml`'s
`api` service runs `uvicorn ai_trading.api.main:app`, the exact same FastAPI instance `app.py`
builds (routers, `/healthz`, and the lifespan that wires the DB engine, `DataSources`, the notify
channel map, and the background tick/dispatch loops from the environment at startup, never at
import time) -- `main.py` only re-exports it under this name and adds `main()`/`python -m
ai_trading.api.main` as a local-dev convenience around the same object, for running outside
uvicorn's own CLI invocation.
"""

import uvicorn

from ai_trading.api.app import app


def main() -> None:
    uvicorn.run(app, host="0.0.0.0", port=8000)


if __name__ == "__main__":
    main()
```

- [ ] **Step 12: Extend `db/engine.py`** with the dedicated health-check engine (Task 3.1's file,
  touched again here — see Task 3.7 for why this exists):

```python
def make_health_check_engine(url: str) -> Engine:
    """A dedicated engine for the `/healthz` readiness probe (Step 0 integration fix): a 1-second
    `connect_timeout` bounds how long an unreachable or slow-to-answer database can block the
    check, independent of the main session_factory's engine (a real request should wait for a
    real connection, never time out after 1s). `psycopg`'s `connect_timeout` connect arg is a
    TCP-connect-phase timeout; a `SELECT 1` against an already-open connection returns
    essentially immediately, so this is the only timeout the probe needs.
    """
    return create_engine(url, connect_args={"connect_timeout": 1})
```

Append this function to the bottom of `packages/family-desk/backend/src/ai_trading/db/engine.py`
(after `session_scope`).

- [ ] **Step 13: Create `tests/api/conftest.py`.**

```python
"""Shared FastAPI `TestClient` fixtures for `tests/api/*`: `get_session` overridden to the real,
per-test-truncated `db_session` fixture (`tests/conftest.py`, real Postgres via
`scripts/test-db.sh`), `get_data_sources` overridden to `fakes.fake_data_sources()` -- no live
network call anywhere in this directory.
"""

from collections.abc import Iterator

import pytest
from fakes import fake_data_sources
from fastapi.testclient import TestClient

from ai_trading.api.app import app
from ai_trading.api.auth import IDENTITY_HEADER, get_data_sources, get_session

OWNER_EMAIL = "owner@example.com"
OTHER_EMAIL = "spouse@example.com"


def auth_headers(email: str = OWNER_EMAIL) -> dict[str, str]:
    return {IDENTITY_HEADER: email}


@pytest.fixture
def client(db_session, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    # Never let a real DESK_RUNTIME_DATABASE_URL leak into a test run: the app's lifespan would
    # otherwise try to build a real engine and start the background tick/dispatch loops.
    monkeypatch.delenv("DESK_RUNTIME_DATABASE_URL", raising=False)

    def override_get_session():
        # A generator (not a plain return) so FastAPI manages it the same way as the real
        # dependency -- the same `db_session` object for every request this test makes, truncated
        # fresh per test by `tests/conftest.py`'s own fixture.
        yield db_session

    app.dependency_overrides[get_session] = override_get_session
    app.dependency_overrides[get_data_sources] = lambda: fake_data_sources()
    try:
        with TestClient(app) as test_client:
            yield test_client
    finally:
        app.dependency_overrides.clear()
```

- [ ] **Step 14: Create `tests/api/fakes.py`.**

```python
"""Network-free `DataSources` test double for `tests/api/*` -- no live network call anywhere in
this directory. Only `bars` is ever touched by L4's own code (`api/quotes.py`,
`jobs.backfill_watchlist`'s stub); the other eight `DataSources` fields are never called by
anything this lane built, so a bare sentinel stands in for them.
"""

import pandas as pd
from ai_trading_common.bars import Bars
from ai_trading_common.registry import DataSources

_EMPTY_FRAME = pd.DataFrame(columns=["open", "high", "low", "close", "volume"])


class FakeBarsSource:
    """Returns whatever frame `frames_by_symbol` has for the requested symbol (empty otherwise,
    mirroring a provider with nothing new right now), and records every call."""

    def __init__(self, frames_by_symbol: dict[str, pd.DataFrame] | None = None) -> None:
        self.frames_by_symbol = frames_by_symbol or {}
        self.calls: list[str] = []

    def bars(self, symbol: str, timeframe: str, start, end, *, now) -> Bars:
        self.calls.append(symbol)
        frame = self.frames_by_symbol.get(symbol, _EMPTY_FRAME)
        return Bars(frame=frame, source="fake", quality="delayed-15m")


def one_bar_frame(close: float) -> pd.DataFrame:
    return pd.DataFrame(
        {"open": [close], "high": [close], "low": [close], "close": [close], "volume": [10.0]},
        index=pd.DatetimeIndex([pd.Timestamp.now(tz="UTC")]),
    )


def fake_data_sources(bars: FakeBarsSource | None = None) -> DataSources:
    unused = object()  # every DataSources field L4 never calls
    return DataSources(
        bars=bars or FakeBarsSource(),
        fundamentals=unused,
        earnings_announcements=unused,
        macro=unused,
        news=unused,
        earnings_calendar=unused,
        consensus=unused,
        earnings=unused,
        targets=unused,
    )
```

- [ ] **Step 15: Create the 8 remaining test files.**

`tests/api/test_auth.py`:

```python
"""Review Focus (PROTO-BRIEF.md §4 L4): identity comes only from `IDENTITY_HEADER`, never a query
param or cookie, and a forged header from outside the gateway is Caddy's trust boundary to hold,
not this layer's -- this file only proves the header *is* trusted when present and *is* required
when absent."""

from conftest import OTHER_EMAIL, OWNER_EMAIL, auth_headers
from sqlalchemy import select

from ai_trading.db.models import User


def test_missing_identity_header_is_401(client):
    response = client.get("/api/desk/settings")
    assert response.status_code == 401


def test_present_identity_header_looks_up_the_right_user_row(client, db_session):
    response = client.get("/api/desk/settings", headers=auth_headers(OWNER_EMAIL))
    assert response.status_code == 200

    user = db_session.execute(select(User).where(User.email == OWNER_EMAIL)).scalar_one()
    assert user.email == OWNER_EMAIL


def test_two_different_emails_map_to_two_different_user_rows(client, db_session):
    client.get("/api/desk/settings", headers=auth_headers(OWNER_EMAIL))
    client.get("/api/desk/settings", headers=auth_headers(OTHER_EMAIL))

    owner = db_session.execute(select(User).where(User.email == OWNER_EMAIL)).scalar_one()
    other = db_session.execute(select(User).where(User.email == OTHER_EMAIL)).scalar_one()
    assert owner.id != other.id


def test_a_query_param_or_cookie_never_substitutes_for_the_header(client):
    client.cookies.set("email", OWNER_EMAIL)
    response = client.get(f"/api/desk/settings?{OWNER_EMAIL.replace('@', '%40')}=1")
    assert response.status_code == 401
```

`tests/api/test_watchlists.py`:

```python
from conftest import OTHER_EMAIL, OWNER_EMAIL, auth_headers

import ai_trading.api.watchlists as watchlists_module
from ai_trading.data.backfill import BackfillResult


def test_create_and_list_watchlist(client):
    created = client.post("/api/desk/watchlists", json={"name": "Core", "horizon": "swing"}, headers=auth_headers())
    assert created.status_code == 201
    body = created.json()
    assert body["name"] == "Core"
    assert body["horizon"] == "swing"

    listed = client.get("/api/desk/watchlists", headers=auth_headers())
    assert [row["id"] for row in listed.json()] == [body["id"]]


def test_add_item_calls_backfill_on_join_with_the_right_arguments(client, monkeypatch):
    calls = []

    def fake_backfill_on_join(session, data_sources, *, symbol, asset, now):
        calls.append((symbol, asset))
        return BackfillResult(requested=(now.date(), now.date()), written=[], uncovered=[])

    monkeypatch.setattr(watchlists_module, "backfill_on_join", fake_backfill_on_join)

    watchlist_id = client.post(
        "/api/desk/watchlists", json={"name": "Core", "horizon": "intraday"}, headers=auth_headers()
    ).json()["id"]

    response = client.post(
        f"/api/desk/watchlists/{watchlist_id}/items",
        json={"symbol": "AAPL", "asset_type": "stock"},
        headers=auth_headers(),
    )

    assert response.status_code == 201
    assert response.json() == {"watchlist_id": watchlist_id, "symbol": "AAPL", "asset_type": "stock"}
    assert calls == [("AAPL", "stock")]


def test_adding_a_future_symbol_still_creates_the_item_even_though_backfill_writes_nothing(client):
    watchlist_id = client.post(
        "/api/desk/watchlists", json={"name": "Futures", "horizon": "swing"}, headers=auth_headers()
    ).json()["id"]

    response = client.post(
        f"/api/desk/watchlists/{watchlist_id}/items",
        json={"symbol": "/ES", "asset_type": "future"},
        headers=auth_headers(),
    )

    assert response.status_code == 201
    assert response.json()["asset_type"] == "future"


def test_watchlist_item_actions_404_for_a_watchlist_owned_by_someone_else(client):
    watchlist_id = client.post(
        "/api/desk/watchlists", json={"name": "Core", "horizon": "swing"}, headers=auth_headers(OWNER_EMAIL)
    ).json()["id"]

    add = client.post(
        f"/api/desk/watchlists/{watchlist_id}/items",
        json={"symbol": "AAPL", "asset_type": "stock"},
        headers=auth_headers(OTHER_EMAIL),
    )
    delete = client.delete(f"/api/desk/watchlists/{watchlist_id}/items/AAPL", headers=auth_headers(OTHER_EMAIL))

    assert add.status_code == 404
    assert delete.status_code == 404


def test_delete_watchlist_item_is_idempotent(client):
    watchlist_id = client.post(
        "/api/desk/watchlists", json={"name": "Core", "horizon": "swing"}, headers=auth_headers()
    ).json()["id"]
    client.post(
        f"/api/desk/watchlists/{watchlist_id}/items",
        json={"symbol": "AAPL", "asset_type": "stock"},
        headers=auth_headers(),
    )

    first = client.delete(f"/api/desk/watchlists/{watchlist_id}/items/AAPL", headers=auth_headers())
    second = client.delete(f"/api/desk/watchlists/{watchlist_id}/items/AAPL", headers=auth_headers())

    assert first.status_code == 204
    assert second.status_code == 204
```

`tests/api/test_strategies.py`:

```python
from conftest import OTHER_EMAIL, OWNER_EMAIL, auth_headers

VALID_SPEC = {
    "schemaVersion": 1,
    "name": "Close above 100",
    "watch": {"universe": {"symbols": ["AAPL"]}, "session": "regular", "runOn": "daily_close"},
    "when": {"op": "gt", "left": {"series": "close"}, "right": {"value": 100.0}},
    "then": {"alert": {"channels": ["inbox"]}},
}

# vwap is intraday-only (ai_trading.core.evaluate.check); daily_close uses daily bars, so this
# spec is schema-valid but fails `check()` -- Review Focus-adjacent but for strategies, not ticks.
CHECK_VIOLATION_SPEC = {
    **VALID_SPEC,
    "when": {"op": "gt", "left": {"series": "vwap"}, "right": {"value": 100.0}},
}


def _create_strategy(client, email: str = OWNER_EMAIL) -> int:
    response = client.post("/api/desk/strategies", json={"name": "My strategy"}, headers=auth_headers(email))
    assert response.status_code == 201
    return response.json()["id"]


def test_create_strategy_starts_in_draft_stage_with_no_current_version(client):
    strategy_id = _create_strategy(client)
    row = client.get("/api/desk/strategies", headers=auth_headers()).json()[0]
    assert row["id"] == strategy_id
    assert row["stage"] == "draft"
    assert row["current_version_id"] is None


def test_create_version_rejects_a_schema_invalid_spec_with_400(client):
    strategy_id = _create_strategy(client)
    bad_spec = {**VALID_SPEC, "schemaVersion": 2}  # only 1 is a valid Literal

    response = client.post(
        f"/api/desk/strategies/{strategy_id}/versions", json={"spec": bad_spec}, headers=auth_headers()
    )

    assert response.status_code == 400


def test_create_version_rejects_a_check_violation_with_400(client):
    strategy_id = _create_strategy(client)

    response = client.post(
        f"/api/desk/strategies/{strategy_id}/versions", json={"spec": CHECK_VIOLATION_SPEC}, headers=auth_headers()
    )

    assert response.status_code == 400
    assert "vwap" in response.json()["detail"]


def test_create_version_sets_it_as_the_strategys_current_version(client):
    strategy_id = _create_strategy(client)

    version = client.post(
        f"/api/desk/strategies/{strategy_id}/versions", json={"spec": VALID_SPEC}, headers=auth_headers()
    ).json()

    strategy = client.get("/api/desk/strategies", headers=auth_headers()).json()[0]
    assert version["version"] == 1
    assert strategy["current_version_id"] == version["id"]


def test_versions_are_404_for_a_strategy_owned_by_someone_else(client):
    strategy_id = _create_strategy(client, OWNER_EMAIL)

    response = client.post(
        f"/api/desk/strategies/{strategy_id}/versions", json={"spec": VALID_SPEC}, headers=auth_headers(OTHER_EMAIL)
    )

    assert response.status_code == 404


def test_stage_transition_rejects_skip_ahead_and_an_unknown_stage(client):
    strategy_id = _create_strategy(client)

    skip_ahead = client.put(
        f"/api/desk/strategies/{strategy_id}/stage", json={"stage": "paper", "confirm": True}, headers=auth_headers()
    )
    unknown = client.put(
        f"/api/desk/strategies/{strategy_id}/stage", json={"stage": "live_confirm"}, headers=auth_headers()
    )

    assert skip_ahead.status_code == 400  # draft -> paper is not draft -> alert_only
    assert unknown.status_code == 400  # live_confirm/live_auto do not exist in this schema (§2)


def test_stage_transition_to_paper_requires_confirm_true(client):
    strategy_id = _create_strategy(client)
    client.put(f"/api/desk/strategies/{strategy_id}/stage", json={"stage": "alert_only"}, headers=auth_headers())

    without_confirm = client.put(
        f"/api/desk/strategies/{strategy_id}/stage", json={"stage": "paper"}, headers=auth_headers()
    )
    with_confirm = client.put(
        f"/api/desk/strategies/{strategy_id}/stage", json={"stage": "paper", "confirm": True}, headers=auth_headers()
    )

    assert without_confirm.status_code == 400
    assert with_confirm.status_code == 200
    assert with_confirm.json()["stage"] == "paper"
```

`tests/api/test_signals.py`:

```python
from datetime import UTC, datetime, timedelta

from conftest import OTHER_EMAIL, OWNER_EMAIL, auth_headers
from sqlalchemy import select

from ai_trading.db.models import Signal, Strategy, StrategyVersion, User

NOW = datetime(2026, 7, 15, 20, 0, tzinfo=UTC)


def _user_id(client, db_session, email: str) -> int:
    client.get("/api/desk/settings", headers=auth_headers(email))
    return db_session.execute(select(User.id).where(User.email == email)).scalar_one()


def _make_signal(db_session, owner_id: int, *, symbol: str = "AAPL", bar_time=NOW, created_at=NOW) -> Signal:
    strategy = Strategy(owner_user_id=owner_id, name="S", stage="alert_only", created_at=NOW)
    db_session.add(strategy)
    db_session.flush()
    version = StrategyVersion(
        strategy_id=strategy.id, version=1, schema_version=1, spec={}, created_by=owner_id, created_at=NOW
    )
    db_session.add(version)
    db_session.flush()
    signal = Signal(
        strategy_version_id=version.id,
        symbol=symbol,
        bar_time=bar_time,
        evidence={"close": 101.0},
        data_quality="eod",
        created_at=created_at,
    )
    db_session.add(signal)
    db_session.flush()
    return signal


def test_signals_are_scoped_to_the_owning_strategys_user(client, db_session):
    owner_id = _user_id(client, db_session, OWNER_EMAIL)
    other_id = _user_id(client, db_session, OTHER_EMAIL)
    mine = _make_signal(db_session, owner_id)
    _make_signal(db_session, other_id, bar_time=NOW + timedelta(minutes=1))

    response = client.get("/api/desk/signals", headers=auth_headers(OWNER_EMAIL))

    assert [row["id"] for row in response.json()] == [mine.id]


def test_signals_filter_by_symbol(client, db_session):
    owner_id = _user_id(client, db_session, OWNER_EMAIL)
    aapl = _make_signal(db_session, owner_id, symbol="AAPL")
    _make_signal(db_session, owner_id, symbol="MSFT", bar_time=NOW + timedelta(minutes=1))

    response = client.get("/api/desk/signals", params={"symbol": "AAPL"}, headers=auth_headers(OWNER_EMAIL))

    assert [row["id"] for row in response.json()] == [aapl.id]


def test_signals_filter_by_since(client, db_session):
    owner_id = _user_id(client, db_session, OWNER_EMAIL)
    older = _make_signal(db_session, owner_id, bar_time=NOW, created_at=NOW - timedelta(days=1))
    newer = _make_signal(db_session, owner_id, bar_time=NOW + timedelta(minutes=1), created_at=NOW)

    response = client.get("/api/desk/signals", params={"since": NOW.isoformat()}, headers=auth_headers(OWNER_EMAIL))

    ids = [row["id"] for row in response.json()]
    assert newer.id in ids
    assert older.id not in ids


def test_signals_pagination_limit_and_offset_in_newest_first_order(client, db_session):
    owner_id = _user_id(client, db_session, OWNER_EMAIL)
    first = _make_signal(db_session, owner_id, bar_time=NOW, created_at=NOW - timedelta(minutes=2))
    second = _make_signal(
        db_session, owner_id, bar_time=NOW + timedelta(minutes=1), created_at=NOW - timedelta(minutes=1)
    )
    third = _make_signal(db_session, owner_id, bar_time=NOW + timedelta(minutes=2), created_at=NOW)

    page1 = client.get("/api/desk/signals", params={"limit": 1}, headers=auth_headers(OWNER_EMAIL)).json()
    page2 = client.get("/api/desk/signals", params={"limit": 1, "offset": 1}, headers=auth_headers(OWNER_EMAIL)).json()

    assert [row["id"] for row in page1] == [third.id]
    assert [row["id"] for row in page2] == [second.id]
    assert first.id not in [row["id"] for row in page1 + page2]
```

`tests/api/test_alerts.py`:

```python
from datetime import UTC, datetime

from conftest import OTHER_EMAIL, OWNER_EMAIL, auth_headers
from sqlalchemy import select

from ai_trading.db.models import Alert, User

NOW = datetime(2026, 7, 15, 20, 0, tzinfo=UTC)


def _user_id(client, db_session, email: str) -> int:
    client.get("/api/desk/settings", headers=auth_headers(email))
    return db_session.execute(select(User.id).where(User.email == email)).scalar_one()


def _make_alert(db_session, user_id: int, *, read_at=None) -> Alert:
    alert = Alert(user_id=user_id, kind="system", severity="info", title="t", body="b", created_at=NOW, read_at=read_at)
    db_session.add(alert)
    db_session.flush()
    return alert


def test_list_alerts_unread_filter(client, db_session):
    owner_id = _user_id(client, db_session, OWNER_EMAIL)
    unread = _make_alert(db_session, owner_id)
    _make_alert(db_session, owner_id, read_at=NOW)

    response = client.get("/api/desk/alerts", params={"unread": "true"}, headers=auth_headers(OWNER_EMAIL))

    assert [row["id"] for row in response.json()] == [unread.id]


def test_list_alerts_is_scoped_to_the_current_user(client, db_session):
    owner_id = _user_id(client, db_session, OWNER_EMAIL)
    other_id = _user_id(client, db_session, OTHER_EMAIL)
    mine = _make_alert(db_session, owner_id)
    _make_alert(db_session, other_id)

    response = client.get("/api/desk/alerts", headers=auth_headers(OWNER_EMAIL))

    assert [row["id"] for row in response.json()] == [mine.id]


def test_mark_alert_read_sets_read_at(client, db_session):
    owner_id = _user_id(client, db_session, OWNER_EMAIL)
    alert = _make_alert(db_session, owner_id)

    response = client.post(f"/api/desk/alerts/{alert.id}/read", headers=auth_headers(OWNER_EMAIL))

    assert response.status_code == 200
    assert response.json()["read_at"] is not None


def test_mark_alert_read_404s_for_a_non_owner(client, db_session):
    owner_id = _user_id(client, db_session, OWNER_EMAIL)
    _user_id(client, db_session, OTHER_EMAIL)
    alert = _make_alert(db_session, owner_id)

    response = client.post(f"/api/desk/alerts/{alert.id}/read", headers=auth_headers(OTHER_EMAIL))

    assert response.status_code == 404
```

`tests/api/test_settings.py`:

```python
from conftest import OWNER_EMAIL, auth_headers


def test_get_settings_defaults_to_an_empty_object(client):
    response = client.get("/api/desk/settings", headers=auth_headers(OWNER_EMAIL))

    assert response.status_code == 200
    assert response.json() == {"settings": {}}


def test_put_settings_round_trips(client):
    body = {"settings": {"quiet_hours": {"start": "22:00", "end": "07:00"}, "channels": ["inbox", "telegram"]}}

    put = client.put("/api/desk/settings", json=body, headers=auth_headers(OWNER_EMAIL))
    get = client.get("/api/desk/settings", headers=auth_headers(OWNER_EMAIL))

    assert put.status_code == 200
    assert put.json() == body
    assert get.json() == body
```

`tests/api/test_quotes_sse.py` (Decision 12's identity requirement is exercised in the last test):

```python
"""SSE rate cap and disconnect-stop (PROTO-BRIEF.md §4 L4). Exercises `quote_events`/
`stream_quotes` directly with a fake `DataSources` and a fake clock/sleep -- no real 0.25s wait,
no real socket, no live network call."""

import asyncio

from fakes import FakeBarsSource, fake_data_sources, one_bar_frame

from ai_trading.api.auth import AuthedUser
from ai_trading.api.quotes import MIN_INTERVAL_SECONDS, quote_events, stream_quotes


async def _no_sleep(seconds: float) -> None:
    return None


def _disconnect_after(n: int):
    calls = 0

    async def is_disconnected() -> bool:
        nonlocal calls
        calls += 1
        return calls > n

    return is_disconnected


def test_quote_events_sleeps_the_minimum_interval_every_tick_even_with_an_instant_read():
    sleeps: list[float] = []

    async def fake_sleep(seconds: float) -> None:
        sleeps.append(seconds)

    data_sources = fake_data_sources(FakeBarsSource({"AAPL": one_bar_frame(101.0)}))

    async def run() -> list[dict]:
        return [event async for event in quote_events("AAPL", data_sources, _disconnect_after(5), sleep=fake_sleep)]

    events = asyncio.run(run())

    assert len(events) == 5
    assert sleeps == [MIN_INTERVAL_SECONDS] * 5


def test_quote_events_stops_as_soon_as_the_client_disconnects():
    data_sources = fake_data_sources()

    async def already_disconnected() -> bool:
        return True

    async def run() -> list[dict]:
        return [event async for event in quote_events("AAPL", data_sources, already_disconnected, sleep=_no_sleep)]

    assert asyncio.run(run()) == []


def test_quote_events_skips_a_tick_with_no_data_but_keeps_the_cadence():
    sleeps: list[float] = []

    async def fake_sleep(seconds: float) -> None:
        sleeps.append(seconds)

    data_sources = fake_data_sources()  # no frame for "AAPL" -> every tick is a quiet one

    async def run() -> list[dict]:
        return [event async for event in quote_events("AAPL", data_sources, _disconnect_after(3), sleep=fake_sleep)]

    events = asyncio.run(run())

    assert events == []  # nothing to send, but the generator still ran -- and slept -- 3 times
    assert sleeps == [MIN_INTERVAL_SECONDS] * 3


def test_stream_quotes_route_wires_an_event_source_response_around_quote_events():
    class _AlreadyDisconnectedRequest:
        async def is_disconnected(self) -> bool:
            return True

    async def run():
        response = await stream_quotes(
            "AAPL",
            _AlreadyDisconnectedRequest(),
            user=AuthedUser(id=1, email="owner@example.com"),
            data_sources=fake_data_sources(),
        )
        events = [event async for event in response.body_iterator]
        return response, events

    response, events = asyncio.run(run())

    assert response.media_type == "text/event-stream"
    assert events == []
```

`tests/api/test_app_background_loops.py`:

```python
"""App background-task wiring smoke test (PROTO-BRIEF.md §4 L4): proves `_background_loop` calls
its `work` callable against a fresh session every `interval` seconds, forever, with a fake clock
and a fake `sleep` -- no real waiting, no real database."""

import asyncio
from datetime import UTC, datetime

from ai_trading.api.app import DISPATCH_INTERVAL_SECONDS, TICK_INTERVAL_SECONDS, _background_loop

_NOW = datetime(2026, 7, 15, 20, 0, tzinfo=UTC)


class _FakeSessionFactory:
    """A bare callable standing in for `sessionmaker[Session]`: each call returns a distinct fake
    "session" object, and nothing here ever touches a real engine."""

    def __init__(self) -> None:
        self.sessions_made = 0

    def __call__(self):
        self.sessions_made += 1
        return _FakeSession()


class _FakeSession:
    def commit(self) -> None:
        pass

    def rollback(self) -> None:
        pass

    def close(self) -> None:
        pass


def _stop_after(n: int):
    """A fake `sleep` that raises once it's been awaited `n` times, ending the otherwise-infinite
    `_background_loop` deterministically."""
    calls: list[float] = []

    async def sleep(seconds: float) -> None:
        calls.append(seconds)
        if len(calls) >= n:
            raise asyncio.CancelledError

    return sleep, calls


def test_background_loop_calls_work_against_a_fresh_session_every_interval():
    factory = _FakeSessionFactory()
    work_calls: list[datetime] = []
    sleep, sleeps = _stop_after(3)

    async def run() -> None:
        await _background_loop(
            lambda session, now: work_calls.append(now),
            factory,
            interval=TICK_INTERVAL_SECONDS,
            sleep=sleep,
            clock=lambda: _NOW,
        )

    try:
        asyncio.run(run())
    except asyncio.CancelledError:
        pass

    assert work_calls == [_NOW] * 3
    assert sleeps == [TICK_INTERVAL_SECONDS] * 3
    assert factory.sessions_made == 3


def test_background_loop_survives_one_failing_iteration_and_uses_its_own_interval():
    calls = 0

    def flaky_work(session, now: datetime) -> None:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("boom")

    sleep, sleeps = _stop_after(2)

    async def run() -> None:
        await _background_loop(
            flaky_work, _FakeSessionFactory(), interval=DISPATCH_INTERVAL_SECONDS, sleep=sleep, clock=lambda: _NOW
        )

    try:
        asyncio.run(run())
    except asyncio.CancelledError:
        pass

    assert calls == 2  # the first iteration's RuntimeError never killed the loop
    assert sleeps == [DISPATCH_INTERVAL_SECONDS] * 2
```

`tests/api/test_main_entrypoint.py` (Decision 16):

```python
"""Integration fix (PROTO-BRIEF.md): exactly one served ASGI app. `deploy/production/Dockerfile`'s
image and `docker-compose.yml`'s `api` service `command:` both name `ai_trading.api.main:app` --
this proves that target actually resolves to the same wired FastAPI instance as `ai_trading.api.app`
(not a second, divergent app object), and that its lifespan builds real startup wiring (the
background tick/dispatch loops, against the real `ai_trading.engine.tick.tick`/
`ai_trading.notify.dispatch.dispatch_pending`, never a stub) from a real database.
"""

from datetime import UTC, datetime

from fastapi.testclient import TestClient

from ai_trading.api import app as app_module
from ai_trading.api import main as main_module


def test_main_app_is_the_same_object_as_app_module_app():
    assert main_module.app is app_module.app


def test_lifespan_wires_the_real_engine_and_notify_functions_against_the_database(db_engine, monkeypatch):
    monkeypatch.delenv("TELEGRAM_BOT_TOKEN", raising=False)
    monkeypatch.delenv("SLACK_WEBHOOK_URL_OWNER", raising=False)
    monkeypatch.setenv("DESK_RUNTIME_DATABASE_URL", db_engine.url.render_as_string(hide_password=False))

    with TestClient(main_module.app) as client:
        session_factory = client.app.state.session_factory
        assert session_factory is not None
        assert client.app.state.data_sources is not None

        # The lifespan's own background-loop callables close over the real `engine.tick.tick` and
        # `notify.dispatch.dispatch_pending` (imported by `app.py` at module load, not a stub) --
        # proven here by running one tick/dispatch cycle directly against the configured database,
        # the same way `_background_loop` does every interval, and seeing it succeed cleanly
        # against an empty (freshly migrated, no strategies/deliveries yet) database.
        with session_factory() as session:
            tick_result = app_module.tick(session, now=datetime.now(UTC))
            assert tick_result.evaluated_strategies == 0
            assert tick_result.errors == []

            dispatch_result = app_module.dispatch_pending(session, channels={}, now=datetime.now(UTC))
            assert dispatch_result == []
            session.commit()
```

- [ ] **Step 16: Run it.**

Run: `uv run pytest -q tests/api/test_quotes_sse.py tests/api/test_app_background_loops.py
tests/api/test_main_entrypoint.py::test_main_app_is_the_same_object_as_app_module_app`
Expected: `7 passed` (4 + 2 + 1, all offline).
Run: `./scripts/test-db.sh tests/api/`
Expected: `34 passed` (the full `tests/api/` directory, DB and offline mixed — the
`test_healthz.py` file from Task 3.7 is not created yet, so this directory's count is 34, not 38;
Task 3.7's step re-runs the whole suite once it exists).

- [ ] **Step 17: Commit.**

```
git add packages/family-desk/backend/pyproject.toml packages/family-desk/backend/uv.lock packages/family-desk/backend/src/ai_trading/api packages/family-desk/backend/src/ai_trading/db/engine.py packages/family-desk/backend/tests/api
git commit -m "Desk: ai_trading.api (FastAPI, identity, REST, SSE quotes)"
```

---

## Task 3.6: Deploy — Dockerfile, bake, compose, Caddy route, deploy.sh

**Files:**
- Create: `packages/family-desk/backend/Dockerfile`
- Create: `deploy/ci/test-l6-desk.sh` (offline L6 deploy harness, adapted from the integrated
  prototype's own `temp/p3-proto/final/ai-trading/deploy/ci/test-l6-desk.sh` for this task's real
  file layout and the app-controls availability gate — Step 7 below)
- Modify: `deploy/docker-bake.hcl` (add target `desk`, add it to `group "default"`)
- Modify: `deploy/production/docker-compose.yml` (add services `api`, `scheduler`; add network
  `database`; `scheduler` gets a `healthcheck:` running `python -m ai_trading.jobs.healthcheck`
  — review fix F4)
- Modify: `deploy/production/Caddyfile` (add `handle /api/desk/*`)
- Modify: `deploy/production/deploy.sh` (2 lines: `SECRET_FILES`, `render_profiles`' call list)
- No change: `deploy/production/health-check.sh` (its `SERVICES` is computed dynamically from the
  catalog now — see below)
- **Not in this task (Decision 5, approved 2026-10-12, ships in its own follow-up PR):** `control/catalog.json` and `control/state.py` —
  registering `api`/`scheduler` as protected app-controls services edits the open-source lane's
  shared control files, so it ships in its own approved follow-up PR (see Decision 5). Without this
  registration, `deploy.sh`'s `apply_selected_services` does not start `api`/`scheduler` on a real
  deploy; that registration is a separate, owner-approved follow-up, not part of this commit.

**Interfaces:** no code interface; this task only needs 3.4's `jobs/scheduler.py` and 3.5's
`api/app.py`/`api/main.py` to exist for its `command:` lines (the two existing module paths).

A note on how this task's content differs from the integrated prototype: the prototype's own L6
deploy files (`ai-trading/temp/p3-proto/final/ai-trading/deploy/...`) were built against an older
snapshot of `deploy.sh`/`health-check.sh`/`docker-compose.yml`, **before** the app-controls system
(`control/catalog.json`, `control/state.py`, the `apply_selected_services`/`stop_disabled_groups`
machinery) landed on `dev`. The steps below are written against the **current** real files — the
new service blocks, the Caddy route, and the `deploy.sh` two-line diff are unchanged from the
prototype's own content (they don't touch anything the app-controls system changed), and
`health-check.sh` needs **no edit at all** (explained in Step 5). The app-controls registration
itself (`control/catalog.json`/`control/state.py`) is Decision 5, approved 2026-10-12 and shipped in its own follow-up PR —
it is not applied by this task.

- [ ] **Step 1: Create the Dockerfile.**

```dockerfile
# syntax=docker/dockerfile:1.7
# Family Desk backend image: one image, two entrypoints -- `api` (uvicorn)
# and `scheduler` -- docker-compose.yml's `command:` picks which to run
# (02c Shared Interfaces: "both run from one image"). "Our code" convention
# (brief L6): alongside ai-trading/auth/Dockerfile and
# ai-trading/market-data/Dockerfile, never under deploy/upstream/ (that's
# for the four submodule apps only).
#
# Build context is ai-trading/ (NOT this file's own directory): see
# docker-bake.hcl's "desk" target. packages/family-desk/backend/pyproject.toml
# resolves its `ai-trading-common` dependency as `../../../common` --
# relative to the repo layout -- so both directories must be copied into the
# build with that same relative layout preserved, which a context scoped to
# just the backend directory could not do.
ARG PYTHON_IMAGE=python:3.12-slim-trixie@sha256:a6e34c598f2467ed0e9a8d349809fcd8b5c603269512df273a0bb1784edc11b1

FROM ${PYTHON_IMAGE} AS build
COPY --from=ghcr.io/astral-sh/uv:0.9.26 /uv /uvx /bin/
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy
WORKDIR /src/packages/family-desk/backend
# Installs exactly what the lock pins; a stale lock fails the build loudly
# (same two-step -- deps first, source second -- as deploy/upstream/mirofish/
# Dockerfile, so an unchanged lock keeps the dependency layer cached).
COPY common /src/common
COPY packages/family-desk/backend/pyproject.toml packages/family-desk/backend/uv.lock ./
# --no-editable: pyproject.toml's tool.uv.sources marks ai-trading-common
# editable (an absolute /src/common path) for local dev; without this flag
# the venv built here would keep pointing at that build-stage-only path,
# which the final stage below never copies in. --no-editable installs it as
# a normal built wheel instead, so the final image needs nothing but its own
# venv (verified empirically: a plain `uv sync --frozen` here produced a venv
# that ImportError'd on ai_trading_common once /src/common was gone).
RUN uv sync --frozen --no-dev --no-editable --no-install-project
COPY packages/family-desk/backend .
RUN uv sync --frozen --no-dev --no-editable

FROM ${PYTHON_IMAGE}
RUN useradd --create-home --shell /usr/sbin/nologin app
COPY --from=build --chown=app:app /src/packages/family-desk/backend /app
ENV PATH=/app/.venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1
USER app
WORKDIR /app
EXPOSE 8000
# No CMD (brief L6): docker-compose.yml's `command:` selects
# `uvicorn ai_trading.api.main:app --host 0.0.0.0 --port 8000` for `api` (the
# one served ASGI app; integration fix, PROTO-BRIEF.md) or
# `python -m ai_trading.jobs.scheduler` for `scheduler` from this one image.
```

- [ ] **Step 2: Add the `desk` bake target.** In `deploy/docker-bake.hcl`, find:

```hcl
group "default" {
  targets = ["web", "ta-terminal", "ta-research", "ahf-terminal", "market-data", "vibe-trading", "mirofish-backend", "auth"]
}
```

Replace with:

```hcl
group "default" {
  targets = ["web", "ta-terminal", "ta-research", "ahf-terminal", "market-data", "vibe-trading", "mirofish-backend", "auth", "desk"]
}
```

Then add this target (any location among the other `target` blocks; after `target "auth"` matches
this file's existing ordering):

```hcl
target "desk" {
  # Context is the ai-trading/ root, not packages/family-desk/backend -- its
  # pyproject.toml resolves ai-trading-common as ../../../common, a sibling
  # directory this build needs copied in with the same relative layout
  # (see the Dockerfile's own header comment).
  context    = "ai-trading"
  dockerfile = "packages/family-desk/backend/Dockerfile"
  tags       = ["${REGISTRY}/ai-trading-desk:${TAG}"]
}
```

- [ ] **Step 3: Add the `api`/`scheduler` services to `docker-compose.yml`.** Add this block as
  the last two services before the top-level `networks:` key:

```yaml
  # Family Desk Phase 3 (02c; owner decision 2026-10-12, D-e): the Desk joins
  # the shared VPS Postgres cluster instead of a Desk-private "desk-postgres"
  # container. `database` below is this repo's OWN top-level network name,
  # pointed at the shared cluster's real external network (`postgres_default`,
  # the project-default name 30-postgres.sh's own Compose project creates) --
  # the exact shape expense-tax-management/deploy/production/docker-compose.yml
  # already uses for the same shared cluster. No desk-postgres service, no
  # Desk-private network, and no Desk-private data volume: nothing here is
  # Desk-private anymore. Neither service gets a `depends_on` on the cluster
  # (D-e, Task 3.6): it lives in a different Compose project
  # (family-app-postgres, ${SHARED_PG_DIR}), already running before Desk ever
  # deploys -- Compose cannot condition on a container from another project,
  # and no other app's compose file in this repo does either. Each service's
  # own healthcheck/startup retry is the gate instead.
  api:
    image: ${AI_TRADING_REGISTRY:-ghcr.io/thangtran3112/family-app}/ai-trading-desk:${AI_TRADING_IMAGE_TAG:?AI_TRADING_IMAGE_TAG is required}
    restart: unless-stopped
    command: uvicorn ai_trading.api.main:app --host 0.0.0.0 --port 8000
    env_file:
      - ${AI_TRADING_SECRETS_DIR:-/etc/family-app/ai-trading}/desk.env
    # The only Desk service on `gateway` -- so Caddy can reach it at
    # api:8000 (Caddyfile's /api/desk/* route) -- plus `database` to reach
    # the shared Postgres cluster at its `postgres` hostname.
    networks: [database, gateway]
    mem_limit: 512m
    pids_limit: 256
    security_opt: ["no-new-privileges:true"]
    healthcheck:
      # Generous retries/start_period (not this file's usual 3/10s): `api`
      # has no depends_on on the shared cluster above (D-e health-gating
      # note, Task 3.6). `/healthz` is a real READINESS check (Decision 4):
      # it runs `SELECT 1` against the Desk database with a 1-second connect
      # timeout on every call, returning 503 when the database can't be
      # reached -- it makes one bounded attempt per call, not its own retry
      # loop, so it's THIS healthcheck's interval/retries/start_period that
      # give a cold/slow shared cluster time to become reachable, by polling
      # the probe repeatedly rather than the probe itself looping.
      test: ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=4)"]
      interval: 10s
      timeout: 5s
      start_period: 60s
      retries: 10

  scheduler:
    image: ${AI_TRADING_REGISTRY:-ghcr.io/thangtran3112/family-app}/ai-trading-desk:${AI_TRADING_IMAGE_TAG:?AI_TRADING_IMAGE_TAG is required}
    restart: unless-stopped
    command: python -m ai_trading.jobs.scheduler
    env_file:
      - ${AI_TRADING_SECRETS_DIR:-/etc/family-app/ai-trading}/desk.env
    # Database only -- never gateway (it's a background job loop, not an
    # HTTP service Caddy ever reaches).
    networks: [database]
    mem_limit: 512m
    pids_limit: 256
    security_opt: ["no-new-privileges:true"]
    healthcheck:
      # F4: `scheduler` has no HTTP endpoint for Docker to poll (unlike
      # `api`'s `/healthz`), so its own main loop touches a heartbeat file
      # once per iteration (ai_trading.jobs.scheduler.main) and this
      # healthcheck runs ai_trading.jobs.healthcheck in-process, which exits
      # 0 only while that heartbeat is still fresh (< 180s old) -- a stuck or
      # crashed loop stops touching it and this starts failing within one
      # window.
      test: ["CMD", "python", "-m", "ai_trading.jobs.healthcheck"]
      interval: 30s
      timeout: 5s
      start_period: 60s
      retries: 5
```

Then, in the top-level `networks:` block, add:

```yaml
  # The shared VPS Postgres cluster's own Compose project default network
  # (infrastructure/vps/steps/30-postgres.sh's project directory is
  # ${SHARED_PG_DIR}, so Compose's default "<project>_default" naming makes
  # it postgres_default) -- external because that cluster is a different
  # Compose project with its own lifecycle, already running before this
  # project ever deploys. "database" is purely this file's own local name
  # for it (same alias expense-tax-management's docker-compose.yml uses).
  database:
    external: true
    name: postgres_default
```

- [ ] **Step 4: Add the Caddy route.** In `deploy/production/Caddyfile`, inside the existing
  `:8080` block, insert this new `handle` block **immediately before** the existing
  `# MiroFish (01i): ...` comment and its `handle /api/* { ... }` block (Caddy `handle` blocks
  match in written order, first match wins, and a bare `/api/*` would also match `/api/desk/*`):

```caddyfile
	handle /api/desk/* {
		route {
			request_header -Cf-Access-Authenticated-User-Email
			forward_auth auth:8181 {
				uri /__auth/check
				copy_headers X-Verified-Email>Cf-Access-Authenticated-User-Email
			}
			reverse_proxy api:8000
		}
	}

```

No `import availability_gate desk` line (unlike the `/u/*`/`/api/*` MiroFish route): Decision 5
(approved 2026-10-12; shipped in its own follow-up PR) would register `api`/`scheduler` as **protected** (always-on), the same category
`market-data`/`auth`/`gateway` are in, and no protected service's own Caddy route carries an
availability gate — confirmed by grepping the current Caddyfile (`market-data` has no route
needing one; every `import availability_gate <id>` line names a *toggleable* `apps` entry). This
route carries no gate either way for now, since the app-controls registration itself is deferred.

This makes the route exist and be correctly gated, but **not publicly reachable**: no hostname in
`infrastructure/cloudflare/ai-trading/` points a Cloudflare Tunnel ingress rule at it yet (Decision
not touched in this phase, D-b), and `trading.tobytran.dev` still resolves to `web:3000` until
Phase 4 (AGENTS.md: nothing else may be put there).

- [ ] **Step 5: `deploy.sh`'s two-line change.** Find:

```bash
SECRET_FILES=(tradingagents.env ai-hedge-fund.env vibe-trading.env vibe-gateway.env auth.env market-data.env cloudflared.env)
```

Replace with:

```bash
SECRET_FILES=(tradingagents.env ai-hedge-fund.env vibe-trading.env vibe-gateway.env auth.env market-data.env desk.env cloudflared.env)
```

Find:

```bash
    "$family_config" render ai-trading/tradingagents ai-trading/ai-hedge-fund ai-trading/vibe-trading ai-trading/gateway ai-trading/market-data \
      --out-dir "$RENDER_SRC_DIR"
```

Replace with:

```bash
    "$family_config" render ai-trading/tradingagents ai-trading/ai-hedge-fund ai-trading/vibe-trading ai-trading/gateway ai-trading/market-data ai-trading/desk \
      --out-dir "$RENDER_SRC_DIR"
```

No rename step needed (unlike `gateway` → `auth.env`): `family_config.py`'s `render` writes
`<profile-basename>.env`, and the profile is already named `desk`. `CONFIG_FILES` already lists
`docker-compose.yml`, `Caddyfile`, and `health-check.sh` — every file this task touches is already
covered by `deploy.sh`'s existing atomic stage/validate/rollback machinery; no new `CONFIG_FILES`
entry is needed (`control/catalog.json`/`control/state.py` are also in `CONFIG_FILES` already, for
the hub's other apps, but this task does not touch them — Decision 5, approved 2026-10-12). `prune_old_images`'s
existing `"$REGISTRY"/ai-trading-*:*` glob already covers the new `ai-trading-desk` image.

- [ ] **Step 6: Validate.** From the repository root:

```
docker compose -f ai-trading/deploy/production/docker-compose.yml -f ai-trading/deploy/production/docker-compose.mirofish.yml config --quiet
```

Expected: exit 0. Then confirm the resolved shape:

```
docker compose -f ai-trading/deploy/production/docker-compose.yml -f ai-trading/deploy/production/docker-compose.mirofish.yml config --format json | python3 -c "
import json, sys
cfg = json.load(sys.stdin)
api = cfg['services']['api']
assert api['command'] == ['uvicorn', 'ai_trading.api.main:app', '--host', '0.0.0.0', '--port', '8000']
assert set(api['networks']) == {'database', 'gateway'}
assert 'ports' not in api and 'depends_on' not in api
scheduler = cfg['services']['scheduler']
assert scheduler['command'] == ['python', '-m', 'ai_trading.jobs.scheduler']
assert set(scheduler['networks']) == {'database'}
assert scheduler['healthcheck']['test'][-1] == 'ai_trading.jobs.healthcheck'  # F4d
assert cfg['networks']['database']['external'] is True or cfg['networks']['database']['external']['name'] == 'postgres_default'
print('ok')
"
```

Expected: `ok`.

- [ ] **Step 7: Create and run the offline L6 deploy harness, `deploy/ci/test-l6-desk.sh`.** The
  integrated prototype's own `temp/p3-proto/final/ai-trading/deploy/ci/test-l6-desk.sh` was written
  against that prototype's pre-app-controls snapshot of the real files (same gap Step 3's own note
  above describes); this task creates the real repository's copy, adapted for its actual file
  layout (`packages/family-desk/backend/` lives directly under `ai-trading/`, not nested the way the
  integration's own `final/` tree was) and for the app-controls availability gate (Task 4, 01g):
  `/api/*` (MiroFish) now runs through `import availability_gate mirofish`, calling a control helper
  over a unix socket at `/run/family-app/ai-trading-control/control.sock`, which no offline harness
  may touch directly. Its real-Caddy routing check (Case 12) instead stands up a throwaway Python
  control-helper stub listening on a unix socket inside its own temp directory, bind-mounted into
  the test Caddy container at that same hardcoded path — mirroring how production bind-mounts the
  real helper's socket directory in, never the real host path itself. Case 8 (health-check.sh's
  `SERVICES`) is adjusted to confirm the file is *unchanged* and still dynamically computed (Decision
  5 was HELD when this harness was written, so `api`/`scheduler` were not yet in the catalog `health-check.sh` reads; the follow-up PR adds them), rather than
  asserting a static list that no longer exists. Case 9 additionally confirms `handle /api/desk/*`
  carries no `import availability_gate` of its own (it is not yet a toggleable app-controls entry).
  Every other case (1–7, 10–11, 13) is unchanged from the prototype's own copy, and the case count
  stays the same: 24 counted cases (plus Case 13, permanently informational-SKIP by design, same as
  the prototype's own copy — the Dockerfile build it would otherwise need is run manually instead,
  per `ai-trading/AGENTS.md`'s Verification section).

```
cd ai-trading
bash deploy/ci/test-l6-desk.sh
```

Expected: `24 checks passed, 0 failed (test-l6-desk.sh)`, with Cases 10–12 actually running (not
skipping) whenever a Docker daemon is available, and zero stray containers/networks left behind.

- [ ] **Step 8: Run the two existing, unmodified offline deploy test scripts against the edited
  files.**

```
cd ai-trading
bash deploy/ci/test-deploy-firestore.sh
bash deploy/ci/test-render-env.sh
```

Expected: `RESULT: GREEN -- 54 cases, 0 failures` and `14 checks passed (render-env.sh)` — these
two scripts are unaffected by the healthz fix or the scheduler healthcheck change (they test
`deploy.sh`'s secret-staging/rollback machinery and the CI-side Cloudflare tunnel-token fetch,
neither of which this task's changes touch).

- [ ] **Step 9: Commit.**

```
git add packages/family-desk/backend/Dockerfile deploy/docker-bake.hcl deploy/production/docker-compose.yml deploy/production/Caddyfile deploy/production/deploy.sh
git commit -m "Desk: deploy (Dockerfile, bake, compose, Caddy route)"
```

`deploy/ci/test-l6-desk.sh` and the scheduler's `healthcheck:` block (Step 3/7 above) ship in a
separate reconciliation commit on top of this one, `Desk: deploy health and offline harness` — the
lane that produced this commit was still working from the plan's pre-review-fix snapshot when it
landed; this plan describes the finished, reconciled state.

Decision 5's app-controls registration (`control/catalog.json`, `control/state.py`) is approved (2026-10-12) — it is
a separate follow-up PR, not part of this one.

---

## Task 3.7: Integration and readiness

This task has three parts: confirm the `/healthz` fix (already written into Task 3.5's `api/app.py`
and Task 3.1's `db/engine.py` above — this is where it's reviewed and its new counts are recorded),
restore the real `pyproject.toml` path, and confirm the CI workflow needs no new step.

**Files:** none new. Confirms: `packages/family-desk/backend/src/ai_trading/api/app.py`,
`packages/family-desk/backend/src/ai_trading/db/engine.py`, a new
`packages/family-desk/backend/tests/api/test_healthz.py`,
`packages/family-desk/backend/pyproject.toml`'s `[tool.uv.sources]`,
`.github/workflows/ai-trading-ci.yml`.

- [ ] **Step 1: Create `tests/api/test_healthz.py`** (4 tests: 1 DB-dependent, 3 offline):

```python
"""`/healthz` readiness probe (Step 0 integration fix, flagged by INTEGRATION-REPORT.md §6.3): a
real `SELECT 1` against the Desk database with a 1-second connect timeout. 200 `{"status": "ok"}`
on success; 503 `{"status": "unavailable"}` on any failure -- the real error text and the database
URL are never returned (AGENTS.md: no VPS address or credential in any response this process
writes)."""

from fastapi.testclient import TestClient
from sqlalchemy import create_engine

from ai_trading.api.app import app

# Nothing listens here; a short connect_timeout makes the failure fast and deterministic, no real
# network wait and no real Postgres needed for these two tests.
_BAD_URL = "postgresql+psycopg://baduser:badpass@127.0.0.1:1/nonexistent"


def _bad_engine():
    return create_engine(_BAD_URL, connect_args={"connect_timeout": 1})


def test_healthz_returns_200_ok_when_the_database_answers(db_engine):
    app.state.health_engine = db_engine
    try:
        with TestClient(app) as client:
            response = client.get("/healthz")
    finally:
        del app.state.health_engine

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_healthz_returns_503_unavailable_when_the_database_cannot_be_reached():
    bad_engine = _bad_engine()
    app.state.health_engine = bad_engine
    try:
        with TestClient(app) as client:
            response = client.get("/healthz")
    finally:
        del app.state.health_engine
        bad_engine.dispose()

    assert response.status_code == 503
    assert response.json() == {"status": "unavailable"}


def test_healthz_503_body_never_contains_the_database_url_credentials_or_an_error_message():
    bad_engine = _bad_engine()
    app.state.health_engine = bad_engine
    try:
        with TestClient(app) as client:
            response = client.get("/healthz")
    finally:
        del app.state.health_engine
        bad_engine.dispose()

    body_text = response.text
    assert response.json() == {"status": "unavailable"}
    for secret_shaped_fragment in ("baduser", "badpass", "127.0.0.1", "nonexistent", "psycopg", "OperationalError"):
        assert secret_shaped_fragment not in body_text


def test_healthz_returns_503_when_no_database_is_configured_at_all():
    assert not hasattr(app.state, "health_engine")  # no lifespan ran in this bare-module test

    with TestClient(app) as client:
        response = client.get("/healthz")

    assert response.status_code == 503
    assert response.json() == {"status": "unavailable"}
```

(Task 3.5's own steps already wrote `app.py`'s fixed `/healthz` handler and `db/engine.py`'s
`make_health_check_engine` — this step only adds the pinning test, matching the order this plan was
actually built in: the integrated prototype shipped the static `/healthz`, Step 0 of writing this
plan fixed it, and this task is where that fix is reviewed in the finished plan.)

- [ ] **Step 2: Fix the `docker-compose.yml` healthcheck comment to match the real behavior.**
  Task 3.6's Step 3 above already writes the **corrected** comment; if a worktree somehow still has
  the integrated prototype's stale comment ("Phase 3's api.py is responsible for making `/healthz`
  actually retry internally"), replace it with the text Task 3.6 Step 3 shows (it already states
  `/healthz` runs `SELECT 1` with a 1-second connect timeout and makes one bounded attempt per
  call).

- [ ] **Step 3: Restore the real `[tool.uv.sources]` path and re-lock.** The integrated
  prototype's `pyproject.toml` carried a lane-local-only absolute path
  (`/Users/.../ai-trading/common`, 3 directories shallower than the real
  `packages/family-desk/backend/`). In the real repository, the path is already relative (every
  earlier task's `pyproject.toml` edit in this plan was written against the real file, so this step
  is a confirmation, not a correction):

```toml
[tool.uv.sources]
ai-trading-common = { path = "../../../common", editable = true }
```

Run (in `packages/family-desk/backend/`): `uv lock`. Expect `uv.lock` to update cleanly (new
`fastapi`/`uvicorn`/`sse-starlette`/`requests`/`httpx` entries from Tasks 3.2 and 3.5, resolved
against the real `../../../common` path) — confirmed buildable end-to-end by Task 3.6's Dockerfile
(a real `docker build` against this exact relative path succeeds, per the integration's own
verification).

- [ ] **Step 4: Confirm `.github/workflows/ai-trading-ci.yml`'s `desk` job needs no new step.**
  Its existing "Backend" step already runs `uv run pytest -q` with `testpaths = ["tests"]`
  (`pyproject.toml`), which recursively collects every directory under `tests/` — `tests/notify/`,
  `tests/engine/`, `tests/jobs/`, `tests/api/` are picked up automatically, with no new CI step,
  only a longer run. Confirm by reading the job (no edit expected):

```
grep -n "working-directory: ai-trading/packages/family-desk/backend" -A 8 .github/workflows/ai-trading-ci.yml
```

Expected: the existing `postgres:17` service, `DESK_TEST_DATABASE_URL`/`DESK_REQUIRE_DB=1`, and
`uv run pytest -q` are unchanged from before this phase.

- [ ] **Step 4b: CI's `Scripts and compose` job needs the Desk env placeholder.** The job creates empty placeholder env files for the upstream apps and the gateway, then runs `docker compose config` on the production file. The `api` and `scheduler` services read `${AI_TRADING_SECRETS_DIR}/desk.env`, so the job fails with "env file .../desk.env not found" unless that placeholder exists. Add `desk` to the placeholder loop in the `scripts` job of `.github/workflows/ai-trading-ci.yml`, so the loop reads `for name in tradingagents ai-hedge-fund vibe-trading vibe-gateway cloudflared auth market-data desk; do : >"$secrets/$name.env"; done`. Verify with the same two `docker compose config --quiet` commands against a placeholder directory. Both must pass. (Found on PR #121's first CI run, 2026-10-12; Step 4 above had checked only the `desk` job.)

- [ ] **Step 5: Run the full suite, with and without Postgres, plus ruff.**

Run (in `packages/family-desk/backend/`):

```
uv sync
uv run pytest -q -rs
```

Expected: `660 passed, 0 failed, 107 skipped` (every skip is a DB-dependent test — 105 from before
this review fix plus the 2 new `test_relogin_reminder.py` DB-dependent tests this fix added, F1/F3;
of the 13 total tests this review fix added across `tests/jobs/test_scheduler.py` and
`tests/jobs/test_relogin_reminder.py`, 11 are offline and 2 need the database — 649+11=660 passed,
105+2=107 skipped, 754+13=767 collected).

Run:

```
./scripts/test-db.sh
```

Expected: `767 passed, 0 failed in <about 32s>` (754 from before this review fix, plus the 13 new
tests this fix added across `test_scheduler.py` and `test_relogin_reminder.py`). Confirm no stray
container: `docker ps --format '{{.Names}}'` must not list a `desk-test-postgres-*` name after this
command exits, and the host's pre-existing `lock-test-*` container (if any) must be untouched.

Run:

```
uv run ruff check .
uv run ruff format --check .
```

Expected: `Ruff: No issues found` (lint) and `129 files already formatted` (ruff's own count — one
new source file, `src/ai_trading/jobs/healthcheck.py` (F4c), joined the tracked set; one source
file, `src/ai_trading/contracts/strategy_spec_v1.py`, is excluded by `extend-exclude`, so the 130
tracked `.py` files under this package become 129 checked).

- [ ] **Step 6: Re-run the deploy offline suites once more, for the record.**

```
cd ../../../../  # repository root (packages/family-desk/backend -> ai-trading -> repo root is 4 levels, not 3)
bash ai-trading/deploy/ci/test-deploy-firestore.sh
bash ai-trading/deploy/ci/test-render-env.sh
```

Expected: `RESULT: GREEN -- 54 cases, 0 failures` and `14 checks passed (render-env.sh)` (Task
3.6's Step 7 numbers, unchanged — these two scripts don't exercise `/healthz` or the scheduler
healthcheck).

- [ ] **Step 7: Commit.**

```
cd ai-trading/packages/family-desk/backend
git add src/ai_trading/api/app.py src/ai_trading/db/engine.py tests/api/test_healthz.py pyproject.toml uv.lock
git commit -m "Desk: /healthz readiness probe (Step 0 fix)"
```

---

## Task 3.8: Release and operator checklist

No code — this is the release procedure and the operator's one-time onboarding steps. Standing
delivery authorization applies (AGENTS.md): after Task 3.7's verification is green, commit, PR to
`dev`, merge, release the scoped paths to `main`, deploy, and verify the live result — monitor
`health-check.sh` and confirm `api`/`scheduler` report healthy, and that the shared
`family-app-postgres` cluster is reachable, before declaring the phase complete.

**Decision 5 is approved (2026-10-12), and its registration ships with this release.**
`ai-trading/control/catalog.json` and `ai-trading/control/state.py` are part of this release's paths
(registered by the follow-up PR). Until that registration is on `main`, `deploy.sh`'s
`apply_selected_services` would **not** start `api`/`scheduler` on a real deploy (their compose
blocks exist, but neither name is in `catalog.json`'s `protected` list), and `health-check.sh`'s
dynamic `SERVICES` list would not include them either. Step 4's live verification below assumes
the registration is on `main`; if it isn't, the containers simply won't be
running yet and Step 4 should be treated as blocked, not failed.

- [ ] **Step 1: Confirm the scoped release paths.** This is the **first** `main` release carrying
  Desk code (02c). The release branch (from `origin/main`) carries only:

  - `ai-trading/common/` (the shared package; the Desk image copies it in, so the image cannot
    build without it; found on the 2026-10-12 release dry run)
  - `ai-trading/packages/family-desk/backend/` (all of it, including
    `docker/postgres/zz-20-desk-roles.sh`)
  - `ai-trading/packages/family-desk/contracts/` (the backend's contract and template tests read its
    fixtures and generated schema; found on the same dry run)
  - `ai-trading/deploy/docker-bake.hcl`
  - `ai-trading/deploy/production/docker-compose.yml`
  - `ai-trading/deploy/production/Caddyfile`
  - `ai-trading/deploy/production/deploy.sh`
  - `infrastructure/vps/apps/ai-trading-desk.conf`
  - `ai-trading/deploy/ci/test-l6-desk.sh` (the offline harness)

  **Also in this release** (Decision 5, approved 2026-10-12): `ai-trading/control/catalog.json` and
  `ai-trading/control/state.py`, with `ai-trading/control/test_state.py` and the operator sentence in
  `ai-trading/deploy/production/README.md`.

  **Shared files touched beyond this phase's own lines** (confirm the diff contains nothing else):
  `deploy/production/docker-compose.yml`, `deploy/production/Caddyfile`, `deploy/production/deploy.sh`
  are all shared with the hub's four existing apps (TradingAgents, ai-hedge-fund, Vibe-Trading,
  MiroFish) and the expense-tax stack's own use of the shared Postgres cluster's network name. They
  must change **only** by the exact lines Task 3.6 names — never reformat, never touch another
  app's service block, and never touch anything under `expense-tax-management/`. Never merge all of
  `dev` into `main` (would also release unrelated expense-tax-management phases) — AGENTS.md.

- [ ] **Step 2: VPS onboarding (operator, one time, before the first deploy that includes this
  phase).**

  1. Confirm `infrastructure/vps/apps/ai-trading-desk.conf`'s `POSTGRES_IMAGE` value
     (`pgvector/pgvector:pg17`) matches the shared cluster's **actual** current image — re-check
     against `infrastructure/vps/apps/expense-tax-management.conf`'s live value or
     `docker inspect` the running `postgres` container on the VPS; if they disagree, the operator
     updates `ai-trading-desk.conf` to match the live value before the next step, never the other
     way around.
  2. Run `infrastructure/vps/bootstrap.sh --app infrastructure/vps/apps/ai-trading-desk.conf`
     (or the equivalent `--only postgres`-scoped re-run per the VPS README's "Adding a new app"
     section) against the real VPS. This generates `DESK_MIGRATOR_DB_PASSWORD`/
     `DESK_RUNTIME_DB_PASSWORD` into `${SHARED_PG_DIR}/.env` (root-only, mode 0600) if not already
     present, creates database `ai_trading_desk_db`, and runs `zz-20-desk-roles.sh` against it.
  3. Fetch those two passwords once (`bootstrap.sh --fetch-secrets-to`, or `ssh ... cat
     ${SHARED_PG_DIR}/.env`), then delete the local copy.
  4. Set Firestore profile `ai-trading/desk` with, at minimum:
     - `DESK_MIGRATOR_DATABASE_URL` = `postgresql://desk_migrator:<password>@postgres:5432/ai_trading_desk_db`
     - `DESK_RUNTIME_DATABASE_URL` = `postgresql://desk_runtime:<password>@postgres:5432/ai_trading_desk_db`

     via `python3 common/config/family_config.py set ai-trading/desk DESK_MIGRATOR_DATABASE_URL`
     and the `DESK_RUNTIME_DATABASE_URL` equivalent — never print or log the value while setting
     it.
  5. Optionally also set `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`/`SLACK_WEBHOOK_URL_OWNER`/
     `SLACK_WEBHOOK_URL_SPOUSE` in the same profile whenever the owner is ready to wire those
     channels in (Decision 7) — `api/app.py`'s `_build_channels` picks them up automatically on
     the next deploy's restart, no code change needed.
  6. Run the one-off Alembic migration against `DESK_MIGRATOR_DATABASE_URL` before the first
     `api`/`scheduler` deploy (the compose services connect as `desk_runtime`, which cannot
     CREATE/DROP): `DATABASE_URL="$DESK_MIGRATOR_DATABASE_URL" uv run alembic upgrade head` from
     `packages/family-desk/backend/` on a host that can reach the VPS's Postgres (or via an
     operator one-shot container using the built `ai-trading-desk` image).

**Decision 15 is approved — no backup confirmation step needed.** Approved by the owner,
2026-10-12: the Desk database rides in the existing combined backup archive (`backup.sh` dumps
every cluster database into one archive per host). No separate prefix. No confirmation pending.
`ai_trading_desk_db`'s dump is named individually as `dumps/ai_trading_desk_db.dump` inside that
one shared `family-app-backup.service` archive — nothing further to build or sign off on here.

- [ ] **Step 3: Restore drill (operator, before relying on backups for this data).** Confirm
  `infrastructure/backup/restore.sh` (or its documented manual procedure) can restore
  `ai_trading_desk_db` specifically out of the shared archive's `manifest.json`, into a scratch
  database, and that `alembic current` on the restored copy reports `0002` — proving the restore
  path actually recovers a *usable* Desk database, not just bytes. Record the drill's outcome in
  the deploy handoff; this does not gate the first deploy (the cluster's existing backup pipeline
  already covers the database the moment it exists), but it must happen before the Desk is trusted
  with real strategies/alerts.

- [ ] **Step 4: First live verification.** After the release lands on `main` and `deploy.sh` runs
  against the real VPS (Decision 5's app-controls registration is approved and ships in this release —
  see the Decision 5 note above; until it is on `main`, `api`/`scheduler` are not started by a real deploy
  at all):

  1. `health-check.sh` reports `api`/`scheduler` healthy (its dynamic `SERVICES` list includes both
     once Decision 5's catalog change has landed).
  2. `curl -fsS https://<the Caddy host>:8080/api/desk/strategies` (unauthenticated) returns `401`
     — proving the gateway's `forward_auth` actually gates the new route in production, not just in
     the offline Caddy check.
  3. From inside the VPS network (or via an authenticated path once Phase 4's UI exists), confirm
     `GET /healthz` returns 200 and `{"status": "ok"}` — proving the real `SELECT 1` against the
     real `ai_trading_desk_db` succeeds through the real `desk_runtime` role and its `search_path`.
  4. Confirm `scheduler`'s container logs show at least one `run_due` cycle completing without
     raising (watch for the first `premarket_0830`/`refresh_15m` slot after deploy, whichever comes
     first).
  5. Confirm the shared `family-app-postgres` cluster itself is reachable and unaffected (no other
     app's container reports new health failures after this deploy).

  Only after all five are confirmed does this phase count as complete, per AGENTS.md's standing
  delivery authorization ("monitor `health-check.sh` and confirm `api`/`scheduler` report healthy,
  and that the shared `family-app-postgres` cluster is reachable, before declaring the phase
  complete").

---

## Integration notes for later phases

These modules are complete and tested in isolation; the phases that actually build on them still
have work to do.

**Phase 4 (the Desk web UI):**
- Consumes every `/api/desk/*` route this phase built: `watchlists`, `strategies` (including the
  stage machine and the auto-promote behavior, Decision 11), `signals`, `alerts` (the inbox),
  `settings` (quiet hours, channel preferences), and the SSE `quotes` stream (Decision 12's
  identity requirement applies to it like every other route).
- Calls `engine.cardback.compute_card_back` directly for the watchlist flip-card UI (Decision 13's
  "summary" bias + Classic pivots) — no new table or endpoint needed, the function is already
  pure and ready to call from a route this phase would add.
- If the Desk ever needs a user-facing on/off switch in the hub's `/settings` page, that is new
  scope on top of Decision 5 (approved and shipped: `api`/`scheduler` simply always run, like
  `market-data`) — would need a new `apps["desk"]` catalog entry and `_REQUIRED_APP_IDS`
  update, not a correction to this phase.
- `trading.tobytran.dev` moves from `web:3000` to the Desk's own frontend here (AGENTS.md
  hostnames); the Cloudflare Tunnel ingress rule for `/api/desk/*` that D-b deliberately deferred
  also needs to exist before this route is publicly reachable.

**Phase 5 (IV, consensus, Desk AI):**
- Adds `iv_daily`/`consensus_snapshots`/`earnings_results`/`analyst_targets` (Phase 2a's D3 ruling
  — "a table arrives with the phase that first needs it") and the daily consensus-EPS snapshot job
  this phase's brief originally sketched for `daily_close` but which the explicit table list moved
  out (PROTO-BRIEF.md §9's resolved contradiction). `jobs.daily_close.run` is the natural place to
  add this job's own call, once those tables exist — it already runs once per day at the fixed
  16:30 ET slot this phase pins (Decision 3).
- Gets `ai_trading.core.valuation`'s fundamentals mapping and ex-dividend dates (Phase 2a's own
  integration notes, carried forward unchanged — this phase added no new work here).

**Phase 6 (paper orders):**
- Reuses the outbox's recorded `data_quality` on every `signals` row to enforce "degraded
  strategies alert but place no paper orders" — this phase recorded the label; Phase 6 is the one
  that reads it back and gates on it.
- Adds `order_intents`/`fills` tables and the code that writes them; `engine.outbox.record_signal`
  never wrote one (confirmed by `test_no_order_intents_table_exists_for_a_paper_order_spec`), so
  there is nothing to migrate or reconcile.
- If Decision 9 (watchdog/relogin_reminder never write a `deliveries` row) is revisited before
  this phase, do it then — extending both jobs to fan out per-channel deliveries is small and
  additive, not a blocker for this phase's own paper-order work.

**The restore drill (Task 3.8, Step 3):** keep re-running it after any future phase adds a new
table to the Desk's schema — the drill proves `alembic current` on the restored copy reports the
*latest* revision at the time of the drill, not just `0002`.
</content>
