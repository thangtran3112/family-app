import { type Kysely, sql } from "kysely";

export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE app.processing_jobs (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
      personal_profile_id uuid,
      business_id uuid,
      workflow_type text NOT NULL,
      workflow_id text NOT NULL,
      task_queue text NOT NULL,
      run_id text,
      status text NOT NULL DEFAULT 'PENDING',
      target_aggregate_type text,
      target_aggregate_id uuid,
      expected_aggregate_version integer,
      allowed_result_schema_version text NOT NULL,
      result jsonb,
      error_message text,
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      dispatched_at timestamptz,
      completed_at timestamptz,
      CONSTRAINT processing_jobs_workflow_id_unique UNIQUE (workflow_id),
      CONSTRAINT processing_jobs_profile_tenant_fk
        FOREIGN KEY (personal_profile_id, tenant_id)
        REFERENCES app.personal_profiles(id, tenant_id),
      CONSTRAINT processing_jobs_business_tenant_fk
        FOREIGN KEY (business_id, tenant_id)
        REFERENCES app.businesses(id, tenant_id),
      CONSTRAINT processing_jobs_scope_check
        CHECK ((personal_profile_id IS NULL) <> (business_id IS NULL)),
      CONSTRAINT processing_jobs_workflow_type_check
        CHECK (char_length(trim(workflow_type)) BETWEEN 1 AND 200),
      CONSTRAINT processing_jobs_task_queue_check
        CHECK (char_length(trim(task_queue)) BETWEEN 1 AND 200),
      CONSTRAINT processing_jobs_status_check
        CHECK (status IN ('PENDING', 'DISPATCHED', 'RUNNING', 'SUCCEEDED', 'FAILED')),
      CONSTRAINT processing_jobs_allowed_result_schema_version_check
        CHECK (char_length(trim(allowed_result_schema_version)) BETWEEN 1 AND 200),
      CONSTRAINT processing_jobs_version_check CHECK (version > 0),
      CONSTRAINT processing_jobs_dispatch_state_check
        CHECK (
          (status = 'PENDING' AND dispatched_at IS NULL AND run_id IS NULL)
          OR (status <> 'PENDING' AND dispatched_at IS NOT NULL)
        ),
      CONSTRAINT processing_jobs_completion_state_check
        CHECK (
          (status IN ('SUCCEEDED', 'FAILED') AND completed_at IS NOT NULL)
          OR (status NOT IN ('SUCCEEDED', 'FAILED') AND completed_at IS NULL)
        )
    )
  `.execute(database);
  await sql`
    CREATE INDEX processing_jobs_tenant_status_index
      ON app.processing_jobs (tenant_id, status, created_at DESC)
  `.execute(database);

  await sql`
    CREATE TABLE app.processing_job_dispatch_outbox (
      id uuid PRIMARY KEY,
      processing_job_id uuid NOT NULL REFERENCES app.processing_jobs(id) ON DELETE CASCADE,
      job_reference jsonb NOT NULL,
      status text NOT NULL DEFAULT 'PENDING',
      attempts integer NOT NULL DEFAULT 0,
      last_error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      dispatched_at timestamptz,
      CONSTRAINT processing_job_dispatch_outbox_job_unique UNIQUE (processing_job_id),
      CONSTRAINT processing_job_dispatch_outbox_status_check
        CHECK (status IN ('PENDING', 'DISPATCHED', 'FAILED')),
      CONSTRAINT processing_job_dispatch_outbox_attempts_check
        CHECK (attempts >= 0)
    )
  `.execute(database);
  await sql`
    CREATE INDEX processing_job_dispatch_outbox_pending_index
      ON app.processing_job_dispatch_outbox (created_at)
      WHERE status = 'PENDING'
  `.execute(database);

}

export async function down(database: Kysely<unknown>): Promise<void> {
  await database.schema.dropTable("app.processing_job_dispatch_outbox").ifExists().execute();
  await database.schema.dropTable("app.processing_jobs").ifExists().execute();
}
