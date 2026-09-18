/**
 * Task 6 — App API enrichment domain.
 *
 * Implements:
 * - buildEnrichmentInput: bounded projection for the AI worker
 * - applyEnrichmentResult: server recomputation, rule tag application,
 *   pending suggestion creation, permanent operation key recording
 * - resolveSuggestion: Task 8 seam (not yet public)
 * - rerunEnrichment: Task 8 seam (not yet public)
 *
 * Security boundaries:
 * - No tenantId, profileId, businessId, selectors, raw receipt text,
 *   amount, tax treatment, review status, or deductible percentage in
 *   the worker input.
 * - Worker cannot redirect scope; all scope/tenant resolution from job row.
 * - All candidate eligibility enforced server-side; server recomputes
 *   deterministic rule tags and rejects mismatches.
 */

import { randomUUID, createHash } from "node:crypto";

import {
  EXPENSE_ENRICHMENT_RESULT_SCHEMA_VERSION,
  EXPENSE_ENRICHMENT_WORKFLOW_TYPE,
  ExpenseEnrichmentResultV1Schema,
  type ExpenseEnrichmentInputResponseV1,
  type ExpenseEnrichmentInputV1,
  type ProcessingJob,
} from "@expense-tax/contracts";
import { type Kysely, type Transaction, sql } from "kysely";

import type { AppDatabase, JsonValue } from "../database/types.js";
import { DomainError } from "../errors.js";
import { recordAuditEvent } from "./audit.js";
import { normalizeMerchant } from "./deduplication.js";
import {
  hashNormalizedRequest,
  toJsonValue,
  type MutationResult,
} from "./idempotency.js";
import { toProcessingJob } from "./processing-job-view.js";

// ------------------------------------------------------------------ //
// Constants
// ------------------------------------------------------------------ //

const ENRICHMENT_RULES_VERSION = 1;
const HISTORY_MONTHS = 24;
const HISTORY_MAX_EXPENSES = 50;

// ------------------------------------------------------------------ //
// Helpers
// ------------------------------------------------------------------ //

/** Canonical SHA-256 (lowercase hex, 64 chars). */
function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Canonical JSON (sorted keys, no whitespace). */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Evidence hash for a suggestion. Canonical JSON → SHA-256 hex. */
function evidenceHash(payload: Record<string, unknown>): string {
  return sha256Hex(canonicalJson(payload));
}

/**
 * Normalize merchant for tag key format.
 * Removes spaces so "corner deli" → "corner-deli" is not needed;
 * the exact format mirrors the Python worker which uses str(normalizedMerchant).
 * Server uses normalizeMerchant() from deduplication.ts then replaces spaces with hyphens.
 */
function merchantTagKey(normalizedMerchant: string): string {
  return `merchant:${normalizedMerchant.replace(/\s+/g, "-")}`;
}

/**
 * Incurred-on day-of-week for weekend rule.
 * Returns true for Saturday (6) or Sunday (7) in ISO weekday.
 */
function isWeekend(dateStr: string): boolean {
  // dateStr is YYYY-MM-DD; parse as local date at noon to avoid TZ issues
  const [year, month, day] = dateStr.split("-").map(Number) as [number, number, number];
  const d = new Date(year, month - 1, day, 12, 0, 0);
  const dow = d.getDay(); // 0=Sun, 6=Sat
  return dow === 0 || dow === 6;
}

/**
 * Compute server-side deterministic rule tag keys for an expense.
 * Must exactly mirror the Python evaluator in services/ai-worker/src/ai_worker/enrichment.py.
 *
 * Rules:
 * - merchant:<normalizedMerchant> if eligible (key in eligibleTagKeys)
 * - timing:weekend if eligible and incurredOn is Sat or Sun
 * - category:<spendingCategoryId> if eligible and spendingCategoryId not null
 */
function computeRuleTagKeys(input: {
  readonly normalizedMerchant: string | null;
  readonly incurredOn: string;
  readonly spendingCategoryId: string | null;
  readonly eligibleTagKeys: readonly string[];
}): string[] {
  const result: string[] = [];

  if (input.normalizedMerchant) {
    const key = merchantTagKey(input.normalizedMerchant);
    if (input.eligibleTagKeys.includes(key)) {
      result.push(key);
    }
  }

  if (isWeekend(input.incurredOn)) {
    const weekendKey = "timing:weekend";
    if (input.eligibleTagKeys.includes(weekendKey)) {
      result.push(weekendKey);
    }
  }

  if (input.spendingCategoryId) {
    const catKey = `category:${input.spendingCategoryId}`;
    if (input.eligibleTagKeys.includes(catKey)) {
      result.push(catKey);
    }
  }

  return result;
}

// ------------------------------------------------------------------ //
// buildEnrichmentInput — bounded projection
// ------------------------------------------------------------------ //

