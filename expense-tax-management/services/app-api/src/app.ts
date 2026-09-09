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
import {
  createBusinessDomain,
  type BusinessDomain,
} from "./domain/businesses.js";
import {
  createIdentityDomain,
  type IdentityDomain,
} from "./domain/identity.js";
import {
  createSpendingCategoryDomain,
  type SpendingCategoryDomain,
} from "./domain/spending-categories.js";
import { createProjectDomain, type ProjectDomain } from "./domain/projects.js";
import { createExpenseDomain, type ExpenseDomain } from "./domain/expenses.js";
import { createTaxDomain, type TaxDomain } from "./domain/tax.js";
import {
  createMembershipDomain,
  type MembershipDomain,
} from "./domain/memberships.js";
import { createTenantDomain, type TenantDomain } from "./domain/tenants.js";
import { createPlansDomain, type PlansDomain } from "./domain/plans.js";
import {
  createProcessingJobsDomain,
  type ProcessingJobsDomain,
} from "./domain/processing-jobs.js";
import { registerErrorHandlers } from "./errors.js";
import { registerAuthPlugin } from "./plugins/auth.js";
import {
  registerDatabasePlugin,
  type DatabaseReadinessProbe,
} from "./plugins/database.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerBusinessRoutes } from "./routes/businesses.js";
import { registerIdentityRoutes } from "./routes/identity.js";
import { registerMembershipRoutes } from "./routes/memberships.js";
import { registerSpendingCategoryRoutes } from "./routes/spending-categories.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerExpenseRoutes } from "./routes/expenses.js";
import { registerTaxRoutes } from "./routes/tax.js";
import { registerTenantRoutes } from "./routes/tenants.js";
import { registerPlanRoutes } from "./routes/plans.js";
import { registerJobRoutes } from "./routes/jobs.js";
import { registerFileRoutes } from "./routes/files.js";
import { createFilesDomain, type FilesDomain } from "./domain/files.js";
import { registerOcrRoutes } from "./routes/ocr.js";
import { createOcrJobsDomain, type OcrJobsDomain } from "./domain/ocr.js";
import {
  createStorageAdapter,
  type StorageAdapter,
} from "./storage/factory.js";
import {
  createTemporalWorkflowStarter,
  type TemporalWorkflowStarter,
} from "./temporal/client.js";
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
  "urlSigningKey",
  "url_signing_key",
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
  readonly identityDomain?: IdentityDomain;
  readonly tenantDomain?: TenantDomain;
  readonly membershipDomain?: MembershipDomain;
  readonly businessDomain?: BusinessDomain;
  readonly spendingCategoryDomain?: SpendingCategoryDomain;
  readonly projectDomain?: ProjectDomain;
  readonly expenseDomain?: ExpenseDomain;
  readonly taxDomain?: TaxDomain;
  readonly plansDomain?: PlansDomain;
  readonly temporalStarter?: TemporalWorkflowStarter;
  readonly processingJobsDomain?: ProcessingJobsDomain;
  readonly storageAdapter?: StorageAdapter;
  readonly filesDomain?: FilesDomain;
  readonly ocrJobsDomain?: OcrJobsDomain;
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
  const identityDomain = options.identityDomain ?? createIdentityDomain(database);
  const tenantDomain = options.tenantDomain ?? createTenantDomain(database);
  const membershipDomain =
    options.membershipDomain ?? createMembershipDomain(database, app.log);
  const businessDomain = options.businessDomain ?? createBusinessDomain(database);
  const spendingCategoryDomain =
    options.spendingCategoryDomain ?? createSpendingCategoryDomain(database);
  const projectDomain = options.projectDomain ?? createProjectDomain(database);
  const expenseDomain = options.expenseDomain ?? createExpenseDomain(database);
  const taxDomain = options.taxDomain ?? createTaxDomain(database);
  const plansDomain = options.plansDomain ?? createPlansDomain(database);
  const temporalStarter =
    options.temporalStarter ?? createTemporalWorkflowStarter(options.config.temporal);
  const processingJobsDomain =
    options.processingJobsDomain ??
    createProcessingJobsDomain(database, temporalStarter);
  const storageAdapter =
    options.storageAdapter ??
    createStorageAdapter({
      backend: options.config.storage.backend,
      localDir: options.config.storage.localDir,
      baseUrl: options.config.storage.baseUrl,
      urlSigningKey: options.config.storage.urlSigningKey,
    });
  const filesDomain =
    options.filesDomain ?? createFilesDomain(database, storageAdapter);

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
  app.register(registerIdentityRoutes, { identityDomain });
  app.register(registerTenantRoutes, {
    identityResolver: identityDomain,
    tenantDomain,
  });
  app.register(registerMembershipRoutes, {
    identityResolver: identityDomain,
    membershipDomain,
  });
  app.register(registerBusinessRoutes, {
    identityResolver: identityDomain,
    businessDomain,
  });
  app.register(registerSpendingCategoryRoutes, {
    identityResolver: identityDomain,
    spendingCategoryDomain,
  });
  app.register(registerProjectRoutes, {
    identityResolver: identityDomain,
    projectDomain,
  });
  app.register(registerExpenseRoutes, {
    identityResolver: identityDomain,
    expenseDomain,
  });
  app.register(registerTaxRoutes, {
    identityResolver: identityDomain,
    taxDomain,
  });
  app.register(registerPlanRoutes, {
    identityResolver: identityDomain,
    plansDomain,
  });
  app.register(registerJobRoutes, { processingJobsDomain });
  app.register(registerFileRoutes, {
    identityResolver: identityDomain,
    filesDomain,
    contentSigningKey: options.config.storage.urlSigningKey,
  });
  const ocrJobsDomain =
    options.ocrJobsDomain ??
    createOcrJobsDomain(database, { plansDomain, filesDomain });
  app.register(registerOcrRoutes, {
    identityResolver: identityDomain,
    ocrJobsDomain,
  });

  if (options.temporalStarter === undefined) {
    app.addHook("onClose", async () => {
      await temporalStarter.close();
    });
  }

  return app;
}
