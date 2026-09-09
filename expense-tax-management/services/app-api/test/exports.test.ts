import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { AuthPrincipal, TokenVerifier } from "../src/auth/types.js";
import { createAppConfig } from "../src/config.js";
import type { ExportsDomain } from "../src/domain/exports.js";

const TEST_ENV = {
  APP_TENANT_TOKEN_ISSUER: "https://identity.test",
  APP_TENANT_TOKEN_AUDIENCE: "expense-app",
  APP_TENANT_JWKS_URL: "https://identity.test/.well-known/jwks.json",
  APP_SERVICE_TOKEN_ISSUER: "https://services.test",
  APP_SERVICE_TOKEN_AUDIENCE: "expense-app-internal",
  APP_SERVICE_JWKS_URL: "https://services.test/.well-known/jwks.json",
  APP_DATABASE_URL: "postgresql://app-runtime.test/app",
  TEMPORAL_HOST: "127.0.0.1:7233",
  TEMPORAL_NAMESPACE: "default",
  STORAGE_BACKEND: "local",
  LOCAL_STORAGE_DIR: "/tmp/expense-tax-exports-test",
  STORAGE_LOCAL_BASE_URL: "http://127.0.0.1:8100",
  STORAGE_URL_SIGNING_KEY: "test-signing-key-not-secret",
};

const TENANT_ID = "22222222-2222-4222-8222-222222222222";
const BUSINESS_ID = "33333333-3333-4333-8333-333333333333";
const PROJECT_ID = "44444444-4444-4444-8444-444444444444";
const EXPORT_ID = "55555555-5555-4555-8555-555555555555";
const TAXONOMY_ID = "66666666-6666-4666-8666-666666666666";
const PROFILE_ID = "77777777-7777-4777-8777-777777777777";
const ACTOR_USER_ID = "88888888-8888-4888-8888-888888888888";
const TIMESTAMP = "2026-09-08T00:00:00.000Z";

const REPORT = {
  businessId: BUSINESS_ID,
  taxYear: 2025,
  baseCurrency: "USD",
  profile: null,
  totals: { currency: "USD", grossTotal: "0.00", deductibleTotal: "0.00", expenseCount: 0 },
  totalsByCurrency: [],
  foreignCurrencySummary: { excludedCount: 0, currencies: [] },
  byCategory: [],
  byMonth: [],
  review: { total: 0, treated: 0, reviewed: 0, unreviewed: 0, excluded: 0, missingTreatment: 0 },
};

const BUNDLE = {
  id: EXPORT_ID,
  tenantId: TENANT_ID,
  businessId: BUSINESS_ID,
  taxYear: 2025,
  taxonomyVersionId: TAXONOMY_ID,
  profileId: PROFILE_ID,
  profileStatus: "active",
  filters: { includeUnresolved: false },
  expenseCount: 1,
  manifest: {
    bundleId: EXPORT_ID,
    businessId: BUSINESS_ID,
    taxYear: 2025,
    taxonomy: { versionId: TAXONOMY_ID, code: "schedule-c-2025", name: "2025 Schedule C" },
    profile: { id: PROFILE_ID, status: "active" },
    baseCurrency: "USD",
    filters: { includeUnresolved: false },
    createdAt: TIMESTAMP,
    appVersion: "test",
    counts: { expenses: 1, included: 1, excludedUnresolved: 0, foreignExcluded: 0 },
    totals: { grossTotal: "12.34", deductibleTotal: "12.34" },
    foreignSummary: { excludedCount: 0, currencies: [] },
    review: { total: 1, treated: 1, reviewed: 1, unreviewed: 0, excluded: 0, missingTreatment: 0 },
    files: [],
  },
  files: [],
  createdByUserId: ACTOR_USER_ID,
  createdAt: TIMESTAMP,
};

function tenantPrincipal(): AuthPrincipal {
  return {
    tokenType: "tenant",
    subject: "identity-subject",
    clientId: null,
    audience: "expense-app",
    issuer: "https://identity.test",
    roles: [],
    scopes: [],
    tokenId: "tenant-token-id",
    email: "owner@example.test",
    emailVerified: true,
    displayName: "Owner",
  };
}

