# tradingagents-web

A small wrapper around the `trading-agents` upstream package that exposes a
private-by-default, owner-scoped research history. New source here is
wrapper-only — nothing in `packages/trading-agents` is ever modified.

## Layout

- `ta_web/domain.py` — `Inputs` (validated request), `Run` (persisted record
  shape), `owner_key`, `public_view`, and the `NotFoundError`/`BusyError`
  domain exceptions. Validation reuses upstream's `normalize_symbol`,
  `safe_ticker_component`, `AssetType`, `AnalystType`, and
  `filter_analysts_for_asset_type` rather than re-implementing them.
- `ta_web/store.py` — `Store`, a SQLite-backed, owner-scoped persistence
  layer. One running record system-wide (`409 Busy` on a second concurrent
  admission), private-by-default visibility, explicit per-owner sharing, and
  idempotent de-duplicated legacy imports. `Store.research_dir` is the one
  directory (`root/research`) reports/import may write run artifacts under.
- `ta_web/reports.py` — safe report preview/publish/download. Reuses
  upstream's own exporter (`tradingagents.reporting.write_report_tree`,
  `tradingagents.report_html.render_report`) rather than re-implementing
  rendering, so the same CommonMark-with-raw-HTML/images-disabled escaping
  and page CSP apply. `publish` writes a run's `exports` once to a staged
  directory, fsyncs it, and `os.replace`s it in atomically before marking
  `artifacts_ready` — a second `publish` call is a no-op (exports are
  immutable). `download` only serves allowlisted regular files (no-follow,
  resolved-ancestry-checked, 32 MiB bound) and never globs. `ReportError`
  carries one of the fixed codes (`REPORT_NOT_READY`/409,
  `REPORT_INVALID_FORMAT`/422, `REPORT_TOO_LARGE`/413, `EXPORT_FAILED`/503).
