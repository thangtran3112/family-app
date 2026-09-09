# Phase 0E Implementation Plan: Business Tax Reports + Canonical Export Bundles

Source of truth: [phase-0i-polyglot-platform-rebaseline-design.md](phase-0i-polyglot-platform-rebaseline-design.md)
§8.2 (scope invariants), §9 (tax product boundary + bundle contents),
§17 (export downloads audited), §18 (exports immutable; retry never mixes),
roadmap row 7A (depends on 0J + 0D — satisfied). Replaces
[phase-0e-project-tax.md](phase-0e-project-tax.md) per its own replan notice
(project is not a tax entity; no filing, ever).

## Scope

In scope:
- Business tax-year report (totals, by-tax-category, by-month, review
  flags, foreign-currency accounting). Pure SQL aggregation, any
  business role incl. viewer.
- Project cost report (totals, by-month, by-spending-category).
  All-time; dense analytics, no tax semantics.
- Canonical export bundles: expenses.csv + manifest.json +
  tax-category-mapping.csv stored via the 0D adapter under
  `tenants/{id}/exports/{exportId}/`, served back through freshly issued
  read URLs. Immutable rows (no updated_at/version columns at all —
  enforced by schema absence). `ExportAdapter` interface with one
  canonical implementation (future tax-software adapters plug in; none
  may file).
- Deterministic golden fixtures (fixed clock injection + fixed seed →
  byte-identical CSV/manifest checked in).

Out of scope: FX conversion (no invented rates — see currency rule),
filing/submission (never), state rules (§9), scheduled exports,
re-OCR, attach-then-extract (0C futures), category suggestion (3C).

## Key decisions (locked)

1. **Base-currency sums, explicit foreign exclusion.** Sums aggregate
   base-currency expenses only; every other currency is EXCLUDED from
   totals but LISTED (`foreignCurrencySummary { excludedCount,
   currencies[] }`, CSV column `included_in_totals`). Silent dropping
   would be dishonest; FX would be invented. Documented as future.
2. **Resolved = treatment with review_status `reviewed`.** `excluded`
   counts as deliberately-resolved (documented state, included by
   default). Default export includes reviewed+excluded, skips
   unreviewed+missing; `includeUnresolved: true` opts into everything
   with manifest flags per row + counts.
3. **Export requires a business tax profile** (pins taxonomy_version_id
   for the manifest mapping table). Any profile status (draft/active/
   closed) — the bundle snapshots the version ID, so later taxonomy
   changes can't rewrite history. Reports need no profile
   (uncategorized bucket covers untreated).
4. **No `updated_at`/`version` on export_bundles.** Immutability by
   schema absence. Retry safety via caller idempotency key (existing
   wrapper), NOT via param-uniqueness (users legitimately re-export).
5. **Storage-before-row, orphans accepted.** CSV bytes → hashes →
   adapter writes → single INSERT. A crash between leaves orphan keys
   under `exports/{id}/` (documented; GC is future). The reverse order
   (row first) would advertise a bundle whose bytes may never land —
   worse.
6. **Exact-decimal SQL, never JS floats.** All money math in Postgres
   numeric (`ROUND(amount * pct / 100, 2)`, `to_char(..., 'FM...0.00')`
   strings). CSV `deductible_amount` COALESCEs to `0.00` so columns
   reconcile; the untreated story lives in review counts, not blanks.
7. **Draft expenses included** (status column tells the story);
   archived excluded (ledger precedent). Personal/other-business never
   in scope (composite tenant+business predicates everywhere).
