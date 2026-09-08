# Phase 0L Implementation Plan: TypeScript Temporal Client & Python Worker Foundation

Source of truth: [phase-0i-polyglot-platform-rebaseline-design.md](phase-0i-polyglot-platform-rebaseline-design.md)
sections 4.3 (Python worker ownership), 16.4 (worker callbacks), 18
(reliability/outbox), and roadmap row 5A ("TypeScript Temporal client and
Python worker foundation with generated contracts/internal clients", depends
on 0I + 0J -- already satisfied, plus 0J1/0K completed ahead of schedule).

## Scope

Generic job-dispatch substrate only. No OCR, no receipts, no real business
aggregate. Phase 0C (depends on 0K, 0L, 0D) wires the first real consumer on
top of this foundation.

In scope:
- `ProcessingJob` domain in App API: create, transactional dispatch outbox,
  a manually-triggered `dispatchPendingJobs()` (mirrors 0K Wave B's
  entitlement-sync "no scheduler yet" precedent), and generic worker-callback
  routes (status update, result submit) with idempotency-key uniqueness and
  optimistic concurrency.
- `@temporalio/client` wiring in App API (client only -- App API never runs a
  worker).
- New `services/ai-worker/` Python project: Temporal Python SDK worker
  foundation, one trivial `FoundationEchoWorkflow` + activity that proves the
  full loop (mark RUNNING -> do trivial work -> submit SUCCEEDED), talking to
  App API over plain bearer-token HTTP (no JWT minting logic in the worker --
  it is handed a token string, matching how every other internal caller in
  this codebase is tested).
- Extending the JSON-Schema -> Pydantic generation pipeline (currently
  hardcoded to the single `JobReferenceV1` schema) to a small loop so it can
  emit multiple internal message types.

Out of scope (explicitly deferred, no caller exists yet):
- OCR/PDF/image activities, GCS, Foundry quota reservation from the worker
  side -- Phase 0C.
- A real scheduler/cron for `dispatchPendingJobs()` -- production adapter
  decision belongs to Phase 1A/1B.
- Reconciliation/retry policies beyond what Temporal's own activity retry
  gives us for free -- no evidence yet of what's actually needed.
- A named Temporal namespace -- see "Shared infra fixes" below.

## Shared infra fixes (found while turning this on for the first time)

`infrastructure/docker-compose.common.yml` already declared a `temporal` +
`temporal-ui` service (from the 0A/0B/0G/0H bootstrap wave), but nobody had
ever actually started it until this phase. It was broken in three ways,
fixed in place (low-risk, additive, already-authorized shared-infra
maintenance, not a redesign):

1. `DB=postgresql` is not a valid `temporalio/auto-setup` driver name (valid:
   `mysql8`, `postgres12`, `postgres12_pgx`, `cassandra`) -- container
   restart-looped. Fixed to `postgres12`.
2. `DYNAMIC_CONFIG_FILE_PATH=config/dynamicconfig/development-sql.yaml` does
   not exist in the `auto-setup:latest` image -- removed the override
   entirely, image ships a working default.
3. Added a real `healthcheck` (`temporal operator cluster health --address
   temporal:7233` -- note: `127.0.0.1:7233` does NOT work from inside this
   container, the server binds the container's own bridge IP, not loopback;
   the service-name address resolves correctly via Docker's embedded DNS).
   `depends_on: temporal: condition: service_healthy` can now be used by
   `app-api`/`ai-worker`.

Also decided: use Temporal's built-in `default` namespace rather than
bootstrapping a custom `expense-management` one. `.env`/`.env.example`
already declared `TEMPORAL_NAMESPACE="expense-management"` from the old
prototype, but registering a custom namespace on every fresh environment
needs its own idempotent bootstrap step for zero present benefit (no second
app shares this Temporal server yet). Changed both files to
`TEMPORAL_NAMESPACE="default"`. Revisit only when a second consumer actually
needs isolation.

`TEMPORAL_HOST` in root `.env`/`.env.example` stays `localhost:7233` --
that's the **local host-process** value (matches this repo's established
`.env` architecture: root `.env` is for host-process dev/tests against the
docker-published port). Containerized `app-api`/`ai-worker` get their own
`TEMPORAL_HOST=temporal:7233` set directly in `docker-compose.yml`'s
environment blocks, exactly like `expense-service`'s existing (untouched)
Temporal wiring and like every other container-network hostname in this repo.

