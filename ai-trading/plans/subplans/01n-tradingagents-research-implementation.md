# TradingAgents Research Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do not implement before owner reviews this written plan and selects execution method.

**Goal:** Give family users durable private research, permanent research URLs, client downloads, and explicitly shared read-only links.

**Architecture:** A maintained web extension imports the unmodified TradingAgents engine and exporter. A small internal web service owns SQLite records and access checks; a separate subprocess runs each admitted research. Existing Clerk/Caddy authentication and `ta-data` persistence remain authoritative.

**Tech Stack:** Python 3.13, Starlette 1.7.0, Uvicorn 0.54.0, Click 8.5.0, upstream-installed Pydantic and HTTPX, stdlib SQLite/subprocess/unittest, plain HTML/CSS/JavaScript, Node 24 native tests, existing Docker Bake/Caddy/Compose.

**Spec:** `ai-trading/plans/subplans/01n-tradingagents-research-design.md` (owner approved 2026-10-10).

## Global Constraints

- Keep `packages/trading-agents` unmodified at its approved upstream pin. Never install editable packages, generate bytecode, or write build/test artifacts there.
- Work on `feature/tradingagents-research` in owner-approved `.worktrees/tradingagents-research`; do not switch the shared main checkout from `feature/toby`.
- Private-by-default history; owner-only sharing changes; authenticated family readers may view/download only explicitly shared research. No anonymous/public shares.
- Accepted requests get a UUID before model execution; repeated ticker/date never overwrites earlier research.
- One active research subprocess initially; `409` Busy instead of queueing. Restart means Interrupted, not an automatic model rerun.
- Per-user memory and per-run results/checkpoints. No raw tool messages, internal logs, credentials, or config files in responses/archives.
- JSON bodies limited to 16 KiB; research depths 1 through 5; history defaults to 25 records and caps at 100.
- Spec's ticker boundary is at most 64 characters; upstream imposes 32 on canonical symbols. Reject upstream-incompatible length before admission; UI uses effective 32-character maximum.
- Preserve server-configured rounds when depth omitted; explicit depth sets both debate/risk rounds. Provider/model/endpoints remain server-controlled.
- Keep legacy terminal reachable. No DNS/new-hostname provisioning or Family Desk changes. Preserve prefix-safe app links.
- Secrets/env values only through environment or `common/config/family_config.py`. No repo env files, identity/secret logs, keys in browser, or provider keys through CI.
- Keep MiroFish in current state; no global Docker prune. Stage only exact owned paths. One meaningful phase PR, not task/spec-only PRs.
- Add `ponytail:` comment for known single-worker/archive-memory ceilings and upgrade triggers, not speculative abstraction.
- Dependency additions are hash-pinned, installed without dependency upgrades, and checked against upstream-installed versions.

## Review Focus

1. First rollout adds image absent from previous release: rollback must restore prior Compose/Caddy/health configuration before pulling previous tag. Task 6 regression exercises old release without research service.
2. Shared link arrives after sign-out, including hub prefix: family login must return to exact research, and revoked link must fail every fresh read. Tasks 4/6 test redirect path and access rechecks.
3. Unknown legacy provenance or repeated import: preserve unknown metadata, retain originals, deduplicate identical content per owner, and create new ID for changed content. Task 2 tests each case.
4. Two simultaneous starts, worker launch failure, or API restart: admit one process, record failures/interruption, avoid orphan worker and duplicate automatic calls. Tasks 1/3 test races and lifecycle.
5. Navigation while polling, clipboard failure, crypto analysts, or hostile report content: never show previous run as current, falsely say Copied, accept incompatible analysts, or execute model HTML. Tasks 1/2/5 include checks.

---

## File map and boundaries

All paths below are repository-root-relative. Keep code in one extension package, `ai-trading/tradingagents-web/ta_web/`:

| File | Responsibility |
|---|---|
| `domain.py` | Validated inputs, opaque identity, public record shape, safe domain errors |
| `store.py` | SQLite schema, transactions, ownership/sharing, lifecycle and snapshots |
| `reports.py` | Upstream rendering, immutable export publication, safe downloads/import |
| `import_reports.py` | Local operator command delegating to report importer |
| `worker.py` | Upstream research execution in isolated child process |
| `runner.py` | Child launch/reaping/termination; no research in HTTP process |
| `app.py` | ASGI app, request guards, HTTP endpoints and static shell |
| `static/index.html`, `static/app.mjs`, `static/app.css` | Accessible dashboard/detail UI and prefix-safe navigation |
| `requirements.lock`, `README.md`, `DIVERGENCE.md` | Pinned additions, running/importing, upstream compatibility |

Tests live in `ai-trading/tradingagents-web/tests/` using unittest and Node's native runner. Do not add ORM, React app, task broker, test framework, generic repository interface, or provider configuration UI.

### Setup/baseline (fold into Task 1)

Run from repository root after plan approval. Preserve these environment paths in task notes; shell variables do not survive separate tool calls automatically.

```sh
export TA_SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/ta-research.XXXXXX")"
mkdir -p "$TA_SCRATCH/upstream"
git -C ai-trading/packages/trading-agents archive HEAD | tar -xf - -C "$TA_SCRATCH/upstream"
python3.13 -m venv "$TA_SCRATCH/venv"
"$TA_SCRATCH/venv/bin/python" -m pip install "$TA_SCRATCH/upstream[dev]"
PYTHONDONTWRITEBYTECODE=1 "$TA_SCRATCH/venv/bin/python" -m pytest "$TA_SCRATCH/upstream/tests" -q -m 'not integration'
```

