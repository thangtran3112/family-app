import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import { ErrorResponseSchema } from "@expense-tax/contracts";
import type { FastifyRequest } from "fastify";
import { serviceGuard, tenantGuard } from "../plugins/auth.js";

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
  if (!workerSubject) throw new Error("Missing required App worker service subject");
  const workerGuard = [
    serviceGuard(workerSubject, ["jobs:write"]),
  ];

  typedApp.get(
    "/internal/v1/auth-check/tenant",
    {
      preHandler: tenantGuard,
      schema: {
        security: [{ tenantBearer: [] }],
        response: {
          200: z.strictObject({
            claimsVerified: claimsSchema,
            tenantId: z.string(),
            userId: z.string(),
          }),
          ...errors,
        },
      },
    },
    async (request) => {
      if (!request.authenticatedUser || !request.resolvedTenantId) {
        throw Object.assign(new Error("Authentication failed"), { statusCode: 401 });
      }
      return {
        claimsVerified: claims(request),
        tenantId: request.resolvedTenantId,
        userId: request.authenticatedUser.id,
      };
    },
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