/**
 * Build the full worker input for the given enrichment job.
 *
 * Enforces:
 * - Job must exist, be EXPENSE_ENRICHMENT_WORKFLOW_TYPE, and be RUNNING.
 * - Expense must exist, be ready, and match expected version.
 * - Eligible tag keys: active tags with exact rule keys present for the scope.
 *   - merchant:<normalizedMerchant> if merchant known and tag active
 *   - timing:weekend always (if active tag exists)
 *   - category:<spendingCategoryId> if category set and tag active
 *   - Never archived tags, never ineligible rule keys.
 * - Eligible spending category IDs: active (not archived) categories for same scope.
 * - Tax snapshot: active business tax profile + active taxonomy + active tax categories.
 * - History: same normalized merchant, same tenant/scope, ready non-archived,
 *   prior 24 months, max 50. Training on active manual/accepted-historical tags,
 *   latest manual/manual_baseline/accepted-historical category decisions, reviewed
 *   user-saved active Business tax treatments under current active profile/taxonomy/year.
 * - No amount, selector, percentage, treatment/review status in output.
 */
export async function buildEnrichmentInput(
  database: Kysely<AppDatabase>,
  jobId: string,
): Promise<ExpenseEnrichmentInputResponseV1> {
  return database.transaction().execute(async (transaction) => {
    // Load and validate job
    const job = await transaction
      .selectFrom("app.processing_jobs")
      .selectAll()
      .where("id", "=", jobId)
      .executeTakeFirst();

    if (!job || job.workflow_type !== EXPENSE_ENRICHMENT_WORKFLOW_TYPE) {
      throw DomainError.notFound();
    }
    if (job.allowed_result_schema_version !== EXPENSE_ENRICHMENT_RESULT_SCHEMA_VERSION) {
      throw DomainError.notFound();
    }
    if (job.status !== "RUNNING") throw DomainError.conflict();
    if (!job.target_aggregate_id || job.target_aggregate_type !== "expense") {
      throw DomainError.validation();
    }

    const expenseId = job.target_aggregate_id;
    const tenantId = job.tenant_id;

    // Load expense
    const expense = await transaction
      .selectFrom("app.expenses")
      .selectAll()
      .where("id", "=", expenseId)
      .where("tenant_id", "=", tenantId)
      .executeTakeFirst();

    if (!expense || expense.status === "archived") {
      return { outcome: "skipped" as const };
    }

    if (
      job.expected_aggregate_version !== null &&
      expense.version !== job.expected_aggregate_version
    ) {
      return { outcome: "stale" as const };
    }

    // Compute scope
    const isPersonal = expense.personal_profile_id !== null;
    const scopeProfileId = expense.personal_profile_id;
    const scopeBusinessId = expense.business_id;

    // Normalized merchant (null if blank)
    const rawMerchant = expense.merchant?.trim() ?? "";
    const normalizedMerchantRaw = rawMerchant ? normalizeMerchant(rawMerchant) : null;
    const normalizedMerchant = normalizedMerchantRaw || null;

    // Incurred-on as date string
    const incurredOnRaw = expense.incurred_on;
    const incurredOn =
      incurredOnRaw instanceof Date
        ? `${incurredOnRaw.getFullYear()}-${String(incurredOnRaw.getMonth() + 1).padStart(2, "0")}-${String(incurredOnRaw.getDate()).padStart(2, "0")}`
        : String(incurredOnRaw);

    // ---- Eligible tag keys ----
    // Active rule tags present in tenant, keyed by the three rule patterns.
    // A tag key is eligible only if an active (non-archived) tag with that key exists.

    const candidateKeys: string[] = [];
    if (normalizedMerchant) {
      candidateKeys.push(merchantTagKey(normalizedMerchant));
    }
    candidateKeys.push("timing:weekend");
    if (expense.spending_category_id) {
      candidateKeys.push(`category:${expense.spending_category_id}`);
    }

    // A candidate key is eligible if:
    // - No tag with that key exists (absent → eligible for creation by the application layer), OR
    // - A tag with that key exists AND is active (not archived).
    // Archived same key is permanently ineligible and never reactivates.
    const archivedTags =
      candidateKeys.length > 0
        ? await transaction
            .selectFrom("app.tags")
            .select(["key", "status"])
            .where("tenant_id", "=", tenantId)
            .where("key", "in", candidateKeys)
            .where("status", "=", "archived")
            .execute()
        : [];

    const archivedKeySet = new Set(archivedTags.map((t) => t.key));
    // Sort for deterministic order; exclude only archived keys
    const eligibleTagKeys = candidateKeys.filter((k) => !archivedKeySet.has(k)).sort();

    // ---- Eligible spending category IDs ----
    // Active (not archived) spending categories for this tenant/scope.
    let eligibleCatQuery = transaction
      .selectFrom("app.spending_categories")
      .select("id")
      .where("tenant_id", "=", tenantId)
      .where("status", "=", "active");

    const eligibleCategories = await eligibleCatQuery.execute();
    const eligibleSpendingCategoryIds = eligibleCategories
      .map((r) => r.id)
      .sort();

    // ---- Eligible tax snapshot (Business only) ----
    let eligibleTaxSnapshot: ExpenseEnrichmentInputV1["eligibleTaxSnapshot"] = null;

    if (!isPersonal && scopeBusinessId) {
      // Find active business tax profile for this business
      const taxProfile = await transaction
        .selectFrom("app.business_tax_profiles as btp")
        .select([
          "btp.id",
          "btp.version",
          "btp.taxonomy_version_id",
          "btp.tax_year",
        ])
        .where("btp.tenant_id", "=", tenantId)
        .where("btp.business_id", "=", scopeBusinessId)
        .where("btp.status", "=", "active")
        .orderBy("btp.tax_year", "desc")
        .limit(1)
        .executeTakeFirst();

      if (taxProfile) {
        // Active tax category definitions under this taxonomy version
        const taxCats = await transaction
          .selectFrom("app.tax_category_definitions")
          .select("id")
          .where("taxonomy_version_id", "=", taxProfile.taxonomy_version_id)
          .where("status", "=", "active")
          .execute();

        eligibleTaxSnapshot = {
          businessTaxProfileId: taxProfile.id,
          businessTaxProfileVersion: Number(taxProfile.version),
          taxonomyVersionId: taxProfile.taxonomy_version_id,
          taxYear: taxProfile.tax_year,
          activeTaxCategoryIds: taxCats.map((r) => r.id).sort(),
        };
      }
    }

    // ---- History — same normalized merchant, same scope, prior 24 months ----
    // exampleCount, candidateTagKeys (manual/accepted-historical active tags),
    // candidateSpendingCategoryIds (latest manual/manual_baseline/accepted-historical decisions),
    // candidateTaxCategoryIds (reviewed user-saved active Business tax treatments).

    const cutoffDate = new Date(expense.incurred_on instanceof Date ? expense.incurred_on : String(expense.incurred_on));
    cutoffDate.setMonth(cutoffDate.getMonth() - HISTORY_MONTHS);
    const cutoffDateStr = `${cutoffDate.getFullYear()}-${String(cutoffDate.getMonth() + 1).padStart(2, "0")}-${String(cutoffDate.getDate()).padStart(2, "0")}`;

    // Find up to HISTORY_MAX_EXPENSES prior expenses with same merchant/scope
    let historicalExpensesQuery = transaction
      .selectFrom("app.expenses as e")
      .select(["e.id", "e.spending_category_id"])
      .where("e.tenant_id", "=", tenantId)
      .where("e.status", "!=", "archived")
      .where("e.id", "!=", expenseId); // exclude current expense

    if (isPersonal && scopeProfileId) {
      historicalExpensesQuery = historicalExpensesQuery.where(
        "e.personal_profile_id",
        "=",
        scopeProfileId,
      );
    } else if (!isPersonal && scopeBusinessId) {
      historicalExpensesQuery = historicalExpensesQuery.where(
        "e.business_id",
        "=",
        scopeBusinessId,
      );
    }

    // Apply merchant filter only if merchant is known
    if (normalizedMerchant) {
      // Use the expense_dedup_fingerprints table to find same-merchant expenses
      const fingerprintExpenseIds = await transaction
        .selectFrom("app.expense_dedup_fingerprints as fp")
        .select("fp.expense_id")
        .where("fp.tenant_id", "=", tenantId)
        .where("fp.normalized_merchant", "=", normalizedMerchant)
        .where("fp.incurred_on", ">=", new Date(`${cutoffDateStr}T00:00:00.000Z`))
        .execute();

      const fpExpenseIdSet = new Set(fingerprintExpenseIds.map((r) => r.expense_id));
      if (fpExpenseIdSet.size === 0) {
        // No history
        const emptyHistory: ExpenseEnrichmentInputV1["history"] = {
          exampleCount: 0,
          candidateTagKeys: [],
          candidateSpendingCategoryIds: [],
          candidateTaxCategoryIds: [],
        };
        const evalInput: ExpenseEnrichmentInputV1 = {
          schemaVersion: 1,
          jobId,
          expenseId,
          expenseVersion: expense.version,
          normalizedMerchant,
          incurredOn,
          spendingCategoryId: expense.spending_category_id,
          rulesVersion: ENRICHMENT_RULES_VERSION,
          eligibleTagKeys,
          eligibleSpendingCategoryIds,
          eligibleTaxSnapshot,
          history: emptyHistory,
        };
        return { outcome: "evaluate" as const, input: evalInput };
      }

      const fpIds = [...fpExpenseIdSet];
      historicalExpensesQuery = historicalExpensesQuery.where(
        "e.id",
        "in",
        fpIds,
      );
    } else {
      // No merchant — no meaningful history
      const emptyHistory: ExpenseEnrichmentInputV1["history"] = {
        exampleCount: 0,
        candidateTagKeys: [],
        candidateSpendingCategoryIds: [],
        candidateTaxCategoryIds: [],
      };
      const evalInput: ExpenseEnrichmentInputV1 = {
        schemaVersion: 1,
        jobId,
        expenseId,
        expenseVersion: expense.version,
        normalizedMerchant: null,
        incurredOn,
        spendingCategoryId: expense.spending_category_id,
        rulesVersion: ENRICHMENT_RULES_VERSION,
        eligibleTagKeys,
        eligibleSpendingCategoryIds,
        eligibleTaxSnapshot,
        history: {
          exampleCount: 0,
          candidateTagKeys: [],
          candidateSpendingCategoryIds: [],
          candidateTaxCategoryIds: [],
        },
      };
      return { outcome: "evaluate" as const, input: evalInput };
    }

    const historicalExpenses = await historicalExpensesQuery
      .orderBy("e.incurred_on", "desc")
      .limit(HISTORY_MAX_EXPENSES)
      .execute();

    const exampleCount = historicalExpenses.length;
    const historicalIds = historicalExpenses.map((e) => e.id);

    // Candidate tag keys — active manual/accepted-historical tags on historical expenses
    let candidateTagKeyMap = new Map<string, number>(); // key → count
    if (exampleCount > 0) {
      const tagRows = await transaction
        .selectFrom("app.expense_tags as et")
        .innerJoin("app.tags as t", (join) =>
          join.onRef("t.id", "=", "et.tag_id").on("t.status", "=", "active"),
        )
        .select(["t.key", "et.expense_id"])
        .where("et.expense_id", "in", historicalIds)
        .where("et.status", "=", "active")
        .where("et.source", "in", ["manual", "historical"])
        .execute();

      const tagsByExpense = new Map<string, Set<string>>();
      for (const row of tagRows) {
        if (!tagsByExpense.has(row.expense_id)) {
          tagsByExpense.set(row.expense_id, new Set());
        }
        tagsByExpense.get(row.expense_id)!.add(row.key);
      }
      for (const [, keys] of tagsByExpense) {
        for (const key of keys) {
          candidateTagKeyMap.set(key, (candidateTagKeyMap.get(key) ?? 0) + 1);
        }
      }
    }

    const candidateTagKeys = [...candidateTagKeyMap.entries()]
      .filter(([, count]) => count > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([key, count]) => ({ key, count }));

    // Candidate spending category IDs — latest manual/manual_baseline/accepted-historical
    let candidateCatMap = new Map<string, number>(); // catId → count
    if (exampleCount > 0) {
      // For each historical expense, find the latest category decision
      for (const he of historicalExpenses) {
        if (!he.spending_category_id) continue;

        // Use the current spending_category_id from the expense (reflects latest decision)
        const catId = he.spending_category_id;
        if (catId) {
          candidateCatMap.set(catId, (candidateCatMap.get(catId) ?? 0) + 1);
        }
      }
    }

    const candidateSpendingCategoryIds = [...candidateCatMap.entries()]
      .filter(([, count]) => count > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([id, count]) => ({ id, count }));

    // Candidate tax category IDs (Business only: reviewed user-saved treatments)
    let candidateTaxCatMap = new Map<string, number>(); // catId → count
    if (!isPersonal && scopeBusinessId && eligibleTaxSnapshot && exampleCount > 0) {
      const taxRows = await transaction
        .selectFrom("app.expense_tax_treatments as ett")
        .select(["ett.tax_category_definition_id", "ett.expense_id"])
        .where("ett.expense_id", "in", historicalIds)
        .where("ett.tenant_id", "=", tenantId)
        .where("ett.business_id", "=", scopeBusinessId)
        .where("ett.business_tax_profile_id", "=", eligibleTaxSnapshot.businessTaxProfileId)
        .where("ett.review_status", "=", "reviewed")
        .execute();

      for (const row of taxRows) {
        const catId = row.tax_category_definition_id;
        candidateTaxCatMap.set(catId, (candidateTaxCatMap.get(catId) ?? 0) + 1);
      }
    }

    const candidateTaxCategoryIds = [...candidateTaxCatMap.entries()]
      .filter(([, count]) => count > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([id, count]) => ({ id, count }));

    const history: ExpenseEnrichmentInputV1["history"] = {
      exampleCount,
      candidateTagKeys,
      candidateSpendingCategoryIds,
      candidateTaxCategoryIds,
    };

    const evalInput: ExpenseEnrichmentInputV1 = {
      schemaVersion: 1,
      jobId,
      expenseId,
      expenseVersion: expense.version,
      normalizedMerchant,
      incurredOn,
      spendingCategoryId: expense.spending_category_id,
      rulesVersion: ENRICHMENT_RULES_VERSION,
      eligibleTagKeys,
      eligibleSpendingCategoryIds,
      eligibleTaxSnapshot,
      history,
    };

    return { outcome: "evaluate" as const, input: evalInput };
  });
}

