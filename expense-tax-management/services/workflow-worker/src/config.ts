import { AI_WORKER_TASK_QUEUE } from "@expense-tax/contracts";
import { z } from "zod";

export interface MachineCredentialConfig {
  readonly audience: string;
  readonly machineSecretKey: string;
  readonly subject: string;
}

export interface WorkerConfig {
  readonly temporal: {
    readonly address: string;
    readonly namespace: "expense-tax";
    readonly taskQueue: typeof AI_WORKER_TASK_QUEUE;
  };
  readonly services: {
    readonly appApiBaseUrl: string;
    readonly foundryBaseUrl: string;
  };
  readonly clerk: {
    readonly issuerUrl: string;
    readonly jwksUrl: string;
    readonly app: MachineCredentialConfig;
    readonly foundry: MachineCredentialConfig;
  };
}

const RequiredStringSchema = z.string().trim().min(1);
const PlaceholderPattern = /not[-_ ]?(?:configured|issued)|change.?me|placeholder/i;

function machineIdSchema(key: string): z.ZodType<string> {
  return RequiredStringSchema.regex(
    /^mch_[A-Za-z0-9]+$/,
    `${key} must be a Clerk machine ID`,
  );
}

function machineSecretSchema(key: string): z.ZodType<string> {
  return RequiredStringSchema.regex(
    /^ak_[A-Za-z0-9_-]+$/,
    `${key} must be a Clerk machine secret key`,
  ).refine(
    (value) => !PlaceholderPattern.test(value),
    `${key} must not be a placeholder`,
  );
}

const TemporalAddressSchema = RequiredStringSchema.refine((value) => {
  const match = /^(?:\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+):(\d{1,5})$/.exec(
    value,
  );
  if (!match) {
    return false;
  }

  const port = Number(match[1]);
  return port >= 1 && port <= 65_535;
}, "TEMPORAL_HOST must be a host:port address");

function baseUrlSchema(key: string): z.ZodType<string> {
  return RequiredStringSchema.transform((value, context) => {
    try {
      const url = new URL(value);
      if (
        (url.protocol !== "http:" && url.protocol !== "https:") ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash
      ) {
        throw new Error("unsafe base URL");
      }

      return url.origin;
    } catch {
      context.addIssue({
        code: "custom",
        message: `${key} must be an HTTP(S) origin without credentials`,
      });
      return z.NEVER;
    }
  });
}

function clerkUrlSchema(key: string): z.ZodType<string> {
  return RequiredStringSchema.transform((value, context) => {
    try {
      const url = new URL(value);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      ) {
        throw new Error("unsafe Clerk URL");
      }

      return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
    } catch {
      context.addIssue({
        code: "custom",
        message: `${key} must be an HTTPS URL without credentials`,
      });
      return z.NEVER;
    }
  });
}

const WorkerEnvironmentSchema = z.object({
  TEMPORAL_HOST: TemporalAddressSchema,
  TEMPORAL_NAMESPACE: z
    .string()
    .trim()
    .pipe(z.literal("expense-tax")),
  AI_WORKER_TASK_QUEUE: z
    .string()
    .trim()
    .pipe(z.literal(AI_WORKER_TASK_QUEUE)),
  APP_API_BASE_URL: baseUrlSchema("APP_API_BASE_URL"),
  FOUNDRY_BASE_URL: baseUrlSchema("FOUNDRY_BASE_URL"),
  CLERK_ISSUER_URL: clerkUrlSchema("CLERK_ISSUER_URL"),
  CLERK_JWKS_URL: clerkUrlSchema("CLERK_JWKS_URL"),
  CLERK_APP_SERVICE_AUDIENCE: machineIdSchema(
    "CLERK_APP_SERVICE_AUDIENCE",
  ),
  CLERK_APP_MACHINE_SECRET_KEY: machineSecretSchema(
    "CLERK_APP_MACHINE_SECRET_KEY",
  ),
  CLERK_APP_SERVICE_SUBJECT: machineIdSchema("CLERK_APP_SERVICE_SUBJECT"),
  CLERK_FOUNDRY_SERVICE_AUDIENCE: machineIdSchema(
    "CLERK_FOUNDRY_SERVICE_AUDIENCE",
  ),
  CLERK_FOUNDRY_MACHINE_SECRET_KEY: machineSecretSchema(
    "CLERK_FOUNDRY_MACHINE_SECRET_KEY",
  ),
  CLERK_FOUNDRY_SERVICE_SUBJECT: machineIdSchema(
    "CLERK_FOUNDRY_SERVICE_SUBJECT",
  ),
});

export function workerConfigFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): WorkerConfig {
  const parsed = WorkerEnvironmentSchema.parse(env);

  return {
    temporal: {
      address: parsed.TEMPORAL_HOST,
      namespace: parsed.TEMPORAL_NAMESPACE,
      taskQueue: parsed.AI_WORKER_TASK_QUEUE,
    },
    services: {
      appApiBaseUrl: parsed.APP_API_BASE_URL,
      foundryBaseUrl: parsed.FOUNDRY_BASE_URL,
    },
    clerk: {
      issuerUrl: parsed.CLERK_ISSUER_URL,
      jwksUrl: parsed.CLERK_JWKS_URL,
      app: {
        audience: parsed.CLERK_APP_SERVICE_AUDIENCE,
        machineSecretKey: parsed.CLERK_APP_MACHINE_SECRET_KEY,
        subject: parsed.CLERK_APP_SERVICE_SUBJECT,
      },
      foundry: {
        audience: parsed.CLERK_FOUNDRY_SERVICE_AUDIENCE,
        machineSecretKey: parsed.CLERK_FOUNDRY_MACHINE_SECRET_KEY,
        subject: parsed.CLERK_FOUNDRY_SERVICE_SUBJECT,
      },
    },
  };
}
