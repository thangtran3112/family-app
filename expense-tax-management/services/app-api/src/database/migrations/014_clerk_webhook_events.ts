import { type Kysely, sql } from "kysely";

export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE app.clerk_webhook_events (
      id uuid PRIMARY KEY,
      event_id text NOT NULL UNIQUE,
      event_type text NOT NULL,
      processed_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT clerk_webhook_events_event_id_check CHECK (char_length(trim(event_id)) BETWEEN 1 AND 255)
    )
  `.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  await database.schema.dropTable("app.clerk_webhook_events").execute();
}
