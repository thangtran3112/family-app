import { type Kysely, sql } from "kysely";

export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE app.business_industries (
      code text PRIMARY KEY,
      name text NOT NULL,
      status text NOT NULL DEFAULT 'active',
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT business_industries_code_check
        CHECK (code = lower(code) AND code ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
      CONSTRAINT business_industries_name_check
        CHECK (char_length(trim(name)) BETWEEN 1 AND 100),
      CONSTRAINT business_industries_status_check
        CHECK (status IN ('active', 'inactive'))
    )
  `.execute(database);

  await sql`
    INSERT INTO app.business_industries (code, name) VALUES
      ('restaurant', 'Restaurant'),
      ('salon', 'Salon'),
      ('daycare', 'Daycare'),
      ('grocery', 'Grocery'),
      ('construction', 'Construction')
    ON CONFLICT (code) DO NOTHING
  `.execute(database);

  await sql`
    CREATE TABLE app.spending_category_templates (
      template_key text PRIMARY KEY,
      name text NOT NULL,
      description text NOT NULL,
      color text NOT NULL,
      icon text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT spending_category_templates_key_check
        CHECK (template_key = lower(template_key)
          AND template_key ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
      CONSTRAINT spending_category_templates_name_check
        CHECK (char_length(trim(name)) BETWEEN 1 AND 100),
      CONSTRAINT spending_category_templates_color_check
        CHECK (color ~ '^#[0-9A-Fa-f]{6}$'),
      CONSTRAINT spending_category_templates_icon_check
        CHECK (icon ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$')
    )
  `.execute(database);

  await sql`
    INSERT INTO app.spending_category_templates
      (template_key, name, description, color, icon)
    VALUES
      ('advertising', 'Advertising', 'Advertising and promotion', '#7C3AED', 'megaphone'),
      ('car-and-truck', 'Car and Truck', 'Business vehicle costs', '#0F766E', 'car'),
      ('contract-labor', 'Contract Labor', 'Payments to contractors', '#B45309', 'hard-hat'),
      ('insurance', 'Insurance', 'Business insurance costs', '#0369A1', 'shield'),
      ('office-expenses', 'Office Expenses', 'Office operations and services', '#4F46E5', 'building'),
      ('rent-or-lease', 'Rent or Lease', 'Business property and equipment rent', '#BE123C', 'key'),
      ('supplies', 'Supplies', 'Business supplies', '#2563EB', 'package'),
      ('utilities', 'Utilities', 'Business utility costs', '#15803D', 'zap')
    ON CONFLICT (template_key) DO NOTHING
  `.execute(database);

  await sql`
    CREATE TABLE app.businesses (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
      name text NOT NULL,
      industry_code text NOT NULL,
      timezone text NOT NULL,
      base_currency text NOT NULL,
      status text NOT NULL DEFAULT 'active',
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      archived_at timestamptz,
      CONSTRAINT businesses_id_tenant_unique UNIQUE (id, tenant_id),
      CONSTRAINT businesses_industry_fk
        FOREIGN KEY (industry_code) REFERENCES app.business_industries(code),
      CONSTRAINT businesses_name_check
        CHECK (char_length(trim(name)) BETWEEN 1 AND 100),
      CONSTRAINT businesses_timezone_check
        CHECK (char_length(trim(timezone)) BETWEEN 1 AND 100),
      CONSTRAINT businesses_base_currency_check
        CHECK (base_currency ~ '^[A-Z]{3}$'),
      CONSTRAINT businesses_status_check
        CHECK (status IN ('active', 'archived')),
      CONSTRAINT businesses_version_check CHECK (version > 0),
      CONSTRAINT businesses_archive_state_check
        CHECK (
          (status = 'active' AND archived_at IS NULL)
          OR (status = 'archived' AND archived_at IS NOT NULL)
        )
    )
  `.execute(database);
  await sql`
    CREATE INDEX businesses_tenant_id_index ON app.businesses (tenant_id)
  `.execute(database);

  await sql`
    CREATE TABLE app.business_memberships (
      business_id uuid NOT NULL,
      tenant_id uuid NOT NULL,
      user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
      role text NOT NULL,
      status text NOT NULL DEFAULT 'active',
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (business_id, user_id),
      CONSTRAINT business_memberships_business_tenant_fk
        FOREIGN KEY (business_id, tenant_id)
        REFERENCES app.businesses(id, tenant_id) ON DELETE CASCADE,
      CONSTRAINT business_memberships_tenant_membership_fk
        FOREIGN KEY (tenant_id, user_id)
        REFERENCES app.tenant_memberships(tenant_id, user_id) ON DELETE CASCADE,
      CONSTRAINT business_memberships_role_check
        CHECK (role IN ('owner', 'editor', 'viewer')),
      CONSTRAINT business_memberships_status_check
        CHECK (status IN ('active', 'inactive')),
      CONSTRAINT business_memberships_version_check CHECK (version > 0)
    )
  `.execute(database);
  await sql`
    CREATE INDEX business_memberships_user_id_index
      ON app.business_memberships (user_id)
  `.execute(database);

  await sql`
    CREATE TABLE app.spending_categories (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
      template_key text REFERENCES app.spending_category_templates(template_key),
      name text NOT NULL,
      description text,
      color text NOT NULL,
      icon text NOT NULL,
      status text NOT NULL DEFAULT 'active',
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      archived_at timestamptz,
      CONSTRAINT spending_categories_id_tenant_unique UNIQUE (id, tenant_id),
      CONSTRAINT spending_categories_name_check
        CHECK (char_length(trim(name)) BETWEEN 1 AND 100),
      CONSTRAINT spending_categories_description_check
        CHECK (description IS NULL OR char_length(description) <= 500),
      CONSTRAINT spending_categories_color_check
        CHECK (color ~ '^#[0-9A-Fa-f]{6}$'),
      CONSTRAINT spending_categories_icon_check
        CHECK (icon ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
      CONSTRAINT spending_categories_status_check
        CHECK (status IN ('active', 'archived')),
      CONSTRAINT spending_categories_version_check CHECK (version > 0),
      CONSTRAINT spending_categories_archive_state_check
        CHECK (
          (status = 'active' AND archived_at IS NULL)
          OR (status = 'archived' AND archived_at IS NOT NULL)
        )
    )
  `.execute(database);
  await sql`
    CREATE UNIQUE INDEX spending_categories_tenant_template_unique
      ON app.spending_categories (tenant_id, template_key)
      WHERE template_key IS NOT NULL
  `.execute(database);
  await sql`
    CREATE UNIQUE INDEX spending_categories_active_tenant_name_unique
      ON app.spending_categories (tenant_id, lower(name))
      WHERE status = 'active'
  `.execute(database);

  await sql`
    CREATE TABLE app.projects (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
      business_id uuid NOT NULL,
      name text NOT NULL,
      client_name text,
      description text,
      status text NOT NULL DEFAULT 'active',
      starts_on date,
      ends_on date,
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      archived_at timestamptz,
      CONSTRAINT projects_business_tenant_fk
        FOREIGN KEY (business_id, tenant_id)
        REFERENCES app.businesses(id, tenant_id) ON DELETE CASCADE,
      CONSTRAINT projects_name_check
        CHECK (char_length(trim(name)) BETWEEN 1 AND 100),
      CONSTRAINT projects_client_name_check
        CHECK (client_name IS NULL OR char_length(client_name) <= 100),
      CONSTRAINT projects_description_check
        CHECK (description IS NULL OR char_length(description) <= 1000),
      CONSTRAINT projects_status_check
        CHECK (status IN ('active', 'completed', 'archived')),
      CONSTRAINT projects_dates_check
        CHECK (starts_on IS NULL OR ends_on IS NULL OR ends_on >= starts_on),
      CONSTRAINT projects_version_check CHECK (version > 0),
      CONSTRAINT projects_archive_state_check
        CHECK (
          (status <> 'archived' AND archived_at IS NULL)
          OR (status = 'archived' AND archived_at IS NOT NULL)
        )
    )
  `.execute(database);
  await sql`
    CREATE INDEX projects_business_id_index ON app.projects (business_id)
  `.execute(database);

  await sql`
    ALTER TABLE app.tenant_invitations
      ADD COLUMN business_id uuid,
      ADD COLUMN business_role text,
      ADD CONSTRAINT tenant_invitations_business_role_check
        CHECK (business_role IS NULL OR business_role IN ('owner', 'editor', 'viewer')),
      ADD CONSTRAINT tenant_invitations_business_grant_check
        CHECK (
          (business_id IS NULL AND business_role IS NULL)
          OR (business_id IS NOT NULL AND business_role IS NOT NULL)
        ),
      ADD CONSTRAINT tenant_invitations_single_grant_check
        CHECK (personal_profile_id IS NULL OR business_id IS NULL),
      ADD CONSTRAINT tenant_invitations_business_tenant_fk
        FOREIGN KEY (business_id, tenant_id)
        REFERENCES app.businesses(id, tenant_id)
  `.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE app.tenant_invitations
      DROP CONSTRAINT tenant_invitations_business_tenant_fk,
      DROP CONSTRAINT tenant_invitations_single_grant_check,
      DROP CONSTRAINT tenant_invitations_business_grant_check,
      DROP CONSTRAINT tenant_invitations_business_role_check,
      DROP COLUMN business_role,
      DROP COLUMN business_id
  `.execute(database);
  await database.schema.dropTable("app.projects").execute();
  await database.schema.dropTable("app.spending_categories").execute();
  await database.schema.dropTable("app.business_memberships").execute();
  await database.schema.dropTable("app.businesses").execute();
  await database.schema.dropTable("app.spending_category_templates").execute();
  await database.schema.dropTable("app.business_industries").execute();
}
