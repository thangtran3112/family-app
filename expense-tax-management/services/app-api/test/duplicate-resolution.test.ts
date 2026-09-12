import {
  DuplicateMatchListSchema,
  DuplicateResolutionResponseSchema,
  type DuplicateMatch,
  type AuthenticatedUser,
} from "@expense-tax/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Kysely } from "kysely";

import { buildApp } from "../src/app.js";
import type { AuthPrincipal, TokenVerifier } from "../src/auth/types.js";
import { createAppConfig } from "../src/config.js";
import {
  createDeduplicationDomain,
  type DeduplicationDomain,
} from "../src/domain/deduplication.js";
import type { AppDatabase } from "../src/database/types.js";

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
const MATCH_ID = "55555555-5555-4555-8555-555555555555";
const EXISTING_EXPENSE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CANDIDATE_EXPENSE_ID = "11111111-1111-4111-8111-111111111112";
const TIMESTAMP = "2026-09-11T00:00:00.000Z";

const MATCH: DuplicateMatch = {
  id: MATCH_ID,
  tenantId: TENANT_ID,
  personalProfileId: PROFILE_ID,
  businessId: null,
  existingExpenseId: EXISTING_EXPENSE_ID,
  candidateExpenseId: CANDIDATE_EXPENSE_ID,
  matchType: "fingerprint",
  confidence: 1,
  evidence: { fingerprintHash: "a".repeat(64) },
  status: "pending",
  version: 1,
  resolvedBy: null,
  resolvedAt: null,
  resolutionIdempotencyKey: null,
  idempotencyKey: "evidence-1",
  createdAt: TIMESTAMP,
};

type FakeQuery = {
  table: string;
  operation: "select" | "insert" | "update";
  where: Record<string, unknown>;
  values: Record<string, unknown>;
};

