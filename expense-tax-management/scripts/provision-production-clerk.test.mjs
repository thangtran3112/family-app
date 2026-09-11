import { describe, expect, it } from "vitest";
import {
  fetchClerkMemberships,
  executePsql,
  parseProvisioningInput,
  provisionAppMappings,
  provisionFoundryOperator,
  validateExternalId,
} from "./provision-production-clerk.mjs";

const validEnv = {
  APP_DATABASE_URL: "postgresql://app:password@example.test/expense_tax",
  FOUNDRY_DATABASE_URL: "postgres://foundry:password@example.test/foundry",
  CLERK_SECRET_KEY: "sk_live_do_not_print",
  CLERK_FAMILY_ORG_ID: "org_2abcDEF123",
  CLERK_THANG_USER_ID: "user_2abcDEF123",
  CLERK_TRAMILY_USER_ID: "user_2xyzDEF456",
  APP_TENANT_ID: "6f7b1f4a-1d47-4b67-9d48-123456789abc",
  APP_THANG_USER_ID: "d5d8b0f5-4df6-4e51-9d66-123456789abc",
  APP_TRAMILY_USER_ID: "a1f54e21-1c44-4c7f-9c35-987654321abc",
};

describe("parseProvisioningInput", () => {
  it("returns only validated provisioning fields", () => {
    expect(parseProvisioningInput(validEnv)).toEqual({
      appDatabaseUrl: validEnv.APP_DATABASE_URL,
      foundryDatabaseUrl: validEnv.FOUNDRY_DATABASE_URL,
      clerkSecretKey: validEnv.CLERK_SECRET_KEY,
      clerkOrgId: validEnv.CLERK_FAMILY_ORG_ID,
      thangClerkUserId: validEnv.CLERK_THANG_USER_ID,
      tramilyClerkUserId: validEnv.CLERK_TRAMILY_USER_ID,
      appTenantId: validEnv.APP_TENANT_ID,
      thangAppUserId: validEnv.APP_THANG_USER_ID,
      tramilyAppUserId: validEnv.APP_TRAMILY_USER_ID,
    });
  });

  it("names every missing variable without exposing a secret", () => {
    const env = { ...validEnv };
    delete env.CLERK_SECRET_KEY;
    delete env.APP_TENANT_ID;

    expect(() => parseProvisioningInput(env)).toThrow(/CLERK_SECRET_KEY/);
    try {
      parseProvisioningInput(env);
    } catch (error) {
      expect(error.message).toContain("APP_TENANT_ID");
      expect(error.message).not.toContain(validEnv.CLERK_SECRET_KEY);
    }
  });

  it.each([
    "APP_DATABASE_URL",
    "FOUNDRY_DATABASE_URL",
    "CLERK_SECRET_KEY",
    "CLERK_FAMILY_ORG_ID",
    "CLERK_THANG_USER_ID",
    "CLERK_TRAMILY_USER_ID",
    "APP_TENANT_ID",
    "APP_THANG_USER_ID",
    "APP_TRAMILY_USER_ID",
  ])("rejects whitespace-only %s without exposing its value", (key) => {
    const env = { ...validEnv, [key]: "  \t  " };

    expect(() => parseProvisioningInput(env)).toThrow(new RegExp(key));
  });

  it.each([
    "APP_DATABASE_URL",
    "FOUNDRY_DATABASE_URL",
    "CLERK_SECRET_KEY",
    "CLERK_FAMILY_ORG_ID",
    "CLERK_THANG_USER_ID",
    "CLERK_TRAMILY_USER_ID",
    "APP_TENANT_ID",
    "APP_THANG_USER_ID",
    "APP_TRAMILY_USER_ID",
  ])("rejects control characters in %s without exposing its value", (key) => {
    const unsafeValue = `safe\nsecret-${key}`;
    const env = { ...validEnv, [key]: unsafeValue };

    expect(() => parseProvisioningInput(env)).toThrow(new RegExp(key));
    try {
      parseProvisioningInput(env);
    } catch (error) {
      expect(error.message).not.toContain(unsafeValue);
    }
  });

  it("rejects malformed database URLs without exposing their values", () => {
    const env = { ...validEnv, APP_DATABASE_URL: "not-a-database-url" };

    expect(() => parseProvisioningInput(env)).toThrow(/APP_DATABASE_URL/);
    try {
      parseProvisioningInput(env);
    } catch (error) {
      expect(error.message).not.toContain(env.APP_DATABASE_URL);
    }
  });
});

