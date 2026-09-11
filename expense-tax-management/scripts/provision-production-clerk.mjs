const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/u;

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

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    parseProvisioningInput();
    console.log("Production Clerk provisioning input validated");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
