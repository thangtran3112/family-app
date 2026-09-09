import { randomUUID } from "node:crypto";

import type {
  BusinessExpenseCollectionParams,
  BusinessExpenseParams,
  Expense,
  ExpenseArchiveRequest,
  ExpenseCreateRequest,
  ExpenseList,
  ExpenseUpdateRequest,
  LedgerQuery,
  PersonalExpenseCollectionParams,
  PersonalExpenseParams,
} from "@expense-tax/contracts";
import { sql, type Kysely, type Selectable, type Transaction } from "kysely";

import type { AppDatabase, ExpenseTable } from "../database/types.js";
import { DomainError } from "../errors.js";
import { recordAuditEvent } from "./audit.js";
import {
  decodeLedgerCursor,
  encodeLedgerCursor,
  ledgerFilterHash,
} from "../pagination/cursor.js";

export interface PersonalExpenseCreateCommand {
  readonly actorUserId: string;
  readonly tenantId: string;
  readonly profileId: string;
  readonly request: ExpenseCreateRequest;
  readonly requestId: string;
}

export interface BusinessExpenseCreateCommand {
  readonly actorUserId: string;
  readonly tenantId: string;
  readonly businessId: string;
  readonly request: ExpenseCreateRequest;
  readonly requestId: string;
}

export interface ExpenseUpdateCommand {
  readonly actorUserId: string;
  readonly tenantId: string;
  readonly expenseId: string;
  readonly request: ExpenseUpdateRequest;
  readonly requestId: string;
}

export interface ExpenseArchiveCommand {
  readonly actorUserId: string;
  readonly tenantId: string;
  readonly expenseId: string;
  readonly request: ExpenseArchiveRequest;
  readonly requestId: string;
}

export interface ExpenseDomain {
  createPersonal(input: PersonalExpenseCreateCommand): Promise<Expense>;
  createBusiness(input: BusinessExpenseCreateCommand): Promise<Expense>;
  listPersonal(
    input: PersonalExpenseCollectionParams & {
      readonly actorUserId: string;
      readonly query: LedgerQuery;
    },
  ): Promise<ExpenseList>;
  listBusiness(
    input: BusinessExpenseCollectionParams & {
      readonly actorUserId: string;
      readonly query: LedgerQuery;
    },
  ): Promise<ExpenseList>;
  getPersonal(input: PersonalExpenseParams & { readonly actorUserId: string }): Promise<Expense>;
  getBusiness(input: BusinessExpenseParams & { readonly actorUserId: string }): Promise<Expense>;
  updatePersonal(input: ExpenseUpdateCommand & { readonly profileId: string }): Promise<Expense>;
  updateBusiness(input: ExpenseUpdateCommand & { readonly businessId: string }): Promise<Expense>;
  archivePersonal(input: ExpenseArchiveCommand & { readonly profileId: string }): Promise<void>;
  archiveBusiness(input: ExpenseArchiveCommand & { readonly businessId: string }): Promise<void>;
}