Baseline failure is not caused by new code: report it and obtain direction before implementation. No live/provider integration test in this baseline. Install the wrapper lock only after it exists; use `--no-deps --require-hashes` and `pip check`. Native tests use `PYTHONPATH=ai-trading/tradingagents-web` and the external venv interpreter. Set `PYTHONDONTWRITEBYTECODE=1` throughout.

## Task 1: Durable owner-scoped records and validated inputs

**Files:** Create `ta_web/__init__.py`, `ta_web/domain.py`, `ta_web/store.py`, `requirements.lock`, `tests/test_store.py`, and initial `README.md` under extension root.

**Interfaces:**

- `Inputs(BaseModel)`: `ticker: str`, `analysis_date: str`, `asset_type: Literal['stock','crypto']`, `analysts: list[str]`, `research_depth: int | None`.
- `Run(TypedDict)`: `id`, `owner_id`, `inputs`, `origin`, `status`, `stage`, `created_at`, `updated_at`, `shared`, `state`, `settings`, `artifacts_ready`, `partial`, `fingerprint`, `error_code`. Inputs/state/settings are JSON-safe dictionaries; legacy inputs may contain explicit null metadata.
- `owner_key(identity: str) -> str`: normalized verified identity to SHA-256 hex; empty/oversized identity refused without echoing it.
- `BusyError`, `NotFoundError`: safe domain exceptions without resource/identity details.
- `public_view(run: Run, viewer: str) -> dict`: fixed public fields plus `can_share`/`can_rerun`; no other owner's key or private filesystem fields.
- `Store(root: Path)` creates index beneath new research subtree; methods below are concrete, not an abstract interface.
- `create(owner: str, inputs: Inputs) -> Run`; `get_visible(id: str, viewer: str) -> Run`; `get_owned(id: str, owner: str) -> Run`; `worker_run(id: str) -> Run` (internal/operator only).
- `list_owned(owner, *, limit=25, offset=0, ticker=None, analysis_date=None, status=None) -> list[Run]`; `set_shared(id, owner, enabled: bool) -> Run`.
- `update(id, *, status=None, stage=None, state=None, settings=None, artifacts_ready=None, partial=None, error_code=None) -> None`: fixed allowed update columns, never owner/sharing supplied by worker.
- `mark_interrupted() -> list[str]` returns interrupted IDs for artifact recovery.
- `add_import(owner, fingerprint, inputs: dict, state: dict, settings: dict, partial: bool) -> tuple[Run, bool]`: record plus whether newly created; unique per owner/content; called by Task 2, not HTTP.
- `discard_import(id, owner) -> None`: operator-internal cleanup restricted to this owner's unpublished import; never delete an existing ready import or ordinary research.

- [ ] **Step 1: Write failing ownership/persistence/race test.** Use unittest's `TemporaryDirectory`, two opaque fixture identities (not email literals), and real SQLite.

```python
def test_private_persistent_unique_and_shared(self):
    owner, reader = owner_key('owner-one'), owner_key('owner-two')
    inputs = Inputs(ticker='SPY', analysis_date='2026-10-09',
                    asset_type='stock', analysts=['market'], research_depth=1)
    first = self.store.create(owner, inputs)
    with self.assertRaises(NotFoundError):
        self.store.get_visible(first['id'], reader)
    self.store.update(first['id'], status='completed')
    second = self.store.create(owner, inputs)
    self.assertNotEqual(first['id'], second['id'])
    self.assertEqual(Store(self.root).get_owned(first['id'], owner)['id'], first['id'])
    self.store.set_shared(first['id'], owner, True)
    self.assertEqual(self.store.get_visible(first['id'], reader)['id'], first['id'])
    self.assertEqual(self.store.list_owned(reader), [])
    with self.assertRaises(NotFoundError):
        self.store.set_shared(first['id'], reader, False)
    self.store.set_shared(first['id'], owner, False)
    with self.assertRaises(NotFoundError):
        self.store.get_visible(first['id'], reader)
```

Add `test_admission_race`: two independent Store connections start in a `ThreadPoolExecutor`/barrier; exactly one succeeds and one raises BusyError. Add input tests: future/noncanonical date; empty/unknown analysts; crypto+fundamentals; bool/string depth; depth 0/6; 33-character canonical symbol; dot-only/path ticker; `GC=F`, `^GSPC`, `0700.HK`, and normalized crypto symbols. Assert invalid requests allocate no row.

- [ ] **Step 2: Run RED.** `PYTHONPATH=ai-trading/tradingagents-web "$TA_SCRATCH/venv/bin/python" -m unittest discover -s ai-trading/tradingagents-web/tests -p test_store.py -v`. Expected import/undefined implementation failure, not missing third-party setup.
- [ ] **Step 3: Implement concrete model/store.** Pydantic `ConfigDict(extra='forbid')`; strict numeric depth; parse exact ISO date before future comparison. Reuse upstream `normalize_symbol`, `safe_ticker_component`, `AssetType`, and analyst compatibility helper. Canonical analyst order is market/social/news/fundamentals; duplicates deduplicate.

```python
def owner_key(identity: str) -> str:
    value = identity.strip().lower()
    if not value or len(value) > 1024:
        raise ValueError('INVALID_IDENTITY')
    return hashlib.sha256(value.encode()).hexdigest()

# SQLite: parameterized values; BEGIN IMMEDIATE around admission.
ACTIVE_INDEX = "CREATE UNIQUE INDEX IF NOT EXISTS one_running ON runs((1)) WHERE status='running'"
IMPORT_INDEX = "CREATE UNIQUE INDEX IF NOT EXISTS imported_content ON runs(owner_id,fingerprint) WHERE fingerprint IS NOT NULL"
READ_QUERY = "SELECT * FROM runs WHERE id=? AND (owner_id=? OR shared=1)"
OWNER_QUERY = "SELECT * FROM runs WHERE id=? AND owner_id=?"
```

