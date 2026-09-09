import { type Kysely, sql } from "kysely";

export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE app.expenses
      DROP CONSTRAINT expenses_source_check,
      ADD CONSTRAINT expenses_source_check
        CHECK (source IN ('manual', 'ocr'))
  `.execute(database);

  await sql`
    ALTER TABLE app.processing_jobs
      ADD COLUMN requested_by_user_id uuid NULL REFERENCES app.users(id),
      ADD COLUMN source_file_id uuid NULL REFERENCES app.expense_files(id) ON DELETE SET NULL,
      ADD COLUMN input_params jsonb NOT NULL DEFAULT '{}'
  `.execute(database);
  await sql`
    CREATE INDEX processing_jobs_source_file_index
      ON app.processing_jobs (source_file_id)
      WHERE source_file_id IS NOT NULL
  `.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  await sql`
    DROP INDEX IF EXISTS app.processing_jobs_source_file_index
  `.execute(database);
  await sql`
    ALTER TABLE app.processing_jobs
      DROP COLUMN IF EXISTS input_params,
      DROP COLUMN IF EXISTS source_file_id,
      DROP COLUMN IF EXISTS requested_by_user_id
  `.execute(database);
  await sql`
    ALTER TABLE app.expenses
      DROP CONSTRAINT expenses_source_check,
      ADD CONSTRAINT expenses_source_check
        CHECK (source = 'manual')
  `.execute(database);
}
