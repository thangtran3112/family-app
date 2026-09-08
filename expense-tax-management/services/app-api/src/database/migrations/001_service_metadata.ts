import { type Kysely, sql } from "kysely";

export async function up(database: Kysely<unknown>): Promise<void> {
  await database.schema
    .createTable("app.service_metadata")
    .addColumn("key", "text", (column) => column.primaryKey())
    .addColumn("value", "jsonb", (column) => column.notNull())
    .addColumn("updated_at", "timestamptz", (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .execute();
}

export async function down(database: Kysely<unknown>): Promise<void> {
  await database.schema.dropTable("app.service_metadata").execute();
}
