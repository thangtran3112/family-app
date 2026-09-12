import { type Kysely, sql } from "kysely";

export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE UNIQUE INDEX expenses_id_tenant_unique
      ON app.expenses (id, tenant_id)
  `.execute(database);
  await sql`
    CREATE UNIQUE INDEX expense_files_id_tenant_unique
      ON app.expense_files (id, tenant_id)
  `.execute(database);
  await sql`
    CREATE UNIQUE INDEX inbound_emails_id_tenant_unique
      ON app.inbound_emails (id, tenant_id)
  `.execute(database);

  await sql`
    CREATE TABLE app.expense_sources (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
      personal_profile_id uuid,
      business_id uuid,
      expense_id uuid NOT NULL,
      source_type text NOT NULL,
      source_file_id uuid,
      inbound_email_id uuid,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT expense_sources_profile_tenant_fk
        FOREIGN KEY (personal_profile_id, tenant_id)
        REFERENCES app.personal_profiles(id, tenant_id),
      CONSTRAINT expense_sources_business_tenant_fk
        FOREIGN KEY (business_id, tenant_id)
        REFERENCES app.businesses(id, tenant_id),
      CONSTRAINT expense_sources_expense_tenant_fk
        FOREIGN KEY (expense_id, tenant_id)
        REFERENCES app.expenses(id, tenant_id) ON DELETE CASCADE,
      CONSTRAINT expense_sources_file_tenant_fk
        FOREIGN KEY (source_file_id, tenant_id)
        REFERENCES app.expense_files(id, tenant_id),
      CONSTRAINT expense_sources_email_tenant_fk
        FOREIGN KEY (inbound_email_id, tenant_id)
        REFERENCES app.inbound_emails(id, tenant_id),
      CONSTRAINT expense_sources_scope_check
        CHECK ((personal_profile_id IS NULL) <> (business_id IS NULL)),
      CONSTRAINT expense_sources_type_check
        CHECK (
          (source_type = 'manual_upload' AND source_file_id IS NOT NULL AND inbound_email_id IS NULL)
          OR (source_type = 'forwarded_email' AND inbound_email_id IS NOT NULL)
        )
    )
  `.execute(database);
  await sql`
    CREATE UNIQUE INDEX expense_sources_file_unique
      ON app.expense_sources (tenant_id, source_file_id)
      WHERE source_file_id IS NOT NULL
  `.execute(database);
  await sql`
    CREATE UNIQUE INDEX expense_sources_email_unique
      ON app.expense_sources (tenant_id, inbound_email_id)
      WHERE inbound_email_id IS NOT NULL
  `.execute(database);

  await sql`
    CREATE TABLE app.expense_dedup_fingerprints (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
      personal_profile_id uuid,
      business_id uuid,
      expense_id uuid NOT NULL,
      fingerprint_version integer NOT NULL,
      normalized_merchant text NOT NULL,
      amount_minor_units bigint NOT NULL,
      currency text NOT NULL,
      incurred_on date NOT NULL,
      fingerprint_hash text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT expense_dedup_fingerprints_profile_tenant_fk
        FOREIGN KEY (personal_profile_id, tenant_id)
        REFERENCES app.personal_profiles(id, tenant_id),
      CONSTRAINT expense_dedup_fingerprints_business_tenant_fk
        FOREIGN KEY (business_id, tenant_id)
        REFERENCES app.businesses(id, tenant_id),
      CONSTRAINT expense_dedup_fingerprints_expense_tenant_fk
        FOREIGN KEY (expense_id, tenant_id)
        REFERENCES app.expenses(id, tenant_id) ON DELETE CASCADE,
      CONSTRAINT expense_dedup_fingerprints_scope_check
        CHECK ((personal_profile_id IS NULL) <> (business_id IS NULL)),
      CONSTRAINT expense_dedup_fingerprints_version_check
        CHECK (fingerprint_version > 0),
      CONSTRAINT expense_dedup_fingerprints_amount_check
        CHECK (amount_minor_units >= 0),
      CONSTRAINT expense_dedup_fingerprints_currency_check
        CHECK (currency ~ '^[A-Z]{3}$'),
      CONSTRAINT expense_dedup_fingerprints_hash_check
        CHECK (fingerprint_hash ~ '^[a-f0-9]{64}$'),
      CONSTRAINT expense_dedup_fingerprints_expense_version_unique
        UNIQUE (expense_id, fingerprint_version)
    )
  `.execute(database);
  await sql`
    CREATE INDEX expense_dedup_fingerprints_scope_lookup_index
      ON app.expense_dedup_fingerprints
        (tenant_id, personal_profile_id, business_id, fingerprint_hash)
  `.execute(database);

  await sql`
    CREATE TABLE app.expense_duplicate_matches (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
      personal_profile_id uuid,
      business_id uuid,
      existing_expense_id uuid NOT NULL,
      candidate_expense_id uuid NOT NULL,
      match_type text NOT NULL,
      confidence numeric(5, 4) NOT NULL,
      evidence jsonb NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      version integer NOT NULL DEFAULT 1,
      resolved_by uuid REFERENCES app.users(id),
      resolved_at timestamptz,
      resolution_idempotency_key text,
      idempotency_key text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT expense_duplicate_matches_profile_tenant_fk
        FOREIGN KEY (personal_profile_id, tenant_id)
        REFERENCES app.personal_profiles(id, tenant_id),
      CONSTRAINT expense_duplicate_matches_business_tenant_fk
        FOREIGN KEY (business_id, tenant_id)
        REFERENCES app.businesses(id, tenant_id),
      CONSTRAINT expense_duplicate_matches_existing_expense_tenant_fk
        FOREIGN KEY (existing_expense_id, tenant_id)
        REFERENCES app.expenses(id, tenant_id) ON DELETE CASCADE,
      CONSTRAINT expense_duplicate_matches_candidate_expense_tenant_fk
        FOREIGN KEY (candidate_expense_id, tenant_id)
        REFERENCES app.expenses(id, tenant_id) ON DELETE CASCADE,
      CONSTRAINT expense_duplicate_matches_scope_check
        CHECK ((personal_profile_id IS NULL) <> (business_id IS NULL)),
      CONSTRAINT expense_duplicate_matches_not_self_check
        CHECK (existing_expense_id <> candidate_expense_id),
      CONSTRAINT expense_duplicate_matches_type_check
        CHECK (match_type IN ('file_sha256', 'fingerprint', 'fuzzy_fields')),
      CONSTRAINT expense_duplicate_matches_confidence_check
        CHECK (confidence BETWEEN 0 AND 1),
      CONSTRAINT expense_duplicate_matches_status_check
        CHECK (status IN ('pending', 'merged', 'separate', 'dismissed')),
      CONSTRAINT expense_duplicate_matches_version_check
        CHECK (version > 0),
      CONSTRAINT expense_duplicate_matches_idempotency_key_check
        CHECK (char_length(trim(idempotency_key)) BETWEEN 1 AND 255),
      CONSTRAINT expense_duplicate_matches_resolution_state_check
        CHECK (
          (
            status = 'pending'
            AND resolved_by IS NULL
            AND resolved_at IS NULL
            AND resolution_idempotency_key IS NULL
          )
          OR (
            status <> 'pending'
            AND resolved_by IS NOT NULL
            AND resolved_at IS NOT NULL
            AND resolution_idempotency_key IS NOT NULL
            AND char_length(trim(resolution_idempotency_key)) BETWEEN 1 AND 255
          )
        ),
      CONSTRAINT expense_duplicate_matches_idempotency_unique
        UNIQUE (tenant_id, idempotency_key)
    )
  `.execute(database);
  await sql`
    CREATE UNIQUE INDEX expense_duplicate_matches_resolution_idempotency_unique
      ON app.expense_duplicate_matches (tenant_id, resolution_idempotency_key)
      WHERE resolution_idempotency_key IS NOT NULL
  `.execute(database);
  await sql`
    CREATE UNIQUE INDEX expense_duplicate_matches_pending_unique
      ON app.expense_duplicate_matches
        (tenant_id, candidate_expense_id, existing_expense_id, match_type)
      WHERE status = 'pending'
  `.execute(database);
  await sql`
    CREATE INDEX expense_duplicate_matches_candidate_lookup_index
      ON app.expense_duplicate_matches
        (tenant_id, personal_profile_id, business_id, candidate_expense_id, status)
  `.execute(database);
  await sql`
    CREATE INDEX expense_duplicate_matches_scope_status_index
      ON app.expense_duplicate_matches
        (tenant_id, personal_profile_id, business_id, status, created_at DESC)
  `.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  await database.schema.dropTable("app.expense_duplicate_matches").ifExists().execute();
  await database.schema.dropTable("app.expense_dedup_fingerprints").ifExists().execute();
  await database.schema.dropTable("app.expense_sources").ifExists().execute();
  await sql`DROP INDEX IF EXISTS app.inbound_emails_id_tenant_unique`.execute(database);
  await sql`DROP INDEX IF EXISTS app.expense_files_id_tenant_unique`.execute(database);
  await sql`DROP INDEX IF EXISTS app.expenses_id_tenant_unique`.execute(database);
}
