import { describe, expect, it } from "vitest";
import {
  parseProvisioningInput,
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
