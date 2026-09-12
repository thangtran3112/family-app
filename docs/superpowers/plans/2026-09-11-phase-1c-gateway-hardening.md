# Phase 1C Gateway Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add portable, free-tier gateway defense in depth for the current Cloudflare Tunnel deployment without replacing Clerk, App API, Foundry, or service authorization.

**Architecture:** Keep Cloudflare limited to DNS, proxy/TLS, free Tunnel routing, and explicit host/path behavior. Put security headers, method policy, body limits, timeouts, and bounded in-process rate limits in the TypeScript services/frontends. Preserve loopback VPS origins and document the future GCP Load Balancer/Cloud Armor mapping without provisioning paid services.

**Tech Stack:** Terraform Cloudflare provider 5.x, Cloudflare Tunnel, Fastify 5, Next.js 16, TypeScript, Vitest, pnpm workspace.

**Spec:** `docs/superpowers/specs/2026-09-11-phase-1c-gateway-hardening-design.md`

## Global Constraints

- Cloudflare usage is restricted to the free tier plus domain registration.
- No Cloudflare Pro/Business/Enterprise upgrade.
- No paid Cloudflare Rate Limiting product.
- No managed WAF subscription or paid bot product.
- No Workers/edge functions for request processing.
- No paid Cloudflare Access/Zero Trust seats.
- No Traefik ForwardAuth deployment.
- No edge conversion of Clerk user tokens into Google IAM identity.
- No trusted plain `X-User-*` or `X-Tenant-*` headers from browsers.
- No removal or weakening of App API tenant/resource authorization.
- No removal or weakening of Foundry platform/service authorization.
- No database migration in this phase.
- No public exposure of VPS application ports.
- Paid GCP Cloud Armor remains optional and requires a separate cost decision.
- Existing unrelated `expense-tax-management/plans/mockups/**` files stay preserved; stage exact Phase 1C paths only.

---

### Task 1: Shared Bounded Gateway Policy

**Files:**
- Create: `expense-tax-management/packages/gateway-policy/package.json`
- Create: `expense-tax-management/packages/gateway-policy/tsconfig.json`
- Create: `expense-tax-management/packages/gateway-policy/src/index.ts`
- Create: `expense-tax-management/packages/gateway-policy/test/index.test.ts`
- Modify: `expense-tax-management/package.json`

**Interfaces:**
- Produces `GatewayRouteClass`, `GatewayLimit`, `GatewayRateDecision`, `GATEWAY_LIMITS`, `createGatewayRateLimiter()`, `authorizationRateKey()`, and `classifyGatewayRoute()`.
- `createGatewayRateLimiter({ clock? })` returns `{ check(routeClass, key): GatewayRateDecision, size(): number, clear(): void }`.
- `GatewayRateDecision` contains `allowed`, `limit`, `remaining`, and `retryAfterSeconds`.

- [ ] **Step 1: Write failing policy tests.**

Cover:

```ts
expect(GATEWAY_LIMITS.webhook.max).toBe(20);
expect(GATEWAY_LIMITS.api.max).toBe(120);
expect(GATEWAY_LIMITS.internal.max).toBe(300);
expect(GATEWAY_LIMITS.health.max).toBe(30);
```

Also cover fixed-window reset, remaining count, `Retry-After`, bounded map pruning, route classification for `/health/live`, `/health/ready`, `/api/v1/integrations/clerk/webhook`, `/internal/v1/*`, and ordinary API routes, plus authorization hashing that never returns the raw bearer value.

- [ ] **Step 2: Run focused tests and verify red.**

Run: `pnpm exec vitest run packages/gateway-policy/test/index.test.ts`

Expected: FAIL because package and exports do not exist.

- [ ] **Step 3: Implement minimal package.**

Use a `Map<string, { windowStartedAt: number; count: number }>` with fixed one-minute windows. Prune expired entries on every check when map size exceeds 1024 and expose `clear()` for tests. Hash an `Authorization` header with SHA-256; use `remoteAddress` only when no bearer header exists. Never store or log raw credentials.

