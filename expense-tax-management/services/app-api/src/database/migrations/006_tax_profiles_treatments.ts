import { type Kysely, sql } from "kysely";

export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE app.expenses
      ADD CONSTRAINT expenses_id_tenant_business_year_unique
      UNIQUE (id, tenant_id, business_id, tax_year)
  `.execute(database);

  await sql`
    CREATE TABLE app.business_tax_profiles (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL,
      business_id uuid NOT NULL,
      tax_year integer NOT NULL,
      taxonomy_version_id uuid NOT NULL,
      tax_form text NOT NULL DEFAULT 'schedule_c',
      accounting_method text NOT NULL,
      status text NOT NULL DEFAULT 'draft',
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT business_tax_profiles_business_tenant_fk
        FOREIGN KEY (business_id, tenant_id)
        REFERENCES app.businesses(id, tenant_id) ON DELETE CASCADE,
      CONSTRAINT business_tax_profiles_taxonomy_year_fk
        FOREIGN KEY (taxonomy_version_id, tax_year)
        REFERENCES app.taxonomy_versions(id, tax_year),
      CONSTRAINT business_tax_profiles_id_scope_year_unique
        UNIQUE (id, tenant_id, business_id, tax_year),
      CONSTRAINT business_tax_profiles_business_year_unique
        UNIQUE (business_id, tax_year),
      CONSTRAINT business_tax_profiles_tax_form_check
        CHECK (tax_form = 'schedule_c'),
      CONSTRAINT business_tax_profiles_accounting_method_check
        CHECK (accounting_method IN ('cash', 'accrual')),
      CONSTRAINT business_tax_profiles_status_check
        CHECK (status IN ('draft', 'active', 'closed')),
      CONSTRAINT business_tax_profiles_version_check CHECK (version > 0)
    )
  `.execute(database);
  await sql`
    CREATE INDEX business_tax_profiles_tenant_business_index
      ON app.business_tax_profiles (tenant_id, business_id, tax_year)
  `.execute(database);

  await sql`
    CREATE TABLE app.expense_tax_treatments (
      expense_id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL,
      business_id uuid NOT NULL,
      tax_year integer NOT NULL,
      business_tax_profile_id uuid NOT NULL,
      taxonomy_version_id uuid NOT NULL,
      tax_category_definition_id uuid NOT NULL,
      deductible_percent numeric(5, 2) NOT NULL,
      review_status text NOT NULL DEFAULT 'unreviewed',
      note text,
      version integer NOT NULL DEFAULT 1,
      created_by_user_id uuid NOT NULL REFERENCES app.users(id),
      updated_by_user_id uuid NOT NULL REFERENCES app.users(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT expense_tax_treatments_expense_fk
        FOREIGN KEY (expense_id, tenant_id, business_id, tax_year)
        REFERENCES app.expenses(id, tenant_id, business_id, tax_year)
        ON DELETE CASCADE,
      CONSTRAINT expense_tax_treatments_profile_fk
        FOREIGN KEY (business_tax_profile_id, tenant_id, business_id, tax_year)
        REFERENCES app.business_tax_profiles(id, tenant_id, business_id, tax_year),
      CONSTRAINT expense_tax_treatments_taxonomy_fk
        FOREIGN KEY (taxonomy_version_id, tax_year)
        REFERENCES app.taxonomy_versions(id, tax_year),
      CONSTRAINT expense_tax_treatments_category_fk
        FOREIGN KEY (tax_category_definition_id, taxonomy_version_id)
        REFERENCES app.tax_category_definitions(id, taxonomy_version_id),
      CONSTRAINT expense_tax_treatments_percent_check
        CHECK (deductible_percent BETWEEN 0 AND 100),
      CONSTRAINT expense_tax_treatments_review_status_check
        CHECK (review_status IN ('unreviewed', 'reviewed', 'excluded')),
      CONSTRAINT expense_tax_treatments_note_check
        CHECK (note IS NULL OR char_length(note) <= 2000),
      CONSTRAINT expense_tax_treatments_version_check CHECK (version > 0)
    )
  `.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  await database.schema.dropTable("app.expense_tax_treatments").ifExists().execute();
  await database.schema.dropTable("app.business_tax_profiles").ifExists().execute();
  await sql`
    ALTER TABLE app.expenses
      DROP CONSTRAINT IF EXISTS expenses_id_tenant_business_year_unique
  `.execute(database);
}
