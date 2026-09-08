import {
  BusinessExpenseCollectionParamsSchema,
  BusinessExpenseParamsSchema,
  ErrorResponseSchema,
  ExpenseArchiveRequestSchema,
  ExpenseCreateRequestSchema,
  ExpenseListSchema,
  ExpenseUpdateRequestSchema,
  LedgerQuerySchema,
  PersonalExpenseCollectionParamsSchema,
  PersonalExpenseParamsSchema,
  ExpenseSchema,
} from "@expense-tax/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import type { IdentityResolver } from "../domain/authenticated-user.js";
import type { ExpenseDomain } from "../domain/expenses.js";
import { DomainError } from "../errors.js";
import { authenticatedUserGuard, tenantGuard } from "../plugins/auth.js";

export interface ExpenseRouteOptions {
  readonly identityResolver: IdentityResolver;
  readonly expenseDomain: ExpenseDomain;
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

export async function registerExpenseRoutes(
  app: FastifyInstance,
  options: ExpenseRouteOptions,
): Promise<void> {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();
  const personalCollection =
    "/api/v1/tenants/:tenantId/personal-profiles/:profileId/expenses";
  const personalItem = `${personalCollection}/:expenseId`;
  const businessCollection = "/api/v1/tenants/:tenantId/businesses/:businessId/expenses";
  const businessItem = `${businessCollection}/:expenseId`;

  typedApp.get(
    personalCollection,
    {
      preHandler: authentication(options.identityResolver),
      schema: {
        params: PersonalExpenseCollectionParamsSchema,
        querystring: LedgerQuerySchema,
        security: [{ tenantBearer: [] }],
        response: { 200: ExpenseListSchema, ...errors },
      },
    },
    async (request) =>
      options.expenseDomain.listPersonal({
        actorUserId: actorUserId(request),
        tenantId: request.params.tenantId,
        profileId: request.params.profileId,
        query: request.query,
      }),
  );

  typedApp.post(
    personalCollection,
    {
      preHandler: authentication(options.identityResolver),
      schema: {
        params: PersonalExpenseCollectionParamsSchema,
        body: ExpenseCreateRequestSchema,
        security: [{ tenantBearer: [] }],
        response: { 201: ExpenseSchema, ...errors },
      },
    },
    async (request, reply) =>
      reply.code(201).send(
        await options.expenseDomain.createPersonal({
          actorUserId: actorUserId(request),
          tenantId: request.params.tenantId,
          profileId: request.params.profileId,
          request: request.body,
          requestId: request.id,
        }),
      ),
  );

  typedApp.get(
    personalItem,
    {
      preHandler: authentication(options.identityResolver),
      schema: {
        params: PersonalExpenseParamsSchema,
        security: [{ tenantBearer: [] }],
        response: { 200: ExpenseSchema, ...errors },
      },
    },
    async (request) =>
      options.expenseDomain.getPersonal({
        actorUserId: actorUserId(request),
        ...request.params,
      }),
  );

  typedApp.patch(
    personalItem,
    {
      preHandler: authentication(options.identityResolver),
      schema: {
        params: PersonalExpenseParamsSchema,
        body: ExpenseUpdateRequestSchema,
        security: [{ tenantBearer: [] }],
        response: { 200: ExpenseSchema, ...errors },
      },
    },
    async (request) =>
      options.expenseDomain.updatePersonal({
        actorUserId: actorUserId(request),
        tenantId: request.params.tenantId,
        profileId: request.params.profileId,
        expenseId: request.params.expenseId,
        request: request.body,
        requestId: request.id,
      }),
  );

  typedApp.delete(
    personalItem,
    {
      preHandler: authentication(options.identityResolver),
      schema: {
        params: PersonalExpenseParamsSchema,
        body: ExpenseArchiveRequestSchema,
        security: [{ tenantBearer: [] }],
        response: { 204: z.null(), ...errors },
      },
    },
    async (request, reply) => {
      await options.expenseDomain.archivePersonal({
        actorUserId: actorUserId(request),
        tenantId: request.params.tenantId,
        profileId: request.params.profileId,
        expenseId: request.params.expenseId,
        request: request.body,
        requestId: request.id,
      });
      return reply.code(204).send(null);
    },
  );

  typedApp.get(
    businessCollection,
    {
      preHandler: authentication(options.identityResolver),
      schema: {
        params: BusinessExpenseCollectionParamsSchema,
        querystring: LedgerQuerySchema,
        security: [{ tenantBearer: [] }],
        response: { 200: ExpenseListSchema, ...errors },
      },
    },
    async (request) =>
      options.expenseDomain.listBusiness({
        actorUserId: actorUserId(request),
        tenantId: request.params.tenantId,
        businessId: request.params.businessId,
        query: request.query,
      }),
  );

  typedApp.post(
    businessCollection,
    {
      preHandler: authentication(options.identityResolver),
      schema: {
        params: BusinessExpenseCollectionParamsSchema,
        body: ExpenseCreateRequestSchema,
        security: [{ tenantBearer: [] }],
        response: { 201: ExpenseSchema, ...errors },
      },
    },
    async (request, reply) =>
      reply.code(201).send(
        await options.expenseDomain.createBusiness({
          actorUserId: actorUserId(request),
          tenantId: request.params.tenantId,
          businessId: request.params.businessId,
          request: request.body,
          requestId: request.id,
        }),
      ),
  );

  typedApp.get(
    businessItem,
    {
      preHandler: authentication(options.identityResolver),
      schema: {
        params: BusinessExpenseParamsSchema,
        security: [{ tenantBearer: [] }],
        response: { 200: ExpenseSchema, ...errors },
      },
    },
    async (request) =>
      options.expenseDomain.getBusiness({
        actorUserId: actorUserId(request),
        ...request.params,
      }),
  );

  typedApp.patch(
    businessItem,
    {
      preHandler: authentication(options.identityResolver),
      schema: {
        params: BusinessExpenseParamsSchema,
        body: ExpenseUpdateRequestSchema,
        security: [{ tenantBearer: [] }],
        response: { 200: ExpenseSchema, ...errors },
      },
    },
    async (request) =>
      options.expenseDomain.updateBusiness({
        actorUserId: actorUserId(request),
        tenantId: request.params.tenantId,
        businessId: request.params.businessId,
        expenseId: request.params.expenseId,
        request: request.body,
        requestId: request.id,
      }),
  );

  typedApp.delete(
    businessItem,
    {
      preHandler: authentication(options.identityResolver),
      schema: {
        params: BusinessExpenseParamsSchema,
        body: ExpenseArchiveRequestSchema,
        security: [{ tenantBearer: [] }],
        response: { 204: z.null(), ...errors },
      },
    },
    async (request, reply) => {
      await options.expenseDomain.archiveBusiness({
        actorUserId: actorUserId(request),
        tenantId: request.params.tenantId,
        businessId: request.params.businessId,
        expenseId: request.params.expenseId,
        request: request.body,
        requestId: request.id,
      });
      return reply.code(204).send(null);
    },
  );
}