- [ ] **Step 4: Wire workspace scripts.**

Add `@expense-tax/gateway-policy` to root `test`, `lint`, `typecheck`, and `build` scripts. Package scripts mirror contracts:

```json
{
  "test": "vitest run --dir test",
  "typecheck": "tsc --noEmit",
  "build": "tsc -p tsconfig.json",
  "lint": "eslint src test"
}
```

- [ ] **Step 5: Run policy and package checks.**

Run: `pnpm --filter @expense-tax/gateway-policy test && pnpm --filter @expense-tax/gateway-policy lint && pnpm --filter @expense-tax/gateway-policy typecheck && pnpm --filter @expense-tax/gateway-policy build`

Expected: all pass.

- [ ] **Step 6: Commit.**

```bash
git add expense-tax-management/packages/gateway-policy expense-tax-management/package.json
git commit -m "feat(gateway): add bounded free-tier policy"
```

### Task 2: App API Origin Hardening

**Files:**
- Create: `expense-tax-management/services/app-api/src/plugins/gateway-hardening.ts`
- Create: `expense-tax-management/services/app-api/test/gateway-hardening.test.ts`
- Modify: `expense-tax-management/services/app-api/src/app.ts`

**Interfaces:**
- `registerGatewayHardening(app)` installs `onRequest` rate checks and `onSend` security headers.
- It consumes `classifyGatewayRoute`, `createGatewayRateLimiter`, and `authorizationRateKey` from `@expense-tax/gateway-policy`.
- Rejected rate-limit requests return `429` with `Retry-After`; no auth principal is created and no route handler runs.

- [ ] **Step 1: Write failing App API tests.**

Build the existing test app with the plugin and assert:

```ts
expect(response.headers["x-content-type-options"]).toBe("nosniff");
expect(response.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
expect(response.headers["x-frame-options"]).toBe("DENY");
expect(response.headers["permissions-policy"]).toContain("camera=(self)");
expect(response.headers["cache-control"]).toBe("no-store");
```

Test route classes, 429 after the exact configured threshold, `Retry-After`, no raw authorization leakage, and no effect on existing 401/403 auth decisions. Verify the existing webhook 1 MiB cap and upload/inbound-email route-specific limits remain unchanged.

- [ ] **Step 2: Run focused tests and verify red.**

Run: `pnpm --filter @expense-tax/app-api test -- test/gateway-hardening.test.ts`

Expected: FAIL because plugin is absent.

- [ ] **Step 3: Implement plugin and server bounds.**

Construct Fastify with `bodyLimit: 1024 * 1024`, `connectionTimeout: 15000`, and `keepAliveTimeout: 5000`; preserve route-specific larger limits already declared by file and inbound-email routes. Register the plugin after error handling and before route registration. Set headers on every response:

```text
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
X-Frame-Options: DENY
Permissions-Policy: camera=(self), microphone=(), geolocation=()
Strict-Transport-Security: max-age=31536000; includeSubDomains
Cache-Control: no-store
```

Do not add CSP here; frontend Clerk domains/assets need a separate verified policy.

- [ ] **Step 4: Run App API verification.**

Run: `pnpm --filter @expense-tax/app-api test`, `pnpm --filter @expense-tax/app-api lint`, and `pnpm --filter @expense-tax/app-api typecheck`.

Expected: all existing and new tests pass.

- [ ] **Step 5: Commit.**

```bash
git add expense-tax-management/services/app-api/src/app.ts expense-tax-management/services/app-api/src/plugins/gateway-hardening.ts expense-tax-management/services/app-api/test/gateway-hardening.test.ts
git commit -m "feat(gateway): harden App API origin"
```

### Task 3: Foundry Service Origin Hardening

**Files:**
- Create: `expense-tax-management/services/foundry-service/src/plugins/gateway-hardening.ts`
- Create: `expense-tax-management/services/foundry-service/test/gateway-hardening.test.ts`
- Modify: `expense-tax-management/services/foundry-service/src/app.ts`

