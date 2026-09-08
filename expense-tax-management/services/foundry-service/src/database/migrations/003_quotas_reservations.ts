import { type Kysely, sql } from "kysely";

export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE foundry.tenant_ai_quotas (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL,
      operation text NOT NULL,
      ai_model_id uuid REFERENCES foundry.ai_models(id),
      period_type text NOT NULL,
      max_jobs integer,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT tenant_ai_quotas_operation_check CHECK (operation IN ('RECEIPT_OCR', 'AI_SEARCH')),
      CONSTRAINT tenant_ai_quotas_period_type_check CHECK (period_type IN ('monthly', 'unlimited')),
      CONSTRAINT tenant_ai_quotas_max_jobs_check CHECK (max_jobs IS NULL OR max_jobs >= 0),
      CONSTRAINT tenant_ai_quotas_scope_unique UNIQUE (tenant_id, operation, ai_model_id)
    )
  `.execute(database);
  await sql`
    CREATE UNIQUE INDEX tenant_ai_quotas_aggregate_unique
      ON foundry.tenant_ai_quotas (tenant_id, operation) WHERE ai_model_id IS NULL
  `.execute(database);

  await sql`
    CREATE TABLE foundry.ai_quota_periods (
      id uuid PRIMARY KEY,
      tenant_ai_quota_id uuid NOT NULL REFERENCES foundry.tenant_ai_quotas(id) ON DELETE CASCADE,
      period_key text NOT NULL,
      consumed_jobs integer NOT NULL DEFAULT 0,
      reserved_jobs integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT ai_quota_periods_quota_period_unique UNIQUE (tenant_ai_quota_id, period_key),
      CONSTRAINT ai_quota_periods_consumed_check CHECK (consumed_jobs >= 0),
      CONSTRAINT ai_quota_periods_reserved_check CHECK (reserved_jobs >= 0)
    )
  `.execute(database);

  await sql`
    CREATE TABLE foundry.ai_quota_reservations (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL,
      operation text NOT NULL,
      ai_model_id uuid NOT NULL REFERENCES foundry.ai_models(id),
      idempotency_key text NOT NULL,
      status text NOT NULL DEFAULT 'RESERVED',
      aggregate_period_id uuid REFERENCES foundry.ai_quota_periods(id),
      model_period_id uuid REFERENCES foundry.ai_quota_periods(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      call_started_at timestamptz,
      resolved_at timestamptz,
      CONSTRAINT ai_quota_reservations_operation_check CHECK (operation IN ('RECEIPT_OCR', 'AI_SEARCH')),
      CONSTRAINT ai_quota_reservations_status_check
        CHECK (status IN ('RESERVED', 'CALL_STARTED', 'CONSUMED', 'RELEASED', 'RECONCILIATION_REQUIRED')),
      CONSTRAINT ai_quota_reservations_idempotency_unique
        UNIQUE (tenant_id, operation, idempotency_key)
    )
  `.execute(database);

  await sql`
    CREATE TABLE foundry.provider_call_logs (
      id uuid PRIMARY KEY,
      reservation_id uuid NOT NULL REFERENCES foundry.ai_quota_reservations(id) ON DELETE CASCADE,
      attempt_number integer NOT NULL,
      provider_idempotency_key text,
      outcome text NOT NULL DEFAULT 'pending',
      latency_ms integer,
      cost_usd numeric(10, 6),
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT provider_call_logs_attempt_unique UNIQUE (reservation_id, attempt_number),
      CONSTRAINT provider_call_logs_attempt_check CHECK (attempt_number > 0),
      CONSTRAINT provider_call_logs_outcome_check CHECK (outcome IN ('accepted', 'failed', 'pending')),
      CONSTRAINT provider_call_logs_latency_check CHECK (latency_ms IS NULL OR latency_ms >= 0),
      CONSTRAINT provider_call_logs_cost_check CHECK (cost_usd IS NULL OR cost_usd >= 0)
    )
  `.execute(database);

  await sql`
    CREATE TABLE foundry.ai_quota_reservation_resolutions (
      id uuid PRIMARY KEY,
      reservation_id uuid NOT NULL REFERENCES foundry.ai_quota_reservations(id) ON DELETE CASCADE,
      decision text NOT NULL,
      reason text NOT NULL,
      evidence jsonb,
      resolved_by_subject text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT ai_quota_reservation_resolutions_decision_check
        CHECK (decision IN ('consumed', 'released')),
      CONSTRAINT ai_quota_reservation_resolutions_subject_unique
        UNIQUE (reservation_id, resolved_by_subject)
    )
  `.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  await database.schema.dropTable("foundry.ai_quota_reservation_resolutions").ifExists().execute();
  await database.schema.dropTable("foundry.provider_call_logs").ifExists().execute();
  await database.schema.dropTable("foundry.ai_quota_reservations").ifExists().execute();
  await database.schema.dropTable("foundry.ai_quota_periods").ifExists().execute();
  await database.schema.dropTable("foundry.tenant_ai_quotas").ifExists().execute();
}
