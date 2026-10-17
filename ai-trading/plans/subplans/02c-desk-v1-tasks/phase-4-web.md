# Phase 4: Desk Web and Hostnames

Part of [02c-desk-v1-implementation-plan.md](../02c-desk-v1-implementation-plan.md). Read its Global Constraints, Review Focus, and Shared Interfaces first. Builds on [Phase 3](phase-3-runtime-and-alerts.md), which is live in production: the Desk API runs, and Caddy already routes `/api/desk/*` behind the Clerk gate.

**Status: defaults approved 2026-10-16; implementation in progress.** All eight defaults below are approved. IBKR remains blocked while waiting for the data user; this phase requires no broker login. Paths are from the repository root.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Subagents work in a `.worktrees/` worktree on their own `feature/*` branch; the main session merges that branch into `feature/toby` (root `AGENTS.md`).

**Goal:** the Family Desk web app at `trading.tobytran.dev`. It is a static Next.js 16 export with every tab from the Paper mockups. Screens whose data exists are wired to the Phase 3 API, and the rest are labelled fixtures. The phase also adds a browser smoke test and the hostname cut-over from the interim hub at `web:3000`.

**Architecture:**
- **Frontend** (`ai-trading/packages/family-desk/frontend`): a static export (`output: "export"`). It mirrors the hub toolchain in `ai-trading/frontend`: the same Next, React, and Tailwind pins, pnpm, the Node 24 test runner, and the same `static-server.mjs`. Browser tests use Playwright, which is new to this package.
- **Hosting:** a GCS bucket holds the export. A Cloudflare Worker, `desk-router`, mirrors `hub-router.js`. `/api/desk/*` goes to the origin hostname the hub Worker already uses (`hub_origin_hostname`, the tunnel to the Caddy gateway). Everything else is served statically from GCS.
- **Gate (unchanged):** Caddy's `handle /api/desk/*` runs `forward_auth auth:8181` (Clerk verification), strips any client-sent `Cf-Access-Authenticated-User-Email`, then calls `reverse_proxy api:8000`.
- **Sign-in:** the Desk bundle does not load Clerk (decision 1). A 401 from the API sends the browser to the hub login, `https://trading-hub.tobytran.dev/login?returnTo=<desk URL>`, the same redirect the terminals use (01l).
- **Types:** API types are generated from FastAPI's OpenAPI document. Strategy specs are validated with `StrategySpecV1Schema` from `@ai-trading/contracts`.
- **Backend:** six read routes are added (Task 3). No write routes beyond Phase 3's.

**Tech stack:** TypeScript, Next.js 16.3.8, React 19.2.8, Tailwind CSS v4, lucide-react, `@fontsource-variable/inter`, `lightweight-charts` (decision 2), `openapi-typescript`, Zod, Playwright. Backend: Python, FastAPI, SQLAlchemy, uv project `ai-trading-desk`. Hosting: Cloudflare Worker (JavaScript) and Terraform (Cloudflare provider v5, Google Cloud Storage).

**Spec:** [02a](../02a-desk-v1-strategies-design.md) §4.5–4.6 (templates, editing), §5 (runtime), §7 (data), §8 (hosts and tabs), §10 (security), §13 (testing), §16 (mockup index). Also [02f](../02f-desk-indicators-and-ai-daily-design.md) §2 (technical card back), [02g](../02g-desk-covered-calls-and-futures-swing-design.md) §§2–4 (screens, covered calls, futures swing), and [02h](../02h-desk-research-tools-design.md) §2 (backtests; fixtures only). Visual source: Paper file "TobyTest", page "Family Desk · R2 mockups". For exact values use the Paper tools (`get_jsx`, `get_computed_styles`), never values read off a screenshot.

## Owner decisions

All eight defaults approved by the owner on 2026-10-16.

| # | Question | Default | Alternative |
|---|---|---|---|
| 1 | Load Clerk in the Desk bundle? | No. The Caddy gate protects the API, and a 401 redirects to the hub login. The bundle has no Clerk key. | Embed `@clerk/react` as the hub does. Adds the public publishable key to the Desk build. |
| 2 | Charting library | `lightweight-charts` (Apache-2.0). Overlays are copied from Vibe-Trading's `frontend/src/lib/indicators.ts` (MIT, with attribution). | Hand-drawn SVG. No dependency, more work for candlesticks. |
| 3 | Interim route on `trading.tobytran.dev` | Removed in the same apply as the Worker route (Task 12). The `web` container keeps running until a later cleanup. | Keep the interim route until a fixed date. |
| 4 | Hub registry card | Add a Desk card to the hub's `/apps/*` registry. It is a small additive edit to an open-source-lane file, so it needs your approval. | Skip it. Link the Desk from bookmarks. |
| 5 | Off switch, daily cap, paper guard checks | Fixtures until Phase 6. No runtime switch exists, and adding one changes the Phase 3 scheduler. | Add a family-wide pause flag now, read by the scheduler. |
| 6 | Browser tests in CI | Playwright against the real Desk API (uvicorn on a Postgres 17 service), behind a test proxy that sets the verified identity header as Caddy does. The real Caddy gate stays in `ai-trading/deploy/ci/smoke-test.sh`. | Browser tests against production only. No signal before merge. |
| 7 | API types | Generated from FastAPI's OpenAPI document. CI fails on drift. | Hand-written types, which drift silently. |
| 8 | Static shell visibility | Public. The shell holds no data, and every `/api/desk/*` call is gated. The hub works the same way. | Gate the shell too. Needs auth in the Worker. |

