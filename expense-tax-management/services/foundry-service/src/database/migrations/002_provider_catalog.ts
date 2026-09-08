import { type Kysely, sql } from "kysely";

export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE foundry.provider_secrets (
      id uuid PRIMARY KEY,
      value text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(database);

  await sql`
    CREATE TABLE foundry.provider_connections (
      id uuid PRIMARY KEY,
      key text NOT NULL UNIQUE,
      provider_kind text NOT NULL,
      display_name text NOT NULL,
      secret_reference uuid NOT NULL REFERENCES foundry.provider_secrets(id),
      status text NOT NULL DEFAULT 'active',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT provider_connections_key_check CHECK (key ~ '^[a-z][a-z0-9_-]*$'),
      CONSTRAINT provider_connections_kind_check
        CHECK (provider_kind IN ('openai', 'openrouter', 'anthropic', 'google', 'paddleocr')),
      CONSTRAINT provider_connections_status_check CHECK (status IN ('active', 'disabled'))
    )
  `.execute(database);

  await sql`
    CREATE TABLE foundry.ai_models (
      id uuid PRIMARY KEY,
      provider_connection_id uuid NOT NULL REFERENCES foundry.provider_connections(id),
      provider_model_id text NOT NULL,
      metered_model_key text NOT NULL,
      status text NOT NULL DEFAULT 'active',
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT ai_models_connection_model_unique UNIQUE (provider_connection_id, provider_model_id),
      CONSTRAINT ai_models_status_check CHECK (status IN ('active', 'disabled'))
    )
  `.execute(database);

  await sql`
    CREATE TABLE foundry.ai_modes (
      id uuid PRIMARY KEY,
      key text NOT NULL UNIQUE,
      display_name text NOT NULL,
      description text,
      operation text NOT NULL,
      status text NOT NULL DEFAULT 'active',
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT ai_modes_key_check CHECK (key ~ '^[a-z][a-z0-9_-]*$'),
      CONSTRAINT ai_modes_operation_check CHECK (operation IN ('RECEIPT_OCR', 'AI_SEARCH')),
      CONSTRAINT ai_modes_status_check CHECK (status IN ('active', 'disabled'))
    )
  `.execute(database);

  await sql`
    CREATE TABLE foundry.ai_mode_route_versions (
      id uuid PRIMARY KEY,
      ai_mode_id uuid NOT NULL REFERENCES foundry.ai_modes(id) ON DELETE CASCADE,
      version_number integer NOT NULL,
      ai_model_id uuid NOT NULL REFERENCES foundry.ai_models(id),
      is_current boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT ai_mode_route_versions_mode_number_unique UNIQUE (ai_mode_id, version_number),
      CONSTRAINT ai_mode_route_versions_number_check CHECK (version_number > 0)
    )
  `.execute(database);
  await sql`
    CREATE UNIQUE INDEX ai_mode_route_versions_one_current_per_mode
      ON foundry.ai_mode_route_versions (ai_mode_id) WHERE is_current
  `.execute(database);

  await sql`
    CREATE TABLE foundry.foundry_audit_events (
      id uuid PRIMARY KEY,
      actor_platform_subject text,
      actor_service_principal text,
      action text NOT NULL,
      outcome text NOT NULL,
      resource_type text NOT NULL,
      resource_id text,
      request_id text NOT NULL,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT foundry_audit_events_outcome_check
        CHECK (outcome IN ('success', 'denied', 'failure'))
    )
  `.execute(database);
  await sql`
    CREATE INDEX foundry_audit_events_resource_index
      ON foundry.foundry_audit_events (resource_type, resource_id, created_at)
  `.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  await database.schema.dropTable("foundry.foundry_audit_events").ifExists().execute();
  await database.schema.dropTable("foundry.ai_mode_route_versions").ifExists().execute();
  await database.schema.dropTable("foundry.ai_modes").ifExists().execute();
  await database.schema.dropTable("foundry.ai_models").ifExists().execute();
  await database.schema.dropTable("foundry.provider_connections").ifExists().execute();
  await database.schema.dropTable("foundry.provider_secrets").ifExists().execute();
}
