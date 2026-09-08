import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  ErrorResponseSchema,
  HealthResponseSchema,
} from "@expense-tax/contracts";
import type { FoundryConfig } from "../config.js";
import type { DatabaseReadinessProbe } from "../plugins/database.js";

export interface HealthRouteOptions {
  readonly config: Pick<FoundryConfig, "service" | "version">;
  readonly readinessProbe: DatabaseReadinessProbe;
}

export async function registerHealthRoutes(
  app: FastifyInstance,
  options: HealthRouteOptions,
): Promise<void> {
  app.withTypeProvider<ZodTypeProvider>().get(
    "/health/live",
    {
      schema: {
        response: {
          200: HealthResponseSchema,
        },
      },
    },
    async () => ({
      status: "ok" as const,
      service: options.config.service,
      version: options.config.version,
    }),
  );

  app.withTypeProvider<ZodTypeProvider>().get(
    "/health/ready",
    {
      schema: {
        response: {
          200: HealthResponseSchema,
          503: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        await options.readinessProbe();
      } catch {
        return reply.code(503).send({
          error: {
            code: "INTERNAL_ERROR",
            message: "Internal server error",
            requestId: request.id,
          },
        });
      }

      return {
        status: "ok" as const,
        service: options.config.service,
        version: options.config.version,
      };
    },
  );
}
