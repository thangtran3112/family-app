import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";
import fastifySwagger from "@fastify/swagger";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import {
  createConfiguredAuthVerifiers,
  type AuthKeyResolverFactory,
} from "./auth/verifier.js";
import type { AuthVerifiers } from "./auth/types.js";
import type { FoundryConfig } from "./config.js";
import { createFoundryDatabase } from "./database/client.js";
import type { FoundryDatabase } from "./database/types.js";
import { createCatalogDomain, type CatalogDomain } from "./domain/catalog.js";
import { createQuotasDomain, type QuotasDomain } from "./domain/quotas.js";
import { createRoutesDomain, type RoutesDomain } from "./domain/routes.js";
import { createOperationsDomain, type OperationsDomain } from "./domain/operations.js";
import {
  createPlatformOperatorDomain,
  type PlatformOperatorDomain,
} from "./domain/platform-operators.js";
import { registerOperationsRoutes } from "./routes/operations.js";
import { createPostgresSecretStore, type SecretStore } from "./domain/vault.js";
import { registerErrorHandlers } from "./errors.js";
import { registerAuthPlugin } from "./plugins/auth.js";
import {
  registerDatabasePlugin,
  type DatabaseReadinessProbe,
} from "./plugins/database.js";
import { registerCatalogRoutes } from "./routes/catalog.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerQuotaRoutes } from "./routes/quotas.js";
import { registerAuthCheckRoutes } from "./routes/auth-check.js";
import type { Kysely } from "kysely";

const SENSITIVE_FIELD_NAMES = [
  "authorization",
  "cookie",
  "cookies",
  "password",
  "token",
  "accessToken",
  "refreshToken",
  "idToken",
  "bearerToken",
  "apiKey",
  "clientSecret",
  "secret",
  "secrets",
  "key",
  "keys",
  "privateKey",
  "secretKey",
  "signingKey",
  "encryptionKey",
  "databaseUrl",
  "databaseURL",
  "database_url",
  "databaseUri",
  "databaseURI",
  "database_uri",
  "connectionString",
  "connection_string",
  "access_token",
  "refresh_token",
  "id_token",
  "bearer_token",
  "api_key",
  "client_secret",
  "private_key",
  "secret_key",
  "signing_key",
  "encryption_key",
  "providerApiKey",
  "providerCredentials",
  "provider_api_key",
  "provider_credentials",
  "modelApiKey",
  "modelCredentials",
  "model_api_key",
  "model_credentials",
];

const SENSITIVE_LOG_PATHS = [
  ...SENSITIVE_FIELD_NAMES,
  ...SENSITIVE_FIELD_NAMES.map((fieldName) => "*." + fieldName),
  "headers.authorization",
  "headers.cookie",
  "headers.cookies",
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers.cookies",
  "request.headers.authorization",
  "request.headers.cookie",
  "request.headers.cookies",
];

type LoggerOption = Exclude<FastifyServerOptions["logger"], undefined>;

export interface BuildAppOptions {
  readonly config: FoundryConfig;
  readonly logger?: FastifyServerOptions["logger"];
  readonly authVerifiers?: AuthVerifiers;
  readonly authKeyResolverFactory?: AuthKeyResolverFactory;
  readonly database?: Kysely<FoundryDatabase>;
  readonly readinessProbe?: DatabaseReadinessProbe;
  readonly secretStore?: SecretStore;
  readonly catalogDomain?: CatalogDomain;
  readonly quotasDomain?: QuotasDomain;
  readonly routesDomain?: RoutesDomain;
  readonly operationsDomain?: OperationsDomain;
  readonly platformOperatorDomain?: PlatformOperatorDomain;
}

function loggerWithRedaction(logger: BuildAppOptions["logger"]): LoggerOption {
  if (logger === false) {
    return false;
  }

  if (logger === true || logger === undefined) {
    return { redact: SENSITIVE_LOG_PATHS };
  }

  return {
    ...logger,
    redact: SENSITIVE_LOG_PATHS,
  };
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const app = Fastify({
    logger: loggerWithRedaction(options.logger),
  });
  const database =
    options.database ?? createFoundryDatabase(options.config.databaseUrl);
  const secretStore = options.secretStore ?? createPostgresSecretStore(database);
  const catalogDomain =
    options.catalogDomain ?? createCatalogDomain(database, secretStore);
  const quotasDomain = options.quotasDomain ?? createQuotasDomain(database);
  const routesDomain = options.routesDomain ?? createRoutesDomain(database);
  const operationsDomain = options.operationsDomain ?? createOperationsDomain(database);
  const platformOperatorDomain =
    options.platformOperatorDomain ?? createPlatformOperatorDomain(database);

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.register(fastifySwagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "Expense Tax Foundry Service",
        version: options.config.version,
      },
      components: {
        securitySchemes: {
          platformBearer: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "JWT",
            description: "Platform operator bearer token",
          },
          serviceBearer: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "JWT",
            description: "Internal service bearer token",
          },
        },
      },
    },
    transform: jsonSchemaTransform,
  });

  registerErrorHandlers(app);
  registerAuthPlugin(app, {
    authVerifiers:
      options.authVerifiers ??
      createConfiguredAuthVerifiers(
        options.config,
        options.authKeyResolverFactory,
      ),
    platformOperatorDomain,
  });
  registerDatabasePlugin(app, {
    database,
    destroyOnClose: options.database === undefined,
    ...(options.readinessProbe
      ? { readinessProbe: options.readinessProbe }
      : {}),
  });
  app.register(registerHealthRoutes, {
    config: options.config,
    readinessProbe: app.databaseReadinessProbe,
  });
  if (options.config.clerk !== undefined) {
    app.register(registerAuthCheckRoutes, {
      workerServiceSubject: options.config.clerk.foundryServiceSubject,
    });
  }
  app.register(registerCatalogRoutes, { catalogDomain });
  app.register(registerQuotaRoutes, {
    quotasDomain,
    routesDomain,
    database,
    ...(options.config.clerk?.foundryServiceSubject
      ? { workerServiceSubject: options.config.clerk.foundryServiceSubject }
      : {}),
    ...(options.config.clerk?.appServiceSubject
      ? { appServiceSubject: options.config.clerk.appServiceSubject }
      : {}),
  });
  app.register(registerOperationsRoutes, { operationsDomain });

  return app;
}
