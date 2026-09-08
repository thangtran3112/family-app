import {
  ProjectListSchema,
  ProjectSchema,
  type AuthenticatedUser,
  type Project,
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
const PROJECT_ID = "44444444-4444-4444-8444-444444444444";
const TIMESTAMP = "2026-09-08T00:00:00.000Z";
const PROJECT: Project = {
  id: PROJECT_ID,
  tenantId: TENANT_ID,
  businessId: BUSINESS_ID,
  name: "Renovation",
  clientName: "Acme",
  description: null,
  status: "active",
  startsOn: "2026-09-01",
  endsOn: null,
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

describe("App API project routes", () => {
  const apps = new Set<ReturnType<typeof buildApp>>();

  afterEach(async () => {
    await Promise.all([...apps].map((app) => app.close()));
    apps.clear();
  });

  function createTestApp() {
    const list = vi.fn(async () => [PROJECT]);
    const get = vi.fn(async () => PROJECT);
    const create = vi.fn(async () => PROJECT);
    const update = vi.fn(async () => ({ ...PROJECT, name: "Updated", version: 2 }));
    const archive = vi.fn(async () => ({
      ...PROJECT,
      status: "archived" as const,
      version: 2,
    }));
    const resolve = vi.fn(async (): Promise<AuthenticatedUser> => ({
      id: USER_ID,
      primaryEmail: "editor@example.test",
      displayName: "Editor",
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
      projectDomain: { archive, create, get, list, update },
    });
    apps.add(app);
    return { app, archive, create, get, list, update };
  }

  const auth = { authorization: "Bearer editor" };
  const collection = `/api/v1/tenants/${TENANT_ID}/businesses/${BUSINESS_ID}/projects`;

  it("lists and gets business-scoped projects", async () => {
    const { app, get, list } = createTestApp();
    const listed = await app.inject({ method: "GET", url: collection, headers: auth });
    const found = await app.inject({
      method: "GET",
      url: `${collection}/${PROJECT_ID}`,
      headers: auth,
    });

    expect(ProjectListSchema.parse(listed.json())).toEqual({ items: [PROJECT] });
    expect(ProjectSchema.parse(found.json())).toEqual(PROJECT);
    expect(list).toHaveBeenCalledWith(USER_ID, TENANT_ID, BUSINESS_ID);
    expect(get).toHaveBeenCalledWith(USER_ID, TENANT_ID, BUSINESS_ID, PROJECT_ID);
  });

  it("creates project without tax identity fields", async () => {
    const { app, create } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: collection,
      headers: auth,
      payload: { name: "Renovation", clientName: "Acme", startsOn: "2026-09-01" },
    });

    expect(response.statusCode).toBe(201);
    expect(ProjectSchema.parse(response.json())).toEqual(PROJECT);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: USER_ID,
        tenantId: TENANT_ID,
        businessId: BUSINESS_ID,
      }),
    );
  });

  it("rejects tax fields at route validation", async () => {
    const { app, create } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: collection,
      headers: auth,
      payload: { name: "Renovation", taxEntity: "sole_proprietor" },
    });

    expect(response.statusCode).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it("updates and archives with expected versions", async () => {
    const { app, archive, update } = createTestApp();
    const updated = await app.inject({
      method: "PATCH",
      url: `${collection}/${PROJECT_ID}`,
      headers: auth,
      payload: { expectedVersion: 1, name: "Updated" },
    });
    const archived = await app.inject({
      method: "DELETE",
      url: `${collection}/${PROJECT_ID}`,
      headers: auth,
      payload: { expectedVersion: 1 },
    });

    expect(updated.statusCode).toBe(200);
    expect(archived.statusCode).toBe(200);
    expect(update).toHaveBeenCalledOnce();
    expect(archive).toHaveBeenCalledOnce();
  });
});