describe("validateExternalId", () => {
  it.each(["", "   ", "user_abc\n123", "org_abc\u0000123"])(
    "rejects unsafe external ID %j",
    (value) => {
      expect(() => validateExternalId(value, "CLERK_USER_ID")).toThrow(
        /CLERK_USER_ID/,
      );
    },
  );

  it("accepts valid Clerk IDs", () => {
    expect(validateExternalId("user_2abcDEF123", "CLERK_USER_ID")).toBe(
      "user_2abcDEF123",
    );
    expect(validateExternalId("org_2abcDEF123", "CLERK_ORG_ID")).toBe(
      "org_2abcDEF123",
    );
  });
});

describe("fetchClerkMemberships", () => {
  it("accepts both family users with member or admin roles", async () => {
    const requests = [];
    const memberships = await fetchClerkMemberships(
      {
        clerkSecretKey: "sk_test_secret",
        clerkOrgId: "org_family",
        thangClerkUserId: "user_thang",
        tramilyClerkUserId: "user_tramily",
      },
      {
        fetchImpl: async (url, options) => {
          requests.push({ url, options });
          const userId = new URL(url).searchParams.get("user_id");
          return new Response(
            JSON.stringify({
              data: [
                {
                  organization: { id: "org_family" },
                  public_user_data: { user_id: userId },
                  role: userId === "user_thang" ? "org:admin" : "org:member",
                },
              ],
            }),
            { status: 200 },
          );
        },
      },
    );

    expect(memberships).toEqual([
      { userId: "user_thang", organizationId: "org_family", role: "org:admin" },
      { userId: "user_tramily", organizationId: "org_family", role: "org:member" },
    ]);
    expect(requests).toHaveLength(2);
    expect(requests[0].options.headers.Authorization).toBe("Bearer sk_test_secret");
  });

  it.each([
    [401, "unauthorized"],
    [200, "missing membership"],
  ])("rejects Clerk response %s", async (status, reason) => {
    await expect(
      fetchClerkMemberships(
        {
          clerkSecretKey: "sk_test_secret",
          clerkOrgId: "org_family",
          thangClerkUserId: "user_thang",
          tramilyClerkUserId: "user_tramily",
        },
        {
          fetchImpl: async () =>
            new Response(JSON.stringify({ data: reason === "missing membership" ? [] : [] }), {
              status,
            }),
        },
      ),
    ).rejects.toThrow(/membership|Clerk/);
  });

  it.each([
    { organization: { id: "org_other" }, role: "org:member" },
    { organization: { id: "org_family" }, role: "org:basic_member" },
  ])("rejects mismatched organization or role", async (membership) => {
    await expect(
      fetchClerkMemberships(
        {
          clerkSecretKey: "sk_test_secret",
          clerkOrgId: "org_family",
          thangClerkUserId: "user_thang",
          tramilyClerkUserId: "user_tramily",
        },
        {
          fetchImpl: async () =>
            new Response(
              JSON.stringify({
                data: [{ ...membership, public_user_data: { user_id: "user_thang" } }],
              }),
              { status: 200 },
            ),
        },
      ),
    ).rejects.toThrow(/membership/);
  });

  it("uses bounded timeout and redacts request secrets from failures", async () => {
    await expect(
      fetchClerkMemberships(
        {
          clerkSecretKey: "sk_test_secret",
          clerkOrgId: "org_family",
          thangClerkUserId: "user_thang",
          tramilyClerkUserId: "user_tramily",
        },
        {
          timeoutMs: 1,
          fetchImpl: async (_url, options) => {
            await new Promise((resolve) => setTimeout(resolve, 5));
            expect(options.signal.aborted).toBe(true);
            throw new Error("sk_test_secret");
          },
        },
      ),
    ).rejects.toThrow("Clerk membership request failed for user_thang");
  });
});

