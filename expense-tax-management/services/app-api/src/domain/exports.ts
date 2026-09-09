import { randomUUID } from "node:crypto";

import type {
  BusinessTaxReport,
  ExportBundle,
  MoneyTotal,
  ProjectCostReport,
} from "@expense-tax/contracts";
import { sql, type Kysely, type Selectable, type Transaction } from "kysely";

import type { AppDatabase, JsonValue } from "../database/types.js";
import { DomainError } from "../errors.js";
import type { StorageAdapter } from "../storage/types.js";
import { recordAuditEvent } from "./audit.js";
import {
  CanonicalExportAdapter,
  sha256Hex,
  type ExportAdapter,
  type ExportExpenseRow,
} from "./export-format.js";
import { FILE_READ_URL_TTL_MS } from "./files.js";
import {
  executeIdempotentMutation,
  hashNormalizedRequest,
  type MutationResult,
} from "./idempotency.js";

type Role = "owner" | "editor" | "viewer";

interface BusinessScope {
  readonly actorUserId: string;
  readonly tenantId: string;
  readonly businessId: string;
}

async function businessRole(
  database: Kysely<AppDatabase>,
  input: BusinessScope,
): Promise<Role> {
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

function canWrite(role: Role): boolean {
  return role === "owner" || role === "editor";
}

const MONEY_FORMAT = "FM999999999999999990.00";

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const separator = decoded.indexOf("|");
  if (separator < 0) throw DomainError.validation();
  const createdAt = new Date(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);
  if (Number.isNaN(createdAt.getTime()) || !id) throw DomainError.validation();
  return { createdAt, id };
}

export interface TaxReportCommand extends BusinessScope {
  readonly taxYear: number;
}

export interface ProjectCostCommand extends BusinessScope {
  readonly projectId: string;
}

export interface CreateExportCommand extends BusinessScope {
  readonly taxYear: number;
  readonly includeUnresolved?: boolean | undefined;
  readonly idempotencyKey: string;
  readonly requestId: string;
  readonly now?: Date;
}

export interface ListExportsCommand extends BusinessScope {
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
}

export interface GetExportCommand extends BusinessScope {
  readonly exportId: string;
  readonly requestId: string;
}

export interface ExportsDomain {
  getTaxReport(input: TaxReportCommand): Promise<BusinessTaxReport>;
  getProjectCostReport(input: ProjectCostCommand): Promise<ProjectCostReport>;
  createExportBundle(
    input: CreateExportCommand,
  ): Promise<MutationResult<ExportBundle, 201>>;
  listExportBundles(
    input: ListExportsCommand,
  ): Promise<{ readonly items: readonly ExportBundle[]; readonly nextCursor: string | null }>;
  getExportBundle(input: GetExportCommand): Promise<ExportBundle>;
}

interface TotalsScope {
  readonly tenantId: string;
  readonly businessId: string;
  readonly taxYear?: number;
  readonly projectId?: string;
  readonly resolvedOnly?: boolean;
}

