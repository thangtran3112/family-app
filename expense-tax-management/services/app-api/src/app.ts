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
import { createRemoteAuthVerifiers } from "./auth/verifier.js";
import type { AuthVerifiers } from "./auth/types.js";
import type { AppConfig } from "./config.js";
import { createAppDatabase } from "./database/client.js";
import type { AppDatabase } from "./database/types.js";
import { registerErrorHandlers } from "./errors.js";
import { registerAuthPlugin } from "./plugins/auth.js";
import {
  registerDatabasePlugin,
  type DatabaseReadinessProbe,
} from "./plugins/database.js";
import { registerHealthRoutes } from "./routes/health.js";
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
  readonly config: AppConfig;
  readonly logger?: FastifyServerOptions["logger"];
  readonly authVerifiers?: AuthVerifiers;
  readonly database?: Kysely<AppDatabase>;
  readonly readinessProbe?: DatabaseReadinessProbe;
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
  const database = options.database ?? createAppDatabase(options.config.databaseUrl);

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.register(fastifySwagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "Expense Tax App API",
        version: options.config.version,
      },
      components: {
        securitySchemes: {
          tenantBearer: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "JWT",
            description: "Tenant account bearer token",
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
      options.authVerifiers ?? createRemoteAuthVerifiers(options.config.auth),
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

  return app;
}
