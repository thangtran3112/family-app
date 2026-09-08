import { describe, expect, it } from "vitest";

import {
  BusinessArchiveRequestSchema,
  BusinessCreateRequestSchema,
  BusinessIndustryListSchema,
  BusinessMembershipSchema,
  BusinessUpdateRequestSchema,
  ProjectArchiveRequestSchema,
  ProjectCreateRequestSchema,
  ProjectSchema,
  ProjectUpdateRequestSchema,
  SpendingCategoryCreateRequestSchema,
  SpendingCategoryUpdateRequestSchema,
  TenantInvitationCreateRequestSchema,
} from "../src/index.js";

const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";
const TENANT_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const TIMESTAMP = "2026-09-08T00:00:00.000Z";

describe("Phase 0J Wave 2 contracts", () => {
  it("parses stable business industries", () => {
    expect(
      BusinessIndustryListSchema.parse({
        items: [{ code: "restaurant", name: "Restaurant", status: "active" }],
      }),
    ).toEqual({
      items: [{ code: "restaurant", name: "Restaurant", status: "active" }],
    });
  });

  it("validates business create and optimistic update input", () => {
    expect(
      BusinessCreateRequestSchema.parse({
        name: " Corner Cafe ",
        industryCode: "restaurant",
        timezone: "America/New_York",
        baseCurrency: "USD",
      }),
    ).toEqual({
      name: "Corner Cafe",
      industryCode: "restaurant",
      timezone: "America/New_York",
      baseCurrency: "USD",
    });
    expect(
      BusinessCreateRequestSchema.safeParse({
        name: "Cafe",
        industryCode: "restaurant",
        timezone: "Not/AZone",
        baseCurrency: "usd",
      }).success,
    ).toBe(false);
    expect(BusinessUpdateRequestSchema.safeParse({ expectedVersion: 1 }).success).toBe(false);
    expect(BusinessArchiveRequestSchema.parse({ expectedVersion: 2 })).toEqual({
      expectedVersion: 2,
    });
  });

  it("defines independent business membership roles", () => {
    expect(
      BusinessMembershipSchema.parse({
        businessId: BUSINESS_ID,
        tenantId: TENANT_ID,
        userId: USER_ID,
        role: "editor",
        status: "active",
        version: 1,
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
      }).role,
    ).toBe("editor");
  });

  it("accepts a single business invitation grant", () => {
    expect(
      TenantInvitationCreateRequestSchema.parse({
        email: "worker@example.test",
        tenantRole: "member",
        grant: { type: "business", businessId: BUSINESS_ID, role: "viewer" },
      }).grant,
    ).toEqual({ type: "business", businessId: BUSINESS_ID, role: "viewer" });
  });

  it("validates category presentation and non-empty updates", () => {
    expect(
      SpendingCategoryCreateRequestSchema.parse({
        name: " Supplies ",
        description: "Operating supplies",
        color: "#12ABef",
        icon: "package",
      }),
    ).toMatchObject({ name: "Supplies", color: "#12ABef", icon: "package" });
    expect(
      SpendingCategoryCreateRequestSchema.safeParse({
        name: "Supplies",
        color: "blue",
        icon: "package",
      }).success,
    ).toBe(false);
    expect(
      SpendingCategoryUpdateRequestSchema.safeParse({ expectedVersion: 1 }).success,
    ).toBe(false);
  });

  it("keeps projects free of tax identity fields", () => {
    expect(
      ProjectSchema.safeParse({
        id: BUSINESS_ID,
        tenantId: TENANT_ID,
        businessId: BUSINESS_ID,
        name: "Renovation",
        clientName: null,
        description: null,
        status: "active",
        startsOn: null,
        endsOn: null,
        version: 1,
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
        taxEntity: "sole_proprietor",
      }).success,
    ).toBe(false);
  });

  it("rejects reversed project dates and empty updates", () => {
    expect(
      ProjectCreateRequestSchema.safeParse({
        name: "Renovation",
        startsOn: "2026-09-10",
        endsOn: "2026-09-09",
      }).success,
    ).toBe(false);
    expect(ProjectUpdateRequestSchema.safeParse({ expectedVersion: 1 }).success).toBe(false);
    expect(ProjectArchiveRequestSchema.parse({ expectedVersion: 3 })).toEqual({
      expectedVersion: 3,
    });
  });
});
