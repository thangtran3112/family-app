import { createHash, randomUUID } from "node:crypto";

import {
  FORWARDED_RECEIPT_WORKFLOW_TYPE,
  type DeduplicationEvidenceV1,
  DuplicateMatchEvidenceSchema,
  type DuplicateMatchList,
  type DuplicateMatchStatus,
} from "@expense-tax/contracts";
import { type Kysely, type Selectable, type Transaction } from "kysely";

import type { AppDatabase } from "../database/types.js";
import { DomainError } from "../errors.js";
import { recordAuditEvent } from "./audit.js";
import { requireScopeRole, type FileScope } from "./files.js";
import {
  executeIdempotentMutation,
  hashNormalizedRequest,
  toJsonValue,
} from "./idempotency.js";

const FINGERPRINT_VERSION = 1;

export interface DeduplicationFingerprint {
  readonly version: number;
  readonly normalizedMerchant: string;
  readonly amountMinorUnits: number;
  readonly currency: string;
  readonly incurredOn: string;
  readonly hash: string;
}

export interface RecordDeduplicationEvidenceInput {
  readonly request: DeduplicationEvidenceV1;
  readonly actorServicePrincipal: string;
  readonly requestId: string;
}

export interface ListDeduplicationMatchesInput {
  readonly actorUserId: string;
  readonly tenantId: string;
  readonly scope: FileScope;
  readonly status?: DuplicateMatchStatus;
  readonly limit?: number;
}

export interface DeduplicationDomain {
  recordEvidence(input: RecordDeduplicationEvidenceInput): Promise<{
    readonly decision: "no_match" | "review";
    readonly matchIds: readonly string[];
  }>;
  listMatches(input: ListDeduplicationMatchesInput): Promise<DuplicateMatchList>;
}

export interface DeduplicationCandidateFile {
  readonly expenseId: string | null;
  readonly sha256Hex: string | null;
  readonly personalProfileId: string | null;
  readonly businessId: string | null;
}

export interface DeduplicationCandidateFingerprint {
  readonly expenseId: string;
  readonly fingerprintHash: string;
  readonly normalizedMerchant: string;
  readonly amountMinorUnits: number;
  readonly currency: string;
  readonly incurredOn: Date | string;
  readonly personalProfileId: string | null;
  readonly businessId: string | null;
}

export interface DeterministicCandidate {
  readonly existingExpenseId: string;
  readonly matchType: "file_sha256" | "fingerprint" | "fuzzy_fields";
  readonly confidence: number;
  readonly evidence: Record<string, unknown>;
}

