# Desk browser E2E

Playwright against the real backend, seeded with disposable data, through `proxy.mjs` (the static export plus an
`/api` proxy that installs the E2E identity for one reserved cookie). Nothing here talks to a provider, a broker or
the public Desk.

| Project | Viewport | Specs |
|---|---|---|
| `chromium` | 1080 x 800 | the first specs (`*.spec.ts` here), on the `legacy` seed, driving the mobile shell |
| `desktop-1440` | 1440 x 900 | `desk/*.spec.ts`, one per board family (02m §d5), on the `technical` seeds |
| `desktop-1180` | 1180 x 820 | the same specs: right rail as a drawer, columns dropped by priority |

Every `desk/` spec imports `test` from `desk/helpers.ts`, whose automatic fixture fails a spec that ends on a screen
showing the 02l §c3 banned wording (`BANNED_TERMS`, the same list `lib/desk/freshness.ts` tests) or any order control
or order request.

## Run

```sh
pnpm install --frozen-lockfile && pnpm build          # the suite serves ./out
pnpm test:e2e                                         # everything, against a throwaway Postgres (needs Docker)
pnpm test:e2e:desktop                                 # only the two desktop projects
bash ../backend/scripts/e2e.sh --browser -- --project=desktop-1180 e2e/desk/alerts.spec.ts   # one spec
```

Without Docker, point `DESK_E2E_ADMIN_DATABASE_URL` at a loopback Postgres maintenance database and run
`uv run python tests/e2e/run.py [--browser -- <playwright args>]` in `../backend` (CI does exactly this). Each run
creates and drops its own `desk_e2e_<hex>` database. Ports default to 18044 (API) and 18045 (proxy); set
`DESK_E2E_API_PORT` and `DESK_E2E_PROXY_PORT` to run several suites side by side, and `--output=<dir>` so they do
not share `test-results`. First use on a machine: `pnpm exec playwright install chromium`.

## The seeded worlds (`../backend/tests/e2e/`)

- `legacy`: invented NVDA and /ES bars for the first specs.
- `technical`: the Run 0 snapshot moved onto the frozen clock (Thu 2026-10-15 20:00 ET, market closed): bars for SPY,
  NVDA and MSFT, 53 symbols of metrics, ten screener runs, her watchlists, filters and five **draft** strategies.
- `technical-alerts`: the same after four NVDA fires: four strategies `alert_only`, three unread alerts, one delivery
  log row of each kind.

`prepareDesk(context, seed)` resets the database and the clock. `setScenario(context, { now, feedAgeMinutes })` moves
the server's frozen clock and the feeds' last good update for an open session, a stale feed or the pre-market; pass the
same `now` to `openDesk`. The alert runtime flag stays off, so `Turn on` answers with "Alerts start when live quotes are
connected" and nothing here can send a message.
