import { describe, expect, it } from "vitest";

import {
  createClerkIdentityMappingDomain,
  type ClerkIdentityMappingRepository,
} from "../src/domain/clerk-identity.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_USER_ID = "22222222-2222-4222-8222-222222222222";
const TENANT_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_TENANT_ID = "44444444-4444-4444-8444-444444444444";

interface State {
  users: Array<{
    id: string;
    clerk_user_id: string | null;
    status: "active" | "disabled";
  }>;
  tenants: Array<{
    id: string;
    clerk_org_id: string | null;
    status: "active" | "archived";
  }>;
  memberships: Array<{
    user_id: string;
    tenant_id: string;
    role: "owner" | "admin" | "member";
    status: "active" | "inactive";
  }>;
  updateCount: number;
}

function repository(state: State): ClerkIdentityMappingRepository {
  return {
    async findUserById(userId) {
      return state.users.find((user) => user.id === userId);
    },
    async findTenantById(tenantId) {
      return state.tenants.find((tenant) => tenant.id === tenantId);
    },
    async findUserByClerkId(clerkUserId) {
      return state.users.find((user) => user.clerk_user_id === clerkUserId);
    },
    async findTenantByClerkOrgId(clerkOrgId) {
      return state.tenants.find((tenant) => tenant.clerk_org_id === clerkOrgId);
    },
    async findMembership(userId, tenantId) {
      return state.memberships.find(
        (membership) =>
          membership.user_id === userId && membership.tenant_id === tenantId,
      );
    },
    async setClerkUserId(userId, clerkUserId) {
      if (state.updateCount === 0) return 0;
      const user = state.users.find((candidate) => candidate.id === userId);
      if (!user) throw new Error("user not found");
      const conflict = state.users.find(
        (candidate) =>
          candidate.id !== userId && candidate.clerk_user_id === clerkUserId,
      );
      if (conflict) throw new Error("unique violation");
      user.clerk_user_id = clerkUserId;
      return 1;
    },
    async setClerkOrgId(tenantId, clerkOrgId) {
      if (state.updateCount === 0) return 0;
      const tenant = state.tenants.find((candidate) => candidate.id === tenantId);
      if (!tenant) throw new Error("tenant not found");
      const conflict = state.tenants.find(
        (candidate) =>
          candidate.id !== tenantId && candidate.clerk_org_id === clerkOrgId,
      );
      if (conflict) throw new Error("unique violation");
      tenant.clerk_org_id = clerkOrgId;
      return 1;
    },
  };
}

function activeState(): State {
  return {
    users: [{ id: USER_ID, clerk_user_id: "user_1", status: "active" }],
    tenants: [{ id: TENANT_ID, clerk_org_id: "org_1", status: "active" }],
    memberships: [
      {
        user_id: USER_ID,
        tenant_id: TENANT_ID,
        role: "owner",
        status: "active",
      },
    ],
    updateCount: 1,
  };
}

