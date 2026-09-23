# Local Clerk Development Bootstrap

## Goal

Run local Expense Tax authentication against the existing Clerk Development
instance, isolated from production users, machines, and credentials. This is a
local verification task, not a production deployment or a new Clerk application.

## Current State

- [x] Clerk CLI authenticated and Expense Tax project linked to its existing Development instance.
- [x] Official Clerk MCP reachable from OpenCode and Claude Code.
- [x] Development publishable and secret keys pulled into ignored local environment files for the package root and Capture, Office, and Foundry frontends; permissions set to `0600`.
- [x] Local Compose settings use Development issuer, JWKS, and separate App and Foundry machine credentials; both service JWT verifiers accept live Development tokens.
- [x] Python and TypeScript token clients issue and validate live Development M2M tokens. Frontend builds and Compose configuration validation pass.

## Remaining Local Verification

- [ ] Start disposable local PostgreSQL and Temporal services with separate runtime and migration database credentials. Keep the unfinished TypeScript worker stopped until its workflow port is complete.
- [ ] Configure a Development-only signed Clerk webhook path to the local App API. Verify user, organization, and membership events, including replay, without connecting a production webhook.
- [ ] Sign in through local Capture, Office, and Foundry frontends using Development identities. Verify App and Foundry authorization against local PostgreSQL mappings and explicit Personal/business scope.
- [ ] Exercise one App API to Python worker to App API callback through the local queue. After the TypeScript worker cutover tasks, repeat the flow on its separate queue and namespace.
- [ ] Record reproducible local setup and smoke outcomes; keep every credential out of tracked files, logs, and test artifacts.

## Boundaries

- `pk_test_` and `sk_test_` belong to Development; production keys never enter local frontend builds.
- Clerk MCP supplies SDK guidance; CLI and service clients perform authenticated instance operations.
- Production deployment, production identities, and production webhook settings remain outside this task.
