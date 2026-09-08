import { describe, expect, it } from "vitest";

import {
  CurrentUserResponseSchema,
  IdentityProvisioningRequestSchema,
  PersonalMembershipUpdateRequestSchema,
  TenantBootstrapSchema,
  TenantInvitationAcceptRequestSchema,
  TenantInvitationCreateRequestSchema,
  TenantMembershipUpdateRequestSchema,
} from "../src/index.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const TENANT_ID = "22222222-2222-4222-8222-222222222222";
const PROFILE_ID = "33333333-3333-4333-8333-333333333333";
const TIMESTAMP = "2026-09-08T00:00:00.000Z";

describe("Phase 0J Wave 1 identity contracts", () => {
  it("parses the resolved current-user response", () => {
    expect(
      CurrentUserResponseSchema.parse({
        user: {
          id: USER_ID,
          primaryEmail: "owner@example.com",
          displayName: "Owner",
          status: "active",
        },
      }),
    ).toEqual({
      user: {
        id: USER_ID,
        primaryEmail: "owner@example.com",
        displayName: "Owner",
        status: "active",
      },
    });
  });

  it("normalizes a verified provider-neutral identity", () => {
    expect(
      IdentityProvisioningRequestSchema.parse({
        issuer: "https://identity.internal.test",
        subject: " provider-user-1 ",
        email: " USER@Example.COM ",
        emailVerified: true,
        displayName: " Test User ",
      }),
    ).toEqual({
      issuer: "https://identity.internal.test",
      subject: "provider-user-1",
      email: "user@example.com",
      emailVerified: true,
      displayName: "Test User",
    });
  });

  it("rejects unverified identities and unknown keys", () => {
    expect(
      IdentityProvisioningRequestSchema.safeParse({
        issuer: "https://identity.internal.test",
        subject: "provider-user-1",
        email: "user@example.com",
        emailVerified: false,
        displayName: "Test User",
      }).success,
    ).toBe(false);
    expect(
      IdentityProvisioningRequestSchema.safeParse({
        issuer: "https://identity.internal.test",
        subject: "provider-user-1",
        email: "user@example.com",
        emailVerified: true,
        displayName: "Test User",
        tenantId: TENANT_ID,
      }).success,
    ).toBe(false);
  });
});

describe("Phase 0J Wave 1 tenant contracts", () => {
  it("validates a complete tenant bootstrap response", () => {
    const bootstrap = {
      tenant: {
        id: TENANT_ID,
        name: "Family",
        slug: "family-22222222",
        status: "active",
        version: 1,
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
      },
      tenantMembership: {
        tenantId: TENANT_ID,
        userId: USER_ID,
        role: "owner",
        status: "active",
        version: 1,
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
      },
      personalProfile: {
        id: PROFILE_ID,
        tenantId: TENANT_ID,
        name: "Personal",
        version: 1,
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
      },
      personalMembership: {
        personalProfileId: PROFILE_ID,
        tenantId: TENANT_ID,
        userId: USER_ID,
        role: "owner",
        status: "active",
        version: 1,
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
      },
    };

    expect(TenantBootstrapSchema.parse(bootstrap)).toEqual(bootstrap);
    expect(
      TenantBootstrapSchema.safeParse({ ...bootstrap, extra: true }).success,
    ).toBe(false);
  });
});

describe("Phase 0J Wave 1 membership contracts", () => {
  it("accepts tenant-only and Personal invitation grants", () => {
    expect(
      TenantInvitationCreateRequestSchema.parse({
        email: " MEMBER@Example.com ",
        tenantRole: "member",
        grant: { type: "none" },
      }),
    ).toEqual({
      email: "member@example.com",
      tenantRole: "member",
      grant: { type: "none" },
    });

    expect(
      TenantInvitationCreateRequestSchema.parse({
        email: "member@example.com",
        tenantRole: "member",
        grant: { type: "personal", profileId: PROFILE_ID, role: "viewer" },
      }).grant,
    ).toEqual({ type: "personal", profileId: PROFILE_ID, role: "viewer" });
  });

  it("rejects unknown invitation grants and short acceptance tokens", () => {
    expect(
      TenantInvitationCreateRequestSchema.safeParse({
        email: "member@example.com",
        tenantRole: "member",
        grant: { type: "workspace", workspaceId: TENANT_ID, role: "viewer" },
      }).success,
    ).toBe(false);
    expect(
      TenantInvitationAcceptRequestSchema.safeParse({ token: "short" }).success,
    ).toBe(false);
  });

  it("requires membership updates to change role or status", () => {
    expect(
      TenantMembershipUpdateRequestSchema.safeParse({ expectedVersion: 1 })
        .success,
    ).toBe(false);
    expect(
      TenantMembershipUpdateRequestSchema.parse({
        expectedVersion: 2,
        role: "admin",
      }),
    ).toEqual({ expectedVersion: 2, role: "admin" });

    expect(
      PersonalMembershipUpdateRequestSchema.safeParse({ expectedVersion: 1 })
        .success,
    ).toBe(false);
    expect(
      PersonalMembershipUpdateRequestSchema.parse({
        expectedVersion: 3,
        status: "inactive",
      }),
    ).toEqual({ expectedVersion: 3, status: "inactive" });
  });
});
