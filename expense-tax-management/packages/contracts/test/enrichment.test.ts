import { describe, expect, expectTypeOf, it } from "vitest";

import {
  // Scope
  ScopeSchema,
  type Scope,
  // Tag
  TagStatusSchema,
  TagOriginSchema,
  TagSchema,
  TagCreateRequestSchema,
  TagUpdateRequestSchema,
  TagArchiveRequestSchema,
  TagListSchema,
  type Tag,
  // ExpenseTag
  ExpenseTagSchema,
  ExpenseTagAssociateRequestSchema,
  ExpenseTagRemoveRequestSchema,
  // Decision
  DecisionSourceSchema,
  ExpenseSpendingCategoryDecisionSchema,
  ExpenseSpendingCategoryDecisionListSchema,
  // Suggestion
  EnrichmentSuggestionKindSchema,
  EnrichmentSuggestionStatusSchema,
  EnrichmentSuggestionSchema,
  EnrichmentSuggestionListSchema,
  // Candidate XOR
  TagCandidateSchema,
  SpendingCategoryCandidateSchema,
  TaxCategoryCandidateSchema,
  // Actions
  SuggestionResolveRequestSchema,
  SuggestionResolveResponseSchema,
  SuggestionMergeRequestSchema,
  SuggestionRerunRequestSchema,
} from "../src/enrichment.js";

const ids = {
  tenantId: "00000000-0000-4000-8000-000000000001",
  profileId: "00000000-0000-4000-8000-000000000002",
  businessId: "00000000-0000-4000-8000-000000000003",
  tagId: "00000000-0000-4000-8000-000000000004",
  expenseId: "00000000-0000-4000-8000-000000000005",
  jobId: "00000000-0000-4000-8000-000000000006",
  suggestionId: "00000000-0000-4000-8000-000000000007",
  categoryId: "00000000-0000-4000-8000-000000000008",
  taxCategoryId: "00000000-0000-4000-8000-000000000009",
  taxProfileId: "00000000-0000-4000-8000-00000000000a",
  taxonomyVersionId: "00000000-0000-4000-8000-00000000000b",
  userId: "00000000-0000-4000-8000-00000000000c",
};

describe("ScopeSchema", () => {
  it("accepts personal scope", () => {
    const result = ScopeSchema.safeParse({ kind: "personal", profileId: ids.profileId });
    expect(result.success).toBe(true);
  });

  it("accepts business scope", () => {
    const result = ScopeSchema.safeParse({ kind: "business", businessId: ids.businessId });
    expect(result.success).toBe(true);
  });

  it("rejects unknown kind", () => {
    expect(ScopeSchema.safeParse({ kind: "unknown", profileId: ids.profileId }).success).toBe(false);
  });

  it("rejects personal scope with businessId", () => {
    expect(
      ScopeSchema.safeParse({ kind: "personal", profileId: ids.profileId, businessId: ids.businessId }).success,
    ).toBe(false);
  });

  it("rejects business scope with profileId", () => {
    expect(
      ScopeSchema.safeParse({ kind: "business", businessId: ids.businessId, profileId: ids.profileId }).success,
    ).toBe(false);
  });

  it("infers correct Scope type", () => {
    expectTypeOf<Scope>().toMatchTypeOf<
      { kind: "personal"; profileId: string } | { kind: "business"; businessId: string }
    >();
  });
});

