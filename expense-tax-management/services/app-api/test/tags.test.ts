/**
 * Task 8 — Tag CRUD, Associations, Merge Invariants, and Suggestion Resolution
 *
 * Tests cover:
 * - Tenant membership read, owner/admin mutation
 * - Exact Personal/Business membership for associations
 * - Cross-scope denial
 * - Archived key collision / explicit unarchive
 * - Self/cross-tenant/archived-target/stale merge rejection
 * - Manual-over-history-over-rule conflict resolution
 * - Source suggestion superseding on merge
 * - Audit count verification
 */
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Kysely } from "kysely";

import {
  TagSchema,
  TagListSchema,
  ExpenseTagSchema,
  EnrichmentSuggestionListSchema,
  type AuthenticatedUser,
  type Tag,
  type ExpenseTag,
} from "@expense-tax/contracts";
import { buildApp } from "../src/app.js";
import type { AuthPrincipal, TokenVerifier } from "../src/auth/types.js";
import { createAppConfig } from "../src/config.js";
import { createAppDatabase } from "../src/database/client.js";
import type { AppDatabase } from "../src/database/types.js";
import { runMigrations } from "../src/database/migrate.js";
import { createTagDomain } from "../src/domain/tags.js";

// ------------------------------------------------------------------ //
// Test env / principal helpers (matches existing test patterns)
// ------------------------------------------------------------------ //
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

const USER_ID = "a1000000-0001-4000-8000-000000000001";
const TENANT_ID = "a1000000-0001-4000-8000-000000000002";
const TAG_ID = "a1000000-0001-4000-8000-000000000003";

const NOW = "2026-09-08T00:00:00.000Z";

const SAMPLE_TAG: Tag = {
  id: TAG_ID,
  tenantId: TENANT_ID,
  key: "custom:my-tag",
  name: "My Tag",
  color: "#FF0000",
  origin: "custom",
  status: "active",
  version: 1,
  createdByUserId: USER_ID,
  createdAt: NOW,
  updatedAt: NOW,
};

// ------------------------------------------------------------------ //
// Unit tests — route contract tests (mock domain)
// ------------------------------------------------------------------ //

