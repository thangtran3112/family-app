# 02s: Desk feedback log (file a bug or a feature request, and a dashboard of their status)

Status: planned 2026-10-26 (owner directive; lower priority than the live Desk phases). Desk lane only. Docs and Paper boards only in this run: no code, no migration, nothing activated.

See also: [02l](02l-desk-desktop-first-mvp.md) (desktop chrome and density rules, §b4), [02m](02m-desk-mvp-implementation-spec.md) (the interface contract this feature extends: §a1 conventions, §c1 routes), and [DEFECTS.md](../../DEFECTS.md) (the agent-side walkthrough ledger; see "Relationship to DEFECTS.md").

## Goal and non-goals

The wife uses the Desk for technical trading and practice. She needs to file a **bug** or a **feature request** from inside the Desk, with a description, links and screenshots, and to see a **dashboard of those reports with their status**. Every once in a while the owner asks Hermes and Claude Code to pick up the open reports and implement them. Minimum: (a) filing, (b) a dashboard with status.

Decisions made by the owner on 2026-10-26 (recorded, not reopened; each with its reason):

1. **Name:** nav and page title "Feedback"; documents call it the Desk feedback log. Ids are `F-001`, `F-002`, ... and are never reused. *Reason: one plain word she already says; a stable id lets a commit name what it closes.*
2. **Routes:** `/feedback` (dashboard), `/feedback/new` (filing form), `/feedback?id=7` (detail). *Reason: the Desk is a static export, so ids travel in the query string, as in `/practice/day?id=5`.*
3. **Two kinds, exactly:** Bug and Feature request. A bug carries a severity; a feature request does not. *Reason: two kinds are all she needs to say, and severity only means something for something broken.*
4. **Severity** is the `DEFECTS.md` convention verbatim: `P0` wrong money or data, or a trading figure shown as true, or a secret leak; `P1` a core flow is broken with no workaround; `P2` wrong or confusing, with a workaround; `P3` cosmetic or copy. *Reason: one scale across the agent ledger and the user log.*
5. **Status model:** `Open -> In progress -> Fixed`, plus `Won't fix` and `Duplicate`. She can only file; `Won't fix` and `Duplicate` are owner- or agent-set. `Fixed` always carries a fix reference (commit hash and/or PR number). *Reason: she should never wonder whether "done" is real.*
6. **Attachments:** screenshots only (PNG, JPEG, WebP), up to 6 per report and 5 MB each, plus a repeatable links list. Bytes stay on the Desk's own side and are served through the Desk's authenticated API; no third-party file host, no GCS. *Reason: trading screens can show balances.* (Where "the Desk's own side" is: see "Attachment storage", which corrects the volume assumption.)
7. **Entry points:** the Desk `More` page and the avatar menu, plus a quiet `Report a problem` link in the status bar. The shell and active-nav treatment follow the Paper board `R3 · Tech · Settings & More · desktop` (node `KSZ-0`) exactly. *Reason: no new nav treatment.*
8. **Relationship to `DEFECTS.md`:** it stays the agent-side ledger; this is the user-filed log. See the section below.
9. **Non-goals:** no mobile mocks (desktop-first, 02l); no email or Telegram notification for reports; no third-party issue tracker; no anonymous filing; no editing or deleting someone else's report; no replies or threads on a report (the description plus optional later edits is enough); nothing here touches broker, orders or IBKR.

## Ownership, QA and scale (owner ruling 2026-10-26)

This feature is deliberately non-critical, so the owner delegated it end to end: **Hermes decides, implements, QAs and walks it through itself.** There is no owner-walkthrough gate for this feature, and Hermes does not wait for the owner to file reports or to move statuses.

- Hermes authors the mocks and this plan, implements P1–P3, and runs the P3 acceptance itself; a finding goes into a log in this plan and is fixed in the same phase instead of being parked for the owner's sweep.
- Hermes files the first reports through `/feedback/new` during its own QA (one real bug, one real feature request), then exercises the dashboard's transitions (`open` -> `in_progress` -> `fixed`) and the CLI bridge on those rows.
- Hermes keeps the dashboard current: `in_progress` when a fix starts, `fixed` with the commit reference when it lands. The owner only ever reads the log, or says "pick up the open feedback".
- The 44 px mobile rule, the owner-walkthrough protocol and the `DEFECTS.md` sweep are unchanged for everything else; this ruling covers this feature only.