Schema includes every Run field, timestamps in UTC, JSON dictionaries, `shared=0`, and a check on status values. Short connection-per-operation transactions; WAL/busy timeout; UUID4 canonical validation for IDs. `get_visible`/`get_owned` raise same NotFoundError on absent/unavailable IDs. Row limit/offset and filters are validated, then bound SQL parameters. Build paths from DB owner and UUID, never ticker or client path.

Create lock additions exactly:

```text
starlette==1.7.0 --hash=sha256:67f8e99895493dd2911a03f11314af6ceebeae4e704bb9f43dfc6a9db151c93e
uvicorn==0.54.0 --hash=sha256:505bdb0f318731d45f1f712071fc781a8981f6847a31c902c9f5e652d4f67faf
click==8.5.0 --hash=sha256:255bc9599cf7748b4b1a446ccc735421bd08a2ae529a8b88597d3de5664ee360
```

These are universal wheels verified from PyPI metadata during planning. No extras/telemetry framework. The inspected local upstream 0.6.0 image already contains Pydantic 2.14.0, AnyIO 4.15.1, HTTPX 0.28.1, and h11 0.16.0, but not these three additions. Recheck fresh base metadata at build time; this local inspection does not prove future upstream compatibility.

- [ ] **Step 4: Run GREEN and inspect DB/privacy.** Repeat test command, `pip check`, and assert no API-safe serialization includes filesystem paths, private owner key for shared readers, or credentials.
- [ ] **Step 5: Commit exact Task 1 files.** `git status --short --branch`; stage only extension files named above; `git diff --cached --check`; `git commit -m "feat(ai-trading): persist private research records"`. No push/PR yet.

## Task 2: Safe report exports and assigned legacy import

**Files:** Create `ta_web/reports.py`, `ta_web/import_reports.py`, `tests/test_reports.py`; extend README with import command.

**Interfaces:** `clean_state(state: dict) -> dict` is the one fixed report-field/subfield allowlist shared with worker; `preview(run: Run) -> str`; `publish(store: Store, id: str) -> None`; `download(store, id, viewer, format) -> tuple[bytes, str, str]` (bytes, MIME, filename); `import_folder(store, source: Path, owner_id: str) -> Run`. `ReportError(code: str)` accepts only fixed error codes mapped to statuses: REPORT_NOT_READY=409, REPORT_INVALID_FORMAT=422, REPORT_TOO_LARGE=413, EXPORT_FAILED=503.

- [ ] **Step 1: Write failing real-renderer/export test.** Use existing upstream exporter, not mocked successful HTML.

```python
def test_download_and_hostile_html(self):
    run = self.store.create(self.owner, self.inputs)
    self.store.update(run['id'], status='completed', partial=False,
        state={'trade_date': self.inputs.analysis_date,
               'market_report': '<script>window.bad=1</script>\n![x](https://invalid.test/x)',
               'final_trade_decision': 'Buy'})
    publish(self.store, run['id'])
    content, mime, name = download(self.store, run['id'], self.owner, 'html')
    self.assertEqual(mime, 'text/html; charset=utf-8')
    self.assertIn(run['id'], name)
    self.assertNotIn(b'<script>', content)
    self.assertNotIn(b'<img', content)
    archive, _, _ = download(self.store, run['id'], self.owner, 'zip')
    with zipfile.ZipFile(io.BytesIO(archive)) as z:
        self.assertIn('complete_report.md', z.namelist())
        self.assertTrue(all(n == 'complete_report.md' or n == 'complete_report.html'
            or (n.endswith('.md') and n.split('/')[0] in
                {'1_analysts','2_research','3_trading','4_risk','5_portfolio'})
            for n in z.namelist()))
```

Also test private reader denial, unavailable export `REPORT_NOT_READY`, fixed-format validation, path/ID traversal, a symlink in allowed artifacts, partial filename labeling, and archive exclusion of injected config/log/checkpoint/memory files.

```python
def test_legacy_assignment_dedupe_and_source_preservation(self):
    source = self.root / 'legacy-input'
    source.mkdir()
    md = source / 'complete_report.md'
    md.write_text('# Imported research\n\nUnknown historical date.', encoding='utf-8')
    old_html = source / 'complete_report.html'
    old_html.write_text('<script>bad()</script>', encoding='utf-8')
    first = import_folder(self.store, source, self.owner)
    self.assertEqual(import_folder(self.store, source, self.owner)['id'], first['id'])
    self.assertIsNone(first['inputs']['analysis_date'])
    self.assertEqual(old_html.read_text(), '<script>bad()</script>')
    html, _, _ = download(self.store, first['id'], self.owner, 'html')
    self.assertNotIn(b'<script>', html)
    with self.assertRaises(NotFoundError):
        self.store.get_visible(first['id'], owner_key('owner-two'))
    md.write_text('# Imported research\n\nChanged content.', encoding='utf-8')
    self.assertNotEqual(import_folder(self.store, source, self.owner)['id'], first['id'])
```

- [ ] **Step 2: Run RED.** `PYTHONPATH=ai-trading/tradingagents-web "$TA_SCRATCH/venv/bin/python" -m unittest discover -s ai-trading/tradingagents-web/tests -p test_reports.py -v`; expected missing report implementation.
- [ ] **Step 3: Implement minimal export pipeline.** Store only allowlisted textual report fields and debate/risk subfields. Use upstream `write_report_tree`; preview uses `render_report(ticker, state, settings, _report_parts(state))`. Treat `_report_parts` as tracked compatibility dependency in DIVERGENCE.

