import { type Kysely, sql } from "kysely";

export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE app.projects
      ADD CONSTRAINT projects_id_tenant_business_unique
      UNIQUE (id, tenant_id, business_id)
  `.execute(database);

  await sql`
    CREATE TABLE app.taxonomy_versions (
      id uuid PRIMARY KEY,
      jurisdiction_code text NOT NULL,
      tax_year integer NOT NULL,
      code text NOT NULL,
      name text NOT NULL,
      status text NOT NULL DEFAULT 'active',
      source_url text NOT NULL,
      source_revision text NOT NULL,
      source_checksum text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT taxonomy_versions_jurisdiction_check
        CHECK (jurisdiction_code = 'US-FEDERAL'),
      CONSTRAINT taxonomy_versions_tax_year_check
        CHECK (tax_year BETWEEN 1900 AND 9999),
      CONSTRAINT taxonomy_versions_code_check
        CHECK (char_length(trim(code)) BETWEEN 1 AND 100),
      CONSTRAINT taxonomy_versions_name_check
        CHECK (char_length(trim(name)) BETWEEN 1 AND 200),
      CONSTRAINT taxonomy_versions_status_check
        CHECK (status IN ('active', 'superseded')),
      CONSTRAINT taxonomy_versions_source_checksum_check
        CHECK (source_checksum ~ '^[a-f0-9]{64}$'),
      CONSTRAINT taxonomy_versions_year_unique
        UNIQUE (jurisdiction_code, tax_year, code),
      CONSTRAINT taxonomy_versions_id_year_unique
        UNIQUE (id, tax_year)
    )
  `.execute(database);

  await sql`
    CREATE TABLE app.tax_category_definitions (
      id uuid PRIMARY KEY,
      taxonomy_version_id uuid NOT NULL,
      code text NOT NULL,
      name text NOT NULL,
      description text,
      official_form text,
      official_line text,
      status text NOT NULL DEFAULT 'active',
      sort_order integer NOT NULL,
      CONSTRAINT tax_category_definitions_taxonomy_fk
        FOREIGN KEY (taxonomy_version_id)
        REFERENCES app.taxonomy_versions(id) ON DELETE RESTRICT,
      CONSTRAINT tax_category_definitions_id_taxonomy_unique
        UNIQUE (id, taxonomy_version_id),
      CONSTRAINT tax_category_definitions_code_unique
        UNIQUE (taxonomy_version_id, code),
      CONSTRAINT tax_category_definitions_code_check
        CHECK (char_length(trim(code)) BETWEEN 1 AND 100),
      CONSTRAINT tax_category_definitions_name_check
        CHECK (char_length(trim(name)) BETWEEN 1 AND 200),
      CONSTRAINT tax_category_definitions_description_check
        CHECK (description IS NULL OR char_length(description) <= 2000),
      CONSTRAINT tax_category_definitions_status_check
        CHECK (status IN ('active', 'inactive')),
      CONSTRAINT tax_category_definitions_sort_order_check
        CHECK (sort_order > 0)
    )
  `.execute(database);

  await sql`
    INSERT INTO app.taxonomy_versions
      (id, jurisdiction_code, tax_year, code, name, status, source_url,
       source_revision, source_checksum)
    VALUES
      ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'US-FEDERAL', 2025,
       'schedule-c-2025', '2025 Schedule C', 'active',
       'https://www.irs.gov/forms-pubs/about-schedule-c-form-1040',
       '2025-final',
       '9f33e9a3f8a4d9d2f3c0f2e6a2a61d7dd5e0a4a8f9b4c1e6f0d4a2c5b7e8f901')
    ON CONFLICT (jurisdiction_code, tax_year, code) DO NOTHING
  `.execute(database);

  await sql`
    INSERT INTO app.tax_category_definitions
      (id, taxonomy_version_id, code, name, description, official_form,
       official_line, status, sort_order)
    VALUES
      ('aaaaaaaa-aaaa-4aaa-8aaa-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'advertising', 'Advertising', NULL, 'Schedule C', '8', 'active', 1),
      ('aaaaaaaa-aaaa-4aaa-8aaa-000000000002', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'car-and-truck', 'Car and Truck Expenses', NULL, 'Schedule C', '9', 'active', 2),
      ('aaaaaaaa-aaaa-4aaa-8aaa-000000000003', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'commissions-and-fees', 'Commissions and Fees', NULL, 'Schedule C', '10', 'active', 3),
      ('aaaaaaaa-aaaa-4aaa-8aaa-000000000004', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'contract-labor', 'Contract Labor', NULL, 'Schedule C', '11', 'active', 4),
      ('aaaaaaaa-aaaa-4aaa-8aaa-000000000005', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'depletion', 'Depletion', NULL, 'Schedule C', '12', 'active', 5),
      ('aaaaaaaa-aaaa-4aaa-8aaa-000000000006', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'depreciation', 'Depreciation', NULL, 'Schedule C', '13', 'active', 6),
      ('aaaaaaaa-aaaa-4aaa-8aaa-000000000007', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'employee-benefits', 'Employee Benefit Programs', NULL, 'Schedule C', '14', 'active', 7),
      ('aaaaaaaa-aaaa-4aaa-8aaa-000000000008', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'insurance', 'Insurance', NULL, 'Schedule C', '15', 'active', 8),
      ('aaaaaaaa-aaaa-4aaa-8aaa-000000000009', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'interest-mortgage', 'Interest: Mortgage', NULL, 'Schedule C', '16a', 'active', 9),
      ('aaaaaaaa-aaaa-4aaa-8aaa-000000000010', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'interest-other', 'Interest: Other', NULL, 'Schedule C', '16b', 'active', 10),
      ('aaaaaaaa-aaaa-4aaa-8aaa-000000000011', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'legal-professional', 'Legal and Professional Services', NULL, 'Schedule C', '17', 'active', 11),
      ('aaaaaaaa-aaaa-4aaa-8aaa-000000000012', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'office-expense', 'Office Expense', NULL, 'Schedule C', '18', 'active', 12),
      ('aaaaaaaa-aaaa-4aaa-8aaa-000000000013', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'pension-profit-sharing', 'Pension and Profit-Sharing Plans', NULL, 'Schedule C', '19', 'active', 13),
      ('aaaaaaaa-aaaa-4aaa-8aaa-000000000014', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'rent-vehicles', 'Rent or Lease: Vehicles', NULL, 'Schedule C', '20a', 'active', 14),
      ('aaaaaaaa-aaaa-4aaa-8aaa-000000000015', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'rent-other', 'Rent or Lease: Other Property', NULL, 'Schedule C', '20b', 'active', 15),
      ('aaaaaaaa-aaaa-4aaa-8aaa-000000000016', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'repairs-maintenance', 'Repairs and Maintenance', NULL, 'Schedule C', '21', 'active', 16),
      ('aaaaaaaa-aaaa-4aaa-8aaa-000000000017', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'supplies', 'Supplies', NULL, 'Schedule C', '22', 'active', 17),
      ('aaaaaaaa-aaaa-4aaa-8aaa-000000000018', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'taxes-licenses', 'Taxes and Licenses', NULL, 'Schedule C', '23', 'active', 18),
      ('aaaaaaaa-aaaa-4aaa-8aaa-000000000019', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'travel', 'Travel', NULL, 'Schedule C', '24a', 'active', 19),
      ('aaaaaaaa-aaaa-4aaa-8aaa-000000000020', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'meals', 'Meals', NULL, 'Schedule C', '24b', 'active', 20),
      ('aaaaaaaa-aaaa-4aaa-8aaa-000000000021', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'utilities', 'Utilities', NULL, 'Schedule C', '25', 'active', 21),
      ('aaaaaaaa-aaaa-4aaa-8aaa-000000000022', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'salaries-wages', 'Wages', NULL, 'Schedule C', '26', 'active', 22),
      ('aaaaaaaa-aaaa-4aaa-8aaa-000000000023', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'other-expenses', 'Other Expenses', NULL, 'Schedule C', '27a', 'active', 23),
      ('aaaaaaaa-aaaa-4aaa-8aaa-000000000024', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'business-use-home', 'Business Use of Home', NULL, 'Schedule C', '30', 'active', 24)
    ON CONFLICT (taxonomy_version_id, code) DO NOTHING
  `.execute(database);

  await sql`
    CREATE TABLE app.expenses (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
      created_by_user_id uuid NOT NULL REFERENCES app.users(id),
      personal_profile_id uuid,
      business_id uuid,
      project_id uuid,
      spending_category_id uuid,
      merchant text NOT NULL,
      description text,
      amount numeric(14, 2) NOT NULL,
      currency text NOT NULL,
      incurred_on date NOT NULL,
      tax_year integer GENERATED ALWAYS AS (extract(year FROM incurred_on)::integer) STORED,
      source text NOT NULL DEFAULT 'manual',
      status text NOT NULL DEFAULT 'draft',
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      archived_at timestamptz,
      CONSTRAINT expenses_id_tenant_unique UNIQUE (id, tenant_id),
      CONSTRAINT expenses_profile_tenant_fk
        FOREIGN KEY (personal_profile_id, tenant_id)
        REFERENCES app.personal_profiles(id, tenant_id),
      CONSTRAINT expenses_business_tenant_fk
        FOREIGN KEY (business_id, tenant_id)
        REFERENCES app.businesses(id, tenant_id),
      CONSTRAINT expenses_project_business_fk
        FOREIGN KEY (project_id, tenant_id, business_id)
        REFERENCES app.projects(id, tenant_id, business_id),
      CONSTRAINT expenses_category_tenant_fk
        FOREIGN KEY (spending_category_id, tenant_id)
        REFERENCES app.spending_categories(id, tenant_id),
      CONSTRAINT expenses_scope_check
        CHECK ((personal_profile_id IS NULL) <> (business_id IS NULL)),
      CONSTRAINT expenses_personal_project_check
        CHECK (personal_profile_id IS NULL OR project_id IS NULL),
      CONSTRAINT expenses_merchant_check
        CHECK (char_length(trim(merchant)) BETWEEN 1 AND 200),
      CONSTRAINT expenses_description_check
        CHECK (description IS NULL OR char_length(description) <= 2000),
      CONSTRAINT expenses_amount_check CHECK (amount > 0),
      CONSTRAINT expenses_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
      CONSTRAINT expenses_source_check CHECK (source = 'manual'),
      CONSTRAINT expenses_status_check
        CHECK (status IN ('draft', 'ready', 'archived')),
      CONSTRAINT expenses_version_check CHECK (version > 0),
      CONSTRAINT expenses_archive_state_check
        CHECK (
          (status <> 'archived' AND archived_at IS NULL)
          OR (status = 'archived' AND archived_at IS NOT NULL)
        )
    )
  `.execute(database);
  await sql`
    CREATE INDEX expenses_tenant_incurred_on_index
      ON app.expenses (tenant_id, incurred_on DESC, id DESC)
  `.execute(database);
  await sql`
    CREATE INDEX expenses_business_index
      ON app.expenses (tenant_id, business_id, incurred_on DESC, id DESC)
  `.execute(database);
  await sql`
    CREATE INDEX expenses_personal_index
      ON app.expenses (tenant_id, personal_profile_id, incurred_on DESC, id DESC)
  `.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  await database.schema.dropTable("app.expenses").ifExists().execute();
  await database.schema.dropTable("app.tax_category_definitions").ifExists().execute();
  await database.schema.dropTable("app.taxonomy_versions").ifExists().execute();
  await sql`
    ALTER TABLE app.projects
      DROP CONSTRAINT IF EXISTS projects_id_tenant_business_unique
  `.execute(database);
}