## Contracts (`packages/contracts`)

New internal message schemas alongside the existing `JobReferenceV1Schema`
(reused unchanged as the sole Temporal workflow input argument -- opaque,
reference-only, matches design doc section 6):

- `JobStatusUpdateRequestV1Schema` (`src/internal/job-status-update-v1.ts`):
  `schemaVersion: literal(1)`, `status: enum(["RUNNING","FAILED"])`,
  `idempotencyKey: string().min(1)`, `expectedJobVersion: int().min(1)`,
  `message: string().max(2000).optional()`.
- `JobResultSubmitRequestV1Schema` (`src/internal/job-result-submit-v1.ts`):
  `schemaVersion: literal(1)`, `status: enum(["SUCCEEDED","FAILED"])`,
  `idempotencyKey: string().min(1)`, `expectedJobVersion: int().min(1)`,
  `resultSchemaVersion: string().min(1)`, `result: z.record(z.string(),
  z.unknown())`, `message: string().max(2000).optional()`.
- `ProcessingJobSchema` (`src/processing-jobs.ts`, App API's own public/OpenAPI
  shape, not an internal-message file): full row shape for the admin read
  route and route response validation.

Naming clarity (this tripped up my first draft, documenting so it doesn't
trip up 0C): `expectedJobVersion` in the callback schemas guards the
**ProcessingJob row's own** optimistic-concurrency counter (App API-internal
bookkeeping, always present). `expectedAggregateVersion` stored ON the
`processing_jobs` row is a **passive, opaque pass-through** field for a
*future* consumer's own domain aggregate (e.g. an expense record in 0C) --
0L neither validates nor interprets it.