export function normalizeMerchant(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en-US")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[\p{P}\p{S}]+/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function toAmountMinorUnits(value: string): number {
  const [whole, fraction = ""] = value.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

function dateOnly(value: Date | string): string {
  if (typeof value === "string") return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

export function buildDeduplicationFingerprint(input: {
  readonly merchant: string;
  readonly amount: string;
  readonly currency: string;
  readonly incurredOn: string;
}): DeduplicationFingerprint {
  const normalizedMerchant = normalizeMerchant(input.merchant);
  if (!normalizedMerchant || !input.amount || !input.currency || !input.incurredOn) {
    throw DomainError.validation();
  }
  const amountMinorUnits = toAmountMinorUnits(input.amount);
  const currency = input.currency.toUpperCase();
  const canonical = [
    `v${FINGERPRINT_VERSION}`,
    normalizedMerchant,
    amountMinorUnits,
    currency,
    input.incurredOn,
  ].join("\n");
  return {
    version: FINGERPRINT_VERSION,
    normalizedMerchant,
    amountMinorUnits,
    currency,
    incurredOn: input.incurredOn,
    hash: createHash("sha256").update(canonical).digest("hex"),
  };
}

function sameScope(
  row:
    | { readonly personal_profile_id: string | null; readonly business_id: string | null }
    | { readonly personalProfileId: string | null; readonly businessId: string | null },
  scope: FileScope,
): boolean {
  const personalProfileId =
    "personal_profile_id" in row ? row.personal_profile_id : row.personalProfileId;
  const businessId = "business_id" in row ? row.business_id : row.businessId;
  return scope.kind === "personal"
    ? personalProfileId === scope.profileId && businessId === null
    : businessId === scope.businessId && personalProfileId === null;
}

function daysBetween(left: string, right: string): number {
  return Math.abs(
    (Date.parse(`${left}T00:00:00.000Z`) - Date.parse(`${right}T00:00:00.000Z`)) /
      86_400_000,
  );
}

export function findDeterministicCandidates(input: {
  readonly scope: FileScope;
  readonly candidateExpenseId: string;
  readonly file: DeduplicationCandidateFile;
  readonly fingerprint: DeduplicationFingerprint;
  readonly files: readonly DeduplicationCandidateFile[];
  readonly fingerprints: readonly DeduplicationCandidateFingerprint[];
}): DeterministicCandidate[] {
  const candidates: DeterministicCandidate[] = [];
  if (input.file.sha256Hex) {
    for (const other of input.files) {
      if (
        other.expenseId === null ||
        other.expenseId === input.candidateExpenseId ||
        other.sha256Hex !== input.file.sha256Hex ||
        !sameScope(other, input.scope)
      ) continue;
      candidates.push({
        existingExpenseId: other.expenseId,
        matchType: "file_sha256",
        confidence: 1,
        evidence: { fileSha256: input.file.sha256Hex },
      });
    }
  }
  for (const other of input.fingerprints) {
    if (other.expenseId === input.candidateExpenseId || !sameScope(other, input.scope)) continue;
    if (other.fingerprintHash === input.fingerprint.hash) {
      candidates.push({
        existingExpenseId: other.expenseId,
        matchType: "fingerprint",
        confidence: 1,
        evidence: { fingerprintHash: input.fingerprint.hash },
      });
      continue;
    }
    if (other.normalizedMerchant !== input.fingerprint.normalizedMerchant) continue;
    const amountDifferencePercent =
      Math.abs(other.amountMinorUnits - input.fingerprint.amountMinorUnits) /
      input.fingerprint.amountMinorUnits * 100;
    const incurredOnDifferenceDays = daysBetween(
      dateOnly(other.incurredOn),
      input.fingerprint.incurredOn,
    );
    if (amountDifferencePercent <= 5 && incurredOnDifferenceDays <= 2) {
      candidates.push({
        existingExpenseId: other.expenseId,
        matchType: "fuzzy_fields",
        confidence: 0.8,
        evidence: {
          normalizedMerchant: input.fingerprint.normalizedMerchant,
          amountMinorUnits: input.fingerprint.amountMinorUnits,
          currency: input.fingerprint.currency,
          incurredOn: input.fingerprint.incurredOn,
          amountDifferencePercent,
          incurredOnDifferenceDays,
        },
      });
    }
  }
  return candidates;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "23505";
}

function matchEvidence(value: unknown) {
  return DuplicateMatchEvidenceSchema.parse(value);
}

function toDuplicateMatch(row: Selectable<AppDatabase["app.expense_duplicate_matches"]>) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    personalProfileId: row.personal_profile_id,
    businessId: row.business_id,
    existingExpenseId: row.existing_expense_id,
    candidateExpenseId: row.candidate_expense_id,
    matchType: row.match_type,
    confidence: Number(row.confidence),
    evidence: matchEvidence(row.evidence),
    status: row.status,
    version: row.version,
    resolvedBy: row.resolved_by,
    resolvedAt: row.resolved_at?.toISOString() ?? null,
    resolutionIdempotencyKey: row.resolution_idempotency_key,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at.toISOString(),
  };
}

async function requireJob(
  transaction: Transaction<AppDatabase>,
  input: DeduplicationEvidenceV1,
) {
  const job = await transaction
    .selectFrom("app.processing_jobs")
    .selectAll()
    .where("id", "=", input.jobId)
    .forUpdate()
    .executeTakeFirst();
  if (!job) throw DomainError.notFound();
  if (job.version !== input.expectedJobVersion) throw DomainError.preconditionFailed();
  if (job.source_file_id !== input.sourceFileId) throw DomainError.validation();
  if (job.personal_profile_id === null && job.business_id === null) throw DomainError.validation();
  if (job.personal_profile_id !== null && job.business_id !== null) throw DomainError.validation();
  return job;
}

async function findCandidate(
  transaction: Transaction<AppDatabase>,
  job: Awaited<ReturnType<typeof requireJob>>,
  sourceFileId: string,
) {
  const file = await transaction
    .selectFrom("app.expense_files")
    .selectAll()
    .where("id", "=", sourceFileId)
    .where("tenant_id", "=", job.tenant_id)
    .executeTakeFirst();
  if (!file || file.status === "DELETED") throw DomainError.notFound();
  if (
    file.personal_profile_id !== job.personal_profile_id ||
    file.business_id !== job.business_id
  ) throw DomainError.validation();
  const candidateExpenseId = job.target_aggregate_id ?? file.expense_id;
  if (!candidateExpenseId) throw DomainError.validation();
  const candidate = await transaction
    .selectFrom("app.expenses")
    .selectAll()
    .where("id", "=", candidateExpenseId)
    .where("tenant_id", "=", job.tenant_id)
    .executeTakeFirst();
  if (!candidate || candidate.status === "archived") throw DomainError.notFound();
  if (
    candidate.personal_profile_id !== job.personal_profile_id ||
    candidate.business_id !== job.business_id
  ) throw DomainError.validation();
  return { file, candidate };
}