describe("Tag schemas", () => {
  const baseTag: Tag = {
    id: ids.tagId,
    tenantId: ids.tenantId,
    personalProfileId: ids.profileId,
    businessId: null,
    key: "travel",
    name: "Travel",
    color: "#FF5733",
    origin: "manual_baseline",
    status: "active",
    version: 1,
    createdAt: "2026-09-12T00:00:00.000Z",
    updatedAt: "2026-09-12T00:00:00.000Z",
  };

  it("accepts a valid personal-scoped tag", () => {
    expect(TagSchema.parse(baseTag)).toEqual(baseTag);
  });

  it("accepts a valid business-scoped tag", () => {
    expect(
      TagSchema.safeParse({ ...baseTag, personalProfileId: null, businessId: ids.businessId }).success,
    ).toBe(true);
  });

  it("rejects dual-scoped tag (both personalProfileId and businessId)", () => {
    expect(
      TagSchema.safeParse({ ...baseTag, businessId: ids.businessId }).success,
    ).toBe(false);
  });

  it("rejects null-scoped tag (neither scope)", () => {
    expect(
      TagSchema.safeParse({ ...baseTag, personalProfileId: null }).success,
    ).toBe(false);
  });

  it("rejects extra fields (strictObject)", () => {
    expect(TagSchema.safeParse({ ...baseTag, extra: true }).success).toBe(false);
  });

  it("rejects invalid status", () => {
    expect(TagSchema.safeParse({ ...baseTag, status: "deleted" }).success).toBe(false);
  });

  it("rejects invalid origin", () => {
    expect(TagSchema.safeParse({ ...baseTag, origin: "unknown" }).success).toBe(false);
  });

  it("rejects invalid color format", () => {
    expect(TagSchema.safeParse({ ...baseTag, color: "red" }).success).toBe(false);
  });

  it("accepts TagCreateRequestSchema", () => {
    expect(
      TagCreateRequestSchema.safeParse({ key: "food", name: "Food", color: "#AABBCC" }).success,
    ).toBe(true);
  });

  it("rejects key with spaces or uppercase in TagCreateRequestSchema", () => {
    expect(TagCreateRequestSchema.safeParse({ key: "My Tag", name: "T", color: "#AABBCC" }).success).toBe(false);
    expect(TagCreateRequestSchema.safeParse({ key: "TAG", name: "T", color: "#AABBCC" }).success).toBe(false);
  });

  it("accepts TagUpdateRequestSchema with at least one field", () => {
    expect(
      TagUpdateRequestSchema.safeParse({ expectedVersion: 1, name: "New Name" }).success,
    ).toBe(true);
  });

  it("rejects TagUpdateRequestSchema with no change fields", () => {
    expect(TagUpdateRequestSchema.safeParse({ expectedVersion: 1 }).success).toBe(false);
  });

  it("accepts TagArchiveRequestSchema", () => {
    expect(TagArchiveRequestSchema.safeParse({ expectedVersion: 2 }).success).toBe(true);
  });

  it("accepts TagListSchema with pagination cursor", () => {
    expect(TagListSchema.parse({ items: [baseTag], nextCursor: null })).toEqual({
      items: [baseTag],
      nextCursor: null,
    });
  });

  it("validates tag status enum", () => {
    expect(TagStatusSchema.parse("active")).toBe("active");
    expect(TagStatusSchema.parse("archived")).toBe("archived");
    expect(TagStatusSchema.safeParse("deleted").success).toBe(false);
  });

  it("validates tag origin enum", () => {
    expect(TagOriginSchema.parse("ai")).toBe("ai");
    expect(TagOriginSchema.parse("manual_baseline")).toBe("manual_baseline");
    expect(TagOriginSchema.safeParse("unknown").success).toBe(false);
  });
});

describe("ExpenseTag schemas", () => {
  const expenseTag = {
    expenseId: ids.expenseId,
    tagId: ids.tagId,
    tenantId: ids.tenantId,
    createdAt: "2026-09-12T00:00:00.000Z",
  };

  it("accepts valid expense tag association", () => {
    expect(ExpenseTagSchema.parse(expenseTag)).toEqual(expenseTag);
  });

  it("rejects extra fields", () => {
    expect(ExpenseTagSchema.safeParse({ ...expenseTag, extra: true }).success).toBe(false);
  });

  it("accepts ExpenseTagAssociateRequestSchema", () => {
    expect(
      ExpenseTagAssociateRequestSchema.safeParse({ tagId: ids.tagId }).success,
    ).toBe(true);
  });

  it("accepts ExpenseTagRemoveRequestSchema", () => {
    expect(
      ExpenseTagRemoveRequestSchema.safeParse({ tagId: ids.tagId }).success,
    ).toBe(true);
  });
});

describe("ExpenseSpendingCategoryDecision schemas", () => {
  const decision = {
    id: ids.suggestionId,
    expenseId: ids.expenseId,
    tenantId: ids.tenantId,
    spendingCategoryId: ids.categoryId,
    source: "manual_baseline" as const,
    actorUserId: ids.userId,
    expenseVersion: 1,
    createdAt: "2026-09-12T00:00:00.000Z",
  };

  it("accepts valid decision", () => {
    expect(ExpenseSpendingCategoryDecisionSchema.parse(decision)).toEqual(decision);
  });

  it("rejects invalid source", () => {
    expect(
      ExpenseSpendingCategoryDecisionSchema.safeParse({ ...decision, source: "unknown" }).success,
    ).toBe(false);
  });

  it("accepts all valid sources", () => {
    for (const source of ["ai", "manual_baseline", "manual_user"] as const) {
      expect(
        DecisionSourceSchema.safeParse(source).success,
        `source '${source}' should be valid`,
      ).toBe(true);
    }
  });

  it("accepts list schema", () => {
    const list = ExpenseSpendingCategoryDecisionListSchema.safeParse({
      items: [decision],
      nextCursor: null,
    });
    expect(list.success).toBe(true);
  });
});

