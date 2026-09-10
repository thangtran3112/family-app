import type { Kysely, Transaction } from "kysely";

import type { AppDatabase } from "../database/types.js";

export type ClerkIdentityNotProvisionedReason =
  | "unknown_user"
  | "unknown_org"
  | "user_deleted"
  | "org_deleted"
  | "org_mismatch";

export type TenantIdentityResolution =
  | {
      readonly status: "resolved";
      readonly userId: string;
      readonly tenantId: string;
      readonly role: "owner" | "admin" | "member";
    }
  | {
      readonly status: "not_provisioned";
      readonly reason: ClerkIdentityNotProvisionedReason;
    };

export type ClerkMappingResult =
  | {
      readonly status: "mapped";
      readonly userId?: string;
      readonly tenantId?: string;
    }
  | {
      readonly status: "not_provisioned";
      readonly reason:
        | "unknown_user"
        | "unknown_org"
        | "user_deleted"
        | "org_deleted";
    }
  | {
      readonly status: "conflict";
      readonly reason:
        | "user_remap"
        | "organization_remap"
        | "user_mapping_not_applied"
        | "organization_mapping_not_applied";
    };

export interface ClerkIdentityMappingRepository {
  findUserById(userId: string): Promise<{
    readonly id: string;
    readonly clerk_user_id: string | null;
    readonly status: "active" | "disabled";
  } | undefined>;
  findTenantById(tenantId: string): Promise<{
    readonly id: string;
    readonly clerk_org_id: string | null;
    readonly status: "active" | "archived";
  } | undefined>;
  findUserByClerkId(clerkUserId: string): Promise<{
    readonly id: string;
    readonly clerk_user_id: string | null;
    readonly status: "active" | "disabled";
  } | undefined>;
  findTenantByClerkOrgId(clerkOrgId: string): Promise<{
    readonly id: string;
    readonly clerk_org_id: string | null;
    readonly status: "active" | "archived";
  } | undefined>;
  findMembership(
    userId: string,
    tenantId: string,
  ): Promise<
    | {
        readonly role: "owner" | "admin" | "member";
        readonly status: "active" | "inactive";
      }
    | undefined
  >;
  setClerkUserId(userId: string, clerkUserId: string): Promise<number>;
  setClerkOrgId(tenantId: string, clerkOrgId: string): Promise<number>;
}

export interface ClerkIdentityMappingDomain {
  resolveTenantIdentity(
    clerkUserId: string,
    clerkOrgId: string,
  ): Promise<TenantIdentityResolution>;
  mapUser(userId: string, clerkUserId: string): Promise<ClerkMappingResult>;
  mapOrganization(tenantId: string, clerkOrgId: string): Promise<ClerkMappingResult>;
}

export function createClerkIdentityMappingDomain(
  repository: ClerkIdentityMappingRepository,
): ClerkIdentityMappingDomain {
  return {
    async resolveTenantIdentity(clerkUserId, clerkOrgId) {
      const user = await repository.findUserByClerkId(clerkUserId);
      if (!user) {
        return { status: "not_provisioned", reason: "unknown_user" };
      }
      if (user.status !== "active") {
        return { status: "not_provisioned", reason: "user_deleted" };
      }

      const tenant = await repository.findTenantByClerkOrgId(clerkOrgId);
      if (!tenant) {
        return { status: "not_provisioned", reason: "unknown_org" };
      }
      if (tenant.status !== "active") {
        return { status: "not_provisioned", reason: "org_deleted" };
      }

      const membership = await repository.findMembership(user.id, tenant.id);
      if (!membership || membership.status !== "active") {
        return { status: "not_provisioned", reason: "org_mismatch" };
      }

      return {
        status: "resolved",
        userId: user.id,
        tenantId: tenant.id,
        role: membership.role,
      };
    },

    async mapUser(userId, clerkUserId) {
      const user = await repository.findUserById(userId);
      if (!user) {
        return { status: "not_provisioned", reason: "unknown_user" };
      }
      if (user.status !== "active") {
        return { status: "not_provisioned", reason: "user_deleted" };
      }
      if (user.clerk_user_id !== null && user.clerk_user_id !== clerkUserId) {
        return { status: "conflict", reason: "user_remap" };
      }

      const affectedRows = await repository.setClerkUserId(userId, clerkUserId);
      if (affectedRows !== 1) {
        return { status: "conflict", reason: "user_mapping_not_applied" };
      }
      return { status: "mapped", userId };
    },

    async mapOrganization(tenantId, clerkOrgId) {
      const tenant = await repository.findTenantById(tenantId);
      if (!tenant) {
        return { status: "not_provisioned", reason: "unknown_org" };
      }
      if (tenant.status !== "active") {
        return { status: "not_provisioned", reason: "org_deleted" };
      }
      if (tenant.clerk_org_id !== null && tenant.clerk_org_id !== clerkOrgId) {
        return { status: "conflict", reason: "organization_remap" };
      }

      const affectedRows = await repository.setClerkOrgId(tenantId, clerkOrgId);
      if (affectedRows !== 1) {
        return {
          status: "conflict",
          reason: "organization_mapping_not_applied",
        };
      }
      return { status: "mapped", tenantId };
    },
  };
}