## Constraints

From the master plan's Global Constraints, the ones that bind the UI:
- Every number shows its data-quality label: `realtime`, `delayed-15m`, `eod`, `fallback`, or `unavailable`.
- Stages shown are `draft`, `alert_only`, and `paper`. `live_confirm` and `live_auto` are never offered (v1 has no live code).
- The frontend has no order-placing code and no `/orders` client.
- Mockups and fixtures use invented numbers only. No real balances, positions, emails, or account IDs in the repo or the bundle.
- The frontend imports only `@ai-trading/contracts` from inside the Desk package, and nothing from other packages.
- Upstream code is copied with attribution. Only `indicators.ts` is copied, and its source commit goes in `THIRD_PARTY_NOTICES.md`.
- The Desk bundle holds no secrets. Single-line commit messages, no trailers. One pull request to `dev` for the whole phase.

## Review Focus

These are the failures a person would hit first. Each has a test in the task that owns the code.

1. **Fixture data never looks live.** Every fixture screen shows its banner, and fixture data has no `quality` field. (Task 4)
2. **The UI cannot place or request a live order.** Live is shown disabled, and there is no order client. (Task 7)
3. **Saving creates a version and changes what the strategy alerts on.** The builder says so before saving and never edits a stored version in place. (Task 7)
4. **Stale or fallback numbers show their label.** A `fallback` or `delayed-15m` price displays that label beside the number. A real 0 renders as 0, and a missing value renders as "not available". (Tasks 5, 8)
5. **A malformed API response fails loudly.** Calls that render numbers pass a Zod schema, and a mismatch throws. (Task 2)
6. **Sessions neither loop nor leak.** A 401 redirects once. A quote stream closes on unmount, and each symbol has at most one. (Tasks 2, 5)
7. **Identity cannot be forged from the browser.** The client sends no identity header. Caddy strips one the browser sends, checked against real Caddy in `smoke-test.sh`. (Task 11)
8. **Mobile reaches every tab.** At 390 px wide, More holds Watchlists, Holdings, and Settings, and nothing needs hover. (Tasks 2, 11)

---

## Interfaces (fixed for this phase)

Routes. A static export cannot pre-render unknown IDs, so there are no dynamic segments; detail views take a query string.

| Route | Screen | Mockups |
|---|---|---|
| `/` | Today | D1, M3, M2 |
| `/strategies` | List. `?id=N` opens the detail and builder. | D2 |
| `/strategies/new` | Templates | D8 |
| `/watchlists` | Watchlists and flip cards | D4, D9, M5, M7 |
| `/technicals?symbol=` | Technicals | D10 |
| `/futures` and `/futures/specs` | Futures swing; specs and roll calendar | D15, D16, M10 |
| `/settings` | Settings (on mobile, under More) | D7 |
| `/more` | Mobile More: navigation and the off-switch fixture | M6 |
| `/paper`, `/holdings`, `/ask`, `/covered-calls`, `/stocks?symbol=`, `/backtests?id=` | Fixtures (Task 4) | D3, D5, D6, D11–D14, D17–D19, M8, M9, M11 |

Tabs (`02a` §8). Desktop: Today, Strategies, Paper, Ask, Watchlists, Holdings. Mobile: Today, Strategies, Paper, Ask, More.

Frontend modules:
- `lib/labels.ts`: `type Quality = "realtime" | "delayed-15m" | "eod" | "fallback" | "unavailable"` and `qualityLabel(q: Quality): string`.
- `lib/api/client.ts`: `deskFetch<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T>`. It throws `DeskApiError` with `kind` of `"http"`, `"unauthenticated"`, or `"malformed"`. On a 401 it redirects once to `hubLoginUrl(location.href)`.
- `lib/api/schemas.ts`: Zod schemas for every response a screen renders.
- `lib/api/openapi.d.ts`: generated from FastAPI's OpenAPI document (Task 2).
- `lib/auth.ts`: `hubLoginUrl(returnTo: string): string`.
- `lib/stream.ts`: `openQuoteStream(symbol: string, onQuote: (q: Quote) => void): () => void`. Reference-counted per symbol.
- `lib/spec/describe.ts`: `describeSpec(spec: StrategySpecV1): string`.
- `lib/spec/form.ts`: `specToForm(spec)` and `formToSpec(form)`, which round-trip.
- `lib/strategy/stage.ts`: `stageOptions(implementedPhase: number)`.
- `lib/settings/schema.ts`: Zod schema for the settings object.
- `lib/fixtures/*.ts`: invented data for the fixture screens. No `quality` key appears anywhere in this folder.
- `components/FixtureScreen.tsx` and `fixtureBannerText(phase: number): string`, which returns `Fixture — wired in Phase N`.

