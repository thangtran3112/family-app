import { type Kysely, sql } from "kysely";

export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE app.users
      ADD COLUMN clerk_user_id text,
      ADD CONSTRAINT users_clerk_user_id_check
        CHECK (clerk_user_id IS NULL OR char_length(trim(clerk_user_id)) BETWEEN 1 AND 255)
  `.execute(database);
  await sql`
    ALTER TABLE app.tenants
      ADD COLUMN clerk_org_id text,
      ADD CONSTRAINT tenants_clerk_org_id_check
        CHECK (clerk_org_id IS NULL OR char_length(trim(clerk_org_id)) BETWEEN 1 AND 255)
  `.execute(database);
  await sql`
    CREATE UNIQUE INDEX users_clerk_user_id_unique
      ON app.users (clerk_user_id)
      WHERE clerk_user_id IS NOT NULL
  `.execute(database);
  await sql`
    CREATE UNIQUE INDEX tenants_clerk_org_id_unique
      ON app.tenants (clerk_org_id)
      WHERE clerk_org_id IS NOT NULL
  `.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS app.tenants_clerk_org_id_unique`.execute(database);
  await sql`DROP INDEX IF EXISTS app.users_clerk_user_id_unique`.execute(database);
  await sql`
    ALTER TABLE app.tenants
      DROP CONSTRAINT IF EXISTS tenants_clerk_org_id_check,
      DROP COLUMN IF EXISTS clerk_org_id
  `.execute(database);
  await sql`
    ALTER TABLE app.users
      DROP CONSTRAINT IF EXISTS users_clerk_user_id_check,
      DROP COLUMN IF EXISTS clerk_user_id
  `.execute(database);
}
