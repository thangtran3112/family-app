import {
  ExpenseListSchema,
  ExpenseSchema,
  type AuthenticatedUser,
  type Expense,
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
  CLERK_APP_SERVICE_SUBJECT: "ai-worker-app-machine",
  CLERK_FOUNDRY_SERVICE_SUBJECT: "ai-worker-foundry-machine",
  APP_DATABASE_URL: "postgresql://app-runtime.test/app",
};
const USER_ID = "11111111-1111-4111-8111-111111111111";
const TENANT_ID = "22222222-2222-4222-8222-222222222222";
const PROFILE_ID = "33333333-3333-4333-8333-333333333333";
const BUSINESS_ID = "44444444-4444-4444-8444-444444444444";
const EXPENSE_ID = "55555555-5555-4555-8555-555555555555";
const TIMESTAMP = "2026-09-08T00:00:00.000Z";

const EXPENSE: Expense = {
  id: EXPENSE_ID,
  tenantId: TENANT_ID,
  createdByUserId: USER_ID,
  personalProfileId: PROFILE_ID,
  businessId: null,
  projectId: null,
  spendingCategoryId: null,
  merchant: "Market",
  description: null,
  amount: "12.50",
  currency: "USD",
  incurredOn: "2025-03-01",
  taxYear: 2025,
  source: "manual",
  status: "ready",
  version: 1,
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

describe("App API expense routes", () => {
  const apps = new Set<ReturnType<typeof buildApp>>();

  afterEach(async () => {
    await Promise.all([...apps].map((app) => app.close()));
    apps.clear();
  });

  function createTestApp() {
    const createPersonal = vi.fn(async () => EXPENSE);
    const createBusiness = vi.fn(async () => ({
      ...EXPENSE,
      personalProfileId: null,
      businessId: BUSINESS_ID,
    }));
    const listPersonal = vi.fn(async () => ({ items: [EXPENSE], nextCursor: null }));
    const listBusiness = vi.fn(async () => ({ items: [], nextCursor: null }));
    const updatePersonal = vi.fn(async () => ({ ...EXPENSE, version: 2 }));
    const archivePersonal = vi.fn(async () => ({ ...EXPENSE, status: "archived" as const }));
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
      expenseDomain: {
        createPersonal,
        createBusiness,
        listPersonal,
        listBusiness,
        updatePersonal,
        archivePersonal,
      },
    });
    apps.add(app);
    return {
      app,
      createBusiness,
      createPersonal,
      listBusiness,
      listPersonal,
    };
  }

  const auth = { authorization: "Bearer owner" };

  it("creates Personal expenses under explicit profile scope", async () => {
    const { app, createPersonal } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/tenants/${TENANT_ID}/personal-profiles/${PROFILE_ID}/expenses`,
      headers: auth,
      payload: {
        personalProfileId: PROFILE_ID,
        merchant: "Market",
        amount: "12.50",
        currency: "USD",
        incurredOn: "2025-03-01",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(ExpenseSchema.parse(response.json())).toEqual(EXPENSE);
    expect(createPersonal).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: USER_ID,
        tenantId: TENANT_ID,
        profileId: PROFILE_ID,
      }),
    );
  });

  it("lists business expenses with cursor envelope", async () => {
    const { app, listBusiness } = createTestApp();
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/tenants/${TENANT_ID}/businesses/${BUSINESS_ID}/expenses?limit=25&sort=amount`,
      headers: auth,
    });

    expect(response.statusCode).toBe(200);
    expect(ExpenseListSchema.parse(response.json())).toEqual({
      items: [],
      nextCursor: null,
    });
    expect(listBusiness).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: USER_ID, businessId: BUSINESS_ID }),
    );
  });

  it("rejects ambiguous expense scope before domain mutation", async () => {
    const { app, createPersonal } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/tenants/${TENANT_ID}/personal-profiles/${PROFILE_ID}/expenses`,
      headers: auth,
      payload: {
        personalProfileId: PROFILE_ID,
        businessId: BUSINESS_ID,
        merchant: "Ambiguous",
        amount: "12.50",
        currency: "USD",
        incurredOn: "2025-03-01",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(createPersonal).not.toHaveBeenCalled();
  });

  it("creates business expenses under explicit business scope", async () => {
    const { app, createBusiness } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/tenants/${TENANT_ID}/businesses/${BUSINESS_ID}/expenses`,
      headers: auth,
      payload: {
        businessId: BUSINESS_ID,
        merchant: "Supplier",
        amount: "12.50",
        currency: "USD",
        incurredOn: "2025-03-01",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(createBusiness).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: USER_ID, businessId: BUSINESS_ID }),
    );
  });
});
