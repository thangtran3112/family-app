export interface AppConfig {
  readonly service: "app-api";
  readonly version: string;
  readonly port: number;
  readonly databaseUrl: string;
  readonly auth: AppAuthConfig;
  readonly temporal: TemporalConnectionConfig;
  readonly storage: StorageConnectionConfig;
  readonly inboundEmail: InboundEmailConfig;
}

export interface InboundEmailConfig {
  readonly baseAddress: string;
  readonly webhookSigningKey: string;
  readonly routingTokenSecret: string;
  readonly challengeDir: string;
}

export interface TemporalConnectionConfig {
  readonly address: string;
  readonly namespace: string;
}

export interface StorageConnectionConfig {
  readonly backend: string;
  readonly localDir: string;
  readonly baseUrl: string;
  readonly urlSigningKey: string;
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
  const temporalEnv =
    options.env?.TEMPORAL_HOST === undefined &&
    options.env?.TEMPORAL_NAMESPACE === undefined
      ? process.env
      : env;
  const storageEnv =
    options.env?.STORAGE_BACKEND === undefined &&
    options.env?.LOCAL_STORAGE_DIR === undefined &&
    options.env?.STORAGE_URL_SIGNING_KEY === undefined &&
    options.env?.STORAGE_LOCAL_BASE_URL === undefined
      ? process.env
      : env;
  const inboundEnv =
    options.env?.INBOUND_EMAIL_BASE_ADDRESS === undefined &&
    options.env?.INBOUND_WEBHOOK_SIGNING_KEY === undefined &&
    options.env?.INBOUND_ROUTING_TOKEN_SECRET === undefined &&
    options.env?.INBOUND_CHALLENGE_DIR === undefined
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
    temporal: {
      address: requiredEnvironmentValue(temporalEnv, "TEMPORAL_HOST"),
      namespace: requiredEnvironmentValue(temporalEnv, "TEMPORAL_NAMESPACE"),
    },
    storage: {
      backend: requiredEnvironmentValue(storageEnv, "STORAGE_BACKEND"),
      localDir: requiredEnvironmentValue(storageEnv, "LOCAL_STORAGE_DIR"),
      baseUrl: requiredEnvironmentValue(storageEnv, "STORAGE_LOCAL_BASE_URL"),
      urlSigningKey: requiredEnvironmentValue(
        storageEnv,
        "STORAGE_URL_SIGNING_KEY",
      ),
    },
    inboundEmail: {
      baseAddress: requiredEnvironmentValue(
        inboundEnv,
        "INBOUND_EMAIL_BASE_ADDRESS",
      ),
      webhookSigningKey: requiredEnvironmentValue(
        inboundEnv,
        "INBOUND_WEBHOOK_SIGNING_KEY",
      ),
      routingTokenSecret: requiredEnvironmentValue(
        inboundEnv,
        "INBOUND_ROUTING_TOKEN_SECRET",
      ),
      challengeDir: requiredEnvironmentValue(
        inboundEnv,
        "INBOUND_CHALLENGE_DIR",
      ),
    },
  };
}
