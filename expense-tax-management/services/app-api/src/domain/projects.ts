import { randomUUID } from "node:crypto";

import type {
  BusinessRole,
  Project,
  ProjectArchiveRequest,
  ProjectCreateRequest,
  ProjectUpdateRequest,
} from "@expense-tax/contracts";
import { sql, type Kysely, type Selectable, type Transaction } from "kysely";

import type { AppDatabase, ProjectTable } from "../database/types.js";
import { DomainError } from "../errors.js";
import { recordAuditEvent } from "./audit.js";

interface ProjectScope {
  readonly actorUserId: string;
  readonly tenantId: string;
  readonly businessId: string;
}

export interface ProjectDomain {
  list(
    actorUserId: string,
    tenantId: string,
    businessId: string,
  ): Promise<readonly Project[]>;
  get(
    actorUserId: string,
    tenantId: string,
    businessId: string,
    projectId: string,
  ): Promise<Project>;
  create(input: ProjectScope & {
    readonly request: ProjectCreateRequest;
    readonly requestId: string;
  }): Promise<Project>;
  update(input: ProjectScope & {
    readonly projectId: string;
    readonly request: ProjectUpdateRequest;
    readonly requestId: string;
  }): Promise<Project>;
  archive(input: ProjectScope & {
    readonly projectId: string;
    readonly request: ProjectArchiveRequest;
    readonly requestId: string;
  }): Promise<Project>;
}

