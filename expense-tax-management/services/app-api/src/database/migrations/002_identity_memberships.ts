import { type Kysely, sql } from "kysely";

export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE app.users (
      id uuid PRIMARY KEY,
      primary_email text NOT NULL,
      display_name text NOT NULL,
      status text NOT NULL DEFAULT 'active',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT users_primary_email_check
        CHECK (primary_email = lower(trim(primary_email))),
      CONSTRAINT users_display_name_check
        CHECK (char_length(trim(display_name)) BETWEEN 1 AND 100),
      CONSTRAINT users_status_check
        CHECK (status IN ('active', 'disabled'))
    )
  `.execute(database);

  await sql`
    CREATE TABLE app.auth_identities (
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
      issuer text NOT NULL,
      subject text NOT NULL,
      verified_email text NOT NULL,
      email_verified boolean NOT NULL,
      last_authenticated_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT auth_identities_issuer_subject_unique
        UNIQUE (issuer, subject),
      CONSTRAINT auth_identities_subject_check
        CHECK (char_length(trim(subject)) BETWEEN 1 AND 255),
      CONSTRAINT auth_identities_verified_email_check
        CHECK (verified_email = lower(trim(verified_email))),
      CONSTRAINT auth_identities_email_verified_check
        CHECK (email_verified)
    )
  `.execute(database);
  await sql`
    CREATE INDEX auth_identities_user_id_index
      ON app.auth_identities (user_id)
  `.execute(database);

  await sql`
    CREATE TABLE app.tenants (
      id uuid PRIMARY KEY,
      name text NOT NULL,
      slug text NOT NULL,
      status text NOT NULL DEFAULT 'active',
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      archived_at timestamptz,
      CONSTRAINT tenants_slug_unique UNIQUE (slug),
      CONSTRAINT tenants_name_check
        CHECK (char_length(trim(name)) BETWEEN 1 AND 100),
      CONSTRAINT tenants_slug_check
        CHECK (slug = lower(slug) AND slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
      CONSTRAINT tenants_status_check
        CHECK (status IN ('active', 'archived')),
      CONSTRAINT tenants_version_check CHECK (version > 0),
      CONSTRAINT tenants_archive_state_check
        CHECK (
          (status = 'active' AND archived_at IS NULL)
          OR (status = 'archived' AND archived_at IS NOT NULL)
        )
    )
  `.execute(database);

  await sql`
    CREATE TABLE app.tenant_memberships (
      tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
      role text NOT NULL,
      status text NOT NULL DEFAULT 'active',
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, user_id),
      CONSTRAINT tenant_memberships_role_check
        CHECK (role IN ('owner', 'admin', 'member')),
      CONSTRAINT tenant_memberships_status_check
        CHECK (status IN ('active', 'inactive')),
      CONSTRAINT tenant_memberships_version_check CHECK (version > 0)
    )
  `.execute(database);
  await sql`
    CREATE INDEX tenant_memberships_user_id_index
      ON app.tenant_memberships (user_id)
  `.execute(database);

  await sql`
    CREATE TABLE app.personal_profiles (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
      name text NOT NULL,
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT personal_profiles_tenant_unique UNIQUE (tenant_id),
      CONSTRAINT personal_profiles_id_tenant_unique UNIQUE (id, tenant_id),
      CONSTRAINT personal_profiles_name_check
        CHECK (char_length(trim(name)) BETWEEN 1 AND 100),
      CONSTRAINT personal_profiles_version_check CHECK (version > 0)
    )
  `.execute(database);

  await sql`
    CREATE TABLE app.personal_memberships (
      personal_profile_id uuid NOT NULL,
      tenant_id uuid NOT NULL,
      user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
      role text NOT NULL,
      status text NOT NULL DEFAULT 'active',
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (personal_profile_id, user_id),
      CONSTRAINT personal_memberships_profile_tenant_fk
        FOREIGN KEY (personal_profile_id, tenant_id)
        REFERENCES app.personal_profiles(id, tenant_id) ON DELETE CASCADE,
      CONSTRAINT personal_memberships_role_check
        CHECK (role IN ('owner', 'editor', 'viewer')),
      CONSTRAINT personal_memberships_status_check
        CHECK (status IN ('active', 'inactive')),
      CONSTRAINT personal_memberships_version_check CHECK (version > 0)
    )
  `.execute(database);
  await sql`
    CREATE INDEX personal_memberships_user_id_index
      ON app.personal_memberships (user_id)
  `.execute(database);

  await sql`
    CREATE TABLE app.tenant_invitations (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
      normalized_email text NOT NULL,
      tenant_role text NOT NULL,
      personal_profile_id uuid,
      personal_role text,
      token_hash text NOT NULL,
      expires_at timestamptz NOT NULL,
      accepted_at timestamptz,
      revoked_at timestamptz,
      created_by_user_id uuid NOT NULL REFERENCES app.users(id),
      accepted_by_user_id uuid REFERENCES app.users(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT tenant_invitations_token_hash_unique UNIQUE (token_hash),
      CONSTRAINT tenant_invitations_normalized_email_check
        CHECK (normalized_email = lower(trim(normalized_email))),
      CONSTRAINT tenant_invitations_tenant_role_check
        CHECK (tenant_role IN ('owner', 'admin', 'member')),
      CONSTRAINT tenant_invitations_personal_role_check
        CHECK (personal_role IS NULL OR personal_role IN ('owner', 'editor', 'viewer')),
      CONSTRAINT tenant_invitations_personal_grant_check
        CHECK (
          (personal_profile_id IS NULL AND personal_role IS NULL)
          OR (personal_profile_id IS NOT NULL AND personal_role IS NOT NULL)
        ),
      CONSTRAINT tenant_invitations_profile_tenant_fk
        FOREIGN KEY (personal_profile_id, tenant_id)
        REFERENCES app.personal_profiles(id, tenant_id),
      CONSTRAINT tenant_invitations_acceptance_check
        CHECK (
          (accepted_at IS NULL AND accepted_by_user_id IS NULL)
          OR (accepted_at IS NOT NULL AND accepted_by_user_id IS NOT NULL)
        ),
      CONSTRAINT tenant_invitations_terminal_state_check
        CHECK (accepted_at IS NULL OR revoked_at IS NULL)
    )
  `.execute(database);
  await sql`
    CREATE INDEX tenant_invitations_tenant_email_index
      ON app.tenant_invitations (tenant_id, normalized_email)
  `.execute(database);

  await sql`
    CREATE TABLE app.app_audit_events (
      id uuid PRIMARY KEY,
      tenant_id uuid REFERENCES app.tenants(id) ON DELETE SET NULL,
      actor_user_id uuid REFERENCES app.users(id) ON DELETE SET NULL,
      actor_service_principal text,
      action text NOT NULL,
      outcome text NOT NULL,
      resource_type text NOT NULL,
      resource_id uuid,
      request_id text NOT NULL,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT app_audit_events_outcome_check
        CHECK (outcome IN ('success', 'denied', 'failure')),
      CONSTRAINT app_audit_events_actor_check
        CHECK (actor_user_id IS NOT NULL OR actor_service_principal IS NOT NULL)
    )
  `.execute(database);
  await sql`
    CREATE INDEX app_audit_events_tenant_created_index
      ON app.app_audit_events (tenant_id, created_at DESC)
  `.execute(database);

  await sql`
    CREATE TABLE app.idempotency_records (
      id uuid PRIMARY KEY,
      actor_key text NOT NULL,
      operation_key text NOT NULL,
      idempotency_key text NOT NULL,
      request_hash text NOT NULL,
      response_status smallint NOT NULL,
      response_body jsonb NOT NULL,
      resource_type text,
      resource_id uuid,
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT idempotency_records_actor_operation_key_unique
        UNIQUE (actor_key, operation_key, idempotency_key),
      CONSTRAINT idempotency_records_request_hash_check
        CHECK (request_hash ~ '^[a-f0-9]{64}$'),
      CONSTRAINT idempotency_records_response_status_check
        CHECK (response_status BETWEEN 200 AND 299)
    )
  `.execute(database);
  await sql`
    CREATE INDEX idempotency_records_expires_at_index
      ON app.idempotency_records (expires_at)
  `.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  await database.schema.dropTable("app.idempotency_records").execute();
  await database.schema.dropTable("app.app_audit_events").execute();
  await database.schema.dropTable("app.tenant_invitations").execute();
  await database.schema.dropTable("app.personal_memberships").execute();
  await database.schema.dropTable("app.personal_profiles").execute();
  await database.schema.dropTable("app.tenant_memberships").execute();
  await database.schema.dropTable("app.tenants").execute();
  await database.schema.dropTable("app.auth_identities").execute();
  await database.schema.dropTable("app.users").execute();
}
