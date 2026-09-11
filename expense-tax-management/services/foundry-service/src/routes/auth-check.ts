import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import { ErrorResponseSchema } from "@expense-tax/contracts";
import { platformGuard, serviceGuard } from "../plugins/auth.js";

export interface AuthCheckRouteOptions {
  readonly workerServiceSubject: string;
}

const claimsSchema = z.strictObject({
  issuer: z.string(),
  audience: z.string(),
  subject: z.string(),
  tokenType: z.string(),
});

const errors = { 401: ErrorResponseSchema, 403: ErrorResponseSchema };

function claims(request: FastifyRequest) {
  const principal = request.authPrincipal;
  if (!principal) throw new Error("authenticated principal missing");
  return {
    issuer: principal.issuer,
    audience: principal.audience,
    subject: principal.subject,
    tokenType: principal.tokenType,
  };
}

export async function registerAuthCheckRoutes(
  app: FastifyInstance,
  options: AuthCheckRouteOptions,
): Promise<void> {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();
  const workerSubject = options.workerServiceSubject.trim();
  if (!workerSubject) throw new Error("Missing required Foundry worker service subject");
  const workerGuard = [
    serviceGuard(workerSubject, ["routes:read"]),
  ];

  typedApp.get(
    "/internal/v1/auth-check/platform",
    {
      preHandler: [platformGuard("catalog_manager")],
      schema: {
        security: [{ platformBearer: [] }],
        response: {
          200: z.strictObject({
            claimsVerified: claimsSchema,
            role: z.literal("catalog_manager"),
          }),
          ...errors,
        },
      },
    },
    async (request) => ({
      claimsVerified: claims(request),
      role: "catalog_manager" as const,
    }),
  );

  typedApp.get(
    "/internal/v1/auth-check/worker",
    {
      preHandler: workerGuard,
      schema: {
        security: [{ serviceBearer: [] }],
        response: { 200: z.strictObject({ claimsVerified: claimsSchema }), ...errors },
      },
    },
    async (request) => ({ claimsVerified: claims(request) }),
  );
}
