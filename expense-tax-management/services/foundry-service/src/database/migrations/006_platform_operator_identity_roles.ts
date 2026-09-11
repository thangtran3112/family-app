import { type Kysely, sql } from "kysely";

export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE foundry.platform_operator_identities
      DROP CONSTRAINT IF EXISTS platform_operator_identities_pkey
  `.execute(database);
  await sql`
    ALTER TABLE foundry.platform_operator_identities
      ADD CONSTRAINT platform_operator_identities_pkey
      PRIMARY KEY (clerk_user_id, role)
  `.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  await sql`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT clerk_user_id
        FROM foundry.platform_operator_identities
        GROUP BY clerk_user_id
        HAVING count(*) > 1
      ) THEN
        RAISE EXCEPTION 'cannot reverse operator identity roles with duplicate clerk user IDs';
      END IF;
    END $$;
  `.execute(database);
  await sql`
    ALTER TABLE foundry.platform_operator_identities
      DROP CONSTRAINT IF EXISTS platform_operator_identities_pkey
  `.execute(database);
  await sql`
    ALTER TABLE foundry.platform_operator_identities
      ADD CONSTRAINT platform_operator_identities_pkey PRIMARY KEY (clerk_user_id)
  `.execute(database);
}