// ------------------------------------------------------------------ //
// applyEnrichmentResult — validate, apply, record
// ------------------------------------------------------------------ //

export interface ApplyEnrichmentResultInput {
  readonly jobId: string;
  readonly idempotencyKey: string;
  readonly expectedJobVersion: number;
  readonly result: unknown;
  readonly actorServicePrincipal: string;
  readonly requestId: string;
}

/**
 * Apply a validated enrichment result atomically:
 * 1. Lock job + expense; verify versions.
 * 2. Parse result via canonical schema.
 * 3. Handle stale/skipped as safe no-mutation completions.
 * 4. For applied: recompute server-side rule tags and compare to worker's
 *    ruleTagKeys. Reject mismatches (CONFLICT).
 * 5. Create/reuse tenant-level rule tags; upsert active expense_tag associations.
 *    Skip existing manual/removed/archived tag decisions.
 * 6. Insert pending historical suggestions; skip ineligible candidates.
 * 7. Record permanent operation keys (replay-safe; conflict on payload change).
 * 8. Mark job SUCCEEDED.
 */
export async function applyEnrichmentResult(
  database: Kysely<AppDatabase>,
  input: ApplyEnrichmentResultInput,
): Promise<MutationResult<ProcessingJob, 200>> {
  return database.transaction().execute(async (transaction) => {
    // ---- Load and lock job ----
    const job = await transaction
      .selectFrom("app.processing_jobs")
      .selectAll()
      .where("id", "=", input.jobId)
      .forUpdate()
      .executeTakeFirst();

    if (!job || job.workflow_type !== EXPENSE_ENRICHMENT_WORKFLOW_TYPE) {
      throw DomainError.notFound();
    }
    if (job.version !== input.expectedJobVersion) {
      throw DomainError.preconditionFailed();
    }
    if (job.status !== "RUNNING") throw DomainError.conflict();

    // ---- Parse result ----
    const parsed = ExpenseEnrichmentResultV1Schema.safeParse(input.result);
    if (!parsed.success) throw DomainError.validation();
    const resultData = parsed.data;
    const outcome = resultData.outcome;

    // ---- Load expense ----
    const expenseId = job.target_aggregate_id;
    if (!expenseId || job.target_aggregate_type !== "expense") {
      throw DomainError.validation();
    }

    const expense = await transaction
      .selectFrom("app.expenses")
      .selectAll()
      .where("id", "=", expenseId)
      .where("tenant_id", "=", job.tenant_id)
      .forUpdate()
      .executeTakeFirst();

    // Stale/skipped: safe no-mutation completion
    if (!expense || expense.status === "archived") {
      return _completeJob(transaction, job, input, "skipped");
    }

    if (
      job.expected_aggregate_version !== null &&
      expense.version !== job.expected_aggregate_version
    ) {
      return _completeJob(transaction, job, input, "stale");
    }

    if (outcome === "stale" || outcome === "skipped") {
      return _completeJob(transaction, job, input, outcome);
    }

    // ---- outcome: applied ----
    // Scope
    const tenantId = job.tenant_id;
    const isPersonal = expense.personal_profile_id !== null;
    const scopeProfileId = expense.personal_profile_id;
    const scopeBusinessId = expense.business_id;

    // Re-derive eligible tag keys for server-side recomputation
    const rawMerchant = expense.merchant?.trim() ?? "";
    const normalizedMerchantRaw = rawMerchant ? normalizeMerchant(rawMerchant) : null;
    const normalizedMerchant = normalizedMerchantRaw || null;

    const incurredOnRaw = expense.incurred_on;
    const incurredOn =
      incurredOnRaw instanceof Date
        ? `${incurredOnRaw.getFullYear()}-${String(incurredOnRaw.getMonth() + 1).padStart(2, "0")}-${String(incurredOnRaw.getDate()).padStart(2, "0")}`
        : String(incurredOnRaw);

    const candidateTagKeysList: string[] = [];
    if (normalizedMerchant) candidateTagKeysList.push(merchantTagKey(normalizedMerchant));
    candidateTagKeysList.push("timing:weekend");
    if (expense.spending_category_id) {
      candidateTagKeysList.push(`category:${expense.spending_category_id}`);
    }

    // Eligible: absent or active tags (archived tags are permanently ineligible)
    const archivedTagsForEligibility =
      candidateTagKeysList.length > 0
        ? await transaction
            .selectFrom("app.tags")
            .select(["key"])
            .where("tenant_id", "=", tenantId)
            .where("key", "in", candidateTagKeysList)
            .where("status", "=", "archived")
            .execute()
        : [];

    const archivedKeySetForEligibility = new Set(archivedTagsForEligibility.map((t) => t.key));
    // Also collect existing active tags for suggestion eligibility validation
    const existingActiveTagRows =
      candidateTagKeysList.length > 0
        ? await transaction
            .selectFrom("app.tags")
            .select(["key", "id"])
            .where("tenant_id", "=", tenantId)
            .where("key", "in", candidateTagKeysList)
            .where("status", "=", "active")
            .execute()
        : [];
    const activeTagKeySet = new Set(existingActiveTagRows.map((t) => t.key));

    const eligibleTagKeys = candidateTagKeysList
      .filter((k) => !archivedKeySetForEligibility.has(k))
      .sort();

    // Server recomputes deterministic rule tags
    const serverRuleTagKeys = computeRuleTagKeys({
      normalizedMerchant,
      incurredOn,
      spendingCategoryId: expense.spending_category_id,
      eligibleTagKeys,
    }).sort();

    // Validate worker's ruleTagKeys matches server recomputation
    const workerRuleTagKeys = [...resultData.ruleTagKeys].sort();
    if (
      serverRuleTagKeys.length !== workerRuleTagKeys.length ||
      serverRuleTagKeys.some((k, i) => k !== workerRuleTagKeys[i])
    ) {
      throw DomainError.conflict();
    }

    // ---- Validate suggestions eligibility ----
    // Only eligible candidates are allowed
    const eligibleCatSet = new Set(
      (
        await transaction
          .selectFrom("app.spending_categories")
          .select("id")
          .where("tenant_id", "=", tenantId)
          .where("status", "=", "active")
          .execute()
      ).map((r) => r.id),
    );

    // Validate eligible tax snapshot for tax suggestions
    let activeTaxProfileId: string | null = null;
    let activeTaxProfileVersion: number | null = null;
    let activeTaxonomyVersionId: string | null = null;
    let activeTaxYear: number | null = null;
    let activeTaxCatIdSet = new Set<string>();

    if (!isPersonal && scopeBusinessId) {
      const taxProfile = await transaction
        .selectFrom("app.business_tax_profiles as btp")
        .select(["btp.id", "btp.version", "btp.taxonomy_version_id", "btp.tax_year"])
        .where("btp.tenant_id", "=", tenantId)
        .where("btp.business_id", "=", scopeBusinessId)
        .where("btp.status", "=", "active")
        .orderBy("btp.tax_year", "desc")
        .limit(1)
        .executeTakeFirst();

      if (taxProfile) {
        activeTaxProfileId = taxProfile.id;
        activeTaxProfileVersion = Number(taxProfile.version);
        activeTaxonomyVersionId = taxProfile.taxonomy_version_id;
        activeTaxYear = taxProfile.tax_year;

        const taxCats = await transaction
          .selectFrom("app.tax_category_definitions")
          .select("id")
          .where("taxonomy_version_id", "=", taxProfile.taxonomy_version_id)
          .where("status", "=", "active")
          .execute();
        activeTaxCatIdSet = new Set(taxCats.map((r) => r.id));
      }
    }

    // Validate each suggestion candidate is eligible
    for (const sug of resultData.suggestions) {
      if (sug.source !== "historical") throw DomainError.validation();
      if (sug.kind === "spending_category") {
        if (!eligibleCatSet.has(sug.spendingCategoryId)) {
          throw DomainError.conflict();
        }
      } else if (sug.kind === "tag") {
        // Tag suggestions must refer to an eligible tag key (absent or active, not archived)
        if (!eligibleTagKeys.includes(sug.tagKey)) {
          throw DomainError.conflict();
        }
      } else if (sug.kind === "tax_category") {
        // Full tax snapshot validation
        if (isPersonal) throw DomainError.conflict();
        if (
          sug.businessTaxProfileId !== activeTaxProfileId ||
          sug.businessTaxProfileVersion !== activeTaxProfileVersion ||
          sug.taxonomyVersionId !== activeTaxonomyVersionId ||
          sug.taxYear !== activeTaxYear ||
          !activeTaxCatIdSet.has(sug.taxCategoryDefinitionId)
        ) {
          throw DomainError.conflict();
        }
      }
    }

    const now = new Date();

    // ---- Apply rule tags ----
    for (const ruleKey of serverRuleTagKeys) {
      // Create or retrieve tenant-level rule tag
      const existingTag = await transaction
        .selectFrom("app.tags")
        .select(["id", "status"])
        .where("tenant_id", "=", tenantId)
        .where("key", "=", ruleKey)
        .executeTakeFirst();

      let tagId: string;
      if (existingTag) {
        tagId = existingTag.id;
        // If tag is archived, skip (spec: archived same key ineligible)
        if (existingTag.status === "archived") continue;
      } else {
        // Create new rule tag (tenant-level, no scope)
        tagId = randomUUID();
        await transaction
          .insertInto("app.tags")
          .values({
            id: tagId,
            tenant_id: tenantId,
            key: ruleKey,
            name: ruleKey,
            color: null,
            origin: "rule",
            status: "active",
            created_by_user_id: null,
            created_at: now,
            updated_at: now,
          })
          .execute();
      }

      // Check for existing expense_tag association
      const existingAssoc = await transaction
        .selectFrom("app.expense_tags")
        .select(["id", "status", "source"])
        .where("tenant_id", "=", tenantId)
        .where("expense_id", "=", expenseId)
        .where("tag_id", "=", tagId)
        .executeTakeFirst();

      if (existingAssoc) {
        // Skip if manual decision or removed or archived
        if (
          existingAssoc.source === "manual" ||
          existingAssoc.status === "removed"
        ) {
          continue;
        }
        // Update existing rule association to active (re-apply)
        await transaction
          .updateTable("app.expense_tags")
          .set({
            status: "active",
            source: "rule",
            confidence: "1",
            rule_version: ENRICHMENT_RULES_VERSION,
            applied_at: now,
          })
          .where("id", "=", existingAssoc.id)
          .execute();
      } else {
        // Insert new rule tag association (scope-bound)
        await transaction
          .insertInto("app.expense_tags")
          .values({
            id: randomUUID(),
            tenant_id: tenantId,
            personal_profile_id: scopeProfileId,
            business_id: scopeBusinessId,
            expense_id: expenseId,
            tag_id: tagId,
            source: "rule",
            confidence: "1",
            rule_version: ENRICHMENT_RULES_VERSION,
            suggestion_id: null,
            status: "active",
            applied_by_user_id: null,
            removed_by_user_id: null,
            applied_at: now,
            removed_at: null,
            created_at: now,
          })
          .execute();
      }

      // Record operation key for this rule tag
      await _recordOperationKey(transaction, {
        tenantId,
        jobId: input.jobId,
        expenseId,
        kind: "tag",
        candidateId: tagId,
        evidenceHashStr: sha256Hex(canonicalJson({ kind: "rule_tag", key: ruleKey })),
        operationKey: `${input.jobId}:rule:${ruleKey}`,
        payloadHash: hashNormalizedRequest({ kind: "rule_tag", key: ruleKey, jobId: input.jobId }),
        responseJson: null,
        now,
      });
    }

    // ---- Create pending historical suggestions ----
    for (const sug of resultData.suggestions) {
      const sugId = randomUUID();
      const idempotencyKey = `${input.jobId}:sug:${sug.kind}:${sug.source}:${sug.evidenceHash}`;

      // Determine candidate IDs
      let tagId: string | null = null;
      let spendingCategoryId: string | null = null;
      let taxCategoryDefinitionId: string | null = null;
      let businessTaxProfileId: string | null = null;
      let businessTaxProfileVersion: number | null = null;
      let taxonomyVersionId: string | null = null;
      let taxYear: number | null = null;

      let candidateId: string | null = null;

      if (sug.kind === "tag") {
        // Find tag by key
        const tagRow = await transaction
          .selectFrom("app.tags")
          .select("id")
          .where("tenant_id", "=", tenantId)
          .where("key", "=", sug.tagKey)
          .where("status", "=", "active")
          .executeTakeFirst();
        if (!tagRow) continue; // Tag no longer active — skip
        tagId = tagRow.id;
        candidateId = tagId;
      } else if (sug.kind === "spending_category") {
        spendingCategoryId = sug.spendingCategoryId;
        candidateId = spendingCategoryId;
      } else if (sug.kind === "tax_category") {
        taxCategoryDefinitionId = sug.taxCategoryDefinitionId;
        businessTaxProfileId = sug.businessTaxProfileId;
        businessTaxProfileVersion = sug.businessTaxProfileVersion;
        taxonomyVersionId = sug.taxonomyVersionId;
        taxYear = sug.taxYear;
        candidateId = taxCategoryDefinitionId;
      }

      // Check for existing pending suggestion (idempotency key)
      const existingSug = await transaction
        .selectFrom("app.expense_enrichment_suggestions")
        .select(["id", "status"])
        .where("tenant_id", "=", tenantId)
        .where("expense_id", "=", expenseId)
        .where("idempotency_key", "=", idempotencyKey)
        .executeTakeFirst();

      if (existingSug) continue; // Already exists

      // Insert pending suggestion
      const evidence: JsonValue = toJsonValue({
        exampleCount: sug.aggregateCounts.exampleCount,
        matchCount: sug.aggregateCounts.matchCount,
      });

      await transaction
        .insertInto("app.expense_enrichment_suggestions")
        .values({
          id: sugId,
          tenant_id: tenantId,
          personal_profile_id: scopeProfileId,
          business_id: scopeBusinessId,
          expense_id: expenseId,
          job_id: input.jobId,
          kind: sug.kind,
          tag_id: tagId,
          spending_category_id: spendingCategoryId,
          tax_category_definition_id: taxCategoryDefinitionId,
          business_tax_profile_id: businessTaxProfileId,
          business_tax_profile_version: businessTaxProfileVersion,
          taxonomy_version_id: taxonomyVersionId,
          tax_year: taxYear,
          source: "historical",
          confidence: String(sug.confidence),
          evidence,
          evidence_hash: sug.evidenceHash,
          status: "pending",
          version: 1,
          expense_version: expense.version,
          idempotency_key: idempotencyKey,
          resolved_by_user_id: null,
          resolved_at: null,
          created_at: now,
        })
        .execute();

      // Record operation key for this suggestion
      await _recordOperationKey(transaction, {
        tenantId,
        jobId: input.jobId,
        expenseId,
        kind: sug.kind as "tag" | "spending_category" | "tax_category",
        candidateId,
        evidenceHashStr: sug.evidenceHash,
        operationKey: idempotencyKey,
        payloadHash: hashNormalizedRequest({
          kind: sug.kind,
          candidateId,
          evidenceHash: sug.evidenceHash,
          jobId: input.jobId,
        }),
        responseJson: toJsonValue({ suggestionId: sugId }),
        now,
      });
    }

    // ---- Mark job SUCCEEDED ----
    const updated = await transaction
      .updateTable("app.processing_jobs")
      .set({
        status: "SUCCEEDED",
        result: toJsonValue(input.result as Record<string, unknown>),
        updated_at: now,
        completed_at: now,
        version: job.version + 1,
      })
      .where("id", "=", input.jobId)
      .returningAll()
      .executeTakeFirstOrThrow();

    await recordAuditEvent(transaction, {
      tenantId: job.tenant_id,
      actorServicePrincipal: input.actorServicePrincipal,
      action: "processing_job.enrichment_result_submitted",
      outcome: "success",
      resourceType: "processing_job",
      resourceId: input.jobId,
      requestId: input.requestId,
      metadata: { outcome: "applied" },
    });

    return {
      statusCode: 200,
      body: toProcessingJob(updated),
      replayed: false,
    };
  });
}