**Scale.** At most about 20–50 reports in total, and the owner expects to clear them within about a week. That is why v1 deliberately has no pagination in the UI (one list that scrolls), no notifications, no retention or archive policy, no bulk actions, no analytics, and no labels, assignees or priorities beyond the two kinds, the five statuses and the four severities. The API keeps `limit` (default 50, max 100) as a guard, not as a UI paging model.

## Where the data lives

The Desk's shared Postgres cluster, database `ai_trading_desk_db`, schema `desk`; the runtime role `desk_runtime` has `SELECT/INSERT/UPDATE/DELETE` on every table the migrator role creates (`backend/docker/postgres/zz-20-desk-roles.sh`: default privileges), so no grant change is needed.

**Migration:** `ai-trading/packages/family-desk/backend/src/ai_trading/db/migrations/versions/0010_feedback_log.py`, `revision = "0010"`, `down_revision = "0009"` (the current head is `0009_replay_switch_rescan`; re-read the directory before writing, in case another phase took `0010`). Additive only; `downgrade()` drops the four tables. Constraint names follow 0009 (`fk_<table>_<col>_<reftable>`, `uq_...`). Models go in `db/models.py` next to `PracticeWeek`.

| Table | Columns | Notes |
|---|---|---|
| `feedback_reports` | `id` serial PK (shown as `F-%03d`); `user_id` FK `users.id`; `kind` text (`bug`/`request`); `severity` text null (`P0`..`P3`); `title` varchar(120); `body` text; `expected` text null; `screen` text; `route` text; `app_version` text; `context` JSONB (practice day, symbol, anything else captured); `captured_at` timestamptz; `links` JSONB (list of `{label, url}`, at most 10); `status` text; `fix_ref` text null; `duplicate_of` int null FK `feedback_reports.id`; `created_at`, `updated_at` timestamptz | check: `kind = 'bug'` iff `severity` is not null; check: `status = 'fixed'` implies `fix_ref` not null; check: `status = 'duplicate'` implies `duplicate_of` not null. No delete route exists, and a Postgres sequence never hands an id out twice, so ids are never reused. |
| `feedback_events` | `id` serial PK; `report_id` FK cascade; `at` timestamptz; `actor` text (`user` / `owner` / `claude-code` / `hermes`); `from_status`, `to_status` text; `note` text null | The timeline in the detail rail ("Open", "In progress, picked up by Claude Code", "Fixed, commit ...") is read from these rows. One row is written for the creation (`null -> open`) and one per status change. |
| `feedback_attachments` | `id` serial PK; `report_id` FK cascade null; `user_id` FK; `filename` text; `content_type` text; `size_bytes` int; `sha256` text; `payload` bytea; `created_at` timestamptz | check: `size_bytes <= 5242880`. `report_id` is null while the file is staged (see "API surface"). |

Indexes: `ix_feedback_reports_status_id (status, id desc)` (dashboard list and counts), `ix_feedback_reports_user_id`, `ix_feedback_events_report_id_at (report_id, at)`, `ix_feedback_attachments_report_id`, `ix_feedback_attachments_user_staged (user_id) where report_id is null` (the staging sweep).

## API surface

New router `ai-trading/packages/family-desk/backend/src/ai_trading/api/feedback.py`, registered in the `for _router_module in (...)` tuple in `api/app.py`; Pydantic models in `api/schemas/feedback.py` (plain Pydantic, like `api/schemas/threads.py`; no new `contracts/` file, because nothing here is a spec the user authors and versions: `ai-trading/packages/family-desk/contracts/` stays untouched). Conventions are 02m §a1, unchanged: prefix `/api/desk/feedback`; `APIRouter(..., dependencies=[Depends(get_current_user), Depends(_no_store)])` exactly as `api/replay.py`; the existing 401 route-walk test then covers it; timestamps ISO-8601 UTC with `Z`; plain `{"detail": ...}` for 401/403/404/409/413/415; spec-style `422` with `{"detail": {"problems": [{"path", "message"}]}}` for field problems (`api/problems.py`); every read is `Cache-Control: no-store`.