async function addMatch(
  transaction: Transaction<AppDatabase>,
  input: {
    readonly tenantId: string;
    readonly scope: FileScope;
    readonly candidateExpenseId: string;
    readonly existingExpenseId: string;
    readonly matchType: "file_sha256" | "fingerprint" | "fuzzy_fields";
    readonly confidence: number;
    readonly evidence: Record<string, unknown>;
    readonly idempotencyKey: string;
  },
): Promise<string> {
  const values = {
    id: randomUUID(),
    tenant_id: input.tenantId,
    personal_profile_id: input.scope.kind === "personal" ? input.scope.profileId : null,
    business_id: input.scope.kind === "business" ? input.scope.businessId : null,
    existing_expense_id: input.existingExpenseId,
    candidate_expense_id: input.candidateExpenseId,
    match_type: input.matchType,
    confidence: input.confidence.toFixed(4),
    evidence: toJsonValue(input.evidence),
    status: "pending" as const,
    version: 1,
    resolved_by: null,
    resolved_at: null,
    resolution_idempotency_key: null,
    idempotency_key: input.idempotencyKey,
  };
  try {
    await transaction
      .insertInto("app.expense_duplicate_matches")
      .values(values)
      .onConflict((oc) => oc.columns(["tenant_id", "idempotency_key"]).doNothing())
      .execute();
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }
  const row = await transaction
    .selectFrom("app.expense_duplicate_matches")
    .select("id")
    .where("tenant_id", "=", input.tenantId)
    .where("candidate_expense_id", "=", input.candidateExpenseId)
    .where("existing_expense_id", "=", input.existingExpenseId)
    .where("match_type", "=", input.matchType)
    .where("status", "=", "pending")
    .executeTakeFirst();
  if (!row) throw DomainError.conflict();
  return row.id;
}

