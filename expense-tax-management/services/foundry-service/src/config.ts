export interface FoundryConfig {
  readonly service: "foundry-service";
  readonly version: string;
  readonly port: number;
  readonly databaseUrl: string;
  readonly auth: FoundryAuthConfig;
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
    new URL(value);
  } catch {
    throw new Error(`Invalid URL in environment variable: ${key}`);
  }

  return value;
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

  const config = {
    service: "foundry-service",
    version: options.version ?? "0.1.0",
    port,
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

  return config;
}