```python
stage = run_directory / f'.exports-{uuid.uuid4()}'
write_report_tree(state, ticker, stage, settings=safe_settings, html=True)
# Add complete ZIP from explicit allowed report files, never rglob('*').
os.replace(stage, run_directory / 'exports')
store.update(run_id, artifacts_ready=True)
```

Each run publishes once to immutable `exports`; metadata is marked ready only after artifact fsync/atomic rename. Downloads are not available while actively running; partial terminal-state reports are explicitly labeled. Open exact allowlisted files with no-follow semantics and verify resolved ancestry; validate every archive input as a regular file. Bounded read/ZIP size is 32 MiB; fail safely with `REPORT_TOO_LARGE` and leave viewable state intact. Explain streaming upgrade ceiling in code.

Importer accepts only explicit operator-assigned owner hex key and recognized Markdown report layout. Consolidated `complete_report.md` or surviving CLI report-section Markdown is sufficient; never infer completion/ownership from folder name/mtime. Recognized per-section content without consolidated report is labeled partial/provenance unknown. Hash ordered relative names and file contents, excluding old HTML; dedupe by owner/fingerprint. Regenerate HTML from Markdown with raw HTML/images disabled, CSP, and escaped titles. Copy to new owned folder, retain source, and use add_import's created flag plus discard_import to roll back only importer-created record/files on failure. No imported record is automatically shared or loaded into agent memory.

CLI: `python -m ta_web.import_reports --root <research-root> --owner-id <opaque-owner-key> --source <legacy-folder>`. Print ID/outcome only; no identity, report text, or provider configuration.

- [ ] **Step 4: Run GREEN.** All store/report tests; inspect ZIP entries and actual HTML CSP. Inject writer/rename failure: no ready metadata or truncated published artifacts; saved state remains available.
- [ ] **Step 5: Commit exact Task 2 files.** Message: `feat(ai-trading): export research reports and import legacy files`.

## Task 3: Isolated upstream execution and crash-safe lifecycle

**Files:** Create `ta_web/worker.py`, `ta_web/runner.py`, `tests/test_runner.py`.

**Interfaces:** `run_research(root: Path, id: str, graph_factory=None) -> None`; `Runner(root: Path)` with `start(id: str) -> None`, `close() -> None`. Production graph factory is lazy-imported TradingAgentsGraph; tests supply fake graph with the same public methods. Runner passes child argv `[sys.executable, '-m', 'ta_web.worker', '--root', str(root), '--run-id', run_id]`, never shell.

- [ ] **Step 1: Write failing isolation/lifecycle test.** Fake graph yields report then final decision; capture its supplied config. Include constructor failure, stream failure with secret sentinel, launch failure, child abnormal exit, and shutdown/interruption.

```python
def test_worker_isolates_paths_and_publishes(self):
    run = self.store.create(self.owner, self.inputs)
    seen = []
    def factory(*args, **kwargs):
        seen.append(kwargs['config'])
        return FakeGraph(*args, **kwargs)
    run_research(self.root, run['id'], graph_factory=factory)
    saved = self.store.worker_run(run['id'])
    self.assertEqual(saved['status'], 'completed')
    self.assertTrue(saved['artifacts_ready'])
    self.assertIn(run['id'], seen[0]['results_dir'])
    self.assertIn(run['id'], seen[0]['data_cache_dir'])
    self.assertIn(self.owner, seen[0]['memory_log_path'])
    self.assertNotIn('provider-secret-sentinel', json.dumps(saved))
```

`FakeGraph` implements constructor, `run_settings`, `create_run_state`, `begin_checkpoint`, `checkpoint_input`, `stream_run`, `record_decision`, `clear_checkpoint_on_success`, `end_checkpoint`, and `propagator.get_graph_args`, matching observed upstream signatures. Its stream includes a nested-analyst report and a full top-level state; assert merge does not discard earlier reports. No fake production research mode.

- [ ] **Step 2: Run RED.** `PYTHONPATH=ai-trading/tradingagents-web "$TA_SCRATCH/venv/bin/python" -m unittest discover -s ai-trading/tradingagents-web/tests -p test_runner.py -v`.
- [ ] **Step 3: Implement worker and process owner.** Deep-copy DEFAULT_CONFIG; run paths `root/users/{owner}/runs/{id}/{results,cache}`; memory `root/users/{owner}/memory/trading_memory.md`. Explicit depth overrides both rounds; omitted keeps environment defaults. No shared personal checkpoint/cache or change to global defaults.

```python
initial = graph.create_run_state(ticker, date, asset_type)
thread_id = graph.begin_checkpoint(ticker, date, asset_type)
args = graph.propagator.get_graph_args()
if thread_id is not None:
    args.setdefault('config', {}).setdefault('configurable', {})['thread_id'] = thread_id
state = dict(initial)
try:
    for _messages, chunk in graph.stream_run(graph.checkpoint_input(initial), **args):
        if chunk:
            state.update(chunk)
            store.update(run_id, state=clean_state(state), stage=research_stage(state))
    graph.record_decision(ticker, date, state)
    graph.clear_checkpoint_on_success(ticker, date, asset_type)
finally:
    graph.end_checkpoint()
```

Import clean_state from Task 2 rather than duplicating its filter. Define `research_stage(state: dict) -> str` in worker; it chooses analyst/research/trading/risk/finished from populated report fields. Persist graph.run_settings through fixed public allowlist. Publish final artifacts before completed status. Exceptions record fixed `RESEARCH_FAILED`/`EXPORT_FAILED` codes without exception text; preserve and export partial snapshot where available.

