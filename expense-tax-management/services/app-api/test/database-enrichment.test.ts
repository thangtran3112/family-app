/**
 * Migration 016 structural tests.
 *
 * These assert the SQL text of the migration file is well-formed and contains
 * the required spec-aligned constraints. They are supplemented by the live
 * PostgreSQL proof in the Phase 3C integration test (app-domain-3c-auto-tagging).
 *
 * An executable import is used so malformed TypeScript (e.g. a bare SQL comment
 * outside a template literal) causes a module-load error rather than silently
 * satisfying text-search assertions.
 */
import * as migration016 from "../src/database/migrations/016_expense_enrichment.js";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../src/database/migrations/016_expense_enrichment.ts", import.meta.url),
  "utf8",
);

describe("expense enrichment migration 016 – executable import", () => {
  it("exports up and down functions (module is valid TypeScript)", () => {
    expect(typeof migration016.up).toBe("function");
    expect(typeof migration016.down).toBe("function");
  });
});

describe("expense enrichment migration 016 – schema structure", () => {
  it("creates all five enrichment tables", () => {
    expect(migration).toContain("CREATE TABLE app.tags");
    expect(migration).toContain("CREATE TABLE app.expense_tags");
    expect(migration).toContain("CREATE TABLE app.expense_spending_category_decisions");
    expect(migration).toContain("CREATE TABLE app.expense_enrichment_suggestions");
    expect(migration).toContain("CREATE TABLE app.enrichment_operation_keys");
  });

  // ---- app.tags --------------------------------------------------------

  it("creates tags as tenant-level with no personal/business scope columns", () => {
    // spec: tags are tenant-level definitions, no per-scope columns.
    // Extract just the CREATE TABLE app.tags DDL block and check it has no scope columns.
    const tagsTableMatch = migration.match(/CREATE TABLE app\.tags\s*\([^;]+\)/);
    expect(tagsTableMatch).not.toBeNull();
    const tagsTable = tagsTableMatch![0];
    expect(tagsTable).not.toContain("personal_profile_id");
    expect(tagsTable).not.toContain("business_id");
  });

  it("tags use spec origin enum: custom | rule", () => {
    expect(migration).toMatch(/origin\s+IN\s*\(\s*'custom',\s*'rule'\s*\)/);
  });

  it("tags have nullable color column (no NOT NULL on color)", () => {
    // color is nullable per spec; must not have 'color text NOT NULL'
    expect(migration).not.toMatch(/color\s+text\s+NOT NULL/);
  });

  it("tags have nullable created_by_user_id (system-created rule tags)", () => {
    expect(migration).toContain("created_by_user_id");
    // must not be NOT NULL
    expect(migration).not.toMatch(/created_by_user_id\s+uuid\s+NOT NULL/);
  });

  it("tags enforce unique (tenant_id, key) across active and archived", () => {
    // spec: unique (tenant_id, key) across both statuses, no partial index
    expect(migration).toContain("tags_key_tenant_unique");
    expect(migration).toMatch(/UNIQUE\s*\(\s*tenant_id,\s*key\s*\)/);
  });

  it("tags key allows namespace colons (merchant:<slug>, timing:weekend, etc.)", () => {
    // key regex must contain colon as a permitted character
    expect(migration).toMatch(/key\s+~\s+'[^']*:[^']*/);
  });

  it("tags enforce status enum: active | archived", () => {
    expect(migration).toMatch(/status\s+IN\s*\(\s*'active',\s*'archived'\s*\)/);
  });

  it("tags enforce positive version", () => {
    expect(migration).toMatch(/version\s+>\s*0/);
  });

  // ---- app.expense_tags -----------------------------------------------

  it("expense_tags has UUID id primary key", () => {
    // spec: expense_tags has 'id' column
    expect(migration).toMatch(/CREATE TABLE app\.expense_tags[\s\S]*?id\s+uuid\s+PRIMARY KEY/);
  });

  it("expense_tags includes exactly one personal/business scope via XOR check", () => {
    expect(migration).toContain("expense_tags_scope_check");
    expect(migration).toMatch(/expense_tags_scope_check[\s\S]*personal_profile_id IS NULL\) <> \(business_id IS NULL\)/);
  });

  it("expense_tags source enum: manual | rule | historical | ai", () => {
    expect(migration).toMatch(/source\s+IN\s*\(\s*'manual',\s*'rule',\s*'historical',\s*'ai'\s*\)/);
  });

  it("expense_tags status enum: active | removed", () => {
    expect(migration).toMatch(/status\s+IN\s*\(\s*'active',\s*'removed'\s*\)/);
  });

  it("expense_tags has confidence, nullable rule_version, nullable suggestion_id", () => {
    expect(migration).toContain("confidence");
    expect(migration).toContain("rule_version");
    expect(migration).toContain("suggestion_id");
    // rule_version must be nullable (no NOT NULL)
    expect(migration).not.toMatch(/rule_version\s+integer\s+NOT NULL/);
  });

  it("expense_tags has applied_by_user_id, removed_by_user_id, applied_at, removed_at", () => {
    expect(migration).toContain("applied_by_user_id");
    expect(migration).toContain("removed_by_user_id");
    expect(migration).toContain("applied_at");
    expect(migration).toContain("removed_at");
  });

  it("expense_tags has unique (tenant_id, expense_id, tag_id) constraint", () => {
    expect(migration).toContain("expense_tags_expense_tag_unique");
    expect(migration).toMatch(/UNIQUE\s*\(\s*tenant_id,\s*expense_id,\s*tag_id\s*\)/);
  });

  it("expense_tags has composite tenant/scope/expense FK validation", () => {
    expect(migration).toContain("expense_tags_expense_tenant_fk");
    expect(migration).toContain("expense_tags_tag_tenant_fk");
  });

  // ---- app.expense_spending_category_decisions ------------------------

  it("decisions has scope fields (personal/business XOR)", () => {
    expect(migration).toContain("expense_spending_category_decisions_scope_check");
    expect(migration).toMatch(/expense_spending_category_decisions_scope_check[\s\S]*personal_profile_id IS NULL\) <> \(business_id IS NULL\)/);
  });

  it("decisions has prior_spending_category_id and new_spending_category_id (append-only, nullable)", () => {
    expect(migration).toContain("prior_spending_category_id");
    expect(migration).toContain("new_spending_category_id");
  });

  it("decisions source enum: manual | manual_baseline | historical | ai", () => {
    expect(migration).toMatch(/source\s+IN\s*\(\s*'manual',\s*'manual_baseline',\s*'historical',\s*'ai'\s*\)/);
  });

  it("decisions has nullable suggestion_id", () => {
    expect(migration).toContain("suggestion_id");
    expect(migration).not.toMatch(/suggestion_id\s+uuid\s+NOT NULL/);
  });

  it("backfills existing spending_category_id into decisions as manual_baseline", () => {
    expect(migration).toContain("manual_baseline");
    expect(migration).toMatch(/INSERT INTO app\.expense_spending_category_decisions/);
    expect(migration).toMatch(/spending_category_id IS NOT NULL/);
  });

  // ---- app.expense_enrichment_suggestions -----------------------------

  it("suggestions has exact personal/business XOR scope", () => {
    expect(migration).toContain("expense_enrichment_suggestions_scope_check");
    expect(migration).toMatch(/expense_enrichment_suggestions_scope_check[\s\S]*personal_profile_id IS NULL\) <> \(business_id IS NULL\)/);
  });

  it("suggestions source enum: historical | ai", () => {
    expect(migration).toMatch(/source\s+IN\s*\(\s*'historical',\s*'ai'\s*\)/);
  });

  it("suggestions has positive version", () => {
    expect(migration).toMatch(/expense_enrichment_suggestions_version_check[\s\S]*version\s*>\s*0/);
  });

  it("suggestions has idempotency_key, resolved_by_user_id, resolved_at", () => {
    expect(migration).toContain("idempotency_key");
    expect(migration).toContain("resolved_by_user_id");
    expect(migration).toContain("resolved_at");
  });

  it("suggestions kind enum: tag | spending_category | tax_category", () => {
    expect(migration).toMatch(/kind\s+IN\s*\(\s*'tag',\s*'spending_category',\s*'tax_category'\s*\)/);
  });

  it("suggestions candidate XOR: tag_id XOR spending_category_id XOR tax_category_definition_id", () => {
    expect(migration).toContain("expense_enrichment_suggestions_candidate_xor_check");
    expect(migration).toMatch(/tag_id IS NOT NULL[\s\S]*spending_category_id IS NULL[\s\S]*tax_category_definition_id IS NULL/);
  });

  it("suggestions tax snapshot requires Business scope and tuple when kind=tax_category", () => {
    expect(migration).toContain("expense_enrichment_suggestions_tax_snapshot_check");
    expect(migration).toMatch(/kind\s*=\s*'tax_category'[\s\S]*tax_profile_id IS NOT NULL/);
    expect(migration).toContain("taxonomy_version_id");
    expect(migration).toContain("tax_year");
    expect(migration).toContain("expense_version");
  });

  it("suggestions enforce status enum: pending | accepted | rejected | superseded", () => {
    expect(migration).toMatch(/status\s+IN\s*\(\s*'pending',\s*'accepted',\s*'rejected',\s*'superseded'\s*\)/);
  });

  it("suggestions enforce confidence 0–1", () => {
    expect(migration).toMatch(/confidence\s+BETWEEN\s+0\s+AND\s+1/);
  });

  it("suggestions enforce evidence_hash SHA-256 format", () => {
    expect(migration).toContain("evidence_hash ~ '^[a-f0-9]{64}$'");
  });

  it("suggestions enforce positive version and expense_version", () => {
    expect(migration).toMatch(/expense_enrichment_suggestions_version_check[\s\S]*version\s*>\s*0/);
    expect(migration).toMatch(/expense_version\s*>\s*0/);
  });

  it("suggestions enforce terminal immutability trigger", () => {
    expect(migration).toContain("prevent_enrichment_suggestion_terminal_update");
    expect(migration).toContain("enrichment_suggestions_terminal_guard_trigger");
    expect(migration).toMatch(/OLD\.status\s+IN\s*\(\s*'accepted',\s*'rejected',\s*'superseded'\s*\)/);
    expect(migration).toContain("terminal enrichment suggestion is immutable");
  });

  it("suggestions enforce parent scope immutability trigger", () => {
    expect(migration).toContain("prevent_enrichment_parent_scope_update");
    expect(migration).toContain("expenses_enrichment_parent_scope_guard_trigger");
  });

  it("suggestions have unique active evidence index on (tenant_id, expense_id, kind, evidence_hash) WHERE pending", () => {
    expect(migration).toContain("expense_enrichment_suggestions_active_evidence_unique");
    expect(migration).toMatch(/\(tenant_id,\s*expense_id,\s*kind,\s*evidence_hash\)/);
    expect(migration).toMatch(/WHERE\s+status\s*=\s*'pending'/);
  });

  // ---- app.enrichment_operation_keys ----------------------------------

  it("operation keys have all required columns", () => {
    expect(migration).toContain("job_id");
    expect(migration).toContain("expense_id");
    expect(migration).toContain("candidate_id");
    expect(migration).toContain("evidence_hash");
    expect(migration).toContain("operation_key");
    expect(migration).toContain("payload_hash");
    expect(migration).toContain("response_json");
  });

  it("operation keys enforce unique (tenant_id, operation_key)", () => {
    expect(migration).toContain("enrichment_operation_keys_operation_key_unique");
    expect(migration).toMatch(/UNIQUE\s*\(\s*tenant_id,\s*operation_key\s*\)/);
  });

  it("operation keys enforce UNIQUE NULLS NOT DISTINCT on composite binding", () => {
    expect(migration).toContain("UNIQUE NULLS NOT DISTINCT");
    expect(migration).toMatch(
      /UNIQUE NULLS NOT DISTINCT\s*\(\s*tenant_id,\s*job_id,\s*expense_id,\s*kind,\s*candidate_id,\s*evidence_hash,\s*operation_key\s*\)/,
    );
  });

  it("operation keys have composite FKs for job+tenant and expense+tenant", () => {
    expect(migration).toContain("enrichment_operation_keys_job_tenant_fk");
    expect(migration).toContain("enrichment_operation_keys_expense_tenant_fk");
  });

  // ---- down() ---------------------------------------------------------

  it("down() drops triggers and functions before tables in correct order", () => {
    expect(migration).toContain("DROP TRIGGER IF EXISTS enrichment_suggestions_terminal_guard_trigger");
    expect(migration).toContain("DROP TRIGGER IF EXISTS expenses_enrichment_parent_scope_guard_trigger");
    expect(migration).toContain("DROP FUNCTION IF EXISTS app.prevent_enrichment_suggestion_terminal_update()");
    expect(migration).toContain("DROP FUNCTION IF EXISTS app.prevent_enrichment_parent_scope_update()");
    expect(migration).toMatch(/dropTable\("app\.enrichment_operation_keys"\)/);
    expect(migration).toMatch(/dropTable\("app\.expense_enrichment_suggestions"\)/);
    expect(migration).toMatch(/dropTable\("app\.expense_spending_category_decisions"\)/);
    expect(migration).toMatch(/dropTable\("app\.expense_tags"\)/);
    expect(migration).toMatch(/dropTable\("app\.tags"\)/);
  });
});