Backend routes added in Task 3. All but `/healthz` require the verified identity:

| Route | Returns |
|---|---|
| `GET /api/desk/me` | `{email}`. 401 without the verified header. |
| `GET /api/desk/bars/{symbol}` (query: `interval` of `1d`, `1h`, `5m`, or `1m`; `days`) | `{symbol, interval, quality, as_of, bars: [{t, o, h, l, c, v}]}` |
| `GET /api/desk/technicals/{symbol}` | `{symbol, quality, as_of, gauges, moving_averages, oscillators, pivots, rsi, macd, card_back}` |
| `GET /api/desk/futures/specs` | 12 contracts: `{root, mini, micro, multiplier, tick_size, session, roll_dates, approx_margin, margin_as_of}` |
| `GET /api/desk/status` | `{gateway, data_sources, streaming_slots: {used, max}, backups, reconciliation}` |
| `GET /api/desk/watchlists/{id}/items` | `[{symbol, asset_type, backfill}]`, where `backfill` is `ready` or `pending` |

Phase 3 routes used unchanged:
- `GET /api/desk/strategies`; `POST /api/desk/strategies` with `{name}`.
- `GET` and `POST /api/desk/strategies/{id}/versions`. `POST` takes `{spec, change_note?}`.
- `PUT /api/desk/strategies/{id}/stage` with `{stage, confirm}`.
- `GET /api/desk/watchlists`; `POST /api/desk/watchlists` with `{name, horizon}`, where horizon is `intraday`, `swing`, or `long_term`.
- `POST /api/desk/watchlists/{id}/items` with `{symbol, asset_type}`; `DELETE /api/desk/watchlists/{id}/items/{symbol}`.
- `GET /api/desk/signals?symbol=&limit=&offset=`.
- `GET /api/desk/alerts`; `POST /api/desk/alerts/{id}/read`.
- `GET` and `PUT /api/desk/settings` with `{settings: {...}}`. Quiet hours live at `settings.quiet_hours` as `{start, end}`, read by `ai_trading.notify.dispatch`.
- `GET /api/desk/quotes/{symbol}` is an SSE stream of `quote` events. Each event carries `quality`.

---

## Task 1: Scaffold the Desk web app and its CI job

**Files**
- Create `ai-trading/packages/family-desk/frontend/` by copying these from `ai-trading/frontend/` and changing names and paths only: `package.json` (name `@ai-trading/desk-web`), `pnpm-lock.yaml` (regenerated), `next.config.ts`, `postcss.config.mjs`, `tsconfig.json`, `eslint.config.mjs`, `static-server.mjs`, `static-server.test.mjs`, `export-layout.test.mjs`.
- Create `app/layout.tsx` and `app/page.tsx` (a placeholder), and `lib/labels.ts` with `lib/labels.test.ts`.
- Modify `.github/workflows/ai-trading-ci.yml`: add a `Desk web app` job.

Link `@ai-trading/contracts` with `"link:../contracts"` in `package.json`. Install the contracts package's dependencies with `pnpm --dir ../contracts install --frozen-lockfile` before the frontend install (also in CI). Do not change the contracts package or its lockfile. Execution correction: `file:` hardlinks its TypeScript export under `node_modules`, which native Node type stripping refuses; a real package import test must cover this integration.

**Steps**
- [ ] **Step 1: Write the failing export test.** Copy `export-layout.test.mjs` and point it at `out/`. It asserts that `out/index.html` and `out/_next/` exist. Run it: it fails, because nothing is built yet.
- [ ] **Step 2: Write the failing label test.** `lib/labels.test.ts` asserts that `qualityLabel` returns exactly the five strings of `Quality`. Run it: it fails, because the function is missing.
- [ ] **Step 3: Scaffold.** Create the files above. The `package.json` scripts are `dev`, `build`, `start`, `lint`, `typecheck`, `test` (`node --test "lib/**/*.test.ts" "*.test.mjs"`), `gen:api` (Task 2), and `test:e2e` (Task 11). Run `pnpm install`.
- [ ] **Step 4: Run the tests.** `pnpm test` and `pnpm build` pass, and `out/index.html` exists.
- [ ] **Step 5: Add the CI job.** `Desk web app` runs `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, and `../../../deploy/ci/check-static-export.sh out`.
- [ ] **Step 6: Commit.**

**Acceptance:** from `ai-trading/packages/family-desk/frontend`, `pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm test && pnpm build && ../../../deploy/ci/check-static-export.sh out` passes. The `Desk web app` job is green.

Produces: the package, the test setup, and the CI job that every later task extends.

---

## Task 2: Shell, design tokens, API client, sign-in redirect, OpenAPI types

**Files**
- Create `components/shell/Shell.tsx`, `components/shell/DesktopNav.tsx`, and `components/shell/MobileTabs.tsx` (Today, Strategies, Paper, Ask, More).
- Create `app/globals.css` with the tokens read from Paper artboards D1 and D2 (`get_computed_styles`). Inter comes from `@fontsource-variable/inter`. Amber `#FFB020` is the single accent, for live, alert, and paper state. Green and red appear only for price direction.
- Create `lib/api/client.ts`, `lib/api/client.test.ts`, `lib/api/schemas.ts`, `lib/auth.ts`, and `lib/auth.test.ts`.
- Create `ai-trading/packages/family-desk/backend/src/ai_trading/api/openapi_dump.py`, which prints `app.openapi()` as sorted JSON.
- Create `scripts/gen-api.sh`, which runs `openapi_dump` in the backend and writes `lib/api/openapi.json` and `lib/api/openapi.d.ts` (through `openapi-typescript`).
- Modify the `Desk web app` job: after `pnpm test`, run `pnpm gen:api` and `git diff --exit-code -- lib/api`. The job installs uv, as the `desk` backend job does, so the dump can run.

