import {
  BusinessTaxProfileSchema,
  TaxCategoryDefinitionListSchema,
  TaxonomyVersionListSchema,
  ExpenseTaxTreatmentSchema,
  type AuthenticatedUser,
  type BusinessTaxProfile,
  type ExpenseTaxTreatment,
  type TaxCategoryDefinition,
  type TaxonomyVersion,
} from "@expense-tax/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { AuthPrincipal, TokenVerifier } from "../src/auth/types.js";
import { createAppConfig } from "../src/config.js";

const TEST_ENV = {
  APP_TENANT_TOKEN_ISSUER: "https://identity.test",
  APP_TENANT_TOKEN_AUDIENCE: "expense-app",
  APP_TENANT_JWKS_URL: "https://identity.test/.well-known/jwks.json",
  APP_SERVICE_TOKEN_ISSUER: "https://services.test",
  APP_SERVICE_TOKEN_AUDIENCE: "expense-app-internal",
  APP_SERVICE_JWKS_URL: "https://services.test/.well-known/jwks.json",
  CLERK_ISSUER_URL: "https://clerk.test",
  CLERK_JWKS_URL: "https://clerk.test/.well-known/jwks.json",
  CLERK_TENANT_AUDIENCE: "tenant-audience",
  CLERK_PLATFORM_AUDIENCE: "platform-audience",
  CLERK_APP_SERVICE_AUDIENCE: "app-service-audience",
  CLERK_FOUNDRY_SERVICE_AUDIENCE: "foundry-service-audience",
  APP_DATABASE_URL: "postgresql://app-runtime.test/app",
};
const USER_ID = "11111111-1111-4111-8111-111111111111";
const TENANT_ID = "22222222-2222-4222-8222-222222222222";
const BUSINESS_ID = "33333333-3333-4333-8333-333333333333";
const EXPENSE_ID = "44444444-4444-4444-8444-444444444444";
const TAXONOMY_ID = "66666666-6666-4666-8666-666666666666";
const DEFINITION_ID = "77777777-7777-4777-8777-777777777777";
const TAX_PROFILE_ID = "88888888-8888-4888-8888-888888888888";
const TIMESTAMP = "2026-09-08T00:00:00.000Z";