Runner retains Popen handles, starts children with `start_new_session=True` and stdout/stderr DEVNULL, and reaps each via a daemon wait thread. Unexpected exit while record still running becomes Failed; never leaves Busy permanently occupied. Shutdown marks manager closing, terminates child process group, waits five seconds, kills if needed, reaps, and records Interrupted rather than misclassifying intentional shutdown as failure. No SIGINT-generated replay. Use one service lock (`fcntl.flock`) during API lifespan so a second process sharing volume cannot mark first process's research interrupted.

- [ ] **Step 4: Run GREEN.** All backend tests. Execute real tiny child scripts for abnormal exit/termination checks (no LLM), then recover stored running record with `mark_interrupted` and partial artifact publication; assert research factory was never called during recovery. Insert `ponytail:` single-process ceiling comment.
- [ ] **Step 5: Commit exact Task 3 files.** Message: `feat(ai-trading): execute isolated persistent research`.

## Task 4: Guarded HTTP API, ownership, and binary downloads

**Files:** Create `ta_web/app.py`, `tests/test_api.py`.

**Interfaces:** `create_app(root: Path, start: Callable[[str], None] | None = None) -> Starlette`; `application` is production ASGI object. Test launch callable never crosses into production config. Add Guard ASGI middleware in this file; it delegates routing/parsing to Starlette rather than implementing HTTP.

- [ ] **Step 1: Write failing authenticated HTTP flow.** Use HTTPX 0.28.1 ASGITransport and stdlib IsolatedAsyncioTestCase; manually enter `app.router.lifespan_context(app)` because transport does not trigger lifespan. Do not install new HTTPX2/TestClient dependency.

```python
async def test_explicit_read_only_share(self):
    app = create_app(self.root, start=lambda run_id: None)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                    base_url='https://research.test') as client:
            owner = {'Cf-Access-Authenticated-User-Email': 'owner-one',
                     'Origin': 'https://research.test'}
            reader = {**owner, 'Cf-Access-Authenticated-User-Email': 'owner-two'}
            made = await client.post('/api/research', headers=owner, json=self.body)
            self.assertEqual(made.status_code, 202)
            run_id = made.json()['id']
            url = f'/api/research/{run_id}'
            self.assertEqual((await client.get(url, headers=reader)).status_code, 404)
            self.assertEqual((await client.post(url+'/sharing', headers=owner,
                                              json={'enabled': True})).status_code, 200)
            self.assertEqual((await client.get(url, headers=reader)).status_code, 200)
            self.assertEqual((await client.post(url+'/sharing', headers=reader,
                                              json={'enabled': False})).status_code, 404)
            await client.post(url+'/sharing', headers=owner, json={'enabled': False})
            self.assertEqual((await client.get(url, headers=reader)).status_code, 404)
```

Add same-origin denial (missing/malformed/cross-site Origin), non-JSON body, streamed body over 16 KiB without Content-Length, string boolean sharing, forged body owner/endpoint/key fields, unauthenticated static/API requests, unavailable/ready download headers and actual bytes, shared-reader download/revoke, no-store/no-referrer, prefix URLs, and safe unexpected-storage error without sentinel leakage.

- [ ] **Step 2: Run RED.** `PYTHONPATH=ai-trading/tradingagents-web "$TA_SCRATCH/venv/bin/python" -m unittest discover -s ai-trading/tradingagents-web/tests -p test_api.py -v`.
- [ ] **Step 3: Implement routes/guard.** Exact route table:

```python
routes = [
    Route('/__healthz', health, methods=['GET']),
    Route('/research', shell, methods=['GET']),
    Route('/research/{id}', detail_shell, methods=['GET']),
    Route('/research/assets/{name}', asset, methods=['GET']),
    Route('/api/research', research_list, methods=['GET']),
    Route('/api/research', research_start, methods=['POST']),
    Route('/api/research/{id}/sharing', sharing, methods=['POST']),
    Route('/api/research/{id}/report', report, methods=['GET']),
    Route('/api/research/{id}/download', report_download, methods=['GET']),
    Route('/api/research/{id}', research_detail, methods=['GET']),
]
```

Define each endpoint named here in app.py. List returns `{owner_id, items, limit, offset, today, defaults}` for own account; defaults are a fixed allowlist of provider/model/round names and values from DEFAULT_CONFIG, never the raw config. Today is server ISO date; the form uses it instead of assuming client timezone. Detail omits another owner's ID. Start validates complete body before Store.create, calls start after commit, marks launch failure on same ID, and responds 202 with ID and prefix-relative detail URL. Sharing performs get_owned before parsing mutation, then set_shared. Detail shell checks visibility before HTML response.

Guard every route except internal-only health; missing verified identity -> 401. Unsafe HTTP requests require exact normalized Origin matching gateway-set scheme/Host. Gateway-set `X-Family-App-Prefix` must be either empty or `/u/tradingagents`; never trust arbitrary prefix/authority from browser. For stripped-prefix requests set ASGI root_path and corresponding full path consistently. Add no-store, no-referrer, nosniff, frame/CSP restrictions to success/errors. Bound streamed JSON before decoding; reject non-object JSON and extra fields, never return raw input through validation errors. Health reveals readiness only and is not publicly proxied.

Map domain NotFoundError to uniform 404, BusyError to generic 409, unavailable artifacts to `409 REPORT_NOT_READY`, oversized artifact to safe 413, and validation to safe 422. Never serialize raw upstream exceptions. Starlette's default error machinery may rethrow after a handled 500; outer guard suppresses/logs only sanitized failures, not original secret-bearing exception text. Verify this behavior explicitly.

The test launch callable deliberately leaves a running record but never starts a model. Production always constructs Runner in lifespan. Tests obtain that Starlette app's router for explicit lifespan management; keep Guard in Starlette's middleware list and secure error responses rather than returning an opaque wrapper with no router. Backend unittest classes initialize TemporaryDirectory, root, Store, hashed owner, Inputs, and JSON body in setUp/asyncSetUp; tests do not depend on another task's fixture library.

