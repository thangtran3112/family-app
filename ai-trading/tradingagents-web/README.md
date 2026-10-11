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
- `requirements.lock` — hash-pinned, `--no-deps` additions this wrapper needs
  on top of the upstream `trading-agents` environment (`starlette`,
  `uvicorn`, `click`).
- `tests/test_store.py` — ownership/persistence/race/input-validation tests
  (`unittest`, real SQLite via `TemporaryDirectory`, no mocks).
- `tests/test_reports.py` — real (non-mocked) exporter/export tests: hostile
  report text, readiness/visibility, traversal/symlink/oversized-file guards,
  publish atomicity/failure handling, and legacy import dedupe/safety.

## Running the tests

```sh
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=tradingagents-web \
  python -m unittest discover -s tradingagents-web/tests -p 'test_*.py' -v
```

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
