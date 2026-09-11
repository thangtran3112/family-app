import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/u;
const CLERK_API_URL = "https://api.clerk.com";
const DEFAULT_TIMEOUT_MS = 10_000;

function validateRequiredValue(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} is required`);
  }
  if (CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new Error(`${field} contains unsafe characters`);
  }
  return value;
}

export function validateExternalId(value, field) {
  return validateRequiredValue(value, field);
}

function validateDatabaseUrl(value, field) {
  const validatedValue = validateRequiredValue(value, field);
  let parsedUrl;
  try {
    parsedUrl = new URL(validatedValue);
  } catch {
    throw new Error(`${field} must be a valid database URL`);
  }

  if (
    !["postgres:", "postgresql:"].includes(parsedUrl.protocol) ||
    parsedUrl.hostname === ""
  ) {
    throw new Error(`${field} must be a valid database URL`);
  }
  return validatedValue;
}

function validateDistinctIdentityAssignments(input, bootstrapEmpty = false) {
  const duplicateFields = [];
  const appTargets = bootstrapEmpty
    ? []
    : [
        ["APP_TENANT_ID", input.appTenantId],
        ["APP_THANG_USER_ID", input.thangAppUserId],
        ["APP_TRAMILY_USER_ID", input.tramilyAppUserId],
      ];
  if (input.thangClerkUserId === input.tramilyClerkUserId) {
    duplicateFields.push("CLERK_THANG_USER_ID", "CLERK_TRAMILY_USER_ID");
  }
  for (let index = 0; index < appTargets.length; index += 1) {
    for (let next = index + 1; next < appTargets.length; next += 1) {
      if (
        appTargets[index][1] !== undefined &&
        appTargets[next][1] !== undefined &&
        appTargets[index][1] === appTargets[next][1]
      ) {
        duplicateFields.push(appTargets[index][0], appTargets[next][0]);
      }
    }
  }
  if (duplicateFields.length > 0) {
    throw new Error(
      `invalid provisioning input: duplicate identity targets ${[...new Set(duplicateFields)].join(", ")}`,
    );
  }
}

export function parseProvisioningInput(env = process.env, options = {}) {
  const bootstrapEmpty = options.bootstrapEmpty === true;
  const missingOrInvalid = [];
  const read = (name, validator = validateRequiredValue) => {
    try {
      return validator(env[name], name);
    } catch {
      missingOrInvalid.push(name);
      return undefined;
    }
  };

  const values = {
    appDatabaseUrl: read("APP_DATABASE_URL", validateDatabaseUrl),
    foundryDatabaseUrl: read("FOUNDRY_DATABASE_URL", validateDatabaseUrl),
    clerkSecretKey: read("CLERK_SECRET_KEY"),
    clerkOrgId: read("CLERK_FAMILY_ORG_ID", validateExternalId),
    thangClerkUserId: read("CLERK_THANG_USER_ID", validateExternalId),
    tramilyClerkUserId: read("CLERK_TRAMILY_USER_ID", validateExternalId),
    appTenantId: bootstrapEmpty
      ? undefined
      : read("APP_TENANT_ID", validateExternalId),
    thangAppUserId: bootstrapEmpty
      ? undefined
      : read("APP_THANG_USER_ID", validateExternalId),
    tramilyAppUserId: bootstrapEmpty
      ? undefined
      : read("APP_TRAMILY_USER_ID", validateExternalId),
  };

  if (missingOrInvalid.length > 0) {
    throw new Error(
      `invalid provisioning input: ${[...new Set(missingOrInvalid)].join(", ")}`,
    );
  }

  validateDistinctIdentityAssignments(values, bootstrapEmpty);
  return values;
}

export function deterministicBootstrapUuid(kind, externalId) {
  const digest = createHash("sha256")
    .update(`expense-tax/bootstrap/${kind}/${externalId}`)
    .digest("hex")
    .slice(0, 32)
    .split("");
  digest[12] = "5";
  digest[16] = (parseInt(digest[16], 16) & 0x3 | 0x8).toString(16);
  return `${digest.slice(0, 8).join("")}-${digest.slice(8, 12).join("")}-${digest.slice(12, 16).join("")}-${digest.slice(16, 20).join("")}-${digest.slice(20).join("")}`;
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function databaseEnvironment(databaseUrl) {
  const parsedUrl = new URL(databaseUrl);
  const host = parsedUrl.hostname.startsWith("[")
    ? parsedUrl.hostname.slice(1, -1)
    : parsedUrl.hostname;
  return {
    PGHOST: host,
    PGPORT: parsedUrl.port || "5432",
    PGUSER: decodeURIComponent(parsedUrl.username),
    PGPASSWORD: decodeURIComponent(parsedUrl.password),
    PGDATABASE: decodeURIComponent(parsedUrl.pathname.slice(1)),
    PGSSLMODE: parsedUrl.searchParams.get("sslmode") || "require",
  };
}

export async function executePsql({
  databaseUrl,
  sql,
  env = process.env,
  spawnImpl = spawn,
}) {
  const databaseEnv = databaseEnvironment(databaseUrl);
  await new Promise((resolve, reject) => {
    const child = spawnImpl(
      "psql",
      ["--no-psqlrc", "--set=ON_ERROR_STOP=1", "--file=-"],
      {
      env: { ...env, ...databaseEnv },
      },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else {
        let redactedStderr = stderr.replaceAll(databaseUrl, "[REDACTED]");
        if (databaseEnv.PGPASSWORD !== "") {
          redactedStderr = redactedStderr.replaceAll(
            databaseEnv.PGPASSWORD,
            "[REDACTED]",
          );
        }
        reject(new Error(`psql failed with exit code ${code}: ${redactedStderr.slice(0, 200)}`));
      }
    });
    child.stdin.end(sql);
  });
}

function membershipRecord(data, expectedUserId, expectedOrgId) {
  return (data ?? []).find((membership) => {
    const userId =
      membership.public_user_data?.user_id ?? membership.user_id ?? membership.userId;
    const organizationId =
      membership.organization?.id ?? membership.organization_id ?? membership.organizationId;
    return userId === expectedUserId && organizationId === expectedOrgId;
  });
}

function assertMembershipRecord(record, userId, organizationId) {
  if (!record || !["org:member", "org:admin"].includes(record.role)) {
    throw new Error(`Clerk membership verification failed for ${userId} in ${organizationId}`);
  }
  return {
    userId,
    organizationId,
    role: record.role,
  };
}

export async function fetchClerkMemberships(input, options = {}) {
  validateDistinctIdentityAssignments(input);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const users = [input.thangClerkUserId, input.tramilyClerkUserId];
  const verified = [];

  for (const userId of users) {
    const url = new URL(
      `/v1/organizations/${encodeURIComponent(input.clerkOrgId)}/memberships`,
      options.apiUrl || CLERK_API_URL,
    );
    url.searchParams.set("user_id", userId);
    let response;
    try {
      response = await fetchImpl(url, {
        headers: {
          Authorization: `Bearer ${input.clerkSecretKey}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new Error(`Clerk membership request failed for ${userId}`);
    }
    if (!response.ok) {
      throw new Error(`Clerk membership request returned HTTP ${response.status}`);
    }
    let body;
    try {
      body = await response.json();
    } catch {
      throw new Error(`Clerk membership response was invalid for ${userId}`);
    }
    verified.push(
      assertMembershipRecord(
        membershipRecord(body.data, userId, input.clerkOrgId),
        userId,
        input.clerkOrgId,
      ),
    );
  }
  return verified;
}