For download reuse Task 2 authorization at time of serving. Send bytes using Response with fixed MIME and sanitized `Content-Disposition: attachment`; do not rely on a bare filesystem URL. Report preview is safe HTML with scripts/network assets forbidden; application shell is not embeddable, while report preview supports same-origin sandboxed frame.

- [ ] **Step 4: Run GREEN.** All backend tests, including lifespan service lock, restart recovery, and prefix-root route generation. No provider calls in CI/unit tests.
- [ ] **Step 5: Commit exact Task 4 files.** Message: `feat(ai-trading): expose guarded research API and downloads`.

## Task 5: Accessible private dashboard and research detail

**Files:** Create `ta_web/static/index.html`, `app.mjs`, `app.css`, `tests/test_ui.mjs`; update app.py static serving. Modify `ai-trading/frontend/components/terminal-frame.tsx` with one TradingAgents-only research launch link; do not restructure shared hub or migration files.

**Interfaces:** `routeFor(pathname: str, prefix: str) -> {kind:'list'|'detail', id?: str}` and `apiPath(prefix: str, suffix: str) -> str` exported from app.mjs for native Node tests; DOM initialization runs only when document exists. `navigate`/popstate use same route handler.

- [ ] **Step 1: Write failing prefix/navigation test.**

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import {routeFor, apiPath} from '../ta_web/static/app.mjs';
test('research routes retain trusted deployment prefix', () => {
  const id = 'b3f34c8d-5cbd-49cf-a7b5-d7a2d65b1d39';
  assert.deepEqual(routeFor(`/u/tradingagents/research/${id}`, '/u/tradingagents'),
                   {kind: 'detail', id});
  assert.equal(apiPath('/u/tradingagents', `/research/${id}`),
               `/u/tradingagents/api/research/${id}`);
  assert.throws(() => routeFor('/u/tradingagents-evil/research', '/u/tradingagents'));
});
```

Browser acceptance cases recorded in README: navigate between two runs while old response delayed; reader has no mutation controls; clipboard failure provides selectable link; mobile form/errors/keyboard work; crypto disables incompatible fundamentals; local file download contains expected report bytes.

- [ ] **Step 2: Run RED.** `node --test ai-trading/tradingagents-web/tests/test_ui.mjs`.
- [ ] **Step 3: Implement shell and UI using native controls.** Labels on ticker/date/asset/analyst/depth inputs; fieldset/legend for analysts; native date and select inputs. Dashboard has filters, pagination, New research and import/share/status labels. Detail shows real settings/progress/report sections and final rating, with md/html/ZIP attachment anchors only when ready; partial badges remain explicit. Imported unknown fields read Unknown, never fabricated defaults.

```javascript
const controller = new AbortController();
const requestedId = currentId;
const response = await fetch(apiPath(prefix, `/research/${requestedId}`),
                             {signal: controller.signal, credentials: 'same-origin'});
