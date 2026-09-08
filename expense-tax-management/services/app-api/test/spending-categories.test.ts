import {
  SpendingCategoryListSchema,
  SpendingCategorySchema,
  type AuthenticatedUser,
  type SpendingCategory,
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
const CATEGORY_ID = "33333333-3333-4333-8333-333333333333";
const TIMESTAMP = "2026-09-08T00:00:00.000Z";
const CATEGORY: SpendingCategory = {
  id: CATEGORY_ID,
  tenantId: TENANT_ID,
  templateKey: null,
  name: "Supplies",
  description: "Operating supplies",
  color: "#2563EB",
  icon: "package",
  status: "active",
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

describe("App API spending category routes", () => {
  const apps = new Set<ReturnType<typeof buildApp>>();

  afterEach(async () => {
    await Promise.all([...apps].map((app) => app.close()));
    apps.clear();
  });

  function createTestApp() {
    const list = vi.fn(async () => [CATEGORY]);
    const create = vi.fn(async () => CATEGORY);
    const update = vi.fn(async () => ({ ...CATEGORY, name: "Materials", version: 2 }));
    const archive = vi.fn(async () => ({
      ...CATEGORY,
      status: "archived" as const,
      version: 2,
    }));
    const resolve = vi.fn(async (): Promise<AuthenticatedUser> => ({
      id: USER_ID,
      primaryEmail: "owner@example.test",
      displayName: "Owner",
      status: "active",
    }));
    const tenantVerifier: TokenVerifier = { verify: vi.fn(async (token) => principal(token)) };
    const app = buildApp({
      config: createAppConfig({ env: TEST_ENV, version: "test" }),
      logger: false,
      authVerifiers: {
        tenant: tenantVerifier,
        service: { verify: vi.fn(async () => { throw new Error("not used"); }) },
      },
      identityDomain: { provision: vi.fn(), resolve },
      spendingCategoryDomain: { archive, create, list, update },
    });
    apps.add(app);
    return { app, archive, create, list, update };
  }

  const auth = { authorization: "Bearer owner" };

  it("lists tenant-scoped categories", async () => {
    const { app, list } = createTestApp();
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/tenants/${TENANT_ID}/spending-categories`,
      headers: auth,
    });

    expect(SpendingCategoryListSchema.parse(response.json())).toEqual({ items: [CATEGORY] });
    expect(list).toHaveBeenCalledWith(USER_ID, TENANT_ID);
  });

  it("creates a custom tenant category", async () => {
    const { app, create } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/tenants/${TENANT_ID}/spending-categories`,
      headers: auth,
      payload: {
        name: " Supplies ",
        description: "Operating supplies",
        color: "#2563EB",
        icon: "package",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(SpendingCategorySchema.parse(response.json())).toEqual(CATEGORY);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: USER_ID, tenantId: TENANT_ID }),
    );
  });

  it("updates and archives with expected versions", async () => {
    const { app, archive, update } = createTestApp();
    const updated = await app.inject({
      method: "PATCH",
      url: `/api/v1/tenants/${TENANT_ID}/spending-categories/${CATEGORY_ID}`,
      headers: auth,
      payload: { expectedVersion: 1, name: "Materials" },
    });
    const archived = await app.inject({
      method: "DELETE",
      url: `/api/v1/tenants/${TENANT_ID}/spending-categories/${CATEGORY_ID}`,
      headers: auth,
      payload: { expectedVersion: 1 },
    });

    expect(updated.statusCode).toBe(200);
    expect(archived.statusCode).toBe(200);
    expect(update).toHaveBeenCalledOnce();
    expect(archive).toHaveBeenCalledOnce();
  });
});
