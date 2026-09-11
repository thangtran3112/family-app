import { spawn } from "node:child_process";

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

export function parseProvisioningInput(env = process.env) {
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
    appTenantId: read("APP_TENANT_ID", validateExternalId),
    thangAppUserId: read("APP_THANG_USER_ID", validateExternalId),
    tramilyAppUserId: read("APP_TRAMILY_USER_ID", validateExternalId),
  };

  if (missingOrInvalid.length > 0) {
    throw new Error(
      `invalid provisioning input: ${[...new Set(missingOrInvalid)].join(", ")}`,
    );
  }

  return values;
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

export async function provisionAppMappings(input, memberships, options = {}) {
  assertVerifiedMemberships(input, memberships);
  const runPsql =
    options.runPsql || ((details) => executePsql({ databaseUrl: input.appDatabaseUrl, ...details }));
  const details = {
    sql: appMappingSql(input),
    env: databaseEnvironment(input.appDatabaseUrl),
  };
  if (options.dryRun) return details;
  await runPsql(details);
  return details;
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

export async function provisionFoundryOperator(input, options = {}) {
  const runPsql =
    options.runPsql || ((details) => executePsql({ databaseUrl: input.foundryDatabaseUrl, ...details }));
  const details = {
    sql: foundryOperatorSql(input),
    env: databaseEnvironment(input.foundryDatabaseUrl),
  };
  if (options.dryRun) return details;
  await runPsql(details);
  return details;
}

async function main() {
  const input = parseProvisioningInput();
  const dryRun = process.argv.includes("--dry-run") || process.env.PROVISION_PRODUCTION_CLERK_CONFIRM !== "Family-auth-release";
  const memberships = await fetchClerkMemberships(input);
  const app = await provisionAppMappings(input, memberships, { dryRun });
  const foundry = await provisionFoundryOperator(input, { dryRun });
  console.log(`${dryRun ? "dry-run" : "provisioned"}: Clerk memberships=2 app mappings=3 Foundry roles=2`);
  if (dryRun) {
    console.log(`SQL preflight: app host=${app.env.PGHOST} foundry host=${foundry.env.PGHOST}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Production Clerk provisioning failed");
    process.exitCode = 1;
  });
}
