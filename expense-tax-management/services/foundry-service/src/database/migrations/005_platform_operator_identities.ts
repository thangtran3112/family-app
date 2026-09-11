import { type Kysely, sql } from "kysely";

export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE foundry.platform_operator_identities (
      clerk_user_id text PRIMARY KEY,
      role text NOT NULL CHECK (role IN ('operator', 'catalog_manager', 'quota_reconciler')),
      status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  await database.schema
    .dropTable("foundry.platform_operator_identities")
    .execute();
}