describe("App API report/export routes", () => {
  const apps = new Set<ReturnType<typeof buildApp>>();

  afterEach(async () => {
    await Promise.all([...apps].map((app) => app.close()));
    apps.clear();
  });

  function createTestApp() {
    const exportsDomain: ExportsDomain = {
      getTaxReport: vi.fn(async () => REPORT),
      getProjectCostReport: vi.fn(async () => ({
        projectId: PROJECT_ID,
        businessId: BUSINESS_ID,
        projectName: "Client work",
        baseCurrency: "USD",
        totals: { currency: "USD", grossTotal: "0.00", deductibleTotal: "0.00", expenseCount: 0 },
        totalsByCurrency: [],
        foreignCurrencySummary: { excludedCount: 0, currencies: [] },
        byMonth: [],
        bySpendingCategory: [],
      })),
      createExportBundle: vi.fn(async () => ({
        statusCode: 201 as const,
        body: BUNDLE,
        replayed: false,
      })),
      listExportBundles: vi.fn(async () => ({ items: [BUNDLE], nextCursor: null })),
      getExportBundle: vi.fn(async () => BUNDLE),
    };
    const resolve = vi.fn(async () => ({
      id: ACTOR_USER_ID,
      primaryEmail: "owner@example.test",
      displayName: "Owner",
      status: "active" as const,
    }));
    const tenantVerifier: TokenVerifier = {
      verify: vi.fn(async (token) => {
        if (token !== "tenant-token") throw new Error("wrong token");
        return tenantPrincipal();
      }),
    };
    const app = buildApp({
      config: createAppConfig({ env: TEST_ENV, version: "test" }),
      logger: false,
      authVerifiers: {
        tenant: tenantVerifier,
        service: { verify: vi.fn(async () => { throw new Error("unused"); }) },
      },
      identityDomain: { provision: vi.fn(), resolve },
      exportsDomain,
    });
    apps.add(app);
    return { app, exportsDomain };
  }

  const business = `/api/v1/tenants/${TENANT_ID}/businesses/${BUSINESS_ID}`;

  it("reads a tax report for an authenticated tenant user", async () => {
    const { app, exportsDomain } = createTestApp();
    const response = await app.inject({
      method: "GET",
      url: `${business}/tax-reports/2025`,
      headers: { authorization: "Bearer tenant-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().taxYear).toBe(2025);
    expect(exportsDomain.getTaxReport).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: ACTOR_USER_ID,
        tenantId: TENANT_ID,
        businessId: BUSINESS_ID,
        taxYear: 2025,
      }),
    );
  });

  it("rejects a malformed tax year before touching the domain", async () => {
    const { app, exportsDomain } = createTestApp();
    const response = await app.inject({
      method: "GET",
      url: `${business}/tax-reports/not-a-year`,
      headers: { authorization: "Bearer tenant-token" },
    });

    expect(response.statusCode).toBe(400);
    expect(exportsDomain.getTaxReport).not.toHaveBeenCalled();
  });

  it("reads a project cost report", async () => {
    const { app, exportsDomain } = createTestApp();
    const response = await app.inject({
      method: "GET",
      url: `${business}/projects/${PROJECT_ID}/cost-report`,
      headers: { authorization: "Bearer tenant-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(exportsDomain.getProjectCostReport).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: PROJECT_ID }),
    );
  });

  it("creates an export bundle with an idempotency key", async () => {
    const { app, exportsDomain } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: `${business}/exports`,
      headers: {
        authorization: "Bearer tenant-token",
        "idempotency-key": "export-1",
      },
      payload: { taxYear: 2025 },
    });

    expect(response.statusCode).toBe(201);
    expect(exportsDomain.createExportBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: ACTOR_USER_ID,
        taxYear: 2025,
        idempotencyKey: "export-1",
      }),
    );
  });

  it("rejects unauthenticated export creation", async () => {
    const { app, exportsDomain } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: `${business}/exports`,
      headers: { "idempotency-key": "export-1" },
      payload: { taxYear: 2025 },
    });

    expect(response.statusCode).toBe(401);
    expect(exportsDomain.createExportBundle).not.toHaveBeenCalled();
  });

  it("lists and reads export bundles", async () => {
    const { app, exportsDomain } = createTestApp();
    const listed = await app.inject({
      method: "GET",
      url: `${business}/exports?limit=10`,
      headers: { authorization: "Bearer tenant-token" },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items).toHaveLength(1);

    const read = await app.inject({
      method: "GET",
      url: `${business}/exports/${EXPORT_ID}`,
      headers: { authorization: "Bearer tenant-token" },
    });
    expect(read.statusCode).toBe(200);
    expect(exportsDomain.getExportBundle).toHaveBeenCalledWith(
      expect.objectContaining({ exportId: EXPORT_ID }),
    );
  });
});
