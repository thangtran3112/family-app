import { randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createAppDatabase } from "../../services/app-api/src/database/client.js";
import type { AppDatabase } from "../../services/app-api/src/database/types.js";
import { createIdentityDomain } from "../../services/app-api/src/domain/identity.js";
import { createMembershipDomain } from "../../services/app-api/src/domain/memberships.js";
import { createTenantDomain } from "../../services/app-api/src/domain/tenants.js";
import type { Kysely } from "kysely";

const integrationEnabled = process.env.PHASE_0J_INTEGRATION === "1";
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const composeScript = path.join(repoRoot, "scripts", "compose.sh");
const runKey = randomUUID().slice(0, 8);

let postgresContainerId = "";
let runtimePassword = "";
let database: Kysely<AppDatabase>;

interface CommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface ComposeConfig {
  readonly services: Record<
    string,
    { readonly environment?: Record<string, string | null> }
  >;
}

function runSql(sql: string): CommandResult {
  return spawnSync(
    "docker",
    [
      "exec",
      "-e",
      `PGPASSWORD=${runtimePassword}`,
      postgresContainerId,
      "psql",
      "-X",
      "-v",
      "ON_ERROR_STOP=1",
      "--host",
      "127.0.0.1",
      "--username",
      "expense_app_runtime",
      "--dbname",
      "expense_tax_db",
      "--tuples-only",
      "--no-align",
      "--pset",
      "footer=off",
      "--command",
      sql,
    ],
    { encoding: "utf8" },
  );
}

function executeSql(sql: string): string {
  const result = runSql(sql);
  if (result.status !== 0) {
    throw new Error(result.stderr || `psql exited with status ${result.status}`);
  }
  return result.stdout.trim();
}

function expectConstraint(sql: string, constraintName: string): void {
  const result = runSql(sql);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(constraintName);
}

function insertUser(id: string, suffix: string): void {
  executeSql(`
    INSERT INTO app.users (id, primary_email, display_name)
    VALUES ('${id}', 'wave1-${runKey}-${suffix}@example.test', 'Wave 1 User');
  `);
}

function insertTenant(id: string, suffix: string): void {
  executeSql(`
    INSERT INTO app.tenants (id, name, slug)
    VALUES ('${id}', 'Wave 1 Tenant', 'wave1-${runKey}-${suffix}');
  `);
}

