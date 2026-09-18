import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../src/database/migrations/016_expense_enrichment.ts", import.meta.url),
  "utf8",
);

describe("expense enrichment migration 016", () => {
  it("creates all five enrichment tables", () => {
    expect(migration).toContain("CREATE TABLE app.tags");
    expect(migration).toContain("CREATE TABLE app.expense_tags");
    expect(migration).toContain("CREATE TABLE app.expense_spending_category_decisions");
    expect(migration).toContain("CREATE TABLE app.expense_enrichment_suggestions");
    expect(migration).toContain("CREATE TABLE app.enrichment_operation_keys");
  });

  it("enforces tag key uniqueness across active/archived via conditional unique index", () => {
    // active tag: unique (tenant_id, key) where status = 'active'
    expect(migration).toContain("tags_active_key_unique");
    expect(migration).toMatch(/WHERE\s+status\s*=\s*'active'/);
    // status bound
    expect(migration).toMatch(/status\s+IN\s*\(\s*'active',\s*'archived'\s*\)/);
  });

  it("enforces XOR scope check on tags (personal XOR business)", () => {
    expect(migration).toMatch(/tags_scope_check[\s\S]*personal_profile_id IS NULL\) <> \(business_id IS NULL\)/);
  });

  it("enforces composite tenant FKs on tags, expense_tags, decisions, and suggestions", () => {
    expect(migration).toContain("tags_profile_tenant_fk");
    expect(migration).toContain("tags_business_tenant_fk");
    expect(migration).toContain("expense_tags_tag_tenant_fk");
    expect(migration).toContain("expense_tags_expense_tenant_fk");
    expect(migration).toContain("expense_spending_category_decisions_expense_tenant_fk");
    expect(migration).toContain("expense_enrichment_suggestions_expense_tenant_fk");
    expect(migration).toContain("expense_enrichment_suggestions_job_tenant_fk");
  });

  it("enforces suggestion source/status bounds", () => {
    expect(migration).toMatch(/origin\s+IN\s*\(\s*'ai',\s*'manual_baseline'\s*\)/);
    expect(migration).toMatch(/status\s+IN\s*\(\s*'pending',\s*'accepted',\s*'rejected',\s*'superseded'\s*\)/);
    expect(migration).toMatch(/confidence\s+BETWEEN\s+0\s+AND\s+1/);
  });

  it("enforces version check and evidence_hash format on suggestions", () => {
    expect(migration).toMatch(/worker_schema_version\s+>\s*0/);
    expect(migration).toContain("evidence_hash ~ '^[a-f0-9]{64}$'");
  });

  it("enforces kind-specific candidate XOR on suggestions (tag XOR category XOR tax_category)", () => {
    // kind enum
    expect(migration).toMatch(/kind\s+IN\s*\(\s*'tag',\s*'spending_category',\s*'tax_category'\s*\)/);
    // XOR candidate check: exactly one of tag_id, spending_category_id, tax_category_definition_id
    expect(migration).toContain("expense_enrichment_suggestions_candidate_xor_check");
    expect(migration).toMatch(/tag_id IS NOT NULL[\s\S]*spending_category_id IS NULL[\s\S]*tax_category_definition_id IS NULL/);
  });

  it("enforces Business-only tax tuple (tax_category suggestions require business_id, profile snapshot)", () => {
    expect(migration).toContain("expense_enrichment_suggestions_tax_snapshot_check");
    expect(migration).toMatch(/kind\s*=\s*'tax_category'[\s\S]*business_tax_profile_id IS NOT NULL/);
    expect(migration).toContain("business_tax_profile_version");
    expect(migration).toContain("taxonomy_version_id");
    expect(migration).toContain("tax_year");
    expect(migration).toContain("tax_category_definition_id");
    expect(migration).toContain("expense_version");
  });

  it("includes composite validation FKs for tax suggestions (profile, taxonomy, category)", () => {
    expect(migration).toContain("expense_enrichment_suggestions_profile_tenant_fk");
    expect(migration).toContain("expense_enrichment_suggestions_taxonomy_fk");
    expect(migration).toContain("expense_enrichment_suggestions_tax_category_fk");
  });

  it("enforces immutability of terminal suggestions via trigger", () => {
    expect(migration).toContain("prevent_enrichment_suggestion_terminal_update");
    expect(migration).toContain("enrichment_suggestions_terminal_guard_trigger");
    expect(migration).toMatch(/OLD\.status\s+IN\s*\(\s*'accepted',\s*'rejected',\s*'superseded'\s*\)/);
    expect(migration).toContain("terminal enrichment suggestion is immutable");
  });

  it("enforces parent scope immutability trigger for enrichment children", () => {
    expect(migration).toContain("prevent_enrichment_parent_scope_update");
    expect(migration).toContain("expenses_enrichment_parent_scope_guard_trigger");
  });

  it("enforces unique active evidence hash per expense/kind (pending suggestions)", () => {
    expect(migration).toContain("expense_enrichment_suggestions_active_evidence_unique");
    expect(migration).toMatch(/WHERE\s+status\s*=\s*'pending'/);
    expect(migration).toMatch(/\(tenant_id,\s*expense_id,\s*kind,\s*evidence_hash\)/);
  });

  it("includes enrichment_operation_keys with all required columns", () => {
    expect(migration).toContain("tenant_id");
    expect(migration).toContain("job_id");
    expect(migration).toContain("expense_id");
    expect(migration).toContain("candidate_id");
    expect(migration).toContain("evidence_hash");
    expect(migration).toContain("operation_key");
    expect(migration).toContain("payload_hash");
    expect(migration).toContain("response_json");
  });

  it("enforces unique (tenant_id, operation_key) on enrichment_operation_keys", () => {
    expect(migration).toContain("enrichment_operation_keys_operation_key_unique");
    expect(migration).toMatch(/UNIQUE\s*\(\s*tenant_id,\s*operation_key\s*\)/);
  });

  it("enforces UNIQUE NULLS NOT DISTINCT on composite candidate binding", () => {
    expect(migration).toContain("UNIQUE NULLS NOT DISTINCT");
    expect(migration).toMatch(/UNIQUE NULLS NOT DISTINCT\s*\(\s*tenant_id,\s*job_id,\s*expense_id,\s*kind,\s*candidate_id,\s*evidence_hash,\s*operation_key\s*\)/);
  });

  it("enforces composite FK for tenant/job/expense on enrichment_operation_keys", () => {
    expect(migration).toContain("enrichment_operation_keys_job_tenant_fk");
    expect(migration).toContain("enrichment_operation_keys_expense_tenant_fk");
  });

  it("backfills existing spending_category_id into expense_spending_category_decisions as manual_baseline", () => {
    expect(migration).toContain("manual_baseline");
    expect(migration).toMatch(/INSERT INTO app\.expense_spending_category_decisions/);
    expect(migration).toMatch(/spending_category_id IS NOT NULL/);
  });

  it("decisions table has source, actor, expense_version columns", () => {
    expect(migration).toContain("source");
    expect(migration).toContain("actor_user_id");
    expect(migration).toContain("expense_version");
  });

  it("decisions table enforces source enum", () => {
    expect(migration).toMatch(/source\s+IN\s*\(\s*'ai',\s*'manual_baseline',\s*'manual_user'\s*\)/);
  });

  it("creates indexes for scope/merchant/history, active tags, pending suggestions, and permanent operation lookup", () => {
    expect(migration).toContain("tags_scope_lookup_index");
    expect(migration).toContain("expense_enrichment_suggestions_pending_lookup_index");
    expect(migration).toContain("enrichment_operation_keys_lookup_index");
  });

  it("drops triggers and functions before tables in down()", () => {
    expect(migration).toContain("DROP TRIGGER IF EXISTS enrichment_suggestions_terminal_guard_trigger");
    expect(migration).toContain("DROP TRIGGER IF EXISTS expenses_enrichment_parent_scope_guard_trigger");
    expect(migration).toContain("DROP FUNCTION IF EXISTS app.prevent_enrichment_suggestion_terminal_update()");
    expect(migration).toContain("DROP FUNCTION IF EXISTS app.prevent_enrichment_parent_scope_update()");
    expect(migration).toMatch(/dropTable\("app\.expense_enrichment_suggestions"\)/);
    expect(migration).toMatch(/dropTable\("app\.expense_spending_category_decisions"\)/);
    expect(migration).toMatch(/dropTable\("app\.expense_tags"\)/);
    expect(migration).toMatch(/dropTable\("app\.tags"\)/);
    expect(migration).toMatch(/dropTable\("app\.enrichment_operation_keys"\)/);
  });
});