function resolutionDatabase(options?: {
  match?: Record<string, unknown> | null;
  idempotency?: Record<string, unknown> | null;
}) {
  const calls: FakeQuery[] = [];
  const auditEvents: Record<string, unknown>[] = [];
  const transferred = { files: 0, sources: 0 };
  const match = options?.match === undefined
    ? {
        id: MATCH_ID,
        tenant_id: TENANT_ID,
        personal_profile_id: PROFILE_ID,
        business_id: null,
        existing_expense_id: EXISTING_EXPENSE_ID,
        candidate_expense_id: CANDIDATE_EXPENSE_ID,
        match_type: "fingerprint",
        confidence: "1.0000",
        evidence: { fingerprintHash: "a".repeat(64) },
        status: "pending",
        version: 1,
        resolved_by: null,
        resolved_at: null,
        resolution_idempotency_key: null,
        idempotency_key: "evidence-1",
        created_at: new Date(TIMESTAMP),
      }
    : options.match;
  const expenses = new Map<string, Record<string, unknown>>([
    [EXISTING_EXPENSE_ID, {
      id: EXISTING_EXPENSE_ID,
      tenant_id: TENANT_ID,
      personal_profile_id: PROFILE_ID,
      business_id: null,
      description: null,
      project_id: null,
      spending_category_id: null,
      incurred_on: null,
      merchant: "Cafe",
      amount: "10.00",
      currency: "USD",
      status: "ready",
      version: 1,
      archived_at: null,
    }],
    [CANDIDATE_EXPENSE_ID, {
      id: CANDIDATE_EXPENSE_ID,
      tenant_id: TENANT_ID,
      personal_profile_id: PROFILE_ID,
      business_id: null,
      description: "Receipt note",
      project_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      spending_category_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      incurred_on: new Date("2026-09-11T00:00:00.000Z"),
      merchant: "Cafe changed",
      amount: "12.00",
      currency: "USD",
      status: "ready",
      version: 1,
      archived_at: null,
    }],
  ]);
  let storedIdempotency = options?.idempotency ?? null;

  function builder(query: FakeQuery): Record<string, unknown> {
    const chain: Record<string, unknown> = {
      innerJoin: () => chain,
      select: () => chain,
      selectAll: () => chain,
      where: (column: string, operator: unknown, value?: unknown) => {
        query.where[column] = value === undefined ? operator : value;
        return chain;
      },
      $if: (condition: boolean, callback: (value: unknown) => unknown) =>
        condition ? callback(chain) : chain,
      forUpdate: () => chain,
      orderBy: () => chain,
      limit: () => chain,
      returning: () => chain,
      executeTakeFirst: async () => {
        if (query.operation === "select") {
          if (query.table.startsWith("app.personal_profiles")) return { role: "owner" };
          if (query.table === "app.idempotency_records") return storedIdempotency;
          if (query.table === "app.expense_duplicate_matches") {
            if (match === null) return undefined;
            if (query.where.id !== undefined && query.where.id !== match.id) return undefined;
            if (query.where.personal_profile_id !== undefined && query.where.personal_profile_id !== match.personal_profile_id) return undefined;
            if (query.where.business_id !== undefined && query.where.business_id !== match.business_id) return undefined;
            return match;
          }
          if (query.table === "app.expenses") return expenses.get(String(query.where.id));
        }
        if (query.operation === "update" && query.table === "app.expenses") {
          const expense = expenses.get(String(query.where.id));
          if (!expense) return { numUpdatedRows: 0n };
          if (query.values.status === "archived") {
            expense.status = "archived";
            expense.archived_at = new Date();
          }
          return { numUpdatedRows: 1n };
        }
        if (query.operation === "update" && query.table === "app.expense_duplicate_matches") {
          if (!match) return undefined;
          match.status = query.values.status;
          match.version = Number(match.version) + 1;
          match.resolved_by = query.values.resolved_by;
          match.resolved_at = query.values.resolved_at;
          match.resolution_idempotency_key = query.values.resolution_idempotency_key;
          return { id: match.id, version: match.version };
        }
        return undefined;
      },
      execute: async () => {
        if (query.operation === "insert" && query.table === "app.idempotency_records") {
          storedIdempotency = query.values;
          return undefined;
        }
        if (query.operation === "insert" && query.table === "app.app_audit_events") {
          auditEvents.push(query.values);
          return undefined;
        }
        if (query.operation === "update" && query.table === "app.expense_files") transferred.files += 1;
        if (query.operation === "update" && query.table === "app.expense_sources") transferred.sources += 1;
        if (query.operation === "update" && query.table === "app.expenses") {
          const expense = expenses.get(String(query.where.id));
          if (expense) Object.assign(expense, query.values);
        }
        return [];
      },
    };
    return chain;
  }

  const transaction = new Proxy({}, {
    get: (_target, property: string) => (table: string) => {
      const operation = property === "selectFrom" ? "select" : property === "insertInto" ? "insert" : "update";
      const query: FakeQuery = { table, operation, where: {}, values: {} };
      calls.push(query);
      return new Proxy(builder(query), {
        get: (target, key: string) => {
          if (key === "values" || key === "set") {
            return (values: Record<string, unknown>) => {
              query.values = values;
              return target;
            };
          }
          return target[key];
        },
      });
    },
  });
  const database = {
    selectFrom: (table: string) => (transaction as { selectFrom: (value: string) => unknown }).selectFrom(table),
    transaction: () => ({ execute: (callback: (value: unknown) => unknown) => callback(transaction) }),
  } as unknown as Kysely<AppDatabase>;
  return { database, calls, expenses, auditEvents, transferred };
}