- `ta_web/import_reports.py` — operator-only legacy import (never HTTP).
  Accepts an explicit, already-opaque owner key (the hex shape `owner_key`
  produces) and a recognized Markdown layout — a consolidated
  `complete_report.md`, or surviving per-section CLI report files (labeled
  `partial` when there's no consolidated report). Ownership/completion are
  never inferred from folder name or mtime. Content is fingerprinted (ordered
  relative names + bytes, excluding old HTML — never trusted/copied forward)
  for per-owner dedupe; old HTML is never reused, only regenerated from the
  Markdown with raw HTML/images disabled, a CSP, and an escaped title. The
  source folder is only ever read.

  ```sh
  PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=tradingagents-web \
    python -m ta_web.import_reports --root <research-root> \
      --owner-id <opaque-owner-key> --source <legacy-folder>
  ```

  Prints only the new/existing run id and its status/partial flag — never
  identity, report text, or provider configuration.
- `ta_web/worker.py` — `run_research(root, id, graph_factory=None)`: the
  isolated research subprocess entry point. Builds a per-run, per-owner
  config (isolated `results_dir`/`data_cache_dir`/`memory_log_path`) around
  upstream's unmodified `TradingAgentsGraph`, persists only `clean_state`/
  `safe_settings` as it streams, and never raises on a publish failure.
- `ta_web/runner.py` — `Runner(root)`: launches `worker.py` as a real
  subprocess (`[sys.executable, '-m', 'ta_web.worker', ...]`, never a
  shell), one at a time, with a race-proof start/close handshake.
- `ta_web/app.py` — `create_app(root, start=None)` / `application`: the
  guarded Starlette HTTP API (identity/Origin/prefix enforcement, the
  `/api/research*` routes, and the `/research`/`/research/{id}` shell routes
  that serve `ta_web/static/`).
- `ta_web/static/index.html`, `ta_web/static/app.mjs`, `ta_web/static/app.css`
  — the framework-free UI: dashboard (pagination plus ticker/analysis-date/
  status history filters), new-research form, and detail/share/download view.
- `requirements.lock` — hash-pinned, `--no-deps` additions this wrapper needs
  on top of the upstream `trading-agents` environment (`starlette`,
  `uvicorn`, `click`).
- `tests/test_store.py` — ownership/persistence/race/input-validation tests
  (`unittest`, real SQLite via `TemporaryDirectory`, no mocks).
- `tests/test_reports.py` — real (non-mocked) exporter/export tests: hostile
  report text, readiness/visibility, traversal/symlink/oversized-file guards,
  publish atomicity/failure handling, and legacy import dedupe/safety.
- `tests/test_runner.py` — `Runner`'s real-subprocess start/close lifecycle,
  including the start-vs-close race proof.
- `tests/test_api.py` — `IsolatedAsyncioTestCase` + HTTPX ASGI transport,
  real `create_app`; guard/body-validation/sharing/download/list-filter
  contract, and the production lifespan (service lock, restart recovery,
  real child subprocess).
- `tests/test_ui.mjs` — Node `node:test`; `app.mjs`'s prefix-safe
  route helpers, progress freshness, safe failure messages, and read-retry
  classification (no DOM, no mocked backend).
- `tests/test_progress.py` — real SQLite heartbeat/progress separation,
  additive/concurrent database upgrades, and a worker heartbeat while the
  graph waits, including heartbeat-thread cleanup.
- `tests/check_progress_browser.mjs` — opt-in offline browser regression:
  actual UI assets with synthetic HTTP fixtures, connection recovery,
  malformed-response handling, authorization-loss clearing, focus,
  reduced motion, and mobile/prefix behavior. Reuses an installed
  `playwright-core`; it adds no application dependency or live provider call.

## Running the service

```sh
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=tradingagents-web \
  python -m uvicorn ta_web.app:application --host 0.0.0.0 --port 8182
```

`application` builds its `Store`/service lock/`Runner` lazily inside the
ASGI lifespan — importing `ta_web.app` alone never touches the filesystem or
a database. The production image runs the same command (no `--reload`); see
`ai-trading/deploy/production/README.md`'s "Research (06)" section and
`ai-trading/deploy/local/README.md` for the actual deployed/local routes
(behind the gateway's identity/prefix headers — this module trusts, never
re-derives, caller identity).

## Running the tests

```sh
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=tradingagents-web \
  python -m unittest discover -s tradingagents-web/tests -p 'test_*.py' -v
node --test tradingagents-web/tests/test_ui.mjs
```

For the optional DOM check, point to an existing Playwright installation and
an isolated test browser (never the owner's personal Chrome profile):

```sh
PLAYWRIGHT_CORE_PATH=/path/to/playwright-core/index.mjs \
PLAYWRIGHT_CHROME_EXECUTABLE=/path/to/test-browser \
  node tradingagents-web/tests/check_progress_browser.mjs
```

## Live progress and connection handling

- The isolated worker records `heartbeat_at` every **5 seconds**, including
  while a model or tool request waits. This confirms worker liveness, not
  forward progress. The heartbeat stops when the worker finishes.
- `last_progress_at` changes only for completed research/tool steps, stage/output activity,
  and completion. Message-only steps update the timestamp, never store their
  raw messages. Heartbeats and sharing changes do not advance it.
- `ended_at` records completion/failure/interruption once, so elapsed research
  time stops even if sharing changes later. Historical end times stay unknown
  rather than being guessed from a later metadata update.
- The authenticated UI keeps its existing **3-second status polling** and
  shows stage, elapsed time, last research activity, and heartbeat age. It
  uses the response's HTTP Date to avoid misleading laptop-clock skew.
- A heartbeat delayed by **20 seconds** produces an unconfirmed-liveness
  warning. **3 minutes without new research activity** produces a slow/stall
  warning even if the heartbeat remains fresh. Neither warning changes the
  saved run status, terminates the worker, or automatically reruns research.
- Active, healthy work has a Hermes-inspired moving rainbow border. Slow,
  disconnected, or terminal states stop the animation. Reduced-motion users
  get a static border and no animated native progress bar.
- Read requests time out after **10 seconds**. Transient network/service or
  malformed-response failures retain the last authorized snapshot, warn,
  and retry reads. Authorization loss/revocation clears private content.
  Mutations are never automatically retried; a timed-out submission warns
  the user to check history before repeating an action.
- Failures/interruption show fixed, helpful explanations and preserve any
  saved analysis. A research error is shown immediately while partial reports
  are prepared; the task remains processing until publication finishes, so
  polling cannot stop just before its downloads become ready. The border is
  static warning-colored during this error-finalization stage. No provider exception, raw tool log, or credential is
  streamed to the browser. Old records migrate additively and keep unknown
  monitoring timestamps as null rather than inventing historical activity.

## Data model notes

- `Store(root)` creates its SQLite index beneath `root/research/index.db`.
  Paths are built only from the given root — never from ticker or other
  client-supplied strings.
- `owner_key(identity)` is the only way an external identity becomes a
  storage key: a SHA-256 hex digest of the normalized identity. Callers
  resolve the verified identity (e.g. family auth) *before* calling the
  store; `Store` itself only ever sees opaque owner keys.
- A single partial unique index (`one_running`) enforces at most one
  `status='running'` row across all owners at a time; a second concurrent
  `create()` raises `BusyError` instead of queueing.
- `get_visible`/`get_owned` both raise the same `NotFoundError` for an
  absent id, a malformed id, or a private row owned by someone else — the
  caller can't distinguish "doesn't exist" from "not yours" or "malformed".
- `public_view(run, viewer)` returns only the protocol's public record
  fields plus `can_share`/`can_rerun`; it never includes `owner_id`,
  `fingerprint`, or filesystem paths.
- `add_import`/`discard_import` are for the operator-driven legacy import
  path only (Task 2), never reachable from HTTP. Imports de-duplicate per
  `(owner, fingerprint)`; `discard_import` only removes this owner's own
  not-yet-published (`artifacts_ready=0`) import row.
