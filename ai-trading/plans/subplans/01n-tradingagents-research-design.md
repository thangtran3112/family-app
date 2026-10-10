# TradingAgents: private research history, links, and client downloads

Date: 2026-10-10. Status: written spec approved by owner on 2026-10-10.

## 1. Intent and success criteria

TradingAgents currently runs as a CLI inside a browser terminal. Its Save report
operation writes files on the server. The owner wants a web research experience:
start research, receive a permanent research URL, return later to read previous
research, and download reports onto the computer accessing the application.

History is private and organized per user. An owner may explicitly share a
research link with other authenticated family members. Recipients have read-only
access. Sharing never makes research publicly accessible.

Success means:

- Every accepted research request receives a UUID before model execution.
- Its `/research/{id}` URL opens both active and historical research.
- Repeating a ticker/date produces a new ID, without overwriting earlier output.
- Reloading, closing the tab, and later returning preserve research and reports.
- Markdown, standalone HTML, and report ZIP downloads save onto the client.
- Private list/detail/download access cannot cross user boundaries.
- Explicit sharing grants read-only family access; revocation removes it.
- Real upstream research and exports are used, not mocked production output.

## 2. Scope and ownership

This session owns the research features, not another session's hostname migration.
Do not discard other-session work or change unrelated applications. Resolve an
integration conflict from evidence and coordinate its narrow correction.

The owner approved a maintained wrapper web extension rather than a source fork.
`packages/trading-agents` stays an unmodified, fetchable upstream submodule.
Current package rules prohibit editing that checkout.

Our application source belongs in `ai-trading/tradingagents-web/`. Its wrapper
image belongs in `ai-trading/deploy/upstream/trading-agents/`. Keep a tracked
`DIVERGENCE.md` with the extension, describing the upstream revision, imported
APIs, behavior added by this application, compatibility tests, and sync procedure.
Copy that manifest into the built TradingAgents application. The requested
source-submodule `DIVERGENCE.md` cannot be edited or tracked through the parent
repository under the current policy. The empty, untracked file in the shared
checkout is not this session's work and must remain untouched.

No new hostname/DNS decision, hub rehosting, Family Desk change, upstream fork,
broker integration, arbitrary model endpoint editor, public sharing, report
editing, automated rerun, or research queue belongs to this phase.

## 3. Architecture

```text
browser
  -> existing Clerk/Caddy family-login gate
  -> research web service: owner checks, API, UI, SQLite index
  -> isolated Python research subprocess
  -> unmodified TradingAgents graph and report exporter
  -> existing persistent ta-data volume
```

Use a small Python web service with a maintained production HTTP framework and
plain HTML/CSS/JavaScript UI. Do not build a custom HTTP parser or another large
frontend. Pin any wrapper-only runtime dependencies; do not change upstream
dependencies. Exact framework versions and build wiring belong in the execution
plan. Reuse the upstream report appearance, including light/dark support.

Run the service as a separate internal `ta-research` container, using the same
upstream base and persistent volume as the terminal. Do not publish its port to
the host. Keep the existing terminal available and give the app's launch surface
a discoverable research link. Deploy routing changes through tracked application
configuration, with no console infrastructure changes.

Serve `/research`, `/research/{id}`, and `/api/research/*` through the existing
TradingAgents hostname's gate. Also support the hub's `/u/tradingagents` prefix:
the gateway strips that prefix for this service and communicates a fixed,
trusted application prefix. Browser links, assets, and API calls must preserve
it. Routes use exact roots and slash descendants, not wildcard sibling matches.
Do not route the research service through MiroFish's generic `/api/*` block.
Keep authentication return paths bookmark-safe for research detail links.

## 4. Identity, persistence, and lifecycle

Only the gateway-verified identity header establishes the caller. The gateway
strips a forged browser identity before forwarding its verified identity. Derive
an opaque, deterministic owner key from that verified identity; never accept an
owner identifier from a browser write request. Existing email-based gateway
identity is sufficient for this phase; account-identity changes require explicit
migration, not silent reassignment.

SQLite stores each run's UUID, owner key, validated research inputs, creation and
update times, lifecycle status, current stage, sharing flag, origin (`web` or
`import`), public-safe settings, and allowlisted report state. It also records
whether exported artifacts are ready. Persist no provider credentials or browser
sessions. All user-facing settings use a fixed allowlist.