if (controller.signal.aborted || requestedId !== currentId) return;
// Only this still-current response may update DOM; use textContent for text.
```

Abort previous request/timer on navigation; poll every three seconds only while visible/running; resume refresh on visibility change. Bind report iframe src to current ID and snapshot version, sandbox without scripts; never innerHTML model text. Error/401/404 paths clear stale content and provide safe login/history links. Shared recipients see read-only badge and view/download only. Owner Share requires explicit enable/revoke response; only say Copied after clipboard resolves. Warn that downloaded copies cannot be revoked. Manual rerun opens prefilled form and POST creates new ID.

Reuse upstream palette/system fonts/dark mode; compact mobile cards and readable desktop table, no new design-token system. Keyboard-visible focus, status live region, associated form errors, 44px primary touch targets, no color-only meaning. Canonical prefix comes from validated shell data attribute, not URL query input.

Hub CTA, conditional on `app.slug === 'tradingagents'`, uses `new URL('research', app.hostUrl).toString()` and opens new tab; leave legacy terminal iframe/path intact. This automatically uses that app's approved hostUrl if other migration changes it. Do not hardcode another hostname here.

- [ ] **Step 4: Run GREEN.** Native UI/backend suites; frontend `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` from `ai-trading/frontend/`. Browser-review desktop and mobile using local gateway stub only for UI; real auth assertions belong to Task 6. Exercise all acceptance cases above and inspect actual downloaded file, not merely click success.
- [ ] **Step 5: Commit exact Task 5 files.** Message: `feat(ai-trading): add private research dashboard and share controls`.

## Task 6: Build/gateway integration, safe rollout, documentation, delivery

**Files:** Create `deploy/upstream/trading-agents/web.Dockerfile` and `deploy/ci/test-tradingagents-research.sh`. Modify `deploy/docker-bake.hcl`, `deploy/docker-bake.ci.hcl`, `deploy/production/docker-compose.yml`, `deploy/production/Caddyfile`, `deploy/production/health-check.sh`, `deploy/production/deploy.sh`, `deploy/local/Caddyfile`, `deploy/local/docker-compose.override.yml`, `deploy/ci/smoke-test.sh`, `deploy/ci/test-deploy-firestore.sh`, `.github/workflows/ai-trading-ci.yml`, `.github/workflows/ai-trading-deploy.yml`. Create extension DIVERGENCE.md; update extension README and production/local runbooks; append small phase result to STATUS.md only when verified.

**Interfaces:** `ta-research` internal service at port 8182, image `${REGISTRY}/ai-trading-ta-research:${TAG}`. Same `tradingagents.env`, appuser UID, and `ta-data` volume; no published port. `APP_CONFIG_STAGING_DIR` is directory supplied by deploy workflow containing four known declarative files; `stage_configs()` and `restore_or_remove_configs()` own their exact files and per-run prior-existence bookkeeping.

- [ ] **Step 1: Write failing real-gateway and first-rollout regression.** Extend existing smoke using two synthetic allowed identities built from fixture names/domain parts rather than logging/literal real emails. Caddy/auth remain real, research service is real; seed synthetic completed records through local Store, not a production fake-provider mode. Assert missing/expired cookie and forged identity denied; owner sees own record; other user fails until sharing; non-owner write remains denied; revoke denies fresh download; root/hub-prefix paths and reserved sibling paths route correctly; existing ttyd WebSocket still returns 101.

In existing deploy fakes, model old Compose/Caddy/health files with **no** research service, new staged config requiring ta-research, and injected health failure. Assert files restored before previous-tag pull; previous pull requests no nonexistent research image; original last-good tag/data volume retained. Inject each config install/restore failure and verify known error is reported without touching unrelated files. Missing staging fails before changing active config.

- [ ] **Step 2: Run RED.** New gateway expectations fail routing/research-image absence; new deploy regression fails config restoration. Existing smoke and Firestore script baseline must still pass before modifying implementation.
- [ ] **Step 3: Implement integration and transactional config rollout.** Bake additions:

```hcl
target "ta-research" {
  context = "ai-trading/deploy/upstream/trading-agents"
  dockerfile = "web.Dockerfile"
  contexts = {
    base = "target:ta-upstream"
    web = "ai-trading/tradingagents-web"
  }
  tags = ["${REGISTRY}/ai-trading-ta-research:${TAG}"]
}
```

Add target to default group/cache overlay. Wrapper inherits `base`, temporarily root for hash-pinned `--no-deps` additions; compare full installed distribution versions before/after and fail on an upstream upgrade/downgrade, then pip check. Copy package/static/manifest via named web context; manifest also at `/home/appuser/app/DIVERGENCE.md`. Restore nonroot appuser. Start one Uvicorn process on 8182 with no reload/access log/server header, trusted proxy headers only on internal network. Use research root under existing home volume, not arbitrary browser env/path.

Compose adds service with 1 GiB limit, pids limit, no-new-privileges and healthcheck on internal `/__healthz`; gateway depends on service and already joins ta network. Add to production health SERVICES. Local overlay adds dependency and fixed local identity/prefix forwarding; local mock is never evidence of production authentication.

Caddy research matchers precede terminal rewrite. Dedicated host paths are exact `/research`, `/research/*`, `/api/research`, `/api/research/*`. Hub's four exact roots/descendants appear in snippet below; strip only `/u/tradingagents` and overwrite `X-Family-App-Prefix`. Dedicated route removes that header to establish empty prefix. Both use an explicit route block ordering identity-header removal, forward_auth, then reverse_proxy. Overwrite forwarded scheme/Host; no browser header establishes prefix/identity. Do not use bare `/research*` or `/api/research*` sibling wildcards.

Hub route core (add validated signed-out-navigation handler within forward_auth as described next):

```caddyfile
@ta_research path /u/tradingagents/research /u/tradingagents/research/* /u/tradingagents/api/research /u/tradingagents/api/research/*
handle @ta_research {
    route {
        request_header -Cf-Access-Authenticated-User-Email
        forward_auth auth:8181 {
            uri /__auth/check
            copy_headers X-Verified-Email>Cf-Access-Authenticated-User-Email
        }
        uri strip_prefix /u/tradingagents
        reverse_proxy ta-research:8182 {
            header_up X-Family-App-Prefix /u/tradingagents
            header_up X-Forwarded-Proto https
            header_up Host {host}
        }
    }
}
```

Signed-out top-level research navigation redirects to hub login with fixed allowlisted origin plus **only** regex-validated root/UUID path. Discard arbitrary query values. Caddy `path_regexp` is URI-decoded; use named captures `{re.research_return.1}`, restricted to slash/hex/hyphen characters, so query injection is impossible. Hub prefix uses separate capture and fixed hub origin. Other unauthenticated requests stay 401, and legacy terminal's existing root redirect remains unchanged. Test parsed returnTo, including login round-trip, not a hand-assumed encoding string.

Deployment controller currently installs new Compose/Caddy/health before invoking deploy.sh and restores only env/image tag. Correct it for this added service:

```text
workflow copies files to staging, installs only deploy controller/config CLI
  -> deploy.sh preflight/disk/profile render using currently active config
  -> stage_secrets arms existing rollback trap
  -> stage_configs validates four known staged files and Compose configuration
  -> back up every prior config before first install; record prior absence
  -> atomic mode-correct installs of Compose files, Caddyfile, health script
  -> pull/up/health for new tag; existing Caddy checksum recreates gateway
failure -> restore config files + env, THEN deploy previous tag
```

Known config files: docker-compose.yml, docker-compose.mirofish.yml, Caddyfile (0644), health-check.sh (0755). Use root-only own backup directory and known basenames; refuse symlinks/missing staging files. `CONFIG_STAGED` is armed before first install; partial staging restores complete previous set. Failed config restoration is a hard, visible rollback concern, never a claimed successful recovery. Preserve existing MiroFish/secret rollback behavior and free-space guard. Workflow no longer pre-installs these four active config files; passes `APP_CONFIG_STAGING_DIR` instead. No generic deployment framework or unrelated rollback cleanup.

Atomic config installation core, after validation/backing up all four files and arming CONFIG_STAGED:

```bash
for name in "${CONFIG_FILES[@]}"; do
  mode=0644
  [[ "$name" == health-check.sh ]] && mode=0755
  tmp="$(mktemp "$APP_DIR/.config-${name}.XXXXXX")"
  install -m "$mode" "$APP_CONFIG_STAGING_DIR/$name" "$tmp"
  mv -f "$tmp" "$APP_DIR/$name"
done
```

Extend common process-level deployment test setup to supply a valid config staging directory, preserving each case's deliberately injected health script. Existing function-only tests remain unchanged. Backup uses a run-owned `mktemp -d` directory; restore exact prior files or remove only files this run introduced, never unrelated backup directories. Config-stage failure and restore failure each leave runnable regression evidence.

CI runs offline unittest checks via research image with tests bound read-only, Node UI tests, existing full image/gateway smoke and deploy script regression. Add test script invocation to existing scripts/images jobs, retaining concurrent Desk jobs unchanged. Script uses dummy/no provider keys. No new env profile or CI credential flow.

- [ ] **Step 4: Verify GREEN, review, and deliver one completed batch.** Required commands from repository root unless noted:

```sh
PYTHONPATH=ai-trading/tradingagents-web "$TA_SCRATCH/venv/bin/python" -m unittest discover -s ai-trading/tradingagents-web/tests -p 'test_*.py' -v
node --test ai-trading/tradingagents-web/tests/test_ui.mjs
docker buildx bake -f ai-trading/deploy/docker-bake.hcl --load
docker buildx bake -f ai-trading/deploy/docker-bake.hcl mirofish-frontend
ai-trading/deploy/ci/test-tradingagents-research.sh
ai-trading/deploy/ci/smoke-test.sh all
ai-trading/deploy/ci/test-deploy-firestore.sh
```

Supply fake publishable key only to local/CI smoke builds, never production; obtain production publishable value only from approved configuration flow without printing it. Also run frontend lint/typecheck/test/build in its own directory, uploader test after build, ShellCheck for changed scripts, Compose validation with env files rendered/faked outside repository, and `git diff --check`.

Before completion, use verification and fresh review skills. Check entire branch diff against dev and approved spec, including auth/rollback boundaries. If Native chosen, one fresh read-only reviewer reviews whole branch; if subagent-driven chosen, follow chosen skill's per-task review gates. No subagent implementation before owner selects it.

Merge current origin/dev in this worktree, preserve others' paths, then integrate owned feature commits into shared feature/toby only after fresh status confirms no other-session conflict. Stage/commit/push exact phase paths, create one PR to dev, wait required checks and image smoke, merge. Scoped release branch from origin/main carries only this phase's extension/build/routing/runbook/workflow changes, not entire dev nor unrelated Desk/Vibe/expense changes. Apply only this phase's hunks to shared workflows/config files: copying whole dev versions could release Desk CI jobs referencing unreleased paths. Verify scoped release diff explicitly. Follow standing release/deploy authorization and appropriate ship/GitHub skills.

Check existing terminal/research activity before rollout; do not forcibly interrupt another family member's active analysis. Report a genuine active-run blocker if necessary. Backend deploy first; once healthy, upload hub static export containing new CTA using existing `upload_hub_static` dispatch. Keep `activate_mirofish`/`stop_mirofish` false. Monitor CI/deploy; compare live image tag/health, MiroFish state, and unrelated services.

Live check uses family-login browser, never owner's personal Chrome: create one real sponsored-provider research (market analyst, depth 1); close/reopen URL, download and inspect artifacts, repeat ticker/date to confirm new ID when practical. Check other-user privacy/read-only sharing through authenticated real-Caddy fixtures; if two family sessions are available, also verify live recipient/revoke flow. Do not impersonate another family member or print session/provider secrets. Synthetic fixtures remain clearly labeled tests, never substituted for real research evidence.

Do not import actual historical private reports until explicit owner key/source assignment is supplied by operator. Import capability must be delivered/tested, but unowned real data is not automatically exposed.

- [ ] **Step 5: Record results and cleanup.** Update DIVERGENCE in same owned change, README with exact launch/import/recovery instructions, runbook with service/rollback behavior, STATUS additively with verified phase. Commit meaningful integration batch before its single PR, not after release. After verified delivery and shared feature/toby integration, remove only this session's clean worktree/branch; do not hand off unmerged/uncommitted implementation.

## Plan self-review and references

- Spec §§1/4: Tasks 1/3/5 cover UUID allocation, durable reopening, uniqueness, status/progress, isolated memory, busy and restart.
- Spec §§2/3: Tasks 5/6 cover unmodified upstream, manifest, existing routes/terminal, prefix safety and no DNS changes.
- Spec §§5/6/9: Tasks 1/4/5/6 cover controls, private list/detail/download, explicit sharing/revoke, read-only recipients, authentication and Origin checks.
- Spec §§7/8: Task 2 covers real safe exports, bytes/headers/archive constraints and explicit legacy assignment/deduplication.
- Spec §9 delivery: Task 6 covers regression/full smoke/browser/live checks and scoped release without other-lane deployment.
- Review Focus: each numbered case has explicit tests in the owning task, including discovered first-rollout config restoration.

Documentation consulted: [Starlette routing](https://www.starlette.io/routing/), [ASGI middleware](https://www.starlette.io/middleware/), [Uvicorn settings](https://www.uvicorn.org/settings/), [HTTPX 0.28.1 ASGI transport](https://www.python-httpx.org/advanced/transports/#asgi-transport), [Caddy path_regexp](https://caddyserver.com/docs/caddyfile/matchers#path_regexp), [Caddy redir](https://caddyserver.com/docs/caddyfile/directives/redir). HTTPX transport does not run lifespan; enter Starlette lifespan explicitly. Current Starlette TestClient uses HTTPX2, so use already-installed HTTPX ASGITransport instead of adding a second client stack.

Execution method/review approval: pending owner selection. No product implementation started.