const TAXONOMY: TaxonomyVersion = {
  id: TAXONOMY_ID,
  jurisdictionCode: "US-FEDERAL",
  taxYear: 2025,
  code: "schedule-c-2025",
  name: "2025 Schedule C",
  status: "active",
  sourceUrl: "https://www.irs.gov/forms-pubs/about-schedule-c-form-1040",
  sourceRevision: "2025-final",
  sourceChecksum: "a".repeat(64),
  createdAt: TIMESTAMP,
};
const DEFINITION: TaxCategoryDefinition = {
  id: DEFINITION_ID,
  taxonomyVersionId: TAXONOMY_ID,
  code: "advertising",
  name: "Advertising",
  description: null,
  officialForm: "Schedule C",
  officialLine: "8",
  status: "active",
  sortOrder: 1,
};
const PROFILE: BusinessTaxProfile = {
  id: TAX_PROFILE_ID,
  tenantId: TENANT_ID,
  businessId: BUSINESS_ID,
  taxYear: 2025,
  taxonomyVersionId: TAXONOMY_ID,
  taxForm: "schedule_c",
  accountingMethod: "cash",
  status: "active",
  version: 1,
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};
const TREATMENT: ExpenseTaxTreatment = {
  expenseId: EXPENSE_ID,
  tenantId: TENANT_ID,
  businessId: BUSINESS_ID,
  taxYear: 2025,
  businessTaxProfileId: TAX_PROFILE_ID,
  taxonomyVersionId: TAXONOMY_ID,
  taxCategoryDefinitionId: DEFINITION_ID,
  deductiblePercent: "75.00",
  reviewStatus: "reviewed",
  note: null,
  version: 1,
  createdByUserId: USER_ID,
  updatedByUserId: USER_ID,
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

function principal(subject: string): AuthPrincipal {
  return {
    tokenType: "tenant",
    subject,
    clientId: null,
    audience: "expense-app",
    issuer: "https://identity.test",
    roles: [],
    scopes: [],
    tokenId: `${subject}-token`,
    email: `${subject}@example.test`,
    emailVerified: true,
    displayName: subject,
  };
}

describe("App API taxonomy and tax routes", () => {
  const apps = new Set<ReturnType<typeof buildApp>>();

  afterEach(async () => {
    await Promise.all([...apps].map((app) => app.close()));
    apps.clear();
  });

  function createTestApp() {
    const listTaxonomies = vi.fn(async () => [TAXONOMY]);
    const listTaxCategories = vi.fn(async () => [DEFINITION]);
    const createProfile = vi.fn(async () => PROFILE);
    const getProfile = vi.fn(async () => PROFILE);
    const updateProfile = vi.fn(async () => ({ ...PROFILE, version: 2 }));
    const closeProfile = vi.fn(async () => undefined);
    const getTreatment = vi.fn(async () => TREATMENT);
    const upsertTreatment = vi.fn(async () => TREATMENT);
    const deleteTreatment = vi.fn(async () => undefined);
    const resolve = vi.fn(async (): Promise<AuthenticatedUser> => ({
      id: USER_ID,
      primaryEmail: "owner@example.test",
      displayName: "Owner",
      status: "active",
    }));
    const tenantVerifier: TokenVerifier = {
      verify: vi.fn(async (token) => principal(token)),
    };
    const app = buildApp({
      config: createAppConfig({ env: TEST_ENV, version: "test" }),
      logger: false,
      authVerifiers: {
        tenant: tenantVerifier,
        service: { verify: vi.fn(async () => { throw new Error("not used"); }) },
      },
      identityDomain: { provision: vi.fn(), resolve },
      taxDomain: {
        listTaxonomies,
        listTaxCategories,
        createProfile,
        getProfile,
        updateProfile,
        closeProfile,
        getTreatment,
        upsertTreatment,
        deleteTreatment,
      },
    });
    apps.add(app);
    return {
      app,
      createProfile,
      getTreatment,
      listTaxCategories,
      listTaxonomies,
      upsertTreatment,
    };
  }

  const auth = { authorization: "Bearer owner" };

  it("lists taxonomy versions and definitions", async () => {
    const { app, listTaxCategories, listTaxonomies } = createTestApp();
    const versions = await app.inject({
      method: "GET",
      url: "/api/v1/taxonomies",
      headers: auth,
    });
    const definitions = await app.inject({
      method: "GET",
      url: `/api/v1/taxonomies/${TAXONOMY_ID}/categories`,
      headers: auth,
    });

    expect(TaxonomyVersionListSchema.parse(versions.json())).toEqual({
      items: [TAXONOMY],
    });
    expect(TaxCategoryDefinitionListSchema.parse(definitions.json())).toEqual({
      items: [DEFINITION],
    });
    expect(listTaxonomies).toHaveBeenCalledOnce();
    expect(listTaxCategories).toHaveBeenCalledWith(TAXONOMY_ID);
  });

  it("creates Schedule C tax profile for explicit business and year", async () => {
    const { app, createProfile } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/tenants/${TENANT_ID}/businesses/${BUSINESS_ID}/tax-profiles`,
      headers: auth,
      payload: { taxYear: 2025, accountingMethod: "cash" },
    });

    expect(response.statusCode).toBe(201);
    expect(BusinessTaxProfileSchema.parse(response.json())).toEqual(PROFILE);
    expect(createProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: USER_ID,
        businessId: BUSINESS_ID,
        request: { taxYear: 2025, accountingMethod: "cash" },
      }),
    );
  });

  it("upserts business expense treatment", async () => {
    const { app, upsertTreatment } = createTestApp();
    const response = await app.inject({
      method: "PUT",
      url: `/api/v1/tenants/${TENANT_ID}/businesses/${BUSINESS_ID}/expenses/${EXPENSE_ID}/tax-treatment`,
      headers: auth,
      payload: {
        businessTaxProfileId: TAX_PROFILE_ID,
        taxonomyVersionId: TAXONOMY_ID,
        taxCategoryDefinitionId: DEFINITION_ID,
        deductiblePercent: "75.00",
        reviewStatus: "reviewed",
        note: null,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(ExpenseTaxTreatmentSchema.parse(response.json())).toEqual(TREATMENT);
    expect(upsertTreatment).toHaveBeenCalledWith(
      expect.objectContaining({ expenseId: EXPENSE_ID, businessId: BUSINESS_ID }),
    );
  });
});