function assertVerifiedMemberships(input, memberships) {
  for (const userId of [input.thangClerkUserId, input.tramilyClerkUserId]) {
    const match = memberships?.find(
      (membership) =>
        membership.userId === userId &&
        membership.organizationId === input.clerkOrgId &&
        ["org:member", "org:admin"].includes(membership.role),
    );
    if (!match) {
      throw new Error(`Clerk membership verification failed for ${userId}`);
    }
  }
}

function bootstrapIdentityIds(input) {
  const tenantId = deterministicBootstrapUuid("tenant", input.clerkOrgId);
  const thangUserId = deterministicBootstrapUuid("user", input.thangClerkUserId);
  const tramilyUserId = deterministicBootstrapUuid("user", input.tramilyClerkUserId);
  return {
    tenantId,
    thangUserId,
    tramilyUserId,
    personalProfileId: deterministicBootstrapUuid("personal-profile", tenantId),
  };
}

function bootstrapAppSql(input) {
  const ids = bootstrapIdentityIds(input);
  const tenantId = sqlLiteral(ids.tenantId);
  const thangUserId = sqlLiteral(ids.thangUserId);
  const tramilyUserId = sqlLiteral(ids.tramilyUserId);
  const profileId = sqlLiteral(ids.personalProfileId);
  const orgId = sqlLiteral(input.clerkOrgId);
  const thangClerkId = sqlLiteral(input.thangClerkUserId);
  const tramilyClerkId = sqlLiteral(input.tramilyClerkUserId);
  return `BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM app.users WHERE id NOT IN (${thangUserId}::uuid, ${tramilyUserId}::uuid))
     OR EXISTS (
       SELECT 1 FROM app.users
       WHERE id = ${thangUserId}::uuid
         AND (primary_email <> 'thangtran3112@gmail.com' OR display_name <> 'Thang Tran' OR status <> 'active'
           OR (clerk_user_id IS NOT NULL AND clerk_user_id <> ${thangClerkId}))
     )
     OR EXISTS (
       SELECT 1 FROM app.users
       WHERE id = ${tramilyUserId}::uuid
         AND (primary_email <> 'tramilyt@gmail.com' OR display_name <> 'Tramily Tran' OR status <> 'active'
           OR (clerk_user_id IS NOT NULL AND clerk_user_id <> ${tramilyClerkId}))
     ) THEN
    RAISE EXCEPTION 'unrelated existing or conflicting App users';
  END IF;
  IF EXISTS (SELECT 1 FROM app.tenants WHERE id <> ${tenantId}::uuid)
     OR EXISTS (
       SELECT 1 FROM app.tenants
       WHERE id = ${tenantId}::uuid
         AND (name <> 'Family' OR slug <> 'family' OR status <> 'active'
           OR (clerk_org_id IS NOT NULL AND clerk_org_id <> ${orgId}))
     ) THEN
    RAISE EXCEPTION 'unrelated existing or conflicting App tenants';
  END IF;
  IF EXISTS (
    SELECT 1 FROM app.tenant_memberships
    WHERE tenant_id = ${tenantId}::uuid AND user_id = ${thangUserId}::uuid
      AND (role <> 'owner' OR status <> 'active')
  ) OR EXISTS (
    SELECT 1 FROM app.tenant_memberships
    WHERE tenant_id = ${tenantId}::uuid AND user_id = ${tramilyUserId}::uuid
      AND (role <> 'member' OR status <> 'active')
  ) THEN
    RAISE EXCEPTION 'conflicting Family tenant membership';
  END IF;
  IF EXISTS (
    SELECT 1 FROM app.personal_profiles
    WHERE id = ${profileId}::uuid
      AND (tenant_id <> ${tenantId}::uuid OR name <> 'Family Personal')
  ) THEN
    RAISE EXCEPTION 'conflicting Family Personal profile';
  END IF;
  IF EXISTS (
    SELECT 1 FROM app.personal_memberships
    WHERE personal_profile_id = ${profileId}::uuid AND user_id = ${thangUserId}::uuid
      AND (tenant_id <> ${tenantId}::uuid OR role <> 'owner' OR status <> 'active')
  ) OR EXISTS (
    SELECT 1 FROM app.personal_memberships
    WHERE personal_profile_id = ${profileId}::uuid AND user_id = ${tramilyUserId}::uuid
      AND (tenant_id <> ${tenantId}::uuid OR role <> 'editor' OR status <> 'active')
  ) THEN
    RAISE EXCEPTION 'conflicting Family Personal membership';
  END IF;
END $$;
INSERT INTO app.tenants (id, name, slug, status, clerk_org_id)
VALUES (${tenantId}::uuid, 'Family', 'family', 'active', ${orgId})
ON CONFLICT (id) DO NOTHING;
INSERT INTO app.users (id, primary_email, display_name, status, clerk_user_id)
VALUES
  (${thangUserId}::uuid, 'thangtran3112@gmail.com', 'Thang Tran', 'active', ${thangClerkId}),
  (${tramilyUserId}::uuid, 'tramilyt@gmail.com', 'Tramily Tran', 'active', ${tramilyClerkId})
ON CONFLICT (id) DO NOTHING;
UPDATE app.tenants SET clerk_org_id = ${orgId}, updated_at = now()
WHERE id = ${tenantId}::uuid AND status = 'active';
UPDATE app.users SET clerk_user_id = ${thangClerkId}, updated_at = now()
WHERE id = ${thangUserId}::uuid AND status = 'active';
UPDATE app.users SET clerk_user_id = ${tramilyClerkId}, updated_at = now()
WHERE id = ${tramilyUserId}::uuid AND status = 'active';
INSERT INTO app.tenant_memberships (tenant_id, user_id, role, status)
VALUES
  (${tenantId}::uuid, ${thangUserId}::uuid, 'owner', 'active'),
  (${tenantId}::uuid, ${tramilyUserId}::uuid, 'member', 'active')
ON CONFLICT (tenant_id, user_id) DO NOTHING;
INSERT INTO app.personal_profiles (id, tenant_id, name)
VALUES (${profileId}::uuid, ${tenantId}::uuid, 'Family Personal')
ON CONFLICT (id) DO NOTHING;
INSERT INTO app.personal_memberships (personal_profile_id, tenant_id, user_id, role, status)
VALUES
  (${profileId}::uuid, ${tenantId}::uuid, ${thangUserId}::uuid, 'owner', 'active'),
  (${profileId}::uuid, ${tenantId}::uuid, ${tramilyUserId}::uuid, 'editor', 'active')
ON CONFLICT (personal_profile_id, user_id) DO NOTHING;
DO $$
BEGIN
  IF (SELECT count(*) FROM app.users WHERE id IN (${thangUserId}::uuid, ${tramilyUserId}::uuid)
      AND status = 'active' AND clerk_user_id IN (${thangClerkId}, ${tramilyClerkId})) <> 2
     OR (SELECT count(*) FROM app.tenants WHERE id = ${tenantId}::uuid
      AND status = 'active' AND clerk_org_id = ${orgId}) <> 1
     OR (SELECT count(*) FROM app.tenant_memberships
      WHERE tenant_id = ${tenantId}::uuid AND status = 'active') <> 2
     OR (SELECT count(*) FROM app.personal_profiles
      WHERE id = ${profileId}::uuid AND tenant_id = ${tenantId}::uuid) <> 1
     OR (SELECT count(*) FROM app.personal_memberships
      WHERE personal_profile_id = ${profileId}::uuid AND tenant_id = ${tenantId}::uuid
        AND status = 'active') <> 2 THEN
    RAISE EXCEPTION 'bootstrap rows failed exact verification';
  END IF;
END $$;
COMMIT;`;
}