describe("EnrichmentSuggestion schemas", () => {
  const baseSuggestion = {
    id: ids.suggestionId,
    tenantId: ids.tenantId,
    expenseId: ids.expenseId,
    jobId: ids.jobId,
    kind: "tag" as const,
    status: "pending" as const,
    candidateId: ids.tagId,
    evidence: { matchedMerchant: "Starbucks" },
    evidenceHash: "a".repeat(64),
    confidence: 0.85,
    workerSchemaVersion: 1,
    // tax snapshot: null for non-tax suggestions
    businessTaxProfileId: null,
    businessTaxProfileVersion: null,
    taxonomyVersionId: null,
    taxYear: null,
    taxCategoryDefinitionId: null,
    expenseVersion: 1,
    createdAt: "2026-09-12T00:00:00.000Z",
  };

  it("accepts a valid tag suggestion", () => {
    expect(EnrichmentSuggestionSchema.safeParse(baseSuggestion).success).toBe(true);
  });

  it("rejects invalid kind", () => {
    expect(
      EnrichmentSuggestionSchema.safeParse({ ...baseSuggestion, kind: "unknown" }).success,
    ).toBe(false);
  });

  it("rejects invalid status", () => {
    expect(
      EnrichmentSuggestionSchema.safeParse({ ...baseSuggestion, status: "deleted" }).success,
    ).toBe(false);
  });

  it("rejects confidence out of [0,1]", () => {
    expect(
      EnrichmentSuggestionSchema.safeParse({ ...baseSuggestion, confidence: -0.01 }).success,
    ).toBe(false);
    expect(
      EnrichmentSuggestionSchema.safeParse({ ...baseSuggestion, confidence: 1.01 }).success,
    ).toBe(false);
  });

  it("rejects invalid evidence_hash format", () => {
    expect(
      EnrichmentSuggestionSchema.safeParse({ ...baseSuggestion, evidenceHash: "not-a-hash" }).success,
    ).toBe(false);
  });

  it("rejects workerSchemaVersion < 1", () => {
    expect(
      EnrichmentSuggestionSchema.safeParse({ ...baseSuggestion, workerSchemaVersion: 0 }).success,
    ).toBe(false);
  });

  it("tax_category suggestion requires full Business snapshot", () => {
    const taxSuggestion = {
      ...baseSuggestion,
      kind: "tax_category" as const,
      candidateId: ids.taxCategoryId,
      businessTaxProfileId: ids.taxProfileId,
      businessTaxProfileVersion: 1,
      taxonomyVersionId: ids.taxonomyVersionId,
      taxYear: 2025,
      taxCategoryDefinitionId: ids.taxCategoryId,
      expenseVersion: 2,
    };
    expect(EnrichmentSuggestionSchema.safeParse(taxSuggestion).success).toBe(true);
    // missing taxYear => fail
    expect(
      EnrichmentSuggestionSchema.safeParse({ ...taxSuggestion, taxYear: null }).success,
    ).toBe(false);
    // missing businessTaxProfileId => fail
    expect(
      EnrichmentSuggestionSchema.safeParse({ ...taxSuggestion, businessTaxProfileId: null }).success,
    ).toBe(false);
  });

  it("non-tax_category suggestion must have null tax snapshot", () => {
    // tag with non-null tax fields => fail
    expect(
      EnrichmentSuggestionSchema.safeParse({
        ...baseSuggestion,
        kind: "tag",
        businessTaxProfileId: ids.taxProfileId,
        businessTaxProfileVersion: 1,
        taxonomyVersionId: ids.taxonomyVersionId,
        taxYear: 2025,
        taxCategoryDefinitionId: ids.taxCategoryId,
      }).success,
    ).toBe(false);
  });

  it("accepts EnrichmentSuggestionListSchema", () => {
    expect(
      EnrichmentSuggestionListSchema.safeParse({
        items: [baseSuggestion],
        nextCursor: null,
      }).success,
    ).toBe(true);
  });

  it("validates kind enum", () => {
    expect(EnrichmentSuggestionKindSchema.parse("tag")).toBe("tag");
    expect(EnrichmentSuggestionKindSchema.parse("spending_category")).toBe("spending_category");
    expect(EnrichmentSuggestionKindSchema.parse("tax_category")).toBe("tax_category");
    expect(EnrichmentSuggestionKindSchema.safeParse("other").success).toBe(false);
  });

  it("validates status enum", () => {
    for (const status of ["pending", "accepted", "rejected", "superseded"] as const) {
      expect(EnrichmentSuggestionStatusSchema.safeParse(status).success).toBe(true);
    }
    expect(EnrichmentSuggestionStatusSchema.safeParse("deleted").success).toBe(false);
  });
});

