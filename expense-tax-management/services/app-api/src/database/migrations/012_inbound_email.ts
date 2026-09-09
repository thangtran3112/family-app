import { type Kysely, sql } from "kysely";

export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE app.expenses
      DROP CONSTRAINT expenses_source_check,
      ADD CONSTRAINT expenses_source_check
        CHECK (source IN ('manual', 'ocr', 'forwarded_email'))
  `.execute(database);
  await sql`
    CREATE TABLE app.verified_email_senders (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
      personal_profile_id uuid,
      business_id uuid,
      email text NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      challenge_hash text,
      challenge_expires_at timestamptz,
      verified_at timestamptz,
      created_by_user_id uuid NOT NULL REFERENCES app.users(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT verified_email_senders_profile_tenant_fk
        FOREIGN KEY (personal_profile_id, tenant_id)
        REFERENCES app.personal_profiles(id, tenant_id),
      CONSTRAINT verified_email_senders_business_tenant_fk
        FOREIGN KEY (business_id, tenant_id)
        REFERENCES app.businesses(id, tenant_id),
      CONSTRAINT verified_email_senders_scope_check
        CHECK ((personal_profile_id IS NULL) <> (business_id IS NULL)),
      CONSTRAINT verified_email_senders_email_check
        CHECK (email = lower(trim(email)) AND position('@' in email) > 1),
      CONSTRAINT verified_email_senders_status_check
        CHECK (status IN ('pending', 'verified', 'revoked')),
      CONSTRAINT verified_email_senders_challenge_state_check
        CHECK (
          (status = 'pending' AND challenge_hash IS NOT NULL AND challenge_expires_at IS NOT NULL)
          OR (status <> 'pending' AND challenge_hash IS NULL AND challenge_expires_at IS NULL)
        )
    )
  `.execute(database);
  await sql`
    CREATE UNIQUE INDEX verified_email_senders_personal_unique
      ON app.verified_email_senders (tenant_id, personal_profile_id, email)
      WHERE personal_profile_id IS NOT NULL AND status <> 'revoked'
  `.execute(database);
  await sql`
    CREATE UNIQUE INDEX verified_email_senders_business_unique
      ON app.verified_email_senders (tenant_id, business_id, email)
      WHERE business_id IS NOT NULL AND status <> 'revoked'
  `.execute(database);

  await sql`
    CREATE TABLE app.inbound_routing_tokens (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
      personal_profile_id uuid,
      business_id uuid,
      token_hash text NOT NULL UNIQUE,
      status text NOT NULL DEFAULT 'active',
      created_by_user_id uuid NOT NULL REFERENCES app.users(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      revoked_at timestamptz,
      CONSTRAINT inbound_routing_tokens_profile_tenant_fk
        FOREIGN KEY (personal_profile_id, tenant_id)
        REFERENCES app.personal_profiles(id, tenant_id),
      CONSTRAINT inbound_routing_tokens_business_tenant_fk
        FOREIGN KEY (business_id, tenant_id)
        REFERENCES app.businesses(id, tenant_id),
      CONSTRAINT inbound_routing_tokens_scope_check
        CHECK ((personal_profile_id IS NULL) <> (business_id IS NULL)),
      CONSTRAINT inbound_routing_tokens_hash_check
        CHECK (token_hash ~ '^[a-f0-9]{64}$'),
      CONSTRAINT inbound_routing_tokens_status_check
        CHECK (status IN ('active', 'revoked')),
      CONSTRAINT inbound_routing_tokens_revoke_state_check
        CHECK (
          (status = 'active' AND revoked_at IS NULL)
          OR (status = 'revoked' AND revoked_at IS NOT NULL)
        )
    )
  `.execute(database);
  await sql`
    CREATE UNIQUE INDEX inbound_routing_tokens_one_personal_active
      ON app.inbound_routing_tokens (tenant_id, personal_profile_id)
      WHERE personal_profile_id IS NOT NULL AND status = 'active'
  `.execute(database);
  await sql`
    CREATE UNIQUE INDEX inbound_routing_tokens_one_business_active
      ON app.inbound_routing_tokens (tenant_id, business_id)
      WHERE business_id IS NOT NULL AND status = 'active'
  `.execute(database);

  await sql`
    CREATE TABLE app.inbound_emails (
      id uuid PRIMARY KEY,
      tenant_id uuid REFERENCES app.tenants(id) ON DELETE CASCADE,
      personal_profile_id uuid,
      business_id uuid,
      routing_token_id uuid REFERENCES app.inbound_routing_tokens(id) ON DELETE SET NULL,
      provider_message_id text NOT NULL UNIQUE,
      sender_email text NOT NULL,
      recipient_address text NOT NULL,
      subject text,
      content_hash text NOT NULL,
      auth_results jsonb NOT NULL,
      status text NOT NULL,
      quarantine_reason text,
      attachment_count integer NOT NULL,
      total_bytes integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      processed_at timestamptz,
      CONSTRAINT inbound_emails_scope_check
        CHECK (
          (tenant_id IS NULL AND personal_profile_id IS NULL AND business_id IS NULL)
          OR (tenant_id IS NOT NULL AND ((personal_profile_id IS NULL) <> (business_id IS NULL)))
        ),
      CONSTRAINT inbound_emails_status_check
        CHECK (status IN ('ACCEPTED', 'QUARANTINED', 'DISMISSED')),
      CONSTRAINT inbound_emails_reason_check
        CHECK ((status = 'ACCEPTED' AND quarantine_reason IS NULL) OR status <> 'ACCEPTED'),
      CONSTRAINT inbound_emails_hash_check CHECK (content_hash ~ '^[a-f0-9]{64}$'),
      CONSTRAINT inbound_emails_counts_check
        CHECK (attachment_count >= 0 AND total_bytes >= 0)
    )
  `.execute(database);
  await sql`
    CREATE INDEX inbound_emails_scope_created_index
      ON app.inbound_emails (tenant_id, created_at DESC)
  `.execute(database);
  await sql`
    CREATE INDEX inbound_emails_token_rate_index
      ON app.inbound_emails (routing_token_id, created_at DESC)
      WHERE routing_token_id IS NOT NULL
  `.execute(database);
  await sql`
    CREATE UNIQUE INDEX inbound_emails_content_dedupe_index
      ON app.inbound_emails (tenant_id, content_hash)
      WHERE tenant_id IS NOT NULL AND status = 'ACCEPTED'
  `.execute(database);

  await sql`
    CREATE TABLE app.inbound_email_attachments (
      id uuid PRIMARY KEY,
      inbound_email_id uuid NOT NULL REFERENCES app.inbound_emails(id) ON DELETE CASCADE,
      expense_file_id uuid REFERENCES app.expense_files(id) ON DELETE SET NULL,
      original_filename text NOT NULL,
      content_type text NOT NULL,
      size_bytes integer NOT NULL,
      sha256_hex text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT inbound_email_attachments_type_check
        CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
      CONSTRAINT inbound_email_attachments_size_check CHECK (size_bytes > 0),
      CONSTRAINT inbound_email_attachments_hash_check CHECK (sha256_hex ~ '^[a-f0-9]{64}$')
    )
  `.execute(database);

  await sql`
    CREATE TABLE app.inbound_email_quarantine_events (
      id uuid PRIMARY KEY,
      inbound_email_id uuid NOT NULL REFERENCES app.inbound_emails(id) ON DELETE CASCADE,
      reason text NOT NULL,
      actor_user_id uuid REFERENCES app.users(id),
      action text NOT NULL DEFAULT 'QUARANTINED',
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT inbound_email_quarantine_events_action_check
        CHECK (action IN ('QUARANTINED', 'DISMISSED'))
    )
  `.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  await database.schema.dropTable("app.inbound_email_quarantine_events").ifExists().execute();
  await database.schema.dropTable("app.inbound_email_attachments").ifExists().execute();
  await database.schema.dropTable("app.inbound_emails").ifExists().execute();
  await database.schema.dropTable("app.inbound_routing_tokens").ifExists().execute();
  await database.schema.dropTable("app.verified_email_senders").ifExists().execute();
  await sql`
    ALTER TABLE app.expenses
      DROP CONSTRAINT expenses_source_check,
      ADD CONSTRAINT expenses_source_check
        CHECK (source IN ('manual', 'ocr'))
  `.execute(database);
}