// ------------------------------------------------------------------ //
// Permanent operation key recording
// ------------------------------------------------------------------ //

interface RecordOpKeyInput {
  readonly tenantId: string;
  readonly jobId: string;
  readonly expenseId: string;
  readonly kind: "tag" | "spending_category" | "tax_category";
  readonly candidateId: string | null;
  readonly evidenceHashStr: string;
  readonly operationKey: string;
  readonly payloadHash: string;
  readonly responseJson: JsonValue;
  readonly now: Date;
}

async function _recordOperationKey(
  transaction: Transaction<AppDatabase>,
  input: RecordOpKeyInput,
): Promise<void> {
  // Check for existing record (replay or conflict)
  const existing = await transaction
    .selectFrom("app.enrichment_operation_keys")
    .select(["payload_hash", "response_json"])
    .where("tenant_id", "=", input.tenantId)
    .where("operation_key", "=", input.operationKey)
    .executeTakeFirst();

  if (existing) {
    if (existing.payload_hash !== input.payloadHash) {
      // Changed payload — permanent conflict
      throw DomainError.conflict();
    }
    // Same payload — idempotent, already recorded
    return;
  }

  await transaction
    .insertInto("app.enrichment_operation_keys")
    .values({
      id: randomUUID(),
      tenant_id: input.tenantId,
      job_id: input.jobId,
      expense_id: input.expenseId,
      kind: input.kind,
      candidate_id: input.candidateId,
      evidence_hash: input.evidenceHashStr,
      operation_key: input.operationKey,
      payload_hash: input.payloadHash,
      response_json: input.responseJson,
      created_at: input.now,
    })
    .execute();
}