describe.skipIf(!integrationEnabled)("Phase 0J Wave 1 database schema", () => {
  beforeAll(() => {
    const config = JSON.parse(
      execFileSync(composeScript, ["config", "--format", "json"], {
        cwd: repoRoot,
        env: process.env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    ) as ComposeConfig;
    postgresContainerId = execFileSync(
      composeScript,
      ["ps", "-q", "postgres"],
      { cwd: repoRoot, env: process.env, encoding: "utf8" },
    ).trim();
    runtimePassword =
      config.services.postgres?.environment?.APP_RUNTIME_DB_PASSWORD ?? "";

    if (!postgresContainerId || !runtimePassword) {
      throw new Error("Phase 0J PostgreSQL integration prerequisites are missing");
    }
    database = createAppDatabase(
      `postgresql://expense_app_runtime:${encodeURIComponent(runtimePassword)}@127.0.0.1:5433/expense_tax_db`,
    );
  });

  afterAll(async () => {
    if (!postgresContainerId || !runtimePassword) return;
    if (runSql("SELECT to_regclass('app.users');").stdout.trim() !== "app.users") {
      await database?.destroy();
      return;
    }

    runSql(`DELETE FROM app.tenants WHERE slug LIKE 'wave1-${runKey}-%';`);
    runSql(
      `DELETE FROM app.users WHERE primary_email LIKE 'wave1-${runKey}-%';`,
    );
    runSql(
      `DELETE FROM app.app_audit_events WHERE request_id LIKE 'wave1-${runKey}-%';`,
    );
    runSql(
      `DELETE FROM app.idempotency_records WHERE idempotency_key LIKE 'wave1-${runKey}-%';`,
    );
    await database.destroy();
  });

  it("creates all Wave 1 tables", () => {
    expect(
      executeSql(`
        SELECT string_agg(name, ',' ORDER BY name)
        FROM unnest(ARRAY[
          'app.app_audit_events',
          'app.auth_identities',
          'app.idempotency_records',
          'app.personal_memberships',
          'app.personal_profiles',
          'app.tenant_invitations',
          'app.tenant_memberships',
          'app.tenants',
          'app.users'
        ]) AS name
        WHERE to_regclass(name) IS NOT NULL;
      `),
    ).toBe(
      "app.app_audit_events,app.auth_identities,app.idempotency_records,app.personal_memberships,app.personal_profiles,app.tenant_invitations,app.tenant_memberships,app.tenants,app.users",
    );
  });

  it("rejects duplicate issuer and subject without linking by email", () => {
    const firstUserId = randomUUID();
    const secondUserId = randomUUID();
    insertUser(firstUserId, "identity-a");
    insertUser(secondUserId, "identity-b");
    executeSql(`
      INSERT INTO app.auth_identities
        (id, user_id, issuer, subject, verified_email, email_verified)
      VALUES
        ('${randomUUID()}', '${firstUserId}', 'https://identity.test', 'subject-${runKey}', 'wave1-${runKey}-shared@example.test', true);
    `);

    expectConstraint(
      `
        INSERT INTO app.auth_identities
          (id, user_id, issuer, subject, verified_email, email_verified)
        VALUES
          ('${randomUUID()}', '${secondUserId}', 'https://identity.test', 'subject-${runKey}', 'wave1-${runKey}-shared@example.test', true);
      `,
      "auth_identities_issuer_subject_unique",
    );
  });

  it("enforces one Personal profile and matching profile tenant", () => {
    const userId = randomUUID();
    const firstTenantId = randomUUID();
    const secondTenantId = randomUUID();
    const profileId = randomUUID();
    insertUser(userId, "profile");
    insertTenant(firstTenantId, "profile-a");
    insertTenant(secondTenantId, "profile-b");
    executeSql(`
      INSERT INTO app.personal_profiles (id, tenant_id, name)
      VALUES ('${profileId}', '${firstTenantId}', 'Personal');
    `);

    expectConstraint(
      `
        INSERT INTO app.personal_profiles (id, tenant_id, name)
        VALUES ('${randomUUID()}', '${firstTenantId}', 'Other Personal');
      `,
      "personal_profiles_tenant_unique",
    );
    expectConstraint(
      `
        INSERT INTO app.personal_memberships
          (personal_profile_id, tenant_id, user_id, role)
        VALUES
          ('${profileId}', '${secondTenantId}', '${userId}', 'viewer');
      `,
      "personal_memberships_profile_tenant_fk",
    );
  });

  it("rejects malformed invitation grants and non-normalized email", () => {
    const userId = randomUUID();
    const tenantId = randomUUID();
    const profileId = randomUUID();
    insertUser(userId, "invitation");
    insertTenant(tenantId, "invitation");
    executeSql(`
      INSERT INTO app.personal_profiles (id, tenant_id, name)
      VALUES ('${profileId}', '${tenantId}', 'Personal');
    `);

    expectConstraint(
      `
        INSERT INTO app.tenant_invitations
          (id, tenant_id, normalized_email, tenant_role, personal_profile_id,
           token_hash, expires_at, created_by_user_id)
        VALUES
          ('${randomUUID()}', '${tenantId}', 'member@example.test', 'member',
           '${profileId}', '${"a".repeat(64)}', now() + interval '7 days', '${userId}');
      `,
      "tenant_invitations_personal_grant_check",
    );
    expectConstraint(
      `
        INSERT INTO app.tenant_invitations
          (id, tenant_id, normalized_email, tenant_role, token_hash,
           expires_at, created_by_user_id)
        VALUES
          ('${randomUUID()}', '${tenantId}', 'Member@Example.test', 'member',
           '${"b".repeat(64)}', now() + interval '7 days', '${userId}');
      `,
      "tenant_invitations_normalized_email_check",
    );
  });

  it("provisions by issuer and subject without linking matching email", async () => {
    const identityDomain = createIdentityDomain(database);
    const sharedEmail = `wave1-${runKey}-shared@example.test`;
    const firstInput = {
      identity: {
        issuer: "https://identity.test",
        subject: `wave1-${runKey}-subject-a`,
        email: sharedEmail,
        emailVerified: true as const,
        displayName: "First Identity",
      },
      actorServicePrincipal: "gateway-auth",
      requestId: `wave1-${runKey}-provision-a`,
    };

    const first = await identityDomain.provision(firstInput);
    const repeated = await identityDomain.provision({
      ...firstInput,
      requestId: `wave1-${runKey}-provision-a-repeat`,
    });
    const second = await identityDomain.provision({
      identity: {
        ...firstInput.identity,
        subject: `wave1-${runKey}-subject-b`,
        displayName: "Second Identity",
      },
      actorServicePrincipal: "gateway-auth",
      requestId: `wave1-${runKey}-provision-b`,
    });

    expect(first.created).toBe(true);
    expect(repeated.created).toBe(false);
    expect(repeated.user.id).toBe(first.user.id);
    expect(second.created).toBe(true);
    expect(second.user.id).not.toBe(first.user.id);
    expect(
      executeSql(`
        SELECT count(*)
        FROM app.auth_identities
        WHERE issuer = 'https://identity.test'
          AND subject LIKE 'wave1-${runKey}-subject-%';
      `),
    ).toBe("2");
    expect(
      executeSql(`
        SELECT count(*)
        FROM app.users
        WHERE primary_email = '${sharedEmail}';
      `),
    ).toBe("2");
  });

  it("bootstraps one tenant under concurrent idempotent requests", async () => {
    const identityDomain = createIdentityDomain(database);
    const tenantDomain = createTenantDomain(database);
    const provisioned = await identityDomain.provision({
      identity: {
        issuer: "https://identity.test",
        subject: `wave1-${runKey}-tenant-owner`,
        email: `wave1-${runKey}-tenant-owner@example.test`,
        emailVerified: true,
        displayName: "Tenant Owner",
      },
      actorServicePrincipal: "gateway-auth",
      requestId: `wave1-${runKey}-tenant-owner-provision`,
    });
    const createInput = {
      actorUserId: provisioned.user.id,
      request: { name: "Concurrent Family" },
      idempotencyKey: `wave1-${runKey}-tenant-create`,
      requestId: `wave1-${runKey}-tenant-create`,
    };

    const [first, concurrentReplay] = await Promise.all([
      tenantDomain.create(createInput),
      tenantDomain.create({
        ...createInput,
        requestId: `wave1-${runKey}-tenant-create-concurrent`,
      }),
    ]);

    expect(first.body.tenant.id).toBe(concurrentReplay.body.tenant.id);
    expect([first.replayed, concurrentReplay.replayed].sort()).toEqual([
      false,
      true,
    ]);
    await expect(
      tenantDomain.create({
        ...createInput,
        request: { name: "Conflicting Family" },
        requestId: `wave1-${runKey}-tenant-create-conflict`,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", statusCode: 409 });

    const tenantId = first.body.tenant.id;
    const profileId = first.body.personalProfile.id;
    expect(
      executeSql(`
        SELECT concat_ws('|',
          (SELECT count(*) FROM app.tenants WHERE id = '${tenantId}'),
          (SELECT count(*) FROM app.tenant_memberships WHERE tenant_id = '${tenantId}'),
          (SELECT count(*) FROM app.personal_profiles WHERE tenant_id = '${tenantId}'),
          (SELECT count(*) FROM app.personal_memberships WHERE tenant_id = '${tenantId}'),
          (SELECT count(*) FROM app.idempotency_records
            WHERE idempotency_key = '${createInput.idempotencyKey}')
        );
      `),
    ).toBe("1|1|1|1|1");
    expect(first.body.tenantMembership.role).toBe("owner");
    expect(first.body.personalMembership).toMatchObject({
      personalProfileId: profileId,
      role: "owner",
    });

    await expect(tenantDomain.list(provisioned.user.id)).resolves.toHaveLength(1);
    await expect(tenantDomain.get(provisioned.user.id, tenantId)).resolves.toMatchObject({
      id: tenantId,
    });
    await expect(
      tenantDomain.update({
        actorUserId: provisioned.user.id,
        tenantId,
        request: { name: "Updated Family", expectedVersion: 1 },
        requestId: `wave1-${runKey}-tenant-update`,
      }),
    ).resolves.toMatchObject({ name: "Updated Family", version: 2 });
    await expect(
      tenantDomain.update({
        actorUserId: provisioned.user.id,
        tenantId,
        request: { name: "Stale Family", expectedVersion: 1 },
        requestId: `wave1-${runKey}-tenant-update-stale`,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", statusCode: 409 });
  });

  it("isolates tenant invitations and serializes final-owner changes", async () => {
    const identityDomain = createIdentityDomain(database);
    const tenantDomain = createTenantDomain(database);
    const membershipDomain = createMembershipDomain(database, {
      error: () => undefined,
    });
    const owner = await identityDomain.provision({
      identity: {
        issuer: "https://identity.test",
        subject: `wave1-${runKey}-membership-owner`,
        email: `wave1-${runKey}-membership-owner@example.test`,
        emailVerified: true,
        displayName: "Membership Owner",
      },
      actorServicePrincipal: "gateway-auth",
      requestId: `wave1-${runKey}-membership-owner-provision`,
    });
    const secondOwner = await identityDomain.provision({
      identity: {
        issuer: "https://identity.test",
        subject: `wave1-${runKey}-membership-second-owner`,
        email: `wave1-${runKey}-membership-second-owner@example.test`,
        emailVerified: true,
        displayName: "Second Owner",
      },
      actorServicePrincipal: "gateway-auth",
      requestId: `wave1-${runKey}-membership-second-owner-provision`,
    });
    const invitee = await identityDomain.provision({
      identity: {
        issuer: "https://identity.test",
        subject: `wave1-${runKey}-tenant-only-invitee`,
        email: `wave1-${runKey}-tenant-only-invitee@example.test`,
        emailVerified: true,
        displayName: "Tenant Only Invitee",
      },
      actorServicePrincipal: "gateway-auth",
      requestId: `wave1-${runKey}-tenant-only-invitee-provision`,
    });
    const bootstrap = await tenantDomain.create({
      actorUserId: owner.user.id,
      request: { name: "Membership Family" },
      idempotencyKey: `wave1-${runKey}-membership-tenant`,
      requestId: `wave1-${runKey}-membership-tenant`,
    });
    const tenantId = bootstrap.body.tenant.id;
    const profileId = bootstrap.body.personalProfile.id;

    const tenantOnlyInvitation = await membershipDomain.createInvitation({
      actorUserId: owner.user.id,
      tenantId,
      request: {
        email: invitee.user.primaryEmail,
        tenantRole: "admin",
        grant: { type: "none" },
      },
      requestId: `wave1-${runKey}-tenant-only-invitation`,
    });
    expect(tenantOnlyInvitation.invitationToken).toHaveLength(43);
    expect(
      executeSql(`
        SELECT concat_ws('|', char_length(token_hash), token_hash = '${tenantOnlyInvitation.invitationToken}')
        FROM app.tenant_invitations
        WHERE id = '${tenantOnlyInvitation.invitation.id}';
      `),
    ).toBe("64|f");
    await membershipDomain.acceptInvitation({
      actorUserId: invitee.user.id,
      request: { token: tenantOnlyInvitation.invitationToken },
      requestId: `wave1-${runKey}-tenant-only-accept`,
    });
    expect(
      executeSql(`
        SELECT concat_ws('|',
          (SELECT count(*) FROM app.tenant_memberships
            WHERE tenant_id = '${tenantId}' AND user_id = '${invitee.user.id}' AND status = 'active'),
          (SELECT count(*) FROM app.personal_memberships
            WHERE personal_profile_id = '${profileId}' AND user_id = '${invitee.user.id}')
        );
      `),
    ).toBe("1|0");
    await expect(
      membershipDomain.listPersonalMemberships({
        actorUserId: invitee.user.id,
        tenantId,
        profileId,
        requestId: `wave1-${runKey}-tenant-admin-personal-denied`,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", statusCode: 403 });

    await membershipDomain.createPersonalMembership({
      actorUserId: owner.user.id,
      tenantId,
      profileId,
      request: { userId: secondOwner.user.id, role: "owner" },
      requestId: `wave1-${runKey}-second-personal-owner`,
    });
    await membershipDomain.updateTenantMembership({
      actorUserId: owner.user.id,
      tenantId,
      targetUserId: secondOwner.user.id,
      request: { expectedVersion: 1, role: "owner" },
      requestId: `wave1-${runKey}-second-tenant-owner`,
    });

    const tenantDemotions = await Promise.allSettled([
      membershipDomain.updateTenantMembership({
        actorUserId: owner.user.id,
        tenantId,
        targetUserId: owner.user.id,
        request: { expectedVersion: 1, role: "member" },
        requestId: `wave1-${runKey}-tenant-owner-a-demote`,
      }),
      membershipDomain.updateTenantMembership({
        actorUserId: secondOwner.user.id,
        tenantId,
        targetUserId: secondOwner.user.id,
        request: { expectedVersion: 2, role: "member" },
        requestId: `wave1-${runKey}-tenant-owner-b-demote`,
      }),
    ]);
    expect(tenantDemotions.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(tenantDemotions.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(
      executeSql(`
        SELECT count(*) FROM app.tenant_memberships
        WHERE tenant_id = '${tenantId}' AND role = 'owner' AND status = 'active';
      `),
    ).toBe("1");

    const personalDemotions = await Promise.allSettled([
      membershipDomain.updatePersonalMembership({
        actorUserId: owner.user.id,
        tenantId,
        profileId,
        targetUserId: owner.user.id,
        request: { expectedVersion: 1, role: "viewer" },
        requestId: `wave1-${runKey}-personal-owner-a-demote`,
      }),
      membershipDomain.updatePersonalMembership({
        actorUserId: secondOwner.user.id,
        tenantId,
        profileId,
        targetUserId: secondOwner.user.id,
        request: { expectedVersion: 1, role: "viewer" },
        requestId: `wave1-${runKey}-personal-owner-b-demote`,
      }),
    ]);
    expect(personalDemotions.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(personalDemotions.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(
      executeSql(`
        SELECT count(*) FROM app.personal_memberships
        WHERE personal_profile_id = '${profileId}' AND role = 'owner' AND status = 'active';
      `),
    ).toBe("1");
  });
});
