# tradingagents-web DIVERGENCE

This is a wrapper package (`ai-trading/tradingagents-web`), not a fork:
`ai-trading/packages/trading-agents` (the upstream `TradingAgents` submodule)
is never modified. This file tracks everything the wrapper depends on from
upstream that could break on an upstream bump, so a Dependabot sync can check
it deliberately instead of discovering a break at runtime.

Runtime copy: this file is also copied to `/home/appuser/app/DIVERGENCE.md`
inside the `ta-research` image (`ai-trading/deploy/upstream/trading-agents/web.Dockerfile`),
next to upstream's own files.

## Upstream source pin

Tracks the same pinned commit as `ai-trading/packages/trading-agents`
(`.gitmodules`; see that submodule's checked-out commit for the exact SHA).
No source file in that submodule is ever edited.

## Hash-pinned additions (`requirements.lock`)

`starlette`, `uvicorn`, `click` — installed `--no-deps --require-hashes` on
top of the upstream environment. `web.Dockerfile` fails the build if
installing these changes the version of any *already-installed* (upstream)
distribution, then runs `pip check` on the combined environment. On an
upstream dependency bump that conflicts with one of these three, regenerate
`requirements.lock` against the new base image before merging the sync.

## Upstream API surface this wrapper relies on

Not re-implemented; imported directly so an upstream rename/removal fails
loudly (ImportError) rather than silently diverging:

- `tradingagents.dataflows.symbols.normalize_symbol`,
  `tradingagents.dataflows.symbols.safe_ticker_component` — canonical,
  path-safe ticker normalization (`ta_web/domain.py`, `ta_web/store.py`).
- `cli.models.AnalystType`, `cli.models.AssetType` — the asset/analyst enums
  the public DTO's `inputs.asset_type`/`analysts` must stay compatible with.
- `cli.prompts.filter_analysts_for_asset_type` — asset-aware analyst
  compatibility (e.g. crypto excludes the fundamentals analyst).
- **Flat CLI layout**: the above live in a top-level `cli/` package
  alongside `tradingagents/` in the upstream repo root, not nested under the
  `tradingagents` package itself. The wrapper's imports (`from cli.models
  import ...`) depend on that top-level package staying importable at that
  path; an upstream restructure that moves or nests `cli/` would need these
  import paths updated here, not a wrapper abstraction layer.
- `run_settings()` — the safe, server-controlled provider/model/round
  defaults a run is created with (`ta_web/domain.py`'s `safe_settings`).
- `write_report_tree(state, ticker, stage, settings=safe_settings, html=True)`
  and `render_report(ticker, state, settings, _report_parts(state))` — used
  by `ta_web/reports.py`'s export/preview pipeline. `_report_parts` is
  upstream's own private helper name, tracked here as a compatibility
  dependency precisely because it is private: an upstream rename/removal is
  not covered by semver and is caught by the real end-to-end publish/
  preview/download smoke evidence below, not by a type signature.

## Tests

- `tests/test_store.py` — unittest, real SQLite via `TemporaryDirectory`, no
  mocks; ownership/persistence/race/input-validation coverage for
  `ta_web/domain.py` and `ta_web/store.py`.
- `tests/test_ui.mjs` — Node `node:test`; prefix-safe route/API-path helpers
  in `ta_web/static/app.mjs` (no DOM, no mocked backend).
- `ai-trading/deploy/ci/test-tradingagents-research.sh` — runs the above
  Python suite *inside the built `ta-research` image* (not just a host dev
  venv), proving the hash-pinned additions and upstream base actually
  support it, then checks the service boots and serves `/__healthz`.
- `ai-trading/deploy/ci/smoke-test.sh` (`gateway`/`all`) — the **real**
  `ta-research` service (not a stand-in), through real Caddy + real auth:
  forged-identity-header stripping, hub-prefix strip/overwrite, sibling-path
  rejection, signed-out navigation redirect preserving only a validated
  root/UUID path (at **both** the hub prefix and the dedicated host), APIs
  staying 401 even with a navigate header, private list/detail/download
  denial to a non-owner, denied nonowner sharing mutation, explicit share
  making a read-only read possible, revoke making every fresh non-owner
  read 404 again, real md/html/zip bytes with correct
  `Content-Type`/`Content-Disposition`, the owner's own sharing POST
  requiring a matching same-origin `Origin` (checked independently against
  the hub prefix, the dedicated host's own Host/Origin, and a direct,
  un-proxied plain-HTTP request standing in for `deploy/local/Caddyfile`'s
  shape, which never forces `X-Forwarded-Proto`), and a real network-bypass
  regression proving a legacy `ta`-network peer cannot reach `ta-research`'s
  IP at all (not just its DNS alias — see "Network isolation" below).
  Fixtures for these checks are seeded with `ta_web.store`/`ta_web.reports`
  directly inside the running container (real, non-mocked persistence/export
  code) — never a real research run, which would need a live model call.

## Network isolation (review round 1, Critical — fixed)

`ta-research` trusts `Cf-Access-Authenticated-User-Email`/`X-Family-App-Prefix`
on any connection it receives, because that trust is normally established by
Caddy stripping/overwriting them before `forward_auth` — ta-research itself
has no way to tell a header Caddy set from one a peer forged. Review round 1
found it placed on the `ta` network alongside `ta-terminal`, so an
authenticated terminal user could send a direct request straight to
`ta-research:8182` with a forged identity header and read another family
member's private research, bypassing Caddy entirely.

Fixed with network segmentation, not an app-level credential (no new secret
profile needed): `ta-research` now lives on its own `research` network
(`docker-compose.yml`), joined only by `gateway` — the exact same isolation
shape as the existing `vibe` network. `ta-terminal` is untouched, still on
`ta` alone. The two networks share no peer except `gateway`, so there is no
Docker-level route from `ta-terminal` to `ta-research` at all, by hostname or
by raw IP. `ta-research`'s own `FORWARDED_ALLOW_IPS` is scoped to exactly
this network's fixed `/29` subnet (`environment:`, mirroring how `vibe-trading`
already sets it for its own dedicated network) instead of `"*"`, which would
have blindly trusted any future peer added to the network, not just the
gateway; `web.Dockerfile` no longer hardcodes the flag, so this stays a pure
deploy/Compose concern. The research network is still a normal (non-`internal`)
bridge, so the background worker subprocess `ta-research` launches keeps its
own outbound internet access for real provider calls — only forwarded-header
*trust* is scoped, never egress.

`deploy/ci/smoke-test.sh` models both networks (one for `ta`/`ahf`/`vibe`/
`gateway`, one reusing `research`'s exact subnet) and proves the fix with a
real peer: from the `ta-terminal` stand-in's own container, a direct request
to `ta-research`'s real IP (not its hostname — DNS absence alone would not
prove isolation) with a forged identity header fails to connect at all.

## Verified integration (as of this change)

`ta_web.app:application`, `ta_web/reports.py`, and the background research
worker landed in this branch (controller-reviewed, commit `73c00ca`). One
real bug was found and fixed while wiring this up, in this task's own
`web.Dockerfile` (not the reviewed app code): the base image's
`ENTRYPOINT ["tradingagents"]` was not cleared, so `CMD`'s Uvicorn argv was
passed as arguments *to* that CLI instead of replacing it
(`No such command 'uvicorn'`). Fixed with `ENTRYPOINT []` before `CMD`.
With that fix: the built image's `/__healthz` serves 200, all 107
`tradingagents-web` unittest cases pass running inside the built image (not
just a host dev venv), and the full `deploy/ci/smoke-test.sh all` real-Caddy
suite passes end-to-end alongside the existing terminal/Vibe/market-data/
MiroFish flows, unmodified.

## Upstream sync procedure

On an upstream `TradingAgents` version bump (weekly Dependabot PR to
`ai-trading/packages/trading-agents`):

1. Re-run `web.Dockerfile`'s version-comparison build step against the new
   base; it fails closed if the bump changed a package this wrapper's
   hash-pinned additions depend on.
2. Re-check every import in "Upstream API surface" above still resolves
   (`cli.models`, `cli.prompts`, `tradingagents.dataflows.symbols`,
   `run_settings`, `write_report_tree`/`render_report`/`_report_parts`). An
   import error here is the signal to update this file and the dependent
   wrapper code together, in the same change.
3. Re-run `tests/test_store.py`, `tests/test_ui.mjs`,
   `deploy/ci/test-tradingagents-research.sh`, and `deploy/ci/smoke-test.sh
   gateway` before merging the sync.
