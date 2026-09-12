import {
  BusinessExpenseCollectionParamsSchema,
  DuplicateMatchListSchema,
  DuplicateMatchStatusSchema,
  DuplicateResolutionRequestSchema,
  DuplicateResolutionResponseSchema,
  ErrorResponseSchema,
  PersonalExpenseCollectionParamsSchema,
} from "@expense-tax/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import type {
  DeduplicationDomain,
  ResolveDeduplicationMatchInput,
} from "../domain/deduplication.js";
import type { IdentityResolver } from "../domain/authenticated-user.js";
import { DomainError } from "../errors.js";
import { authenticatedUserGuard, tenantGuard } from "../plugins/auth.js";

type ResolutionDomain = DeduplicationDomain & {
  resolveMatch: NonNullable<DeduplicationDomain["resolveMatch"]>;
};

export interface DuplicateMatchRouteOptions {
  readonly identityResolver: IdentityResolver;
  readonly deduplicationDomain: ResolutionDomain;
}

const authentication = (identityResolver: IdentityResolver) => [
  tenantGuard,
  authenticatedUserGuard(identityResolver),
];
const errors = {
  400: ErrorResponseSchema,
  401: ErrorResponseSchema,
  403: ErrorResponseSchema,
  404: ErrorResponseSchema,
  409: ErrorResponseSchema,
  500: ErrorResponseSchema,
};
const listQuery = z.strictObject({
  status: DuplicateMatchStatusSchema.optional(),
  cursor: z.string().trim().min(1).max(4_096).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const personalParams = PersonalExpenseCollectionParamsSchema;
const businessParams = BusinessExpenseCollectionParamsSchema;
const personalMatchParams = personalParams.extend({ matchId: z.uuid() });
const businessMatchParams = businessParams.extend({ matchId: z.uuid() });

function actorUserId(request: FastifyRequest): string {
  if (!request.authenticatedUser) throw DomainError.unauthenticated();
  return request.authenticatedUser.id;
}

function registerScopeRoutes(
  app: FastifyInstance,
  options: DuplicateMatchRouteOptions,
  input: {
    readonly collection: string;
    readonly params: typeof personalParams | typeof businessParams;
    readonly matchParams: typeof personalMatchParams | typeof businessMatchParams;
    readonly scope: (params: Record<string, string>) => ResolveDeduplicationMatchInput["scope"];
  },
): void {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();
  typedApp.get(
    input.collection,
    {
      preHandler: authentication(options.identityResolver),
      schema: {
        params: input.params,
        querystring: listQuery,
        security: [{ tenantBearer: [] }],
        response: { 200: DuplicateMatchListSchema, ...errors },
      },
    },
    async (request) => options.deduplicationDomain.listMatches({
      actorUserId: actorUserId(request),
      tenantId: request.params.tenantId,
      scope: input.scope(request.params),
      ...(request.query.status === undefined ? {} : { status: request.query.status }),
      ...(request.query.cursor === undefined ? {} : { cursor: request.query.cursor }),
      limit: request.query.limit,
    }),
  );

  typedApp.post(
    `${input.collection}/:matchId/resolve`,
    {
      preHandler: authentication(options.identityResolver),
      schema: {
        params: input.matchParams,
        body: DuplicateResolutionRequestSchema,
        security: [{ tenantBearer: [] }],
        response: { 200: DuplicateResolutionResponseSchema, ...errors },
      },
    },
    async (request) => options.deduplicationDomain.resolveMatch({
      actorUserId: actorUserId(request),
      tenantId: request.params.tenantId,
      scope: input.scope(request.params),
      matchId: request.params.matchId,
      action: request.body.action,
      expectedMatchVersion: request.body.expectedMatchVersion,
      idempotencyKey: request.body.idempotencyKey,
      requestId: request.id,
    }),
  );
}

export async function registerDuplicateMatchRoutes(
  app: FastifyInstance,
  options: DuplicateMatchRouteOptions,
): Promise<void> {
  registerScopeRoutes(app, options, {
    collection: "/api/v1/tenants/:tenantId/personal-profiles/:profileId/duplicate-matches",
    params: personalParams,
    matchParams: personalMatchParams,
    scope: (params) => ({ kind: "personal", profileId: params.profileId as string }),
  });
  registerScopeRoutes(app, options, {
    collection: "/api/v1/tenants/:tenantId/businesses/:businessId/duplicate-matches",
    params: businessParams,
    matchParams: businessMatchParams,
    scope: (params) => ({ kind: "business", businessId: params.businessId as string }),
  });
}