**Steps**
- [ ] **Step 1: Write the failing auth test.** `hubLoginUrl("https://trading.tobytran.dev/")` equals `https://trading-hub.tobytran.dev/login?returnTo=https%3A%2F%2Ftrading.tobytran.dev%2F`.
- [ ] **Step 2: Write the failing client tests.** Inject `fetch` and `location`. (a) A 401 sets `location.href` once, to `hubLoginUrl(current)`, and throws `DeskApiError` with `kind: "unauthenticated"`. (b) A 200 whose body fails the schema throws with `kind: "malformed"`. (c) A 503 throws with `kind: "http"` and the status.
- [ ] **Step 3: Implement** the client, the auth helper, the shell, the tokens, and the OpenAPI dump. Generate the types.
- [ ] **Step 4: Check the shell.** At 1280 px the desktop nav shows six tabs. At 390 px the bottom bar shows five, and More opens links to Watchlists, Holdings, and Settings. Task 11's `mobile.spec.ts` covers this in a browser.
- [ ] **Step 5: Commit.**

**Acceptance:** `pnpm test`, `pnpm build`, and `pnpm gen:api && git diff --exit-code -- lib/api` pass.

Produces: `deskFetch`, `DeskApiError`, `hubLoginUrl`, the shell components, and `lib/api/openapi.d.ts`.

---

## Task 3: Backend read routes the screens need

**Files**
- Create `ai-trading/packages/family-desk/backend/src/ai_trading/api/bars.py`, `technicals.py`, `futures.py`, `status.py`, and `me.py`.
- Modify `ai-trading/packages/family-desk/backend/src/ai_trading/api/watchlists.py`: add `GET /{watchlist_id}/items`.
- Modify `ai-trading/packages/family-desk/backend/src/ai_trading/api/app.py`: include the new routers.
- Create tests under `ai-trading/packages/family-desk/backend/tests/api/`.

**Behaviour**
- `me` returns `{email}` from the verified header. No header gives 401. There is no default user.
- `bars` reads through `DataSources` (Phase 2a). The response carries the provider's quality label unchanged, so `fallback` stays `fallback`. No bars gives `quality: "unavailable"` and an empty list. A bar is never fabricated. A bad `interval` gives 422.
- `technicals` runs the pure functions in `ai_trading.core` over the bars: `indicators` (Phase 1), and `bias` and `pivots` (Phase 1c). `card_back` is the return value of `ai_trading.engine.cardback.compute_card_back`, unchanged.
- `futures/specs` gives the 12 contracts from `ai_trading.core.futures` (Phase 1c). `approx_margin` and `margin_as_of` come from the source named in `02g` §2 (D16 shows approximate margins with their source and date). With no source, both are `null`. Never guess.
- `status`: `gateway` is `"not_configured"` until Phase 2b, and it never reports `up`. `streaming_slots.used` is 0 while there are no IBKR subscriptions, and `max` is 70 (`02a` §7). Browser SSE connections are not broker subscriptions and must not be counted as slots. `backups` and `reconciliation` are `null` until a feed exists.
- `watchlists/{id}/items` is owner-scoped and returns 404 for other owners, as Phase 3 does. `backfill` is `ready` when the symbol has daily bars, and `pending` otherwise. It is derived, with no new column.

**Steps**
- [ ] **Step 1: Write the failing tests** (pytest, a fake `DataSources`, no network): `test_me_requires_verified_header`; `test_bars_unavailable_is_empty_not_fabricated`; `test_bars_keeps_fallback_label`; `test_card_back_is_engine_output` (equal to `compute_card_back` on the same bars); `test_futures_margin_null_without_source`; `test_status_never_reports_gateway_up`; `test_watchlist_items_backfill_derived_from_bars`; `test_openapi_has_every_desk_route` (every route in the Interfaces table appears in the document).
- [ ] **Step 2: Run them.** They fail.
- [ ] **Step 3: Implement** the routes and the watchlist items route.
- [ ] **Step 4: Run the tests.** They pass.
- [ ] **Step 5: Regenerate the frontend types** (`pnpm gen:api`) and commit them with the routes.

**Acceptance:** `cd ai-trading/packages/family-desk/backend && uv run ruff check . && uv run pytest -q` passes. `cd ai-trading/packages/family-desk/frontend && pnpm gen:api && git diff --exit-code -- lib/api` passes.

