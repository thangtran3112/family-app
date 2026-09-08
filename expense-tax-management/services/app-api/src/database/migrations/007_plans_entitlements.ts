import { type Kysely, sql } from "kysely";

export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE app.plans (
      id uuid PRIMARY KEY,
      key text NOT NULL UNIQUE,
      name text NOT NULL,
      description text,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT plans_key_check CHECK (key ~ '^[a-z][a-z0-9_-]*$')
    )
  `.execute(database);

  await sql`
    CREATE TABLE app.plan_versions (
      id uuid PRIMARY KEY,
      plan_id uuid NOT NULL REFERENCES app.plans(id) ON DELETE CASCADE,
      version_number integer NOT NULL,
      effective_at timestamptz NOT NULL DEFAULT now(),
      is_current boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT plan_versions_plan_number_unique UNIQUE (plan_id, version_number),
      CONSTRAINT plan_versions_id_plan_unique UNIQUE (id, plan_id),
      CONSTRAINT plan_versions_number_check CHECK (version_number > 0)
    )
  `.execute(database);
  await sql`
    CREATE UNIQUE INDEX plan_versions_one_current_per_plan
      ON app.plan_versions (plan_id) WHERE is_current
  `.execute(database);

  await sql`
    CREATE TABLE app.feature_definitions (
      id uuid PRIMARY KEY,
      key text NOT NULL UNIQUE,
      name text NOT NULL,
      description text,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT feature_definitions_key_check CHECK (key ~ '^[a-z][a-z0-9_]*$')
    )
  `.execute(database);

  await sql`
    CREATE TABLE app.plan_entitlements (
      plan_version_id uuid NOT NULL REFERENCES app.plan_versions(id) ON DELETE CASCADE,
      feature_definition_id uuid NOT NULL REFERENCES app.feature_definitions(id),
      is_enabled boolean NOT NULL,
      limit_value integer,
      limit_period text,
      PRIMARY KEY (plan_version_id, feature_definition_id),
      CONSTRAINT plan_entitlements_limit_period_check
        CHECK (limit_period IS NULL OR limit_period IN ('monthly', 'unlimited')),
      CONSTRAINT plan_entitlements_limit_value_check
        CHECK (limit_value IS NULL OR limit_value >= 0)
    )
  `.execute(database);

  await sql`
    CREATE TABLE app.tenant_subscriptions (
      tenant_id uuid PRIMARY KEY REFERENCES app.tenants(id) ON DELETE CASCADE,
      plan_version_id uuid NOT NULL REFERENCES app.plan_versions(id),
      status text NOT NULL DEFAULT 'trialing',
      current_entitlement_version integer NOT NULL DEFAULT 1,
      started_at timestamptz NOT NULL DEFAULT now(),
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT tenant_subscriptions_status_check
        CHECK (status IN ('trialing', 'active', 'canceled')),
      CONSTRAINT tenant_subscriptions_version_check CHECK (version > 0),
      CONSTRAINT tenant_subscriptions_entitlement_version_check
        CHECK (current_entitlement_version > 0)
    )
  `.execute(database);

  await sql`
    CREATE TABLE app.tenant_addons (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
      feature_definition_id uuid NOT NULL REFERENCES app.feature_definitions(id),
      enabled boolean NOT NULL DEFAULT true,
      granted_by text NOT NULL,
      expires_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT tenant_addons_tenant_feature_unique UNIQUE (tenant_id, feature_definition_id)
    )
  `.execute(database);

  await sql`
    CREATE TABLE app.tenant_feature_overrides (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
      feature_definition_id uuid NOT NULL REFERENCES app.feature_definitions(id),
      override_enabled boolean NOT NULL,
      reason text NOT NULL,
      granted_by text NOT NULL,
      expires_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT tenant_feature_overrides_tenant_feature_unique
        UNIQUE (tenant_id, feature_definition_id),
      CONSTRAINT tenant_feature_overrides_reason_check
        CHECK (char_length(reason) BETWEEN 1 AND 2000)
    )
  `.execute(database);

  await sql`
    CREATE TABLE app.feature_usage_events (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
      feature_definition_id uuid NOT NULL REFERENCES app.feature_definitions(id),
      initiating_user_id uuid NOT NULL REFERENCES app.users(id),
      occurred_at timestamptz NOT NULL DEFAULT now(),
      quantity integer NOT NULL DEFAULT 1,
      metadata jsonb,
      CONSTRAINT feature_usage_events_quantity_check CHECK (quantity > 0)
    )
  `.execute(database);
  await sql`
    CREATE INDEX feature_usage_events_tenant_feature_time_index
      ON app.feature_usage_events (tenant_id, feature_definition_id, occurred_at)
  `.execute(database);

  await sql`
    CREATE TABLE app.entitlement_snapshot_outbox (
      outbox_sequence bigserial PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
      entitlement_version integer NOT NULL,
      payload jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT entitlement_snapshot_outbox_tenant_version_unique
        UNIQUE (tenant_id, entitlement_version)
    )
  `.execute(database);

  // Seed: trial plan, version 1, six initial feature definitions, all
  // disabled except the free-tier baseline (receipt_forwarding is always
  // available per design doc "available to every plan"; ai_search on
  // trial is capped at 20/month per design doc).
  await sql`
    INSERT INTO app.feature_definitions (id, key, name, description) VALUES
      ('bbbbbbbb-0001-4000-8000-000000000001', 'receipt_forwarding', 'Receipt Forwarding', 'Forward receipts by email for OCR intake'),
      ('bbbbbbbb-0001-4000-8000-000000000002', 'connected_mailbox_scan', 'Connected Mailbox Scan', 'Scan a connected Gmail/Outlook inbox for receipts'),
      ('bbbbbbbb-0001-4000-8000-000000000003', 'ai_search', 'AI Receipt Search', 'Semantic and natural-language receipt search'),
      ('bbbbbbbb-0001-4000-8000-000000000004', 'ocr_mode_fast', 'OCR Mode: Fast', 'Fast/low-cost OCR extraction mode'),
      ('bbbbbbbb-0001-4000-8000-000000000005', 'ocr_mode_balanced', 'OCR Mode: Balanced', 'Balanced OCR extraction mode'),
      ('bbbbbbbb-0001-4000-8000-000000000006', 'ocr_mode_accurate', 'OCR Mode: Accurate', 'High-accuracy OCR extraction mode')
  `.execute(database);

  await sql`
    INSERT INTO app.plans (id, key, name, description) VALUES
      ('cccccccc-0001-4000-8000-000000000001', 'trial', 'Trial', 'Default plan for new tenants')
  `.execute(database);
  await sql`
    INSERT INTO app.plan_versions (id, plan_id, version_number, is_current) VALUES
      ('dddddddd-0001-4000-8000-000000000001', 'cccccccc-0001-4000-8000-000000000001', 1, true)
  `.execute(database);
  await sql`
    INSERT INTO app.plan_entitlements
      (plan_version_id, feature_definition_id, is_enabled, limit_value, limit_period) VALUES
      ('dddddddd-0001-4000-8000-000000000001', 'bbbbbbbb-0001-4000-8000-000000000001', true, NULL, 'unlimited'),
      ('dddddddd-0001-4000-8000-000000000001', 'bbbbbbbb-0001-4000-8000-000000000002', false, NULL, NULL),
      ('dddddddd-0001-4000-8000-000000000001', 'bbbbbbbb-0001-4000-8000-000000000003', true, 20, 'monthly'),
      ('dddddddd-0001-4000-8000-000000000001', 'bbbbbbbb-0001-4000-8000-000000000004', true, NULL, 'unlimited'),
      ('dddddddd-0001-4000-8000-000000000001', 'bbbbbbbb-0001-4000-8000-000000000005', true, NULL, 'unlimited'),
      ('dddddddd-0001-4000-8000-000000000001', 'bbbbbbbb-0001-4000-8000-000000000006', false, NULL, NULL)
  `.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  await database.schema.dropTable("app.entitlement_snapshot_outbox").ifExists().execute();
  await database.schema.dropTable("app.feature_usage_events").ifExists().execute();
  await database.schema.dropTable("app.tenant_feature_overrides").ifExists().execute();
  await database.schema.dropTable("app.tenant_addons").ifExists().execute();
  await database.schema.dropTable("app.tenant_subscriptions").ifExists().execute();
  await database.schema.dropTable("app.plan_entitlements").ifExists().execute();
  await database.schema.dropTable("app.feature_definitions").ifExists().execute();
  await database.schema.dropTable("app.plan_versions").ifExists().execute();
  await database.schema.dropTable("app.plans").ifExists().execute();
}