function appMappingSql(input) {
  const users = [
    [input.thangAppUserId, input.thangClerkUserId],
    [input.tramilyAppUserId, input.tramilyClerkUserId],
  ];
  const checks = users
    .map(
      ([appUserId, clerkUserId]) => `
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM app.users
        WHERE id = ${sqlLiteral(appUserId)}::uuid
          AND status = 'active'
          AND (clerk_user_id IS NULL OR clerk_user_id = ${sqlLiteral(clerkUserId)})
      ) THEN
        RAISE EXCEPTION 'inactive, missing, or conflicting app user mapping';
      END IF;
    END $$;
    UPDATE app.users
      SET clerk_user_id = ${sqlLiteral(clerkUserId)}, updated_at = now()
      WHERE id = ${sqlLiteral(appUserId)}::uuid
        AND status = 'active'
        AND (clerk_user_id IS NULL OR clerk_user_id = ${sqlLiteral(clerkUserId)});
    DO $$
    BEGIN
      IF (SELECT count(*) FROM app.users WHERE id = ${sqlLiteral(appUserId)}::uuid AND clerk_user_id = ${sqlLiteral(clerkUserId)}) <> 1 THEN
        RAISE EXCEPTION 'app user mapping affected unexpected row count';
      END IF;
    END $$;`,
    )
    .join("\n");
  return `BEGIN;
${checks}
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM app.tenants
    WHERE id = ${sqlLiteral(input.appTenantId)}::uuid
      AND status = 'active'
      AND (clerk_org_id IS NULL OR clerk_org_id = ${sqlLiteral(input.clerkOrgId)})
  ) THEN
    RAISE EXCEPTION 'inactive, missing, or conflicting app tenant mapping';
  END IF;
END $$;
UPDATE app.tenants
  SET clerk_org_id = ${sqlLiteral(input.clerkOrgId)}, updated_at = now()
  WHERE id = ${sqlLiteral(input.appTenantId)}::uuid
    AND status = 'active'
    AND (clerk_org_id IS NULL OR clerk_org_id = ${sqlLiteral(input.clerkOrgId)});
DO $$
BEGIN
  IF (SELECT count(*) FROM app.tenants WHERE id = ${sqlLiteral(input.appTenantId)}::uuid AND clerk_org_id = ${sqlLiteral(input.clerkOrgId)}) <> 1 THEN
    RAISE EXCEPTION 'app tenant mapping affected unexpected row count';
  END IF;
END $$;
COMMIT;`;
}