Consumes: `DataSources` (2a), `ai_trading.core.*` (1, 1c), and `compute_card_back` (3). Produces: the six routes above, typed in `lib/api/openapi.d.ts`.

---

## Task 4: Fixture screens for every tab that waits for a later phase

**Files**
- Create `components/FixtureScreen.tsx`, which wraps its children with the banner. Its props are `phase` and `title`.
- Create `lib/fixtures/paper.ts`, `holdings.ts`, `ask.ts`, `covered-calls.ts`, `stocks.ts` (the long-term view, the Desk AI verdict, the track record, valuation, and timeline), and `backtests.ts`.
- Create `app/paper/page.tsx` (D3, Phase 6), `app/holdings/page.tsx` (D5, Phase 5), `app/ask/page.tsx` (D6, Phase 7), `app/covered-calls/page.tsx` (D13, D14, M9; Phase 5), `app/stocks/page.tsx` (D11, D12, D18, D19, M8, M11; Phase 5), and `app/backtests/page.tsx` (D17; Phase 6b).

**Behaviour**
- Each screen renders inside `FixtureScreen`, which shows `fixtureBannerText(phase)`.
- Fixture numbers are invented. Fixture data has no `quality` key, and the screen makes no `/api/desk` request.
- The Desk read on Today (D1) is a fixture too, in Task 5, until Phase 5.

**Steps**
- [ ] **Step 1: Write the failing tests.** `lib/fixtures/fixtures.test.ts` walks every fixture export and asserts that no key is named `quality`. A `FixtureScreen` test asserts that `fixtureBannerText(6) === "Fixture — wired in Phase 6"`.
- [ ] **Step 2: Run them.** They fail.
- [ ] **Step 3: Implement** the fixtures and the six routes. Export each layout from its Paper artboard with `get_jsx`.
- [ ] **Step 4: Run the tests.** They pass.
- [ ] **Step 5: Commit.**

**Acceptance:** `pnpm test && pnpm build` passes. Task 11's `fixtures.spec.ts` checks the banner and the absence of API calls on each route.

---

## Task 5: Today

