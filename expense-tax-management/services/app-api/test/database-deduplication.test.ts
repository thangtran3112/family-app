import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../src/database/migrations/013_expense_deduplication.ts", import.meta.url),
  "utf8",
);

describe("expense deduplication migration", () => {
  it("creates provenance, fingerprint, and duplicate match tables", () => {
    expect(migration).toContain("CREATE TABLE app.expense_sources");
    expect(migration).toContain("CREATE TABLE app.expense_dedup_fingerprints");
    expect(migration).toContain("CREATE TABLE app.expense_duplicate_matches");
  });

  it("enforces tenant scope XOR and source provenance constraints", () => {
    expect(migration).toMatch(/expense_sources_scope_check[\s\S]*personal_profile_id IS NULL\) <> \(business_id IS NULL\)/);
    expect(migration).toMatch(/expense_sources_reference_check[\s\S]*source_file_id IS NOT NULL/);
    expect(migration).toMatch(/expense_dedup_fingerprints_scope_check[\s\S]*personal_profile_id IS NULL\) <> \(business_id IS NULL\)/);
    expect(migration).toMatch(/expense_duplicate_matches_scope_check[\s\S]*personal_profile_id IS NULL\) <> \(business_id IS NULL\)/);
  });

  it("declares status, match type, fingerprint, lookup, and idempotency constraints", () => {
    expect(migration).toMatch(/match_type IN \('file_sha256', 'fingerprint', 'fuzzy_fields'\)/);
    expect(migration).toMatch(/status IN \('pending', 'merged', 'separate', 'dismissed'\)/);
    expect(migration).toContain("amount_minor_units bigint NOT NULL");
    expect(migration).toContain("fingerprint_hash text NOT NULL");
    expect(migration).toContain("expense_duplicate_matches_candidate_lookup_index");
    expect(migration).toContain("expense_duplicate_matches_idempotency_unique");
    expect(migration).toContain("idempotency_key text NOT NULL");
  });
});