| Method and path | Purpose | Request | Success | Failure codes |
|---|---|---|---|---|
| `GET /api/desk/feedback` | list and counts | query `status` (repeatable), `kind`, `area`, `q`, `sort` (`newest`/`updated`/`oldest`), `limit` (default 50, max 100), `offset` | `{items: [{id, ref: "F-014", kind, severity, title, route, area, reported_by, updated_at, status, fix_ref}], counts: {open, in_progress, fixed, wont_fix, duplicate}}`; counts are over the whole log, not the page | 422 bad query |
| `POST /api/desk/feedback` | file a report | `{kind, severity?, title (1-120), body (1-4000), expected?, screen, route, app_version, context, captured_at, links: [{label?, url}], attachment_ids: []}` | `201` the detail shape below | 422 problems (`severity` required for a bug and forbidden for a request; `url` must be `http(s)`; at most 10 links; at most 6 attachments; an attachment id must be a staged file of the same user) |
| `GET /api/desk/feedback/{id}` | detail | none | `{...row, body, expected, screen, app_version, context, captured_at, links, attachments: [{id, filename, size_bytes, content_type}], events: [{at, actor, from_status, to_status, note}], duplicate_of, fix_ref}` | 404 |
| `PATCH /api/desk/feedback/{id}` | set status, or edit text | `{status?, fix_ref?, duplicate_of?, note?}` for a status change (owner); `{title?, body?, expected?, severity?, links?}` for the filer's own edit while the report is `open` | `200` the detail shape | 403 not allowed for this user; 404; 409 transition not allowed from the current status; 422 `fixed` without `fix_ref`, `duplicate` without a valid `duplicate_of`, `won't fix` without a `note` |
| `POST /api/desk/feedback/{id}/attachments` | add a screenshot to an existing report | multipart `file` | `201 {id, filename, size_bytes, content_type}` | 404; 403 (not the filer or owner); 413 over 5 MB; 415 not PNG/JPEG/WebP (checked by magic bytes, not the header); 409 a seventh file |
| `POST /api/desk/feedback/attachments` | **stage** a screenshot before the report exists | multipart `file` | `201` same shape, `report_id` null | 413, 415 as above; 409 when the user already has 6 staged files |
| `DELETE /api/desk/feedback/attachments/{id}` | remove one **staged** screenshot (the form's Remove) | none | `204` | 404 (missing, or not the caller's); 409 the file is already on a report and stays with it |
| `GET /api/desk/feedback/attachments/{id}` | the bytes | none | `200` with the stored `Content-Type`, `Content-Disposition: inline`, `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store` | 404 (including a staged file that is not the caller's) |

The staging route exists because the filing form shows an upload in progress and a failed upload *before* Send (boards `R3 · Desk · Feedback report · desktop` and `R3 · Desk · Feedback states · desktop`); the brief's single `POST /{id}/attachments` would only work after Send. Staged files older than 24 hours are deleted by the staging route itself on its next call, so no scheduler job is added. `GET /attachments/{id}` is declared before `GET /{id}` for readability; the integer path type keeps them apart.

Visibility: every signed-in family user can read every report (two users; the dashboard is a shared list and the mock shows "Reported by"). This differs from 02m §a1's per-user scoping on purpose; ruling 3 below.

## Attachment storage

**The brief assumed "an existing Desk volume path". There is none.** `ai-trading/deploy/production/docker-compose.yml` says it in so many words for the Desk: "no Desk-private data volume: nothing here is Desk-private anymore"; the `api` service mounts no volume and its data lives in the shared VPS Postgres. The repository's own precedent for binary payloads is `replay_blobs.payload` (`LargeBinary` in `db/models.py`). So the plan stores bytes in `feedback_attachments.payload` (`bytea`) in the same database: nothing new to provision, one backup, authenticated reads through the existing gate, no third-party storage. Worst case is 30 MB per report (6 x 5 MB), and about 1.5 GB for a 50-report log that is never pruned; in practice a Desk screenshot is a few hundred KB and the owner clears the log within about a week, so the realistic footprint is tens of MB. If it ever matters, pruning is one statement against `feedback_attachments` by `report_id`/`created_at`; no job is added now. Limits are enforced server-side: 5 MB (`size_bytes` check constraint plus a streamed read that stops at 5 MB + 1), PNG/JPEG/WebP by magic bytes, 6 per report. The read route serves the stored type with `nosniff` and `inline` so the rail can show a thumbnail.

Backup: `replay_blobs` rows are left out of the nightly backup because they are re-fetchable market data (STATUS 5I). Feedback attachments are not re-fetchable, so P1 must confirm the backup job includes `feedback_attachments` (read `infrastructure/` backup config first; do not assume).

A mounted volume (a new compose volume and an infrastructure change) is the alternative; it is an owner decision, listed under Open questions.

## Frontend

Static export, no server actions; the detail is `/feedback?id=7` (query-param routing, like `app/practice/day/page.tsx`). Read `node_modules/next/dist/docs/` before writing any Next code (`ai-trading/packages/family-desk/frontend/AGENTS.md`: this is not the Next.js the model knows).

- Routes: `frontend/app/feedback/page.tsx` (dashboard plus detail rail, `?id=`), `frontend/app/feedback/new/page.tsx`. Add both to `lib/lanes.ts` as `technical` like `/more` and `/settings` (the `More` group), and to the static-export allow-lists: `ai-trading/deploy/ci/upload-hub-static.sh` and its test `upload-hub-static.test.sh`, and `frontend/export-layout.test.mjs` (recent commits `e215d79f` and `bbc5e949` show a new route fails the static uploader until it is listed).
- Components under `frontend/components/feedback/`: `FeedbackScreen`, `FeedbackFilters` (type segmented, status chips with active chips filled amber and off chips amber-outlined, area select, search, sort), `FeedbackTable` (28 px rows, 2 px amber left edge on the selected row, hover `--color-raised` with `Open` and `Copy id`), `FeedbackDetailRail` (meta, description, links, screenshots, `StatusTimeline`), `FeedbackForm` with `SeverityRadios`, `CapturedContext`, `LinksField`, `ScreenshotsField`, and `SentPanel`. Data loaders in `lib/desk/feedback.ts` beside `lib/desk/replay.ts`; the context capture (screen, route, practice day, symbol, app version, time) in `lib/desk/feedbackContext.ts`, so the form never asks for what the Desk already knows. Regenerate the OpenAPI types with `pnpm gen:api` after the backend lands.
- Entry points: a `Feedback` section in the More/Settings left rail (the `R3 · Tech · Settings & More · desktop` pattern), an item in the avatar menu (`components/shell/DesktopNav.tsx`), and a `Report a problem` link at the right end of the 24 px status bar (`components/shell/Shell.tsx`); the link opens `/feedback/new` with the current route captured.
- States: empty ("No reports yet · file one when something looks wrong, or when you want something built"), loading, error (the Desk's existing fetch-error rows), uploading (progress bar, Send report disabled with `Reason: 1 screenshot is still uploading`), upload failed (`Upload failed · this file is 8.4 MB, the limit is 5 MB`, in the `--color-down` semantic colour and always with the words, never colour alone — the mock board shows a plain outline chip and P2 brings it onto the semantic colour — Retry and Remove), sent (`F-014`, `Sent · thanks, it's on the Desk's list`, `View it`, what was attached), and the agent states (`Claude Code is working on this · updated 2 h ago`; `Fixed in <hash> · shipped <date>`). The `--color-ai` colour appears only on the agent chip or note.
- Density: 02l §b4 desktop rules (28 px rows, 24 px minimum in rails, right-aligned tabular numbers, 48 px top bar, rails 280 and 320); the 44 px mobile target rule does not apply. No mobile layout.

## Status model and who may set what

Owner = an email listed in a new `DESK_OWNER_EMAILS` value of the `ai-trading/desk` Firestore profile (name only here; set it through `common/config/family_config.py`, never in the repository). Any other signed-in user is a filer.

| Transition | Who | Rules |
|---|---|---|
| (none) -> `open` | any signed-in user | by filing; writes the first event |
| `open` -> `in_progress` | owner, agents (CLI) | agents record `actor` (`claude-code` or `hermes`) |
| `in_progress` -> `open` | owner, agents | a pickup that was dropped |
| `open` or `in_progress` -> `fixed` | owner, agents | `fix_ref` required (7-40 hex characters for a commit, and/or `PR #nnn`) |
| `open` or `in_progress` -> `wont_fix` | owner only | `note` required (the reason she will read) |
| `open` or `in_progress` -> `duplicate` | owner only | `duplicate_of` required and must be a different existing id |
| `fixed`, `wont_fix`, `duplicate` -> `open` | owner only | a reopen; the old `fix_ref` stays in the events |

