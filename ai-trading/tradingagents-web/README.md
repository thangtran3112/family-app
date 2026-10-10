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
  idempotent de-duplicated legacy imports.
- `requirements.lock` — hash-pinned, `--no-deps` additions this wrapper needs
  on top of the upstream `trading-agents` environment (`starlette`,
  `uvicorn`, `click`).
- `tests/test_store.py` — ownership/persistence/race/input-validation tests
  (`unittest`, real SQLite via `TemporaryDirectory`, no mocks).

## Running the tests

```sh
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=tradingagents-web \
  python -m unittest discover -s tradingagents-web/tests -p 'test_store.py' -v
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
