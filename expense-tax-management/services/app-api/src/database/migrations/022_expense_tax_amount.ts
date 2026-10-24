import { type Kysely, sql } from "kysely";

export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE app.expenses
      ADD COLUMN tax_amount numeric(14, 2),
      ADD CONSTRAINT expenses_tax_amount_nonnegative_check
        CHECK (tax_amount >= 0),
      ADD CONSTRAINT expenses_tax_amount_not_greater_than_amount_check
        CHECK (tax_amount <= amount)
  `.execute(database);
}

export async function down(): Promise<void> {
  throw new Error(
    "Migration 022 is forward-only: rollback is not supported, as it would discard persisted tax amounts. Write a new forward migration instead.",
  );
}