function toProject(row: Selectable<ProjectTable>): Project {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    businessId: row.business_id,
    name: row.name,
    clientName: row.client_name,
    description: row.description,
    status: row.status,
    startsOn: dateOnly(row.starts_on),
    endsOn: dateOnly(row.ends_on),
    version: row.version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function dateOnly(value: Date | string | null): string | null {
  if (value === null || typeof value === "string") return value;
  const year = String(value.getFullYear()).padStart(4, "0");
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function businessAccess(
  database: Kysely<AppDatabase>,
  input: ProjectScope,
): Promise<{ role: BusinessRole; status: "active" | "archived" }> {
  const access = await database
    .selectFrom("app.businesses as business")
    .innerJoin("app.tenants as tenant", (join) =>
      join
        .onRef("tenant.id", "=", "business.tenant_id")
        .on("tenant.status", "=", "active"),
    )
    .innerJoin("app.tenant_memberships as tenant_membership", (join) =>
      join
        .onRef("tenant_membership.tenant_id", "=", "business.tenant_id")
        .on("tenant_membership.user_id", "=", input.actorUserId)
        .on("tenant_membership.status", "=", "active"),
    )
    .innerJoin("app.business_memberships as business_membership", (join) =>
      join
        .onRef("business_membership.business_id", "=", "business.id")
        .onRef("business_membership.tenant_id", "=", "business.tenant_id")
        .on("business_membership.user_id", "=", input.actorUserId)
        .on("business_membership.status", "=", "active"),
    )
    .select(["business.status", "business_membership.role"])
    .where("business.id", "=", input.businessId)
    .where("business.tenant_id", "=", input.tenantId)
    .executeTakeFirst();
  if (!access) throw DomainError.notFound();
  return access;
}

async function requireBusinessReader(
  database: Kysely<AppDatabase>,
  input: ProjectScope,
): Promise<void> {
  const access = await businessAccess(database, input);
  if (access.status !== "active") throw DomainError.notFound();
}

async function requireBusinessWriter(
  database: Kysely<AppDatabase>,
  input: ProjectScope,
): Promise<void> {
  const access = await businessAccess(database, input);
  if (access.status === "archived") throw DomainError.conflict();
  if (access.role !== "owner" && access.role !== "editor") {
    throw DomainError.forbidden();
  }
}

async function mutableProject(
  transaction: Transaction<AppDatabase>,
  input: ProjectScope & { projectId: string },
): Promise<Selectable<ProjectTable>> {
  const project = await transaction
    .selectFrom("app.projects")
    .selectAll()
    .where("id", "=", input.projectId)
    .where("tenant_id", "=", input.tenantId)
    .where("business_id", "=", input.businessId)
    .executeTakeFirst();
  if (!project) throw DomainError.notFound();
  if (project.status === "archived") throw DomainError.conflict();
  return project;
}

function validateDates(startsOn: string | null, endsOn: string | null): void {
  if (startsOn && endsOn && endsOn < startsOn) throw DomainError.validation();
}

export function createProjectDomain(database: Kysely<AppDatabase>): ProjectDomain {
  return {
    async list(actorUserId, tenantId, businessId) {
      await requireBusinessReader(database, { actorUserId, tenantId, businessId });
      const rows = await database
        .selectFrom("app.projects")
        .selectAll()
        .where("tenant_id", "=", tenantId)
        .where("business_id", "=", businessId)
        .where("status", "!=", "archived")
        .orderBy("created_at", "asc")
        .execute();
      return rows.map(toProject);
    },

    async get(actorUserId, tenantId, businessId, projectId) {
      await requireBusinessReader(database, { actorUserId, tenantId, businessId });
      const row = await database
        .selectFrom("app.projects")
        .selectAll()
        .where("id", "=", projectId)
        .where("tenant_id", "=", tenantId)
        .where("business_id", "=", businessId)
        .where("status", "!=", "archived")
        .executeTakeFirst();
      if (!row) throw DomainError.notFound();
      return toProject(row);
    },

    async create(input) {
      return database.transaction().execute(async (transaction) => {
        await requireBusinessWriter(transaction, input);
        validateDates(input.request.startsOn ?? null, input.request.endsOn ?? null);
        const now = new Date();
        const created = await transaction
          .insertInto("app.projects")
          .values({
            id: randomUUID(),
            tenant_id: input.tenantId,
            business_id: input.businessId,
            name: input.request.name,
            client_name: input.request.clientName ?? null,
            description: input.request.description ?? null,
            status: "active",
            starts_on: input.request.startsOn ?? null,
            ends_on: input.request.endsOn ?? null,
            version: 1,
            created_at: now,
            updated_at: now,
            archived_at: null,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await recordAuditEvent(transaction, {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          action: "project.created",
          outcome: "success",
          resourceType: "project",
          resourceId: created.id,
          requestId: input.requestId,
        });
        return toProject(created);
      });
    },

    async update(input) {
      return database.transaction().execute(async (transaction) => {
        await requireBusinessWriter(transaction, input);
        const current = await mutableProject(transaction, input);
        const startsOn =
          input.request.startsOn === undefined
            ? dateOnly(current.starts_on)
            : input.request.startsOn;
        const endsOn =
          input.request.endsOn === undefined
            ? dateOnly(current.ends_on)
            : input.request.endsOn;
        validateDates(startsOn, endsOn);
        const updated = await transaction
          .updateTable("app.projects")
          .set({
            ...(input.request.name === undefined
              ? {}
              : { name: input.request.name }),
            ...(input.request.clientName === undefined
              ? {}
              : { client_name: input.request.clientName }),
            ...(input.request.description === undefined
              ? {}
              : { description: input.request.description }),
            ...(input.request.status === undefined
              ? {}
              : { status: input.request.status }),
            ...(input.request.startsOn === undefined
              ? {}
              : { starts_on: input.request.startsOn }),
            ...(input.request.endsOn === undefined
              ? {}
              : { ends_on: input.request.endsOn }),
            version: sql<number>`version + 1`,
            updated_at: new Date(),
          })
          .where("id", "=", input.projectId)
          .where("tenant_id", "=", input.tenantId)
          .where("business_id", "=", input.businessId)
          .where("status", "!=", "archived")
          .where("version", "=", input.request.expectedVersion)
          .returningAll()
          .executeTakeFirst();
        if (!updated) throw DomainError.conflict();
        await recordAuditEvent(transaction, {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          action: "project.updated",
          outcome: "success",
          resourceType: "project",
          resourceId: input.projectId,
          requestId: input.requestId,
        });
        return toProject(updated);
      });
    },

    async archive(input) {
      return database.transaction().execute(async (transaction) => {
        await requireBusinessWriter(transaction, input);
        await mutableProject(transaction, input);
        const updated = await transaction
          .updateTable("app.projects")
          .set({
            status: "archived",
            archived_at: new Date(),
            updated_at: new Date(),
            version: sql<number>`version + 1`,
          })
          .where("id", "=", input.projectId)
          .where("tenant_id", "=", input.tenantId)
          .where("business_id", "=", input.businessId)
          .where("status", "!=", "archived")
          .where("version", "=", input.request.expectedVersion)
          .returningAll()
          .executeTakeFirst();
        if (!updated) throw DomainError.conflict();
        await recordAuditEvent(transaction, {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          action: "project.archived",
          outcome: "success",
          resourceType: "project",
          resourceId: input.projectId,
          requestId: input.requestId,
        });
        return toProject(updated);
      });
    },
  };
}