// ------------------------------------------------------------------ //
// Stale/skipped completion helper
// ------------------------------------------------------------------ //

async function _completeJob(
  transaction: Transaction<AppDatabase>,
  job: import("./processing-job-view.js").ProcessingJobRow,
  input: ApplyEnrichmentResultInput,
  terminalOutcome: "stale" | "skipped",
): Promise<MutationResult<ProcessingJob, 200>> {
  const now = new Date();
  const updated = await transaction
    .updateTable("app.processing_jobs")
    .set({
      status: "SUCCEEDED",
      result: toJsonValue(input.result as Record<string, unknown>),
      updated_at: now,
      completed_at: now,
      version: job.version + 1,
    })
    .where("id", "=", input.jobId)
    .returningAll()
    .executeTakeFirstOrThrow();

  await recordAuditEvent(transaction, {
    tenantId: job.tenant_id,
    actorServicePrincipal: input.actorServicePrincipal,
    action: "processing_job.enrichment_result_submitted",
    outcome: "success",
    resourceType: "processing_job",
    resourceId: input.jobId,
    requestId: input.requestId,
    metadata: { outcome: terminalOutcome },
  });

  return {
    statusCode: 200,
    body: toProcessingJob(updated),
    replayed: false,
  };
}

// ------------------------------------------------------------------ //
// Permanent replay for enrichment result submission
// ------------------------------------------------------------------ //

