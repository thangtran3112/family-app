import { type Kysely, sql } from "kysely";

export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE app.expense_files (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
      personal_profile_id uuid,
      business_id uuid,
      expense_id uuid,
      original_filename text NOT NULL,
      content_type text NOT NULL,
      size_bytes integer,
      sha256_hex text,
      storage_key text NOT NULL,
      thumbnail_storage_key text,
      thumbnail_status text NOT NULL DEFAULT 'pending',
      status text NOT NULL DEFAULT 'PENDING',
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT expense_files_storage_key_unique UNIQUE (storage_key),
      CONSTRAINT expense_files_profile_tenant_fk
        FOREIGN KEY (personal_profile_id, tenant_id)
        REFERENCES app.personal_profiles(id, tenant_id),
      CONSTRAINT expense_files_business_tenant_fk
        FOREIGN KEY (business_id, tenant_id)
        REFERENCES app.businesses(id, tenant_id),
      CONSTRAINT expense_files_expense_fk
        FOREIGN KEY (expense_id)
        REFERENCES app.expenses(id) ON DELETE SET NULL,
      CONSTRAINT expense_files_scope_check
        CHECK ((personal_profile_id IS NULL) <> (business_id IS NULL)),
      CONSTRAINT expense_files_filename_check
        CHECK (char_length(trim(original_filename)) BETWEEN 1 AND 255),
      CONSTRAINT expense_files_content_type_check
        CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
      CONSTRAINT expense_files_size_check
        CHECK (size_bytes IS NULL OR size_bytes >= 0),
      CONSTRAINT expense_files_sha256_check
        CHECK (sha256_hex IS NULL OR sha256_hex ~ '^[a-f0-9]{64}$'),
      CONSTRAINT expense_files_status_check
        CHECK (status IN ('PENDING', 'READY', 'FAILED', 'DELETED')),
      CONSTRAINT expense_files_thumbnail_status_check
        CHECK (thumbnail_status IN ('pending', 'ready', 'skipped', 'failed')),
      CONSTRAINT expense_files_version_check CHECK (version > 0)
    )
  `.execute(database);
  await sql`
    CREATE INDEX expense_files_tenant_status_index
      ON app.expense_files (tenant_id, status, created_at DESC)
  `.execute(database);
  await sql`
    CREATE INDEX expense_files_expense_index
      ON app.expense_files (expense_id)
      WHERE expense_id IS NOT NULL
  `.execute(database);

  await sql`
    CREATE TABLE app.upload_sessions (
      id uuid PRIMARY KEY,
      expense_file_id uuid NOT NULL REFERENCES app.expense_files(id) ON DELETE CASCADE,
      status text NOT NULL DEFAULT 'PENDING',
      expires_at timestamptz NOT NULL,
      confirmed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT upload_sessions_file_unique UNIQUE (expense_file_id),
      CONSTRAINT upload_sessions_status_check
        CHECK (status IN ('PENDING', 'CONFIRMED', 'EXPIRED')),
      CONSTRAINT upload_sessions_confirmation_state_check
        CHECK (
          (status = 'CONFIRMED' AND confirmed_at IS NOT NULL)
          OR (status <> 'CONFIRMED' AND confirmed_at IS NULL)
        )
    )
  `.execute(database);
  await sql`
    CREATE INDEX upload_sessions_pending_index
      ON app.upload_sessions (expires_at)
      WHERE status = 'PENDING'
  `.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  await database.schema.dropTable("app.upload_sessions").ifExists().execute();
  await database.schema.dropTable("app.expense_files").ifExists().execute();
}