function appMappingPreflightSql(input) {
  const users = [
    [input.thangAppUserId, input.thangClerkUserId],
    [input.tramilyAppUserId, input.tramilyClerkUserId],
  ];
  const checks = users
    .map(
      ([appUserId, clerkUserId]) => `
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM app.users
    WHERE id = ${sqlLiteral(appUserId)}::uuid
      AND status = 'active'
      AND (clerk_user_id IS NULL OR clerk_user_id = ${sqlLiteral(clerkUserId)})
  ) THEN
    RAISE EXCEPTION 'inactive, missing, or conflicting app user mapping';
  END IF;
END $$;`,
    )
    .join("\n");
  return `BEGIN READ ONLY;
${checks}
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM app.tenants
    WHERE id = ${sqlLiteral(input.appTenantId)}::uuid
      AND status = 'active'
      AND (clerk_org_id IS NULL OR clerk_org_id = ${sqlLiteral(input.clerkOrgId)})
  ) THEN
    RAISE EXCEPTION 'inactive, missing, or conflicting app tenant mapping';
  END IF;
END $$;
ROLLBACK;`;
}

function bootstrapPreflightSql(input) {
  const writeSql = bootstrapAppSql(input);
  const guardSql = writeSql.slice(0, writeSql.indexOf("INSERT INTO app.tenants"));
  return `${guardSql.replace("BEGIN;", "BEGIN READ ONLY;")}ROLLBACK;`;
}