function dateOnly(value: Date | string): string {
  if (typeof value === "string") return value;
  return `${String(value.getFullYear()).padStart(4, "0")}-${String(
    value.getMonth() + 1,
  ).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

function toExpense(row: Selectable<ExpenseTable>): Expense {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    createdByUserId: row.created_by_user_id,
    personalProfileId: row.personal_profile_id,
    businessId: row.business_id,
    projectId: row.project_id,
    spendingCategoryId: row.spending_category_id,
    merchant: row.merchant,
    description: row.description,
    amount: String(row.amount),
    currency: row.currency,
    incurredOn: dateOnly(row.incurred_on as Date | string),
    taxYear: row.tax_year,
    source: row.source,
    status: row.status,
    version: row.version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

type Scope =
  | { readonly kind: "personal"; readonly profileId: string }
  | { readonly kind: "business"; readonly businessId: string };

async function personalRole(
  database: Kysely<AppDatabase>,
  input: { actorUserId: string; tenantId: string; profileId: string },
): Promise<"owner" | "editor" | "viewer"> {
  const access = await database
    .selectFrom("app.personal_profiles as profile")
    .innerJoin("app.tenants as tenant", (join) =>
      join.onRef("tenant.id", "=", "profile.tenant_id").on("tenant.status", "=", "active"),
    )
    .innerJoin("app.tenant_memberships as tenant_membership", (join) =>
      join
        .onRef("tenant_membership.tenant_id", "=", "profile.tenant_id")
        .on("tenant_membership.user_id", "=", input.actorUserId)
        .on("tenant_membership.status", "=", "active"),
    )
    .innerJoin("app.personal_memberships as membership", (join) =>
      join
        .onRef("membership.personal_profile_id", "=", "profile.id")
        .onRef("membership.tenant_id", "=", "profile.tenant_id")
        .on("membership.user_id", "=", input.actorUserId)
        .on("membership.status", "=", "active"),
    )
    .select("membership.role")
    .where("profile.id", "=", input.profileId)
    .where("profile.tenant_id", "=", input.tenantId)
    .executeTakeFirst();
  if (!access) throw DomainError.notFound();
  return access.role;
}

async function businessRole(
  database: Kysely<AppDatabase>,
  input: { actorUserId: string; tenantId: string; businessId: string },
): Promise<"owner" | "editor" | "viewer"> {
  const access = await database
    .selectFrom("app.businesses as business")
    .innerJoin("app.tenants as tenant", (join) =>
      join.onRef("tenant.id", "=", "business.tenant_id").on("tenant.status", "=", "active"),
    )
    .innerJoin("app.tenant_memberships as tenant_membership", (join) =>
      join
        .onRef("tenant_membership.tenant_id", "=", "business.tenant_id")
        .on("tenant_membership.user_id", "=", input.actorUserId)
        .on("tenant_membership.status", "=", "active"),
    )
    .innerJoin("app.business_memberships as membership", (join) =>
      join
        .onRef("membership.business_id", "=", "business.id")
        .onRef("membership.tenant_id", "=", "business.tenant_id")
        .on("membership.user_id", "=", input.actorUserId)
        .on("membership.status", "=", "active"),
    )
    .select("membership.role")
    .where("business.id", "=", input.businessId)
    .where("business.tenant_id", "=", input.tenantId)
    .where("business.status", "=", "active")
    .executeTakeFirst();
  if (!access) throw DomainError.notFound();
  return access.role;
}

function canWrite(role: "owner" | "editor" | "viewer"): boolean {
  return role === "owner" || role === "editor";
}

function assertRequestScope(request: ExpenseCreateRequest, scope: Scope): void {
  if (scope.kind === "personal") {
    if (request.personalProfileId !== scope.profileId || request.businessId != null) {
      throw DomainError.notFound();
    }
    if (request.projectId != null) throw DomainError.validation();
    return;
  }
  if (request.businessId !== scope.businessId || request.personalProfileId != null) {
    throw DomainError.notFound();
  }
}

export async function insertExpenseInTransaction(
  transaction: Transaction<AppDatabase>,
  input: {
    actorUserId: string;
    tenantId: string;
    request: ExpenseCreateRequest;
    requestId: string;
    scope: Scope;
    source?: "manual" | "ocr" | "forwarded_email";
    initialStatus?: "draft" | "ready";
  },
): Promise<Expense> {
  const now = new Date();
  const created = await transaction
    .insertInto("app.expenses")
    .values({
      id: randomUUID(),
      tenant_id: input.tenantId,
      created_by_user_id: input.actorUserId,
      personal_profile_id: input.scope.kind === "personal" ? input.scope.profileId : null,
      business_id: input.scope.kind === "business" ? input.scope.businessId : null,
      project_id: input.request.projectId ?? null,
      spending_category_id: input.request.spendingCategoryId ?? null,
      merchant: input.request.merchant,
      description: input.request.description ?? null,
      amount: input.request.amount,
      currency: input.request.currency,
      incurred_on: input.request.incurredOn,
      source: input.source ?? "manual",
      status: input.initialStatus ?? "draft",
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
    action: "expense.created",
    outcome: "success",
    resourceType: "expense",
    resourceId: created.id,
    requestId: input.requestId,
  });
  return toExpense(created);
}

async function queryExpenses(
  database: Kysely<AppDatabase>,
  input: {
    readonly actorUserId: string;
    readonly tenantId: string;
    readonly scope: Scope;
    readonly query: LedgerQuery;
  },
): Promise<ExpenseList> {
  if (input.scope.kind === "personal" && input.query.taxReviewStatus !== undefined) {
    throw DomainError.validation();
  }
  const cursorScope =
    input.scope.kind === "personal"
      ? { tenantId: input.tenantId, profileId: input.scope.profileId }
      : { tenantId: input.tenantId, businessId: input.scope.businessId };
  const filterHash = ledgerFilterHash(input.query as unknown as Record<string, unknown>);
  const cursor = input.query.cursor
    ? (() => {
        try {
          const decoded = decodeLedgerCursor(input.query.cursor);
          if (
            JSON.stringify(decoded.scope) !== JSON.stringify(cursorScope) ||
            decoded.filterHash !== filterHash ||
            decoded.sort !== input.query.sort ||
            decoded.direction !== input.query.direction
          ) {
            throw new Error("Ledger cursor does not match query");
          }
          return decoded;
        } catch {
          throw DomainError.validation();
        }
      })()
    : null;
  let query = database
    .selectFrom("app.expenses as expense")
    .leftJoin("app.expense_tax_treatments as treatment", "treatment.expense_id", "expense.id")
    .selectAll("expense")
    .where("expense.tenant_id", "=", input.tenantId)
    .where("expense.status", "!=", "archived");
  if (input.scope.kind === "personal") {
    query = query.where("expense.personal_profile_id", "=", input.scope.profileId);
  } else {
    query = query.where("expense.business_id", "=", input.scope.businessId);
  }
  if (input.query.incurredFrom !== undefined) {
    query = query.where(
      "expense.incurred_on",
      ">=",
      new Date(`${input.query.incurredFrom}T00:00:00.000Z`),
    );
  }
  if (input.query.incurredTo !== undefined) {
    query = query.where(
      "expense.incurred_on",
      "<=",
      new Date(`${input.query.incurredTo}T00:00:00.000Z`),
    );
  }
  if (input.query.amountMin !== undefined) {
    query = query.where("expense.amount", ">=", input.query.amountMin);
  }
  if (input.query.amountMax !== undefined) {
    query = query.where("expense.amount", "<=", input.query.amountMax);
  }
  if (input.query.status !== undefined) {
    query = query.where("expense.status", "=", input.query.status);
  }
  if (input.query.spendingCategoryId !== undefined) {
    query = query.where("expense.spending_category_id", "=", input.query.spendingCategoryId);
  }
  if (input.query.projectId !== undefined) {
    query = query.where("expense.project_id", "=", input.query.projectId);
  }
  if (input.query.taxReviewStatus !== undefined) {
    query = query.where("treatment.review_status", "=", input.query.taxReviewStatus);
  }
  if (cursor) {
    const column =
      input.query.sort === "amount"
        ? "amount"
        : input.query.sort === "merchant"
          ? "merchant"
          : input.query.sort === "createdAt"
            ? "created_at"
            : "incurred_on";
    const reference = sql.ref(`expense.${column}`);
    const idReference = sql.ref("expense.id");
    const operator = input.query.direction === "asc" ? sql`>` : sql`<`;
    const lastValue =
      input.query.sort === "incurredOn"
        ? new Date(`${cursor.lastValue}T00:00:00.000Z`)
        : input.query.sort === "createdAt"
          ? new Date(cursor.lastValue)
          : cursor.lastValue;
    query = query.where(sql<boolean>`(
      ${reference} ${operator} ${lastValue}
      OR (${reference} = ${lastValue} AND ${idReference} ${operator} ${cursor.lastId})
    )`);
  }
  const direction = input.query.direction;
  if (input.query.sort === "amount") {
    query = query.orderBy("expense.amount", direction).orderBy("expense.id", direction);
  } else if (input.query.sort === "merchant") {
    query = query.orderBy("expense.merchant", direction).orderBy("expense.id", direction);
  } else if (input.query.sort === "createdAt") {
    query = query.orderBy("expense.created_at", direction).orderBy("expense.id", direction);
  } else {
    query = query.orderBy("expense.incurred_on", direction).orderBy("expense.id", direction);
  }
  const rows = await query.limit(input.query.limit + 1).execute();
  const pageRows = rows.slice(0, input.query.limit);
  const lastRow = pageRows.at(-1);
  const nextCursor = rows.length > input.query.limit && lastRow
    ? encodeLedgerCursor({
        scope: cursorScope,
        filterHash,
        sort: input.query.sort,
        direction: input.query.direction,
        lastValue:
          input.query.sort === "incurredOn"
            ? dateOnly(lastRow.incurred_on as Date | string)
            : input.query.sort === "createdAt"
              ? lastRow.created_at.toISOString()
              : input.query.sort === "amount"
                ? String(lastRow.amount)
                : lastRow.merchant,
        lastId: lastRow.id,
      })
    : null;
  return { items: pageRows.map(toExpense), nextCursor };
}

async function findExpense(
  database: Kysely<AppDatabase>,
  input: { tenantId: string; expenseId: string; scope: Scope },
): Promise<Selectable<ExpenseTable>> {
  let query = database
    .selectFrom("app.expenses")
    .selectAll()
    .where("id", "=", input.expenseId)
    .where("tenant_id", "=", input.tenantId)
    .where("status", "!=", "archived");
  query =
    input.scope.kind === "personal"
      ? query.where("personal_profile_id", "=", input.scope.profileId)
      : query.where("business_id", "=", input.scope.businessId);
  const row = await query.executeTakeFirst();
  if (!row) throw DomainError.notFound();
  return row;
}

async function updateExpense(
  database: Kysely<AppDatabase>,
  input: ExpenseUpdateCommand & { readonly scope: Scope },
): Promise<Expense> {
  return database.transaction().execute(async (transaction) => {
    const current = await findExpense(transaction, {
      tenantId: input.tenantId,
      expenseId: input.expenseId,
      scope: input.scope,
    });
    if (input.scope.kind === "personal" && input.request.projectId !== undefined) {
      if (input.request.projectId !== null) throw DomainError.validation();
    }
    const updated = await transaction
      .updateTable("app.expenses")
      .set({
        ...(input.request.merchant === undefined ? {} : { merchant: input.request.merchant }),
        ...(input.request.description === undefined
          ? {}
          : { description: input.request.description }),
        ...(input.request.amount === undefined ? {} : { amount: input.request.amount }),
        ...(input.request.currency === undefined ? {} : { currency: input.request.currency }),
        ...(input.request.incurredOn === undefined
          ? {}
          : { incurred_on: input.request.incurredOn }),
        ...(input.request.projectId === undefined ? {} : { project_id: input.request.projectId }),
        ...(input.request.spendingCategoryId === undefined
          ? {}
          : { spending_category_id: input.request.spendingCategoryId }),
        ...(input.request.status === undefined ? {} : { status: input.request.status }),
        version: sql<number>`version + 1`,
        updated_at: new Date(),
      })
      .where("id", "=", current.id)
      .where("tenant_id", "=", input.tenantId)
      .where("version", "=", input.request.expectedVersion)
      .returningAll()
      .executeTakeFirst();
    if (!updated) throw DomainError.conflict();
    await recordAuditEvent(transaction, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      action: "expense.updated",
      outcome: "success",
      resourceType: "expense",
      resourceId: input.expenseId,
      requestId: input.requestId,
    });
    return toExpense(updated);
  });
}

async function archiveExpense(
  database: Kysely<AppDatabase>,
  input: ExpenseArchiveCommand & { readonly scope: Scope },
): Promise<void> {
  await database.transaction().execute(async (transaction) => {
    await findExpense(transaction, {
      tenantId: input.tenantId,
      expenseId: input.expenseId,
      scope: input.scope,
    });
    const updated = await transaction
      .updateTable("app.expenses")
      .set({
        status: "archived",
        archived_at: new Date(),
        updated_at: new Date(),
        version: sql<number>`version + 1`,
      })
      .where("id", "=", input.expenseId)
      .where("tenant_id", "=", input.tenantId)
      .where("version", "=", input.request.expectedVersion)
      .returning("id")
      .executeTakeFirst();
    if (!updated) throw DomainError.conflict();
    await recordAuditEvent(transaction, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      action: "expense.archived",
      outcome: "success",
      resourceType: "expense",
      resourceId: input.expenseId,
      requestId: input.requestId,
    });
  });
}

export function createExpenseDomain(database: Kysely<AppDatabase>): ExpenseDomain {
  return {
    async createPersonal(input) {
      assertRequestScope(input.request, { kind: "personal", profileId: input.profileId });
      const role = await personalRole(database, input);
      if (!canWrite(role)) throw DomainError.forbidden();
      return database.transaction().execute((transaction) =>
        insertExpenseInTransaction(transaction, {
          ...input,
          scope: { kind: "personal", profileId: input.profileId },
        }),
      );
    },
    async createBusiness(input) {
      assertRequestScope(input.request, { kind: "business", businessId: input.businessId });
      const role = await businessRole(database, input);
      if (!canWrite(role)) throw DomainError.forbidden();
      return database.transaction().execute((transaction) =>
        insertExpenseInTransaction(transaction, {
          ...input,
          scope: { kind: "business", businessId: input.businessId },
        }),
      );
    },
    async listPersonal(input) {
      await personalRole(database, input);
      return queryExpenses(database, {
        ...input,
        scope: { kind: "personal", profileId: input.profileId },
      });
    },
    async listBusiness(input) {
      await businessRole(database, input);
      return queryExpenses(database, {
        ...input,
        scope: { kind: "business", businessId: input.businessId },
      });
    },
    async getPersonal(input) {
      await personalRole(database, input);
      return toExpense(
        await findExpense(database, {
          tenantId: input.tenantId,
          expenseId: input.expenseId,
          scope: { kind: "personal", profileId: input.profileId },
        }),
      );
    },
    async getBusiness(input) {
      await businessRole(database, input);
      return toExpense(
        await findExpense(database, {
          tenantId: input.tenantId,
          expenseId: input.expenseId,
          scope: { kind: "business", businessId: input.businessId },
        }),
      );
    },
    async updatePersonal(input) {
      const role = await personalRole(database, input);
      if (!canWrite(role)) throw DomainError.forbidden();
      return updateExpense(database, {
        ...input,
        scope: { kind: "personal", profileId: input.profileId },
      });
    },
    async updateBusiness(input) {
      const role = await businessRole(database, input);
      if (!canWrite(role)) throw DomainError.forbidden();
      return updateExpense(database, {
        ...input,
        scope: { kind: "business", businessId: input.businessId },
      });
    },
    async archivePersonal(input) {
      const role = await personalRole(database, input);
      if (!canWrite(role)) throw DomainError.forbidden();
      return archiveExpense(database, {
        ...input,
        scope: { kind: "personal", profileId: input.profileId },
      });
    },
    async archiveBusiness(input) {
      const role = await businessRole(database, input);
      if (!canWrite(role)) throw DomainError.forbidden();
      return archiveExpense(database, {
        ...input,
        scope: { kind: "business", businessId: input.businessId },
      });
    },
  };
}
