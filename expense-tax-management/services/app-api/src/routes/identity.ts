import {
  CurrentUserResponseSchema,
  ErrorResponseSchema,
  IdentityProvisioningRequestSchema,
  IdentityProvisioningResponseSchema,
} from "@expense-tax/contracts";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import type { IdentityDomain } from "../domain/identity.js";
import { DomainError } from "../errors.js";
import {
  authenticatedUserGuard,
  serviceGuard,
  tenantGuard,
} from "../plugins/auth.js";

export interface IdentityRouteOptions {
  readonly identityDomain: IdentityDomain;
}

export async function registerIdentityRoutes(
  app: FastifyInstance,
  options: IdentityRouteOptions,
): Promise<void> {
  app.withTypeProvider<ZodTypeProvider>().post(
    "/internal/v1/identity-provisionings",
    {
      preHandler: serviceGuard("gateway-auth", ["identity:provision"]),
      schema: {
        body: IdentityProvisioningRequestSchema,
        security: [{ serviceBearer: [] }],
        response: {
          200: IdentityProvisioningResponseSchema,
          201: IdentityProvisioningResponseSchema,
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          409: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const actorServicePrincipal = request.authPrincipal?.clientId;
      if (!actorServicePrincipal) throw DomainError.forbidden();

      const result = await options.identityDomain.provision({
        identity: request.body,
        actorServicePrincipal,
        requestId: request.id,
      });
      return reply
        .code(result.created ? 201 : 200)
        .send({ user: result.user });
    },
  );

  app.withTypeProvider<ZodTypeProvider>().get(
    "/api/v1/users/me",
    {
      preHandler: [
        tenantGuard,
        authenticatedUserGuard(options.identityDomain),
      ],
      schema: {
        security: [{ tenantBearer: [] }],
        response: {
          200: CurrentUserResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request) => {
      const user = request.authenticatedUser;
      if (!user) throw DomainError.unauthenticated();
      return { user };
    },
  );
}