function principal(): AuthPrincipal {
  return {
    tokenType: "tenant",
    subject: "tenant-user",
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

describe("duplicate resolution routes", () => {
  const apps = new Set<ReturnType<typeof buildApp>>();

  afterEach(async () => {
    await Promise.all([...apps].map((app) => app.close()));
    apps.clear();
  });

  function createTestApp() {
    const listMatches = vi.fn(async () => ({ items: [MATCH], nextCursor: null }));
    const resolveMatch = vi.fn(async (input: {
      action: "merge" | "keep_both" | "discard_new";
      matchId: string;
      expectedMatchVersion: number;
      idempotencyKey: string;
    }) => ({
      matchId: input.matchId,
      action: input.action,
      status: input.action === "merge" ? "merged" as const : input.action === "keep_both" ? "separate" as const : "dismissed" as const,
      version: input.expectedMatchVersion + 1,
      idempotencyKey: input.idempotencyKey,
    }));
    const domain: DeduplicationDomain = {
      recordEvidence: vi.fn(async () => ({ decision: "no_match" as const, matchIds: [] })),
      listMatches,
      resolveMatch,
    };
    const identityResolver = {
      resolve: vi.fn(async (): Promise<AuthenticatedUser> => ({
        id: USER_ID,
        primaryEmail: "owner@example.test",
        displayName: "Owner",
        status: "active",
      })),
    };
    const tenantVerifier: TokenVerifier = { verify: vi.fn(async () => principal()) };
    const app = buildApp({
      config: createAppConfig({ env: TEST_ENV, version: "test" }),
      logger: false,
      authVerifiers: {
        tenant: tenantVerifier,
        service: { verify: vi.fn(async () => { throw new Error("not used"); }) },
      },
      identityDomain: identityResolver,
      deduplicationDomain: domain,
    });
    apps.add(app);
    return { app, listMatches, resolveMatch };
  }

  it("lists Personal matches inside explicit profile scope", async () => {
    const { app, listMatches } = createTestApp();
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/tenants/${TENANT_ID}/personal-profiles/${PROFILE_ID}/duplicate-matches?status=pending&limit=10&cursor=cursor-1`,
      headers: { authorization: "Bearer tenant-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(DuplicateMatchListSchema.parse(response.json())).toEqual({
      items: [MATCH],
      nextCursor: null,
    });
    expect(listMatches).toHaveBeenCalledWith({
      actorUserId: USER_ID,
      tenantId: TENANT_ID,
      scope: { kind: "personal", profileId: PROFILE_ID },
      status: "pending",
      limit: 10,
      cursor: "cursor-1",
    });
  });

  it.each([
    ["merge", "merged"],
    ["keep_both", "separate"],
    ["discard_new", "dismissed"],
  ] as const)("resolves Business match with %s", async (action, status) => {
    const { app, resolveMatch } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/tenants/${TENANT_ID}/businesses/${BUSINESS_ID}/duplicate-matches/${MATCH_ID}/resolve`,
      headers: { authorization: "Bearer tenant-token" },
      payload: {
        action,
        expectedMatchVersion: 1,
        idempotencyKey: `resolve-${action}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(DuplicateResolutionResponseSchema.parse(response.json())).toEqual({
      matchId: MATCH_ID,
      action,
      status,
      version: 2,
      idempotencyKey: `resolve-${action}`,
    });
    expect(resolveMatch).toHaveBeenCalledWith({
      actorUserId: USER_ID,
      tenantId: TENANT_ID,
      scope: { kind: "business", businessId: BUSINESS_ID },
      matchId: MATCH_ID,
      action,
      expectedMatchVersion: 1,
      idempotencyKey: `resolve-${action}`,
      requestId: expect.any(String),
    });
  });
});

describe("duplicate resolution domain", () => {
  it("locks expenses in sorted UUID order and transfers merge state atomically", async () => {
    const fake = resolutionDatabase();
    const domain = createDeduplicationDomain(fake.database);

    const result = await domain.resolveMatch?.({
      actorUserId: USER_ID,
      tenantId: TENANT_ID,
      scope: { kind: "personal", profileId: PROFILE_ID },
      matchId: MATCH_ID,
      action: "merge",
      expectedMatchVersion: 1,
      idempotencyKey: "resolve-merge",
      requestId: "request-merge",
    });

    expect(result).toMatchObject({
      matchId: MATCH_ID,
      action: "merge",
      status: "merged",
      version: 2,
    });
    expect(fake.calls
      .filter((call) => call.table === "app.expenses" && call.operation === "select")
      .map((call) => call.where.id))
      .toEqual([CANDIDATE_EXPENSE_ID, EXISTING_EXPENSE_ID]);
    expect(fake.expenses.get(EXISTING_EXPENSE_ID)).toMatchObject({
      description: "Receipt note",
      project_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      spending_category_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      amount: "10.00",
      merchant: "Cafe",
    });
    expect(fake.expenses.get(CANDIDATE_EXPENSE_ID)).toMatchObject({ status: "archived" });
    expect(fake.transferred).toEqual({ files: 1, sources: 1 });
    expect(fake.auditEvents).toHaveLength(1);
    expect(fake.auditEvents[0]).toMatchObject({
      action: "deduplication.match_merge",
      resource_id: MATCH_ID,
      request_id: "request-merge",
    });
  });

  it("rejects stale and terminal matches without mutation", async () => {
    const stale = resolutionDatabase();
    const domain = createDeduplicationDomain(stale.database);
    await expect(domain.resolveMatch?.({
      actorUserId: USER_ID,
      tenantId: TENANT_ID,
      scope: { kind: "personal", profileId: PROFILE_ID },
      matchId: MATCH_ID,
      action: "discard_new",
      expectedMatchVersion: 2,
      idempotencyKey: "resolve-stale",
      requestId: "request-stale",
    })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(stale.transferred).toEqual({ files: 0, sources: 0 });

    const terminal = resolutionDatabase({
      match: {
        id: MATCH_ID,
        tenant_id: TENANT_ID,
        personal_profile_id: PROFILE_ID,
        business_id: null,
        existing_expense_id: EXISTING_EXPENSE_ID,
        candidate_expense_id: CANDIDATE_EXPENSE_ID,
        status: "merged",
        version: 2,
      },
    });
    const terminalDomain = createDeduplicationDomain(terminal.database);
    await expect(terminalDomain.resolveMatch?.({
      actorUserId: USER_ID,
      tenantId: TENANT_ID,
      scope: { kind: "personal", profileId: PROFILE_ID },
      matchId: MATCH_ID,
      action: "keep_both",
      expectedMatchVersion: 2,
      idempotencyKey: "resolve-terminal",
      requestId: "request-terminal",
    })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(terminal.auditEvents).toHaveLength(0);
  });

  it.each([
    ["keep_both", "separate", "ready"],
    ["discard_new", "dismissed", "archived"],
  ] as const)("applies %s without hard deleting candidate", async (action, status, candidateStatus) => {
    const fake = resolutionDatabase();
    const domain = createDeduplicationDomain(fake.database);
    const result = await domain.resolveMatch?.({
      actorUserId: USER_ID,
      tenantId: TENANT_ID,
      scope: { kind: "personal", profileId: PROFILE_ID },
      matchId: MATCH_ID,
      action,
      expectedMatchVersion: 1,
      idempotencyKey: `resolve-${action}`,
      requestId: `request-${action}`,
    });

    expect(result).toMatchObject({ action, status, version: 2 });
    expect(fake.expenses.get(CANDIDATE_EXPENSE_ID)).toMatchObject({ status: candidateStatus });
    expect(fake.expenses.has(CANDIDATE_EXPENSE_ID)).toBe(true);
    expect(fake.transferred).toEqual({ files: 0, sources: 0 });
    expect(fake.auditEvents).toHaveLength(1);
  });

  it("replays identical resolution and rejects idempotency-key reuse with new action", async () => {
    const fake = resolutionDatabase();
    const domain = createDeduplicationDomain(fake.database);
    const input = {
      actorUserId: USER_ID,
      tenantId: TENANT_ID,
      scope: { kind: "personal", profileId: PROFILE_ID } as const,
      matchId: MATCH_ID,
      action: "merge" as const,
      expectedMatchVersion: 1,
      idempotencyKey: "resolve-replay",
      requestId: "request-replay",
    };
    const first = await domain.resolveMatch?.(input);
    const replay = await domain.resolveMatch?.(input);
    expect(replay).toEqual(first);
    expect(fake.auditEvents).toHaveLength(1);
    await expect(domain.resolveMatch?.({ ...input, action: "keep_both" })).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("fails closed for a match outside requested scope", async () => {
    const fake = resolutionDatabase({
      match: {
        id: MATCH_ID,
        tenant_id: TENANT_ID,
        personal_profile_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        business_id: null,
        existing_expense_id: EXISTING_EXPENSE_ID,
        candidate_expense_id: CANDIDATE_EXPENSE_ID,
        status: "pending",
        version: 1,
      },
    });
    const domain = createDeduplicationDomain(fake.database);
    await expect(domain.resolveMatch?.({
      actorUserId: USER_ID,
      tenantId: TENANT_ID,
      scope: { kind: "personal", profileId: PROFILE_ID },
      matchId: MATCH_ID,
      action: "merge",
      expectedMatchVersion: 1,
      idempotencyKey: "resolve-foreign",
      requestId: "request-foreign",
    })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