export async function provisionAppMappings(input, memberships, options = {}) {
  validateDistinctIdentityAssignments(input, options.bootstrapEmpty === true);
  assertVerifiedMemberships(input, memberships);
  const runPsql =
    options.runPsql || ((details) => executePsql({ databaseUrl: input.appDatabaseUrl, ...details }));
  const writeSql = options.bootstrapEmpty ? bootstrapAppSql(input) : appMappingSql(input);
  const details = {
    env: databaseEnvironment(input.appDatabaseUrl),
    ...(options.bootstrapEmpty ? { bootstrapIds: bootstrapIdentityIds(input) } : {}),
  };
  if (options.dryRun) {
    await runPsql({
      sql: options.bootstrapEmpty
        ? bootstrapPreflightSql(input)
        : appMappingPreflightSql(input),
      env: details.env,
    });
    return details;
  }
  await runPsql({ ...details, sql: writeSql });
  return { ...details, sql: writeSql };
}

function foundryOperatorSql(input) {
  const userId = sqlLiteral(input.thangClerkUserId);
  return `BEGIN;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM foundry.platform_operator_identities
    WHERE clerk_user_id = ${userId} AND role IN ('operator', 'catalog_manager') AND status = 'disabled'
  ) THEN
    RAISE EXCEPTION 'disabled platform operator role conflict';
  END IF;
END $$;
INSERT INTO foundry.platform_operator_identities (clerk_user_id, role, status)
VALUES
  (${userId}, 'operator', 'active'),
  (${userId}, 'catalog_manager', 'active')
ON CONFLICT (clerk_user_id, role) DO UPDATE
  SET status = 'active', updated_at = now();
COMMIT;`;
}

function foundryOperatorPreflightSql(input) {
  const userId = sqlLiteral(input.thangClerkUserId);
  return `BEGIN READ ONLY;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM foundry.platform_operator_identities
    WHERE clerk_user_id = ${userId} AND role IN ('operator', 'catalog_manager') AND status = 'disabled'
  ) THEN
    RAISE EXCEPTION 'disabled platform operator role conflict';
  END IF;
END $$;
ROLLBACK;`;
}

export async function provisionFoundryOperator(input, options = {}) {
  validateDistinctIdentityAssignments(input);
  const runPsql =
    options.runPsql || ((details) => executePsql({ databaseUrl: input.foundryDatabaseUrl, ...details }));
  const writeSql = foundryOperatorSql(input);
  const details = {
    env: databaseEnvironment(input.foundryDatabaseUrl),
  };
  if (options.dryRun) {
    await runPsql({ sql: foundryOperatorPreflightSql(input), env: details.env });
    return details;
  }
  await runPsql({ ...details, sql: writeSql });
  return { ...details, sql: writeSql };
}

async function main() {
  const bootstrapEmpty = process.argv.includes("--bootstrap-empty");
  const input = parseProvisioningInput(process.env, { bootstrapEmpty });
  const dryRun = process.argv.includes("--dry-run") || process.env.PROVISION_PRODUCTION_CLERK_CONFIRM !== "Family-auth-release";
  const memberships = await fetchClerkMemberships(input);
  const app = await provisionAppMappings(input, memberships, { dryRun, bootstrapEmpty });
  const foundry = await provisionFoundryOperator(input, { dryRun });
  console.log(`${dryRun ? "dry-run" : "provisioned"}: Clerk memberships=2 app mappings=3 Foundry roles=2`);
  if (dryRun) {
    console.log(`SQL preflight: app host=${app.env.PGHOST} foundry host=${foundry.env.PGHOST}`);
    if (bootstrapEmpty) {
      console.log(`bootstrap IDs: ${JSON.stringify(app.bootstrapIds)}`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Production Clerk provisioning failed");
    process.exitCode = 1;
  });
}
