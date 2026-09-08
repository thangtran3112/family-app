import {
  BusinessScopeParamsSchema,
  BusinessTaxProfileCloseRequestSchema,
  BusinessTaxProfileCreateRequestSchema,
  BusinessTaxProfileParamsSchema,
  BusinessTaxProfileSchema,
  BusinessTaxProfileUpdateRequestSchema,
  ErrorResponseSchema,
  ExpenseTaxTreatmentCreateRequestSchema,
  ExpenseTaxTreatmentParamsSchema,
  ExpenseTaxTreatmentSchema,
  TaxCategoryDefinitionListSchema,
  TaxonomyVersionListSchema,
  TaxonomyVersionParamsSchema,
} from "@expense-tax/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import type { IdentityResolver } from "../domain/authenticated-user.js";
import type { TaxDomain } from "../domain/tax.js";
import { DomainError } from "../errors.js";
import { authenticatedUserGuard, tenantGuard } from "../plugins/auth.js";

export interface TaxRouteOptions {
  readonly identityResolver: IdentityResolver;
  readonly taxDomain: TaxDomain;
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

function actorUserId(request: FastifyRequest): string {
  if (!request.authenticatedUser) throw DomainError.unauthenticated();
  return request.authenticatedUser.id;
}

export async function registerTaxRoutes(
  app: FastifyInstance,
  options: TaxRouteOptions,
): Promise<void> {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();
  const profileCollection = "/api/v1/tenants/:tenantId/businesses/:businessId/tax-profiles";
  const profileItem = `${profileCollection}/:taxYear`;
  const treatmentPath =
    "/api/v1/tenants/:tenantId/businesses/:businessId/expenses/:expenseId/tax-treatment";

  typedApp.get(
    "/api/v1/taxonomies",
    {
      preHandler: authentication(options.identityResolver),
      schema: {
        security: [{ tenantBearer: [] }],
        response: { 200: TaxonomyVersionListSchema, ...errors },
      },
    },
    async () => ({ items: [...(await options.taxDomain.listTaxonomies())] }),
  );

  typedApp.get(
    "/api/v1/taxonomies/:taxonomyVersionId/categories",
    {
      preHandler: authentication(options.identityResolver),
      schema: {
        params: TaxonomyVersionParamsSchema,
        security: [{ tenantBearer: [] }],
        response: { 200: TaxCategoryDefinitionListSchema, ...errors },
      },
    },
    async (request) => ({
      items: [
        ...(await options.taxDomain.listTaxCategories(request.params.taxonomyVersionId)),
      ],
    }),
  );

  typedApp.post(
    profileCollection,
    {
      preHandler: authentication(options.identityResolver),
      schema: {
        params: BusinessScopeParamsSchema,
        body: BusinessTaxProfileCreateRequestSchema,
        security: [{ tenantBearer: [] }],
        response: { 201: BusinessTaxProfileSchema, ...errors },
      },
    },
    async (request, reply) =>
      reply.code(201).send(
        await options.taxDomain.createProfile({
          actorUserId: actorUserId(request),
          tenantId: request.params.tenantId,
          businessId: request.params.businessId,
          request: request.body,
          requestId: request.id,
        }),
      ),
  );

  typedApp.get(
    profileItem,
    {
      preHandler: authentication(options.identityResolver),
      schema: {
        params: BusinessTaxProfileParamsSchema,
        security: [{ tenantBearer: [] }],
        response: { 200: BusinessTaxProfileSchema, ...errors },
      },
    },
    async (request) =>
      options.taxDomain.getProfile({
        actorUserId: actorUserId(request),
        ...request.params,
      }),
  );

  typedApp.patch(
    profileItem,
    {
      preHandler: authentication(options.identityResolver),
      schema: {
        params: BusinessTaxProfileParamsSchema,
        body: BusinessTaxProfileUpdateRequestSchema,
        security: [{ tenantBearer: [] }],
        response: { 200: BusinessTaxProfileSchema, ...errors },
      },
    },
    async (request) =>
      options.taxDomain.updateProfile({
        actorUserId: actorUserId(request),
        tenantId: request.params.tenantId,
        businessId: request.params.businessId,
        taxYear: request.params.taxYear,
        request: request.body,
        requestId: request.id,
      }),
  );

  typedApp.delete(
    profileItem,
    {
      preHandler: authentication(options.identityResolver),
      schema: {
        params: BusinessTaxProfileParamsSchema,
        body: BusinessTaxProfileCloseRequestSchema,
        security: [{ tenantBearer: [] }],
        response: { 204: z.null(), ...errors },
      },
    },
    async (request, reply) => {
      await options.taxDomain.closeProfile({
        actorUserId: actorUserId(request),
        tenantId: request.params.tenantId,
        businessId: request.params.businessId,
        taxYear: request.params.taxYear,
        expectedVersion: request.body.expectedVersion,
        requestId: request.id,
      });
      return reply.code(204).send(null);
    },
  );

  typedApp.get(
    treatmentPath,
    {
      preHandler: authentication(options.identityResolver),
      schema: {
        params: ExpenseTaxTreatmentParamsSchema,
        security: [{ tenantBearer: [] }],
        response: { 200: ExpenseTaxTreatmentSchema, ...errors },
      },
    },
    async (request) =>
      options.taxDomain.getTreatment({
        actorUserId: actorUserId(request),
        ...request.params,
      }),
  );

  typedApp.put(
    treatmentPath,
    {
      preHandler: authentication(options.identityResolver),
      schema: {
        params: ExpenseTaxTreatmentParamsSchema,
        body: ExpenseTaxTreatmentCreateRequestSchema,
        security: [{ tenantBearer: [] }],
        response: { 200: ExpenseTaxTreatmentSchema, ...errors },
      },
    },
    async (request) =>
      options.taxDomain.upsertTreatment({
        actorUserId: actorUserId(request),
        ...request.params,
        request: request.body,
        requestId: request.id,
      }),
  );

  typedApp.delete(
    treatmentPath,
    {
      preHandler: authentication(options.identityResolver),
      schema: {
        params: ExpenseTaxTreatmentParamsSchema,
        security: [{ tenantBearer: [] }],
        response: { 204: z.null(), ...errors },
      },
    },
    async (request, reply) => {
      await options.taxDomain.deleteTreatment({
        actorUserId: actorUserId(request),
        ...request.params,
        requestId: request.id,
      });
      return reply.code(204).send(null);
    },
  );
}
