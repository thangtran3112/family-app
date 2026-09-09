import { type Kysely, sql } from "kysely";

export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE app.export_bundles (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
      business_id uuid NOT NULL,
      tax_year integer NOT NULL,
      taxonomy_version_id uuid NOT NULL REFERENCES app.taxonomy_versions(id) ON DELETE RESTRICT,
      profile_id uuid NOT NULL,
      profile_status text NOT NULL,
      filters jsonb NOT NULL,
      manifest jsonb NOT NULL,
      csv_storage_key text NOT NULL,
      manifest_storage_key text NOT NULL,
      mapping_storage_key text NOT NULL,
      expense_count integer NOT NULL,
      created_by_user_id uuid NOT NULL REFERENCES app.users(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT export_bundles_business_tenant_fk
        FOREIGN KEY (business_id, tenant_id)
        REFERENCES app.businesses(id, tenant_id) ON DELETE CASCADE,
      CONSTRAINT export_bundles_tax_year_check
        CHECK (tax_year BETWEEN 1900 AND 9999),
      CONSTRAINT export_bundles_csv_key_unique UNIQUE (csv_storage_key),
      CONSTRAINT export_bundles_manifest_key_unique UNIQUE (manifest_storage_key),
      CONSTRAINT export_bundles_mapping_key_unique UNIQUE (mapping_storage_key),
      CONSTRAINT export_bundles_expense_count_check CHECK (expense_count >= 0)
    )
  `.execute(database);
  await sql`
    CREATE INDEX export_bundles_business_created_index
      ON app.export_bundles (business_id, created_at DESC, id DESC)
  `.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  await database.schema.dropTable("app.export_bundles").ifExists().execute();
}