export function createExportsDomain(
  database: Kysely<AppDatabase>,
  storage: StorageAdapter,
  options: { readonly appVersion: string; readonly adapter?: ExportAdapter },
): ExportsDomain {
  const adapter = options.adapter ?? CanonicalExportAdapter;

  async function totalsByCurrency(
    executor: Kysely<AppDatabase> | Transaction<AppDatabase>,
    input: TotalsScope,
  ): Promise<MoneyTotal[]> {
    let query = executor
      .selectFrom("app.expenses as e")
      .leftJoin("app.expense_tax_treatments as t", "t.expense_id", "e.id")
      .select([
        "e.currency as currency",
        sql<string>`count(*)`.as("expense_count"),
        sql<string>`to_char(coalesce(sum(e.amount), 0), ${MONEY_FORMAT})`.as("gross_total"),
        sql<string>`to_char(coalesce(sum(round(e.amount * t.deductible_percent / 100, 2)), 0), ${MONEY_FORMAT})`.as(
          "deductible_total",
        ),
      ])
      .where("e.tenant_id", "=", input.tenantId)
      .where("e.business_id", "=", input.businessId)
      .where("e.status", "!=", "archived");
    if (input.taxYear !== undefined) query = query.where("e.tax_year", "=", input.taxYear);
    if (input.projectId !== undefined) query = query.where("e.project_id", "=", input.projectId);
    if (input.resolvedOnly === true) {
      query = query.where((eb) =>
        eb.or([
          eb("t.review_status", "=", "reviewed"),
          eb("t.review_status", "=", "excluded"),
        ]),
      );
    }
    const rows = await query
      .groupBy("e.currency")
      .orderBy("e.currency")
      .execute();
    return rows.map((row) => ({
      currency: row.currency,
      grossTotal: row.gross_total,
      deductibleTotal: row.deductible_total,
      expenseCount: Number(row.expense_count),
    }));
  }

  function splitBaseTotals(
    totals: MoneyTotal[],
    baseCurrency: string,
  ): { totals: MoneyTotal; foreign: { excludedCount: number; currencies: string[] } } {
    const base = totals.find((total) => total.currency === baseCurrency);
    const foreign = totals.filter((total) => total.currency !== baseCurrency);
    return {
      totals: base ?? {
        currency: baseCurrency,
        grossTotal: "0.00",
        deductibleTotal: "0.00",
        expenseCount: 0,
      },
      foreign: {
        excludedCount: foreign.reduce((sum, total) => sum + total.expenseCount, 0),
        currencies: foreign.map((total) => total.currency),
      },
    };
  }

  async function reviewSummary(
    executor: Kysely<AppDatabase> | Transaction<AppDatabase>,
    input: { tenantId: string; businessId: string; taxYear: number },
  ) {
    const row = await executor
      .selectFrom("app.expenses as e")
      .leftJoin("app.expense_tax_treatments as t", "t.expense_id", "e.id")
      .select([
        sql<string>`count(*)`.as("total"),
        sql<string>`count(*) filter (where t.expense_id is not null)`.as("treated"),
        sql<string>`count(*) filter (where t.review_status = 'reviewed')`.as("reviewed"),
        sql<string>`count(*) filter (where t.review_status = 'unreviewed')`.as("unreviewed"),
        sql<string>`count(*) filter (where t.review_status = 'excluded')`.as("excluded"),
        sql<string>`count(*) filter (where t.expense_id is null)`.as("missing"),
      ])
      .where("e.tenant_id", "=", input.tenantId)
      .where("e.business_id", "=", input.businessId)
      .where("e.tax_year", "=", input.taxYear)
      .where("e.status", "!=", "archived")
      .executeTakeFirstOrThrow();
    return {
      total: Number(row.total),
      treated: Number(row.treated),
      reviewed: Number(row.reviewed),
      unreviewed: Number(row.unreviewed),
      excluded: Number(row.excluded),
      missingTreatment: Number(row.missing),
    };
  }

  async function assembleBundle(
    row: Selectable<AppDatabase["app.export_bundles"]>,
  ): Promise<ExportBundle> {
    const manifest = row.manifest as unknown as ExportBundle["manifest"];
    const refs = [
      { path: "expenses.csv", storageKey: row.csv_storage_key },
      { path: "tax-category-mapping.csv", storageKey: row.mapping_storage_key },
      { path: "manifest.json", storageKey: row.manifest_storage_key },
    ];
    const files = [];
    for (const ref of refs) {
      const meta = manifest.files.find((file) => file.path === ref.path);
      const issued = await storage.issueReadUrl({
        fileId: ref.storageKey,
        storageKey: ref.storageKey,
        expiresAt: new Date(Date.now() + FILE_READ_URL_TTL_MS),
      });
      files.push({
        path: ref.path,
        sha256Hex: meta?.sha256Hex ?? "",
        bytes: meta?.bytes ?? 0,
        downloadUrl: issued.url,
        urlExpiresAt: new Date(Date.now() + FILE_READ_URL_TTL_MS).toISOString(),
      });
    }
    return {
      id: row.id,
      tenantId: row.tenant_id,
      businessId: row.business_id,
      taxYear: row.tax_year,
      taxonomyVersionId: row.taxonomy_version_id,
      profileId: row.profile_id,
      profileStatus: row.profile_status,
      filters: (row.filters as { includeUnresolved: boolean }) ?? {
        includeUnresolved: false,
      },
      expenseCount: row.expense_count,
      manifest,
      files,
      createdByUserId: row.created_by_user_id,
      createdAt: row.created_at.toISOString(),
    };
  }

  return {
    async getTaxReport(input) {
      await businessRole(database, input);
      const business = await database
        .selectFrom("app.businesses")
        .select("base_currency")
        .where("id", "=", input.businessId)
        .where("tenant_id", "=", input.tenantId)
        .executeTakeFirstOrThrow();
      const profile = await database
        .selectFrom("app.business_tax_profiles")
        .select(["id", "status", "taxonomy_version_id"])
        .where("tenant_id", "=", input.tenantId)
        .where("business_id", "=", input.businessId)
        .where("tax_year", "=", input.taxYear)
        .executeTakeFirst();

      const currencyTotals = await totalsByCurrency(database, {
        tenantId: input.tenantId,
        businessId: input.businessId,
        taxYear: input.taxYear,
      });
      const { totals, foreign } = splitBaseTotals(currencyTotals, business.base_currency);

      const byCategory = await database
        .selectFrom("app.expenses as e")
        .leftJoin("app.expense_tax_treatments as t", "t.expense_id", "e.id")
        .leftJoin("app.tax_category_definitions as c", "c.id", "t.tax_category_definition_id")
        .select([
          "c.code as category_code",
          sql<string>`coalesce(c.name, 'Uncategorized')`.as("category_name"),
          sql<string>`count(*)`.as("expense_count"),
          sql<string>`to_char(coalesce(sum(e.amount), 0), ${MONEY_FORMAT})`.as("gross_total"),
          sql<string>`to_char(coalesce(sum(round(e.amount * t.deductible_percent / 100, 2)), 0), ${MONEY_FORMAT})`.as(
            "deductible_total",
          ),
        ])
        .where("e.tenant_id", "=", input.tenantId)
        .where("e.business_id", "=", input.businessId)
        .where("e.tax_year", "=", input.taxYear)
        .where("e.status", "!=", "archived")
        .where("e.currency", "=", business.base_currency)
        .groupBy(["c.code", "c.name"])
        .orderBy("gross_total", "desc")
        .execute();

      const byMonth = await database
        .selectFrom("app.expenses as e")
        .leftJoin("app.expense_tax_treatments as t", "t.expense_id", "e.id")
        .select([
          sql<string>`to_char(e.incurred_on, 'YYYY-MM')`.as("month"),
          sql<string>`count(*)`.as("expense_count"),
          sql<string>`to_char(coalesce(sum(e.amount), 0), ${MONEY_FORMAT})`.as("gross_total"),
          sql<string>`to_char(coalesce(sum(round(e.amount * t.deductible_percent / 100, 2)), 0), ${MONEY_FORMAT})`.as(
            "deductible_total",
          ),
        ])
        .where("e.tenant_id", "=", input.tenantId)
        .where("e.business_id", "=", input.businessId)
        .where("e.tax_year", "=", input.taxYear)
        .where("e.status", "!=", "archived")
        .where("e.currency", "=", business.base_currency)
        .groupBy(sql`to_char(e.incurred_on, 'YYYY-MM')`)
        .orderBy(sql`to_char(e.incurred_on, 'YYYY-MM')`)
        .execute();

      const review = await reviewSummary(database, {
        tenantId: input.tenantId,
        businessId: input.businessId,
        taxYear: input.taxYear,
      });

      return {
        businessId: input.businessId,
        taxYear: input.taxYear,
        baseCurrency: business.base_currency,
        profile: profile
          ? {
              id: profile.id,
              status: profile.status,
              taxonomyVersionId: profile.taxonomy_version_id,
            }
          : null,
        totals,
        totalsByCurrency: currencyTotals,
        foreignCurrencySummary: foreign,
        byCategory: byCategory.map((row) => ({
          categoryCode: row.category_code,
          categoryName: row.category_name,
          expenseCount: Number(row.expense_count),
          grossTotal: row.gross_total,
          deductibleTotal: row.deductible_total,
        })),
        byMonth: byMonth.map((row) => ({
          month: row.month,
          expenseCount: Number(row.expense_count),
          grossTotal: row.gross_total,
          deductibleTotal: row.deductible_total,
        })),
        review,
      };
    },

    async getProjectCostReport(input) {
      await businessRole(database, input);
      const project = await database
        .selectFrom("app.projects")
        .select(["id", "name"])
        .where("id", "=", input.projectId)
        .where("tenant_id", "=", input.tenantId)
        .where("business_id", "=", input.businessId)
        .executeTakeFirst();
      if (!project) throw DomainError.notFound();
      const business = await database
        .selectFrom("app.businesses")
        .select("base_currency")
        .where("id", "=", input.businessId)
        .where("tenant_id", "=", input.tenantId)
        .executeTakeFirstOrThrow();

      const currencyTotals = await totalsByCurrency(database, {
        tenantId: input.tenantId,
        businessId: input.businessId,
        projectId: input.projectId,
      });
      const { totals, foreign } = splitBaseTotals(currencyTotals, business.base_currency);

      const byMonth = await database
        .selectFrom("app.expenses as e")
        .select([
          sql<string>`to_char(e.incurred_on, 'YYYY-MM')`.as("month"),
          sql<string>`count(*)`.as("expense_count"),
          sql<string>`to_char(coalesce(sum(e.amount), 0), ${MONEY_FORMAT})`.as("gross_total"),
          sql<string>`to_char(0.00, ${MONEY_FORMAT})`.as("deductible_total"),
        ])
        .where("e.tenant_id", "=", input.tenantId)
        .where("e.business_id", "=", input.businessId)
        .where("e.project_id", "=", input.projectId)
        .where("e.status", "!=", "archived")
        .where("e.currency", "=", business.base_currency)
        .groupBy(sql`to_char(e.incurred_on, 'YYYY-MM')`)
        .orderBy(sql`to_char(e.incurred_on, 'YYYY-MM')`)
        .execute();

      const byCategory = await database
        .selectFrom("app.expenses as e")
        .leftJoin("app.spending_categories as s", "s.id", "e.spending_category_id")
        .select([
          "s.id as category_id",
          sql<string>`coalesce(s.name, 'Uncategorized')`.as("category_name"),
          sql<string>`count(*)`.as("expense_count"),
          sql<string>`to_char(coalesce(sum(e.amount), 0), ${MONEY_FORMAT})`.as("gross_total"),
        ])
        .where("e.tenant_id", "=", input.tenantId)
        .where("e.business_id", "=", input.businessId)
        .where("e.project_id", "=", input.projectId)
        .where("e.status", "!=", "archived")
        .where("e.currency", "=", business.base_currency)
        .groupBy(["s.id", "s.name"])
        .orderBy("gross_total", "desc")
        .execute();

      return {
        projectId: project.id,
        businessId: input.businessId,
        projectName: project.name,
        baseCurrency: business.base_currency,
        totals,
        totalsByCurrency: currencyTotals,
        foreignCurrencySummary: foreign,
        byMonth: byMonth.map((row) => ({
          month: row.month,
          expenseCount: Number(row.expense_count),
          grossTotal: row.gross_total,
          deductibleTotal: row.deductible_total,
        })),
        bySpendingCategory: byCategory.map((row) => ({
          categoryId: row.category_id,
          categoryName: row.category_name,
          expenseCount: Number(row.expense_count),
          grossTotal: row.gross_total,
        })),
      };
    },

    async createExportBundle(input) {
      const role = await businessRole(database, input);
      if (!canWrite(role)) throw DomainError.forbidden();
      const includeUnresolved = input.includeUnresolved ?? false;

      return executeIdempotentMutation(database, {
        actorKey: `user:${input.actorUserId}`,
        operationKey: "export-bundle.create",
        idempotencyKey: input.idempotencyKey,
        requestHash: hashNormalizedRequest({
          tenantId: input.tenantId,
          businessId: input.businessId,
          taxYear: input.taxYear,
          includeUnresolved,
        }),
        statusCode: 201,
        parseBody: (value) => value as ExportBundle,
        execute: async (transaction) => {
          const business = await transaction
            .selectFrom("app.businesses")
            .select("base_currency")
            .where("id", "=", input.businessId)
            .where("tenant_id", "=", input.tenantId)
            .executeTakeFirstOrThrow();
          const profile = await transaction
            .selectFrom("app.business_tax_profiles")
            .selectAll()
            .where("tenant_id", "=", input.tenantId)
            .where("business_id", "=", input.businessId)
            .where("tax_year", "=", input.taxYear)
            .executeTakeFirst();
          if (!profile) throw DomainError.notFound();
          const taxonomy = await transaction
            .selectFrom("app.taxonomy_versions")
            .select(["id", "code", "name"])
            .where("id", "=", profile.taxonomy_version_id)
            .executeTakeFirstOrThrow();

          let detail = transaction
            .selectFrom("app.expenses as e")
            .leftJoin("app.expense_tax_treatments as t", "t.expense_id", "e.id")
            .leftJoin(
              "app.tax_category_definitions as c",
              "c.id",
              "t.tax_category_definition_id",
            )
            .leftJoin("app.spending_categories as s", "s.id", "e.spending_category_id")
            .leftJoin("app.projects as p", "p.id", "e.project_id")
            .select([
              "e.id as expense_id",
              sql<string>`to_char(e.incurred_on, 'YYYY-MM-DD')`.as("incurred_on"),
              "e.merchant as merchant",
              "e.description as description",
              "e.amount as amount",
              "e.currency as currency",
              "e.source as source",
              "e.status as status",
              "s.name as spending_category",
              "p.name as project",
              "c.code as tax_category_code",
              "c.name as tax_category_name",
              "t.deductible_percent as deductible_percent",
              sql<string>`to_char(coalesce(round(e.amount * t.deductible_percent / 100, 2), 0), ${MONEY_FORMAT})`.as(
                "deductible_amount",
              ),
              "t.review_status as review_status",
              sql<string | null>`(select f.id from app.expense_files as f where f.expense_id = e.id order by f.created_at asc, f.id asc limit 1)`.as(
                "receipt_file_id",
              ),
            ])
            .where("e.tenant_id", "=", input.tenantId)
            .where("e.business_id", "=", input.businessId)
            .where("e.tax_year", "=", input.taxYear)
            .where("e.status", "!=", "archived");
          if (!includeUnresolved) {
            detail = detail.where((eb) =>
              eb.or([
                eb("t.review_status", "=", "reviewed"),
                eb("t.review_status", "=", "excluded"),
              ]),
            );
          }
          const rows = await detail
            .orderBy("e.incurred_on", "asc")
            .orderBy("e.id", "asc")
            .execute();

          const categories = await transaction
            .selectFrom("app.tax_category_definitions")
            .select(["code", "name", "official_form", "official_line"])
            .where("taxonomy_version_id", "=", profile.taxonomy_version_id)
            .where("status", "=", "active")
            .orderBy("sort_order", "asc")
            .execute();

          const baseCurrency = business.base_currency;
          let included = 0;
          let excludedUnresolved = 0;
          let foreignExcluded = 0;
          const foreignCurrencies = new Set<string>();
          const csvRows: ExportExpenseRow[] = rows.map((row) => {
            const inBase = row.currency === baseCurrency;
            const resolved =
              row.review_status === "reviewed" || row.review_status === "excluded";
            if (!inBase) {
              foreignExcluded += 1;
              foreignCurrencies.add(row.currency);
            } else if (!resolved) {
              excludedUnresolved += 1;
            } else {
              included += 1;
            }
            return {
              expenseId: row.expense_id,
              incurredOn: row.incurred_on,
              merchant: row.merchant,
              description: row.description,
              amount: String(row.amount),
              currency: row.currency,
              includedInTotals: inBase && resolved,
              spendingCategory: row.spending_category,
              project: row.project,
              taxCategoryCode: row.tax_category_code,
              taxCategoryName: row.tax_category_name,
              deductiblePercent:
                row.deductible_percent === null ? null : String(row.deductible_percent),
              deductibleAmount: row.deductible_amount,
              reviewStatus: row.review_status,
              receiptFileId: row.receipt_file_id,
              source: row.source,
              status: row.status,
            };
          });

          // Exact-decimal sums, never JS floats. Default scope matches the
          // resolved-only SQL helper; with includeUnresolved the scope is
          // "base currency, any review state", which the helper cannot
          // express -- so sum the CSV subset instead. All values are 2dp
          // strings, so integer-cent arithmetic is exact.
          const toCents = (money: string): number => {
            const [whole = "0", frac = "00"] = money.split(".");
            return Number(whole) * 100 + Number((frac + "00").slice(0, 2));
          };
          const fromCents = (cents: number): string =>
            `${Math.trunc(cents / 100)}.${String(Math.abs(cents % 100)).padStart(2, "0")}`;
          const subsetTotals = includeUnresolved
            ? {
                grossTotal: fromCents(
                  csvRows
                    .filter((row) => row.includedInTotals)
                    .reduce((sum, row) => sum + toCents(row.amount), 0),
                ),
                deductibleTotal: fromCents(
                  csvRows
                    .filter((row) => row.includedInTotals)
                    .reduce((sum, row) => sum + toCents(row.deductibleAmount), 0),
                ),
              }
            : await (async () => {
                const exportTotals = await totalsByCurrency(transaction, {
                  tenantId: input.tenantId,
                  businessId: input.businessId,
                  taxYear: input.taxYear,
                  resolvedOnly: true,
                });
                const base = exportTotals.find(
                  (total) => total.currency === baseCurrency,
                );
                return {
                  grossTotal: base?.grossTotal ?? "0.00",
                  deductibleTotal: base?.deductibleTotal ?? "0.00",
                };
              })();

          const review = {
            total: rows.length,
            treated: rows.filter((row) => row.review_status !== null).length,
            reviewed: rows.filter((row) => row.review_status === "reviewed").length,
            unreviewed: rows.filter((row) => row.review_status === "unreviewed").length,
            excluded: rows.filter((row) => row.review_status === "excluded").length,
            missingTreatment: rows.filter((row) => row.review_status === null).length,
          };

          const now = input.now ?? new Date();
          const bundleId = randomUUID();
          const prefix = `tenants/${input.tenantId}/exports/${bundleId}`;
          const csvText = adapter.buildExpensesCsv(csvRows);
          const mappingText = adapter.buildMappingCsv(
            categories.map((category) => ({
              code: category.code,
              name: category.name,
              officialForm: category.official_form,
              officialLine: category.official_line,
            })),
          );
          const csvKey = `${prefix}/expenses.csv`;
          const mappingKey = `${prefix}/tax-category-mapping.csv`;
          const manifestKey = `${prefix}/manifest.json`;
          const fileRefs = [
            { path: "expenses.csv", sha256Hex: sha256Hex(csvText), bytes: Buffer.byteLength(csvText, "utf8") },
            { path: "tax-category-mapping.csv", sha256Hex: sha256Hex(mappingText), bytes: Buffer.byteLength(mappingText, "utf8") },
          ];
          const manifest = adapter.buildManifest({
            bundleId,
            businessId: input.businessId,
            taxYear: input.taxYear,
            taxonomy: {
              versionId: taxonomy.id,
              code: taxonomy.code,
              name: taxonomy.name,
            },
            profile: { id: profile.id, status: profile.status },
            baseCurrency,
            includeUnresolved,
            createdAt: now.toISOString(),
            appVersion: options.appVersion,
            counts: {
              expenses: rows.length,
              included,
              excludedUnresolved,
              foreignExcluded,
            },
            grossTotal: subsetTotals.grossTotal,
            deductibleTotal: subsetTotals.deductibleTotal,
            foreignSummary: {
              excludedCount: foreignExcluded,
              currencies: [...foreignCurrencies].sort(),
            },
            review,
            files: fileRefs,
          });
          // manifest.files covers the data files only: a self-entry
          // would be circular (hash of content containing the hash).
          // The manifest's own authoritative copy is the bundle row.
          const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;

          await storage.writeObject({
            storageKey: csvKey,
            data: Buffer.from(csvText, "utf8"),
            contentType: "text/csv",
          });
          await storage.writeObject({
            storageKey: mappingKey,
            data: Buffer.from(mappingText, "utf8"),
            contentType: "text/csv",
          });
          await storage.writeObject({
            storageKey: manifestKey,
            data: Buffer.from(manifestText, "utf8"),
            contentType: "application/json",
          });

          const created = await transaction
            .insertInto("app.export_bundles")
            .values({
              id: bundleId,
              tenant_id: input.tenantId,
              business_id: input.businessId,
              tax_year: input.taxYear,
              taxonomy_version_id: profile.taxonomy_version_id,
              profile_id: profile.id,
              profile_status: profile.status,
              filters: { includeUnresolved },
              manifest: manifest as unknown as JsonValue,
              csv_storage_key: csvKey,
              manifest_storage_key: manifestKey,
              mapping_storage_key: mappingKey,
              expense_count: rows.length,
              created_by_user_id: input.actorUserId,
              created_at: now,
            })
            .returningAll()
            .executeTakeFirstOrThrow();

          await recordAuditEvent(transaction, {
            tenantId: input.tenantId,
            actorUserId: input.actorUserId,
            action: "export_bundle.created",
            outcome: "success",
            resourceType: "export_bundle",
            resourceId: bundleId,
            requestId: input.requestId,
          });

          return assembleBundle(created);
        },
      });
    },

    async listExportBundles(input) {
      await businessRole(database, input);
      const limit = input.limit ?? 25;
      const cursor = input.cursor ? decodeCursor(input.cursor) : null;
      let query = database
        .selectFrom("app.export_bundles")
        .selectAll()
        .where("tenant_id", "=", input.tenantId)
        .where("business_id", "=", input.businessId);
      if (cursor) {
        query = query.where((eb) =>
          eb.or([
            eb("created_at", "<", cursor.createdAt),
            eb.and([
              eb("created_at", "=", cursor.createdAt),
              eb("id", "<", cursor.id),
            ]),
          ]),
        );
      }
      const rows = await query
        .orderBy("created_at", "desc")
        .orderBy("id", "desc")
        .limit(limit + 1)
        .execute();
      const page = rows.slice(0, limit);
      const items: ExportBundle[] = [];
      for (const row of page) items.push(await assembleBundle(row));
      const last = page[page.length - 1];
      return {
        items,
        nextCursor:
          rows.length > limit && last
            ? encodeCursor(last.created_at, last.id)
            : null,
      };
    },

    async getExportBundle(input) {
      await businessRole(database, input);
      const row = await database
        .selectFrom("app.export_bundles")
        .selectAll()
        .where("id", "=", input.exportId)
        .where("tenant_id", "=", input.tenantId)
        .where("business_id", "=", input.businessId)
        .executeTakeFirst();
      if (!row) throw DomainError.notFound();
      await database.transaction().execute(async (transaction) => {
        await recordAuditEvent(transaction, {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          action: "export_bundle.downloaded",
          outcome: "success",
          resourceType: "export_bundle",
          resourceId: row.id,
          requestId: input.requestId,
        });
      });
      return assembleBundle(row);
    },
  };
}