describe("Clerk identity mapping", () => {
  it("resolves active Clerk user and org through active tenant membership", async () => {
    const domain = createClerkIdentityMappingDomain(repository(activeState()));

    await expect(domain.resolveTenantIdentity("user_1", "org_1")).resolves.toEqual({
      status: "resolved",
      userId: USER_ID,
      tenantId: TENANT_ID,
      role: "owner",
    });
  });

  it.each([
    ["unknown user", "missing_user", "org_1", "unknown_user"],
    ["unknown org", "user_1", "missing_org", "unknown_org"],
  ] as const)("fails closed for %s", async (_label, userId, orgId, reason) => {
    const domain = createClerkIdentityMappingDomain(repository(activeState()));

    await expect(domain.resolveTenantIdentity(userId, orgId)).resolves.toEqual({
      status: "not_provisioned",
      reason,
    });
  });

  it.each([
    ["disabled user", { userStatus: "disabled" as const, tenantStatus: "active" as const }, "user_deleted"],
    ["archived org", { userStatus: "active" as const, tenantStatus: "archived" as const }, "org_deleted"],
  ] as const)("fails closed for %s", async (_label, statuses, reason) => {
    const state = activeState();
    state.users[0].status = statuses.userStatus;
    state.tenants[0].status = statuses.tenantStatus;
    const domain = createClerkIdentityMappingDomain(repository(state));

    await expect(domain.resolveTenantIdentity("user_1", "org_1")).resolves.toEqual({
      status: "not_provisioned",
      reason,
    });
  });

  it("fails closed when Clerk user is not a member of resolved org", async () => {
    const state = activeState();
    state.users.push({
      id: OTHER_USER_ID,
      clerk_user_id: "user_2",
      status: "active",
    });
    const domain = createClerkIdentityMappingDomain(repository(state));

    await expect(domain.resolveTenantIdentity("user_2", "org_1")).resolves.toEqual({
      status: "not_provisioned",
      reason: "org_mismatch",
    });
  });

  it("fails closed when user and org resolve to separate mappings", async () => {
    const state = activeState();
    state.tenants.push({
      id: OTHER_TENANT_ID,
      clerk_org_id: "org_2",
      status: "active",
    });
    state.memberships.push({
      user_id: USER_ID,
      tenant_id: OTHER_TENANT_ID,
      role: "member",
      status: "inactive",
    });
    const domain = createClerkIdentityMappingDomain(repository(state));

    await expect(domain.resolveTenantIdentity("user_1", "org_2")).resolves.toEqual({
      status: "not_provisioned",
      reason: "org_mismatch",
    });
  });

  it("upserts identical Clerk mappings idempotently", async () => {
    const state = activeState();
    const domain = createClerkIdentityMappingDomain(repository(state));

    await expect(domain.mapUser(USER_ID, "user_1")).resolves.toEqual({
      status: "mapped",
      userId: USER_ID,
    });
    await expect(domain.mapUser(USER_ID, "user_1")).resolves.toEqual({
      status: "mapped",
      userId: USER_ID,
    });
    await expect(domain.mapOrganization(TENANT_ID, "org_1")).resolves.toEqual({
      status: "mapped",
      tenantId: TENANT_ID,
    });
    await expect(domain.mapOrganization(TENANT_ID, "org_1")).resolves.toEqual({
      status: "mapped",
      tenantId: TENANT_ID,
    });
  });

  it.each([
    ["unknown user", "missing-user", "unknown_user"],
    ["disabled user", USER_ID, "user_deleted"],
  ] as const)("rejects %s user mapping", async (_label, userId, reason) => {
    const state = activeState();
    if (reason === "user_deleted") state.users[0].status = "disabled";
    const domain = createClerkIdentityMappingDomain(repository(state));

    await expect(domain.mapUser(userId, "new-user")).resolves.toEqual({
      status: "not_provisioned",
      reason,
    });
  });

  it("rejects user remapping and affected-row races", async () => {
    const state = activeState();
    const domain = createClerkIdentityMappingDomain(repository(state));

    await expect(domain.mapUser(USER_ID, "different-user")).resolves.toEqual({
      status: "conflict",
      reason: "user_remap",
    });
    state.users[0].clerk_user_id = null;
    state.updateCount = 0;
    await expect(domain.mapUser(USER_ID, "new-user")).resolves.toEqual({
      status: "conflict",
      reason: "user_mapping_not_applied",
    });
  });

  it.each([
    ["unknown organization", "missing-org", "unknown_org"],
    ["archived organization", TENANT_ID, "org_deleted"],
  ] as const)("rejects %s mapping", async (_label, tenantId, reason) => {
    const state = activeState();
    if (reason === "org_deleted") state.tenants[0].status = "archived";
    const domain = createClerkIdentityMappingDomain(repository(state));

    await expect(domain.mapOrganization(tenantId, "new-org")).resolves.toEqual({
      status: "not_provisioned",
      reason,
    });
  });

  it("rejects organization remapping", async () => {
    const domain = createClerkIdentityMappingDomain(repository(activeState()));

    await expect(domain.mapOrganization(TENANT_ID, "different-org")).resolves.toEqual({
      status: "conflict",
      reason: "organization_remap",
    });
  });
});
