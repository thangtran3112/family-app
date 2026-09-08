import {
  BusinessBootstrapSchema,
  BusinessIndustryListSchema,
  BusinessListSchema,
  SmallBusinessSchema,
  type AuthenticatedUser,
  type BusinessBootstrap,
  type BusinessIndustry,
  type SmallBusiness,
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
  APP_DATABASE_URL: "postgresql://app-runtime.test/app",
};
const USER_ID = "11111111-1111-4111-8111-111111111111";
const TENANT_ID = "22222222-2222-4222-8222-222222222222";
const BUSINESS_ID = "33333333-3333-4333-8333-333333333333";
const TIMESTAMP = "2026-09-08T00:00:00.000Z";

const BUSINESS: SmallBusiness = {
  id: BUSINESS_ID,
  tenantId: TENANT_ID,
  name: "Corner Cafe",
  industryCode: "restaurant",
  timezone: "America/New_York",
  baseCurrency: "USD",
  status: "active",
  version: 1,
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};
const INDUSTRIES: BusinessIndustry[] = [
  { code: "restaurant", name: "Restaurant", status: "active" },
];
const BOOTSTRAP: BusinessBootstrap = {
  business: BUSINESS,
  businessMembership: {
    businessId: BUSINESS_ID,
    tenantId: TENANT_ID,
    userId: USER_ID,
    role: "owner",
    status: "active",
    version: 1,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  },
  createdSpendingCategories: [],
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

describe("App API business routes", () => {
  const apps = new Set<ReturnType<typeof buildApp>>();

  afterEach(async () => {
    await Promise.all([...apps].map((app) => app.close()));
    apps.clear();
  });

  function createTestApp() {
    const create = vi.fn(async () => ({
      statusCode: 201 as const,
      body: BOOTSTRAP,
      replayed: false,
    }));
    const list = vi.fn(async () => [BUSINESS]);
    const get = vi.fn(async () => BUSINESS);
    const update = vi.fn(async (input: { request: { expectedVersion: number } }) => ({
      ...BUSINESS,
      name: "Updated Cafe",
      version: input.request.expectedVersion + 1,
    }));
    const archive = vi.fn(async (input: { request: { expectedVersion: number } }) => ({
      ...BUSINESS,
      status: "archived" as const,
      version: input.request.expectedVersion + 1,
    }));
    const listIndustries = vi.fn(async () => INDUSTRIES);
    const resolve = vi.fn(async (): Promise<AuthenticatedUser> => ({
      id: USER_ID,
      primaryEmail: "owner@example.test",
      displayName: "Owner",
      status: "active",
    }));
    const tenantVerifier: TokenVerifier = { verify: vi.fn(async (token) => principal(token)) };
    const serviceVerifier: TokenVerifier = {
      verify: vi.fn(async () => {
        throw new Error("service token not accepted");
      }),
    };
    const app = buildApp({
      config: createAppConfig({ env: TEST_ENV, version: "test" }),
      logger: false,
      authVerifiers: { tenant: tenantVerifier, service: serviceVerifier },
      identityDomain: { provision: vi.fn(), resolve },
      businessDomain: { archive, create, get, list, listIndustries, update },
    });
    apps.add(app);
    return { app, archive, create, get, list, listIndustries, update };
  }

  const auth = { authorization: "Bearer owner" };

  it("lists stable industries for an authenticated user", async () => {
    const { app, listIndustries } = createTestApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/business-industries",
      headers: auth,
    });

    expect(response.statusCode).toBe(200);
    expect(BusinessIndustryListSchema.parse(response.json())).toEqual({ items: INDUSTRIES });
    expect(listIndustries).toHaveBeenCalledOnce();
  });

  it("creates business bootstrap state with idempotency", async () => {
    const { app, create } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/tenants/${TENANT_ID}/businesses`,
      headers: { ...auth, "idempotency-key": "business-create-1" },
      payload: {
        name: " Corner Cafe ",
        industryCode: "restaurant",
        timezone: "America/New_York",
        baseCurrency: "USD",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(BusinessBootstrapSchema.parse(response.json())).toEqual(BOOTSTRAP);
    expect(create).toHaveBeenCalledWith({
      actorUserId: USER_ID,
      tenantId: TENANT_ID,
      idempotencyKey: "business-create-1",
      request: {
        name: "Corner Cafe",
        industryCode: "restaurant",
        timezone: "America/New_York",
        baseCurrency: "USD",
      },
      requestId: expect.any(String),
    });
  });

  it("lists and gets only domain-authorized businesses", async () => {
    const { app, get, list } = createTestApp();
    const listResponse = await app.inject({
      method: "GET",
      url: `/api/v1/tenants/${TENANT_ID}/businesses`,
      headers: auth,
    });
    const getResponse = await app.inject({
      method: "GET",
      url: `/api/v1/tenants/${TENANT_ID}/businesses/${BUSINESS_ID}`,
      headers: auth,
    });

    expect(BusinessListSchema.parse(listResponse.json())).toEqual({ items: [BUSINESS] });
    expect(SmallBusinessSchema.parse(getResponse.json())).toEqual(BUSINESS);
    expect(list).toHaveBeenCalledWith(USER_ID, TENANT_ID);
    expect(get).toHaveBeenCalledWith(USER_ID, TENANT_ID, BUSINESS_ID);
  });

  it("updates and archives with expected versions", async () => {
    const { app, archive, update } = createTestApp();
    const updateResponse = await app.inject({
      method: "PATCH",
      url: `/api/v1/tenants/${TENANT_ID}/businesses/${BUSINESS_ID}`,
      headers: auth,
      payload: { expectedVersion: 1, name: "Updated Cafe" },
    });
    const archiveResponse = await app.inject({
      method: "DELETE",
      url: `/api/v1/tenants/${TENANT_ID}/businesses/${BUSINESS_ID}`,
      headers: auth,
      payload: { expectedVersion: 2 },
    });

    expect(updateResponse.statusCode).toBe(200);
    expect(archiveResponse.statusCode).toBe(200);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: USER_ID }));
    expect(archive).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: USER_ID }));
  });
});