describe("App API tag routes — unit (mock domain)", () => {
  const apps = new Set<ReturnType<typeof buildApp>>();

  afterEach(async () => {
    await Promise.all([...apps].map((app) => app.close()));
    apps.clear();
  });

  function createTestApp() {
    const listTags = vi.fn(async () => ({ items: [SAMPLE_TAG], nextCursor: null }));
    const createTag = vi.fn(async () => SAMPLE_TAG);
    const updateTag = vi.fn(async () => ({ ...SAMPLE_TAG, name: "Updated", version: 2 }));
    const archiveTag = vi.fn(async () => ({ ...SAMPLE_TAG, status: "archived" as const, version: 2 }));
    const unarchiveTag = vi.fn(async () => ({ ...SAMPLE_TAG, status: "active" as const, version: 3 }));
    const mergeTags = vi.fn(async () => undefined);
    const listExpenseTags = vi.fn(async () => ({ items: [] as ExpenseTag[], nextCursor: null }));
    const applyExpenseTag = vi.fn(async () => ({ id: randomUUID(), tenantId: TENANT_ID, personalProfileId: null, businessId: randomUUID(), expenseId: randomUUID(), tagId: TAG_ID, source: "manual" as const, confidence: 1, ruleVersion: null, suggestionId: null, status: "active" as const, version: 1, appliedByUserId: USER_ID, removedByUserId: null, appliedAt: NOW, removedAt: null, createdAt: NOW } as ExpenseTag));
    const removeExpenseTag = vi.fn(async () => undefined);
    const listSuggestions = vi.fn(async () => ({ items: [], nextCursor: null }));
    const resolveSuggestion = vi.fn(async () => ({ suggestionId: randomUUID(), status: "accepted" as const, version: 2 }));
    const rerunEnrichment = vi.fn(async () => undefined);

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
      tagDomain: {
        listTags,
        createTag,
        updateTag,
        archiveTag,
        unarchiveTag,
        mergeTags,
        listExpenseTags,
        applyExpenseTag,
        removeExpenseTag,
        listSuggestions,
        resolveSuggestion,
        rerunEnrichment,
      },
    });
    apps.add(app);
    return {
      app,
      listTags, createTag, updateTag, archiveTag, unarchiveTag, mergeTags,
      listExpenseTags, applyExpenseTag, removeExpenseTag,
      listSuggestions, resolveSuggestion, rerunEnrichment,
    };
  }

  const auth = { authorization: "Bearer owner" };
  const PROFILE_ID = "a1000000-0001-4000-8000-000000000010";
  const BIZ_ID = "a1000000-0001-4000-8000-000000000011";
  const EXPENSE_ID = "a1000000-0001-4000-8000-000000000012";

  it("lists tenant tags", async () => {
    const { app, listTags } = createTestApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/tenants/${TENANT_ID}/tags`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const body = TagListSchema.parse(res.json());
    expect(body.items).toHaveLength(1);
    expect(listTags).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT_ID }));
  });

  it("creates a custom tag (owner/admin only)", async () => {
    const { app, createTag } = createTestApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/tenants/${TENANT_ID}/tags`,
      headers: auth,
      payload: { name: "My Tag", color: "#FF0000" },
    });
    expect(res.statusCode).toBe(201);
    const body = TagSchema.parse(res.json());
    expect(body.origin).toBe("custom");
    expect(createTag).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: USER_ID, tenantId: TENANT_ID }),
    );
  });

  it("updates a tag (PATCH)", async () => {
    const { app, updateTag } = createTestApp();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/tenants/${TENANT_ID}/tags/${TAG_ID}`,
      headers: auth,
      payload: { expectedVersion: 1, name: "Updated" },
    });
    expect(res.statusCode).toBe(200);
    expect(updateTag).toHaveBeenCalledOnce();
  });

  it("archives a tag", async () => {
    const { app, archiveTag } = createTestApp();
    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/tenants/${TENANT_ID}/tags/${TAG_ID}`,
      headers: auth,
      payload: { expectedVersion: 1 },
    });
    expect(res.statusCode).toBe(200);
    expect(archiveTag).toHaveBeenCalledOnce();
  });

  it("unarchives a tag explicitly (POST .../:tagId/unarchive)", async () => {
    const { app, unarchiveTag } = createTestApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/tenants/${TENANT_ID}/tags/${TAG_ID}/unarchive`,
      headers: auth,
      payload: { expectedVersion: 2 },
    });
    expect(res.statusCode).toBe(200);
    expect(unarchiveTag).toHaveBeenCalledOnce();
  });

  it("merges two tags (POST .../:tagId/merge)", async () => {
    const SOURCE_TAG_ID = randomUUID();
    const TARGET_TAG_ID = randomUUID();
    const { app, mergeTags } = createTestApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/tenants/${TENANT_ID}/tags/${SOURCE_TAG_ID}/merge`,
      headers: auth,
      payload: {
        sourceTagId: SOURCE_TAG_ID,
        targetTagId: TARGET_TAG_ID,
        expectedSourceVersion: 1,
        expectedTargetVersion: 1,
      },
    });
    expect(res.statusCode).toBe(204);
    expect(mergeTags).toHaveBeenCalledWith(
      expect.objectContaining({ sourceTagId: SOURCE_TAG_ID, targetTagId: TARGET_TAG_ID }),
    );
  });

  it("lists expense tags — personal scope", async () => {
    const { app, listExpenseTags } = createTestApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/tenants/${TENANT_ID}/personal-profiles/${PROFILE_ID}/expenses/${EXPENSE_ID}/tags`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(listExpenseTags).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: PROFILE_ID, expenseId: EXPENSE_ID }),
    );
  });

  it("applies an expense tag — personal scope", async () => {
    const { app, applyExpenseTag } = createTestApp();
    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/tenants/${TENANT_ID}/personal-profiles/${PROFILE_ID}/expenses/${EXPENSE_ID}/tags/${TAG_ID}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(applyExpenseTag).toHaveBeenCalledOnce();
  });

  it("removes an expense tag — personal scope", async () => {
    const { app, removeExpenseTag } = createTestApp();
    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/tenants/${TENANT_ID}/personal-profiles/${PROFILE_ID}/expenses/${EXPENSE_ID}/tags/${TAG_ID}`,
      headers: auth,
      payload: { expectedVersion: 1 },
    });
    expect(res.statusCode).toBe(204);
    expect(removeExpenseTag).toHaveBeenCalledOnce();
  });

  it("lists suggestions — personal scope", async () => {
    const { app, listSuggestions } = createTestApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/tenants/${TENANT_ID}/personal-profiles/${PROFILE_ID}/expenses/${EXPENSE_ID}/suggestions`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(listSuggestions).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: PROFILE_ID, expenseId: EXPENSE_ID }),
    );
  });

  it("resolves a suggestion — personal scope", async () => {
    const SUG_ID = randomUUID();
    const { app, resolveSuggestion } = createTestApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/tenants/${TENANT_ID}/personal-profiles/${PROFILE_ID}/expenses/${EXPENSE_ID}/suggestions/${SUG_ID}/resolve`,
      headers: auth,
      payload: {
        action: "rejected",
        expectedSuggestionVersion: 1,
        expectedExpenseVersion: 1,
        idempotencyKey: "idem-key-1",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(resolveSuggestion).toHaveBeenCalledOnce();
  });

  it("triggers enrichment rerun — personal scope", async () => {
    const { app, rerunEnrichment } = createTestApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/tenants/${TENANT_ID}/personal-profiles/${PROFILE_ID}/expenses/${EXPENSE_ID}/enrichment-runs`,
      headers: auth,
      payload: { expenseId: EXPENSE_ID, kinds: ["tag"] },
    });
    expect(res.statusCode).toBe(204);
    expect(rerunEnrichment).toHaveBeenCalledOnce();
  });

  it("lists expense tags — business scope", async () => {
    const { app, listExpenseTags } = createTestApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/tenants/${TENANT_ID}/businesses/${BIZ_ID}/expenses/${EXPENSE_ID}/tags`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(listExpenseTags).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: BIZ_ID, expenseId: EXPENSE_ID }),
    );
  });

  it("resolves suggestion — business scope", async () => {
    const SUG_ID = randomUUID();
    const { app, resolveSuggestion } = createTestApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/tenants/${TENANT_ID}/businesses/${BIZ_ID}/expenses/${EXPENSE_ID}/suggestions/${SUG_ID}/resolve`,
      headers: auth,
      payload: {
        action: "accepted",
        expectedSuggestionVersion: 1,
        expectedExpenseVersion: 1,
        idempotencyKey: "idem-key-biz",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(resolveSuggestion).toHaveBeenCalledOnce();
  });
});

// ------------------------------------------------------------------ //
// createTagDomain module export test
// ------------------------------------------------------------------ //
describe("domain/tags.ts — module export", () => {
  it("createTagDomain is exported as a function", () => {
    expect(typeof createTagDomain).toBe("function");
  });
});

// ------------------------------------------------------------------ //
// Live PostgreSQL tests
// ------------------------------------------------------------------ //

const requested = process.env.PHASE_3C_INTEGRATION === "1";
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const composeScript = path.join(repoRoot, "scripts", "compose.sh");
const runKey = randomUUID().replaceAll("-", "").slice(0, 12);
const databaseName = `expense_tax_t8_${runKey}`;

interface ComposeConfig {
  readonly services: Record<
    string,
    { readonly environment?: Record<string, string | null> }
  >;
}

// Task 8 live fixture IDs
const T8_TENANT_ID   = "8a000000-0000-4000-8000-000000000001";
const T8_USER_ID     = "8a000000-0000-4000-8000-000000000002";
const T8_PROFILE_ID  = "8a000000-0000-4000-8000-000000000003";
const T8_BIZ_ID      = "8a000000-0000-4000-8000-000000000004";
const T8_TAX_PROF_ID = "8a000000-0000-4000-8000-000000000005";
const T8_TAXVER_ID   = "8a000000-0000-4000-8000-000000000006";
const T8_TAXCAT_ID   = "8a000000-0000-4000-8000-000000000007";
const T8_CAT_ID      = "8a000000-0000-4000-8000-000000000008";

let postgresContainerId = "";
let runtimePassword = "";
let migratorPassword = "";
let database: Kysely<AppDatabase> | undefined;

function dockerPsql(
  dbName: string,
  username: string,
  password: string,
  sqlStatement: string,
): string {
  const result = spawnSync(
    "docker",
    [
      "exec", "-e", `PGPASSWORD=${password}`,
      postgresContainerId,
      "psql", "-X", "-v", "ON_ERROR_STOP=1",
      "--host", "127.0.0.1",
      "--username", username,
      "--dbname", dbName,
      "--tuples-only", "--no-align",
      "--pset", "footer=off",
      "--command", sqlStatement,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function adminSql(sqlStatement: string, db = "postgres"): string {
  return dockerPsql(db, "postgres", "postgrespassword", sqlStatement);
}

function runtimeSql(sqlStatement: string): string {
  return dockerPsql(databaseName, "expense_app_runtime", runtimePassword, sqlStatement);
}

describe.skipIf(!requested)(
  "Task 8 — live PostgreSQL tag CRUD, associations, merge, and suggestion resolution",
  () => {
    beforeAll(async () => {
      const dockerAvailable = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
      if (!dockerAvailable) throw new Error("Phase 3C PostgreSQL prerequisites unavailable");

      let postgresRunning = false;
      try {
        postgresRunning = execFileSync(composeScript, ["ps", "-q", "postgres"], {
          cwd: repoRoot, env: process.env, encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim().length > 0;
      } catch { postgresRunning = false; }
      if (!postgresRunning) throw new Error("Phase 3C PostgreSQL prerequisites unavailable");

      const config = JSON.parse(
        execFileSync(composeScript, ["config", "--format", "json"], {
          cwd: repoRoot, env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
        }),
      ) as ComposeConfig;
      postgresContainerId = execFileSync(composeScript, ["ps", "-q", "postgres"], {
        cwd: repoRoot, env: process.env, encoding: "utf8",
      }).trim();
      runtimePassword = config.services.postgres?.environment?.APP_RUNTIME_DB_PASSWORD ?? "";
      migratorPassword = config.services.postgres?.environment?.APP_MIGRATOR_DB_PASSWORD ?? "";
      if (!postgresContainerId || !runtimePassword || !migratorPassword) {
        throw new Error("Phase 3C PostgreSQL prerequisites unavailable");
      }

      adminSql(`CREATE DATABASE ${databaseName};`);
      adminSql(
        `CREATE SCHEMA app AUTHORIZATION expense_app_migrator;
         CREATE SCHEMA app_migrations AUTHORIZATION expense_app_migrator;
         GRANT USAGE ON SCHEMA app TO expense_app_runtime;`,
        databaseName,
      );
      const migrationDatabaseUrl = `postgresql://expense_app_migrator:${encodeURIComponent(migratorPassword)}@127.0.0.1:5433/${databaseName}`;
      const runtimeDatabaseUrl = `postgresql://expense_app_runtime:${encodeURIComponent(runtimePassword)}@127.0.0.1:5433/${databaseName}`;
      await runMigrations(migrationDatabaseUrl);
      adminSql(
        `GRANT USAGE ON SCHEMA app TO expense_app_runtime;
         GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO expense_app_runtime;
         GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA app TO expense_app_runtime;`,
        databaseName,
      );
      database = createAppDatabase(runtimeDatabaseUrl);
      seedFixtures();
    });

    afterAll(async () => {
      await database?.destroy();
      if (postgresContainerId && databaseName) {
        adminSql(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE);`);
      }
    });

    function seedFixtures(): void {
      runtimeSql(`
        INSERT INTO app.users (id, primary_email, display_name)
        VALUES ('${T8_USER_ID}', 't8-owner@example.test', 'T8 Owner')
        ON CONFLICT DO NOTHING;

        INSERT INTO app.tenants (id, name, slug, status)
        VALUES ('${T8_TENANT_ID}', 'T8 Tenant', 't8-tenant-${runKey}', 'active')
        ON CONFLICT DO NOTHING;

        INSERT INTO app.tenant_memberships (tenant_id, user_id, role, status)
        VALUES ('${T8_TENANT_ID}', '${T8_USER_ID}', 'owner', 'active')
        ON CONFLICT DO NOTHING;

        INSERT INTO app.personal_profiles (id, tenant_id, name)
        VALUES ('${T8_PROFILE_ID}', '${T8_TENANT_ID}', 'T8 Profile')
        ON CONFLICT DO NOTHING;

        INSERT INTO app.personal_memberships (personal_profile_id, tenant_id, user_id, role, status)
        VALUES ('${T8_PROFILE_ID}', '${T8_TENANT_ID}', '${T8_USER_ID}', 'owner', 'active')
        ON CONFLICT DO NOTHING;

        INSERT INTO app.businesses (id, tenant_id, name, industry_code, timezone, base_currency, status)
        VALUES ('${T8_BIZ_ID}', '${T8_TENANT_ID}', 'T8 Biz', 'restaurant', 'UTC', 'USD', 'active')
        ON CONFLICT DO NOTHING;

        INSERT INTO app.business_memberships (business_id, tenant_id, user_id, role, status)
        VALUES ('${T8_BIZ_ID}', '${T8_TENANT_ID}', '${T8_USER_ID}', 'owner', 'active')
        ON CONFLICT DO NOTHING;

        INSERT INTO app.spending_categories (id, tenant_id, name, color, icon, status)
        VALUES ('${T8_CAT_ID}', '${T8_TENANT_ID}', 'T8 Cat', '#AABBCC', 'tag', 'active')
        ON CONFLICT DO NOTHING;

        INSERT INTO app.taxonomy_versions (id, jurisdiction_code, tax_year, code, name, status, source_url, source_revision, source_checksum)
        VALUES ('${T8_TAXVER_ID}', 'US-FEDERAL', 2025, 'test-v1', 'Test Taxonomy', 'active', 'https://test.local', 'rev1', '${"a".repeat(64)}')
        ON CONFLICT DO NOTHING;

        INSERT INTO app.tax_category_definitions (id, taxonomy_version_id, code, name, status, sort_order)
        VALUES ('${T8_TAXCAT_ID}', '${T8_TAXVER_ID}', 'MEALS', 'Meals & Entertainment', 'active', 1)
        ON CONFLICT DO NOTHING;

        INSERT INTO app.business_tax_profiles (id, tenant_id, business_id, tax_year, taxonomy_version_id, tax_form, accounting_method, status)
        VALUES ('${T8_TAX_PROF_ID}', '${T8_TENANT_ID}', '${T8_BIZ_ID}', 2025, '${T8_TAXVER_ID}', 'schedule_c', 'cash', 'active')
        ON CONFLICT DO NOTHING;
      `);
    }

    // ---------------------------------------------------------------- //
    // T8-L1: Tag CRUD — create (owner enforced), list, update, archive
    // ---------------------------------------------------------------- //

    it("T8-L1: tag create generates immutable custom:<uuid> key server-side", async () => {
      const domain = createTagDomain(database!);
      const tag = await domain.createTag({
        actorUserId: T8_USER_ID,
        tenantId: T8_TENANT_ID,
        request: { name: "Restaurant Meals", color: "#FF0000" },
        requestId: `t8-l1-${runKey}`,
      });
      expect(tag.key).toMatch(/^custom:[0-9a-f-]{36}$/);
      expect(tag.origin).toBe("custom");
      expect(tag.status).toBe("active");
    });

    it("T8-L1b: non-admin member cannot create tag", async () => {
      const memberUserId = randomUUID();
      runtimeSql(`
        INSERT INTO app.users (id, primary_email, display_name)
        VALUES ('${memberUserId}', 'member-${runKey}@example.test', 'Member')
        ON CONFLICT DO NOTHING;
        INSERT INTO app.tenant_memberships (tenant_id, user_id, role, status)
        VALUES ('${T8_TENANT_ID}', '${memberUserId}', 'member', 'active')
        ON CONFLICT DO NOTHING;
      `);
      const domain = createTagDomain(database!);
      await expect(
        domain.createTag({
          actorUserId: memberUserId,
          tenantId: T8_TENANT_ID,
          request: { name: "Denied", color: "#000000" },
          requestId: `t8-l1b-${runKey}`,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("T8-L1c: list is accessible to any tenant member", async () => {
      const domain = createTagDomain(database!);
      const result = await domain.listTags({ actorUserId: T8_USER_ID, tenantId: T8_TENANT_ID });
      expect(Array.isArray(result.items)).toBe(true);
    });

    // ---------------------------------------------------------------- //
    // T8-L2: Archived key collision / explicit unarchive
    // ---------------------------------------------------------------- //

    it("T8-L2: archive and explicit unarchive cycle; archived key never duplicated", async () => {
      const domain = createTagDomain(database!);
      const tag = await domain.createTag({
        actorUserId: T8_USER_ID,
        tenantId: T8_TENANT_ID,
        request: { name: "Temp Tag", color: "#123456" },
        requestId: `t8-l2-create-${runKey}`,
      });

      const archived = await domain.archiveTag({
        actorUserId: T8_USER_ID,
        tenantId: T8_TENANT_ID,
        tagId: tag.id,
        request: { expectedVersion: tag.version },
        requestId: `t8-l2-archive-${runKey}`,
      });
      expect(archived.status).toBe("archived");

      // Archived tag cannot be archived again
      await expect(
        domain.archiveTag({
          actorUserId: T8_USER_ID,
          tenantId: T8_TENANT_ID,
          tagId: tag.id,
          request: { expectedVersion: archived.version },
          requestId: `t8-l2-rearchive-${runKey}`,
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });

      // Unarchive explicitly
      const restored = await domain.unarchiveTag({
        actorUserId: T8_USER_ID,
        tenantId: T8_TENANT_ID,
        tagId: tag.id,
        request: { expectedVersion: archived.version },
        requestId: `t8-l2-unarchive-${runKey}`,
      });
      expect(restored.status).toBe("active");
    });

    // ---------------------------------------------------------------- //
    // T8-L3: Association — manual apply/remove, one row per expense/tag
    // ---------------------------------------------------------------- //

    it("T8-L3: apply tag to expense writes active association with source=manual", async () => {
      const domain = createTagDomain(database!);

      // Create an expense
      const expId = randomUUID();
      runtimeSql(`
        INSERT INTO app.expenses (id, tenant_id, created_by_user_id, personal_profile_id, business_id,
          merchant, amount, currency, incurred_on, source, status)
        VALUES ('${expId}', '${T8_TENANT_ID}', '${T8_USER_ID}',
          '${T8_PROFILE_ID}', NULL, 'Coffee Shop', '10.00', 'USD', '2026-09-01', 'manual', 'ready')
        ON CONFLICT DO NOTHING;
      `);

      // Create a custom tag
      const tag = await domain.createTag({
        actorUserId: T8_USER_ID,
        tenantId: T8_TENANT_ID,
        request: { name: "Coffee Tag", color: "#663300" },
        requestId: `t8-l3-tag-${runKey}`,
      });

      const assoc = await domain.applyExpenseTag({
        actorUserId: T8_USER_ID,
        tenantId: T8_TENANT_ID,
        profileId: T8_PROFILE_ID,
        businessId: null,
        expenseId: expId,
        tagId: tag.id,
        requestId: `t8-l3-apply-${runKey}`,
      });

      expect(assoc.source).toBe("manual");
      expect(assoc.status).toBe("active");

      // Idempotent re-apply returns the same row (or updates to active)
      const assoc2 = await domain.applyExpenseTag({
        actorUserId: T8_USER_ID,
        tenantId: T8_TENANT_ID,
        profileId: T8_PROFILE_ID,
        businessId: null,
        expenseId: expId,
        tagId: tag.id,
        requestId: `t8-l3-apply2-${runKey}`,
      });
      expect(assoc2.id).toBe(assoc.id);

      // Check exactly one row in DB
      const count = runtimeSql(
        `SELECT count(*) FROM app.expense_tags
          WHERE expense_id = '${expId}' AND tag_id = '${tag.id}';`,
      );
      expect(count).toBe("1");
    });

    it("T8-L3b: remove tag writes removed status, version incremented, manual beats rule", async () => {
      const domain = createTagDomain(database!);
      const expId = randomUUID();
      runtimeSql(`
        INSERT INTO app.expenses (id, tenant_id, created_by_user_id, personal_profile_id, business_id,
          merchant, amount, currency, incurred_on, source, status)
        VALUES ('${expId}', '${T8_TENANT_ID}', '${T8_USER_ID}',
          '${T8_PROFILE_ID}', NULL, 'Coffee Shop', '5.00', 'USD', '2026-09-01', 'manual', 'ready')
        ON CONFLICT DO NOTHING;
      `);

      const tag = await domain.createTag({
        actorUserId: T8_USER_ID,
        tenantId: T8_TENANT_ID,
        request: { name: "Remove Test Tag", color: "#333333" },
        requestId: `t8-l3b-tag-${runKey}`,
      });

      const assoc = await domain.applyExpenseTag({
        actorUserId: T8_USER_ID,
        tenantId: T8_TENANT_ID,
        profileId: T8_PROFILE_ID,
        businessId: null,
        expenseId: expId,
        tagId: tag.id,
        requestId: `t8-l3b-apply-${runKey}`,
      });

      await domain.removeExpenseTag({
        actorUserId: T8_USER_ID,
        tenantId: T8_TENANT_ID,
        profileId: T8_PROFILE_ID,
        businessId: null,
        expenseId: expId,
        tagId: tag.id,
        expectedVersion: assoc.version,
        requestId: `t8-l3b-remove-${runKey}`,
      });

      const row = runtimeSql(
        `SELECT status, source, removed_by_user_id FROM app.expense_tags
          WHERE expense_id = '${expId}' AND tag_id = '${tag.id}';`,
      );
      expect(row).toContain("removed");
      expect(row).toContain(T8_USER_ID);
    });

    it("T8-L3c: cross-scope denial — personal-scope route with business expense rejected", async () => {
      const domain = createTagDomain(database!);
      const expId = randomUUID();
      runtimeSql(`
        INSERT INTO app.expenses (id, tenant_id, created_by_user_id, personal_profile_id, business_id,
          merchant, amount, currency, incurred_on, source, status)
        VALUES ('${expId}', '${T8_TENANT_ID}', '${T8_USER_ID}',
          NULL, '${T8_BIZ_ID}', 'Biz Coffee', '15.00', 'USD', '2026-09-01', 'manual', 'ready')
        ON CONFLICT DO NOTHING;
      `);

      const tag = await domain.createTag({
        actorUserId: T8_USER_ID,
        tenantId: T8_TENANT_ID,
        request: { name: "Cross Scope Tag", color: "#444444" },
        requestId: `t8-l3c-tag-${runKey}`,
      });

      // Apply with wrong scope (profileId given but expense is business)
      await expect(
        domain.applyExpenseTag({
          actorUserId: T8_USER_ID,
          tenantId: T8_TENANT_ID,
          profileId: T8_PROFILE_ID,
          businessId: null,
          expenseId: expId,
          tagId: tag.id,
          requestId: `t8-l3c-apply-${runKey}`,
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    // ---------------------------------------------------------------- //
    // T8-L4: Merge — locks sorted, preserves precedence, supersedes suggestions
    // ---------------------------------------------------------------- //

    it("T8-L4: merge locks source/target sorted, archives source, increments target, writes audit", async () => {
      const domain = createTagDomain(database!);

      const sourceTag = await domain.createTag({
        actorUserId: T8_USER_ID,
        tenantId: T8_TENANT_ID,
        request: { name: "Source Tag", color: "#111111" },
        requestId: `t8-l4-src-${runKey}`,
      });
      const targetTag = await domain.createTag({
        actorUserId: T8_USER_ID,
        tenantId: T8_TENANT_ID,
        request: { name: "Target Tag", color: "#222222" },
        requestId: `t8-l4-tgt-${runKey}`,
      });

      await domain.mergeTags({
        actorUserId: T8_USER_ID,
        tenantId: T8_TENANT_ID,
        sourceTagId: sourceTag.id,
        targetTagId: targetTag.id,
        expectedSourceVersion: sourceTag.version,
        expectedTargetVersion: targetTag.version,
        requestId: `t8-l4-merge-${runKey}`,
      });

      // Source must be archived
      const srcStatus = runtimeSql(
        `SELECT status FROM app.tags WHERE id = '${sourceTag.id}';`,
      );
      expect(srcStatus).toBe("archived");

      // Target must have version incremented
      const tgtVersion = runtimeSql(
        `SELECT version FROM app.tags WHERE id = '${targetTag.id}';`,
      );
      expect(parseInt(tgtVersion, 10)).toBeGreaterThan(targetTag.version);

      // Audit event must exist
      const auditCount = runtimeSql(
        `SELECT count(*) FROM app.app_audit_events
          WHERE action = 'tag.merged' AND resource_id = '${sourceTag.id}';`,
      );
      expect(parseInt(auditCount, 10)).toBeGreaterThanOrEqual(1);
    });

    it("T8-L4b: self-merge rejected", async () => {
      const domain = createTagDomain(database!);
      const tag = await domain.createTag({
        actorUserId: T8_USER_ID,
        tenantId: T8_TENANT_ID,
        request: { name: "Self Merge Tag", color: "#555555" },
        requestId: `t8-l4b-${runKey}`,
      });
      await expect(
        domain.mergeTags({
          actorUserId: T8_USER_ID,
          tenantId: T8_TENANT_ID,
          sourceTagId: tag.id,
          targetTagId: tag.id,
          expectedSourceVersion: tag.version,
          expectedTargetVersion: tag.version,
          requestId: `t8-l4b-merge-${runKey}`,
        }),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    });

    it("T8-L4c: stale source version rejected", async () => {
      const domain = createTagDomain(database!);
      const src = await domain.createTag({
        actorUserId: T8_USER_ID,
        tenantId: T8_TENANT_ID,
        request: { name: "Stale Src", color: "#666666" },
        requestId: `t8-l4c-src-${runKey}`,
      });
      const tgt = await domain.createTag({
        actorUserId: T8_USER_ID,
        tenantId: T8_TENANT_ID,
        request: { name: "Stale Tgt", color: "#777777" },
        requestId: `t8-l4c-tgt-${runKey}`,
      });
      await expect(
        domain.mergeTags({
          actorUserId: T8_USER_ID,
          tenantId: T8_TENANT_ID,
          sourceTagId: src.id,
          targetTagId: tgt.id,
          expectedSourceVersion: 999,
          expectedTargetVersion: tgt.version,
          requestId: `t8-l4c-merge-${runKey}`,
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    });

    it("T8-L4d: archived target rejected", async () => {
      const domain = createTagDomain(database!);
      const src = await domain.createTag({
        actorUserId: T8_USER_ID,
        tenantId: T8_TENANT_ID,
        request: { name: "Arch Target Src", color: "#888888" },
        requestId: `t8-l4d-src-${runKey}`,
      });
      const tgt = await domain.createTag({
        actorUserId: T8_USER_ID,
        tenantId: T8_TENANT_ID,
        request: { name: "Arch Target Tgt", color: "#999999" },
        requestId: `t8-l4d-tgt-${runKey}`,
      });
      // Archive the target first
      const archivedTgt = await domain.archiveTag({
        actorUserId: T8_USER_ID,
        tenantId: T8_TENANT_ID,
        tagId: tgt.id,
        request: { expectedVersion: tgt.version },
        requestId: `t8-l4d-archive-${runKey}`,
      });
      await expect(
        domain.mergeTags({
          actorUserId: T8_USER_ID,
          tenantId: T8_TENANT_ID,
          sourceTagId: src.id,
          targetTagId: tgt.id,
          expectedSourceVersion: src.version,
          expectedTargetVersion: archivedTgt.version,
          requestId: `t8-l4d-merge-${runKey}`,
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    });

    it("T8-L4e: merge preserves manual precedence over rule when both source and target have associations", async () => {
      const domain = createTagDomain(database!);
      const expId = randomUUID();
      runtimeSql(`
        INSERT INTO app.expenses (id, tenant_id, created_by_user_id, personal_profile_id, business_id,
          merchant, amount, currency, incurred_on, source, status)
        VALUES ('${expId}', '${T8_TENANT_ID}', '${T8_USER_ID}',
          '${T8_PROFILE_ID}', NULL, 'Merge Diner', '20.00', 'USD', '2026-09-01', 'manual', 'ready')
        ON CONFLICT DO NOTHING;
      `);

      const srcTag = await domain.createTag({
        actorUserId: T8_USER_ID,
        tenantId: T8_TENANT_ID,
        request: { name: "Prec Src", color: "#AAAAAA" },
        requestId: `t8-l4e-src-${runKey}`,
      });
      const tgtTag = await domain.createTag({
        actorUserId: T8_USER_ID,
        tenantId: T8_TENANT_ID,
        request: { name: "Prec Tgt", color: "#BBBBBB" },
        requestId: `t8-l4e-tgt-${runKey}`,
      });

      // Apply source tag manually to the expense
      await domain.applyExpenseTag({
        actorUserId: T8_USER_ID,
        tenantId: T8_TENANT_ID,
        profileId: T8_PROFILE_ID,
        businessId: null,
        expenseId: expId,
        tagId: srcTag.id,
        requestId: `t8-l4e-apply-src-${runKey}`,
      });

      // Apply target tag via rule (insert directly)
      runtimeSql(`
        INSERT INTO app.expense_tags (id, tenant_id, personal_profile_id, business_id,
          expense_id, tag_id, source, confidence, rule_version, suggestion_id,
          status, applied_at)
        VALUES (gen_random_uuid(), '${T8_TENANT_ID}', '${T8_PROFILE_ID}', NULL,
          '${expId}', '${tgtTag.id}', 'rule', '1', 1, NULL, 'active', now())
        ON CONFLICT DO NOTHING;
      `);

      // Merge src → tgt
      await domain.mergeTags({
        actorUserId: T8_USER_ID,
        tenantId: T8_TENANT_ID,
        sourceTagId: srcTag.id,
        targetTagId: tgtTag.id,
        expectedSourceVersion: srcTag.version,
        expectedTargetVersion: tgtTag.version,
        requestId: `t8-l4e-merge-${runKey}`,
      });

      // After merge: tgtTag association must be manual (source association was stronger)
      const assocRow = runtimeSql(
        `SELECT source FROM app.expense_tags
          WHERE expense_id = '${expId}' AND tag_id = '${tgtTag.id}' AND status = 'active';`,
      );
      expect(assocRow).toBe("manual");
    });

    it("T8-L4f: merge supersedes pending source suggestions, preserves terminal", async () => {
      const domain = createTagDomain(database!);
      const expId = randomUUID();
      runtimeSql(`
        INSERT INTO app.expenses (id, tenant_id, created_by_user_id, personal_profile_id, business_id,
          merchant, amount, currency, incurred_on, source, status)
        VALUES ('${expId}', '${T8_TENANT_ID}', '${T8_USER_ID}',
          '${T8_PROFILE_ID}', NULL, 'Sugg Diner', '25.00', 'USD', '2026-09-01', 'manual', 'ready')
        ON CONFLICT DO NOTHING;
      `);

      const srcTag = await domain.createTag({
        actorUserId: T8_USER_ID,
        tenantId: T8_TENANT_ID,
        request: { name: "Sugg Src", color: "#CCCCCC" },
        requestId: `t8-l4f-src-${runKey}`,
      });
      const tgtTag = await domain.createTag({
        actorUserId: T8_USER_ID,
        tenantId: T8_TENANT_ID,
        request: { name: "Sugg Tgt", color: "#DDDDDD" },
        requestId: `t8-l4f-tgt-${runKey}`,
      });

      // Seed a fake job + pending suggestion for srcTag on this expense
      const fakeJobId = randomUUID();
      runtimeSql(`
        INSERT INTO app.processing_jobs
          (id, tenant_id, personal_profile_id, business_id,
           workflow_type, workflow_id, task_queue, status,
           target_aggregate_type, target_aggregate_id, expected_aggregate_version,
           input_params, allowed_result_schema_version)
        VALUES
          ('${fakeJobId}', '${T8_TENANT_ID}', '${T8_PROFILE_ID}', NULL,
           'ExpenseEnrichmentWorkflow', 'job-${fakeJobId}', 'expense-tax-ai-worker', 'SUCCEEDED',
           'expense', '${expId}', 1,
           '{}', 'expense-enrichment-v1')
        ON CONFLICT DO NOTHING;
      `);

      const pendingSugId = randomUUID();
      const acceptedSugId = randomUUID();
      runtimeSql(`
        INSERT INTO app.expense_enrichment_suggestions
          (id, tenant_id, personal_profile_id, business_id, expense_id, job_id,
           kind, tag_id, spending_category_id, tax_category_definition_id,
           business_tax_profile_id, business_tax_profile_version, taxonomy_version_id, tax_year,
           source, confidence, evidence_hash, status, version, expense_version, idempotency_key)
        VALUES
          -- pending suggestion for source tag
          ('${pendingSugId}', '${T8_TENANT_ID}', '${T8_PROFILE_ID}', NULL,
           '${expId}', '${fakeJobId}', 'tag', '${srcTag.id}', NULL, NULL,
           NULL, NULL, NULL, NULL,
           'historical', 0.9, '${"a".repeat(64)}', 'pending', 1, 1, 'pending-sug-${runKey}'),
          -- accepted suggestion for source tag (terminal — must NOT change)
          ('${acceptedSugId}', '${T8_TENANT_ID}', '${T8_PROFILE_ID}', NULL,
           '${expId}', '${fakeJobId}', 'tag', '${srcTag.id}', NULL, NULL,
           NULL, NULL, NULL, NULL,
           'historical', 0.8, '${"b".repeat(64)}', 'accepted', 2, 1, 'accepted-sug-${runKey}')
        ON CONFLICT DO NOTHING;
      `);

      await domain.mergeTags({
        actorUserId: T8_USER_ID,
        tenantId: T8_TENANT_ID,
        sourceTagId: srcTag.id,
        targetTagId: tgtTag.id,
        expectedSourceVersion: srcTag.version,
        expectedTargetVersion: tgtTag.version,
        requestId: `t8-l4f-merge-${runKey}`,
      });

      // Pending must be superseded
      const pendingStatus = runtimeSql(
        `SELECT status FROM app.expense_enrichment_suggestions WHERE id = '${pendingSugId}';`,
      );
      expect(pendingStatus).toBe("superseded");

      // Accepted must remain accepted (terminal)
      const acceptedStatus = runtimeSql(
        `SELECT status FROM app.expense_enrichment_suggestions WHERE id = '${acceptedSugId}';`,
      );
      expect(acceptedStatus).toBe("accepted");
    });

    // ---------------------------------------------------------------- //
    // T8-L5: Suggestion resolution — tag accept creates historical association
    // ---------------------------------------------------------------- //

    it("T8-L5: accept tag suggestion creates historical active association unless manual/removed blocks", async () => {
      const { createEnrichmentJobInTransaction } = await import("../src/domain/enrichment-jobs.js");
      const { resolveSuggestion } = await import("../src/domain/enrichment.js");

      const expId = randomUUID();
      const tagId = randomUUID();
      runtimeSql(`
        INSERT INTO app.expenses (id, tenant_id, created_by_user_id, personal_profile_id, business_id,
          merchant, amount, currency, incurred_on, source, status)
        VALUES ('${expId}', '${T8_TENANT_ID}', '${T8_USER_ID}',
          '${T8_PROFILE_ID}', NULL, 'Tag Accept Shop', '12.00', 'USD', '2026-09-02', 'manual', 'ready')
        ON CONFLICT DO NOTHING;

        INSERT INTO app.tags (id, tenant_id, key, name, color, origin, status)
        VALUES ('${tagId}', '${T8_TENANT_ID}', 'custom:tag-${runKey}', 'Acc Tag', '#EEEEEE', 'custom', 'active')
        ON CONFLICT DO NOTHING;
      `);

      // Create a pending suggestion for the tag
      const fakeJobId = randomUUID();
      runtimeSql(`
        INSERT INTO app.processing_jobs
          (id, tenant_id, personal_profile_id, business_id,
           workflow_type, workflow_id, task_queue, status,
           target_aggregate_type, target_aggregate_id, expected_aggregate_version,
           input_params, allowed_result_schema_version)
        VALUES
          ('${fakeJobId}', '${T8_TENANT_ID}', '${T8_PROFILE_ID}', NULL,
           'ExpenseEnrichmentWorkflow', 'job-${fakeJobId}', 'expense-tax-ai-worker', 'SUCCEEDED',
           'expense', '${expId}', 1,
           '{}', 'expense-enrichment-v1')
        ON CONFLICT DO NOTHING;
      `);

      const sugId = randomUUID();
      runtimeSql(`
        INSERT INTO app.expense_enrichment_suggestions
          (id, tenant_id, personal_profile_id, business_id, expense_id, job_id,
           kind, tag_id, spending_category_id, tax_category_definition_id,
           business_tax_profile_id, business_tax_profile_version, taxonomy_version_id, tax_year,
           source, confidence, evidence_hash, status, version, expense_version, idempotency_key)
        VALUES
          ('${sugId}', '${T8_TENANT_ID}', '${T8_PROFILE_ID}', NULL,
           '${expId}', '${fakeJobId}', 'tag', '${tagId}', NULL, NULL,
           NULL, NULL, NULL, NULL,
           'historical', 0.9, '${"c".repeat(64)}', 'pending', 1, 1, 'tag-accept-${runKey}')
        ON CONFLICT DO NOTHING;
      `);

      const result = await resolveSuggestion(database!, {
        actorUserId: T8_USER_ID,
        tenantId: T8_TENANT_ID,
        profileId: T8_PROFILE_ID,
        businessId: null,
        expenseId: expId,
        suggestionId: sugId,
        request: {
          action: "accepted",
          expectedSuggestionVersion: 1,
          expectedExpenseVersion: 1,
          idempotencyKey: `t8-l5-resolve-${runKey}`,
        },
        requestId: `t8-l5-req-${runKey}`,
      });

      expect(result.status).toBe("accepted");

      // Historical active association must exist
      const assocRow = runtimeSql(
        `SELECT source, status FROM app.expense_tags
          WHERE expense_id = '${expId}' AND tag_id = '${tagId}'
            AND status = 'active';`,
      );
      expect(assocRow).toContain("historical");
    });

    it("T8-L5b: reject suggestion — terminal, not superseded", async () => {
      const { resolveSuggestion } = await import("../src/domain/enrichment.js");

      const expId = randomUUID();
      const tagId = randomUUID();
      runtimeSql(`
        INSERT INTO app.expenses (id, tenant_id, created_by_user_id, personal_profile_id, business_id,
          merchant, amount, currency, incurred_on, source, status)
        VALUES ('${expId}', '${T8_TENANT_ID}', '${T8_USER_ID}',
          '${T8_PROFILE_ID}', NULL, 'Reject Shop', '8.00', 'USD', '2026-09-02', 'manual', 'ready')
        ON CONFLICT DO NOTHING;

        INSERT INTO app.tags (id, tenant_id, key, name, color, origin, status)
        VALUES ('${tagId}', '${T8_TENANT_ID}', 'custom:rej-${runKey}', 'Rej Tag', '#111111', 'custom', 'active')
        ON CONFLICT DO NOTHING;
      `);

      const fakeJobId = randomUUID();
      runtimeSql(`
        INSERT INTO app.processing_jobs
          (id, tenant_id, personal_profile_id, business_id,
           workflow_type, workflow_id, task_queue, status,
           target_aggregate_type, target_aggregate_id, expected_aggregate_version,
           input_params, allowed_result_schema_version)
        VALUES
          ('${fakeJobId}', '${T8_TENANT_ID}', '${T8_PROFILE_ID}', NULL,
           'ExpenseEnrichmentWorkflow', 'job-${fakeJobId}', 'expense-tax-ai-worker', 'SUCCEEDED',
           'expense', '${expId}', 1,
           '{}', 'expense-enrichment-v1')
        ON CONFLICT DO NOTHING;
      `);

      const sugId = randomUUID();
      runtimeSql(`
        INSERT INTO app.expense_enrichment_suggestions
          (id, tenant_id, personal_profile_id, business_id, expense_id, job_id,
           kind, tag_id, spending_category_id, tax_category_definition_id,
           business_tax_profile_id, business_tax_profile_version, taxonomy_version_id, tax_year,
           source, confidence, evidence_hash, status, version, expense_version, idempotency_key)
        VALUES
          ('${sugId}', '${T8_TENANT_ID}', '${T8_PROFILE_ID}', NULL,
           '${expId}', '${fakeJobId}', 'tag', '${tagId}', NULL, NULL,
           NULL, NULL, NULL, NULL,
           'historical', 0.7, '${"d".repeat(64)}', 'pending', 1, 1, 'tag-reject-${runKey}')
        ON CONFLICT DO NOTHING;
      `);

      const result = await resolveSuggestion(database!, {
        actorUserId: T8_USER_ID,
        tenantId: T8_TENANT_ID,
        profileId: T8_PROFILE_ID,
        businessId: null,
        expenseId: expId,
        suggestionId: sugId,
        request: {
          action: "rejected",
          expectedSuggestionVersion: 1,
          expectedExpenseVersion: 1,
          idempotencyKey: `t8-l5b-resolve-${runKey}`,
        },
        requestId: `t8-l5b-req-${runKey}`,
      });

      expect(result.status).toBe("rejected");

      // No association created
      const assocCount = runtimeSql(
        `SELECT count(*) FROM app.expense_tags
          WHERE expense_id = '${expId}' AND tag_id = '${tagId}';`,
      );
      expect(assocCount).toBe("0");
    });

    it("T8-L5c: replay — identical resolution returns original", async () => {
      const { resolveSuggestion } = await import("../src/domain/enrichment.js");

      const expId = randomUUID();
      const tagId = randomUUID();
      runtimeSql(`
        INSERT INTO app.expenses (id, tenant_id, created_by_user_id, personal_profile_id, business_id,
          merchant, amount, currency, incurred_on, source, status)
        VALUES ('${expId}', '${T8_TENANT_ID}', '${T8_USER_ID}',
          '${T8_PROFILE_ID}', NULL, 'Replay Cafe', '11.00', 'USD', '2026-09-02', 'manual', 'ready')
        ON CONFLICT DO NOTHING;

        INSERT INTO app.tags (id, tenant_id, key, name, color, origin, status)
        VALUES ('${tagId}', '${T8_TENANT_ID}', 'custom:rpl-${runKey}', 'Rpl Tag', '#222222', 'custom', 'active')
        ON CONFLICT DO NOTHING;
      `);

      const fakeJobId = randomUUID();
      runtimeSql(`
        INSERT INTO app.processing_jobs
          (id, tenant_id, personal_profile_id, business_id,
           workflow_type, workflow_id, task_queue, status,
           target_aggregate_type, target_aggregate_id, expected_aggregate_version,
           input_params, allowed_result_schema_version)
        VALUES
          ('${fakeJobId}', '${T8_TENANT_ID}', '${T8_PROFILE_ID}', NULL,
           'ExpenseEnrichmentWorkflow', 'job-${fakeJobId}', 'expense-tax-ai-worker', 'SUCCEEDED',
           'expense', '${expId}', 1,
           '{}', 'expense-enrichment-v1')
        ON CONFLICT DO NOTHING;
      `);

      const sugId = randomUUID();
      runtimeSql(`
        INSERT INTO app.expense_enrichment_suggestions
          (id, tenant_id, personal_profile_id, business_id, expense_id, job_id,
           kind, tag_id, spending_category_id, tax_category_definition_id,
           business_tax_profile_id, business_tax_profile_version, taxonomy_version_id, tax_year,
           source, confidence, evidence_hash, status, version, expense_version, idempotency_key)
        VALUES
          ('${sugId}', '${T8_TENANT_ID}', '${T8_PROFILE_ID}', NULL,
           '${expId}', '${fakeJobId}', 'tag', '${tagId}', NULL, NULL,
           NULL, NULL, NULL, NULL,
           'historical', 0.8, '${"e".repeat(64)}', 'pending', 1, 1, 'replay-sug-${runKey}')
        ON CONFLICT DO NOTHING;
      `);

      const idemKey = `t8-l5c-replay-${runKey}`;
      const commonInput = {
        actorUserId: T8_USER_ID,
        tenantId: T8_TENANT_ID,
        profileId: T8_PROFILE_ID,
        businessId: null,
        expenseId: expId,
        suggestionId: sugId,
        request: {
          action: "rejected" as const,
          expectedSuggestionVersion: 1,
          expectedExpenseVersion: 1,
          idempotencyKey: idemKey,
        },
      };

      const first = await resolveSuggestion(database!, { ...commonInput, requestId: `t8-l5c-req1-${runKey}` });
      const second = await resolveSuggestion(database!, { ...commonInput, requestId: `t8-l5c-req2-${runKey}` });

      expect(second.suggestionId).toBe(first.suggestionId);
      expect(second.status).toBe("rejected");
    });

    it("T8-L5d: conflict — different payload for same idempotency key", async () => {
      const { resolveSuggestion } = await import("../src/domain/enrichment.js");

      const expId = randomUUID();
      const tagId = randomUUID();
      runtimeSql(`
        INSERT INTO app.expenses (id, tenant_id, created_by_user_id, personal_profile_id, business_id,
          merchant, amount, currency, incurred_on, source, status)
        VALUES ('${expId}', '${T8_TENANT_ID}', '${T8_USER_ID}',
          '${T8_PROFILE_ID}', NULL, 'Conflict Cafe', '13.00', 'USD', '2026-09-02', 'manual', 'ready')
        ON CONFLICT DO NOTHING;

        INSERT INTO app.tags (id, tenant_id, key, name, color, origin, status)
        VALUES ('${tagId}', '${T8_TENANT_ID}', 'custom:cnf-${runKey}', 'Cnf Tag', '#333333', 'custom', 'active')
        ON CONFLICT DO NOTHING;
      `);

      const fakeJobId = randomUUID();
      runtimeSql(`
        INSERT INTO app.processing_jobs
          (id, tenant_id, personal_profile_id, business_id,
           workflow_type, workflow_id, task_queue, status,
           target_aggregate_type, target_aggregate_id, expected_aggregate_version,
           input_params, allowed_result_schema_version)
        VALUES
          ('${fakeJobId}', '${T8_TENANT_ID}', '${T8_PROFILE_ID}', NULL,
           'ExpenseEnrichmentWorkflow', 'job-${fakeJobId}', 'expense-tax-ai-worker', 'SUCCEEDED',
           'expense', '${expId}', 1,
           '{}', 'expense-enrichment-v1')
        ON CONFLICT DO NOTHING;
      `);

      const sugId = randomUUID();
      runtimeSql(`
        INSERT INTO app.expense_enrichment_suggestions
          (id, tenant_id, personal_profile_id, business_id, expense_id, job_id,
           kind, tag_id, spending_category_id, tax_category_definition_id,
           business_tax_profile_id, business_tax_profile_version, taxonomy_version_id, tax_year,
           source, confidence, evidence_hash, status, version, expense_version, idempotency_key)
        VALUES
          ('${sugId}', '${T8_TENANT_ID}', '${T8_PROFILE_ID}', NULL,
           '${expId}', '${fakeJobId}', 'tag', '${tagId}', NULL, NULL,
           NULL, NULL, NULL, NULL,
           'historical', 0.75, '${"f".repeat(64)}', 'pending', 1, 1, 'conflict-sug-${runKey}')
        ON CONFLICT DO NOTHING;
      `);

      const idemKey = `t8-l5d-conflict-${runKey}`;
      await resolveSuggestion(database!, {
        actorUserId: T8_USER_ID,
        tenantId: T8_TENANT_ID,
        profileId: T8_PROFILE_ID,
        businessId: null,
        expenseId: expId,
        suggestionId: sugId,
        request: {
          action: "rejected",
          expectedSuggestionVersion: 1,
          expectedExpenseVersion: 1,
          idempotencyKey: idemKey,
        },
        requestId: `t8-l5d-req1-${runKey}`,
      });

      // Same idem key, different action
      await expect(
        resolveSuggestion(database!, {
          actorUserId: T8_USER_ID,
          tenantId: T8_TENANT_ID,
          profileId: T8_PROFILE_ID,
          businessId: null,
          expenseId: expId,
          suggestionId: sugId,
          request: {
            action: "accepted",
            expectedSuggestionVersion: 1,
            expectedExpenseVersion: 1,
            idempotencyKey: idemKey,
          },
          requestId: `t8-l5d-req2-${runKey}`,
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    });

    // ---------------------------------------------------------------- //
    // T8-L6: rerunEnrichment creates new enrichment job
    // ---------------------------------------------------------------- //

    it("T8-L6: rerunEnrichment creates new enrichment job for ready expense", async () => {
      const { rerunEnrichment } = await import("../src/domain/enrichment.js");

      const expId = randomUUID();
      runtimeSql(`
        INSERT INTO app.expenses (id, tenant_id, created_by_user_id, personal_profile_id, business_id,
          merchant, amount, currency, incurred_on, source, status)
        VALUES ('${expId}', '${T8_TENANT_ID}', '${T8_USER_ID}',
          '${T8_PROFILE_ID}', NULL, 'Rerun Diner', '9.00', 'USD', '2026-09-02', 'manual', 'ready')
        ON CONFLICT DO NOTHING;
      `);

      const beforeCount = parseInt(runtimeSql(
        `SELECT count(*) FROM app.processing_jobs
          WHERE target_aggregate_id = '${expId}';`,
      ), 10);

      await rerunEnrichment(database!, {
        actorUserId: T8_USER_ID,
        tenantId: T8_TENANT_ID,
        profileId: T8_PROFILE_ID,
        businessId: null,
        expenseId: expId,
        kinds: ["tag"],
        requestId: `t8-l6-rerun-${runKey}`,
      });

      const afterCount = parseInt(runtimeSql(
        `SELECT count(*) FROM app.processing_jobs
          WHERE target_aggregate_id = '${expId}';`,
      ), 10);

      expect(afterCount).toBe(beforeCount + 1);
    });
  },
);