**Interfaces:**
- Same `registerGatewayHardening(app)` behavior as App API, using the shared package and no user identity headers.
- Foundry platform and service auth-check routes retain exact audience/role/source checks.

- [ ] **Step 1: Write failing Foundry tests.**

Assert the same five security headers, no-store behavior, route-class limits, 429 response, and unchanged platform/service 401/403 behavior through existing injected test routes.

- [ ] **Step 2: Run focused tests and verify red.**

Run: `pnpm --filter @expense-tax/foundry-service test -- test/gateway-hardening.test.ts`

Expected: FAIL because plugin is absent.

- [ ] **Step 3: Implement and register plugin.**

Use the same 1 MiB default JSON/body limit, 15-second connection timeout, 5-second keep-alive timeout, headers, and bounded local limiter. Foundry's existing route-specific behavior remains authoritative.

- [ ] **Step 4: Run Foundry verification.**

Run: `pnpm --filter @expense-tax/foundry-service test`, `pnpm --filter @expense-tax/foundry-service lint`, and `pnpm --filter @expense-tax/foundry-service typecheck`.

- [ ] **Step 5: Commit.**

```bash
git add expense-tax-management/services/foundry-service/src/app.ts expense-tax-management/services/foundry-service/src/plugins/gateway-hardening.ts expense-tax-management/services/foundry-service/test/gateway-hardening.test.ts
git commit -m "feat(gateway): harden Foundry origin"
```

### Task 4: Frontend Security Headers and Free-Tier Route Matrix

**Files:**
- Modify: `expense-tax-management/frontend/capture-web/next.config.ts`
- Modify: `expense-tax-management/frontend/office-web/next.config.ts`
- Modify: `expense-tax-management/frontend/foundry-web/next.config.ts`
- Create: `expense-tax-management/scripts/check-phase-1c-gateway.mjs`
- Create: `expense-tax-management/scripts/check-phase-1c-gateway.test.mjs`
- Modify: `expense-tax-management/package.json`
- Modify: `infrastructure/cloudflare/expense-tax/README.md`
- Modify: `infrastructure/cloudflare/expense-tax/main.tf` only if static route assertions require a correction

**Interfaces:**
- Each Next config exports the same `headers()` policy for `/:path*` without CSP.
- `check-phase-1c-gateway.mjs` exports `checkPhase1cGateway()` and fails on paid Cloudflare resources, paid Cloudflare product references, public origin ports, route-order regressions, missing frontend headers, or route-matrix drift.

- [ ] **Step 1: Write failing static checks.**

Assert:

```js
expect(source).toContain('X-Content-Type-Options');
expect(source).toContain('Referrer-Policy');
expect(source).toContain('X-Frame-Options');
expect(source).toContain('Permissions-Policy');
expect(terraform).toContain('path     = "/internal/v1/*"');
expect(terraform).toContain('service  = "http://127.0.0.1:8200"');
expect(terraform).toContain('http_status:404');
expect(terraform).not.toMatch(/cloudflare_(access|worker|waf|rate_limit)/u);
```

Also assert all five hostnames, loopback origins, no public bind (`0.0.0.0:7301`, etc.), and free-tier cost boundary text.

- [ ] **Step 2: Run checks and verify red.**

Run: `pnpm exec vitest run scripts/check-phase-1c-gateway.test.mjs`

Expected: FAIL until headers/checker/docs are added.

- [ ] **Step 3: Add frontend headers.**

Implement `headers()` in all three Next configs with the shared header values from Task 2. Do not add CSP, cookie changes, auth changes, or paid Cloudflare configuration.

- [ ] **Step 4: Add route/cost static checker and docs.**

The checker reads Terraform, production compose, three Next configs, and the Phase 1C design. Add root script:

```json
"check:phase-1c-gateway": "node scripts/check-phase-1c-gateway.mjs"
```

Document that free Cloudflare Tunnel/DNS/proxy are allowed and paid WAF/rate-limit/Workers/Cloud Armor require separate approval.

- [ ] **Step 5: Run frontend and static verification.**