**Files**
- Replace `app/page.tsx`.
- Create `components/today/Watchlist.tsx` (rows: symbol, price, change, label, today's signal count), `components/today/PriceChart.tsx`, `components/today/SignalFeed.tsx` (`GET /api/desk/signals?limit=50`), `components/today/AlertsPanel.tsx` (`GET /api/desk/alerts`, with mark-read), `components/today/DeskRead.tsx` (a fixture until Phase 5), and `components/Labeled.tsx`.
- Create `lib/stream.ts` and `lib/stream.test.ts`.
- Create `lib/indicators.ts` as a copy of the submodule's `frontend/src/lib/indicators.ts` at the commit the superproject pins, with its header kept. Record the source path and commit in `ai-trading/packages/family-desk/THIRD_PARTY_NOTICES.md`. Create `lib/indicators.test.ts`.

**Behaviour**
- `Labeled` renders a value with its label. A `null` value renders as "not available", never as 0.
- `PriceChart` loads `GET /api/desk/bars/{symbol}`, and its overlays come from `lib/indicators.ts`. The chart header shows the quality and the as-of time.
- The paper position overlay (entry, stop, target) is a Phase 6 fixture. It is drawn dashed and labelled as a fixture.
- Quotes come from `openQuoteStream`: one `EventSource` per symbol, however many components subscribe.

**Steps**
- [ ] **Step 1: Write the failing tests.** `stream.test.ts`: two subscribers open one `EventSource`; the last unsubscribe closes it; an error reconnects with backoff of 1 s, 2 s, and 4 s, capped at 30 s; unmounting closes the stream. `indicators.test.ts`: golden SMA and RSI values on a fixed series, so a corrupted copy fails.
- [ ] **Step 2: Run them.** They fail.
- [ ] **Step 3: Implement.** Copy `indicators.ts` first, then the components.
- [ ] **Step 4: Run the tests.** They pass.
- [ ] **Step 5: Commit.**

**Acceptance:** `pnpm test && pnpm build` passes. Task 11's `today.spec.ts` covers the rendered screen.

Consumes: `GET /api/desk/quotes/{symbol}` (SSE), `bars`, `signals`, and `alerts`.

---

## Task 6: Strategies list, templates, new from a template

**Files**
- Create `app/strategies/page.tsx` (the list; the detail view is Task 7), `components/strategies/StrategyList.tsx` (columns: name, stage, current version, and a 30-day paper P&L column that is a Phase 6 fixture), `components/strategies/TemplateCard.tsx`, and `app/strategies/new/page.tsx`.
- Create `lib/templates.ts`, which imports the eleven JSON files currently in `ai-trading/packages/family-desk/contracts/templates/`, and `lib/spec/describe.ts` with its test. The approved design said ten; the shipped contracts include the technical-bias template too. Include every shipped template rather than hiding one to match an outdated count.

**Behaviour**
- Eleven cards, one per shipped template, each showing `describeSpec(template)`.
- A watchlist picker, fed by `GET /api/desk/watchlists`.
- A stage choice. Only `draft` is enabled in this phase. "Alert + paper" is shown disabled, as "available in Phase 6".
- "Use this template" runs `POST /api/desk/strategies` with `{name}`, then `POST /api/desk/strategies/{id}/versions` with `{spec, change_note: "from template <slug>"}`, then opens `/strategies?id={id}`.
- Phase 3 has no delete route. If the version call fails, the strategy exists with no version. The list marks such strategies "no version" and offers "Add version", so no orphan goes unnoticed.

**Steps**
- [ ] **Step 1: Write the failing tests.** `templates.test.ts`: every shipped template parses with `StrategySpecV1Schema` from `@ai-trading/contracts`, and the manifest matches the eleven JSON files on disk. `describe.test.ts`: golden sentences for `vwap-reclaim` and `gap-and-go`, and no empty result.
- [ ] **Step 2: Run them.** They fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests.** They pass.
- [ ] **Step 5: Commit.**

**Acceptance:** `pnpm test && pnpm build` passes. Task 11's `strategy-flow.spec.ts` covers the flow.

Produces: `describeSpec`. Consumes: `StrategySpecV1Schema` and the Phase 3 strategy and watchlist routes.

---

## Task 7: Builder, versions, JSON view, stage control

**Files**
- Extend `app/strategies/page.tsx` to handle `?id=`.
- Create `components/builder/SpecForm.tsx` (the Watch, When, Then, and Limits blocks), `components/builder/VersionList.tsx`, `components/builder/JsonView.tsx` (read-only), `components/builder/StageControl.tsx`, and `components/builder/SaveBar.tsx` (the unsaved-change bar).
- Create `lib/spec/form.ts` and `lib/spec/form.test.ts`, and `lib/strategy/stage.ts` and `lib/strategy/stage.test.ts`.

**Behaviour**
- Validation: `StrategySpecV1Schema.safeParse(formToSpec(form))` drives the inline errors for each block. Save is disabled while the form is invalid.
- Save is `POST /api/desk/strategies/{id}/versions`, never `PUT`. If the stage is not `draft`, the bar says: "Saving makes version N the one this strategy alerts on."
- Leaving with unsaved edits asks first, both in-app and on `beforeunload`.
- The version history comes from `GET .../versions`. A selected version is read-only, and "View JSON" shows exactly what is stored.
- `stageOptions(4)` returns `draft` and `alert_only` enabled, `paper` disabled as "Phase 6", and `Live` as the text "Not in v1" with no control. A stage change calls `PUT /api/desk/strategies/{id}/stage` with `{stage, confirm: true}`, and only after the confirm dialog.

**Steps**
- [ ] **Step 1: Write the failing tests.** `form.test.ts`: `formToSpec(specToForm(s))` deep-equals `s` for every shipped template, and an invalid form reports error paths that name the block. `stage.test.ts`: the options never include `live_confirm` or `live_auto`, and `paper` is disabled below Phase 6. A source test asserts that no file under `lib/api/` or `app/` contains `/orders`.
- [ ] **Step 2: Run them.** They fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests.** They pass.
- [ ] **Step 5: Commit.**

**Acceptance:** `pnpm test && pnpm build` passes. Task 11's `strategy-flow.spec.ts` checks that a save adds version 2 and leaves version 1's JSON unchanged.

---

## Task 8: Watchlists, flip cards, streaming slots

**Files**
- Create `app/watchlists/page.tsx`, `components/watchlists/WatchlistTable.tsx` (horizon tags for intraday, swing, and long-term; rows with a labelled price, today's signal count, and the strategies that watch the list), `components/watchlists/AddSymbol.tsx`, `components/watchlists/FlipCard.tsx`, and `components/watchlists/SlotMeter.tsx`.
- Create `lib/watchlists/cardBack.ts` and `cardBack.test.ts`, and `lib/watchlists/slots.ts` and `slots.test.ts`.

**Behaviour**
- "Used by" comes from each strategy's current version: `spec.watch.universe.watchlist` must equal the list's name.
- `AddSymbol` posts to `POST /api/desk/watchlists/{id}/items`. A `pending` item shows "backfilling".
- The flip card's front shows the price, its label, and the signal. The back shows `card_back` from `GET /api/desk/technicals/{symbol}`.
- The watchlist and the flip cards share one stream per symbol, through `openQuoteStream`.
- `SlotMeter` shows `slotsText({used, max})` from `GET /api/desk/status`. Nothing is hard-coded.
- Mobile M5 and M7 use the same components in one column.

**Steps**
- [ ] **Step 1: Write the failing tests.** `cardBack.test.ts`: a missing field renders "not available", and a real 0 renders "0". `slots.test.ts`: `slotsText({used: 41, max: 70}) === "41 of 70"`.
- [ ] **Step 2: Run them.** They fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests.** They pass.
- [ ] **Step 5: Commit.**

**Acceptance:** `pnpm test && pnpm build` passes. Task 11's `flip-card.spec.ts` covers the flip.

---

## Task 9: Technicals, futures specs, futures swing

**Files**
- Create `app/technicals/page.tsx`, `components/technicals/Gauges.tsx`, `components/technicals/RsiMacdChart.tsx` (`lightweight-charts`), and `components/technicals/IndicatorTables.tsx` (oscillators, moving averages, pivots).
- Create `app/futures/page.tsx` (pair chips, bias gauges, and weekly levels; positions, roll warnings, and the weekend card are Phase 6 fixtures) and `app/futures/specs/page.tsx` (D16: the specs table, mini and micro equivalence, the roll timeline, and session hours).
- Create `lib/futures/specs.ts` and `lib/futures/specs.test.ts`.

**Behaviour**
- The gauge labels come from the backend's `gauges`, which use `ai_trading.core.bias`. The frontend does not reimplement thresholds.
- Each block shows its quality label.
- `marginText(approx, asOf)` returns "not available" when `approx` is null. Otherwise it returns a string such as `≈ $1,234 (as of 2026-10-01)`.
- Broker availability on the pair chips is a Phase 6 fixture, and it says "no broker connected yet".

**Steps**
- [ ] **Step 1: Write the failing tests.** `specs.test.ts`: `marginText(null, null) === "not available"`, and `marginText(1234, "2026-10-01") === "≈ $1,234 (as of 2026-10-01)"`.
- [ ] **Step 2: Run them.** They fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests.** They pass.
- [ ] **Step 5: Commit.**

**Acceptance:** `pnpm test && pnpm build` passes. Task 11's `technicals.spec.ts` covers the Technicals screen.

---

## Task 10: Settings and More

**Files**
- Create `app/settings/page.tsx`, `components/settings/Channels.tsx` (Telegram and Slack toggles; quiet hours `start` and `end`), `components/settings/SourcesStatus.tsx` (from `GET /api/desk/status`: gateway state, and data sources with their labels), and `components/settings/Fixtures.tsx`.
- Create `lib/settings/schema.ts` and `lib/settings/schema.test.ts`.
- Create `app/more/page.tsx`: the off-switch fixture row first, then links to Watchlists, Holdings, and Settings (M6).

**Behaviour**
- It loads with `GET /api/desk/settings` and saves with `PUT /api/desk/settings`. The save sends the whole object, so the screen merges its keys into the loaded object and keys it does not own survive.
- Quiet hours use `HH:MM` in 24-hour time. The notify module reads `settings.quiet_hours` with `start` and `end`.
- Fixtures: the off switch, the daily cap, and the paper guard checks (Phase 6), and the Ask budget (Phase 7). Backups and reconciliation show "no feed yet" while `status.backups` and `status.reconciliation` are `null`.

**Steps**
- [ ] **Step 1: Write the failing tests.** `schema.test.ts`: `25:00` is rejected, `22:00` and `07:30` pass, and a merge keeps keys the screen does not own.
- [ ] **Step 2: Run them.** They fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests.** They pass.
- [ ] **Step 5: Commit.**

**Acceptance:** `pnpm test && pnpm build` passes. Task 11's `settings.spec.ts` checks that quiet hours persist.

---

## Task 11: Browser smoke test and CI end-to-end job

**Files**
- Create `ai-trading/packages/family-desk/frontend/playwright.config.ts`.
- Create `e2e/proxy.mjs`. It serves `out/` and forwards `/api/desk/*` to uvicorn. It strips any browser-sent `Cf-Access-Authenticated-User-Email`, then sets `e2e@example.test` only when the request carries the test cookie `desk_e2e_session=1`. This stands in for Caddy's gate. The real gate is checked by `smoke-test.sh`.
- Create `e2e/today.spec.ts`, `strategy-flow.spec.ts`, `flip-card.spec.ts`, `technicals.spec.ts`, `settings.spec.ts`, `fixtures.spec.ts`, `mobile.spec.ts`, and `auth.spec.ts`.
- Create `ai-trading/packages/family-desk/backend/tests/e2e/seed.py`. It seeds the e2e user and invented daily and intraday bars for NVDA and ES.
- Modify `ai-trading/deploy/ci/smoke-test.sh`: add a Desk section. Against the real Caddy on the test stack, `GET /api/desk/strategies` with no session returns 401, and with a forged `Cf-Access-Authenticated-User-Email` it still returns 401.
- Modify the CI workflow: add a `Desk e2e` job.

**Flows**
- `today.spec.ts`: the watchlist rows show labels, the chart canvas renders, and the signal feed renders.
- `strategy-flow.spec.ts`: Today → Strategies → New from template (`vwap-reclaim`) → save → one engine tick (`ai_trading.engine.tick`, Phase 3) over the seeded bars → the alert appears in AlertsPanel. The alert must come from the engine tick, not from the test. The test also saves a second version and checks that version 1's JSON is unchanged.
- `flip-card.spec.ts`: flip NVDA, and the back shows technicals with a label.
- `technicals.spec.ts`: the gauges and the three tables render.
- `settings.spec.ts`: quiet hours persist after a reload.
- `fixtures.spec.ts`: each fixture route shows the banner and makes no `/api/desk` request.
- `mobile.spec.ts`: at 390×844, More reaches Watchlists, Holdings, and Settings.
- `auth.spec.ts`: without the test cookie, the API returns 401, and the app redirects to the hub login with `returnTo` set. The redirect is intercepted, not followed.

**CI job `Desk e2e`:** use a Postgres 17 service container. Run `uv run alembic upgrade head` with the migrator URL, then `uv run python tests/e2e/seed.py`. Start `uv run python -m uvicorn ai_trading.api.main:app --port 8000`. Use `python -m uvicorn`, never bare `uvicorn`, which is the Phase 3 hotfix. Then run `pnpm build`, `pnpm exec playwright install --with-deps chromium`, and `pnpm exec playwright test`.

**Steps**
- [ ] **Step 1: Write the specs and the proxy first.** Run them: they fail until the screens exist.
- [ ] **Step 2: Implement the seed and the CI job.**
- [ ] **Step 3: Run the suite until it is green.**
- [ ] **Step 4: Add the smoke-test section.** Run `docker buildx bake -f ai-trading/deploy/docker-bake.hcl --load` from the repository root, then `ai-trading/deploy/ci/smoke-test.sh all`. AGENTS requires this after API changes.
- [ ] **Step 5: Commit.**

**Acceptance:** `pnpm exec playwright test` passes locally and in the `Desk e2e` job, and `smoke-test.sh all` passes.

---

## Task 12: Hosting, hostname cut-over, and live verification (owner-gated)

**Files**
- Create `infrastructure/gcp/ai-trading/desk-bucket.tf`, mirroring `hub-bucket.tf`: the export bucket, readable the way the hub's bucket is.
- Create `infrastructure/cloudflare/ai-trading/worker/desk-router.js` and `desk-router.test.js`. The router mirrors `hub-router.js`, except that its only dynamic path is `/api/desk/`. Everything else is served statically from GCS, with the same security headers and the same 404 fallback. It must not bind `trading-hub.tobytran.dev`.
- Create `infrastructure/cloudflare/ai-trading/desk-static.tf`, mirroring `hub-static.tf`: the Worker script, the route `trading.tobytran.dev/*`, and bindings for the bucket and for `ORIGIN_HOSTNAME` (the same `hub_origin_hostname` value, so the Desk reaches the same Caddy origin).
- Modify `infrastructure/cloudflare/ai-trading/main.tf`: delete every tunnel ingress entry whose hostname is `var.hub_hostname` (`trading.tobytran.dev`). That is the two `/u/*` entries, the `/__auth/*` entry, and the catch-all to `web:3000`. Then delete `hub_hostname` from `variables.tf` if nothing else references it (grep first), and update the README.
- Modify `.github/workflows/ai-trading-deploy.yml`: add the input `upload_desk_static` (boolean). It runs `ai-trading/deploy/ci/upload-hub-static.sh <export-dir> <desk-bucket>`, which already takes the bucket as an argument.
- Modify the hub registry in `ai-trading/frontend` only if decision 4 is approved.

**Procedure**
1. Open one pull request to `dev` for Tasks 1–12, with CI green, and merge it.
2. Release to `main` with this phase's paths only: `ai-trading/packages/family-desk/**`, `ai-trading/deploy/**`, `ai-trading/frontend/**` (the registry card only, if decision 4 is approved), `infrastructure/cloudflare/ai-trading/**`, `infrastructure/gcp/ai-trading/**`, and `.github/workflows/ai-trading-deploy.yml`. Build the release commit from `origin/main`, the way the rollback release was built.
3. The release deploys the API with the Task 3 routes. Confirm that the deploy succeeded and that `last-good-tag` moved.
4. Run the Terraform plans (`CLOUDSDK_ACTIVE_CONFIG_NAME=personal` for GCP). You review the output, and then the bucket and the Worker script are applied. **Do not** apply the `trading.tobytran.dev/*` route yet.
5. Run `gh workflow run ai-trading-deploy.yml --ref main -f upload_desk_static=true`. Confirm that `index.html`, `strategies.html`, and `404.html` are in the bucket.
6. Apply the route and the ingress removal together. This is the cut-over.
7. Live checks. All must pass:
   - `https://trading.tobytran.dev/` returns 200 as HTML with the security headers.
   - `https://trading.tobytran.dev/strategies` returns 200.
   - `https://trading.tobytran.dev/api/desk/strategies` returns 401 with no session.
   - The same call with a forged `Cf-Access-Authenticated-User-Email` returns 401.
   - Signed out, the app redirects to the hub login with `returnTo` set to the Desk URL, and the hub login accepts that `returnTo`. You check this in a browser.
   - In a signed-in browser, Today shows labelled prices.
8. Rollback: revert the Terraform commit and apply it. The ingress entries and the interim hub come back. The bucket can stay.

**Acceptance:** `node --test infrastructure/cloudflare/ai-trading/worker/*.test.js` passes. `docker run --rm -v "$PWD":/w -w /w/infrastructure/cloudflare/ai-trading hashicorp/terraform:latest validate` passes after `init -backend=false`, and the same for `infrastructure/gcp/ai-trading`. The step 7 results are recorded in this file.

---

## Done

When Tasks 1–12 are merged and the step 7 checks pass, check off this file's steps with the date and the live results, then change the Phase 4 row in the master plan to "Done (date)". Do neither before then.