The filer can edit her own title, description, severity and links while the report is `open`, and nothing else; nobody edits or deletes another person's text. There are no replies or comments.

## Agent workflow (the important part)

Owner-triggered, once in a while, on the owner's request. There is no poller, no auto-fix and no automatic status change.

1. The owner says, in Hermes or Claude Code, "pick up the open feedback".
2. The agent lists the open reports with the backend CLI, rendered through the documented Firestore mechanism so no secret is printed: `common/config/family_config.py run ai-trading/desk -- uv run python -m ai_trading.cli.feedback list --status open --json` (run from `ai-trading/packages/family-desk/backend`). The same profile pattern `ai-trading/desk` is what `cli/replay_prep.py` documents for `DESK_RUNTIME_DATABASE_URL`. New file: `src/ai_trading/cli/feedback.py`, sibling of `replay_prep.py`.
3. Subcommands: `list [--status ...] [--json]`, `show F-014 [--json]`, `export F-014 --dir <path outside the repository>` (writes the screenshots so the agent can look at them; never inside the repository, which is public), `start F-014 --actor claude-code`, `fix F-014 --ref <commit and/or PR> --actor claude-code`, `wontfix F-014 --note "..."`, `duplicate F-014 --of F-009`. Every write goes through the same service functions as the API, so the transition rules above hold for the CLI too.
4. **No machine token over HTTP.** The Desk has no service-token mechanism (a search of `backend/src` for bearer or service-token handling finds none; identity is only the Caddy-verified header, `api/auth.py`). Inventing one would add an auth surface to a feature that does not need it, so the agents use the CLI against the database, and `PATCH /api/desk/feedback/{id}` is the owner's path in the UI under her Clerk identity. This replaces the brief's "CLI plus the authenticated PATCH" for agents; see Open questions.
5. Commit rule: a commit that fixes a report says so in the subject or body, `fix(desk): <what> (closes F-014)`, and the pull request description lists the ids. After the merge, the agent runs `fix F-014 --ref <merge or fix commit>`; the report then shows the reference to her.
6. The agent never sets `Won't fix` or `Duplicate` on its own judgment without the owner's say-so in the same session; the CLI requires `--actor` and writes it to the event.