Run: `pnpm exec vitest run scripts/check-phase-1c-gateway.test.mjs`, all three frontend test/lint/typecheck/build commands, and `git diff --check`.

- [ ] **Step 6: Commit.**

```bash
git add expense-tax-management/frontend/*/next.config.ts expense-tax-management/scripts/check-phase-1c-gateway.mjs expense-tax-management/scripts/check-phase-1c-gateway.test.mjs expense-tax-management/package.json infrastructure/cloudflare/expense-tax/README.md infrastructure/cloudflare/expense-tax/main.tf
git commit -m "feat(gateway): enforce free-tier route policy"
```

### Task 5: Full Verification and Deployment Gate

**Files:**
- Modify: `docs/superpowers/plans/2026-09-11-phase-1c-gateway-hardening.md` with evidence only after implementation
- Modify: `.superpowers/sdd/2026-09-11-phase-1c-gateway-hardening/progress.md`

- [ ] **Step 1: Run full local verification.**

Run:

```bash
pnpm test
pnpm lint
pnpm typecheck
pnpm build
pnpm exec vitest run scripts/check-phase-1c-gateway.test.mjs
git diff --check
```

Expected: zero failures; pre-existing skipped tests remain identified rather than silently changed.

- [ ] **Step 2: Verify free-tier Terraform plan.**

Run Terraform formatting, backend-disabled validation, and plan inspection. Confirm plan contains no Cloudflare paid product resources, no public origin bind, and only expected Tunnel/DNS changes. Do not apply without explicit user approval after plan review.

- [ ] **Step 3: Verify public behavior locally/externally.**

Check all five HTTPS hosts, public health, security headers, unsupported methods, unknown paths, expected Clerk `401`/`403`, webhook `202`/replay, and direct VPS port non-reachability. Never print tokens or payloads.

- [ ] **Step 4: Update evidence and commit.**

Record commands, results, cost boundary, and any deferred GCP-specific work in the SDD ledger. Stage only Phase 1C plan/ledger files and commit:

```bash
git commit -m "docs(gateway): record phase 1c verification"
```

- [ ] **Step 5: Push reviewed code and request deployment approval after plan review.**

After required Terraform inputs are provided, run and inspect the reviewed free-tier plan. Only then push reviewed code and docs and request explicit deployment approval. Apply only after approval. Public production probes require separate approval.

#### Task 5 Evidence (2026-09-11)

- Local root verification from `expense-tax-management`: `pnpm test` passed with 445 tests passed and 1 pre-existing skipped Foundry database test; `pnpm lint`, `pnpm typecheck`, and `pnpm build` passed.
- Phase 1C static verification passed: `pnpm exec vitest run scripts/check-phase-1c-gateway.test.mjs` passed 6 tests; `pnpm check:phase-1c-gateway` passed.
- Terraform local checks passed in `infrastructure/cloudflare/expense-tax`: `terraform fmt -check -recursive .`, `terraform init -backend=false`, and `terraform validate`.
- **Step 2 incomplete:** Terraform plan did not execute because required Terraform inputs/credentials were absent: `cloudflare_account_id` was unavailable and the required variables were not supplied. No credentials were printed, invented, or used to contact Cloudflare. Static inspection is supplemental only and cannot prove plan contents; it confirms declared Tunnel, Tunnel config, DNS, and loopback origins, with no paid Cloudflare product resource or public origin bind declared.
- `git diff --check` passed.
- Public HTTPS host, health, header, method, path, Clerk authorization, webhook, and direct-port checks were deferred. User explicitly prohibited external production probes without separate approval.
- No Terraform plan, apply, deployment, Cloudflare/GCP mutation, push, or deployment-approval request was executed. **Step 5 incomplete:** no approval was requested or granted because no reviewed plan was available.
- Next action, in order: provide required Terraform plan inputs/credentials; run and inspect the free-tier plan; request explicit deployment approval; apply only after approval. Public production probes require separate approval.
- Deferred GCP-specific work: future GCP Load Balancer/Cloud Armor mapping remains documentation/design only; paid Cloud Armor requires separate cost and deployment approval.
