import { type Kysely, sql } from "kysely";

export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE foundry.provider_connections
      DROP CONSTRAINT provider_connections_kind_check,
      ADD CONSTRAINT provider_connections_kind_check
        CHECK (provider_kind IN ('openai', 'openrouter', 'anthropic', 'google', 'paddleocr', 'fake'))
  `.execute(database);

  // Seed fake OCR provider: one inert backend behind the three curated OCR
  // mode names. The vault value is deliberately NOT a credential (the fake
  // adapter never reads it); it exists only because connections require a
  // secret reference. Mode differences (cost/latency/accuracy) are future
  // real-provider work; per-mode quotas remain enforceable via model or
  // aggregate policies regardless.
  await sql`
    INSERT INTO foundry.provider_secrets (id, value)
    VALUES ('eeeeeeee-0001-4000-8000-000000000001', 'fake-provider-no-credential')
    ON CONFLICT (id) DO NOTHING
  `.execute(database);
  await sql`
    INSERT INTO foundry.provider_connections (id, key, provider_kind, display_name, secret_reference, status)
    VALUES ('eeeeeeee-0001-4000-8000-000000000002', 'fake-ocr', 'fake', 'Fake OCR (dev/test only)', 'eeeeeeee-0001-4000-8000-000000000001', 'active')
    ON CONFLICT (id) DO NOTHING
  `.execute(database);
  await sql`
    INSERT INTO foundry.ai_models (id, provider_connection_id, provider_model_id, metered_model_key, status)
    VALUES ('eeeeeeee-0001-4000-8000-000000000003', 'eeeeeeee-0001-4000-8000-000000000002', 'fake-ocr-v1', 'fake-ocr', 'active')
    ON CONFLICT (id) DO NOTHING
  `.execute(database);
  await sql`
    INSERT INTO foundry.ai_modes (id, key, display_name, description, operation, status)
    VALUES
      ('eeeeeeee-0001-4000-8000-000000000004', 'ocr_mode_fast', 'OCR Fast', 'Fast fake OCR mode (dev/test only)', 'RECEIPT_OCR', 'active'),
      ('eeeeeeee-0001-4000-8000-000000000005', 'ocr_mode_balanced', 'OCR Balanced', 'Balanced fake OCR mode (dev/test only)', 'RECEIPT_OCR', 'active'),
      ('eeeeeeee-0001-4000-8000-000000000006', 'ocr_mode_accurate', 'OCR Accurate', 'Accurate fake OCR mode (dev/test only)', 'RECEIPT_OCR', 'active')
    ON CONFLICT (id) DO NOTHING
  `.execute(database);
  await sql`
    INSERT INTO foundry.ai_mode_route_versions (id, ai_mode_id, version_number, ai_model_id, is_current)
    VALUES
      ('eeeeeeee-0001-4000-8000-000000000007', 'eeeeeeee-0001-4000-8000-000000000004', 1, 'eeeeeeee-0001-4000-8000-000000000003', true),
      ('eeeeeeee-0001-4000-8000-000000000008', 'eeeeeeee-0001-4000-8000-000000000005', 1, 'eeeeeeee-0001-4000-8000-000000000003', true),
      ('eeeeeeee-0001-4000-8000-000000000009', 'eeeeeeee-0001-4000-8000-000000000006', 1, 'eeeeeeee-0001-4000-8000-000000000003', true)
    ON CONFLICT (id) DO NOTHING
  `.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  await sql`
    DELETE FROM foundry.ai_mode_route_versions
    WHERE id IN (
      'eeeeeeee-0001-4000-8000-000000000007',
      'eeeeeeee-0001-4000-8000-000000000008',
      'eeeeeeee-0001-4000-8000-000000000009'
    );
    DELETE FROM foundry.ai_modes
    WHERE id IN (
      'eeeeeeee-0001-4000-8000-000000000004',
      'eeeeeeee-0001-4000-8000-000000000005',
      'eeeeeeee-0001-4000-8000-000000000006'
    );
    DELETE FROM foundry.ai_models
    WHERE id = 'eeeeeeee-0001-4000-8000-000000000003';
    DELETE FROM foundry.provider_connections
    WHERE id = 'eeeeeeee-0001-4000-8000-000000000002';
    DELETE FROM foundry.provider_secrets
    WHERE id = 'eeeeeeee-0001-4000-8000-000000000001';
    ALTER TABLE foundry.provider_connections
      DROP CONSTRAINT provider_connections_kind_check,
      ADD CONSTRAINT provider_connections_kind_check
        CHECK (provider_kind IN ('openai', 'openrouter', 'anthropic', 'google', 'paddleocr'))
  `.execute(database);
}