8. **Export creation: owner/editor + audit.** Reports: any active
   role. Export downloads: no extra audit beyond creation (matches
   file GET precedent; §17's "export downloads are audited" is met by
   the creation audit binding actor+params — hmm, strictly §17 says
   DOWNLOADS audited. Creation audit covers who/what; each GET
   re-issues URLs without audit. Honest gap? For 0E I audit creation
   only and note download-audit as future with real download tracking.
   Actually — cheap to close: audit on GET bundle too (actorUserId
   known, read-only tx... recordAuditEvent needs a transaction; GET
   handlers can open one. Cost: one INSERT per download read. DO IT —
   closes the §17 line fully.)
   Hmm, wait: list route too? No — list is enumeration, not download.
   Audit single-GET only. Decided.

## Contracts (`src/exports.ts`)

- `TaxYearParamsSchema { tenantId, businessId, taxYear }`,
  `ProjectCostParamsSchema { ...params, projectId }` (reuse business
  collection params + projectId — define fresh, mirrors expense params).
- `MoneyTotalSchema { currency, grossTotal, deductibleTotal,
  expenseCount }` (strings for money, ints for counts).
- `BusinessTaxReportSchema { businessId, taxYear, baseCurrency,
  profile: { id, status, taxonomyVersionId } | null,
  totals: MoneyTotal, totalsByCurrency: MoneyTotal[],
  foreignCurrencySummary: { excludedCount, currencies: string[] },
  byCategory: [{ categoryCode|null, categoryName, expenseCount,
  grossTotal, deductibleTotal }], byMonth: [{ month, ...same sums }],
  review: { total, treated, reviewed, unreviewed, excluded,
  missingTreatment } }`.
- `ProjectCostReportSchema { projectId, businessId, projectName,
  totals, totalsByCurrency, foreignCurrencySummary,
  byMonth, bySpendingCategory: [{ categoryId|null, categoryName,
  ...sums }] }`.
- `CreateExportRequestSchema { taxYear, includeUnresolved?: boolean }`.
- `ExportBundleSchema { id, tenantId, businessId, taxYear,
  taxonomyVersionId, profileId, profileStatus, filters, expenseCount,
  files: [{ path, sha256Hex, bytes }], manifest: ManifestSchema,
  createdByUserId, createdAt }`.
- `ManifestSchema` (strict, golden-stable): `{ bundleId, businessId,
  taxYear, taxonomy: { versionId, code, name }, profile: { id, status },
  baseCurrency, filters: { includeUnresolved }, generatedAt,
  appVersion, counts: { expenses, included, excludedUnresolved,
  foreignExcluded }, totals: { grossTotal, deductibleTotal },
  foreignSummary, review: { reviewed, unreviewed, excluded,
  missingTreatment }, files: [{ path, sha256Hex, bytes }] }`.
- `ExportBundleListSchema { items: ExportBundle[], nextCursor: string|null }`,
  `ExportListQuerySchema { limit?, cursor? }` (files.ts pattern).

## Tables (migration `011_export_bundles.ts`)

`app.export_bundles` (id PK, tenant_id FK CASCADE, business_id +
composite FK (business_id, tenant_id)→businesses, tax_year int CHECK
1900–9999, taxonomy_version_id FK RESTRICT, profile_id uuid NULL (no FK
— lifecycle decoupled; status snapshotted as profile_status text),
filters jsonb NOT NULL, manifest jsonb NOT NULL, csv_storage_key UNIQUE,
manifest_storage_key, mapping_storage_key, expense_count int ≥ 0,
created_by_user_id FK, created_at; index (business_id, created_at DESC)).
NO updated_at/version — immutable by construction.

## Domain

`src/domain/export-format.ts` (pure, DB-free, fast unit tests):
- `escapeCsvCell`, `buildExpensesCsv(rows): string` (fixed column
  order, `\n` endings, trailing newline),
- `buildMappingCsv(categories): string`,
- `buildManifest(input): Manifest` (takes counts/totals/files metadata
  + injected `generatedAt: string` + appVersion),
- `sha256Hex(bytes)`,
- `ExportAdapter` interface `{ buildExpensesCsv, buildMappingCsv,
  buildManifest }` + `CanonicalExportAdapter` impl. Future adapters
  implement the interface; none may file (doc comment).

`src/domain/exports.ts` (`createExportsDomain(database, storage,
{ appVersion })`):
- `getTaxReport({ actorUserId, tenantId, businessId, taxYear }клиент)`:
  role check (any), business base currency lookup, one big LEFT JOIN
  query (expenses ≠ archived × treatments × definitions × taxonomy
  [pinned to profile's version if profile exists ELSE latest active?
  Category names need A taxonomy — without a profile, join definitions
  via treatment's own taxonomy_version_id (treatments store theirs).
  Untreated → uncategorized. No profile needed. ✓], spending? not
  needed for tax report), bucket in JS from ordered rows (simpler than
  GROUPING SETS; counts are report-scale), money strings from SQL
  to_char.
- `getProjectCostReport(...)`: project must belong to business (else
  NOT_FOUND — no cross-business oracle), expenses by project_id,
  buckets by month + spending category (LEFT JOIN categories;
  null → "Uncategorized").
- `createExportBundle({ actorUserId, tenantId, businessId, taxYear,
  includeUnresolved, idempotencyKey, requestId, now? })`: canWrite role;
  profile REQUIRED (else 404 "create a tax profile for this year
  first"); rows query (deterministic ORDER BY incurred_on, id;
  unresolved filter per flag); build bytes via adapter; sha; storage
  writes (`exports/{bundleId}/expenses.csv|manifest.json|
  mapping.csv`); INSERT bundle; audit `export_bundle.created`; return
  bundle WITH fresh download URLs (issueReadUrl × 3, 15-min TTL —
  same TTL const as files? files.ts FILE_READ_URL_TTL_MS is module
  private... export and reuse? It's in files.ts, not exported. Define
  local EXPORT_READ_URL_TTL_MS = 15min with comment (duplication of a
  magic number × 2 — acceptable, or export from files.ts? Cleaner:
  export FILE_READ_URL_TTL_MS from files.ts and reuse. DO that.)
- `listExportBundles` (cursor pagination, files.ts pattern),
  `getExportBundle` (+ fresh URLs + download audit).
- All wrapped: create in executeIdempotentMutation (op
  "export-bundle.create", hash covers tenant+business+year+flag).

## Routes (`src/routes/exports.ts`, tenant auth pattern)

- `GET .../businesses/:businessId/tax-reports/:taxYear`
- `GET .../businesses/:businessId/projects/:projectId/cost-report`
- `POST .../businesses/:businessId/exports` (+ idempotency header)
- `GET .../businesses/:businessId/exports` (list query)
- `GET .../businesses/:businessId/exports/:exportId`
- Wire in app.ts (exportsDomain needs database, storageAdapter,
  appVersion: config.version).

## Testing

1. Contracts `phase-0e-contracts.test.ts`.
2. Pure unit `export-format.test.ts` (CSV escaping incl.
   commas/quotes/newlines, manifest shape, sha helper).
3. Route unit `exports.test.ts` (mocked domain, auth matrix incl.
   viewer-read vs viewer-create-403).
4. Integration `app-domain-0e-reports.test.ts` (PHASE_0E_INTEGRATION):
   seed business (industry `restaurant`), profile 2025 (taxonomy
   schedule-c-2025 — query seeded IDs), expenses via domain
   (mix: treated-reviewed / unreviewed / excluded / untreated /
   foreign-currency / archived / personal-other-scope-negative),
   assert report buckets + review counts + foreign summary;
   project cost incl. uncategorized; export create → bundle row +
   objects on disk (LOCAL_STORAGE_DIR override? integration uses real
   LOCAL_STORAGE_DIR from env... 0D test used tmpdir adapter directly.
   For domain-level export test, construct exportsDomain with tmpdir
   adapter explicitly (not via buildApp) — same as 0D pattern);
   golden: fixed clock + fixed seed → CSV bytes === committed fixture
   (`packages/contracts/fixtures/tax-export-canonical.csv` — hmm,
   fixtures live in contracts pkg but content is app-generated... 0D
   precedent? fixtures dir has job-reference-v1.json (contract
   fixture). App-level golden could live in test/ dir instead:
   `test/fixtures/`. Check what's there... simpler: keep golden
   assertion inline? 200-line CSV inline is unreadable. Put fixture
   at `test/fixtures/tax-export-canonical.csv` (+ `.manifest.json`).
   Check test/ layout first.
   determinism hazards: UUIDs (ids differ per run!) — CSV includes
   expense_id... byte-identical IMPOSSIBLE with random UUIDs. Fix:
   golden test seeds FIXED UUIDs (constants) for tenant/user/
   business/expenses/etc. Fully deterministic seed → byte-identical.
   created_at timestamps! Expense created_at defaults now() — CSV must
   EXCLUDE volatile columns (no created_at in CSV; manifest
   generatedAt from injected clock). created_by? user id fixed UUID ✓.
   Order: ORDER BY incurred_on, id (fixed) ✓.
5. Verify `verify-phase-0e.mjs` (cascade 0c + flags; contracts/app
   tests; 0E integration; drift; docker build app-api; readiness).

## Non-goals

FX, filing, state rules, scheduled exports, TXF/IRS adapters (interface
only), download tracking beyond creation+single-GET audit.