## Relationship to DEFECTS.md

`ai-trading/DEFECTS.md` stays the **agent-side walkthrough ledger**: `D-nnn` ids written by Hermes or Claude during the owner's walkthroughs, owner-read. It is not deleted or restructured by this feature. The in-app log is the **user-filed** one, `F-nnn`. Cross-reference rule: a walkthrough defect that the owner wants tracked as a user-visible request gets an `F-nnn` row (filed by the owner through the form, with the `D-nnn` id in the description); a fix commit names the id it closes (`D-nnn` for the ledger, `F-nnn` for the log, both when both apply). Severity words are the same on both.

## Design index

Paper file TobyTest (`01M4K3AXAKQC8Z6JTW03YR5HEG`), page "Family Desk · R2 mockups" (`p-1-0`), a new row band below the practice boards (the lowest existing board ends at world y 54029), x step 1600 from the established leftmost column. The 13 MVP boards and every other existing board are unchanged. All three carry `SIMULATED DESIGN CONTENT` and `Source: designed fixture · no reports filed yet`.

| Board | Paper node | World position (x, y) | Size | Mocks |
|---|---|---|---|---|
| `R3 · Desk · Feedback · desktop` | `WGC-0` | -195.001, 54429.999 | 1440 x 1024 | `/feedback` dashboard with the `F-014` detail rail |
| `R3 · Desk · Feedback report · desktop` | `WP5-0` | 1404.999, 54429.999 | 1440 x 1654 | `/feedback/new` (the shell shows the form's first screen; the section below it is the scrolled rest) |
| `R3 · Desk · Feedback states · desktop` | `X32-0` | 3004.999, 54429.999 | 1440 x 820 | empty, upload failed, sent, agent picked it up |

Fixture caveat: the boards first showed `commit c42e4eb6`, which is a **real** commit in this repository (the hub fixes of STATUS 5M: D-008, D-009, D-016, D-017, D-030, D-035), not a fix for `F-014`. Corrected 2026-10-26: the three occurrences now read `commit 1a2b3c4`, which `git cat-file -e 1a2b3c4^{commit}` shows is **not** a commit in this repository, and the three hostname fixtures now read `trading.tobytran.dev`, the Desk's real hostname. These were the only two corrections; nothing else on the boards changed and the page node count stayed 30644.

Sync rule: this plan, `plans/STATUS.md` (row 5O) and the affected subplans (02l, 02m) move together in the same commit whenever the feature or the boards change.

## Phases

Each phase is its own pull request, opened only when the phase is finished (root `AGENTS.md`: conserve Actions minutes). Verification commands come from `ai-trading/AGENTS.md`.

- **P1: backend, migration, API, CLI, tests.** Files: `0010_feedback_log.py`, `db/models.py`, `api/feedback.py`, `api/schemas/feedback.py`, `api/app.py`, `cli/feedback.py`, the owner-emails setting, and tests (migration up and down, every transition including each forbidden one, 413/415/409 limits, magic-byte check, staged-file sweep, ownership and visibility, the 401 route-walk, CLI parity with the API). Acceptance, from `ai-trading/packages/family-desk/backend/`: `uv run ruff check . && uv run pytest -q` (Postgres via `scripts/test-db.sh`); regenerate `lib/api/openapi.json` with the existing dump; confirm the backup job covers `feedback_attachments`.
  - **P1 delivered 2026-10-26** on `feature/desk-feedback-p1` (migration `0010`, `ai_trading/feedback.py`, API, CLI, tests; the full backend suite is green). Backup confirmed: `infrastructure/backup/backup.sh` dumps every non-template database and leaves out only `*.replay_blobs` row data, so `feedback_attachments` is in the nightly dump. `lib/api/openapi.*` is P2's: its script (`frontend/scripts/gen-api.sh`) and output live in the frontend, and the CI `desk-web` job fails `git diff --exit-code -- lib/api` until they are regenerated.
- **P2: frontend routes and states.** Files as listed under Frontend. Acceptance, from `ai-trading/packages/family-desk/frontend/`: `pnpm gen:api`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm test:export`, then `pnpm test:e2e:desktop` (Playwright at 1440 and 1180: file a bug with a screenshot, file a request with none, upload over 5 MB shows the failure row, sent state, detail via `?id=`, each filter); after `pnpm build`, run `ai-trading/deploy/ci/upload-hub-static.test.sh` (the new routes are allowed). Compare the screens against the three Paper boards.
  - **P2 delivered 2026-10-26** on `feature/desk-feedback-p2`: `/feedback` and `/feedback/new` with every state on the three boards, the avatar-menu, Settings & More rail and status-bar entry points, and the static-export allow-lists; status is read-only in the UI in v1 (agents and the owner move it through the CLI), so an owner-only status editor is a later decision.
- **P3: agent bridge and the Hermes-owned walkthrough.** Hermes files one real bug and one real feature request through `/feedback/new` on the live Desk (test user), then drives `list`, `export`, `start`, `fix --ref` through the CLI and checks that the detail rail shows the timeline and the reference; it compares both screens against the three Paper boards and logs its findings in the walkthrough section of this plan. Acceptance: that walkthrough log, and the P1 and P2 commands green on the merged tree. No owner-walkthrough gate (see Ownership, QA and scale).

## Walkthrough log (Hermes-owned, P3)

Appended when P3 runs: the date, the two reports filed through `/feedback/new`, the screens compared against the three boards, every finding with its severity, and what was fixed. Empty until then. Findings that are cosmetic and out of scope go to `ai-trading/DEFECTS.md` as `D-nnn` rows instead.

## Rulings (closed 2026-10-26 by Hermes under the delegation above; do not reopen)

1. **Attachment storage:** `bytea` in the shared Postgres, exactly as `replay_blobs` does. No new compose volume and no infrastructure change — the compose file states the Desk has no private data volume, and the repository's precedent for binary payloads is already in the database.
2. **Who is the owner:** `DESK_OWNER_EMAILS` in the `ai-trading/desk` Firestore profile (names only in the repository; set through `common/config/family_config.py`). The Desk has no role concept and this feature does not add one.
3. **Visibility:** every signed-in family user reads every report. Two users share one flat log; per-user scoping would hide the owner's own reports from the other user.
4. **Agent write path:** the backend CLI, through the same service functions as the API, against the database. No new HTTP token and no new auth surface. If agents ever need HTTP, that is a separate decision with its own scoped token and header check — not this plan.
5. **List length and ids:** no hiding and no paging in the UI. The mock's `F-007`–`F-014` are simply the rows on the board; a real log starts at `F-001`, and at 20–50 reports one scrolling list is the whole design (see Ownership, QA and scale).
6. **Shell on `/feedback`:** the three boards keep `KSZ-0`'s convention (the first primary nav tab underlined) rather than inventing an active-nav treatment for one screen. If the live shell does the same, it is a known shell cosmetic and is logged in `DEFECTS.md`, not treated as a feedback-log defect.