describe("database provisioning", () => {
  const input = {
    appDatabaseUrl: "postgresql://app:password@app.test/expense_tax?sslmode=require",
    foundryDatabaseUrl: "postgresql://foundry:password@foundry.test/foundry",
    clerkOrgId: "org_family",
    thangClerkUserId: "user_thang",
    tramilyClerkUserId: "user_tramily",
    appTenantId: "tenant-id",
    thangAppUserId: "thang-id",
    tramilyAppUserId: "tramily-id",
  };
  const memberships = [
    { userId: "user_thang", organizationId: "org_family", role: "org:admin" },
    { userId: "user_tramily", organizationId: "org_family", role: "org:member" },
  ];

  it("uses stable target IDs and idempotent app mapping SQL", async () => {
    let execution;
    await provisionAppMappings(input, memberships, {
      runPsql: async (details) => {
        execution = details;
      },
    });

    expect(execution.databaseUrl).toBeUndefined();
    expect(execution.env).toMatchObject({
      PGHOST: "app.test",
      PGPORT: "5432",
      PGUSER: "app",
      PGPASSWORD: "password",
      PGDATABASE: "expense_tax",
      PGSSLMODE: "require",
    });
    expect(execution.sql).toContain("thang-id");
    expect(execution.sql).toContain("tramily-id");
    expect(execution.sql).toContain("tenant-id");
    expect(execution.sql).toContain("BEGIN");
    expect(execution.sql).toContain("clerk_user_id IS NULL OR clerk_user_id =");
  });

  it("rejects inactive targets and conflicting remaps in SQL", async () => {
    let execution;
    await provisionAppMappings(input, memberships, {
      runPsql: async (details) => {
        execution = details;
      },
    });

    expect(execution.sql).toContain("status = 'active'");
    expect(execution.sql).toContain("RAISE EXCEPTION");
    expect(execution.sql).toContain("clerk_user_id IS NULL OR clerk_user_id =");
  });

  it("provisions both thang roles and rejects disabled conflicts", async () => {
    let execution;
    await provisionFoundryOperator(input, {
      runPsql: async (details) => {
        execution = details;
      },
    });

    expect(execution.env.PGHOST).toBe("foundry.test");
    expect(execution.sql).toContain("'operator'");
    expect(execution.sql).toContain("'catalog_manager'");
    expect(execution.sql).toContain("status = 'disabled'");
    expect(execution.sql).toContain("ON CONFLICT (clerk_user_id, role)");
  });

  it("redacts database password from psql stderr", async () => {
    const stderr = "password=database-secret connection failed";
    const spawnImpl = () => {
      const listeners = new Map();
      const child = {
        stderr: { on: (_event, listener) => listeners.set("stderr", listener) },
        stdin: { end: () => undefined },
        once: (event, listener) => listeners.set(event, listener),
      };
      queueMicrotask(() => {
        listeners.get("stderr")?.(Buffer.from(stderr));
        listeners.get("close")?.(2);
      });
      return child;
    };

    await expect(
      executePsql({
        databaseUrl: "postgresql://app:database-secret@app.test/expense_tax",
        sql: "SELECT 1",
        spawnImpl,
      }),
    ).rejects.toThrow(/\[REDACTED\]/);
    await expect(
      executePsql({
        databaseUrl: "postgresql://app:database-secret@app.test/expense_tax",
        sql: "SELECT 1",
        spawnImpl,
      }),
    ).rejects.not.toThrow("database-secret");
  });
});
