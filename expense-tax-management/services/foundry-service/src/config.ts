export interface FoundryConfig {
  readonly service: "foundry-service";
  readonly version: string;
  readonly port: number;
  readonly authProvider: AuthProvider;
  readonly databaseUrl: string;
  readonly auth: FoundryAuthConfig;
  readonly clerk?: ClerkConfig;
}

export type AuthProvider = "clerk" | "legacy";

export interface ClerkConfig {
  readonly issuerUrl: string;
  readonly jwksUrl: string;
  readonly tenantAudience: string;
  readonly platformAudience: string;
  readonly appServiceAudience: string;
  readonly foundryServiceAudience: string;
  readonly appServiceSubject: string;
  readonly foundryServiceSubject: string;
  readonly publishableKey?: string | undefined;
  readonly secretKey?: string | undefined;
  readonly webhookSigningSecret?: string | undefined;
}

export interface TokenAuthorityConfig {
  readonly issuer: string;
  readonly audience: string;
  readonly jwksUrl: string;
}

export interface FoundryAuthConfig {
  readonly platform: TokenAuthorityConfig;
  readonly service: TokenAuthorityConfig;
}

export interface FoundryConfigOptions {
  readonly version?: string;
  readonly port?: number;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

function requiredEnvironmentValue(
  env: Readonly<Record<string, string | undefined>>,
  key: string,
): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }

  return value;
}

function jwksUrl(
  env: Readonly<Record<string, string | undefined>>,
  key: string,
): string {
  const value = requiredEnvironmentValue(env, key);
  try {
    if (new URL(value).protocol !== "https:") {
      throw new Error("non-HTTPS URL");
    }
  } catch {
    throw new Error(`Invalid URL in environment variable: ${key}`);
  }

  return value;
}

function urlEnvironmentValue(
  env: Readonly<Record<string, string | undefined>>,
  key: string,
): string {
  const value = requiredEnvironmentValue(env, key);
  try {
    if (new URL(value).protocol !== "https:") {
      throw new Error("non-HTTPS URL");
    }
  } catch {
    throw new Error(`Invalid URL in environment variable: ${key}`);
  }

  return value;
}

function optionalEnvironmentValue(
  env: Readonly<Record<string, string | undefined>>,
  key: string,
): string | undefined {
  const value = env[key]?.trim();
  return value || undefined;
}

export function createFoundryConfig(
  options: FoundryConfigOptions = {},
): FoundryConfig {
  const port = options.port ?? 8200;
  const env = options.env ?? process.env;
  // Existing focused auth fixtures intentionally provide only auth variables.
  const databaseEnv =
    options.env?.FOUNDRY_DATABASE_URL === undefined &&
    options.env?.FOUNDRY_MIGRATION_DATABASE_URL === undefined
      ? process.env
      : env;

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Invalid application port");
  }

  const databaseUrl = requiredEnvironmentValue(
    databaseEnv,
    "FOUNDRY_DATABASE_URL",
  );
  const authProvider = env.AUTH_PROVIDER?.trim() || "clerk";
  if (authProvider !== "clerk" && authProvider !== "legacy") {
    throw new Error("Invalid AUTH_PROVIDER: expected clerk or legacy");
  }

  const clerk =
    authProvider === "clerk"
      ? {
          issuerUrl: urlEnvironmentValue(env, "CLERK_ISSUER_URL"),
          jwksUrl: urlEnvironmentValue(env, "CLERK_JWKS_URL"),
          tenantAudience: requiredEnvironmentValue(
            env,
            "CLERK_TENANT_AUDIENCE",
          ),
          platformAudience: requiredEnvironmentValue(
            env,
            "CLERK_PLATFORM_AUDIENCE",
          ),
           appServiceAudience: requiredEnvironmentValue(
            env,
            "CLERK_APP_SERVICE_AUDIENCE",
          ),
          foundryServiceAudience: requiredEnvironmentValue(
            env,
            "CLERK_FOUNDRY_SERVICE_AUDIENCE",
          ),
          appServiceSubject: requiredEnvironmentValue(
            env,
            "CLERK_APP_SERVICE_SUBJECT",
          ),
          foundryServiceSubject: requiredEnvironmentValue(
            env,
            "CLERK_FOUNDRY_SERVICE_SUBJECT",
          ),
          publishableKey: optionalEnvironmentValue(
            env,
            "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
          ),
          secretKey: optionalEnvironmentValue(env, "CLERK_SECRET_KEY"),
          webhookSigningSecret: optionalEnvironmentValue(
            env,
            "CLERK_WEBHOOK_SIGNING_SECRET",
          ),
        }
      : undefined;

  const config = {
    service: "foundry-service",
    version: options.version ?? "0.1.0",
    port,
    authProvider,
  } as FoundryConfig;

  Object.defineProperty(config, "databaseUrl", {
    enumerable: false,
    value: databaseUrl,
  });

  Object.defineProperty(config, "auth", {
    enumerable: false,
    value: {
      platform: {
        issuer: requiredEnvironmentValue(
          env,
          "FOUNDRY_PLATFORM_TOKEN_ISSUER",
        ),
        audience: requiredEnvironmentValue(
          env,
          "FOUNDRY_PLATFORM_TOKEN_AUDIENCE",
        ),
        jwksUrl: jwksUrl(env, "FOUNDRY_PLATFORM_JWKS_URL"),
      },
      service: {
        issuer: requiredEnvironmentValue(
          env,
          "FOUNDRY_SERVICE_TOKEN_ISSUER",
        ),
        audience: requiredEnvironmentValue(
          env,
          "FOUNDRY_SERVICE_TOKEN_AUDIENCE",
        ),
        jwksUrl: jwksUrl(env, "FOUNDRY_SERVICE_JWKS_URL"),
      },
    },
  });

  if (clerk !== undefined) {
    Object.defineProperty(config, "clerk", {
      enumerable: false,
      value: clerk,
    });
  }

  return config;
}