/**
 * Check for a permanent operation key replay.
 * Returns the stored response if found and payload matches.
 * Throws CONFLICT if same key with different payload.
 * Returns null if no permanent record exists (first call).
 */
export async function checkPermanentReplay(
  database: Kysely<AppDatabase>,
  input: {
    readonly tenantId: string;
    readonly jobId: string;
    readonly expenseId: string;
    readonly payloadHash: string;
    readonly storedResponse: ProcessingJob;
  },
): Promise<MutationResult<ProcessingJob, 200> | null> {
  // Check if a "job-level" operation key exists for this job's result submission
  const operationKey = `result:${input.jobId}`;
  const existing = await database
    .selectFrom("app.enrichment_operation_keys")
    .select(["payload_hash", "response_json"])
    .where("tenant_id", "=", input.tenantId)
    .where("operation_key", "=", operationKey)
    .executeTakeFirst();

  if (!existing) return null;
  if (existing.payload_hash !== input.payloadHash) throw DomainError.conflict();

  return {
    statusCode: 200,
    body: input.storedResponse,
    replayed: true,
  };
}

// ------------------------------------------------------------------ //
// resolveSuggestion — Task 8 seam
// ------------------------------------------------------------------ //

/** Resolve a pending enrichment suggestion (accept/reject). Task 8 implements this. */
export async function resolveSuggestion(
  database: Kysely<AppDatabase>,
  input: {
    readonly suggestionId: string;
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly decision: "accepted" | "rejected";
    readonly requestId: string;
  },
): Promise<void> {
  // Task 8 will implement full resolution logic.
  // This seam ensures the function exists and is importable.
  throw DomainError.conflict();
}

// ------------------------------------------------------------------ //
// rerunEnrichment — Task 8 seam
// ------------------------------------------------------------------ //

/** Re-enqueue an enrichment job for an expense. Task 8 implements this. */
export async function rerunEnrichment(
  database: Kysely<AppDatabase>,
  input: {
    readonly tenantId: string;
    readonly expenseId: string;
    readonly requestedByUserId: string;
    readonly requestId: string;
  },
): Promise<ProcessingJob> {
  // Task 8 will implement re-enqueueing logic.
  throw DomainError.conflict();
}
