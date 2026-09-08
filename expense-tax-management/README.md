# Expense Tax Management

Self-hosted expense management monorepo for households, freelancers, and small
 businesses. Phase 0I contains canonical Zod contracts, TypeScript App and Foundry
 services, generated Python DTOs, and isolated PostgreSQL service roles. Phase 0J
 Waves 1-2 add provider-neutral identities, tenant and Personal memberships,
 business industries, business memberships, industry-specific spending categories,
 projects, invitations, audit records, and idempotent App API bootstrap.

## Prerequisites

- Node.js 22 or newer and pnpm 11.9
- Python 3.13 or newer and uv
- Docker with Compose

## Setup

```bash
pnpm install --frozen-lockfile
cd common/python/expense-contracts
uv sync --frozen
```

Configure local values through `.env`; `.env.example` documents required keys.
Use the repository wrapper for Compose operations:

```bash
pnpm compose:up
pnpm compose:down
```

## Phase 0I Verification

Full completion verification requires the local PostgreSQL service and enables
all database-boundary integration checks:

```bash
PHASE_0I_INTEGRATION=1 pnpm verify:phase-0i
```

Running without `PHASE_0I_INTEGRATION=1` executes non-database gates, reports the
required PostgreSQL check as skipped, and exits unsuccessfully.

## Phase 0J Wave 1 Verification

Full Wave 1 verification includes the Phase 0I regression gate, real PostgreSQL
authorization and concurrency checks, generated-contract drift, the App API
Docker build, and credential-boundary audits:

```bash
PHASE_0I_INTEGRATION=1 PHASE_0J_INTEGRATION=1 pnpm verify:phase-0j:wave1
```

Running without `PHASE_0J_INTEGRATION=1` reports the required Wave 1 PostgreSQL
check as skipped and exits unsuccessfully.

## Phase 0J Wave 2 Verification

Full Wave 2 verification includes Wave 1 regression, industry-specific category
seed and bootstrap checks, business memberships and invitations, spending
categories, projects, generated-contract drift, Docker build, and credential
boundaries:

```bash
PHASE_0I_INTEGRATION=1 PHASE_0J_INTEGRATION=1 PHASE_0J_WAVE2_INTEGRATION=1 pnpm verify:phase-0j:wave2
```

Running without `PHASE_0J_WAVE2_INTEGRATION=1` reports the required Wave 2
PostgreSQL check as skipped and exits unsuccessfully.

## Phase 0J Waves 3-4 Verification

Full local Phase 0J verification includes expenses, 2025 Schedule C taxonomy,
business tax profiles, tax treatments, cursor pagination, generated artifacts,
all prior waves, Docker build, readiness, and credential boundaries:

```bash
PHASE_0I_INTEGRATION=1 PHASE_0J_INTEGRATION=1 PHASE_0J_WAVE2_INTEGRATION=1 PHASE_0J_WAVE3_INTEGRATION=1 PHASE_0J_WAVE4_INTEGRATION=1 pnpm verify:phase-0j:wave4
```

Production gateway, VPS, GCP, and shared infrastructure remain outside this
local gate.