Generation pipeline changes:
- `generate-json-schema.ts`: loop over `[{schema, className, fileName}]`
  instead of one hardcoded schema; emits
  `internal-messages.schema.json` (unchanged, `JobReferenceV1` only, keeps
  the established filename's meaning stable),
  `job-status-update-v1.schema.json`, `job-result-submit-v1.schema.json`.
- `packages/contracts/scripts/generate-python.sh`: same loop, one
  `datamodel-codegen` invocation per schema, outputs
  `internal_messages.py` (unchanged), `job_status_update_v1.py`,
  `job_result_submit_v1.py`. `generated/__init__.py` re-exports all three
  classes.
- `check-generated.mjs`: two more comparison pairs.

## App API (`services/app-api`)

Migration `008_processing_jobs.ts`:
- `app.processing_jobs`: `id`, `tenant_id`, `personal_profile_id` /
  `business_id` (same `CHECK ((personal_profile_id IS NULL) <>
  (business_id IS NULL))` + composite-FK-to-`(id, tenant_id)` pattern as
  `app.expenses`), `workflow_type`, `workflow_id` (unique), `task_queue`,
  `run_id` (nullable, set on dispatch), `status` (`PENDING` -> `DISPATCHED`
  -> `RUNNING` -> `SUCCEEDED`/`FAILED`, checked legal-transition in code, not
  just a CHECK constraint, since the legal-transition set is richer than a
  simple enum), `target_aggregate_type`/`target_aggregate_id`/
  `expected_aggregate_version` (all nullable, passive pass-through per above),
  `allowed_result_schema_version`, `result` (jsonb, nullable),
  `error_message` (nullable), `version` (integer, starts at 1), timestamps.
- `app.processing_job_dispatch_outbox`: transactional outbox row written in
  the same transaction as `processing_jobs` insert. `id`,
  `processing_job_id`, `job_reference` (jsonb, the literal `JobReferenceV1`
  payload), `status` (`PENDING`/`DISPATCHED`/`FAILED`), `attempts`,
  `last_error`, timestamps.
- `app.processing_job_callback_receipts`: `id`, `processing_job_id`,
  `idempotency_key`, `response_status`, `created_at`, `UNIQUE
  (processing_job_id, idempotency_key)`. Mirrors 0K Wave B's
  idempotency-key-uniqueness-with-409-on-replay convention exactly (insert
  first, `23505` -> `DomainError.conflict()` via the same `runInsert`-style
  wrapper) rather than a silent return-previous-result semantic -- this
  codebase already chose "hard reject duplicates" as its idempotency
  philosophy in Wave B and I am not re-litigating it here.

`src/temporal/client.ts`: `createTemporalWorkflowStarter(config)` returns a
narrow injectable interface (`start(workflowType, { workflowId, taskQueue,
args, workflowIdConflictPolicy }): Promise<{ runId }>`), built on
`@temporalio/client`'s `Connection.connect` + `Client`. Narrow on purpose --
same DI convention as `database`/`authVerifiers` in `buildApp`, lets unit
tests inject a fake starter instead of needing a real server.

`src/domain/processing-jobs.ts` (`ProcessingJobsDomain`):
- `createJob(...)`: one transaction, inserts `processing_jobs` (status
  `PENDING`) + `processing_job_dispatch_outbox` row.
- `dispatchPendingJobs({ limit })`: selects `PENDING` outbox rows, calls the
  injected Temporal starter with `workflowIdConflictPolicy: "USE_EXISTING"`
  (a redispatch after a crash mid-batch returns the existing handle instead
  of erroring or double-starting -- this is what makes "retries safely" in
  the design doc concretely true), advances `PENDING` -> `DISPATCHED` on
  success, increments `attempts`/`last_error` and leaves `PENDING` on
  failure.
- `recordStatusUpdate(...)` / `submitResult(...)`: idempotency-receipt
  insert, `expectedJobVersion` check (mismatch -> conflict), legal-transition
  check (terminal states `SUCCEEDED`/`FAILED` never accept another
  transition), `resultSchemaVersion` must match the job's own
  `allowed_result_schema_version` (mismatch -> validation error).
- `getJob(...)`: plain read, admin/debug only for now.

Routes (`src/routes/jobs.ts`, `/internal/v1/jobs*` prefix matching the
established App API internal-route convention -- not the design doc's more
aspirational `/api/internal/app/v1/...` full path, exactly like Foundry's own
routes already diverged the same way):
- `POST /internal/v1/jobs/foundation-echo` -- `serviceGuard("platform-admin",
  ["jobs:manage"])`. Creates one `FoundationEchoWorkflow` job. This is the
  only place a job gets created in 0L, since there is no real trigger yet;
  0C adds its own specific creation call sites directly against the domain
  function, not through a public route.
- `POST /internal/v1/jobs/dispatch` -- same admin guard. Calls
  `dispatchPendingJobs()`.
- `GET /internal/v1/jobs/:jobId` -- same admin guard. Debug/test visibility.
- `POST /internal/v1/jobs/:jobId/status` -- `serviceGuard("ai-worker",
  ["jobs:write"])`.
- `POST /internal/v1/jobs/:jobId/result` -- `serviceGuard("ai-worker",
  ["jobs:write"])`.

## Python worker (`services/ai-worker/`, new)

Standalone `uv` project (`pyproject.toml`, `src` layout, `python>=3.13`,
mirrors `expense-contracts`' structure exactly), path-dependency on
`expense-contracts` for the generated Pydantic models.

- `src/ai_worker/constants.py`: `TASK_QUEUE = "expense-tax-ai-worker"`,
  `FOUNDATION_ECHO_WORKFLOW_TYPE = "FoundationEchoWorkflow"`. No codegen
  plumbing exists for plain string constants shared cross-language; mirrored
  literally in `packages/contracts/src/internal/task-queues.ts` with a
  `// keep in sync` comment on both sides, and a test on both sides asserting
  the exact literal value so drift fails loudly instead of silently.
- `src/ai_worker/app_api_client.py`: thin `httpx.AsyncClient` wrapper reading
  `APP_API_BASE_URL` and `APP_API_SERVICE_TOKEN` (a plain bearer string, not
  a JWT the worker mints itself -- matches design doc's "worker fetches a
  short-lived App-signed admission grant" being a *Foundry-reservation*-time
  concern for 0C, not a 0L concern; 0L's worker is simply handed whatever
  token its operator configures it with, same as every other internal caller
  is tested in this repo today).
- `src/ai_worker/workflows.py`: `FoundationEchoWorkflow` (`@workflow.defn`) --
  takes `JobReferenceV1` as its only argument, calls the `mark_running`
  activity, then `submit_echo_result`.
- `src/ai_worker/activities.py`: `mark_running(job_reference)` (POSTs
  `/internal/v1/jobs/{id}/status`), `submit_echo_result(job_reference)`
  (POSTs `/internal/v1/jobs/{id}/result` with a trivial
  `{"echo": job_reference.jobId}` result).
- `src/ai_worker/run_worker.py`: connects, constructs `Worker(client,
  task_queue=TASK_QUEUE, workflows=[FoundationEchoWorkflow],
  activities=[mark_running, submit_echo_result])`, runs until stopped.
- `services/ai-worker/Dockerfile`: mirrors `expense-service/Dockerfile`'s
  `uv`-based pattern, adds a non-root user (matching the TS services'
  hardening bar, which the legacy `expense-service` never got), copies the
  sibling `common/python/expense-contracts` package in since it's a path
  dependency.
- `docker-compose.yml`: new `ai-worker` service, `depends_on: temporal:
  condition: service_healthy`, `TEMPORAL_HOST=temporal:7233`.

## Testing (four tiers, matching what each language already does elsewhere plus one new tier)

1. **TS unit** (`services/app-api/test/jobs.test.ts`): route auth/scoping
   with mocked domain + a fake Temporal starter, mirrors `plans.test.ts`'s
   `servicePrincipal(clientId, scopes)` fake-verifier convention exactly.
2. **TS + real Postgres integration**
   (`test/integration/app-domain-0l-jobs.test.ts`): domain-layer only (no
   HTTP), mirrors `app-domain-0j1.test.ts`'s convention, but with a REAL
   `@temporalio/client` against the real `temporal` container so
   `dispatchPendingJobs()` is proven to actually start a real workflow (not
   just flip a DB row) -- confirms via `client.workflow.getHandle(id
   ).describe()`.
3. **Python unit/integration (pytest)**: `ActivityEnvironment` for the two
   activities in isolation (mocked `httpx` via `respx`); workflow logic via
   `WorkflowEnvironment.start_time_skipping()` (Temporal SDK's own ephemeral
   test server, not the real docker container) with a real in-process
   `Worker` and a mocked activity implementation, proving the workflow drives
   the right call sequence.
4. **New tier -- real cross-process worker loop**
   (`test/integration/app-domain-0l-worker-loop.test.ts`, gated behind its
   own `PHASE_0L_WORKER_LOOP=1` flag since it is the heaviest test in this
   repo): a real `buildApp().listen({ port: 0 })` Fastify instance with a
   fake `authVerifiers.service.verify` that accepts a fixed test bearer
   string for `clientId: "ai-worker"`, a real spawned `uv run python -m
   ai_worker.run_worker` child process pointed at that instance's ephemeral
   port and the real `temporal` container, `dispatchPendingJobs()` called
   with a real `@temporalio/client`, then polling `getJob()` until
   `SUCCEEDED`. This is the first genuine cross-language/cross-process test
   in the repo -- existing integration tests never exercise real HTTP or
   real auth, only real Postgres against the domain layer directly. Building
   the full "fake-provider end-to-end" proof the design doc describes for 0C
   is explicitly out of scope here (no Foundry/GCS yet); this is the
   foundation-scoped slice of it, and it exists specifically because
   cross-language wiring bugs (task-queue name mismatches, payload
   (de)serialization, auth header shape) are exactly the class of bug that
   per-language unit tests cannot catch.

## Verification gate

`scripts/verify-phase-0l.mjs`, cascading through
`verify:phase-0k:wave-b`, adding: contracts tests, app-api tests, the new
Postgres integration test, Python `pytest` (via `uv run pytest`), the
worker-loop test (gated the same way DB integration tests are -- required
for a true zero-skip run), `ai-worker` Docker build + compose bring-up
(build/boot proof only, matching the bar every other service's Docker gate
already sets -- real auth against a real running container isn't exercised
anywhere in this repo yet, App API/Foundry included).

## Non-goals / explicitly deferred (revisit only when a real caller exists)

- Automatic/scheduled dispatch (cron, interval timer, or Cloud Scheduler) --
  production adapter decision, Phase 1A/1B territory.
- Any activity retry/backoff policy tuning beyond Temporal defaults -- no
  evidence yet of what real OCR/LLM providers need.
- Foundry quota reservation from the worker -- Phase 0C wires this using
  the already-built 0K quota domain plus the admission-grant flow described
  in design doc section 16.3.
- A named Temporal namespace -- see "Shared infra fixes".
