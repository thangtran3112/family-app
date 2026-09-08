export interface AppConfig {
  readonly service: "app-api";
  readonly version: string;
  readonly port: number;
  readonly databaseUrl: string;
  readonly auth: AppAuthConfig;
}

export interface TokenAuthorityConfig {
  readonly issuer: string;
  readonly audience: string;
  readonly jwksUrl: string;
}

export interface AppAuthConfig {
  readonly tenant: TokenAuthorityConfig;
  readonly service: TokenAuthorityConfig;
}

export interface AppConfigOptions {
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
    new URL(value);
  } catch {
    throw new Error(`Invalid URL in environment variable: ${key}`);
  }

  return value;
}

export function createAppConfig(options: AppConfigOptions = {}): AppConfig {
  const port = options.port ?? 8100;
  const env = options.env ?? process.env;
  // Existing focused auth fixtures intentionally provide only auth variables.
  const databaseEnv =
    options.env?.APP_DATABASE_URL === undefined &&
    options.env?.APP_MIGRATION_DATABASE_URL === undefined
      ? process.env
      : env;

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Invalid application port");
  }

  const databaseUrl = requiredEnvironmentValue(databaseEnv, "APP_DATABASE_URL");

  return {
    service: "app-api",
    version: options.version ?? "0.1.0",
    port,
    databaseUrl,
    auth: {
      tenant: {
        issuer: requiredEnvironmentValue(env, "APP_TENANT_TOKEN_ISSUER"),
        audience: requiredEnvironmentValue(env, "APP_TENANT_TOKEN_AUDIENCE"),
        jwksUrl: jwksUrl(env, "APP_TENANT_JWKS_URL"),
      },
      service: {
        issuer: requiredEnvironmentValue(env, "APP_SERVICE_TOKEN_ISSUER"),
        audience: requiredEnvironmentValue(env, "APP_SERVICE_TOKEN_AUDIENCE"),
        jwksUrl: jwksUrl(env, "APP_SERVICE_JWKS_URL"),
      },
    },
  };
}