Files live under a new research subtree of the existing volume. Derive paths
from database ownership and validated UUIDs, never browser paths. Each run has its
own results/checkpoint directory. Agent memory belongs to its owner, separate
from other users and the existing terminal's shared legacy memory. Nonsecret
market-data caching may be shared only where upstream semantics make that safe.

States: `running`, `completed`, `failed`, `interrupted`. Imports are completed
report-only records with an imported label. Partial report snapshots survive
failure/interruption. Export state clearly identifies partial output.

One active research subprocess initially. Enforce admission transactionally,
including simultaneous start requests; respond `409` with a clear Busy message
when occupied. Separate processes avoid upstream's process-global configuration
leaking between users. UI/history requests do not run the graph in-process.
An accepted ID is committed before launching research. Launch failure becomes a
recorded failure, not an invisible request.

The child uses upstream graph execution, report generation, and configured
provider defaults. Persist progress/report snapshots without exposing tool
arguments, internal traces, or raw exceptions. Publish artifacts atomically
before marking them ready/completed. Browser disconnect does not cancel research.

Run one API server process per container, with no development reloader or
multiworker pool. Its exit terminates the container and its research child, so
startup cannot abandon a still-running orphan and admit a second research.
On service/container restart, unfinished records become Interrupted. No automatic
replay or model call occurs. A manual rerun creates a new ID with copied public
inputs. The initial design does not add cancellation, queueing, or transparent
resume. Comment the single-worker ceiling and its upgrade trigger in code.

## 5. Web experience and API

Dashboard shows only the caller's research, newest first, with pagination
(25 records by default, maximum 100 per request)
and ticker, analysis-date, and status filters. Each row shows ticker, date,
creation time, status, final rating when available, and sharing/import labels.
Provide useful empty, loading, and failure states and a New research action.

The start form accepts ticker, analysis date, asset type, selected analysts, and
research depth. Validate shape, length, enum/range, and date at the API boundary;
apply upstream asset/analyst compatibility rules. Provider/model defaults come
from existing Firestore-injected environment values, never client-supplied keys,
filesystem paths, or arbitrary backend URLs. Accept ticker strings of at most
64 characters at the request boundary and research depths 1 through 5. Upstream
currently accepts canonical tickers of at most 32 characters; reject longer
canonical symbols before execution and reflect that effective limit in the UI.
An explicitly submitted depth
sets both debate and risk rounds; when omitted, preserve server-configured round
defaults. Display the effective values, not merely the requested ones.

An accepted start immediately navigates to the UUID detail URL. The page shows
settings, stage/status, available analyst/research/trading/risk/portfolio report
sections, and final recommendation. Poll bounded status/report snapshots while
active, stopping for terminal states or while the page is hidden. Reload and
browser Back/Forward must restore the correct research, not an in-memory last run.

API contract:

| Operation | Access and outcome |
|---|---|
| `GET /api/research` | Own history only, bounded pagination and validated filters |
| `POST /api/research` | Authenticated start; `202` with ID/detail URL, or `409` Busy |
| `GET /api/research/{id}` | Owner, or authenticated family reader when explicitly shared |
| `POST /api/research/{id}/sharing` | Owner only; explicit boolean enable/revoke |
| `GET /api/research/{id}/report` | Same read check; safe rendered report/snapshot |
| `GET /api/research/{id}/download?format=md\|html\|zip` | Same read check; fixed formats only |

Malformed requests receive `400`/`422`; missing authentication receives `401` at
the gate/service. Unknown and unauthorized IDs receive the same `404`, including
attempted non-owner mutations. An artifact not yet available receives a clear
`409 REPORT_NOT_READY` response, not a broken filesystem link. Infrastructure and provider
failures become safe user-facing states; no secret-bearing raw error is returned.

## 6. Explicit read-only sharing

Default `shared=false`. Owner selects Share, explicitly enables sharing, and
copies the existing `/research/{id}` link. The UUID is unguessable, but possession
alone never bypasses family authentication. Other family members may read that
one shared research and download its visible report; they cannot alter its
inputs/status/sharing or overwrite its artifacts. Their own dashboards remain
owner-scoped and do not list another user's shared history.

Revoke sets `shared=false`; every subsequent detail, snapshot, and download
request rechecks access. A recipient's already downloaded copy cannot be revoked;
state that in the sharing UI. Previously delivered bytes cannot be recalled.
Disable caching of private/shared responses. A previously copied URL stops
working for other users after revocation and works again only if re-enabled.
Sharing an active run includes its subsequently produced report snapshots.

