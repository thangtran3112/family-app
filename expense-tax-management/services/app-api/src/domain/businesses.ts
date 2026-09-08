import { randomUUID } from "node:crypto";

import {
  BusinessBootstrapSchema,
  type BusinessBootstrap,
  type BusinessCreateRequest,
  type BusinessIndustry,
  type BusinessMembership,
  type BusinessUpdateRequest,
  type BusinessArchiveRequest,
  type SmallBusiness,
  type SpendingCategory,
} from "@expense-tax/contracts";
import { sql, type Kysely, type Selectable } from "kysely";

import type {
  AppDatabase,
  BusinessIndustryTable,
  BusinessMembershipTable,
  BusinessTable,
  SpendingCategoryTable,
} from "../database/types.js";
import { DomainError } from "../errors.js";
import { recordAuditEvent } from "./audit.js";
import {
  executeIdempotentMutation,
  hashNormalizedRequest,
  type MutationResult,
} from "./idempotency.js";

export interface BusinessDomain {
  listIndustries(): Promise<readonly BusinessIndustry[]>;
  create(input: {
    readonly actorUserId: string;
    readonly tenantId: string;
    readonly request: BusinessCreateRequest;
    readonly idempotencyKey: string;
    readonly requestId: string;
  }): Promise<MutationResult<BusinessBootstrap, 201>>;
  list(actorUserId: string, tenantId: string): Promise<readonly SmallBusiness[]>;
  get(actorUserId: string, tenantId: string, businessId: string): Promise<SmallBusiness>;
  update(input: {
    readonly actorUserId: string;
    readonly tenantId: string;
    readonly businessId: string;
    readonly request: BusinessUpdateRequest;
    readonly requestId: string;
  }): Promise<SmallBusiness>;
  archive(input: {
    readonly actorUserId: string;
    readonly tenantId: string;
    readonly businessId: string;
    readonly request: BusinessArchiveRequest;
    readonly requestId: string;
  }): Promise<SmallBusiness>;
}

function iso(value: Date): string {
  return value.toISOString();
}

function toIndustry(row: Selectable<BusinessIndustryTable>): BusinessIndustry {
  return { code: row.code, name: row.name, status: row.status };
}

