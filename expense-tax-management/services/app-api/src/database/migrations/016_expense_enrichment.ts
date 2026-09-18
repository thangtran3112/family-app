import { type Kysely, sql } from "kysely";

export async function up(database: Kysely<unknown>): Promise<void> {
  // ------------------------------------------------------------------ //
  // Supporting unique indexes on parent tables needed for composite FKs.
  // These are created AFTER the tables they index already exist.
  // ------------------------------------------------------------------ //
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS expenses_id_tenant_unique
      ON app.expenses (id, tenant_id)
  `.execute(database);
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS processing_jobs_id_tenant_unique
      ON app.processing_jobs (id, tenant_id)
  `.execute(database);
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS business_tax_profiles_id_tenant_unique
      ON app.business_tax_profiles (id, tenant_id)
  `.execute(database);

  // ------------------------------------------------------------------ //
  // app.tags
  //
  // Tenant-level tag definitions. Tags have NO personal/business scope:
  // they belong to the tenant and can be applied to any expense in scope.
  //
  // origin: 'custom' (created by users) | 'rule' (system-created).
  // Unique (tenant_id, key) across ALL statuses: reusing an archived key
  // requires explicit unarchive; rules never silently reactivate a key.
  // color is nullable (rule tags may have none).
  // created_by_user_id is nullable (system-created rule tags have no actor).
  // ------------------------------------------------------------------ //
  await sql`
    CREATE TABLE app.tags (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
      key text NOT NULL,
      name text NOT NULL,
      color text,
      origin text NOT NULL DEFAULT 'custom',
      status text NOT NULL DEFAULT 'active',
      version integer NOT NULL DEFAULT 1,
      created_by_user_id uuid REFERENCES app.users(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT tags_key_check
        CHECK (key = lower(trim(key)) AND char_length(key) BETWEEN 1 AND 100
          AND key ~ '^[a-z0-9_:.-]+$'),
      CONSTRAINT tags_name_check
        CHECK (char_length(trim(name)) BETWEEN 1 AND 100),
      CONSTRAINT tags_color_check
        CHECK (color IS NULL OR color ~ '^#[0-9A-Fa-f]{6}$'),
      CONSTRAINT tags_status_check
        CHECK (status IN ('active', 'archived')),
      CONSTRAINT tags_origin_check
        CHECK (origin IN ('custom', 'rule')),
      CONSTRAINT tags_version_check
        CHECK (version > 0),
      CONSTRAINT tags_key_tenant_unique
        UNIQUE (tenant_id, key)
    )
  `.execute(database);
  await sql`
    CREATE UNIQUE INDEX tags_id_tenant_unique
      ON app.tags (id, tenant_id)
  `.execute(database);
  await sql`
    CREATE INDEX tags_scope_lookup_index
      ON app.tags (tenant_id, status)
  `.execute(database);

  // ------------------------------------------------------------------ //
  // app.expense_tags
  //
  // One row per expense/tag decision. Exactly one personal_profile_id OR
  // business_id per row. A removed row is retained so rule evidence cannot
  // recreate a user-rejected tag unchanged.
  //
  // source: 'manual' | 'rule' | 'historical' | 'ai'
  // status: 'active' | 'removed'
  // ------------------------------------------------------------------ //
  await sql`
    CREATE TABLE app.expense_tags (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
      personal_profile_id uuid,
      business_id uuid,
      expense_id uuid NOT NULL,
      tag_id uuid NOT NULL,
      source text NOT NULL,
      confidence numeric(5, 4) NOT NULL,
      rule_version integer,
      suggestion_id uuid,
      status text NOT NULL DEFAULT 'active',
      version integer NOT NULL DEFAULT 1,
      applied_by_user_id uuid REFERENCES app.users(id),
      removed_by_user_id uuid REFERENCES app.users(id),
      applied_at timestamptz,
      removed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT expense_tags_profile_tenant_fk
        FOREIGN KEY (personal_profile_id, tenant_id)
        REFERENCES app.personal_profiles(id, tenant_id),
      CONSTRAINT expense_tags_business_tenant_fk
        FOREIGN KEY (business_id, tenant_id)
        REFERENCES app.businesses(id, tenant_id),
      CONSTRAINT expense_tags_expense_tenant_fk
        FOREIGN KEY (expense_id, tenant_id)
        REFERENCES app.expenses(id, tenant_id) ON DELETE CASCADE,
      CONSTRAINT expense_tags_tag_tenant_fk
        FOREIGN KEY (tag_id, tenant_id)
        REFERENCES app.tags(id, tenant_id),
      CONSTRAINT expense_tags_scope_check
        CHECK ((personal_profile_id IS NULL) <> (business_id IS NULL)),
      CONSTRAINT expense_tags_source_check
        CHECK (source IN ('manual', 'rule', 'historical', 'ai')),
      CONSTRAINT expense_tags_status_check
        CHECK (status IN ('active', 'removed')),
      CONSTRAINT expense_tags_confidence_check
        CHECK (confidence BETWEEN 0 AND 1),
      CONSTRAINT expense_tags_rule_version_check
        CHECK (rule_version IS NULL OR rule_version > 0),
      CONSTRAINT expense_tags_version_check
        CHECK (version > 0),
      CONSTRAINT expense_tags_expense_tag_unique
        UNIQUE (tenant_id, expense_id, tag_id)
    )
  `.execute(database);
  await sql`
    CREATE INDEX expense_tags_expense_lookup_index
      ON app.expense_tags (tenant_id, expense_id, status)
  `.execute(database);
  await sql`
    CREATE INDEX expense_tags_tag_lookup_index
      ON app.expense_tags (tenant_id, tag_id)
  `.execute(database);

  // ------------------------------------------------------------------ //
  // app.expense_spending_category_decisions  (append-only)
  //
  // Records every category assignment change. Exactly one scope per row.
  // source: 'manual' | 'manual_baseline' | 'historical' | 'ai'
  //
  // Backfill: every non-null expenses.spending_category_id becomes a
  // manual_baseline decision using the expense created_by_user_id and version.
  // ------------------------------------------------------------------ //
  await sql`
    CREATE TABLE app.expense_spending_category_decisions (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
      personal_profile_id uuid,
      business_id uuid,
      expense_id uuid NOT NULL,
      prior_spending_category_id uuid,
      new_spending_category_id uuid,
      source text NOT NULL,
      actor_user_id uuid REFERENCES app.users(id),
      expense_version integer NOT NULL,
      suggestion_id uuid,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT expense_spending_category_decisions_profile_tenant_fk
        FOREIGN KEY (personal_profile_id, tenant_id)
        REFERENCES app.personal_profiles(id, tenant_id),
      CONSTRAINT expense_spending_category_decisions_business_tenant_fk
        FOREIGN KEY (business_id, tenant_id)
        REFERENCES app.businesses(id, tenant_id),
      CONSTRAINT expense_spending_category_decisions_expense_tenant_fk
        FOREIGN KEY (expense_id, tenant_id)
        REFERENCES app.expenses(id, tenant_id) ON DELETE CASCADE,
      CONSTRAINT expense_spending_category_decisions_scope_check
        CHECK ((personal_profile_id IS NULL) <> (business_id IS NULL)),
      CONSTRAINT expense_spending_category_decisions_source_check
        CHECK (source IN ('manual', 'manual_baseline', 'historical', 'ai')),
      CONSTRAINT expense_spending_category_decisions_expense_version_check
        CHECK (expense_version > 0)
    )
  `.execute(database);
  await sql`
    CREATE INDEX expense_spending_category_decisions_expense_index
      ON app.expense_spending_category_decisions (tenant_id, expense_id, created_at DESC)
  `.execute(database);
  await sql`
    INSERT INTO app.expense_spending_category_decisions
      (id, tenant_id, personal_profile_id, business_id, expense_id,
       prior_spending_category_id, new_spending_category_id,
       source, actor_user_id, expense_version, created_at)
    SELECT
      gen_random_uuid(),
      e.tenant_id,
      e.personal_profile_id,
      e.business_id,
      e.id,
      NULL,
      e.spending_category_id,
      'manual_baseline',
      e.created_by_user_id,
      e.version,
      e.created_at
    FROM app.expenses e
    WHERE e.spending_category_id IS NOT NULL
  `.execute(database);

  // ------------------------------------------------------------------ //
  // app.expense_enrichment_suggestions
  //
  // One row per pending or resolved suggestion. Exactly one personal/business
  // scope per row. Candidate column XOR by kind.
  // Tax suggestions additionally require business scope and a tax profile/
  // taxonomy/year tuple.
  //
  // source: 'historical' | 'ai'
  // status: 'pending' | 'accepted' | 'rejected' | 'superseded'
  //
  // Terminal (accepted/rejected/superseded) rows are immutable via trigger.
  // ------------------------------------------------------------------ //
  await sql`
    CREATE TABLE app.expense_enrichment_suggestions (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
      personal_profile_id uuid,
      business_id uuid,
      expense_id uuid NOT NULL,
      job_id uuid NOT NULL,
      kind text NOT NULL,
      tag_id uuid,
      spending_category_id uuid,
      tax_category_definition_id uuid,
      tax_profile_id uuid,
      taxonomy_version_id uuid,
      tax_year integer,
      source text NOT NULL,
      confidence numeric(5, 4) NOT NULL,
      evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
      evidence_hash text NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      version integer NOT NULL DEFAULT 1,
      expense_version integer NOT NULL,
      idempotency_key text NOT NULL,
      resolved_by_user_id uuid REFERENCES app.users(id),
      resolved_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT expense_enrichment_suggestions_profile_tenant_fk
        FOREIGN KEY (personal_profile_id, tenant_id)
        REFERENCES app.personal_profiles(id, tenant_id),
      CONSTRAINT expense_enrichment_suggestions_business_tenant_fk
        FOREIGN KEY (business_id, tenant_id)
        REFERENCES app.businesses(id, tenant_id),
      CONSTRAINT expense_enrichment_suggestions_expense_tenant_fk
        FOREIGN KEY (expense_id, tenant_id)
        REFERENCES app.expenses(id, tenant_id) ON DELETE CASCADE,
      CONSTRAINT expense_enrichment_suggestions_job_tenant_fk
        FOREIGN KEY (job_id, tenant_id)
        REFERENCES app.processing_jobs(id, tenant_id),
      CONSTRAINT expense_enrichment_suggestions_tax_profile_tenant_fk
        FOREIGN KEY (tax_profile_id, tenant_id)
        REFERENCES app.business_tax_profiles(id, tenant_id),
      CONSTRAINT expense_enrichment_suggestions_taxonomy_fk
        FOREIGN KEY (taxonomy_version_id)
        REFERENCES app.taxonomy_versions(id),
      CONSTRAINT expense_enrichment_suggestions_tax_category_fk
        FOREIGN KEY (tax_category_definition_id)
        REFERENCES app.tax_category_definitions(id),
      CONSTRAINT expense_enrichment_suggestions_scope_check
        CHECK ((personal_profile_id IS NULL) <> (business_id IS NULL)),
      CONSTRAINT expense_enrichment_suggestions_kind_check
        CHECK (kind IN ('tag', 'spending_category', 'tax_category')),
      CONSTRAINT expense_enrichment_suggestions_source_check
        CHECK (source IN ('historical', 'ai')),
      CONSTRAINT expense_enrichment_suggestions_status_check
        CHECK (status IN ('pending', 'accepted', 'rejected', 'superseded')),
      CONSTRAINT expense_enrichment_suggestions_confidence_check
        CHECK (confidence BETWEEN 0 AND 1),
      CONSTRAINT expense_enrichment_suggestions_version_check
        CHECK (version > 0),
      CONSTRAINT expense_enrichment_suggestions_expense_version_check
        CHECK (expense_version > 0),
      CONSTRAINT expense_enrichment_suggestions_evidence_hash_check
        CHECK (evidence_hash ~ '^[a-f0-9]{64}$'),
      CONSTRAINT expense_enrichment_suggestions_idempotency_key_check
        CHECK (char_length(trim(idempotency_key)) BETWEEN 1 AND 255),
      CONSTRAINT expense_enrichment_suggestions_candidate_xor_check
        CHECK (
          (kind = 'tag' AND tag_id IS NOT NULL AND spending_category_id IS NULL AND tax_category_definition_id IS NULL)
          OR (kind = 'spending_category' AND spending_category_id IS NOT NULL AND tag_id IS NULL AND tax_category_definition_id IS NULL)
          OR (kind = 'tax_category' AND tax_category_definition_id IS NOT NULL AND tag_id IS NULL AND spending_category_id IS NULL)
        ),
      CONSTRAINT expense_enrichment_suggestions_tax_snapshot_check
        CHECK (
          (kind = 'tax_category' AND tax_profile_id IS NOT NULL AND business_id IS NOT NULL
            AND taxonomy_version_id IS NOT NULL AND tax_year IS NOT NULL)
          OR (kind <> 'tax_category' AND tax_profile_id IS NULL
            AND taxonomy_version_id IS NULL AND tax_year IS NULL)
        ),
      CONSTRAINT expense_enrichment_suggestions_tax_year_check
        CHECK (tax_year IS NULL OR (tax_year >= 1900 AND tax_year <= 9999)),
      CONSTRAINT expense_enrichment_suggestions_resolution_check
        CHECK (
          (status = 'pending' AND resolved_by_user_id IS NULL AND resolved_at IS NULL)
          OR (status IN ('accepted', 'rejected', 'superseded') AND resolved_by_user_id IS NOT NULL AND resolved_at IS NOT NULL)
        )
    )
  `.execute(database);
  await sql`
    CREATE UNIQUE INDEX expense_enrichment_suggestions_active_evidence_unique
      ON app.expense_enrichment_suggestions (tenant_id, expense_id, kind, evidence_hash)
      WHERE status = 'pending'
  `.execute(database);
  await sql`
    CREATE INDEX expense_enrichment_suggestions_pending_lookup_index
      ON app.expense_enrichment_suggestions (tenant_id, expense_id, kind, status)
  `.execute(database);

  await sql`
    CREATE OR REPLACE FUNCTION app.prevent_enrichment_suggestion_terminal_update()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      IF OLD.status IN ('accepted', 'rejected', 'superseded') AND OLD IS DISTINCT FROM NEW THEN
        RAISE EXCEPTION 'terminal enrichment suggestion is immutable';
      END IF;
      RETURN NEW;
    END;
    $function$;
  `.execute(database);
  await sql`
    CREATE TRIGGER enrichment_suggestions_terminal_guard_trigger
      BEFORE UPDATE ON app.expense_enrichment_suggestions
      FOR EACH ROW EXECUTE FUNCTION app.prevent_enrichment_suggestion_terminal_update()
  `.execute(database);

  await sql`
    CREATE OR REPLACE FUNCTION app.prevent_enrichment_parent_scope_update()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      IF OLD.tenant_id IS NOT DISTINCT FROM NEW.tenant_id
        AND OLD.personal_profile_id IS NOT DISTINCT FROM NEW.personal_profile_id
        AND OLD.business_id IS NOT DISTINCT FROM NEW.business_id THEN
        RETURN NEW;
      END IF;

      IF EXISTS (
        SELECT 1 FROM app.expense_enrichment_suggestions WHERE expense_id = OLD.id
      ) OR EXISTS (
        SELECT 1 FROM app.expense_spending_category_decisions WHERE expense_id = OLD.id
      ) OR EXISTS (
        SELECT 1 FROM app.expense_tags WHERE expense_id = OLD.id
      ) THEN
        RAISE EXCEPTION 'referenced expense scope is immutable once enrichment data exists';
      END IF;

      RETURN NEW;
    END;
    $function$;
  `.execute(database);
  await sql`
    CREATE TRIGGER expenses_enrichment_parent_scope_guard_trigger
      BEFORE UPDATE OF tenant_id, personal_profile_id, business_id ON app.expenses
      FOR EACH ROW EXECUTE FUNCTION app.prevent_enrichment_parent_scope_update()
  `.execute(database);

  // ------------------------------------------------------------------ //
  // app.enrichment_operation_keys  (permanent replay / conflict dedup)
  //
  // Identical replay (same composite binding + payload_hash) returns stored
  // response_json. Same operation_key with different binding or payload_hash
  // is a permanent conflict.
  //
  // PostgreSQL 17: UNIQUE NULLS NOT DISTINCT ensures two rows with identical
  // binding and candidate_id IS NULL both collide (standard UNIQUE would
  // treat NULL != NULL and allow duplicates).
  // ------------------------------------------------------------------ //
  await sql`
    CREATE TABLE app.enrichment_operation_keys (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
      job_id uuid NOT NULL,
      expense_id uuid NOT NULL,
      kind text NOT NULL,
      candidate_id uuid,
      evidence_hash text NOT NULL,
      operation_key text NOT NULL,
      payload_hash text NOT NULL,
      response_json jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT enrichment_operation_keys_job_tenant_fk
        FOREIGN KEY (job_id, tenant_id)
        REFERENCES app.processing_jobs(id, tenant_id),
      CONSTRAINT enrichment_operation_keys_expense_tenant_fk
        FOREIGN KEY (expense_id, tenant_id)
        REFERENCES app.expenses(id, tenant_id) ON DELETE CASCADE,
      CONSTRAINT enrichment_operation_keys_kind_check
        CHECK (kind IN ('tag', 'spending_category', 'tax_category')),
      CONSTRAINT enrichment_operation_keys_evidence_hash_check
        CHECK (evidence_hash ~ '^[a-f0-9]{64}$'),
      CONSTRAINT enrichment_operation_keys_payload_hash_check
        CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
      CONSTRAINT enrichment_operation_keys_operation_key_unique
        UNIQUE (tenant_id, operation_key),
      CONSTRAINT enrichment_operation_keys_composite_binding_unique
        UNIQUE NULLS NOT DISTINCT (tenant_id, job_id, expense_id, kind, candidate_id, evidence_hash, operation_key)
    )
  `.execute(database);
  await sql`
    CREATE INDEX enrichment_operation_keys_lookup_index
      ON app.enrichment_operation_keys (tenant_id, job_id, expense_id, kind)
  `.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS expenses_enrichment_parent_scope_guard_trigger ON app.expenses`.execute(database);
  await sql`DROP TRIGGER IF EXISTS enrichment_suggestions_terminal_guard_trigger ON app.expense_enrichment_suggestions`.execute(database);
  await sql`DROP FUNCTION IF EXISTS app.prevent_enrichment_suggestion_terminal_update()`.execute(database);
  await sql`DROP FUNCTION IF EXISTS app.prevent_enrichment_parent_scope_update()`.execute(database);
  await database.schema.dropTable("app.enrichment_operation_keys").ifExists().execute();
  await database.schema.dropTable("app.expense_enrichment_suggestions").ifExists().execute();
  await database.schema.dropTable("app.expense_spending_category_decisions").ifExists().execute();
  await database.schema.dropTable("app.expense_tags").ifExists().execute();
  await database.schema.dropTable("app.tags").ifExists().execute();
  await sql`DROP INDEX IF EXISTS app.business_tax_profiles_id_tenant_unique`.execute(database);
  await sql`DROP INDEX IF EXISTS app.processing_jobs_id_tenant_unique`.execute(database);
  await sql`DROP INDEX IF EXISTS app.expenses_id_tenant_unique`.execute(database);
}