type AppDatabaseExecutor = Kysely<AppDatabase> | Transaction<AppDatabase>;

export function createDatabaseClerkIdentityMappingRepository(
  database: AppDatabaseExecutor,
): ClerkIdentityMappingRepository {
  return {
    async findUserById(userId) {
      return database
        .selectFrom("app.users")
        .select(["id", "clerk_user_id", "status"])
        .where("id", "=", userId)
        .executeTakeFirst();
    },
    async findTenantById(tenantId) {
      return database
        .selectFrom("app.tenants")
        .select(["id", "clerk_org_id", "status"])
        .where("id", "=", tenantId)
        .executeTakeFirst();
    },
    async findUserByClerkId(clerkUserId) {
      return database
        .selectFrom("app.users")
        .select(["id", "clerk_user_id", "status"])
        .where("clerk_user_id", "=", clerkUserId)
        .executeTakeFirst();
    },
    async findTenantByClerkOrgId(clerkOrgId) {
      return database
        .selectFrom("app.tenants")
        .select(["id", "clerk_org_id", "status"])
        .where("clerk_org_id", "=", clerkOrgId)
        .executeTakeFirst();
    },
    async findMembership(userId, tenantId) {
      return database
        .selectFrom("app.tenant_memberships")
        .select(["role", "status"])
        .where("user_id", "=", userId)
        .where("tenant_id", "=", tenantId)
        .executeTakeFirst();
    },
    async setClerkUserId(userId, clerkUserId) {
      const rows = await database
        .updateTable("app.users")
        .set({ clerk_user_id: clerkUserId })
        .where("id", "=", userId)
        .where("status", "=", "active")
        .where((expression) =>
          expression.or([
            expression("clerk_user_id", "is", null),
            expression("clerk_user_id", "=", clerkUserId),
          ]),
        )
        .returning("id")
        .execute();
      return rows.length;
    },
    async setClerkOrgId(tenantId, clerkOrgId) {
      const rows = await database
        .updateTable("app.tenants")
        .set({ clerk_org_id: clerkOrgId })
        .where("id", "=", tenantId)
        .where("status", "=", "active")
        .where((expression) =>
          expression.or([
            expression("clerk_org_id", "is", null),
            expression("clerk_org_id", "=", clerkOrgId),
          ]),
        )
        .returning("id")
        .execute();
      return rows.length;
    },
  };
}

export function createDatabaseClerkIdentityMappingDomain(
  database: AppDatabaseExecutor,
): ClerkIdentityMappingDomain {
  return createClerkIdentityMappingDomain(
    createDatabaseClerkIdentityMappingRepository(database),
  );
}

/**
 * Resolve identity inside caller's financial mutation transaction. Callers
 * must use same transaction for authorization lookup and financial writes.
 */
export function resolveTenantIdentityInTransaction(
  transaction: Transaction<AppDatabase>,
  clerkUserId: string,
  clerkOrgId: string,
): Promise<TenantIdentityResolution> {
  return createDatabaseClerkIdentityMappingDomain(transaction).resolveTenantIdentity(
    clerkUserId,
    clerkOrgId,
  );
}