function toBusiness(row: Selectable<BusinessTable>): SmallBusiness {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    industryCode: row.industry_code,
    timezone: row.timezone,
    baseCurrency: row.base_currency,
    status: row.status,
    version: row.version,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function toBusinessMembership(
  row: Selectable<BusinessMembershipTable>,
): BusinessMembership {
  return {
    businessId: row.business_id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    role: row.role,
    status: row.status,
    version: row.version,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function toSpendingCategory(
  row: Selectable<SpendingCategoryTable>,
): SpendingCategory {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    templateKey: row.template_key,
    name: row.name,
    description: row.description,
    color: row.color,
    icon: row.icon,
    status: row.status,
    version: row.version,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

async function requireTenantAdministrator(
  database: Kysely<AppDatabase>,
  actorUserId: string,
  tenantId: string,
): Promise<void> {
  const membership = await database
    .selectFrom("app.tenant_memberships as membership")
    .innerJoin("app.tenants as tenant", "tenant.id", "membership.tenant_id")
    .select("membership.role")
    .where("membership.tenant_id", "=", tenantId)
    .where("membership.user_id", "=", actorUserId)
    .where("membership.status", "=", "active")
    .where("tenant.status", "=", "active")
    .executeTakeFirst();
  if (!membership) throw DomainError.notFound();
  if (membership.role !== "owner" && membership.role !== "admin") {
    throw DomainError.forbidden();
  }
}

async function requireBusinessOwner(
  database: Kysely<AppDatabase>,
  input: { actorUserId: string; tenantId: string; businessId: string },
): Promise<Selectable<BusinessTable>> {
  const access = await database
    .selectFrom("app.businesses as business")
    .innerJoin("app.business_memberships as membership", (join) =>
      join
        .onRef("membership.business_id", "=", "business.id")
        .onRef("membership.tenant_id", "=", "business.tenant_id")
        .on("membership.user_id", "=", input.actorUserId)
        .on("membership.status", "=", "active"),
    )
    .innerJoin("app.tenant_memberships as tenant_membership", (join) =>
      join
        .onRef("tenant_membership.tenant_id", "=", "business.tenant_id")
        .on("tenant_membership.user_id", "=", input.actorUserId)
        .on("tenant_membership.status", "=", "active"),
    )
    .innerJoin("app.tenants as tenant", (join) =>
      join
        .onRef("tenant.id", "=", "business.tenant_id")
        .on("tenant.status", "=", "active"),
    )
    .selectAll("business")
    .select("membership.role")
    .where("business.id", "=", input.businessId)
    .where("business.tenant_id", "=", input.tenantId)
    .executeTakeFirst();
  if (!access) throw DomainError.notFound();
  if (access.role !== "owner") throw DomainError.forbidden();
  if (access.status === "archived") throw DomainError.conflict();
  return access;
}

export function createBusinessDomain(database: Kysely<AppDatabase>): BusinessDomain {
  return {
    async listIndustries() {
      const rows = await database
        .selectFrom("app.business_industries")
        .selectAll()
        .where("status", "=", "active")
        .orderBy("name", "asc")
        .execute();
      return rows.map(toIndustry);
    },

    async create(input) {
      return executeIdempotentMutation(database, {
        actorKey: `user:${input.actorUserId}`,
        operationKey: `business.create:${input.tenantId}`,
        idempotencyKey: input.idempotencyKey,
        requestHash: hashNormalizedRequest(input.request),
        statusCode: 201,
        parseBody: (value) => BusinessBootstrapSchema.parse(value),
        execute: async (transaction) => {
          await requireTenantAdministrator(
            transaction,
            input.actorUserId,
            input.tenantId,
          );
          const industry = await transaction
            .selectFrom("app.business_industries")
            .select("code")
            .where("code", "=", input.request.industryCode)
            .where("status", "=", "active")
            .executeTakeFirst();
          if (!industry) throw DomainError.validation();

          const now = new Date();
          const businessId = randomUUID();
          const businessRow: Selectable<BusinessTable> = {
            id: businessId,
            tenant_id: input.tenantId,
            name: input.request.name,
            industry_code: input.request.industryCode,
            timezone: input.request.timezone,
            base_currency: input.request.baseCurrency,
            status: "active",
            version: 1,
            created_at: now,
            updated_at: now,
            archived_at: null,
          };
          const membershipRow: Selectable<BusinessMembershipTable> = {
            business_id: businessId,
            tenant_id: input.tenantId,
            user_id: input.actorUserId,
            role: "owner",
            status: "active",
            version: 1,
            created_at: now,
            updated_at: now,
          };
          const templates = await transaction
            .selectFrom(
              "app.industry_spending_category_templates as industry_template",
            )
            .innerJoin(
              "app.spending_category_templates as template",
              "template.template_key",
              "industry_template.template_key",
            )
            .selectAll("template")
            .where("industry_template.industry_code", "=", input.request.industryCode)
            .orderBy("industry_template.sort_order", "asc")
            .execute();
          const categoryRows: Selectable<SpendingCategoryTable>[] = templates.map(
            (template) => ({
              id: randomUUID(),
              tenant_id: input.tenantId,
              template_key: template.template_key,
              name: template.name,
              description: template.description,
              color: template.color,
              icon: template.icon,
              status: "active",
              version: 1,
              created_at: now,
              updated_at: now,
              archived_at: null,
            }),
          );

          await transaction.insertInto("app.businesses").values(businessRow).execute();
          await transaction
            .insertInto("app.business_memberships")
            .values(membershipRow)
            .execute();
          const createdCategoryRows =
            categoryRows.length === 0
              ? []
              : await transaction
              .insertInto("app.spending_categories")
              .values(categoryRows)
              .onConflict((conflict) => conflict.doNothing())
              .returningAll()
              .execute();
          await recordAuditEvent(transaction, {
            tenantId: input.tenantId,
            actorUserId: input.actorUserId,
            action: "business.created",
            outcome: "success",
            resourceType: "business",
            resourceId: businessId,
            requestId: input.requestId,
          });
          return {
            business: toBusiness(businessRow),
            businessMembership: toBusinessMembership(membershipRow),
            createdSpendingCategories: createdCategoryRows.map(toSpendingCategory),
          };
        },
      });
    },

    async list(actorUserId, tenantId) {
      const rows = await database
        .selectFrom("app.businesses as business")
        .innerJoin("app.business_memberships as membership", (join) =>
          join
            .onRef("membership.business_id", "=", "business.id")
            .onRef("membership.tenant_id", "=", "business.tenant_id")
            .on("membership.user_id", "=", actorUserId)
            .on("membership.status", "=", "active"),
        )
        .innerJoin("app.tenant_memberships as tenant_membership", (join) =>
          join
            .onRef("tenant_membership.tenant_id", "=", "business.tenant_id")
            .on("tenant_membership.user_id", "=", actorUserId)
            .on("tenant_membership.status", "=", "active"),
        )
        .innerJoin("app.tenants as tenant", (join) =>
          join
            .onRef("tenant.id", "=", "business.tenant_id")
            .on("tenant.status", "=", "active"),
        )
        .selectAll("business")
        .where("business.tenant_id", "=", tenantId)
        .where("business.status", "=", "active")
        .orderBy("business.created_at", "asc")
        .execute();
      return rows.map(toBusiness);
    },

    async get(actorUserId, tenantId, businessId) {
      const row = await database
        .selectFrom("app.businesses as business")
        .innerJoin("app.business_memberships as membership", (join) =>
          join
            .onRef("membership.business_id", "=", "business.id")
            .onRef("membership.tenant_id", "=", "business.tenant_id")
            .on("membership.user_id", "=", actorUserId)
            .on("membership.status", "=", "active"),
        )
        .innerJoin("app.tenant_memberships as tenant_membership", (join) =>
          join
            .onRef("tenant_membership.tenant_id", "=", "business.tenant_id")
            .on("tenant_membership.user_id", "=", actorUserId)
            .on("tenant_membership.status", "=", "active"),
        )
        .innerJoin("app.tenants as tenant", (join) =>
          join
            .onRef("tenant.id", "=", "business.tenant_id")
            .on("tenant.status", "=", "active"),
        )
        .selectAll("business")
        .where("business.id", "=", businessId)
        .where("business.tenant_id", "=", tenantId)
        .where("business.status", "=", "active")
        .executeTakeFirst();
      if (!row) throw DomainError.notFound();
      return toBusiness(row);
    },

    async update(input) {
      return database.transaction().execute(async (transaction) => {
        await requireBusinessOwner(transaction, input);
        const updated = await transaction
          .updateTable("app.businesses")
          .set({
            ...(input.request.name === undefined
              ? {}
              : { name: input.request.name }),
            ...(input.request.industryCode === undefined
              ? {}
              : { industry_code: input.request.industryCode }),
            ...(input.request.timezone === undefined
              ? {}
              : { timezone: input.request.timezone }),
            ...(input.request.baseCurrency === undefined
              ? {}
              : { base_currency: input.request.baseCurrency }),
            version: sql<number>`version + 1`,
            updated_at: new Date(),
          })
          .where("id", "=", input.businessId)
          .where("tenant_id", "=", input.tenantId)
          .where("version", "=", input.request.expectedVersion)
          .where("status", "=", "active")
          .returningAll()
          .executeTakeFirst();
        if (!updated) throw DomainError.conflict();
        await recordAuditEvent(transaction, {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          action: "business.updated",
          outcome: "success",
          resourceType: "business",
          resourceId: input.businessId,
          requestId: input.requestId,
        });
        return toBusiness(updated);
      });
    },

    async archive(input) {
      return database.transaction().execute(async (transaction) => {
        await requireBusinessOwner(transaction, input);
        const updated = await transaction
          .updateTable("app.businesses")
          .set({
            status: "archived",
            archived_at: new Date(),
            updated_at: new Date(),
            version: sql<number>`version + 1`,
          })
          .where("id", "=", input.businessId)
          .where("tenant_id", "=", input.tenantId)
          .where("version", "=", input.request.expectedVersion)
          .where("status", "=", "active")
          .returningAll()
          .executeTakeFirst();
        if (!updated) throw DomainError.conflict();
        await recordAuditEvent(transaction, {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          action: "business.archived",
          outcome: "success",
          resourceType: "business",
          resourceId: input.businessId,
          requestId: input.requestId,
        });
        return toBusiness(updated);
      });
    },
  };
}