No separate public bearer token, recipient list, or share-expiry scheduler is
needed: an explicit sharing flag, UUID URL, and existing family gate cover the
approved use case.

## 7. Reports and downloads

Reuse upstream `TradingAgentsGraph`/`write_report_tree` and safe HTML rendering.
Download endpoints stream/send artifact bytes with the correct content type,
attachment disposition, and sanitized filename containing ticker, date, and ID.
Label partial downloads explicitly. Browser's normal download behavior saves the
copy locally; no server-path prompt, browser filesystem API, or emailed report
is required.

ZIP contains only the complete report and known per-section Markdown artifacts.
Exclude logs, configuration, credentials, checkpoints, memory files, and
unrelated user/run output. Reject unknown formats, traversal, invalid UUIDs, and
symlinks escaping the run's artifact root. Do not expose a directory browser.

Model Markdown must not execute HTML/scripts or fetch remote images. Reuse
upstream's renderer; render report content in a protected document/frame with
appropriate content-security restrictions. Do not insert model content directly
into application HTML. Standalone downloaded HTML keeps these restrictions.

## 8. Legacy reports

Provide an operator-only local import command, not a browser-accessible arbitrary
filesystem reader. It accepts a surviving report folder and an explicit opaque
owner key obtained from the authenticated user's account information. Never
infer ownership from ticker/date or assign old shared files to the first visitor.

Import copies validated report files into a new ID-owned directory, regenerates
safe HTML from Markdown rather than trusting legacy HTML, labels the record
Imported, and retains source files unchanged. Fingerprint the validated report
contents; importing unchanged content for the same owner returns its existing
record, while changed content gets a new ID without overwriting the prior import.
Unknown dates/settings stay
explicitly unknown; do not invent provenance. Reports without a known owner
remain unavailable through the new application until assigned by an operator.
Missing or overwritten old research cannot be recovered by this feature.

## 9. Security and verification

- Gate every UI/API/download route; expose no public backend port.
- Enforce ownership/read-only rules for every endpoint, not only the UI.
- Protect POSTs with strict same-origin checks using gateway-set authority,
  JSON bodies limited to 16 KiB, expected content type, and validated inputs.
- Set no-referrer policy so external report links do not receive private IDs.
- Private responses use no-store; never log keys, identities, private report
  bodies, or secret-bearing raw exceptions.
- Test ID allocation before execution, repeated ticker/date uniqueness,
  durable reopen across service instances, and interrupted startup handling.
- Test simultaneous admission, failed worker launch/execution, and partial output.
- Test each download's bytes, disposition, MIME type, archive contents, and
  not-ready behavior; test hostile UUIDs, paths, symlinks, and model markup.
- Test cross-user list/detail/download denial, explicit shared reads, denied
  shared-reader mutations, revocation, and unauthenticated access.
- Test legacy import assignment, source preservation, sanitization, and dedupe.
- Run production's real-Caddy smoke to verify forged identity stripping and
  exact route/prefix handling; mock-only identity tests are insufficient.
- Browser-check desktop/mobile, refresh/bookmarks, Back/Forward, private history,
  shared read-only states, and a file actually downloaded to the client.
- Run one real sponsored-provider research to verify the upstream integration,
  without printing keys or committing generated research.

When adding the research service, retain prior Compose/Caddy/health files for
rollback and restore them before starting an older tag that has no research
image. Do not leave new configuration pointing at a nonexistent old image.

Follow ai-trading's standing delivery policy after implementation: verify/review,
integrate through the owning branch into dev, scoped release to main, deploy
without changing MiroFish's state, then verify live. Do not open a spec-only PR
or release another session's unfinished application paths.

## 10. Observed baseline

The upstream pin is `1394a3f72aa4393e1a98f51b382434c4b4c2d972`.
`cli/run.py::_offer_reports` delegates to `graph.save_reports`, which calls
`tradingagents/reporting.py::write_report_tree`. An offline probe invoking these
unchanged functions with synthetic report content confirmed host-local file
creation, not a client download. The production Compose file mounts `ta-data`
at `/home/appuser/.tradingagents` and currently exposes only ttyd for this app.
`TradingAgentsGraph.__init__` mutates upstream global dataflow configuration;
research-process isolation is necessary, not merely an optimization.

This is source/probe evidence, not a claim that new functionality exists or that
the current production report inventory has been inspected.