export function createDeduplicationDomain(
  database: Kysely<AppDatabase>,
): DeduplicationDomain {
  return {
    async recordEvidence(input) {
      const result = await executeIdempotentMutation(database, {
        actorKey: `service:${input.actorServicePrincipal}`,
        operationKey: "deduplication.evidence.record",
        idempotencyKey: input.request.idempotencyKey,
        requestHash: hashNormalizedRequest(input.request),
        statusCode: 200 as const,
        parseBody: (value) => value as { decision: "no_match" | "review"; matchIds: string[] },
        execute: async (transaction) => {
          const job = await requireJob(transaction, input.request);
          const scope: FileScope =
            job.personal_profile_id !== null
              ? { kind: "personal", profileId: job.personal_profile_id }
              : { kind: "business", businessId: job.business_id as string };
          const { file, candidate } = await findCandidate(transaction, job, input.request.sourceFileId);
          const fingerprint = buildDeduplicationFingerprint(input.request);
          const inboundEmailId =
            job.workflow_type === FORWARDED_RECEIPT_WORKFLOW_TYPE &&
            typeof job.input_params === "object" &&
            job.input_params !== null &&
            typeof (job.input_params as Record<string, unknown>).inboundEmailId === "string"
              ? (job.input_params as Record<string, string>).inboundEmailId
              : null;
          if (job.workflow_type === FORWARDED_RECEIPT_WORKFLOW_TYPE && !inboundEmailId) {
            throw DomainError.validation();
          }
          if (inboundEmailId) {
            const inboundEmail = await transaction
              .selectFrom("app.inbound_emails")
              .select(["id", "tenant_id", "personal_profile_id", "business_id"])
              .where("id", "=", inboundEmailId)
              .where("tenant_id", "=", job.tenant_id)
              .executeTakeFirst();
            if (
              !inboundEmail ||
              inboundEmail.personal_profile_id !== job.personal_profile_id ||
              inboundEmail.business_id !== job.business_id
            ) throw DomainError.validation();
          }

          await transaction
            .insertInto("app.expense_sources")
            .values({
              id: randomUUID(),
              tenant_id: job.tenant_id,
              personal_profile_id: job.personal_profile_id,
              business_id: job.business_id,
              expense_id: candidate.id,
              source_type: inboundEmailId ? "forwarded_email" : "manual_upload",
              source_file_id: file.id,
              inbound_email_id: inboundEmailId,
              metadata: toJsonValue(input.request.orderNumber ? { orderNumber: input.request.orderNumber } : {}),
            })
            .onConflict((oc) => oc.columns(["tenant_id", "source_file_id"]).doNothing())
            .execute();
          await transaction
            .insertInto("app.expense_dedup_fingerprints")
            .values({
              id: randomUUID(),
              tenant_id: job.tenant_id,
              personal_profile_id: job.personal_profile_id,
              business_id: job.business_id,
              expense_id: candidate.id,
              fingerprint_version: fingerprint.version,
              normalized_merchant: fingerprint.normalizedMerchant,
              amount_minor_units: fingerprint.amountMinorUnits,
              currency: fingerprint.currency,
              incurred_on: new Date(`${fingerprint.incurredOn}T00:00:00.000Z`),
              fingerprint_hash: fingerprint.hash,
            })
            .onConflict((oc) => oc.columns(["expense_id", "fingerprint_version"]).doNothing())
            .execute();

          const matchIds: string[] = [];
          const files = file.sha256_hex
            ? await transaction
                .selectFrom("app.expense_files")
                .select(["expense_id", "sha256_hex", "personal_profile_id", "business_id"])
                .where("tenant_id", "=", job.tenant_id)
                .where("sha256_hex", "=", file.sha256_hex)
                .where("expense_id", "is not", null)
                .execute()
            : [];
          const fingerprints = await transaction
            .selectFrom("app.expense_dedup_fingerprints")
            .selectAll()
            .where("tenant_id", "=", job.tenant_id)
            .where("normalized_merchant", "=", fingerprint.normalizedMerchant)
            .execute();
          const candidates = findDeterministicCandidates({
            scope,
            candidateExpenseId: candidate.id,
            file: {
              expenseId: file.expense_id,
              sha256Hex: file.sha256_hex,
              personalProfileId: file.personal_profile_id,
              businessId: file.business_id,
            },
            fingerprint,
            files: files.map((row) => ({
              expenseId: row.expense_id,
              sha256Hex: row.sha256_hex,
              personalProfileId: row.personal_profile_id,
              businessId: row.business_id,
            })),
            fingerprints: fingerprints.map((row) => ({
              expenseId: row.expense_id,
              fingerprintHash: row.fingerprint_hash,
              normalizedMerchant: row.normalized_merchant,
              amountMinorUnits: Number(row.amount_minor_units),
              currency: row.currency,
              incurredOn: row.incurred_on,
              personalProfileId: row.personal_profile_id,
              businessId: row.business_id,
            })),
          });
          for (const match of candidates) {
            matchIds.push(await addMatch(transaction, {
              tenantId: job.tenant_id,
              scope,
              candidateExpenseId: candidate.id,
              existingExpenseId: match.existingExpenseId,
              matchType: match.matchType,
              confidence: match.confidence,
              evidence: match.evidence,
              idempotencyKey: `${input.request.idempotencyKey}:${match.matchType}:${match.existingExpenseId}`,
            }));
          }
          await transaction
            .updateTable("app.processing_jobs")
            .set({ updated_at: new Date() })
            .where("id", "=", job.id)
            .execute();
          await recordAuditEvent(transaction, {
            tenantId: job.tenant_id,
            actorServicePrincipal: input.actorServicePrincipal,
            action: "deduplication.evidence_recorded",
            outcome: "success",
            resourceType: "processing_job",
            resourceId: job.id,
            requestId: input.requestId,
            metadata: { matchCount: matchIds.length },
          });
          return { decision: matchIds.length > 0 ? "review" as const : "no_match" as const, matchIds };
        },
      });
      return result.body;
    },

    async listMatches(input) {
      await requireScopeRole(database, input);
      let query = database
        .selectFrom("app.expense_duplicate_matches")
        .selectAll()
        .where("tenant_id", "=", input.tenantId)
        .where("status", "=", input.status ?? "pending");
      query = input.scope.kind === "personal"
        ? query.where("personal_profile_id", "=", input.scope.profileId)
        : query.where("business_id", "=", input.scope.businessId);
      const rows = await query
        .orderBy("created_at", "desc")
        .orderBy("id", "desc")
        .limit(input.limit ?? 50)
        .execute();
      return { items: rows.map(toDuplicateMatch), nextCursor: null };
    },
  };
}
