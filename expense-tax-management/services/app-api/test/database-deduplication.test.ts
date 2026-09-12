import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../src/database/migrations/015_expense_deduplication.ts", import.meta.url),
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
    expect(migration).toMatch(/expense_dedup_fingerprints_scope_check[\s\S]*personal_profile_id IS NULL\) <> \(business_id IS NULL\)/);
    expect(migration).toMatch(/expense_duplicate_matches_scope_check[\s\S]*personal_profile_id IS NULL\) <> \(business_id IS NULL\)/);
    expect(migration).toContain("expense_sources_expense_tenant_fk");
    expect(migration).toContain("expense_sources_file_tenant_fk");
    expect(migration).toContain("expense_sources_email_tenant_fk");
    expect(migration).toContain("expense_dedup_fingerprints_expense_tenant_fk");
    expect(migration).toContain("expense_duplicate_matches_existing_expense_tenant_fk");
    expect(migration).toContain("expense_duplicate_matches_candidate_expense_tenant_fk");
    expect(migration).toContain("UNIQUE INDEX expense_files_id_tenant_unique");
    expect(migration).toContain("UNIQUE INDEX inbound_emails_id_tenant_unique");
    expect(migration).toContain("validate_expense_dedup_scope");
    expect(migration).toContain("tenant_memberships");
    expect(migration).toContain("status = 'active'");
    expect(migration).toContain("expense_sources_scope_validation_trigger");
    expect(migration).toContain("expense_dedup_fingerprints_scope_validation_trigger");
    expect(migration).toContain("expense_duplicate_matches_scope_validation_trigger");
    expect(migration).toContain("prevent_expense_dedup_parent_scope_update");
    expect(migration).toContain("expenses_dedup_parent_scope_guard_trigger");
    expect(migration).toContain("expense_files_dedup_parent_scope_guard_trigger");
    expect(migration).toContain("inbound_emails_dedup_parent_scope_guard_trigger");
  });

  it("declares status, match type, fingerprint, lookup, and idempotency constraints", () => {
    expect(migration).toMatch(/match_type IN \('file_sha256', 'fingerprint', 'fuzzy_fields'\)/);
    expect(migration).toMatch(/status IN \('pending', 'merged', 'separate', 'dismissed'\)/);
    expect(migration).toContain("amount_minor_units bigint NOT NULL");
    expect(migration).toContain("fingerprint_hash text NOT NULL");
    expect(migration).toContain("expense_duplicate_matches_candidate_lookup_index");
    expect(migration).toContain("expense_duplicate_matches_idempotency_unique");
    expect(migration).toContain("idempotency_key text NOT NULL");
    expect(migration).toContain("idempotency_key = trim(idempotency_key)");
    expect(migration).toContain("resolution_idempotency_key = trim(resolution_idempotency_key)");
    expect(migration).toContain("expense_duplicate_matches_resolution_idempotency_unique");
    expect(migration).toContain("WHERE resolution_idempotency_key IS NOT NULL");
    expect(migration).toContain("expense_duplicate_matches_pending_unique");
    expect(migration).toContain("WHERE status = 'pending'");
    expect(migration).toContain("char_length(trim(normalized_merchant)) > 0");
    expect(migration).toMatch(/status = 'pending'[\s\S]*resolution_idempotency_key IS NULL/);
    expect(migration).toMatch(/status <> 'pending'[\s\S]*resolution_idempotency_key IS NOT NULL/);
    expect(migration).toMatch(/source_type = 'manual_upload'[\s\S]*source_file_id IS NOT NULL[\s\S]*inbound_email_id IS NULL/);
    expect(migration).toMatch(/source_type = 'forwarded_email'[\s\S]*inbound_email_id IS NOT NULL/);
    expect(migration).toContain("prevent_duplicate_match_terminal_update");
    expect(migration).toContain("OLD IS DISTINCT FROM NEW");
    expect(migration).toContain("expense_duplicate_matches_terminal_guard_trigger");
  });

  it("drops migration-owned reference indexes after dependent tables", () => {
    expect(migration).toContain("DROP INDEX IF EXISTS app.expense_files_id_tenant_unique");
    expect(migration).toContain("DROP INDEX IF EXISTS app.inbound_emails_id_tenant_unique");
    expect(migration).toContain("DROP TRIGGER IF EXISTS expense_sources_scope_validation_trigger");
    expect(migration).toContain("DROP TRIGGER IF EXISTS expense_dedup_fingerprints_scope_validation_trigger");
    expect(migration).toContain("DROP TRIGGER IF EXISTS expense_duplicate_matches_scope_validation_trigger");
    expect(migration).toContain("DROP TRIGGER IF EXISTS expense_duplicate_matches_terminal_guard_trigger");
    expect(migration).toContain("DROP FUNCTION IF EXISTS app.validate_expense_dedup_scope()");
    expect(migration).toContain("DROP FUNCTION IF EXISTS app.prevent_duplicate_match_terminal_update()");
    expect(migration).toContain("DROP TRIGGER IF EXISTS expenses_dedup_parent_scope_guard_trigger");
    expect(migration).toContain("DROP TRIGGER IF EXISTS expense_files_dedup_parent_scope_guard_trigger");
    expect(migration).toContain("DROP TRIGGER IF EXISTS inbound_emails_dedup_parent_scope_guard_trigger");
    expect(migration).toContain("DROP FUNCTION IF EXISTS app.prevent_expense_dedup_parent_scope_update()");
    expect(migration).toMatch(/dropTable\("app\.expense_duplicate_matches"\)[\s\S]*dropTable\("app\.expense_dedup_fingerprints"\)[\s\S]*dropTable\("app\.expense_sources"\)/);
  });
});
