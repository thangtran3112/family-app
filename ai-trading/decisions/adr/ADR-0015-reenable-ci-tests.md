# ADR-0015: ai-trading CI runs the test gates again

Status: accepted 2026-11-01 (owner). Supersedes [ADR-0013](ADR-0013-ci-deployment-only.md) for ai-trading only. ADR-0013 is not edited; its expense-tax part stands.

Decision: `.github/workflows/ai-trading-ci.yml` returns and runs the Verification gates of `../AGENTS.md` on every pull request to `dev` and every push to `dev`. `main` stays deploy-only (`ai-trading-deploy.yml`), so a release never waits on these jobs.

Why: ADR-0013 removed the suites because Actions minutes were the cost. The owner confirmed the repository is public, and hosted-runner minutes are free for a public repository. The premise is gone, and with it the reason to leave a skipped gate as an unnoticed regression (ADR-0013, "Consequences").

The workflow, six parallel jobs, recovered from `97baa1b4^` (the last commit that had the file) and narrowed:

| Job | Gate |
|---|---|
| `desk-backend` | `uv run ruff check .` and `uv run pytest -q` in `packages/family-desk/backend`, with a Postgres 17 service and `DESK_REQUIRE_DB=1` so the DB tests run |
| `desk-contracts` | `pnpm typecheck` and `pnpm test` in `packages/family-desk/contracts` |
| `desk-frontend` | `pnpm typecheck` and `pnpm test` in `packages/family-desk/frontend` (installs the linked contracts first) |
| `hub-frontend` | `pnpm test` in `frontend` |
| `bridge` | `go vet ./...` and `go test -race -count=1 ./...` in `packages/market-data/bridge` |
| `common` | `uv run pytest -q` in `common` |

Not restored: the old `scripts`, `desk-e2e-services`, `desk-caddy-acceptance` and `images` jobs, lint, build and export checks, `buf lint`, `buf breaking`, generate drift, and the OpenAPI drift check. They stay local gates under ADR-0013's rules until an owner asks for them back.

Live provider test: `packages/market-data/bridge/internal/providers/alpaca/live_smoke_test.go` calls Alpaca's historical bars API (IEX feed, raw adjustment) and checks the response shape, ascending timestamps, unadjusted prices and a clean refusal for an invalid symbol. It reads `ALPACA_API_KEY_ID` and `ALPACA_API_SECRET_KEY` from the environment and skips when they are absent. CI has no provider keys, by design (secrets live in Firestore `family-config`), so the test is inside `go test ./...` and skips there. Run it locally with the keys from `family_config.py` (command in the file header).

Consequences: a failing gate now blocks a `dev` pull request visibly. The `dev` ruleset still requires the retired expense-tax status check "Contracts, services, workers, frontends" (ADR-0013, "Ruleset"); that is still the owner's to drop, and the new jobs are not required checks until the owner adds them. Expense-tax stays deployment-only. The path filter skips documentation-only changes, so those do not spend a run.
