import { FoundryAuditEventListSchema, OperationsListQuerySchema, ProviderCallLogListSchema, QuotaPeriodListSchema, ReconciliationQueueSchema } from "@expense-tax/contracts";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { OperationsDomain } from "../domain/operations.js";
import { platformGuard } from "../plugins/auth.js";

export async function registerOperationsRoutes(app: FastifyInstance, options: { operationsDomain: OperationsDomain }) {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const catalog = [platformGuard("catalog_manager")];
  const reconciler = [platformGuard("quota_reconciler")];
  typed.get("/internal/v1/provider-call-logs", { preHandler: reconciler, schema: { querystring: OperationsListQuerySchema, security: [{ platformBearer: [] }], response: { 200: ProviderCallLogListSchema } } }, async (request) => ({ items: [...await options.operationsDomain.listProviderCalls(request.query.limit ?? 100)] }));
  typed.get("/internal/v1/quota-periods", { preHandler: catalog, schema: { querystring: OperationsListQuerySchema, security: [{ platformBearer: [] }], response: { 200: QuotaPeriodListSchema } } }, async (request) => ({ items: [...await options.operationsDomain.listQuotaPeriods(request.query.limit ?? 100)] }));
  typed.get("/internal/v1/reconciliation-queue", { preHandler: reconciler, schema: { querystring: OperationsListQuerySchema, security: [{ platformBearer: [] }], response: { 200: ReconciliationQueueSchema } } }, async (request) => ({ items: [...await options.operationsDomain.listReconciliationQueue(request.query.limit ?? 100)] }));
  typed.get("/internal/v1/foundry-audit-events", { preHandler: catalog, schema: { querystring: OperationsListQuerySchema, security: [{ platformBearer: [] }], response: { 200: FoundryAuditEventListSchema } } }, async (request) => ({ items: [...await options.operationsDomain.listAuditEvents(request.query.limit ?? 100)] }));
}