describe("Strict kind-specific candidate XOR objects", () => {
  it("accepts TagCandidateSchema", () => {
    expect(TagCandidateSchema.safeParse({ tagId: ids.tagId }).success).toBe(true);
  });

  it("rejects TagCandidateSchema with extra fields", () => {
    expect(TagCandidateSchema.safeParse({ tagId: ids.tagId, extra: true }).success).toBe(false);
  });

  it("accepts SpendingCategoryCandidateSchema", () => {
    expect(
      SpendingCategoryCandidateSchema.safeParse({ spendingCategoryId: ids.categoryId }).success,
    ).toBe(true);
  });

  it("rejects SpendingCategoryCandidateSchema with extra fields", () => {
    expect(
      SpendingCategoryCandidateSchema.safeParse({ spendingCategoryId: ids.categoryId, extra: true }).success,
    ).toBe(false);
  });

  it("accepts TaxCategoryCandidateSchema with full snapshot", () => {
    expect(
      TaxCategoryCandidateSchema.safeParse({
        taxCategoryDefinitionId: ids.taxCategoryId,
        businessTaxProfileId: ids.taxProfileId,
        businessTaxProfileVersion: 1,
        taxonomyVersionId: ids.taxonomyVersionId,
        taxYear: 2025,
        activeTaxCategoryIds: [ids.taxCategoryId],
      }).success,
    ).toBe(true);
  });

  it("rejects TaxCategoryCandidateSchema with missing snapshot fields", () => {
    expect(
      TaxCategoryCandidateSchema.safeParse({
        taxCategoryDefinitionId: ids.taxCategoryId,
      }).success,
    ).toBe(false);
  });

  it("rejects TaxCategoryCandidateSchema with invalid taxYear", () => {
    expect(
      TaxCategoryCandidateSchema.safeParse({
        taxCategoryDefinitionId: ids.taxCategoryId,
        businessTaxProfileId: ids.taxProfileId,
        businessTaxProfileVersion: 1,
        taxonomyVersionId: ids.taxonomyVersionId,
        taxYear: 1800,
        activeTaxCategoryIds: [],
      }).success,
    ).toBe(false);
  });

  it("rejects TaxCategoryCandidateSchema with extra fields", () => {
    expect(
      TaxCategoryCandidateSchema.safeParse({
        taxCategoryDefinitionId: ids.taxCategoryId,
        businessTaxProfileId: ids.taxProfileId,
        businessTaxProfileVersion: 1,
        taxonomyVersionId: ids.taxonomyVersionId,
        taxYear: 2025,
        activeTaxCategoryIds: [],
        extra: true,
      }).success,
    ).toBe(false);
  });
});

describe("Suggestion action schemas", () => {
  it("accepts SuggestionResolveRequestSchema with accepted/rejected/superseded", () => {
    for (const action of ["accepted", "rejected", "superseded"] as const) {
      expect(
        SuggestionResolveRequestSchema.safeParse({
          action,
          expectedVersion: 1,
        }).success,
      ).toBe(true);
    }
  });

  it("rejects SuggestionResolveRequestSchema with pending action", () => {
    expect(
      SuggestionResolveRequestSchema.safeParse({ action: "pending", expectedVersion: 1 }).success,
    ).toBe(false);
  });

  it("accepts SuggestionResolveResponseSchema", () => {
    expect(
      SuggestionResolveResponseSchema.safeParse({
        suggestionId: ids.suggestionId,
        status: "accepted",
        version: 2,
      }).success,
    ).toBe(true);
  });

  it("accepts SuggestionMergeRequestSchema (bulk resolve)", () => {
    expect(
      SuggestionMergeRequestSchema.safeParse({
        suggestionIds: [ids.suggestionId],
        action: "accepted",
      }).success,
    ).toBe(true);
    // empty array => fail
    expect(
      SuggestionMergeRequestSchema.safeParse({
        suggestionIds: [],
        action: "accepted",
      }).success,
    ).toBe(false);
  });

  it("accepts SuggestionRerunRequestSchema", () => {
    expect(
      SuggestionRerunRequestSchema.safeParse({
        expenseId: ids.expenseId,
        kinds: ["tag", "spending_category"],
      }).success,
    ).toBe(true);
    // empty kinds => fail
    expect(
      SuggestionRerunRequestSchema.safeParse({
        expenseId: ids.expenseId,
        kinds: [],
      }).success,
    ).toBe(false);
  });
});
